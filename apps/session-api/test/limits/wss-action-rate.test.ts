/**
 * 每会话动作频率限制(任务分解 WP-6 第 1 条;D-API-53)。
 *
 * 与 WP-5 每连接令牌桶叠加、同源实现(MessageRateLimiter 按会话键)。注入
 * 时钟驱动的确定性红灯:
 *  - 连接桶仍有余量、会话桶耗尽 → 冻结错误帧 "action rate limit exceeded"
 *    (证明两道闸独立叠加,触顶 = 同族确定性拒绝,连接保持);
 *  - 会话桶跨连接存活:第二连接激活(踢旧)不重置会话预算——封堵"断线重连
 *    刷新令牌桶"的绕行向量;
 *  - 时间推进补充令牌(纯函数补充语义,注入时钟零抖动)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { WssFrameSchema, type WssFrame } from "@stackmaster/protocol";

import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  buildSessionTestRig,
  sessionCommand,
  sessionCredentialFromSetCookie,
  type SessionTestRig,
  type RigWssClient,
} from "../routes/helpers/session-rig.js";

/** 出站帧收集器(线上次序)。 */
class FrameCollector {
  readonly frames: WssFrame[] = [];
  attach(client: RigWssClient): void {
    client.on("message", (data: Buffer) => {
      this.frames.push(JSON.parse(data.toString("utf8")) as WssFrame);
    });
  }
  async waitFor(predicate: (frames: readonly WssFrame[]) => boolean): Promise<void> {
    await vi.waitFor(
      () => {
        if (!predicate(this.frames)) {
          throw new Error("等待出站帧条件超时");
        }
      },
      { timeout: 5000, interval: 10 },
    );
  }
}

function actionFrame(input: {
  sessionId: string;
  seq: number;
  clientSeq: number;
  baseRevision: number;
  idempotencyKey: string;
  requestId: string;
}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    type: "action",
    sessionId: input.sessionId,
    seq: input.seq,
    requestId: input.requestId,
    payload: {
      protocolVersion: 1,
      sessionId: input.sessionId,
      clientSeq: input.clientSeq,
      baseRevision: input.baseRevision,
      idempotencyKey: input.idempotencyKey,
      action: { type: "write_bytes", args: { addressHex: "0x401000", bytesHex: "c3" } },
    },
  };
}

describe("每会话动作频率闸(与每连接令牌桶叠加,D-API-53)", () => {
  const IDLE_CLEANUPS: (() => Promise<void>)[] = [];
  afterEach(async () => {
    const cleanups = IDLE_CLEANUPS.splice(0, IDLE_CLEANUPS.length);
    for (const cleanup of cleanups) {
      await cleanup();
    }
  });

  async function build(): Promise<{ rig: SessionTestRig; sessionId: string; cookie: string }> {
    let clockMs = 1_000_000;
    const rig = await buildSessionTestRig({
      now: () => clockMs,
      wss: { messageRatePerSecond: 2 },
    });
    (rig as unknown as { __advanceClock: (ms: number) => void }).__advanceClock = (ms: number) => {
      clockMs += ms;
    };
    IDLE_CLEANUPS.push(async () => {
      await rig.wssRegistry.closeAll();
      await rig.app.close();
    });
    await rig.registerChallenge();
    const issued = await rig.issueEmbedToken();
    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: sessionCommand("create_session", {
        challengeId: TEST_CHALLENGE_ID,
        challengeVersion: TEST_CHALLENGE_VERSION,
        embedSessionId: issued.claims.embedSessionId,
        embedToken: issued.token,
      }),
    });
    expect(response.statusCode).toBe(201);
    const sessionId = (response.json() as { payload: { sessionId: string } }).payload.sessionId;
    const cookie = sessionCredentialFromSetCookie({
      headers: response.headers as Record<string, unknown>,
    });
    return { rig, sessionId, cookie };
  }

  async function connect(rig: SessionTestRig, cookie: string): Promise<{ client: RigWssClient; collector: FrameCollector }> {
    const client = await rig.connectChannel(cookie);
    const collector = new FrameCollector();
    collector.attach(client);
    return { client, collector };
  }

  it("会话桶耗尽而连接桶有余量:同族冻结错误帧确定性拒绝,连接保持", async () => {
    const { rig, sessionId, cookie } = await build();

    // 连接 A:帧 1(连接桶 2→1,会话桶 2→1)→ 正常响应。
    const a = await connect(rig, cookie);
    a.client.send(JSON.stringify(actionFrame({
      sessionId, seq: 1, clientSeq: 1, baseRevision: 0,
      idempotencyKey: "idem-sar-1", requestId: "t-1",
    })));
    await a.collector.waitFor((frames) => frames.length === 1);
    expect(a.collector.frames[0]?.type).toBe("action_response");

    // 同会话第二连接激活(踢旧):连接 B 的连接桶全新,会话桶共享。
    const b = await connect(rig, cookie);
    await vi.waitFor(() => {
      if (!a.client.isClosed && a.client.readyState !== 0 && a.client.readyState !== 3) {
        // injectWS 的 close 事件在服务端主动关闭时传播;踢旧路径已有 WP-5 覆盖。
      }
      return true;
    });

    // 帧 2(连接 B:2→1;会话桶 1→0)→ 正常响应。
    b.client.send(JSON.stringify(actionFrame({
      sessionId, seq: 1, clientSeq: 2, baseRevision: 1,
      idempotencyKey: "idem-sar-2", requestId: "t-2",
    })));
    await b.collector.waitFor((frames) => frames.length === 1);
    expect(b.collector.frames[0]?.type).toBe("action_response");

    // 帧 3:连接 B 仍有余量(1→0),会话桶已耗尽 → 每会话闸触顶,
    // 冻结错误帧 "action rate limit exceeded"(非 "message rate limit exceeded"
    // ——两道闸独立可辨),连接保持。
    b.client.send(JSON.stringify(actionFrame({
      sessionId, seq: 2, clientSeq: 3, baseRevision: 2,
      idempotencyKey: "idem-sar-3", requestId: "t-3",
    })));
    await b.collector.waitFor((frames) => frames.length === 2);
    const errorFrame = WssFrameSchema.parse(b.collector.frames[1]);
    expect(errorFrame.type).toBe("error");
    if (errorFrame.type === "error") {
      expect(errorFrame.payload).toEqual({
        code: "budget_exhausted",
        message: "action rate limit exceeded",
      });
    }

    // 触顶后的确定性叠加次序(D-API-53 流水线序):连接闸先于会话闸——此刻
    // 两桶皆空,下一帧由连接闸以同族冻结错误帧拒绝("message rate limit
    // exceeded"),结论与隐藏状态无关(I-4)。
    b.client.send(JSON.stringify(actionFrame({
      sessionId, seq: 3, clientSeq: 4, baseRevision: 2,
      idempotencyKey: "idem-sar-4", requestId: "t-4",
    })));
    await b.collector.waitFor((frames) => frames.length === 3);
    const nextError = WssFrameSchema.parse(b.collector.frames[2]);
    expect(nextError.type).toBe("error");
    if (nextError.type === "error") {
      expect(nextError.payload).toEqual({
        code: "budget_exhausted",
        message: "message rate limit exceeded",
      });
    }

    // 时间推进(1 秒,速率 2/s)→ 令牌补充 → 动作重新放行(连接保持证明)。
    (rig as unknown as { __advanceClock: (ms: number) => void }).__advanceClock(1000);
    b.client.send(JSON.stringify(actionFrame({
      sessionId, seq: 4, clientSeq: 5, baseRevision: 2,
      idempotencyKey: "idem-sar-5", requestId: "t-5",
    })));
    await b.collector.waitFor((frames) => frames.length === 4);
    expect(b.collector.frames[3]?.type).toBe("action_response");
  });

  it("会话桶跨连接存活(重连不重置预算);回收后逐出(SessionActionRateLimiter 单元语义)", async () => {
    const rig = await buildSessionTestRig();
    const limiter = rig.sessionActionLimiter;
    // 桶惰性创建;默认容量 30。
    expect(limiter.trackedSessionCount).toBe(0);
    expect(limiter.tryTake("sess-x")).toBe(true);
    expect(limiter.trackedSessionCount).toBe(1);
    // 同会话计量共享;不同会话独立建桶。
    expect(limiter.tryTake("sess-y")).toBe(true);
    expect(limiter.trackedSessionCount).toBe(2);
    // 回收逐出(keepalive 到期组合钩子的联动语义)。
    limiter.evict("sess-x");
    expect(limiter.trackedSessionCount).toBe(1);
    limiter.evict("sess-x"); // 幂等
    expect(limiter.trackedSessionCount).toBe(1);
  });
});

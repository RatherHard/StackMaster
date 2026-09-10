/**
 * ZR-P4 时序统计面(任务分解 WP-6 第 4 条;T-SC3 承接,阶段二移交 §六.4)。
 *
 * 编排器层统计断言(测试面):同题目同脚本在不同秘密变体下,通道上的响应
 * 时序与帧长分布无可区分差异。恒定成本由引擎 T-SC2(ZR-P7,属性测试)保证,
 * 本层是通道级兜底统计——捕获"执行域产物之外"的通道行为差异(投影形态、
 * 事件聚合、错误面、帧化节奏)。
 *
 * 变体语义:同一题目、同一动作脚本、两个独立签发的会话(不同 embed 实例 →
 * 不同 jti / 会话标识 / 独立会话状态);真实秘密语料变体(异 seed / 秘密
 * 长度变体)随题目 fixture 到位后逐题必跑(ZR-B1 🔜),本测试锁定统计面
 * harness 与红灯反例的检出能力。
 *
 * 抗-flaky 设计:主断言 = 帧长分布逐位置断言 + 归一化载荷逐字节断言 +
 * 类型序列有序性断言(全部零时钟参与);时序面只做次数与录制序单调性断言,
 * 不做响应时长分位数断言(避免 CI 时钟抖动红灯)。红灯反例:变更脚本的
 * 帧分布在第 1 帧即可检出(证明统计面可检出真实差异,零命中非静默绿灯)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_ACTION_PROTOCOL_VERSION, type WssFrame } from "@stackmaster/protocol";

import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  buildSessionTestRig,
  sessionCommand,
  sessionCredentialFromSetCookie,
  type SessionTestRig,
  type RigWssClient,
} from "../routes/helpers/session-rig.js";
import { SESSION_CREDENTIAL_COOKIE_NAME } from "../../src/auth/cookie.js";
import {
  assertIndistinguishable,
  firstDivergence,
  frameLengths,
} from "../wss/helpers/frame-statistics.js";

const IDLE_CLEANUPS: (() => Promise<void>)[] = [];

afterEach(async () => {
  const cleanups = IDLE_CLEANUPS.splice(0, IDLE_CLEANUPS.length);
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

/** 出站帧收集器(线上次序;客户端视角与 rig 录制器双面互证)。 */
class FrameCollector {
  readonly frames: WssFrame[] = [];
  attach(client: RigWssClient): void {
    client.on("message", (data: Buffer) => {
      this.frames.push(JSON.parse(data.toString("utf8")) as WssFrame);
    });
  }
  async waitFor(count: number): Promise<void> {
    await vi.waitFor(
      () => {
        if (this.frames.length < count) {
          throw new Error("等待出站帧超时");
        }
      },
      { timeout: 5000, interval: 10 },
    );
  }
}

interface VariantSession {
  readonly sessionId: string;
  readonly client: RigWssClient;
  readonly collector: FrameCollector;
}

/** 动作脚本(基线与红灯变体各 3 帧;红灯变体首动作触发确定性拒绝)。 */
function scriptFrames(sessionId: string, variant: "baseline" | "mutated"): Record<string, unknown>[] {
  const firstAction =
    variant === "baseline"
      ? { type: "write_bytes", args: { addressHex: "0x401000", bytesHex: "c3" } }
      : // 红灯变体:不可见地址写入 → 确定性拒绝(rejected 形态,revision 不前进)。
        { type: "write_bytes", args: { addressHex: "0x401000", bytesHex: "ff" } };
  const revisionAfterFirst = variant === "baseline" ? 1 : 0;
  return [
    {
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
      type: "action",
      sessionId,
      seq: 1,
      requestId: "t-1",
      payload: {
        protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
        sessionId,
        clientSeq: 1,
        baseRevision: 0,
        idempotencyKey: "idem-tsc3-1",
        action: firstAction,
      },
    },
    {
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
      type: "action",
      sessionId,
      seq: 2,
      requestId: "t-2",
      payload: {
        protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
        sessionId,
        clientSeq: 2,
        baseRevision: revisionAfterFirst,
        idempotencyKey: "idem-tsc3-2",
        action: { type: "step", args: {} },
      },
    },
    {
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
      type: "action",
      sessionId,
      seq: 3,
      requestId: "t-3",
      payload: {
        protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
        sessionId,
        clientSeq: 3,
        baseRevision: revisionAfterFirst + 1,
        idempotencyKey: "idem-tsc3-3",
        action: { type: "pause", args: {} },
      },
    },
  ];
}

async function runVariant(rig: SessionTestRig, variant: "baseline" | "mutated"): Promise<VariantSession> {
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
  const client = await rig.app.injectWS("/sessions/channel", {
    headers: { cookie: `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookie}` },
  });
  const collector = new FrameCollector();
  collector.attach(client);
  for (const frame of scriptFrames(sessionId, variant)) {
    client.send(JSON.stringify(frame));
  }
  await collector.waitFor(3);
  return { sessionId, client, collector };
}

describe("ZR-P4 时序统计面:通道级行为在变体间无可区分差异(T-SC3 承接)", () => {
  it("同题目同脚本两个变体:帧数 / 类型序列 / 帧长分布 / 归一化载荷逐字节一致", async () => {
    const rig = await buildSessionTestRig();
    await rig.registerChallenge();

    const variantA = await runVariant(rig, "baseline");
    const variantB = await runVariant(rig, "baseline");

    // 双面取样:客户端线上次序 + 服务端录制面(rig 级录制器)。
    const clientFramesA = [...variantA.collector.frames];
    const clientFramesB = [...variantB.collector.frames];
    const serverFramesA = rig.outboundRecorder.framesOf(variantA.sessionId);
    const serverFramesB = rig.outboundRecorder.framesOf(variantB.sessionId);

    expect(clientFramesA).toHaveLength(3);
    expect(serverFramesA).toHaveLength(3);

    // 主断言:帧长分布逐位置 + 类型序列 + 归一化载荷(客户端面与服务端面)。
    assertIndistinguishable(clientFramesA, clientFramesB, "客户端帧分布(变体 A vs B)");
    assertIndistinguishable(serverFramesA, serverFramesB, "服务端录制帧分布(变体 A vs B)");

    // 帧长分布的显式数值断言(逐字节;主断言的直读形态)。
    expect(frameLengths(clientFramesA)).toEqual(frameLengths(clientFramesB));

    // 时序面(抗-flaky):只断言次数与录制序单调性,不断言响应时长。
    const records = rig.outboundRecorder.records().filter(
      (record) => record.frame.sessionId === variantA.sessionId || record.frame.sessionId === variantB.sessionId,
    );
    expect(records).toHaveLength(6);
    for (let i = 1; i < records.length; i += 1) {
      const previous = records[i - 1]?.recordedAt ?? 0;
      expect(records[i]?.recordedAt).toBeGreaterThanOrEqual(previous);
    }
  });

  it("红灯反例:变更脚本的帧分布可被检出(统计面零命中非静默绿灯)", async () => {
    const rig = await buildSessionTestRig();
    await rig.registerChallenge();

    const baseline = await runVariant(rig, "baseline");
    const mutated = await runVariant(rig, "mutated");

    // 首动作载荷变更(write_bytes 字节数不同)→ 第 1 帧即可区分:
    // 帧长不同 + 归一化载荷不同。检出能力证明零命中断言有效。
    const lengthsA = frameLengths([...baseline.collector.frames]);
    const lengthsM = frameLengths([...mutated.collector.frames]);
    expect(lengthsA[0]).not.toBe(lengthsM[0]);
    expect(firstDivergence([...baseline.collector.frames], [...mutated.collector.frames])).toBe(0);
    expect(() =>
      assertIndistinguishable(
        [...baseline.collector.frames],
        [...mutated.collector.frames],
        "红灯反例(应可检出)",
      ),
    ).toThrow(/可区分/);
  });
});

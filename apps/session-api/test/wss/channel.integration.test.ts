/**
 * WSS 动作通道集成测试(阶段三任务分解 WP-5 完成标准;D-API-40 ~ D-API-48)。
 *
 * 全链路绿(13.3 断线重连):签发 embed token → REST create_session(拿
 * Cookie)→ WSS 升级(Cookie)→ 发动作 → 收 action_response(过冻结
 * WssFrameSchema 断言,ProjectionDelta 原样)→ 断开 → 重连 → REST
 * sync-projection → 新 baseRevision 继续。
 * 红灯:未认证升级拒;跨会话帧拒;首帧版本不受支持拒;锚定后版本漂移帧拒;
 * 畸形载荷(strictObject)错误帧 + 零校验器细节;帧超 MAX_WSS_FRAME_BYTES;
 * 频率超限确定性;多连接踢旧;优雅停机有序关闭;串行不变性。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import { connect as netConnect } from "node:net";
import {
  MAX_WSS_FRAME_BYTES,
  SESSION_ACTION_PROTOCOL_VERSION,
  WssFrameSchema,
  type WssFrame,
} from "@stackmaster/protocol";

import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  buildSessionTestRig,
  sessionCommand,
  sessionCredentialFromSetCookie,
  credentialHeaders,
  type SessionTestRig,
  type SessionRigOptions,
} from "../routes/helpers/session-rig.js";
import { WSS_CHANNEL_ROUTE } from "../../src/wss/index.js";
import { SESSION_CREDENTIAL_COOKIE_NAME } from "../../src/auth/cookie.js";
import type { RigWssClient } from "../routes/helpers/session-rig.js";

// ── 测试工具 ─────────────────────────────────────────────────────────────────

/** 出站帧收集器:逐帧 push + 条件等待(帧到达次序即线上次序)。 */
class FrameCollector {
  readonly frames: WssFrame[] = [];
  readonly closes: { code: number }[] = [];

  attach(client: RigWssClient): void {
    client.on("message", (data: Buffer) => {
      this.frames.push(JSON.parse(data.toString("utf8")) as WssFrame);
    });
    client.on("close", (code: number) => {
      this.closes.push({ code });
    });
  }

  async waitFor(predicate: (frames: readonly WssFrame[]) => boolean, timeoutMs = 5000): Promise<void> {
    await vi.waitFor(
      () => {
        if (!predicate(this.frames)) {
          throw new Error("等待出站帧条件超时");
        }
      },
      { timeout: timeoutMs, interval: 10 },
    );
  }
}

/** 构造入站动作帧(冻结信封;载荷层 clientSeq / baseRevision 由测试指定)。 */
function actionFrame(input: {
  sessionId: string;
  seq: number;
  clientSeq?: number;
  baseRevision?: number;
  idempotencyKey: string;
  actionType?: "pause" | "write_bytes" | "step";
  requestId?: string;
  protocolVersion?: number;
  frameSessionId?: string;
  payloadSessionId?: string;
  extraPayloadFields?: Record<string, unknown>;
}): Record<string, unknown> {
  const sessionId = input.frameSessionId ?? input.sessionId;
  const payloadSessionId = input.payloadSessionId ?? input.sessionId;
  return {
    protocolVersion: input.protocolVersion ?? SESSION_ACTION_PROTOCOL_VERSION,
    type: "action",
    sessionId,
    seq: input.seq,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    payload: {
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
      sessionId: payloadSessionId,
      clientSeq: input.clientSeq ?? input.seq,
      baseRevision: input.baseRevision ?? 0,
      idempotencyKey: input.idempotencyKey,
      action:
        input.actionType === "write_bytes"
          ? { type: "write_bytes", args: { addressHex: "0x401000", bytesHex: "c3" } }
          : input.actionType === "step"
            ? { type: "step", args: {} }
            : { type: "pause", args: {} },
      ...input.extraPayloadFields,
    },
  };
}

/** rig + 会话 + 凭证 Cookie 的一次性装配(红灯 / 绿灯共用)。 */
async function createConnectedStack(rig: SessionTestRig): Promise<{
  sessionId: string;
  cookie: string;
  client: RigWssClient;
}> {
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
  const sessionId = (response.json() as {
    payload: { sessionId: string };
  }).payload.sessionId;
  const cookie = sessionCredentialFromSetCookie(response);
  const client = await rig.connectChannel(cookie);
  return { sessionId, cookie, client };
}

const IDLE_CLEANUPS: (() => Promise<void>)[] = [];

async function buildWssRig(options: SessionRigOptions = {}): Promise<SessionTestRig> {
  const rig = await buildSessionTestRig(options);
  IDLE_CLEANUPS.push(async () => {
    await rig.wssRegistry.closeAll();
    await rig.app.close();
  });
  return rig;
}

afterEach(async () => {
  const cleanups = IDLE_CLEANUPS.splice(0, IDLE_CLEANUPS.length);
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

// ── 全链路绿 ────────────────────────────────────────────────────────────────

describe("WSS 动作通道全链路(13.3 断线重连对齐)", () => {
  it("签发 → create_session → WSS 升级 → 动作 → action_response(过冻结帧 Schema,投影原样下发)", async () => {
    const rig = await buildWssRig();
    const { sessionId, client } = await createConnectedStack(rig);
    const collector = new FrameCollector();
    collector.attach(client);

    client.send(JSON.stringify(actionFrame({
      sessionId,
      seq: 1,
      clientSeq: 1,
      baseRevision: 0,
      idempotencyKey: "idem-full-link-1",
      actionType: "write_bytes",
      requestId: "t-1",
    })));
    await collector.waitFor((frames) => frames.length === 1);

    const frame = collector.frames[0];
    // 出站帧整体过冻结 WssFrameSchema(信封 + ActionResponse 载荷 + superRefine)。
    const parsed = WssFrameSchema.parse(frame);
    expect(parsed.type).toBe("action_response");
    if (parsed.type !== "action_response") {
      return;
    }
    expect(parsed.sessionId).toBe(sessionId);
    expect(parsed.seq).toBe(1);
    expect(parsed.requestId).toBe("t-1"); // 传输层 requestId 原样回显(D-API-5)
    expect(parsed.protocolVersion).toBe(SESSION_ACTION_PROTOCOL_VERSION);
    // 载荷原样转发执行域产物:revision 前进、增量耦合、事件白名单面。
    expect(parsed.payload.revision).toBe(1);
    expect(parsed.payload.status).toBe("running");
    expect(parsed.payload.projectionDelta?.revision).toBe(parsed.payload.revision);
    expect(parsed.payload.projectionDelta).not.toBeNull();
    // 响应帧不携带"新版本"(信封按请求版本解释,D-API-2)且零凭证字段。
    expect(JSON.stringify(frame)).not.toContain("credential");
    expect(JSON.stringify(frame)).not.toContain("embedToken");
  });

  it("断开 → 重连(凭证重验)→ REST sync-projection 对齐 revision → 新 baseRevision 继续", async () => {
    const rig = await buildWssRig();
    const { sessionId, cookie, client } = await createConnectedStack(rig);
    const collector = new FrameCollector();
    collector.attach(client);
    client.send(JSON.stringify(actionFrame({
      sessionId, seq: 1, clientSeq: 1, baseRevision: 0,
      idempotencyKey: "idem-reconnect-1", actionType: "step", requestId: "t-1",
    })));
    await collector.waitFor((frames) => frames.length === 1);
    client.close();

    // 重连:新升级 = 凭证重验(preHandler 全量重跑)。
    const reconnected = await rig.connectChannel(cookie);
    const collector2 = new FrameCollector();
    collector2.attach(reconnected);

    // REST sync-projection:只重发缓存投影,revision 对齐(通道不新增同步面)。
    const syncResponse = await rig.app.inject({
      method: "POST",
      url: "/sessions/projection-sync",
      cookies: { [SESSION_CREDENTIAL_COOKIE_NAME]: cookie },
      headers: credentialHeaders(),
      payload: sessionCommand("sync_projection", { sessionId }),
    });
    expect(syncResponse.statusCode).toBe(200);
    const synced = syncResponse.json() as { payload: { revision: number } };
    expect(synced.payload.revision).toBe(1);

    // 以新 baseRevision 继续(载荷层 clientSeq 也使用新序号区间)。
    reconnected.send(JSON.stringify(actionFrame({
      sessionId, seq: 2, clientSeq: 2, baseRevision: 1,
      idempotencyKey: "idem-reconnect-2", actionType: "step", requestId: "t-2",
    })));
    await collector2.waitFor((frames) => frames.length === 1);
    const parsed = WssFrameSchema.parse(collector2.frames[0]);
    expect(parsed.type).toBe("action_response");
    if (parsed.type === "action_response") {
      expect(parsed.payload.revision).toBe(2);
      expect(parsed.seq).toBe(1); // 新连接的出站 seq 重起
    }
    // 会话不因连接断开而关闭(断线保持的服务端侧义务)。
    expect(rig.manager.liveCount).toBe(1);
  });

  it("心跳节拍内连接保活(协议层 ping/pong,无应用层心跳帧,D-API-6)", async () => {
    const rig = await buildWssRig({
      wss: { heartbeatIntervalSeconds: 0.05, idleTimeoutSeconds: 0.5 },
    });
    const { sessionId, client } = await createConnectedStack(rig);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // ws OPEN = 1:多个心跳节拍(ping → 客户端协议层自动 pong)后连接仍活跃。
    expect(client.readyState).toBe(1);
    const collector = new FrameCollector();
    collector.attach(client);
    client.send(JSON.stringify(actionFrame({
      sessionId, seq: 1, idempotencyKey: "idem-heartbeat-1", actionType: "pause",
    })));
    await collector.waitFor((frames) => frames.length === 1);
    // 通道上零应用层心跳帧:出站帧只有 action_response(记录面验证)。
    expect(rig.outboundRecorder.frames().every((frame) => frame.type === "action_response")).toBe(true);
  });
});

// ── 串行不变性与幂等 ────────────────────────────────────────────────────────

describe("WSS 动作通道串行不变性与幂等前置守卫", () => {
  it("并发发 N 帧:响应序 = 执行序(revision 单调 +1),单会话串行无并发执行", async () => {
    const rig = await buildWssRig();
    const { sessionId, client } = await createConnectedStack(rig);
    const collector = new FrameCollector();
    collector.attach(client);

    const total = 10;
    for (let i = 1; i <= total; i += 1) {
      client.send(JSON.stringify(actionFrame({
        sessionId, seq: i, clientSeq: i, baseRevision: i - 1,
        idempotencyKey: `idem-serial-${i}`, actionType: "step", requestId: `t-${i}`,
      })));
    }
    await collector.waitFor((frames) => frames.length === total);

    const responses = collector.frames.map((frame) => WssFrameSchema.parse(frame));
    responses.forEach((frame, index) => {
      expect(frame.type).toBe("action_response");
      expect(frame.seq).toBe(index + 1); // 出站 seq 单调,帧序 = 执行序
      if (frame.type === "action_response") {
        expect(frame.requestId).toBe(`t-${index + 1}`);
        expect(frame.payload.revision).toBe(index + 1); // 严格 +1,无并发交错
      }
    });
  });

  it("幂等重放:同键同载荷 → 编排核心缓存响应字节相同;同键异载荷 → 确定性冲突错误帧", async () => {
    const rig = await buildWssRig();
    const { sessionId, client } = await createConnectedStack(rig);
    const collector = new FrameCollector();
    collector.attach(client);

    const frame = actionFrame({
      sessionId, seq: 1, clientSeq: 1, baseRevision: 0,
      idempotencyKey: "idem-replay-1", actionType: "write_bytes", requestId: "t-1",
    });
    client.send(JSON.stringify(frame));
    await collector.waitFor((frames) => frames.length === 1);
    client.send(JSON.stringify(frame)); // 原样重发(同 clientSeq 同键)
    await collector.waitFor((frames) => frames.length === 2);

    const first = WssFrameSchema.parse(collector.frames[0]);
    const replay = WssFrameSchema.parse(collector.frames[1]);
    expect(first.type).toBe("action_response");
    expect(replay.type).toBe("action_response");
    if (first.type === "action_response" && replay.type === "action_response") {
      // 载荷字节相同(编排核心账本缓存;传输层 seq 递增不进契约载荷)。
      expect(JSON.stringify(replay.payload)).toBe(JSON.stringify(first.payload));
    }

    // 同键异负载:确定性冲突错误帧(幂等窗口前置守卫)。
    client.send(JSON.stringify(actionFrame({
      sessionId, seq: 3, clientSeq: 3, baseRevision: 0,
      idempotencyKey: "idem-replay-1", actionType: "step", requestId: "t-3",
    })));
    await collector.waitFor((frames) => frames.length === 3);
    const conflict = WssFrameSchema.parse(collector.frames[2]);
    expect(conflict.type).toBe("error");
    if (conflict.type === "error") {
      expect(conflict.payload.code).toBe("idempotency_conflict");
      expect(conflict.payload.message).toBe("idempotency key conflict");
    }
  });
});

// ── 红灯矩阵 ────────────────────────────────────────────────────────────────

describe("WSS 通道红灯矩阵(确定性拒绝)", () => {
  it("未认证升级拒绝:无 Cookie → HTTP 401 + 冻结统一形态(升级即拒,D-API-14)", async () => {
    const rig = await buildWssRig();
    await rig.registerChallenge();

    // HTTP 面(不带 Upgrade 头):路由生命周期先过凭证 preHandler → 401。
    const plain = await rig.app.inject({ method: "GET", url: WSS_CHANNEL_ROUTE });
    expect(plain.statusCode).toBe(401);
    expect(plain.json()).toEqual({ code: "invalid_input_format", message: "authentication failed" });

    // 升级面:握手被 401 拒绝,连接不建立。
    await expect(rig.app.injectWS(WSS_CHANNEL_ROUTE)).rejects.toThrow(/401/);
  });

  it("跨会话帧拒绝:帧 sessionId / 载荷 sessionId 与凭证绑定会话不符 → 错误帧,连接保持", async () => {
    const rig = await buildWssRig();
    const { sessionId, client } = await createConnectedStack(rig);
    const collector = new FrameCollector();
    collector.attach(client);

    client.send(JSON.stringify(actionFrame({
      sessionId, seq: 1, idempotencyKey: "idem-cross-1",
      frameSessionId: "sess-other-session",
    })));
    await collector.waitFor((frames) => frames.length === 1);
    const rejected = WssFrameSchema.parse(collector.frames[0]);
    expect(rejected.type).toBe("error");
    if (rejected.type === "error") {
      expect(rejected.payload.code).toBe("invalid_input_format");
      expect(rejected.payload.message).toBe("session mismatch");
    }

    // 载荷层跨会话同样拒绝。
    client.send(JSON.stringify(actionFrame({
      sessionId, seq: 2, idempotencyKey: "idem-cross-2", payloadSessionId: "sess-other-session",
    })));
    await collector.waitFor((frames) => frames.length === 2);
    const rejectedPayload = WssFrameSchema.parse(collector.frames[1]);
    expect(rejectedPayload.type).toBe("error");

    // 连接保持:合法帧照常受理(逐帧确定性拒绝,不是断开)。
    client.send(JSON.stringify(actionFrame({ sessionId, seq: 3, idempotencyKey: "idem-cross-3" })));
    await collector.waitFor((frames) => frames.length === 3);
    expect(WssFrameSchema.parse(collector.frames[2]).type).toBe("action_response");
  });

  it("首帧版本不受支持拒绝;连接锚定后版本漂移帧拒绝(锚定不漂移,D-API-2)", async () => {
    const rig = await buildWssRig();
    const { sessionId, client } = await createConnectedStack(rig);
    const collector = new FrameCollector();
    collector.attach(client);

    // 首帧版本 2:不在受理集合 → unsupported protocol version。
    client.send(JSON.stringify(actionFrame({
      sessionId, seq: 1, idempotencyKey: "idem-ver-1", protocolVersion: 2,
    })));
    await collector.waitFor((frames) => frames.length === 1);
    const first = WssFrameSchema.parse(collector.frames[0]);
    expect(first.type).toBe("error");
    if (first.type === "error") {
      expect(first.payload.message).toBe("unsupported protocol version");
    }

    // 受理集合内的首帧锚定版本 1;随后漂移帧(版本 2)确定性拒绝。
    client.send(JSON.stringify(actionFrame({ sessionId, seq: 2, idempotencyKey: "idem-ver-2" })));
    await collector.waitFor((frames) => frames.length === 2);
    client.send(JSON.stringify(actionFrame({
      sessionId, seq: 3, idempotencyKey: "idem-ver-3", protocolVersion: 2,
    })));
    await collector.waitFor((frames) => frames.length === 3);
    const anchored = WssFrameSchema.parse(collector.frames[1]);
    expect(anchored.type).toBe("action_response");
    const drifted = WssFrameSchema.parse(collector.frames[2]);
    expect(drifted.type).toBe("error");
    if (drifted.type === "error") {
      expect(drifted.payload.message).toBe("unsupported protocol version");
    }
  });

  it("畸形载荷(strictObject)错误帧:响应面零校验器细节,细节只进受控日志(基线 #8)", async () => {
    const rig = await buildWssRig();
    const { sessionId, client } = await createConnectedStack(rig);
    const collector = new FrameCollector();
    collector.attach(client);

    client.send(JSON.stringify(actionFrame({
      sessionId, seq: 1, idempotencyKey: "idem-malformed-1",
      extraPayloadFields: { smuggledVmState: { internal: true } },
    })));
    await collector.waitFor((frames) => frames.length === 1);
    const raw = JSON.stringify(collector.frames[0]);
    const rejected = WssFrameSchema.parse(collector.frames[0]);
    expect(rejected.type).toBe("error");
    if (rejected.type === "error") {
      // 冻结形态逐字节断言:零 Zod issue 路径、零输入片段回显。
      expect(rejected.payload.code).toBe("invalid_input_format");
      expect(rejected.payload.message).toBe("malformed frame");
      expect(Object.keys(rejected.payload).sort()).toEqual(["code", "message"]);
    }
    expect(raw).not.toContain("smuggledVmState");
    expect(raw).not.toContain("issue");

    // 畸形 JSON 与二进制帧同样错误帧拒绝(连接保持)。
    client.send("{not-json");
    await collector.waitFor((frames) => frames.length === 2);
    expect(WssFrameSchema.parse(collector.frames[1]).type).toBe("error");

    // 受控日志:有 reason 与 issue 计数 / 路径,无载荷原文。
    const rejectionLogs = rig.capture.entries().filter((entry) => entry.msg === "wss frame rejected");
    expect(rejectionLogs.length).toBeGreaterThanOrEqual(2);
    const strictLog = rejectionLogs.find((entry) => entry.reason === "malformed_frame");
    expect(strictLog).toBeDefined();
    expect(strictLog?.issueCount).toBeGreaterThan(0);
    expect(rig.capture.raw()).not.toContain("smuggledVmState");
  });

  it("帧超 MAX_WSS_FRAME_BYTES:协议层 close 1009 强制断开(8.3 字节护栏)", async () => {
    const rig = await buildWssRig();
    const { client } = await createConnectedStack(rig);
    const collector = new FrameCollector();
    collector.attach(client);

    const oversized = "x".repeat(MAX_WSS_FRAME_BYTES + 1);
    client.send(oversized);
    await vi.waitFor(
      () => {
        if (collector.closes.length === 0) {
          throw new Error("等待超限关闭超时");
        }
      },
      { timeout: 5000, interval: 10 },
    );
    expect(collector.closes[0]?.code).toBe(1009);
  });

  it("消息频率超限:令牌桶触顶逐帧确定性拒绝(错误帧,连接保持)", async () => {
    const rig = await buildWssRig({ wss: { messageRatePerSecond: 2 } });
    const { sessionId, client } = await createConnectedStack(rig);
    const collector = new FrameCollector();
    collector.attach(client);

    for (let i = 1; i <= 4; i += 1) {
      client.send(JSON.stringify(actionFrame({
        sessionId, seq: i, idempotencyKey: `idem-rate-${i}`, actionType: "step",
      })));
    }
    // 确定性:前 2 帧消耗桶容量受理,第 3 / 4 帧立即错误帧(同步闸先于串行链),
    // 之后受理响应按执行序到达。
    await collector.waitFor((frames) => frames.length === 4);
    const kinds = collector.frames.map((frame) => WssFrameSchema.parse(frame).type);
    expect(kinds).toEqual(["error", "error", "action_response", "action_response"]);
    const rateError = WssFrameSchema.parse(collector.frames[0]);
    if (rateError.type === "error") {
      expect(rateError.payload.code).toBe("budget_exhausted");
      expect(rateError.payload.message).toBe("message rate limit exceeded");
    }
  });
});

// ── 多连接 / 断线保持 / 停机 ────────────────────────────────────────────────

describe("WSS 通道多连接、断线保持与优雅停机", () => {
  it("多连接踢旧:同会话第二连接激活 → 旧连接收错误帧说明后 close 1008,新连接可用", async () => {
    const rig = await buildWssRig();
    const { sessionId, cookie, client: oldClient } = await createConnectedStack(rig);
    const oldCollector = new FrameCollector();
    oldCollector.attach(oldClient);

    const newClient = await rig.connectChannel(cookie);
    const newCollector = new FrameCollector();
    newCollector.attach(newClient);

    await oldCollector.waitFor((frames) => frames.length === 1);
    const kick = WssFrameSchema.parse(oldCollector.frames[0]);
    expect(kick.type).toBe("error");
    if (kick.type === "error") {
      expect(kick.payload.message).toBe("connection replaced");
    }
    await vi.waitFor(
      () => {
        if (oldCollector.closes.length === 0) {
          throw new Error("等待旧连接关闭超时");
        }
      },
      { timeout: 5000, interval: 10 },
    );
    expect(oldCollector.closes[0]?.code).toBe(1008);

    // 新连接可用;串行不变性底线:同一时刻至多一条活跃通道。
    newClient.send(JSON.stringify(actionFrame({
      sessionId, seq: 1, idempotencyKey: "idem-kick-1", actionType: "step",
    })));
    await newCollector.waitFor((frames) => frames.length === 1);
    expect(WssFrameSchema.parse(newCollector.frames[0]).type).toBe("action_response");
    expect(rig.wssRegistry.hasActive(sessionId)).toBe(true);
    // 断线保持路径(客户端发起断开 → 服务端 close 事件 → 保持计时器)由
    // connection-lifecycle.test.ts 以替身 socket 覆盖:injectWS 模拟传输不把
    // 客户端 close 传播为服务端 close 事件(真实 TCP 面不受影响)。
  });

  it("优雅停机:closeAll 冲刷发送缓冲后以 close 1001 有序关闭全部活跃连接", async () => {
    const rig = await buildWssRig();
    const { sessionId, client } = await createConnectedStack(rig);
    const collector = new FrameCollector();
    collector.attach(client);
    client.send(JSON.stringify(actionFrame({
      sessionId, seq: 1, idempotencyKey: "idem-shutdown-1", actionType: "step",
    })));
    await collector.waitFor((frames) => frames.length === 1);

    await rig.wssRegistry.closeAll();
    await vi.waitFor(
      () => {
        if (collector.closes.length === 0) {
          throw new Error("等待停机关闭超时");
        }
      },
      { timeout: 5000, interval: 10 },
    );
    expect(collector.closes[0]?.code).toBe(1001);
    expect(rig.wssRegistry.activeCount).toBe(0);
  });
});

// ── 空闲超时(原始 socket:不回 pong 的静默客户端)──────────────────────────

describe("WSS 通道空闲超时(D-API-42)", () => {
  it("静默连接(不回 pong)超过空闲超时 → 错误帧 + close 1000", async () => {
    const rig = await buildWssRig({
      wss: { heartbeatIntervalSeconds: 0.05, idleTimeoutSeconds: 0.15 },
    });
    await rig.registerChallenge();
    // 原始 socket 需要真实监听(injectWS 客户端会自动回 pong,无法模拟静默)。
    await rig.app.listen({ port: 0, host: "127.0.0.1" });
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
    const cookie = sessionCredentialFromSetCookie(response);
    const addresses = rig.app.addresses();
    const listenAddress = addresses[0];
    if (listenAddress === undefined) {
      throw new Error("服务未监听");
    }

    // 原始 socket:完成升级握手后保持完全静默(不回 pong)。
    const socket: Socket = await new Promise((resolve, reject) => {
      const raw = netConnect({ host: "127.0.0.1", port: listenAddress.port }, () => resolve(raw));
      raw.on("error", reject);
    });
    const key = randomBytes(16).toString("base64");
    const handshake = [
      `GET ${WSS_CHANNEL_ROUTE} HTTP/1.1`,
      `Host: 127.0.0.1:${listenAddress.port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      `Cookie: ${SESSION_CREDENTIAL_COOKIE_NAME}=${cookie}`,
      "\r\n",
    ].join("\r\n");
    const received: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    socket.write(handshake);
    await vi.waitFor(
      () => {
        const text = Buffer.concat(received).toString("utf8");
        if (!text.includes("101 Switching Protocols")) {
          throw new Error("等待升级握手完成超时");
        }
      },
      { timeout: 5000, interval: 10 },
    );

    // 静默超过空闲超时:服务端 ping 无 pong → 错误帧(尽力)+ close 1000。
    received.length = 0;
    await vi.waitFor(
      () => {
        const buffer = Buffer.concat(received);
        const text = buffer.toString("utf8");
        // close 帧:opcode 0x88,载荷前两字节 = 关闭码 1000(0x03 0xE8);
        // 服务端 close 携带 reason,帧长不定,按 [0x88, len, 03, E8] 模式匹配。
        let hasCloseFrame = false;
        for (let index = 0; index + 3 < buffer.length; index += 1) {
          const lengthByte = buffer.at(index + 1) ?? 0xff;
          if (
            buffer.at(index) === 0x88 &&
            lengthByte <= 0x7d &&
            buffer.at(index + 2) === 0x03 &&
            buffer.at(index + 3) === 0xe8
          ) {
            hasCloseFrame = true;
            break;
          }
        }
        if (!text.includes("connection idle timeout") || !hasCloseFrame) {
          throw new Error("等待空闲断开超时");
        }
      },
      { timeout: 5000, interval: 20 },
    );
    socket.destroy();
  }, 20_000);
});

/**
 * 调试通道通道语义测试(阶段四 WP-41;WP-40 协议语义 §四;ADR-DC1 条款
 * 1/3/6;假调试 worker 承载——装载与引擎语义归真实二进制的门控集成)。
 *
 * 覆盖面:升级认证 401(与既有 WSS 通道同形)、连接级版本锚定(自建同款)、
 * 方向检查、会话绑定、**限额共用**(调试帧与解题动作同一每会话桶,429
 * 字节级一致,条款 6)、attach 幂等(单实例)、重放对齐(debug_attached
 * revision = 权威日志对齐点)、调试交互不进权威日志、会话终态同步回收、
 * **展示上下文推送**(推送模型定案:attached → function_table 恰一次;
 * 每次 paused → instruction_stream;帧序与 requestId 定案见
 * debug-channel.ts 文件头;null bytesHex / jumpTargetHex 归一化为缺席)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RigWssClient } from "../routes/helpers/session-rig.js";
import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  buildSessionTestRig,
  credentialHeaders,
  sessionCommand,
  sessionCredentialFromSetCookie,
  type SessionTestRig,
} from "../routes/helpers/session-rig.js";
import { WSS_ACTION_RATE_LIMIT_ERROR } from "../../src/wss/channel-constants.js";
import { SessionMetrics, assertMetricsTextDiscipline } from "../../src/metrics/metrics.js";
import {
  DEBUG_ACTION_RATE_LIMIT_ERROR,
  DEBUG_CHANNEL_ROUTE,
  DEBUG_INTERNAL_ERROR,
  DebugChannelError,
} from "../../src/debug/index.js";
import { SESSION_CREDENTIAL_COOKIE_NAME } from "../../src/auth/cookie.js";
import { DebugFrameSchema, type DebugFrame } from "@stackmaster/protocol";

// ── 测试工具 ─────────────────────────────────────────────────────────────────

/** 出站帧收集器:逐帧 push + 条件等待(帧到达次序即线上次序)。 */
class DebugFrameCollector {
  readonly frames: DebugFrame[] = [];

  attach(client: RigWssClient): void {
    client.on("message", (data: Buffer) => {
      this.frames.push(DebugFrameSchema.parse(JSON.parse(data.toString("utf8"))));
    });
  }

  async waitFor(
    predicate: (frames: readonly DebugFrame[]) => boolean,
    timeoutMs = 5000,
  ): Promise<void> {
    await vi.waitFor(
      () => {
        if (!predicate(this.frames)) {
          throw new Error("等待调试出站帧条件超时");
        }
      },
      { timeout: timeoutMs, interval: 10 },
    );
  }
}

/** 调试通道请求帧构造(冻结信封;version 漂移 / 越权字段由参数注入)。 */
function debugFrame(input: {
  sessionId: string;
  seq: number;
  type: "debug_attach" | "debug_window" | "debug_step" | "debug_run_to_breakpoint" | "debug_search";
  payload: Record<string, unknown>;
  requestId?: string;
  protocolVersion?: number;
  extraEnvelopeFields?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    protocolVersion: input.protocolVersion ?? 1,
    type: input.type,
    sessionId: input.sessionId,
    seq: input.seq,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    payload: input.payload,
    ...input.extraEnvelopeFields,
  });
}

interface DebugStack {
  rig: SessionTestRig;
  sessionId: string;
  cookie: string;
  client: RigWssClient;
  collector: DebugFrameCollector;
}

/** rig + 会话 + 调试通道连接(绿灯共用前置)。 */
async function createDebugStack(
  rig: SessionTestRig,
  options: { attach?: boolean } = {},
): Promise<DebugStack> {
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
  const cookie = sessionCredentialFromSetCookie(response);
  const client = await rig.connectDebugChannel(cookie);
  const collector = new DebugFrameCollector();
  collector.attach(client);
  if (options.attach !== false) {
    client.send(debugFrame({
      sessionId,
      seq: 1,
      type: "debug_attach",
      payload: { origin: { kind: "revision", revision: 0 } },
      requestId: "attach-1",
    }));
    // 推送模型:attached 之后服务端主动推 function_table(running 对齐则止于
    // 两帧);等待两帧到齐再返回,后续发送不与推送竞争观察窗口。
    await collector.waitFor((frames) => frames.length === 2);
    expect(collector.frames[0]?.type).toBe("debug_attached");
    expect(collector.frames[1]?.type).toBe("debug_function_table");
  }
  return { rig, sessionId, cookie, client, collector };
}

const CLEANUPS: (() => Promise<void>)[] = [];

async function buildRig(options: Parameters<typeof buildSessionTestRig>[0] = {}) {
  const rig = await buildSessionTestRig(options);
  CLEANUPS.push(async () => {
    await rig.debugOrchestrator.dispose();
    await rig.wssRegistry.closeAll();
    await rig.app.close();
  });
  return rig;
}

afterEach(async () => {
  const cleanups = CLEANUPS.splice(0, CLEANUPS.length);
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

// ── 升级认证与版本锚定 ────────────────────────────────────────────────────────

describe("调试通道升级认证与版本锚定(自建同款,既有通道零改动)", () => {
  it("未认证升级 = HTTP 401 + 冻结 PublicError(与既有 WSS 通道同一 preHandler)", async () => {
    const rig = await buildRig();
    const unauthorized = await rig.app.inject({ method: "GET", url: DEBUG_CHANNEL_ROUTE });
    expect(unauthorized.statusCode).toBe(401);
    const wssUnauthorized = await rig.app.inject({ method: "GET", url: "/sessions/channel" });
    // 字节级一致:同一认证中间件、同一冻结形态(防枚举,零原因区分)。
    expect(unauthorized.payload).toBe(wssUnauthorized.payload);
    expect(unauthorized.statusCode).toBe(wssUnauthorized.statusCode);
  });

  it("首帧版本不受支持 → 错误帧;受理版本锚定连接;漂移帧确定性拒绝", async () => {
    const stack = await createDebugStack(await buildRig(), { attach: false });
    const { client, collector, sessionId } = stack;

    // 首帧版本不在受理集合 → unsupported version(连接保持,锚定未发生)。
    client.send(debugFrame({
      sessionId, seq: 1, type: "debug_step", payload: {}, protocolVersion: 99,
    }));
    await collector.waitFor((frames) => frames.length === 1);
    expect(collector.frames[0]?.type).toBe("error");
    if (collector.frames[0]?.type === "error") {
      expect(collector.frames[0].payload).toEqual({
        code: "invalid_input_format",
        message: "unsupported protocol version",
      });
    }

    // 受理版本锚定连接(首帧 v1 即解释版本);推送模型:attached 之后伴随
    // function_table 推送。
    client.send(debugFrame({
      sessionId, seq: 2, type: "debug_attach",
      payload: { origin: { kind: "revision", revision: 0 } },
    }));
    await collector.waitFor((frames) => frames.length === 3);
    expect(collector.frames[1]?.type).toBe("debug_attached");
    expect(collector.frames[2]?.type).toBe("debug_function_table");

    // 锚定后漂移 → version_anchor_violation(同款锚定语义)。
    client.send(debugFrame({
      sessionId, seq: 3, type: "debug_step", payload: {}, protocolVersion: 99,
    }));
    await collector.waitFor((frames) => frames.length === 4);
    if (collector.frames[3]?.type === "error") {
      expect(collector.frames[3].payload.message).toBe("unsupported protocol version");
    }
    expect(stack.rig.manager.liveCount).toBe(1);
  });

  it("上行 S→C 类型 = 方向违规;跨会话帧 = 会话绑定拒绝;未知载荷字段 = 畸形", async () => {
    const stack = await createDebugStack(await buildRig(), { attach: false });
    const { client, collector, sessionId } = stack;

    // S→C 类型出现在上行:判别联合下载荷形状无法被解析 → 畸形帧错误帧。
    client.send(JSON.stringify({
      protocolVersion: 1,
      type: "debug_window_data",
      sessionId,
      seq: 1,
      payload: { addressHex: "0x400000", bytesHex: "00" },
    }));
    client.send(debugFrame({
      sessionId: "sess-other-session-000001",
      seq: 2,
      type: "debug_step",
      payload: {},
    }));
    client.send(JSON.stringify({
      protocolVersion: 1,
      type: "debug_step",
      sessionId,
      seq: 3,
      payload: { rogueField: true },
    }));
    await collector.waitFor((frames) => frames.length === 3);
    expect(collector.frames.map((frame) => (frame.type === "error" ? frame.payload.message : frame.type))).toEqual([
      "malformed frame",     // S→C 类型上行 = 方向违规(载荷形状无法解析)
      "session mismatch",    // 跨会话帧 = 会话绑定拒绝
      "malformed frame",     // 未知载荷字段 = strictObject 拒绝
    ]);
  });
});

// ── 限额共用(条款 6)────────────────────────────────────────────────────────

describe("调试帧与解题动作共用同一每会话预算(D-API-50~53 同源)", () => {
  it("每会话桶被解题侧耗尽 → 调试帧 429(budget_exhausted / 文案字节级一致)", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    let nowMs = now.getTime();
    const rig = await buildRig({ now: () => nowMs, wss: { messageRatePerSecond: 2 } });
    const stack = await createDebugStack(rig, { attach: false });

    // 直接抽干共享桶(冻结时钟 = 零补充,确定性触顶)。
    expect(rig.sessionActionLimiter.tryTake(stack.sessionId)).toBe(true);
    expect(rig.sessionActionLimiter.tryTake(stack.sessionId)).toBe(true);

    stack.client.send(debugFrame({
      sessionId: stack.sessionId, seq: 1, type: "debug_attach",
      payload: { origin: { kind: "revision", revision: 0 } },
    }));
    await stack.collector.waitFor((frames) => frames.length === 1);
    expect(stack.collector.frames[0]?.type).toBe("error");
    if (stack.collector.frames[0]?.type === "error") {
      // 429 冻结形态与解题侧字节级一致(条款 6)。
      expect(stack.collector.frames[0].payload).toEqual(DEBUG_ACTION_RATE_LIMIT_ERROR);
      expect(stack.collector.frames[0].payload).toEqual(WSS_ACTION_RATE_LIMIT_ERROR);
    }
    nowMs += 10_000; // 时钟前进:桶补充后同一帧形态放行
    stack.client.send(debugFrame({
      sessionId: stack.sessionId, seq: 2, type: "debug_attach",
      payload: { origin: { kind: "revision", revision: 0 } },
    }));
    // 推送模型:attached 之后伴随 function_table 推送(帧序确定)。
    await stack.collector.waitFor((frames) => frames.length === 3);
    expect(stack.collector.frames[1]?.type).toBe("debug_attached");
    expect(stack.collector.frames[2]?.type).toBe("debug_function_table");
  });

  it("预算拒绝计数进 /metrics(挤占观察面;标签零秘密零标识符)", async () => {
    const nowMs = new Date("2026-01-01T00:00:00Z").getTime();
    const metrics = new SessionMetrics();
    const rig = await buildRig({
      now: () => nowMs,
      wss: { messageRatePerSecond: 1 },
      metrics,
    });
    const stack = await createDebugStack(rig, { attach: false });
    rig.sessionActionLimiter.tryTake(stack.sessionId);
    rig.sessionActionLimiter.tryTake(stack.sessionId);
    rig.sessionActionLimiter.tryTake(stack.sessionId);
    stack.client.send(debugFrame({
      sessionId: stack.sessionId, seq: 1, type: "debug_step", payload: {},
    }));
    await stack.collector.waitFor((frames) => frames.length === 1);
    expect(stack.collector.frames[0]?.type).toBe("error");
    const text = await metrics.render();
    expect(text).toContain("session_api_debug_budget_rejections_total 1");
    // 新增指标族在白名单机检下零违例(标签纪律)。
    expect(assertMetricsTextDiscipline(text)).toEqual([]);
  });
});

// ── attach 幂等 / 重放对齐 / 不进权威日志 / 回收 ────────────────────────────

describe("attach 幂等、确定性重放对齐与权威日志零污染", () => {
  it("重放对齐:attach origin=revision N → debug_attached.revision = 权威日志对齐点", async () => {
    const rig = await buildRig();
    const stack = await createDebugStack(rig, { attach: false });

    // 真实会话两个已接受动作(假 worker revision 1→2),submit 落权威日志。
    for (const actionType of ["step", "step"] as const) {
      await rig.manager.applyAction(stack.sessionId, "tenant-alpha", { type: actionType, args: {} });
    }
    await rig.manager.submit(stack.sessionId, "tenant-alpha");
    expect(await rig.actionLog.countBySession(stack.sessionId, "tenant-alpha")).toBe(2);

    stack.client.send(debugFrame({
      sessionId: stack.sessionId, seq: 1, type: "debug_attach",
      payload: { origin: { kind: "revision", revision: 2 } },
      requestId: "attach-replay",
    }));
    await stack.collector.waitFor((frames) => frames.length === 2);
    const attached = stack.collector.frames[0];
    expect(attached?.type).toBe("debug_attached");
    if (attached?.type === "debug_attached") {
      expect(attached.requestId).toBe("attach-replay");
      expect(attached.payload.revision).toBe(2);
      expect(attached.payload.status).toBe("running");
      expect(attached.payload.paused).toBeUndefined();
    }
    // 推送模型:attach 的伴生函数表回显 attach requestId(定案的唯一回显例外)。
    expect(stack.collector.frames[1]?.type).toBe("debug_function_table");
    expect(stack.collector.frames[1]?.requestId).toBe("attach-replay");
    // attach 幂等:再次 attach 复用同一实例(不重复 spawn / 重放)。
    stack.client.send(debugFrame({
      sessionId: stack.sessionId, seq: 2, type: "debug_attach",
      payload: { origin: { kind: "revision", revision: 1 } },
    }));
    await stack.collector.waitFor((frames) => frames.length === 4);
    expect(stack.collector.frames[2]?.type).toBe("debug_attached");
    expect(stack.collector.frames[3]?.type).toBe("debug_function_table");
    // 主帧(第二次 attach)无 requestId → function_table 推送帧亦不带。
    expect(stack.collector.frames[3]?.requestId).toBeUndefined();
    expect(rig.debugOrchestrator.instanceCount).toBe(1);
  });

  it("调试交互不进权威日志:window/step/run_to_breakpoint 后权威日志长度不变", async () => {
    const rig = await buildRig();
    const stack = await createDebugStack(rig); // 已 attach
    const before = await rig.actionLog.countBySession(stack.sessionId, "tenant-alpha");
    expect(before).toBe(0);

    stack.client.send(debugFrame({
      sessionId: stack.sessionId, seq: 2, type: "debug_window",
      payload: { addressHex: "0x405000", byteLength: 8 }, requestId: "w-1",
    }));
    stack.client.send(debugFrame({ sessionId: stack.sessionId, seq: 3, type: "debug_step", payload: {}, requestId: "s-1" }));
    stack.client.send(debugFrame({
      sessionId: stack.sessionId, seq: 4, type: "debug_run_to_breakpoint",
      payload: { breakpoints: ["0x400002"] }, requestId: "r-1",
    }));
    stack.client.send(debugFrame({
      sessionId: stack.sessionId, seq: 5, type: "debug_search",
      payload: { patternHex: "d3adb33f" }, requestId: "q-1",
    }));
    // 帧序:window_data、paused+instruction_stream(step)、
    // paused+instruction_stream(run_to_breakpoint)、search_results。
    await stack.collector.waitFor((frames) => frames.length === 8);

    // 每请求一帧回执,requestId 原样回显(传输层关联);暂停后紧跟指令流推送。
    expect(stack.collector.frames[2]?.type).toBe("debug_window_data");
    expect(stack.collector.frames[2]?.requestId).toBe("w-1");
    expect(stack.collector.frames[3]?.type).toBe("debug_paused");
    expect(stack.collector.frames[3]?.requestId).toBe("s-1");
    expect(stack.collector.frames[4]?.type).toBe("debug_instruction_stream");
    expect(stack.collector.frames[5]?.type).toBe("debug_paused");
    expect(stack.collector.frames[5]?.requestId).toBe("r-1");
    expect(stack.collector.frames[6]?.type).toBe("debug_instruction_stream");
    expect(stack.collector.frames[7]?.type).toBe("debug_search_results");
    expect(stack.collector.frames[7]?.requestId).toBe("q-1");
    // 指令流推送帧一律不带 requestId(S→C 主动推送语义,文件头定案)。
    expect(stack.collector.frames[4]?.requestId).toBeUndefined();
    expect(stack.collector.frames[6]?.requestId).toBeUndefined();

    // 权威日志零污染;真实会话 revision 不受调试交互影响(条款 4)。
    expect(await rig.actionLog.countBySession(stack.sessionId, "tenant-alpha")).toBe(0);
    expect(rig.manager.getSessionSummary(stack.sessionId, "tenant-alpha")?.revision).toBe(0);
  });

  it("checkpoint 起点只解析日志位置;未知 checkpoint 确定性拒绝", async () => {
    const rig = await buildRig();
    const stack = await createDebugStack(rig, { attach: false });
    stack.client.send(debugFrame({
      sessionId: stack.sessionId, seq: 1, type: "debug_attach",
      payload: { origin: { kind: "checkpoint", checkpointId: "cp-nonexistent" } },
    }));
    await stack.collector.waitFor((frames) => frames.length === 1);
    expect(stack.collector.frames[0]?.type).toBe("error");
    if (stack.collector.frames[0]?.type === "error") {
      expect(stack.collector.frames[0].payload.message).toBe("unknown checkpoint");
    }
  });

  it("close_session 同步回收调试实例(实例数归零,幂等回收)", async () => {
    const rig = await buildRig();
    const stack = await createDebugStack(rig); // 已 attach → 实例存在
    expect(rig.debugOrchestrator.instanceCount).toBe(1);

    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions/close",
      cookies: { [SESSION_CREDENTIAL_COOKIE_NAME]: stack.cookie },
      headers: credentialHeaders(),
      payload: sessionCommand("close_session", { sessionId: stack.sessionId }),
    });
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => {
      if (rig.debugOrchestrator.instanceCount !== 0) {
        throw new Error("等待调试实例回收");
      }
    }, { timeout: 5000, interval: 10 });
    expect(rig.debugOrchestrator.instanceCount).toBe(0);
  });
});

// ── 展示上下文推送(推送模型定案)─────────────────────────────────────────────

describe("展示上下文推送(attached → function_table 恰一次;每次 paused → instruction_stream)", () => {
  it("attach(running 对齐)帧序恰为 attached → function_table;不推指令流;function_table 回显 attach requestId", async () => {
    const rig = await buildRig();
    const stack = await createDebugStack(rig, { attach: false });
    stack.client.send(debugFrame({
      sessionId: stack.sessionId, seq: 1, type: "debug_attach",
      payload: { origin: { kind: "revision", revision: 0 } },
      requestId: "attach-1",
    }));
    await stack.collector.waitFor((frames) => frames.length === 2);
    expect(stack.collector.frames.map((frame) => frame.type)).toEqual([
      "debug_attached",
      "debug_function_table",
    ]);
    const table = stack.collector.frames[1];
    if (table?.type === "debug_function_table") {
      // requestId 定案唯一例外:主帧(attach)携带 requestId → function_table 回显。
      expect(table.requestId).toBe("attach-1");
      expect(table.payload.functions).toEqual([
        { label: "sub_400000", startAddressHex: "0x400000", byteLength: 16 },
      ]);
    }
    // running 对齐无 paused → 不推指令流(静置后帧数仍为 2,无第 3 帧)。
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stack.collector.frames.length).toBe(2);
  });

  it("attach 携带 paused → attached → function_table → instruction_stream(顺序在 attached 之后;指令流帧不带 requestId)", async () => {
    const rig = await buildRig();
    const stack = await createDebugStack(rig, { attach: false });
    // 先 attach(running)并单步,使调试实例进入暂停态(假 worker 暂停感知)。
    stack.client.send(debugFrame({
      sessionId: stack.sessionId, seq: 1, type: "debug_attach",
      payload: { origin: { kind: "revision", revision: 0 } },
    }));
    stack.client.send(debugFrame({
      sessionId: stack.sessionId, seq: 2, type: "debug_step", payload: {},
    }));
    await stack.collector.waitFor((frames) => frames.length === 4);
    // 幂等 attach 复用实例:对齐态 = paused → attached 携带 paused,推送帧序
    // attached → function_table → instruction_stream(文件头定案)。
    stack.client.send(debugFrame({
      sessionId: stack.sessionId, seq: 3, type: "debug_attach",
      payload: { origin: { kind: "revision", revision: 0 } },
      requestId: "attach-2",
    }));
    await stack.collector.waitFor((frames) => frames.length === 7);
    expect(stack.collector.frames[4]?.type).toBe("debug_attached");
    if (stack.collector.frames[4]?.type === "debug_attached") {
      expect(stack.collector.frames[4].payload.paused).toEqual({ addressHex: "0x400001" });
    }
    expect(stack.collector.frames[5]?.type).toBe("debug_function_table");
    expect(stack.collector.frames[5]?.requestId).toBe("attach-2");
    expect(stack.collector.frames[6]?.type).toBe("debug_instruction_stream");
    // 指令流推送帧一律不带 requestId(attach 携带 paused 触发也不例外)。
    expect(stack.collector.frames[6]?.requestId).toBeUndefined();
    if (stack.collector.frames[6]?.type === "debug_instruction_stream") {
      expect(stack.collector.frames[6].payload.instructions[0]?.addressHex).toBe("0x400000");
    }
  });

  it("null bytesHex / jumpTargetHex 归一化为缺席(worker 线形差异,WP-44;归一化后过冻结 Schema)", async () => {
    const rig = await buildRig();
    const stack = await createDebugStack(rig);
    stack.client.send(debugFrame({
      sessionId: stack.sessionId, seq: 2, type: "debug_step", payload: {},
    }));
    await stack.collector.waitFor((frames) => frames.length === 4);
    const stream = stack.collector.frames[3];
    expect(stream?.type).toBe("debug_instruction_stream");
    if (stream?.type === "debug_instruction_stream") {
      // 假 worker 第 2 条 bytesHex = null、第 3 条 jumpTargetHex = null:
      // 归一化后为字段缺席(收集器的 DebugFrameSchema.parse 本身即契约自检
      // ——null 形态无法通过 strictObject + optional)。
      expect(stream.payload.instructions).toEqual([
        { addressHex: "0x400000", bytesHex: "55", text: "push rbp" },
        { addressHex: "0x400001", text: "mov rbp, rsp" },
        { addressHex: "0x400002", bytesHex: "01", text: "int3" },
      ]);
      expect("bytesHex" in stream.payload.instructions[1]!).toBe(false);
      expect("jumpTargetHex" in stream.payload.instructions[2]!).toBe(false);
      expect("truncated" in stream.payload).toBe(false);
    }
  });

  it("指令流推送失败 → error 帧(internal_error)且连接存活(后续请求照常回执)", async () => {
    const rig = await buildRig();
    vi.spyOn(rig.debugOrchestrator, "instructionStream").mockRejectedValue(
      new DebugChannelError(DEBUG_INTERNAL_ERROR, "simulated instruction stream push failure"),
    );
    const stack = await createDebugStack(rig);
    stack.client.send(debugFrame({
      sessionId: stack.sessionId, seq: 2, type: "debug_step", payload: {}, requestId: "s-1",
    }));
    await stack.collector.waitFor((frames) => frames.length === 4);
    expect(stack.collector.frames[2]?.type).toBe("debug_paused");
    expect(stack.collector.frames[3]?.type).toBe("error");
    if (stack.collector.frames[3]?.type === "error") {
      expect(stack.collector.frames[3].payload).toEqual(DEBUG_INTERNAL_ERROR);
    }
    // 连接不断:后续 debug_window 照常回执(推送失败仅降级上下文可见性,
    // 与帧处理 catch 形态一致)。
    stack.client.send(debugFrame({
      sessionId: stack.sessionId, seq: 3, type: "debug_window",
      payload: { addressHex: "0x405000", byteLength: 8 }, requestId: "w-1",
    }));
    await stack.collector.waitFor((frames) => frames.length === 5);
    expect(stack.collector.frames[4]?.type).toBe("debug_window_data");
    expect(stack.collector.frames[4]?.requestId).toBe("w-1");
  });
});

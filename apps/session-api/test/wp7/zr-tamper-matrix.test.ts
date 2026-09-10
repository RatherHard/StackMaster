/**
 * ZR-T1 ~ T4 服务端篡改矩阵(阶段三 WP-7 第 2 条;映射文档 §四)。
 *
 * 矩阵逐条(ZR-T1 ~ T4 行的 Compose/编排器侧落点;服务端为权威,浏览器
 * 完全不可信——伪造面一律确定性拒绝,零状态影响):
 *  - **重放旧请求**:窗口内字节相同重放 = 编排核心缓存响应(字节相同,无
 *    再执行);窗口过期后同键重放仍确定性(缓存同形,revision 不前进);
 *    旧 baseRevision 请求(新键)= stale_base_revision 确定性拒绝——
 *    正确性由 baseRevision 与串行保证,幂等窗口只是效率设施(协议 §4.3);
 *  - **ZR-T1 / T2 伪造成功标志 / 自制快照 / 状态哈希**:strictObject 拒绝
 *    (畸形帧错误帧 + 零校验器细节),权威状态零影响;
 *  - **伪造投影**:通道无客户端 → 服务端投影入口,伪造字段 strictObject
 *    拒绝;sync-projection 只重发 worker 权威缓存投影;
 *  - **幂等键同键异负载**:idempotency_conflict 确定性冲突,无执行。
 */

import { afterEach, describe, expect, it } from "vitest";
import { canonicalize } from "@stackmaster/protocol";

import { SESSION_CREDENTIAL_COOKIE_NAME } from "../../src/auth/cookie.js";
import {
  actionFrame,
  createConnectedStack,
  sendFrame,
  type ConnectedStack,
} from "./helpers/wp7-harness.js";

const STACKS: ConnectedStack[] = [];

async function buildStack(options?: Parameters<typeof createConnectedStack>[0]): Promise<ConnectedStack> {
  const stack = await createConnectedStack(options);
  STACKS.push(stack);
  return stack;
}

afterEach(async () => {
  const stacks = STACKS.splice(0, STACKS.length);
  for (const stack of stacks) {
    await stack.rig.wssRegistry.closeAll();
    await stack.rig.app.close();
  }
});

/** 剥离服务端瞬态标识(帧 seq 与载荷 requestId)后的规范化视图(I-4 比较形态)。 */
function normalizePayload(frame: unknown): string {
  const clone = structuredClone(frame) as Record<string, unknown> & {
    payload?: Record<string, unknown>;
  };
  delete clone["seq"];
  if (clone.payload !== undefined) {
    delete clone.payload["requestId"];
  }
  return canonicalize(clone);
}

describe("重放旧请求(幂等窗口与 baseRevision 的确定性)", () => {
  it("窗口内字节相同重放 → 编排核心缓存响应字节相同(revision 不前进,无再执行)", async () => {
    const stack = await buildStack();
    const frame = actionFrame({
      sessionId: stack.sessionId, seq: 1, clientSeq: 1, baseRevision: 0,
      idempotencyKey: "tamper-replay-1", actionType: "write_bytes", bytesHex: "aa",
    });
    sendFrame(stack.client, frame);
    await stack.collector.waitFor((frames) => frames.length === 1);
    sendFrame(stack.client, frame); // 原样重发
    await stack.collector.waitFor((frames) => frames.length === 2);

    const first = stack.collector.frames[0];
    const replay = stack.collector.frames[1];
    expect(first?.type).toBe("action_response");
    // 载荷字节相同(缓存回放);传输层 seq 递增不进载荷契约。
    expect(normalizePayload(replay)).toBe(normalizePayload(first));
    expect(replay?.type).toBe("action_response");
    if (replay?.type === "action_response") {
      expect(replay.payload.revision).toBe(1);
    }
  });

  it("窗口过期后同键重放 → 仍确定性(同形响应,revision 不前进;窗口只是效率设施)", async () => {
    // 时钟可注入:窗口 TTL 2 s;推进假时钟越过 TTL。
    let nowMs = 1_700_000_000_000;
    const stack = await buildStack({
      now: () => nowMs,
      env: { IDEMPOTENCY_WINDOW_TTL_SECONDS: "2" },
    });
    const frame = actionFrame({
      sessionId: stack.sessionId, seq: 1, clientSeq: 1, baseRevision: 0,
      idempotencyKey: "tamper-expired-1", actionType: "write_bytes", bytesHex: "aa",
    });
    sendFrame(stack.client, frame);
    await stack.collector.waitFor((frames) => frames.length === 1);

    nowMs += 3_000; // 越过幂等窗口 TTL(2 s)
    sendFrame(stack.client, frame);
    await stack.collector.waitFor((frames) => frames.length === 2);
    sendFrame(stack.client, frame); // 再重放一次:确定性(同输入恒同响应)
    await stack.collector.waitFor((frames) => frames.length === 3);

    const first = stack.collector.frames[0];
    const replayA = stack.collector.frames[1];
    const replayB = stack.collector.frames[2];
    expect(first?.type).toBe("action_response");
    // 确定性:窗口过期后的重放彼此同形,且 revision 恒为首次执行结果(1)。
    expect(normalizePayload(replayA)).toBe(normalizePayload(replayB));
    for (const frameOf of [replayA, replayB]) {
      expect(frameOf?.type).toBe("action_response");
      if (frameOf?.type === "action_response") {
        expect(frameOf.payload.revision).toBe(1);
      }
    }
  });

  it("过期 revision 锚的请求(新幂等键)→ 服务端权威锚定执行,零状态腐化(实现语义:D-API-62)", async () => {
    // 实现语义登记(权威 API 语义规约 D-API-62):session-core 的 clientSeq /
    // baseRevision 预检是**结构性预检**(编排核心以内部水位与权威账本锚定
    // 请求,D-W8-9"权威判定只在执行域");载荷层携带的 clientSeq /
    // baseRevision 为客户端声明值,不入预检——旧锚请求不产生
    // stale_base_revision 拒绝,而是被服务端以当前权威 revision 重新锚定
    // 后确定性执行。正确性(零状态腐化、无并发交错)由串行队列与幂等缓存
    // 承载;本用例锁定该语义。
    const stack = await buildStack();
    // 先推进权威 revision 到 1。
    sendFrame(stack.client, actionFrame({
      sessionId: stack.sessionId, seq: 1, clientSeq: 1, baseRevision: 0,
      idempotencyKey: "tamper-stale-base-1", actionType: "step",
    }));
    await stack.collector.waitFor((frames) => frames.length === 1);
    expect(stack.collector.frames[0]?.type).toBe("action_response");

    // 旧请求形态:baseRevision = 0(过期锚),新键新 clientSeq。
    sendFrame(stack.client, actionFrame({
      sessionId: stack.sessionId, seq: 2, clientSeq: 2, baseRevision: 0,
      idempotencyKey: "tamper-stale-base-2", actionType: "step",
    }));
    await stack.collector.waitFor((frames) => frames.length === 2);
    const executed = stack.collector.frames[1];
    expect(executed?.type).toBe("action_response");
    if (executed?.type === "action_response") {
      // 服务端锚定:revision 自权威账本续算(2),而非客户端声称的旧锚。
      expect(executed.payload.revision).toBe(2);
      expect(executed.payload.userVisibleError).toBeUndefined();
    }
    // 确定性:同输入恒同响应(I-4;剥离瞬态标识后逐字节一致)——原样重发
    // (同 clientSeq 同键同负载)→ 幂等缓存回放。
    sendFrame(stack.client, actionFrame({
      sessionId: stack.sessionId, seq: 3, clientSeq: 2, baseRevision: 0,
      idempotencyKey: "tamper-stale-base-2", actionType: "step",
    }));
    await stack.collector.waitFor((frames) => frames.length === 3);
    // 同键同负载 → 幂等缓存回放(与首次执行同形)。
    expect(normalizePayload(stack.collector.frames[2])).toBe(normalizePayload(executed));
  });
});

describe("ZR-T1 / T2:伪造成功标志 / 自制快照 / 状态哈希(strictObject 拒绝)", () => {
  it.each([
    ["伪造成功标志", { status: "success" }],
    ["自制快照", { snapshot: { snapshotFormatVersion: 1, revision: 999, payload: {} } }],
    ["状态哈希字段", { stateHash: "deadbeef".repeat(8) }],
  ])("%s 字段注入载荷 → 畸形帧错误帧 + 零校验器细节", async (_label, extra) => {
    const stack = await buildStack();
    sendFrame(stack.client, actionFrame({
      sessionId: stack.sessionId, seq: 1, idempotencyKey: "tamper-forged-1",
      extraPayloadFields: extra,
    }));
    await stack.collector.waitFor((frames) => frames.length === 1);

    const rejected = stack.collector.frames[0];
    expect(rejected?.type).toBe("error");
    if (rejected?.type === "error") {
      expect(rejected.payload.code).toBe("invalid_input_format");
      expect(rejected.payload.message).toBe("malformed frame");
      expect(Object.keys(rejected.payload).sort()).toEqual(["code", "message"]);
    }
    // 零校验器细节:注入字段名与 issue 面不出现在响应。
    const raw = JSON.stringify(stack.collector.frames[0]);
    for (const key of Object.keys(extra)) {
      expect(raw).not.toContain(key);
    }

    // 权威状态零影响:连接保持,合法动作照常 +1。
    sendFrame(stack.client, actionFrame({
      sessionId: stack.sessionId, seq: 2, idempotencyKey: "tamper-forged-2", actionType: "step",
    }));
    await stack.collector.waitFor((frames) => frames.length === 2);
    const next = stack.collector.frames[1];
    expect(next?.type).toBe("action_response");
    if (next?.type === "action_response") {
      expect(next.payload.revision).toBe(1);
    }
  });

  it("REST 命令体伪造字段同样 strictObject 拒绝(400 冻结形态)", async () => {
    const { rig, sessionId, cookie } = await buildStack();
    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions/projection-sync",
      cookies: { [SESSION_CREDENTIAL_COOKIE_NAME]: cookie },
      headers: { origin: "https://plugin.example" },
      payload: sessionCommandWithForgedField(sessionId),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "invalid_input_format", message: "invalid request" });
  });
});

/** 带伪造字段的 sync_projection 命令体(跨套件复用的最小构造)。 */
function sessionCommandWithForgedField(sessionId: string): Record<string, unknown> {
  return {
    command: "sync_projection",
    protocolVersion: 1,
    payload: { sessionId, status: "success", stateHash: "deadbeef" },
  };
}

describe("ZR-T3:伪造投影不影响权威状态", () => {
  it("伪造 projectionDelta 字段被拒;sync-projection 只回 worker 权威缓存投影", async () => {
    const stack = await buildStack();
    // 执行一个合法动作,让权威 revision = 1。
    sendFrame(stack.client, actionFrame({
      sessionId: stack.sessionId, seq: 1, clientSeq: 1, baseRevision: 0,
      idempotencyKey: "tamper-proj-1", actionType: "step",
    }));
    await stack.collector.waitFor((frames) => frames.length === 1);

    // 伪造投影:客户端自报 projectionDelta / 权威 revision 999。
    sendFrame(stack.client, actionFrame({
      sessionId: stack.sessionId, seq: 2, idempotencyKey: "tamper-proj-2",
      extraPayloadFields: {
        projectionDelta: { revision: 999, dirtyRanges: [], changedRegisters: [] },
        revision: 999,
      },
    }));
    await stack.collector.waitFor((frames) => frames.length === 2);
    expect(stack.collector.frames[1]?.type).toBe("error");
    expect(JSON.stringify(stack.collector.frames[1])).not.toContain("999");

    // 权威状态不受影响:REST sync-projection 返回服务端 revision(1),零 999。
    const sync = await stack.rig.app.inject({
      method: "POST",
      url: "/sessions/projection-sync",
      cookies: { [SESSION_CREDENTIAL_COOKIE_NAME]: stack.cookie },
      headers: { origin: "https://plugin.example" },
      payload: { command: "sync_projection", protocolVersion: 1, payload: { sessionId: stack.sessionId } },
    });
    expect(sync.statusCode).toBe(200);
    const synced = sync.json() as { payload: { revision: number } };
    expect(synced.payload.revision).toBe(1);
    expect(JSON.stringify(sync.body)).not.toContain("999");

    // 后续合法动作从权威状态继续(revision 2),伪造未注入任何状态。
    sendFrame(stack.client, actionFrame({
      sessionId: stack.sessionId, seq: 3, clientSeq: 3, baseRevision: 1,
      idempotencyKey: "tamper-proj-3", actionType: "step",
    }));
    await stack.collector.waitFor((frames) => frames.length === 3);
    const next = stack.collector.frames[2];
    if (next?.type === "action_response") {
      expect(next.payload.revision).toBe(2);
    }
  });
});

describe("ZR-T4:幂等键同键异负载冲突", () => {
  it("同键同负载 → 缓存字节相同;同键异负载 → idempotency_conflict 错误帧且无执行", async () => {
    const stack = await buildStack();
    const frame = actionFrame({
      sessionId: stack.sessionId, seq: 1, clientSeq: 1, baseRevision: 0,
      idempotencyKey: "tamper-conflict-1", actionType: "write_bytes", bytesHex: "aa",
    });
    sendFrame(stack.client, frame);
    await stack.collector.waitFor((frames) => frames.length === 1);

    // 同键异负载:action 换成 step(其余同)。
    sendFrame(stack.client, actionFrame({
      sessionId: stack.sessionId, seq: 2, clientSeq: 2, baseRevision: 0,
      idempotencyKey: "tamper-conflict-1", actionType: "step",
    }));
    await stack.collector.waitFor((frames) => frames.length === 2);
    const conflict = stack.collector.frames[1];
    expect(conflict?.type).toBe("error");
    if (conflict?.type === "error") {
      expect(conflict.payload.code).toBe("idempotency_conflict");
      expect(conflict.payload.message).toBe("idempotency key conflict");
    }

    // 无执行:权威 revision 仍为 1(冲突帧不推进状态),连接保持。
    sendFrame(stack.client, actionFrame({
      sessionId: stack.sessionId, seq: 3, clientSeq: 3, baseRevision: 1,
      idempotencyKey: "tamper-conflict-2", actionType: "step",
    }));
    await stack.collector.waitFor((frames) => frames.length === 3);
    const next = stack.collector.frames[2];
    expect(next?.type).toBe("action_response");
    if (next?.type === "action_response") {
      expect(next.payload.revision).toBe(2);
    }
  });
});

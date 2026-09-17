/**
 * 调试克隆「对齐源」通道级行为测试(中期 M3 遗留移交清单第 6 项;D-API-145)。
 *
 * 缺陷面(本文件的红灯):调试实例 = attach 时按 `origin.revision` 重放权威
 * 动作日志得到的克隆;旧实现对**只读已落库日志**(仅在 `submit` 时落库)
 * ⇒ **未提交会话**的克隆恒为种子初始态,`debug_attached.revision` 恒 0
 * (M2 期真机取证:请求 `targetRevision: 1`、实际对齐 `revision: 0`)。
 *
 * 本文件用**假调试 worker**(`debug_apply_recorded` 逐条累加 revision,与真实
 * worker 的"重放进度 = 已应用条数"同构)在**通道级**固定:
 *  - 未提交会话(已落库 0 条)attach 精确对齐到请求 revision(红灯 → 绿);
 *  - 同一 revision 重复 attach 回执逐字节一致(确定性;attach 幂等零重复
 *    spawn / 零重复重放);
 *  - 不可得的 revision 一律**确定性拒绝**(超出权威 revision / 恢复基线缺口
 *    同一冻结载荷,**在 spawn 之前**判定),不静默退回种子态;
 *  - 推送时机零改动:`debug_attached` → `debug_function_table`(冻结口径)。
 *
 * 真机字节级证据(栈区 = 玩家写入字节而非全 0)在
 * `debug-clone-alignment.integration.test.ts`(SESSION_API_IT 门控,真实
 * vm-worker)。纯函数语义在 `debug-clone-alignment-source.test.ts`。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugFrameSchema, type DebugFrame } from "@stackmaster/protocol";

import {
  DebugChannelError,
  DebugChannelOrchestrator,
  DEBUG_REVISION_UNAVAILABLE_ERROR,
  placeholderDebugVariantProvider,
} from "../../src/debug/index.js";
import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  buildSessionTestRig,
  fakeDebugWorkerCommand,
  sessionCommand,
  sessionCredentialFromSetCookie,
  type RigWssClient,
  type SessionTestRig,
} from "../routes/helpers/session-rig.js";

const TENANT_ID = "tenant-alpha";

class DebugFrameCollector {
  readonly frames: DebugFrame[] = [];

  attach(client: RigWssClient): void {
    client.on("message", (data: Buffer) => {
      this.frames.push(DebugFrameSchema.parse(JSON.parse(data.toString("utf8"))));
    });
  }

  async waitForType(type: DebugFrame["type"], occurrence = 1, timeoutMs = 15000): Promise<DebugFrame> {
    await vi.waitFor(
      () => {
        if (this.frames.filter((frame) => frame.type === type).length < occurrence) {
          throw new Error(`等待调试帧 ${type} #${occurrence} 超时`);
        }
      },
      { timeout: timeoutMs, interval: 10 },
    );
    const match = this.frames.filter((frame) => frame.type === type)[occurrence - 1];
    if (match === undefined) {
      throw new Error(`帧 ${type} #${occurrence} 缺失`);
    }
    return match;
  }
}

interface DebugStack {
  readonly sessionId: string;
  readonly cookie: string;
  readonly client: RigWssClient;
  readonly collector: DebugFrameCollector;
}

/** 建会话 + 调试通道连接(不 attach;attach 由用例按需发起)。 */
async function openDebugStack(rig: SessionTestRig): Promise<DebugStack> {
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
  return { sessionId, cookie, client, collector };
}

function sendAttach(stack: DebugStack, seq: number, revision: number, requestId?: string): void {
  stack.client.send(
    JSON.stringify({
      protocolVersion: 1,
      type: "debug_attach",
      sessionId: stack.sessionId,
      seq,
      ...(requestId === undefined ? {} : { requestId }),
      payload: { origin: { kind: "revision", revision } },
    }),
  );
}

/**
 * 克隆身份面(冻结 `debug_attached` 回执载荷):信封的 `seq` / `sessionId` /
 * `requestId` 属传输簿记,不参与"同一 revision 克隆逐字节一致"的比对。
 */
function cloneIdentity(frame: DebugFrame): { type: DebugFrame["type"]; payload: unknown } {
  return { type: frame.type, payload: frame.type === "debug_attached" ? frame.payload : null };
}

/** 施加 2 个已接受动作(会话 revision → 2),**不 submit**(权威日志零落库)。 */
async function applyTwoActionsWithoutSubmit(rig: SessionTestRig, sessionId: string): Promise<void> {
  for (const action of [
    { type: "step" as const, args: {} },
    { type: "step" as const, args: {} },
  ]) {
    const response = await rig.manager.applyAction(sessionId, TENANT_ID, action);
    expect(response.status).toBe("running");
  }
}

const CLEANUPS: (() => Promise<void>)[] = [];

async function buildRig(): Promise<SessionTestRig> {
  const rig = await buildSessionTestRig();
  CLEANUPS.push(async () => {
    await rig.debugOrchestrator.dispose();
    await rig.wssRegistry.closeAll();
    await rig.app.close();
  });
  await rig.registerByteChallenge();
  return rig;
}

afterEach(async () => {
  const cleanups = CLEANUPS.splice(0, CLEANUPS.length);
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

describe("调试克隆对齐源:未提交会话(红灯面)", () => {
  it("未提交会话 attach 精确对齐到请求 revision(旧对齐源恒退化为种子态 revision 0)", async () => {
    const rig = await buildRig();
    const stack = await openDebugStack(rig);
    await applyTwoActionsWithoutSubmit(rig, stack.sessionId);

    // 前提锚:会话权威 revision = 2 而**已落库权威日志 = 0 条**(未提交)。
    expect(rig.manager.getSessionSummary(stack.sessionId, TENANT_ID)?.revision).toBe(2);
    expect(await rig.actionLog.countBySession(stack.sessionId, TENANT_ID)).toBe(0);

    sendAttach(stack, 1, 2, "attach-replay");
    const attached = await stack.collector.waitForType("debug_attached");
    expect(attached.type).toBe("debug_attached");
    if (attached.type === "debug_attached") {
      // 红灯(修前):已落库日志为空 ⇒ 重放 0 条 ⇒ revision 0(种子初始态)。
      expect(attached.payload.revision).toBe(2);
      expect(attached.payload.status).toBe("running");
      expect(attached.requestId).toBe("attach-replay");
    }
    // 推送时机零改动:attached → function_table(冻结口径)。
    await stack.collector.waitForType("debug_function_table");

    // 对齐源不含任何落库副作用:未提交会话的权威日志仍为 0 条(条款 4)。
    expect(await rig.actionLog.countBySession(stack.sessionId, TENANT_ID)).toBe(0);
  });

  it("确定性:同一会话重复 attach 回执逐字节一致,且不重复 spawn;同形会话之间亦逐字节一致", async () => {
    const rig = await buildRig();
    const first = await openDebugStack(rig);
    const second = await openDebugStack(rig);
    await applyTwoActionsWithoutSubmit(rig, first.sessionId);
    await applyTwoActionsWithoutSubmit(rig, second.sessionId);

    sendAttach(first, 1, 2, "attach-a");
    const attachedA = await first.collector.waitForType("debug_attached");
    sendAttach(second, 1, 2, "attach-b");
    const attachedB = await second.collector.waitForType("debug_attached");

    // 两个同形会话(相同权威动作序、均未提交)的**克隆身份**逐字节一致
    // (信封 seq / sessionId / requestId 属传输簿记,不入克隆身份比对)。
    expect(cloneIdentity(attachedB)).toEqual(cloneIdentity(attachedA));
    // 双实例并存(每会话至多一个调试实例)。
    expect(rig.debugOrchestrator.instanceCount).toBe(2);

    // 同一会话同一 revision 重复 attach:attach 幂等复用既有实例,克隆身份一致。
    sendAttach(first, 2, 2, "attach-a2");
    const attachedA2 = await first.collector.waitForType("debug_attached", 2);
    expect(cloneIdentity(attachedA2)).toEqual(cloneIdentity(attachedA));
    expect(rig.debugOrchestrator.instanceCount).toBe(2);
  });
});

describe("调试克隆对齐源:不可得的 revision 一律确定性拒绝(禁止静默退回种子态)", () => {
  it("超出会话权威 revision ⇒ 冻结 invalid_input_format / revision is not available(通道错误帧)", async () => {
    const rig = await buildRig();
    const stack = await openDebugStack(rig);
    await applyTwoActionsWithoutSubmit(rig, stack.sessionId);

    sendAttach(stack, 1, 3);
    const errorFrame = await stack.collector.waitForType("error");
    expect(errorFrame.type).toBe("error");
    if (errorFrame.type === "error") {
      expect(errorFrame.payload).toEqual(DEBUG_REVISION_UNAVAILABLE_ERROR);
    }
    // 未 spawn 实例(判定在装载 / spawn 之前完成)。
    expect(rig.debugOrchestrator.instanceCount).toBe(0);
  });
});

describe("调试克隆对齐源:重启恢复形态(在途账本基线 > 已落库覆盖)", () => {
  /**
   * 恢复态会话摘要形态(`SessionOrchestrator.recover` 的真实产物语义:
   * revision = 快照信封 revision,`acceptedActions` 账本自恢复点重启 ⇒
   * 在途日志为空、基线 = revision)。此处以 deps 缝的结构替身固定**对齐源
   * 语义**(真实 import_snapshot 往返归 WP-7 恢复测试;缺口形态的端到端
   * 真机证据见 `debug-clone-alignment.integration.test.ts`)。
   */
  function buildRecoveredOrchestrator(rig: SessionTestRig): DebugChannelOrchestrator {
    return new DebugChannelOrchestrator({
      manager: {
        getSessionSummary: () => ({
          challengeId: TEST_CHALLENGE_ID,
          challengeVersion: TEST_CHALLENGE_VERSION,
          revision: 6,
          acceptedActionLog: [],
        }),
        listCheckpoints: async () => [],
      },
      variantProvider: placeholderDebugVariantProvider({
        getPublic: async (challengeId, version) => rig.bundles.getPublic(challengeId, version),
      }),
      bundles: rig.bundles,
      actionLog: rig.actionLog,
      logger: rig.logger,
      idleRecycleSeconds: 30,
      runToBreakpointMaxSteps: 1000,
      workerCommand: fakeDebugWorkerCommand(),
    });
  }

  const RECOVERED_SESSION_ID = "sess-recovered-gap";

  it("基线 6 而已落库只到 3:revision 4/6 确定性拒绝(缺口前的态不静默冒充),revision 3 精确对齐", async () => {
    const rig = await buildRig();
    const orchestrator = buildRecoveredOrchestrator(rig);
    try {
      await rig.actionLog.append(
        [1, 2, 3].map((revision) => ({
          sessionId: RECOVERED_SESSION_ID,
          tenantId: TENANT_ID,
          clientSeq: revision,
          revisionAfter: revision,
          action: { type: "step", args: {} },
          submissionRef: "sub-recovered",
        })),
      );

      for (const unavailable of [4, 5, 6]) {
        const error = await orchestrator
          .attach(RECOVERED_SESSION_ID, TENANT_ID, { kind: "revision", revision: unavailable })
          .catch((thrown: unknown) => thrown);
        expect(error).toBeInstanceOf(DebugChannelError);
        expect((error as DebugChannelError).payload).toEqual(DEBUG_REVISION_UNAVAILABLE_ERROR);
      }
      // 缺口判定先于 spawn:零实例留下。
      expect(orchestrator.instanceCount).toBe(0);

      // 缺口之内(= 已落库连续前缀可达的 revision)精确对齐,不越界、不缺条。
      const receipt = await orchestrator.attach(RECOVERED_SESSION_ID, TENANT_ID, {
        kind: "revision",
        revision: 3,
      });
      expect(receipt.revision).toBe(3);
      expect(orchestrator.instanceCount).toBe(1);
    } finally {
      await orchestrator.dispose();
    }
  });

  it("恢复基线之前的已落库条目超出基线时被丢弃(不把恢复点之后的态混入克隆)", async () => {
    const rig = await buildRig();
    const orchestrator = buildRecoveredOrchestrator(rig); // revision 6 / 基线 6
    try {
      await rig.actionLog.append(
        [1, 2, 3, 4, 5].map((revision) => ({
          sessionId: RECOVERED_SESSION_ID,
          tenantId: TENANT_ID,
          clientSeq: revision,
          revisionAfter: revision,
          action: { type: "step", args: {} },
          submissionRef: "sub-recovered",
        })),
      );
      // 已落库 1..5 全部 ≤ 基线 6 ⇒ 连续覆盖只到 5(缺 6)⇒ revision 6 不可得。
      const error = await orchestrator
        .attach(RECOVERED_SESSION_ID, TENANT_ID, { kind: "revision", revision: 6 })
        .catch((thrown: unknown) => thrown);
      expect((error as DebugChannelError).payload).toEqual(DEBUG_REVISION_UNAVAILABLE_ERROR);
      // revision 5 可达(逐条上界精确,不因"接近"而降级冒充 6)。
      const receipt = await orchestrator.attach(RECOVERED_SESSION_ID, TENANT_ID, {
        kind: "revision",
        revision: 5,
      });
      expect(receipt.revision).toBe(5);
    } finally {
      await orchestrator.dispose();
    }
  });
});

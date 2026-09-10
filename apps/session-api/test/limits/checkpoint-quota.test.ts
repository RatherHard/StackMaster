/**
 * 存储与快照配额红灯(任务分解 WP-6 第 2 条;D-API-54):
 *  - 每会话 checkpoint 数量上限(≤ 协议 MAX_CHECKPOINTS_PER_SESSION = 256):
 *    触顶后 create_checkpoint 确定性拒绝(错误码 budget_exhausted,静态文案,
 *    revision 不前进,不触发 worker 往返);
 *  - 快照字节预算:超预算的恢复点不落库 + 粘性标记,后续 create_checkpoint
 *    确定性拒绝(快照字节数只有执行后可精确计量,粘性语义 = 预算触顶拒绝
 *    create_checkpoint 的确定性承载);
 *  - 每租户存储配额:已持久化快照字节合计 ≥ 配额即拒绝后续 checkpoint;
 *  - 重复触顶请求呈现同一确定性形态(status / code / message / revision)。
 */
import { describe, expect, it } from "vitest";
import type { ActionResponse } from "@stackmaster/protocol";

import { TEST_TENANT_ID, buildSessionTestRig, type SessionTestRig } from "../routes/helpers/session-rig.js";
import { evaluateCheckpointQuota } from "../../src/limits/index.js";

const CHECKPOINT_ACTION = { type: "create_checkpoint", args: {} } as const;

async function createSessionDirect(
  rig: SessionTestRig,
  overrides: { tenantId?: string } = {},
): Promise<string> {
  return rig.manager.createSession({
    tenantId: overrides.tenantId ?? TEST_TENANT_ID,
    userId: "user-42",
    challengeId: "chal-stack-escape",
    challengeVersion: "1.2.3",
    embedTokenJti: `jti-${Math.random().toString(36).slice(2)}`,
  }).then((outcome) => outcome.sessionId);
}

describe("每会话 checkpoint 数量上限(D-API-54)", () => {
  it("配额内 checkpoint 正常;触顶后 create_checkpoint 确定性拒绝(budget_exhausted)", async () => {
    const rig = await buildSessionTestRig({
      env: { SESSION_API_MAX_CHECKPOINTS_PER_SESSION: "2" },
    });
    await rig.registerChallenge();
    const sessionId = await createSessionDirect(rig);

    expect((await rig.manager.applyAction(sessionId, TEST_TENANT_ID, CHECKPOINT_ACTION)).revision).toBe(1);
    expect((await rig.manager.applyAction(sessionId, TEST_TENANT_ID, CHECKPOINT_ACTION)).revision).toBe(2);
    expect(await rig.manager.listCheckpoints(sessionId, TEST_TENANT_ID)).toHaveLength(2);
    expect(await rig.snapshots.listBySession(sessionId, TEST_TENANT_ID)).toHaveLength(2);

    // 触顶:预执行确定性拒绝(不触发 worker 往返、不消耗执行预算)。
    const firstReject = (await rig.manager.applyAction(
      sessionId,
      TEST_TENANT_ID,
      CHECKPOINT_ACTION,
    )) as ActionResponse;
    const secondReject = (await rig.manager.applyAction(
      sessionId,
      TEST_TENANT_ID,
      CHECKPOINT_ACTION,
    )) as ActionResponse;

    for (const response of [firstReject, secondReject]) {
      expect(response.status).toBe("rejected");
      expect(response.revision).toBe(2); // 权威 revision 不前进
      expect(response.projectionDelta).toBeNull();
      expect(response.publicEvents).toEqual([]);
      expect(response.userVisibleError).toEqual({
        code: "budget_exhausted",
        message: "checkpoint quota exceeded",
      });
    }
    // 两次触顶呈现同一确定性形态(status / code / message / revision 同值;
    // requestId 为服务端关联值,D-API-5 关联语义不承载确定性)。
    expect(secondReject.status).toBe(firstReject.status);
    expect(secondReject.revision).toBe(firstReject.revision);
    expect(secondReject.userVisibleError).toEqual(firstReject.userVisibleError);
    // 拒绝的 checkpoint 不入账本、不落库。
    expect(await rig.manager.listCheckpoints(sessionId, TEST_TENANT_ID)).toHaveLength(2);
    expect(await rig.snapshots.listBySession(sessionId, TEST_TENANT_ID)).toHaveLength(2);
  });

  it("checkpoint 动作拒绝不消耗 clientSeq 预算份额(配额闸先于预算计量)", async () => {
    const rig = await buildSessionTestRig({
      env: {
        SESSION_API_MAX_CHECKPOINTS_PER_SESSION: "1",
        SESSION_API_MAX_CLIENT_SEQ_PER_SESSION: "2",
      },
    });
    await rig.registerChallenge();
    const sessionId = await createSessionDirect(rig);

    expect((await rig.manager.applyAction(sessionId, TEST_TENANT_ID, CHECKPOINT_ACTION)).revision).toBe(1);
    // 触顶拒绝(配额)。
    expect(
      (await rig.manager.applyAction(sessionId, TEST_TENANT_ID, CHECKPOINT_ACTION)) as ActionResponse,
    ).toMatchObject({ status: "rejected" });
    // 配额拒绝未消耗预算:预算内的非 checkpoint 动作仍可执行。
    expect(
      (await rig.manager.applyAction(sessionId, TEST_TENANT_ID, {
        type: "write_bytes",
        args: { addressHex: "0x401000", bytesHex: "c3" },
      })) as ActionResponse,
    ).toMatchObject({ status: "running" });
  });
});

describe("快照字节预算(粘性超限,D-API-54)", () => {
  it("超预算恢复点不落库并置粘性标记;后续 create_checkpoint 确定性拒绝", async () => {
    const rig = await buildSessionTestRig({
      env: { SESSION_API_SNAPSHOT_BYTE_BUDGET: "1" }, // 最小预算:任何快照必超
    });
    await rig.registerChallenge();
    const sessionId = await createSessionDirect(rig);

    // 第一个 checkpoint 被执行域接受,但恢复点超预算 → 不落库 + 粘性标记。
    const accepted = (await rig.manager.applyAction(
      sessionId,
      TEST_TENANT_ID,
      CHECKPOINT_ACTION,
    )) as ActionResponse;
    expect(accepted.status).toBe("running");
    expect(await rig.snapshots.listBySession(sessionId, TEST_TENANT_ID)).toHaveLength(0);

    // 粘性标记:后续 create_checkpoint 预执行确定性拒绝(静态文案,零内部计量)。
    const reject = (await rig.manager.applyAction(
      sessionId,
      TEST_TENANT_ID,
      CHECKPOINT_ACTION,
    )) as ActionResponse;
    expect(reject.status).toBe("rejected");
    expect(reject.userVisibleError).toEqual({
      code: "budget_exhausted",
      message: "snapshot byte budget exceeded",
    });
    const rejectAgain = (await rig.manager.applyAction(
      sessionId,
      TEST_TENANT_ID,
      CHECKPOINT_ACTION,
    )) as ActionResponse;
    expect(rejectAgain.userVisibleError).toEqual(reject.userVisibleError);
    expect(rejectAgain.revision).toBe(reject.revision);
    // 超限恢复点永不落库(恢复锚回退语义:宁缺勿超)。
    expect(await rig.snapshots.listBySession(sessionId, TEST_TENANT_ID)).toHaveLength(0);
  });
});

describe("每租户存储配额(D-API-54)", () => {
  it("租户已持久化快照字节 ≥ 配额:该租户一切会话的 create_checkpoint 确定性拒绝", async () => {
    const rig = await buildSessionTestRig({
      env: { SESSION_API_TENANT_STORAGE_QUOTA_BYTES: "1" }, // 最小配额:一行快照即满
    });
    await rig.registerChallenge();
    const sessionA = await createSessionDirect(rig);
    const sessionB = await createSessionDirect(rig);

    // 会话 A 的首个 checkpoint 正常落库(此时用量 0 < 配额)。
    expect((await rig.manager.applyAction(sessionA, TEST_TENANT_ID, CHECKPOINT_ACTION)).revision).toBe(1);
    expect((await rig.snapshots.listBySession(sessionA, TEST_TENANT_ID)).length).toBe(1);

    // 用量已满:同会话的下一个 checkpoint 确定性拒绝。
    const rejectA = (await rig.manager.applyAction(
      sessionA,
      TEST_TENANT_ID,
      CHECKPOINT_ACTION,
    )) as ActionResponse;
    expect(rejectA.userVisibleError).toEqual({
      code: "budget_exhausted",
      message: "tenant storage quota exceeded",
    });

    // 同租户新会话同样拒绝(配额以租户为域);拒绝不落库。
    const rejectB = (await rig.manager.applyAction(
      sessionB,
      TEST_TENANT_ID,
      CHECKPOINT_ACTION,
    )) as ActionResponse;
    expect(rejectB.userVisibleError).toEqual({
      code: "budget_exhausted",
      message: "tenant storage quota exceeded",
    });
    expect(await rig.snapshots.listBySession(sessionB, TEST_TENANT_ID)).toHaveLength(0);
  });
});

describe("evaluateCheckpointQuota 纯函数判定(确定性核心)", () => {
  const limits = {
    maxCheckpointsPerSession: 3,
    snapshotByteBudget: 1000,
    tenantStorageQuotaBytes: 5000,
  };

  it("预算内的判定恒放行", () => {
    expect(
      evaluateCheckpointQuota({
        checkpointCount: 2,
        latestEnvelopeByteLength: 1000,
        snapshotOverBudget: false,
        tenantStorageUsedBytes: 4999,
        limits,
      }),
    ).toEqual({ ok: true });
    // 字节等于预算(不大于)放行;用量等于配额(不小于)拒绝——边界方向固定。
    expect(
      evaluateCheckpointQuota({
        checkpointCount: 0,
        latestEnvelopeByteLength: null,
        snapshotOverBudget: false,
        tenantStorageUsedBytes: 5000,
        limits,
      }),
    ).toEqual({ ok: false, reason: "tenant_storage", detail: expect.any(String) });
  });

  it("判定顺序固定:粘性标记 → 数量 → 字节 → 租户用量(同输入恒同结论)", () => {
    const overAll = {
      latestEnvelopeByteLength: 2000,
      tenantStorageUsedBytes: 9999,
      limits,
    };
    expect(evaluateCheckpointQuota({ ...overAll, checkpointCount: 3, snapshotOverBudget: true })).toEqual({
      ok: false,
      reason: "snapshot_budget",
      detail: expect.stringContaining("sticky"),
    });
    expect(evaluateCheckpointQuota({ ...overAll, checkpointCount: 3, snapshotOverBudget: false })).toEqual({
      ok: false,
      reason: "checkpoint_count",
      detail: expect.any(String),
    });
    expect(evaluateCheckpointQuota({ ...overAll, checkpointCount: 2, snapshotOverBudget: false })).toEqual({
      ok: false,
      reason: "snapshot_budget",
      detail: expect.any(String),
    });
    expect(evaluateCheckpointQuota({ ...overAll, checkpointCount: 2, snapshotOverBudget: false, latestEnvelopeByteLength: 999 })).toEqual({
      ok: false,
      reason: "tenant_storage",
      detail: expect.any(String),
    });
  });
});

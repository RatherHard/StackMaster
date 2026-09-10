/**
 * 存储与快照配额(任务分解 WP-6 第 2 条;D-API-54)。
 *
 * 三个维度,全部在 `create_checkpoint` 进入执行域**之前**确定性判定
 * (拒绝不触发 worker 往返、不消耗任何执行预算;呈现 = 编排器侧预检
 * ActionResponse,与 session-core 预检同形:`status: "rejected"` +
 * `userVisibleError.code = "budget_exhausted"`——16 冻结码中资源预算类
 * 协议级拒绝码,能力矩阵 addressHex / explanation 双 forbidden,零解释面,
 * 零配额内部计量透出):
 *  1. 每会话 checkpoint 数量上限(≤ 协议外圈护栏 MAX_CHECKPOINTS_PER_SESSION
 *     = 256,契约层语义见 limits.ts;默认值 = 协议上限,配置天花板同值);
 *  2. 每会话快照字节预算:以最近已知 checkpoint 信封的规范化 JSON 字节长度
 *     为预执行估计——信封越大估计越准,状态增长只会更大(保守方向);持久化
 *     边界复核实际信封字节数,超限即粘性标记(见下);
 *  3. 每租户存储配额:已持久化快照密文行字节数合计(SessionRepository ×
 *     SnapshotStore 组合查询,T0 形态;阶段六全面租户隔离时复核为反norm计数)
 *     ≥ 配额即拒绝后续 checkpoint。
 *
 * **粘性超限标记**:快照字节数只有在该 checkpoint 被引擎接受后才能精确计量;
 * 若实际信封超出预算(或租户配额已满),该恢复点不落库(审计 + 受控日志,
 * 恢复锚回退到上一个预算内快照——"最近快照丢尾"语义容忍),并置粘性标记,
 * 此后该会话的一切 create_checkpoint 确定性拒绝。同一动作序列恒同一判定
 * 序列(I-4);粘性标记只升不降(预算是资源上限,不是动态水位)。
 */

/** 每会话 checkpoint 配额三元组(config 启动校验后的冻结形态)。 */
export interface CheckpointQuotaLimits {
  /** 每会话 checkpoint 数量上限(≤ MAX_CHECKPOINTS_PER_SESSION = 256)。 */
  readonly maxCheckpointsPerSession: number;
  /** 单快照信封字节预算(信封规范化 JSON 字节长度口径)。 */
  readonly snapshotByteBudget: number;
  /** 每租户已持久化快照字节配额(checkpoints 行密文字节合计口径)。 */
  readonly tenantStorageQuotaBytes: number;
}

/** 配额判定结论(reason 只进受控日志与审计;响应面恒为冻结形态)。 */
export type CheckpointQuotaVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "checkpoint_count" | "snapshot_budget" | "tenant_storage";
      readonly detail: string;
    };

/** 配额触顶的冻结静态文案(userVisibleError.message;零内部计量)。 */
export const CHECKPOINT_QUOTA_MESSAGES: Record<
  NonNullable<Extract<CheckpointQuotaVerdict, { ok: false }>["reason"]>,
  string
> = {
  checkpoint_count: "checkpoint quota exceeded",
  snapshot_budget: "snapshot byte budget exceeded",
  tenant_storage: "tenant storage quota exceeded",
};

/** 快照信封的配额计量字节数(规范化 JSON 的 UTF-8 字节长度;确定性)。 */
export function envelopeByteLength(envelope: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(envelope), "utf8");
}

/**
 * 纯函数配额判定(顺序固定,先判粘性标记再判数量与字节;同一输入恒同一
 * 结论,I-4)。tenantStorageUsedBytes 为 null 表示计量源不可用(无任何已
 * 知会话行)——预执行面以"不低于已用量"的保守方向放行,实际超限由持久化
 * 边界复核兜住(粘性标记)。
 */
export function evaluateCheckpointQuota(input: {
  readonly checkpointCount: number;
  readonly latestEnvelopeByteLength: number | null;
  readonly snapshotOverBudget: boolean;
  readonly tenantStorageUsedBytes: number | null;
  readonly limits: CheckpointQuotaLimits;
}): CheckpointQuotaVerdict {
  if (input.snapshotOverBudget) {
    return {
      ok: false,
      reason: "snapshot_budget",
      detail: "session previously produced a snapshot beyond byte budget (sticky)",
    };
  }
  if (input.checkpointCount >= input.limits.maxCheckpointsPerSession) {
    return {
      ok: false,
      reason: "checkpoint_count",
      detail: `${input.checkpointCount} >= ${input.limits.maxCheckpointsPerSession}`,
    };
  }
  if (
    input.latestEnvelopeByteLength !== null &&
    input.latestEnvelopeByteLength > input.limits.snapshotByteBudget
  ) {
    return {
      ok: false,
      reason: "snapshot_budget",
      detail: `latest envelope ${input.latestEnvelopeByteLength} > budget ${input.limits.snapshotByteBudget}`,
    };
  }
  if (
    input.tenantStorageUsedBytes !== null &&
    input.tenantStorageUsedBytes >= input.limits.tenantStorageQuotaBytes
  ) {
    return {
      ok: false,
      reason: "tenant_storage",
      detail: `used ${input.tenantStorageUsedBytes} >= quota ${input.limits.tenantStorageQuotaBytes}`,
    };
  }
  return { ok: true };
}

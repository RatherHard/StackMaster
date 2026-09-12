/**
 * verifier 持久化端口(WP-61 / WP-62)。
 *
 * 信任域 4 的最小授权面:裁决域(verifier_runs 认领 / 推进、verdicts 幂等
 * 写入)+ submissions 只读(裁决引用取回)+ challenge_versions 只读(登记
 * 摘要比对)+ audit_log 追加(裁决域三值发射,D-API-90 / 95;仅 INSERT)+
 * 对象存储双桶只读(仅 GET:私有判题包 `private-bundles`、公开描述包
 * `public-descriptors`——001 迁移的对象名语义即双桶布局,公开描述包是玩家
 * 可达的公开产物,零秘密面)。一切按会话 / 题目定位的查询 WHERE 强制
 * tenant_id(查询层租户校验,D-API-20 延伸)。
 */

/** 已认领的裁决 run(SUBMIT 引用随行;SKIP LOCKED 单实例独占推进)。 */
export interface ClaimedRun {
  readonly runId: string;
  readonly tenantId: string;
  readonly submissionId: string;
  /** 提交会话锚(submissions.session_id;裁决域审计事件的关联位,D-API-95)。 */
  readonly sessionId: string;
  /** 提交时登记的规范化动作日志摘要(SHA-256 hex;取回复算比对锚,D-API-85)。 */
  readonly logDigest: string | null;
  /** 本次 submission 的 run 计数(含本行;重试上限判据)。 */
  readonly attemptCount: number;
  /** 内部裁决引用完整形态(stackmaster-session-submit/1 + replay 材料)。 */
  readonly reference: unknown;
}

/**
 * 裁决域审计事件(WP-62;D-API-90 三值,verifier 侧发射)。
 *
 * kind 记录的是安全事实而非 run 状态(D-API-90 行 3):`verdict_completed` =
 * 引擎合成裁决落库(detail 携 submissionId 与 11 值字面);`verdict_rejected` =
 * 拒裁方向(D-API-95 方向码封闭集);`verdict_replay_failed` = 执行面故障。
 * detail 仅非秘密标量(append-only 端口 detail 纪律同源,零凭证材料)。
 */
export interface VerdictAuditEvent {
  readonly kind: "verdict_completed" | "verdict_replay_failed" | "verdict_rejected";
  /** 事件时刻(Unix epoch 毫秒)。 */
  readonly at: number;
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

/** 认领结果(run 状态机推进 running;零认领 = 空数组)。 */
export interface VerdictQueue {
  claim(batchSize: number, maxAttempts: number): Promise<ClaimedRun[]>;
  /**
   * 裁决完成:run → completed,同事务幂等写 verdicts(`submission_id`
   * 唯一,ON CONFLICT DO NOTHING——同 submission 重复裁决确定性同判、
   * 不重复写入,D-API-85)并追加裁决域审计事件(审计与处置同事务:
   * append 失败即处置整体回滚,fail-closed,D-API-95)。
   */
  complete(input: {
    runId: string;
    submissionId: string;
    tenantId: string;
    sessionId: string;
    verdict: string;
    /** SERVER_ONLY 明细(重放逐项结论 / 隐藏测试汇总 / 失败原因标签;零浏览器可达面)。 */
    detail: unknown;
    /** 同事务追加的裁决域审计事件(verdict_completed / verdict_rejected)。 */
    audit: VerdictAuditEvent;
  }): Promise<void>;
  /**
   * run 失败(无法产生任何裁决的形态):run → failed;未达重试上限时
   * 以新 pending run 行承载重试(D-API-85;耗尽后查询面恒为 pending)。
   * 审计事件(verdict_rejected / verdict_replay_failed)与失败态同事务落库。
   */
  fail(input: {
    runId: string;
    tenantId: string;
    submissionId: string;
    sessionId: string;
    attemptCount: number;
    reason: string;
    maxAttempts: number;
    audit: VerdictAuditEvent;
  }): Promise<void>;
  /** 队列深度(pending 行数;/metrics 观察面)。 */
  pendingCount(): Promise<number>;
}

/** challenge_versions 登记行(双包摘要与对象名;只读)。 */
export interface ChallengeVersionRegistration {
  readonly privateBundleSha256: string;
  readonly publicDescriptorSha256: string;
  readonly privateBundleObject: string;
  readonly publicDescriptorObject: string;
}

export interface ChallengeSource {
  /** 按租户取登记行(查询层租户校验强制;未登记 = null)。 */
  findVersion(
    tenantId: string,
    challengeId: string,
    contentVersion: string,
  ): Promise<ChallengeVersionRegistration | null>;
}

/**
 * 登记双包只读源(对象名取自 challenge_versions 登记行,各归其桶):
 * `getPrivate` 读私有判题包桶,`getPublic` 读公开描述包桶(公开产物,零秘密)。
 */
export interface BundleSource {
  /** 私有判题包原始字节(仅 GET;对象名来自登记行,非派生)。 */
  getPrivate(objectName: string): Promise<Uint8Array | null>;
  /** 公开描述包原始字节(公开桶;同登记行 public_descriptor_object)。 */
  getPublic(objectName: string): Promise<Uint8Array | null>;
  /** readiness 探针(最小授权面:接受 NotFound/NoSuchKey = 权限可达)。 */
  probe(): Promise<void>;
}

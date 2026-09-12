/**
 * verifier 持久化端口(WP-61)。
 *
 * 信任域 4 的最小授权面:裁决域(verifier_runs 认领 / 推进、verdicts 幂等
 * 写入)+ submissions 只读(裁决引用取回)+ challenge_versions 只读(登记
 * 摘要比对)+ 对象存储双桶只读(仅 GET:私有判题包 `private-bundles`、公开
 * 描述包 `public-descriptors`——001 迁移的对象名语义即双桶布局,公开描述包
 * 是玩家可达的公开产物,零秘密面)。一切按会话 / 题目定位的查询 WHERE 强制
 * tenant_id(查询层租户校验,D-API-20 延伸)。
 */

/** 已认领的裁决 run(SUBMIT 引用随行;SKIP LOCKED 单实例独占推进)。 */
export interface ClaimedRun {
  readonly runId: string;
  readonly tenantId: string;
  readonly submissionId: string;
  /** 提交时登记的规范化动作日志摘要(SHA-256 hex;取回复算比对锚,D-API-85)。 */
  readonly logDigest: string | null;
  /** 本次 submission 的 run 计数(含本行;重试上限判据)。 */
  readonly attemptCount: number;
  /** 内部裁决引用完整形态(stackmaster-session-submit/1 + replay 材料)。 */
  readonly reference: unknown;
}

/** 认领结果(run 状态机推进 running;零认领 = 空数组)。 */
export interface VerdictQueue {
  claim(batchSize: number, maxAttempts: number): Promise<ClaimedRun[]>;
  /**
   * 裁决完成:run → completed,同事务幂等写 verdicts(`submission_id`
   * 唯一,ON CONFLICT DO NOTHING——同 submission 重复裁决确定性同判、
   * 不重复写入,D-API-85)。
   */
  complete(input: {
    runId: string;
    submissionId: string;
    tenantId: string;
    verdict: string;
    /** SERVER_ONLY 明细(重放逐项结论 / 失败原因标签;零浏览器可达面)。 */
    detail: unknown;
  }): Promise<void>;
  /**
   * run 失败(无法产生任何裁决的形态):run → failed;未达重试上限时
   * 以新 pending run 行承载重试(D-API-85;耗尽后查询面恒为 pending)。
   */
  fail(input: { runId: string; tenantId: string; submissionId: string; attemptCount: number; reason: string; maxAttempts: number }): Promise<void>;
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

/**
 * 持久化面端口契约(WP-3;权威 API 语义规约 D-API-20 ~ D-API-26)。
 *
 * 设计纪律:
 *  - 存储适配层接口化,测试可换内存实现(test/persistence/memory-stores 侧);
 *  - 快照适配器对快照载荷**只存取不解析**(D-W8-11):SnapshotStore 的进出
 *    都是密文字节,加密 / 解密由调用方经 SnapshotCipher 完成;
 *  - Redis 只存可重建、带 TTL 状态,不作权威(ADR-4):route / rate / idem
 *    / token 四键域全部带 TTL;
 *  - 查询层租户校验强制:一切按会话定位的查询都必须携带 tenantId 并在
 *    过滤条件中强制(行级策略归阶段六完善)。
 */

// ── Redis 键域原语 ────────────────────────────────────────────────────────

/**
 * 通用键值原语(Redis 键域的通用面;token:{jti} 键由 WP-2 端口消费)。
 * 全部操作要求显式 TTL(键域"全部带 TTL"纪律;ADR-4 可重建、不作权威)。
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /**
   * 原子删除:键存在并删除返回 true,不存在返回 false(Redis GETDEL 语义;
   * jti 单次消费的原子原语)。
   */
  deleteIfPresent(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/** 会话路由键(route:{sessionId}):编排器实例属主绑定,带 TTL。 */
export interface RouteStore {
  /** 绑定会话到属主(覆盖写;TTL 必须与会话保活节奏一致)。 */
  bind(sessionId: string, owner: string, ttlSeconds: number): Promise<void>;
  /** 解析当前属主;无绑定或已过期返回 null。 */
  resolve(sessionId: string): Promise<string | null>;
  release(sessionId: string): Promise<void>;
}

/** 固定窗口原子计数器(rate:{tenant}:{user} 键域;消费方 WP-6)。 */
export interface RateLimitCounter {
  /** 窗口内自增并返回当前计数;首增时以 windowSeconds 立窗口 TTL。 */
  increment(key: string, windowSeconds: number): Promise<number>;
}

// ── PostgreSQL 权威存储 ───────────────────────────────────────────────────

export type SessionPhaseRow = "active" | "crashed" | "closed";

/** sessions 行(快照锚 = 最近快照恢复点的外键)。 */
export interface SessionRow {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
  readonly phase: SessionPhaseRow;
  /** seed 策略元数据(不含 seed 值——seed 永不持久化,D-API-23)。 */
  readonly seedStrategy: string;
  readonly latestRevision: number;
  readonly latestSnapshotId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateSessionRowInput {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
  readonly seedStrategy: string;
}

/** 会话仓储:一切查询强制租户过滤(查询层租户校验;行级策略归阶段六)。 */
export interface SessionRepository {
  insertSession(input: CreateSessionRowInput): Promise<SessionRow>;
  /** 会话定位:sessionId × tenantId 双条件,租户不匹配 = 查不到(防枚举)。 */
  findSession(sessionId: string, tenantId: string): Promise<SessionRow | null>;
  listSessionsByTenant(tenantId: string): Promise<SessionRow[]>;
  /**
   * 重启恢复枚举(WP-7,D-API-63):`phase = 'active'` 的会话行,供编排器
   * 启动时的两步恢复路径消费。这是查询层租户过滤的唯一跨租户例外——
   * 服务进程生命周期操作(启动恢复)而非租户作用域数据访问,调用方仅限
   * 运行时装配(runtime)与测试;消费语义见 recoverActiveSessions。
   */
  listActiveSessions(): Promise<SessionRow[]>;
  updateSessionPhase(sessionId: string, tenantId: string, phase: SessionPhaseRow): Promise<void>;
  /**
   * 终态会话保留窗口清理(WP-6,D-API-55):删除进入终态(closed / crashed)
   * 且 updated_at ≤ cutoffIso 的会话行;返回清除行数。active 会话不受影响。
   * T0 无 cron,由 TerminalSessionCleaner 可调用入口驱动(运维定时调用,
   * 与快照 purgeExpired 同形态)。
   */
  purgeTerminalSessionsBefore(cutoffIso: string): Promise<number>;
  /** 快照锚推进(恢复点元数据;快照载荷本体在 checkpoints 表密文列)。 */
  updateSessionSnapshotAnchor(
    sessionId: string,
    tenantId: string,
    snapshotId: string,
    latestRevision: number,
  ): Promise<void>;
}

export type SnapshotOrigin = "explicit_checkpoint" | "auto_periodic" | "session_close";

/** 快照记录(checkpoints 行;ciphertext 为 AES-256-GCM 密文信封)。 */
export interface SnapshotRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly checkpointId: string | null;
  readonly origin: SnapshotOrigin;
  readonly revision: number;
  /** 密文字节(编排器只存取不解析;解密由调用方用密钥做)。 */
  readonly ciphertext: Uint8Array;
  readonly byteSize: number;
  readonly createdAt: string;
}

export interface SaveSnapshotInput {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly checkpointId?: string | null;
  readonly origin: SnapshotOrigin;
  readonly revision: number;
  readonly ciphertext: Uint8Array;
}

/**
 * 快照仓储(编排器对快照只存取不解析,D-W8-11;落库必须密文)。
 * 明文/密文的边界:本端口只接受与返回**密文**;加密与解密在 SnapshotCipher。
 */
export interface SnapshotStore {
  save(input: SaveSnapshotInput): Promise<SnapshotRecord>;
  /** 最近快照(恢复点);无快照返回 null。 */
  latest(sessionId: string, tenantId: string): Promise<SnapshotRecord | null>;
  listBySession(sessionId: string, tenantId: string): Promise<SnapshotRecord[]>;
  /** 保留期清理(SESSION_API_SNAPSHOT_RETENTION_DAYS;返回清除行数)。 */
  purgeExpired(retentionDays: number): Promise<number>;
}

/** 已接受动作的落库条目(拒绝不入账,D-W8-9 编排器账本同源)。 */
export interface ActionLogEntryInput {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly clientSeq: number;
  readonly revisionAfter: number;
  /** 规范化动作对象(玩家提交可见面;动作日志本身不加密但必须零秘密)。 */
  readonly action: unknown;
  /** submit 引用同锚(内部裁决引用标识;可空 = 尚未随 submit 锚定)。 */
  readonly submissionRef?: string | null;
}

/** 已落库的动作日志条目(租户在查询参数中,行内不重复返回)。 */
export type StoredActionLogEntry = Omit<ActionLogEntryInput, "tenantId"> & {
  readonly id: number;
  readonly createdAt: string;
};

/** 规范化动作日志(append-only;数据库层触发器强制,红灯反例见集成测试)。 */
export interface ActionLogStore {
  append(entries: readonly ActionLogEntryInput[]): Promise<void>;
  listBySession(sessionId: string, tenantId: string): Promise<StoredActionLogEntry[]>;
  countBySession(sessionId: string, tenantId: string): Promise<number>;
}

/**
 * submit 内部裁决引用落库(submissions 行;verdicts / verifier_runs 归阶段六)。
 */
export interface SubmissionRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly publicStatus: string;
  readonly reference: unknown;
  readonly createdAt: string;
}

export interface SubmissionStore {
  /**
   * 落库提交引用并同步入队裁决(WP-61,D-API-85):同一事务插入
   * `verifier_runs` pending 行(`logDigest` = 引用内规范化动作日志的
   * SHA-256 hex 绑定锚),pending 行即队列本体,零新增队列设施。
   */
  record(input: {
    tenantId: string;
    sessionId: string;
    revision: number;
    publicStatus: string;
    reference: unknown;
    /** 规范化动作日志 SHA-256 hex(verifier_runs.log_digest;取回复算比对)。 */
    logDigest: string;
  }): Promise<SubmissionRecord>;
  findBySession(sessionId: string, tenantId: string): Promise<SubmissionRecord[]>;
}

// ── 题目域:对象存储 + 注册表 ─────────────────────────────────────────────

/**
 * 题目双包对象存储(MinIO):私有判题包入 private-bundles 桶(服务端专用、
 * 静态加密、最小权限);公开描述包入 public-descriptors 桶(CDN 发布与签名
 * URL 归阶段五,本阶段仅对象存储落点)。
 */
export interface ChallengeBundleStore {
  putPrivate(challengeId: string, version: string, content: Uint8Array): Promise<string>;
  getPrivate(challengeId: string, version: string): Promise<Uint8Array | null>;
  putPublic(challengeId: string, version: string, content: Uint8Array): Promise<string>;
  getPublic(challengeId: string, version: string): Promise<Uint8Array | null>;
}

/** challenge_versions 行(版本链、双包哈希与签名)。 */
export interface ChallengeVersionRow {
  readonly challengeId: string;
  readonly contentVersion: string;
  readonly tenantId: string;
  readonly vmProfileVersion: string;
  readonly privateBundleSha256: string;
  readonly publicDescriptorSha256: string;
  readonly privateBundleObject: string;
  readonly publicDescriptorObject: string;
  readonly signature: string;
  readonly signerKeyId: string;
  readonly registeredAt: string;
}

export interface ChallengeVersionInput {
  readonly challengeId: string;
  readonly contentVersion: string;
  readonly tenantId: string;
  readonly vmProfileVersion: string;
  readonly privateBundleSha256: string;
  readonly publicDescriptorSha256: string;
  readonly privateBundleObject: string;
  readonly publicDescriptorObject: string;
  readonly signature: string;
  readonly signerKeyId: string;
}

/** 题目注册表(challenges / challenge_versions;版本不可变)。 */
export interface ChallengeRegistry {
  upsertChallenge(input: { challengeId: string; tenantId: string; title?: string }): Promise<void>;
  insertChallengeVersion(input: ChallengeVersionInput): Promise<void>;
  findChallengeVersion(challengeId: string, version: string, tenantId: string): Promise<ChallengeVersionRow | null>;
  listChallengeVersions(challengeId: string, tenantId: string): Promise<ChallengeVersionRow[]>;
  /**
   * 公开描述包下发路径的版本行读取(阶段五 WP-50,D-API-76):按
   * (challengeId, contentVersion) 查登记行,不带租户过滤。
   *
   * 这是查询层租户过滤的第二处跨租户例外(先例:D-API-63
   * listActiveSessions),理由:公开描述包是**公开内容**(设计上可 CDN
   * 分发,8.3),其下发端点无凭证、无租户上下文;行内 (challenge_id,
   * content_version) 为全局唯一主键(migrations/001),跨租户查询结果
   * 唯一且行内容(双包摘要、对象名、登记签名)本身即公开元数据。私有面
   * (租户作用域题目访问)仍走 findChallengeVersion 的租户强制过滤,本
   * 方法不得用于私有判题包路径。调用方仅限公开描述包下发路由与测试。
   */
  findPublishedChallengeVersion(challengeId: string, version: string): Promise<ChallengeVersionRow | null>;
}

// ── 幂等窗口(D-W8-9;Redis 后端 + 进程内降级,同接口)───────────────────

/** 幂等窗口裁决(D-W8-9 字节比较语义)。 */
export type IdempotencyVerdict = "fresh" | "replay-identical" | "conflict";

/**
 * 幂等窗口:`(sessionId, key)` × 规范化请求字节的原子检查并登记。
 *  - "fresh":窗口内首次出现,已登记(调用方执行动作并缓存响应);
 *  - "replay-identical":同键同规范化负载(字节相同重放);
 *  - "conflict":同键异负载(确定性拒绝)。
 * 窗口是效率设施,正确性由 baseRevision 与单会话串行保证(协议 §4.3)——
 * 这是幂等窗口唯一允许降级进程内的原因(D-API-24)。
 */
export interface IdempotencyWindow {
  checkAndRecord(sessionId: string, key: string, canonicalRequest: string): Promise<IdempotencyVerdict>;
}

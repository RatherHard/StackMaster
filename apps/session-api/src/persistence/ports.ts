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

// ── 启动票据键域(launch:{jti};WP-91,D-LT-2)────────────────────────────

/**
 * 启动票据的**服务端绑定记录**(D-LT-2「绑定」行)。
 *
 * 这是票据的**全部语义所在**:令牌本身是不透明持有证明(不签名、不解析
 * claims,D-LT-1)⇒ 「这张票能开哪一题、属于哪个租户、何时作废」**只**存在于
 * 本记录里。记录随消费(TTL)消失,票据随即失去意义。
 *
 * 字段口径:
 *  - `tenantId`:**不在 URL / 不在响应体**(D-LT-2「绑定」行末)。它由签发时的
 *    「宿主凭证 × `SESSION_API_HOST_TENANTS` 白名单」派生并**封存在票据内**,
 *    换票时从本记录取回 —— 这条路径是「URL / body 参数永不进入租户派生路径」
 *    (安全红线 6.2)在票据面上的结构性兑现:URL 里根本**没有**租户可自报。
 *  - `challengeId` / `version`:公开导航信息(一题一址),换票时与路径逐字比对。
 *  - `expiresAt`:Unix epoch 秒;与 Redis TTL、签发响应回显值**同值**
 *    (D-LT-2「有效期」行:Redis TTL 与响应回显值同值)。
 */
export interface LaunchTicketBinding {
  readonly tenantId: string;
  readonly challengeId: string;
  /** 题目内容版本(X.Y.Z 语义化版本字面)。 */
  readonly version: string;
  /** 过期时刻(Unix epoch 秒,UTC)。 */
  readonly expiresAt: number;
}

/**
 * 换票时**由路径派生**的比对字段(换票路由的三、四步输入)。
 *
 * 只有这两个字段来自请求:它们是公开导航信息,且**只能用于「与记录比对」**,
 * 永远不参与身份 / 租户派生。`tenantId` **刻意不在此接口** —— 它由记录携带,
 * 不在 URL 上(D-LT-2),故调用方连"从请求取租户"这个动作都**无法表达**。
 */
export interface LaunchTicketRedemptionKey {
  readonly challengeId: string;
  readonly version: string;
}

/**
 * 启动票据存储端口(`launch:{jti}` 键域)。
 *
 * **分级 = fail-closed**(D-LT-2「单次消费」行:Redis 不可用 ⇒ 503
 * `store_unavailable`,不降级、不静默放行),登记在
 * `idempotency-window.ts` 的 `REDIS_DEGRADE_POLICY`。
 *
 * 与 `TokenIssuanceStore`(WP-2,`token:{jti}`)的**关键差异**:后者的消费
 * 语义是「存在即删」(GETDEL),而票据的消费语义是**比较并交换(CAS)** ——
 * 只有绑定字段与请求逐字一致才删除(见 `consume`)。
 */
export interface LaunchTicketStore {
  /**
   * 登记票据(TTL = 票据 TTL 秒数;值 = 绑定记录的规范化 JSON)。
   *
   * TTL 与 `binding.expiresAt` **同源同值**(调用方用同一个 TTL 常量算
   * `expiresAt` 并传此处,D-LT-2「有效期」行)。
   */
  put(token: string, binding: LaunchTicketBinding, ttlSeconds: number): Promise<void>;

  /**
   * **原子**比较并消费(D-LT-2「单次消费」行的落地原语)。
   *
   * 语义:绑定记录存在、未过期、且 `challengeId` / `version` 与 `expected`
   * **逐字一致** ⇒ **删除并返回该记录**;任一不满足 ⇒ **返回 null 且不删除**。
   *
   * **两处语义选择及其理由**:
   *
   *  1. **不一致时不消费**(不是"先删再验")。若不一致也删除,那么任何人只要
   *     拿到票据并故意用错 URL 打开一次,就能把合法持有者的票据烧掉 ——
   *     一枚公开地址被"路过"一次即失效,这是可用性攻击面。比较失败必须
   *     **无副作用**。并发下"至多一方拿到记录"仍由删除的原子性保证。
   *  2. **四种"无有效记录"形态同形返回 null**:未签发 / 已消费 / 已过期
   *     (TTL 自然失效)/ 绑定不符。端口面**不区分**它们 —— 区分即给攻击者
   *     一个枚举信号(安全红线 9.2 侧信道约束),而响应面要求三态**逐字节
   *     一致**(D-LT-2「换票路由」行)。具体原因是**受控日志**面的事,不是
   *     端口返回值面的事。
   *
   * 存储不可用 ⇒ 抛 `PersistenceError("store_unavailable")`(适配器负责
   * 翻译),由既有 `error-mapping` 矩阵天然映射为 503 `storage unavailable`
   * —— **不在这里吞掉、不降级、不静默放行**。
   */
  consume(
    token: string,
    expected: LaunchTicketRedemptionKey,
  ): Promise<LaunchTicketBinding | null>;
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

// ── 裁决域读取(阶段六 WP-63,D-API-83 / D-API-96)────────────────────────

/**
 * 裁决呈现面行(公开上限面;D-API-96 纪律的结构化落实):本端口**不暴露**
 * `verdicts.detail` 明细列——呈现链路只取 11 值 verdict 与裁决落库时刻,
 * detail 整体 SERVER_ONLY,零浏览器可达面(结构性无表达位)。
 */
export interface VerdictRecordPublic {
  /** 11 值结果类型字面(verifier 落库面;字面合法性由响应面自检兜底)。 */
  readonly verdict: string;
  /** 裁决落库时刻(Unix epoch 秒;verdicts.created_at 的秒级投影)。 */
  readonly decidedAtEpochSeconds: number;
}

/**
 * 裁决呈现面读取端口(阶段六 WP-63,D-API-83:呈现链路 = session-api 读
 * 裁决域,verifier 零查询面):只读,零写入面(裁决唯一出处 = 信任域 4
 * verifier,硬门槛——本端口不存在任何使 session-api 产生 / 改写裁决的方法)。
 */
export interface VerdictQueryStore {
  /**
   * 定位链第一环:`submissions` 行按 (submissionId, tenantId, sessionId)
   * 三条件定位——租户与凭证据点(sessionId)双强制(查询层租户校验,
   * D-API-20),任一环不符 = null(与不存在同形,防枚举)。
   */
  findSubmissionForVerdict(
    submissionId: string,
    tenantId: string,
    sessionId: string,
  ): Promise<SubmissionRecord | null>;
  /**
   * 定位链第二环:`verdicts` 行按 (submissionId, tenantId) 双条件读取
   * (租户绑定 = 查询层第二环 + 行级政策双层同形,WP-65 微扩 D-API-101);
   * 任一环不符 / 未落库返回 null(查询面恒 pending,D-API-84 fail-closed
   * 方向——run failed / 队列积压均呈现 pending,绝不以判负兜底)。
   */
  findVerdictBySubmissionId(
    submissionId: string,
    tenantId: string,
  ): Promise<VerdictRecordPublic | null>;
}

// ── 宿主成绩同步读取(中期 M3 WP-78;D-API-122 ~ D-API-126)───────────────

/**
 * 宿主成绩记录行(公开上限面七字段;D-API-123 纪律的结构化落实):
 *
 *  - 本端口**不暴露** `verdicts.detail`(判题明细 / 谓词 / 隐藏测试命中)、
 *    `submissions.reference`(完整 IR / 原始快照 / 完整事件日志)、
 *    `verifier_runs` 任何列——三者整体 SERVER_ONLY,结构性无表达位;
 *  - 本端口**不暴露** `tenantId`:租户是查询入参(认证上下文派生),不是
 *    载荷字段(回显即扩大探测面且无用途,O-MP-6 / 6.2)。
 */
export interface HostScoreRecordRow {
  /** 本行游标值(`verdicts.id` 的公开投影;keyset 唯一排序键)。 */
  readonly id: string;
  readonly submissionId: string;
  readonly sessionId: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
  /** 11 值结果类型字面(字面合法性由响应面冻结契约自检兜底)。 */
  readonly verdict: string;
  /** 裁决落库时刻(Unix epoch 秒;`verdicts.created_at` 的秒级投影)。 */
  readonly decidedAtEpochSeconds: number;
}

/** 宿主成绩分页查询(租户集合显式入参;零请求体身份,零查询参数决定租户)。 */
export interface HostScorePageQuery {
  /**
   * 凭证绑定的租户集合(**唯一**租户来源;认证上下文派生 —— 服务端从
   * 认证上下文派生租户,不接受请求体 / 查询参数自报身份,6.2)。
   * 实现必须对集合内**每个**租户做租户作用域查询(行级政策 + 查询层 WHERE
   * 双层强制),集合外租户结构性不可达。
   */
  readonly tenantIds: readonly string[];
  /**
   * keyset 游标 = 上一页末行 `id`;null = 首页。
   * **禁止以时刻为游标**(D-API-92 教训:库内微秒时刻经 JS Date 截断会回退,
   * 末行被重复选中)——本字段类型是标识符字符串而非时间戳,结构上排除了
   * 时刻游标形态。
   */
  readonly afterId: string | null;
  /** 单批行数上限(正整数,由路由按 config.hostScoresBatch 钳定)。 */
  readonly limit: number;
}

/**
 * 宿主成绩同步读取端口(中期 M3 WP-78,D-API-126):只读,零写入面
 * ——本端口不存在任何使 session-api 产生 / 改写裁决或提交的方法(裁决唯一
 * 出处 = 信任域 4 verifier,硬门槛);零 DDL、零新角色(复用 session_app
 * 角色与既有 RLS 政策)。
 */
export interface HostScoresQueryStore {
  /**
   * 按 `id` 升序取一页成绩(keyset 分页)。
   *
   * 返回**至多 `limit + 1` 行**:多取一行是"是否还有下一页"的探测法——
   * 零额外 COUNT 往返,且与 keyset 语义一致(有第 limit+1 行 ⇒ 本页末行的
   * id 即可作为 `nextCursor`)。调用方负责裁掉探测行并据此决定 `nextCursor`。
   */
  listScores(query: HostScorePageQuery): Promise<readonly HostScoreRecordRow[]>;
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

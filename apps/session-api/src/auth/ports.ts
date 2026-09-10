/**
 * 认证域端口(WP-2 交付面;权威 API 语义规约 D-API-18)。
 *
 * 三个端口的 PostgreSQL / Redis 适配器归 WP-4(以 WP-3 的 KeyValueStore /
 * PG 存储接入),本文件只冻结端口形状与语义:
 *  - TokenIssuanceStore.consume 是**原子单次消费**:记录存在则删除并返回,
 *    否则返回 null——并发调用方至多一方拿到记录;Redis 适配器须以 GETDEL
 *    或 Lua 等价语义实现,不得退化成"读后删"两步;
 *  - CredentialRevocationStore 是会话凭证 jti 的吊销键域(存在即拒绝),
 *    键 TTL 不得小于凭证剩余有效期;
 *  - AuditSink 是 **append-only 端口语义**:只有 append,没有更新 / 删除;
 *    PG 落库实现(WP-3 / WP-4)须以数据库层强制追加性(任务分解 WP-3
 *    `action_log` 同一纪律),内存实现(本包)以深冻结对象表达同一语义。
 *
 * 端口方法全部异步:内存实现即时返回,Redis / PG 适配器不因签名形状受限。
 */

/** embed token 签发记录(token:{jti} 键域的载荷;嵌入协议 §六)。 */
export interface IssuedEmbedTokenRecord {
  readonly jti: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
  readonly embedSessionId: string;
  /** 签发时刻(Unix epoch 毫秒)。 */
  readonly issuedAt: number;
  /** 过期时刻(Unix epoch 毫秒;与签名 claims 的秒值 expiresAt × 1000 一致)。 */
  readonly expiresAt: number;
}

/** embed token 签发记录存储(键域 token:{jti};删除即吊销)。 */
export interface TokenIssuanceStore {
  /** 写入签发记录,ttlSeconds 内可消费(超时由 TTL 自然失效)。 */
  put(record: IssuedEmbedTokenRecord, ttlSeconds: number): Promise<void>;
  /**
   * 原子单次消费:记录存在(且未过 TTL)则删除并返回该记录;否则返回 null。
   * 返回 null 的语义:未签发 / 已消费 / 已吊销 / 已过期——调用方不再区分
   * (失败响应面统一,D-API-14),细节判断只允许依赖消费前后的受控日志。
   */
  consume(jti: string): Promise<IssuedEmbedTokenRecord | null>;
  /** 删除即吊销;返回是否确有记录被删除(幂等)。 */
  revoke(jti: string): Promise<boolean>;
}

/** 会话凭证 jti 吊销键域(存在即拒绝;TTL ≥ 凭证剩余有效期)。 */
export interface CredentialRevocationStore {
  revoke(jti: string, ttlSeconds: number): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
}

/**
 * 审计事件种类(枚举冻结;WP-2 审计最小写入面)。
 * 会话凭证的吊销不设独立种类:运行期吊销由强制终止流程触发(以
 * `session_force_closed` 承载),embed token 的吊销以 `embed_token_revoked`
 * 承载。
 */
export const AUDIT_EVENT_KINDS = [
  "embed_token_issued",
  "embed_token_consumed",
  "embed_token_revoked",
  "session_credential_issued",
  "create_session",
  "submit",
  "session_force_closed",
] as const;

export type AuditEventKind = (typeof AUDIT_EVENT_KINDS)[number];

/** 审计主体(派生自认证上下文;拒绝事件在身份可得前以 "unknown" 占位)。 */
export interface AuditActor {
  readonly tenantId: string;
  readonly userId: string;
}

/** 审计 detail 取值域:仅非秘密标量(jti、challengeId、reason 码等;零凭证材料)。 */
export type AuditDetailValue = string | number | boolean;

/** 审计事件(append-only;at 为 Unix epoch 毫秒)。 */
export interface AuditEvent {
  readonly kind: AuditEventKind;
  readonly at: number;
  readonly actor: AuditActor;
  readonly sessionId?: string;
  readonly detail?: Readonly<Record<string, AuditDetailValue>>;
}

/** 审计追加端口:只有 append——更新与删除不在端口面上(append-only 端口语义)。 */
export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
}

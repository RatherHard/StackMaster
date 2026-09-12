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
 *    PG 落库实现(阶段六 WP-64 收口,D-API-91)以数据库层强制追加性
 *    (任务分解 WP-3 `action_log` 同一纪律;`audit_log` 触发器 + REVOKE
 *    双层,migrations/006),内存实现(本包)以深冻结对象表达同一语义。
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
 * 审计事件种类(枚举冻结;阶段三 WP-2 七值 + 阶段六 WP-64 Q5 定案裁决域
 * 三值 = **十值封闭集合**,D-API-90 一次性定案后冻结,不逐次漂移——
 * D-API-59 的阶段六开口由此收口;库层 CHECK 约束同锚,migrations/006)。
 *
 * 会话凭证的吊销不设独立种类:运行期吊销由强制终止流程触发(以
 * `session_force_closed` 承载),embed token 的吊销以 `embed_token_revoked`
 * 承载。
 *
 * 裁决域三值(发射面归属:verifier 侧,信任域 4,WP-62 接线;本包只定案
 * 集合并预留库层,verifier 角色对 audit_log 仅有 INSERT,D-API-93):
 *  - `verdict_completed`:裁决完成(run completed,verdicts 行落库,detail
 *    携带 submissionId 与 11 值 verdict 字面;成绩终态是审计重放与争议复核
 *    的必要要素)——含 challenge_invalid / replay_mismatch 等非成绩方向
 *    (它们是有效裁决,D-API-85/87);
 *  - `verdict_replay_failed`:重放失败(run failed:重放执行面故障 / 重试
 *    耗尽,run 未产生任何裁决,D-API-85 failed 语义;裁决链路安全状态);
 *  - `verdict_rejected`:拒裁(输入完整性 / 授权完整性 / 形态完备性事实
 *    导致裁决请求被拒:log_digest 复算不符、双包哈希与登记不符、对象取回
 *    越权、bundle lock 不一致、六记录项缺项等拒裁方向;run 状态机映射沿
 *    D-API-87 主从关系,审计 kind 记录的是拒裁安全事实)。
 *
 * 归档动作(archive 批完成)**不在集合内**:运维事件账不上审计
 * (D-API-59 原裁决),走受控日志 + `/metrics` 计数器(D-API-92)。
 */
export const AUDIT_EVENT_KINDS = [
  // ── 阶段三 WP-2 七值(D-API-18,原样零改动)──
  "embed_token_issued",
  "embed_token_consumed",
  "embed_token_revoked",
  "session_credential_issued",
  "create_session",
  "submit",
  "session_force_closed",
  // ── 阶段六 WP-64 Q5 定案:裁决域三值(D-API-90;发射面 = WP-62 / verifier)──
  "verdict_completed",
  "verdict_replay_failed",
  "verdict_rejected",
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

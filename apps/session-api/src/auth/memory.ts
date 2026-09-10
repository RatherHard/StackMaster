/**
 * 端口的进程内内存实现(WP-2;测试与未接线期的默认装配)。
 *
 * 边界声明:内存实现**不是生产持久化面**——TokenIssuanceStore /
 * CredentialRevocationStore 的 Redis 适配器与 AuditSink 的 PostgreSQL 落库
 * 归 WP-3 / WP-4(D-API-18)。进程内单线程 + Map 的同步"取删一体"天然
 * 提供原子单次消费;跨进程语义由 Redis 适配器以 GETDEL / Lua 承接。
 * InMemoryAuditSink 无容量上限,仅供测试与未接线期,不得用于生产常驻。
 */

import type {
  AuditEvent,
  AuditSink,
  CredentialRevocationStore,
  IssuedEmbedTokenRecord,
  TokenIssuanceStore,
} from "./ports.js";

/** 内存实现的时钟注入点(默认 Date.now;测试注入以覆盖 TTL 过期路径)。 */
export interface InMemoryStoreOptions {
  readonly now?: () => number;
}

/** embed token 签发记录的内存实现(put / 原子单次 consume / revoke)。 */
export class InMemoryTokenIssuanceStore implements TokenIssuanceStore {
  readonly #records = new Map<string, { record: IssuedEmbedTokenRecord; expiresAtMs: number }>();
  readonly #now: () => number;

  constructor(options: InMemoryStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  async put(record: IssuedEmbedTokenRecord, ttlSeconds: number): Promise<void> {
    // 存储副本:调用方持有的引用后续变更不得影响签发记录(存储是权威锚)。
    this.#records.set(record.jti, {
      record: { ...record },
      expiresAtMs: this.#now() + ttlSeconds * 1000,
    });
  }

  async consume(jti: string): Promise<IssuedEmbedTokenRecord | null> {
    const entry = this.#records.get(jti);
    if (entry === undefined) {
      return null;
    }
    // 原子单次消费:存在则删除并返回(取删一体,无窗口)。
    this.#records.delete(jti);
    if (this.#now() >= entry.expiresAtMs) {
      return null;
    }
    return entry.record;
  }

  async revoke(jti: string): Promise<boolean> {
    return this.#records.delete(jti);
  }
}

/** 会话凭证吊销键域的内存实现(存在即拒绝;TTL 到期自然出键)。 */
export class InMemoryCredentialRevocationStore implements CredentialRevocationStore {
  readonly #revoked = new Map<string, number>();
  readonly #now: () => number;

  constructor(options: InMemoryStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  async revoke(jti: string, ttlSeconds: number): Promise<void> {
    this.#revoked.set(jti, this.#now() + ttlSeconds * 1000);
  }

  async isRevoked(jti: string): Promise<boolean> {
    const expiresAtMs = this.#revoked.get(jti);
    if (expiresAtMs === undefined) {
      return false;
    }
    if (this.#now() >= expiresAtMs) {
      this.#revoked.delete(jti);
      return false;
    }
    return true;
  }
}

/** 深冻结审计事件副本:append-only 在内存实现的可观察面上以不可变性表达。 */
function freezeAuditEvent(event: AuditEvent): AuditEvent {
  const copy: {
    kind: AuditEvent["kind"];
    at: number;
    actor: AuditEvent["actor"];
    sessionId?: string;
    detail?: AuditEvent["detail"];
  } = {
    kind: event.kind,
    at: event.at,
    actor: Object.freeze({ ...event.actor }),
  };
  if (event.sessionId !== undefined) {
    copy.sessionId = event.sessionId;
  }
  if (event.detail !== undefined) {
    copy.detail = Object.freeze({ ...event.detail });
  }
  return Object.freeze(copy);
}

/** 审计内存实现:append-only(无更新 / 删除面),snapshot 返回冻结只读视图。 */
export class InMemoryAuditSink implements AuditSink {
  readonly #events: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    this.#events.push(freezeAuditEvent(event));
  }

  /** 只读快照:数组与事件对象均深冻结;变更尝试在严格模式下抛 TypeError。 */
  snapshot(): readonly AuditEvent[] {
    return Object.freeze([...this.#events].map((event) => freezeAuditEvent(event)));
  }

  /** 已追加事件数(测试断言用)。 */
  get size(): number {
    return this.#events.length;
  }
}

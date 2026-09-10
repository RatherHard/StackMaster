/**
 * 持久化端口的内存实现(WP-3;供单元测试与未接线期使用)。
 *
 * 语义与生产适配器逐一同构(TTL、原子消费、租户过滤、append-only 的
 * "无变更接口"形态),差异只在载体:内存实现的租户过滤是**查询层强制**的
 * 参考实现,PostgreSQL 实现以同形 SQL 表达,集成测试以数据库红灯反例
 * (UPDATE / DELETE 被拒、跨租户空集)证明其强制层。
 */

import { PersistenceError } from "./errors.js";
import type {
  ActionLogEntryInput,
  ActionLogStore,
  ChallengeBundleStore,
  ChallengeRegistry,
  ChallengeVersionInput,
  ChallengeVersionRow,
  CreateSessionRowInput,
  IdempotencyVerdict,
  IdempotencyWindow,
  KeyValueStore,
  RateLimitCounter,
  RouteStore,
  SaveSnapshotInput,
  SessionPhaseRow,
  SessionRepository,
  SessionRow,
  SnapshotOrigin,
  SnapshotRecord,
  SnapshotStore,
  StoredActionLogEntry,
  SubmissionRecord,
  SubmissionStore,
} from "./ports.js";

/** 时钟注入(毫秒纪元;TTL 语义测试用假时钟驱动)。 */
export type Clock = () => number;

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence.toString(36).padStart(8, "0")}`;
}

// ── Redis 键域原语(内存形态)────────────────────────────────────────────

interface MemoryEntry {
  readonly value: string;
  readonly expiresAt: number;
}

/** 通用键值原语:带 TTL、GETDEL 语义的原子 deleteIfPresent。 */
export class MemoryKeyValueStore implements KeyValueStore {
  private readonly entries = new Map<string, MemoryEntry>();

  constructor(private readonly now: Clock = Date.now) {}

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new PersistenceError("invalid_identifier", "TTL 必须为正(键域全部带 TTL 纪律)");
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async deleteIfPresent(key: string): Promise<boolean> {
    const existed = await this.get(key);
    if (existed === null) {
      return false;
    }
    this.entries.delete(key);
    return true;
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

/** 会话路由键(route:{sessionId}):带 TTL,绑定即覆盖。 */
export class MemoryRouteStore implements RouteStore {
  private readonly routes = new Map<string, MemoryEntry>();

  constructor(private readonly now: Clock = Date.now) {}

  async bind(sessionId: string, owner: string, ttlSeconds: number): Promise<void> {
    this.routes.set(sessionId, { value: owner, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async resolve(sessionId: string): Promise<string | null> {
    const entry = this.routes.get(sessionId);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.routes.delete(sessionId);
      return null;
    }
    return entry.value;
  }

  async release(sessionId: string): Promise<void> {
    this.routes.delete(sessionId);
  }
}

/** 固定窗口原子计数器(窗口锚定于首增;单进程内原子 = JS 事件循环串行)。 */
export class MemoryRateLimitCounter implements RateLimitCounter {
  private readonly counters = new Map<string, { count: number; expiresAt: number }>();

  constructor(private readonly now: Clock = Date.now) {}

  async increment(key: string, windowSeconds: number): Promise<number> {
    const current = this.counters.get(key);
    const nowMs = this.now();
    if (current === undefined || current.expiresAt <= nowMs) {
      this.counters.set(key, { count: 1, expiresAt: nowMs + windowSeconds * 1000 });
      return 1;
    }
    current.count += 1;
    return current.count;
  }
}

// ── 会话域 ────────────────────────────────────────────────────────────────

/** 会话仓储:findSession 强制 (sessionId, tenantId) 双条件——跨租户即空集。 */
export class MemorySessionRepository implements SessionRepository {
  private readonly rows = new Map<string, SessionRow>();

  constructor(private readonly now: Clock = Date.now) {}

  async insertSession(input: CreateSessionRowInput): Promise<SessionRow> {
    if (this.rows.has(input.sessionId)) {
      throw new PersistenceError("challenge_version_conflict", "会话标识已存在(服务端签发必须全局唯一)");
    }
    const nowIso = new Date(this.now()).toISOString();
    const row: SessionRow = {
      ...input,
      phase: "active",
      latestRevision: 0,
      latestSnapshotId: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.rows.set(row.sessionId, row);
    return row;
  }

  async findSession(sessionId: string, tenantId: string): Promise<SessionRow | null> {
    const row = this.rows.get(sessionId);
    if (row === undefined || row.tenantId !== tenantId) {
      return null; // 租户不匹配与不存在同形态返回(防枚举)
    }
    return row;
  }

  async listSessionsByTenant(tenantId: string): Promise<SessionRow[]> {
    return [...this.rows.values()].filter((row) => row.tenantId === tenantId);
  }

  /** 重启恢复枚举(D-API-63):active 行(跨租户;仅供启动恢复路径消费)。 */
  async listActiveSessions(): Promise<SessionRow[]> {
    return [...this.rows.values()].filter((row) => row.phase === "active");
  }

  async updateSessionPhase(sessionId: string, tenantId: string, phase: SessionPhaseRow): Promise<void> {
    const row = await this.findSession(sessionId, tenantId);
    if (row === null) {
      throw new PersistenceError("session_not_found", "会话不存在或租户不匹配");
    }
    this.rows.set(sessionId, { ...row, phase, updatedAt: new Date(this.now()).toISOString() });
  }

  /** 终态会话保留窗口清理(D-API-55):只清除 closed / crashed 且过期的行。 */
  async purgeTerminalSessionsBefore(cutoffIso: string): Promise<number> {
    const cutoffMs = Date.parse(cutoffIso);
    let purged = 0;
    for (const [sessionId, row] of this.rows) {
      if (row.phase !== "active" && Date.parse(row.updatedAt) <= cutoffMs) {
        this.rows.delete(sessionId);
        purged += 1;
      }
    }
    return purged;
  }

  async updateSessionSnapshotAnchor(
    sessionId: string,
    tenantId: string,
    snapshotId: string,
    latestRevision: number,
  ): Promise<void> {
    const row = await this.findSession(sessionId, tenantId);
    if (row === null) {
      throw new PersistenceError("session_not_found", "会话不存在或租户不匹配");
    }
    this.rows.set(sessionId, {
      ...row,
      latestSnapshotId: snapshotId,
      latestRevision,
      updatedAt: new Date(this.now()).toISOString(),
    });
  }
}

// ── 快照域(只存取不解析;内存实现同样只见密文)─────────────────────────

export class MemorySnapshotStore implements SnapshotStore {
  private readonly rows = new Map<string, SnapshotRecord>();

  constructor(private readonly now: Clock = Date.now) {}

  async save(input: SaveSnapshotInput): Promise<SnapshotRecord> {
    const record: SnapshotRecord = {
      id: nextId("snap"),
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      checkpointId: input.checkpointId ?? null,
      origin: input.origin,
      revision: input.revision,
      ciphertext: Uint8Array.from(input.ciphertext),
      byteSize: input.ciphertext.byteLength,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.rows.set(record.id, record);
    return record;
  }

  async latest(sessionId: string, tenantId: string): Promise<SnapshotRecord | null> {
    const rows = await this.listBySession(sessionId, tenantId);
    return rows[rows.length - 1] ?? null;
  }

  async listBySession(sessionId: string, tenantId: string): Promise<SnapshotRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.sessionId === sessionId && row.tenantId === tenantId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  }

  async purgeExpired(retentionDays: number): Promise<number> {
    const cutoff = this.now() - retentionDays * 86_400_000;
    let purged = 0;
    for (const [id, row] of this.rows) {
      if (Date.parse(row.createdAt) < cutoff) {
        this.rows.delete(id);
        purged += 1;
      }
    }
    return purged;
  }
}

// ── 动作日志 / 提交引用(append-only:只有 append 与查询,无变更接口)────

export class MemoryActionLogStore implements ActionLogStore {
  private readonly entries: (StoredActionLogEntry & { tenantId: string })[] = [];

  constructor(private readonly now: Clock = Date.now) {}

  async append(inputs: readonly ActionLogEntryInput[]): Promise<void> {
    for (const input of inputs) {
      this.entries.push({
        sessionId: input.sessionId,
        tenantId: input.tenantId,
        clientSeq: input.clientSeq,
        revisionAfter: input.revisionAfter,
        action: input.action,
        submissionRef: input.submissionRef ?? null,
        id: this.entries.length + 1,
        createdAt: new Date(this.now()).toISOString(),
      });
    }
  }

  async listBySession(sessionId: string, tenantId: string): Promise<StoredActionLogEntry[]> {
    return this.entries
      .filter((entry) => entry.sessionId === sessionId && entry.tenantId === tenantId)
      .map((entry) => ({
        id: entry.id,
        sessionId: entry.sessionId,
        clientSeq: entry.clientSeq,
        revisionAfter: entry.revisionAfter,
        action: entry.action,
        submissionRef: entry.submissionRef,
        createdAt: entry.createdAt,
      }));
  }

  async countBySession(sessionId: string, tenantId: string): Promise<number> {
    const rows = await this.listBySession(sessionId, tenantId);
    return rows.length;
  }
}

export class MemorySubmissionStore implements SubmissionStore {
  private readonly rows: (SubmissionRecord & { tenantId: string })[] = [];

  constructor(private readonly now: Clock = Date.now) {}

  async record(input: {
    tenantId: string;
    sessionId: string;
    revision: number;
    publicStatus: string;
    reference: unknown;
  }): Promise<SubmissionRecord> {
    const row: SubmissionRecord & { tenantId: string } = {
      id: nextId("sub"),
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      revision: input.revision,
      publicStatus: input.publicStatus,
      reference: input.reference,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.rows.push(row);
    return row;
  }

  async findBySession(sessionId: string, tenantId: string): Promise<SubmissionRecord[]> {
    return this.rows
      .filter((row) => row.sessionId === sessionId && row.tenantId === tenantId)
      .map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        revision: row.revision,
        publicStatus: row.publicStatus,
        reference: row.reference,
        createdAt: row.createdAt,
      }));
  }
}

// ── 题目域(对象存储 + 注册表,内存形态)────────────────────────────────

export interface ChallengeObjectKey {
  readonly bucket: "private" | "public";
  readonly challengeId: string;
  readonly version: string;
}

export class MemoryChallengeBundleStore implements ChallengeBundleStore {
  private readonly objects = new Map<string, Uint8Array>();

  constructor(
    private readonly objectName: (key: ChallengeObjectKey) => string = (key) =>
      `${key.challengeId}/${key.version}/${key.bucket === "private" ? "bundle" : "descriptor"}.json`,
  ) {}

  private nameOf(challengeId: string, version: string, bucket: "private" | "public"): string {
    return this.objectName({ bucket, challengeId, version });
  }

  async putPrivate(challengeId: string, version: string, content: Uint8Array): Promise<string> {
    const name = this.nameOf(challengeId, version, "private");
    this.objects.set(name, Uint8Array.from(content));
    return name;
  }

  async getPrivate(challengeId: string, version: string): Promise<Uint8Array | null> {
    return this.objects.get(this.nameOf(challengeId, version, "private")) ?? null;
  }

  async putPublic(challengeId: string, version: string, content: Uint8Array): Promise<string> {
    const name = this.nameOf(challengeId, version, "public");
    this.objects.set(name, Uint8Array.from(content));
    return name;
  }

  async getPublic(challengeId: string, version: string): Promise<Uint8Array | null> {
    return this.objects.get(this.nameOf(challengeId, version, "public")) ?? null;
  }
}

export class MemoryChallengeRegistry implements ChallengeRegistry {
  private readonly challenges = new Map<string, { tenantId: string; title: string | null }>();
  private readonly versions = new Map<string, ChallengeVersionRow>();

  constructor(private readonly now: Clock = Date.now) {}

  async upsertChallenge(input: { challengeId: string; tenantId: string; title?: string }): Promise<void> {
    this.challenges.set(input.challengeId, {
      tenantId: input.tenantId,
      title: input.title ?? null,
    });
  }

  async insertChallengeVersion(input: ChallengeVersionInput): Promise<void> {
    const key = `${input.challengeId}@${input.contentVersion}`;
    if (this.versions.has(key)) {
      throw new PersistenceError("challenge_version_conflict", "题目版本已登记(版本不可变)");
    }
    this.versions.set(key, {
      ...input,
      registeredAt: new Date(this.now()).toISOString(),
    });
  }

  async findChallengeVersion(challengeId: string, version: string, tenantId: string): Promise<ChallengeVersionRow | null> {
    const row = this.versions.get(`${challengeId}@${version}`);
    if (row === undefined || row.tenantId !== tenantId) {
      return null;
    }
    return row;
  }

  async listChallengeVersions(challengeId: string, tenantId: string): Promise<ChallengeVersionRow[]> {
    return [...this.versions.values()]
      .filter((row) => row.challengeId === challengeId && row.tenantId === tenantId)
      .sort((a, b) => (a.registeredAt < b.registeredAt ? -1 : 1));
  }
}

// ── 幂等窗口(进程内形态;Redis 不可用时的 sanctioned 降级载体)──────────

interface IdempotencyCacheEntry {
  readonly canonicalRequest: string;
  readonly expiresAt: number;
}

/**
 * 进程内幂等窗口(D-W8-9 同语义;分级降级策略中的 sanctioned 降级载体,
 * D-API-24):窗口是效率设施,正确性由 baseRevision 与单会话串行保证
 * (协议 §4.3)——降级只损失"跨实例共享窗口",不损失协议正确性。
 */
export class MemoryIdempotencyWindow implements IdempotencyWindow {
  private readonly entries = new Map<string, IdempotencyCacheEntry>();

  constructor(
    private readonly ttlSeconds: number,
    private readonly now: Clock = Date.now,
  ) {}

  async checkAndRecord(sessionId: string, key: string, canonicalRequest: string): Promise<IdempotencyVerdict> {
    const storageKey = `${sessionId}\u0000${key}`;
    const nowMs = this.now();
    const cached = this.entries.get(storageKey);
    if (cached !== undefined) {
      if (cached.expiresAt <= nowMs) {
        this.entries.delete(storageKey); // TTL 过期 → fresh(完成标准明确要求)
      } else if (cached.canonicalRequest === canonicalRequest) {
        return "replay-identical";
      } else {
        return "conflict";
      }
    }
    this.entries.set(storageKey, {
      canonicalRequest,
      expiresAt: nowMs + this.ttlSeconds * 1000,
    });
    return "fresh";
  }
}

// ── 快照 origin 的统一入口(内存实现不区分来源,仅透传)─────────────────

export type { SnapshotOrigin };

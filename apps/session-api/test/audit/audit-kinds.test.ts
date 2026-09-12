/**
 * 审计 kind 集合定案断言与 PgAuditSink 单元测试(WP-64;Q5 / D-API-90 ~ 91)。
 *
 * Q5 定案(阶段六任务分解 §六;D-API-59 开口收口):kind 集合 = 阶段三七值
 * 封闭集合 + 裁决域三值(verdict_completed / verdict_replay_failed /
 * verdict_rejected),共 **十值封闭集合,一次性定案后冻结**——本文件是集合
 * 冻结的机检锚:任何再扩张(逐次漂移)或字面改动都在此红灯。
 * 归档动作(archive 批完成)不在集合内:运维事件账走受控日志 + /metrics
 * 计数器(D-API-59"运维事件账不上审计"原裁决)。
 *
 * 发射面归属(定案登记):session-api 现有事件沿七既有值;裁决域三值由
 * WP-62 在 verifier 侧(信任域 4)发射——本包只定案集合与预留库层
 * (audit_log CHECK + verifier 角色 INSERT 授权),不实现 verifier 发射。
 */
import { describe, expect, it } from "vitest";

import { AUDIT_EVENT_KINDS, type AuditEvent } from "../../src/auth/ports.js";
import { PersistenceError } from "../../src/persistence/errors.js";
import { PgAuditSink } from "../../src/persistence/pg/audit-sink.js";

/** 阶段三 WP-2 定案的七既有值(D-API-18;顺序即冻结序)。 */
const LEGACY_SEVEN = [
  "embed_token_issued",
  "embed_token_consumed",
  "embed_token_revoked",
  "session_credential_issued",
  "create_session",
  "submit",
  "session_force_closed",
] as const;

/** 阶段六 WP-64 Q5 定案新增的裁决域三值(发射面归 WP-62 / verifier 侧)。 */
const VERDICT_THREE = ["verdict_completed", "verdict_replay_failed", "verdict_rejected"] as const;

/** 归档动作不在审计集合内(运维事件账;受控日志 + /metrics 承载)。 */
const ARCHIVE_KIND_CANDIDATES = ["audit_archived", "archive_batch_completed", "audit_archive"];

describe("审计 kind 十值封闭集合(Q5 定案冻结,D-API-90)", () => {
  it("集合 = 阶段三七值(原样零改动)+ 裁决域三值,恰十值", () => {
    expect(AUDIT_EVENT_KINDS).toHaveLength(10);
    expect([...AUDIT_EVENT_KINDS].slice(0, 7)).toEqual([...LEGACY_SEVEN]);
    expect([...AUDIT_EVENT_KINDS].slice(7)).toEqual([...VERDICT_THREE]);
  });

  it("集合逐值冻结:任何字面漂移(改名 / 增删)即红灯", () => {
    expect([...AUDIT_EVENT_KINDS]).toEqual([...LEGACY_SEVEN, ...VERDICT_THREE]);
  });

  it("归档动作被排除在集合外(运维事件账不上审计,D-API-59 原裁决)", () => {
    for (const candidate of ARCHIVE_KIND_CANDIDATES) {
      expect(AUDIT_EVENT_KINDS).not.toContain(candidate);
    }
  });

  it("裁决域三值可构造合法 AuditEvent(发射面的类型层预留)", async () => {
    // 类型层:三个新 kind 都是合法 AuditEventKind(编译期联合成员);
    // 运行期:InMemoryAuditSink 形态接受(行为同构由 PG 实现集成测试承接)。
    const events: AuditEvent[] = VERDICT_THREE.map((kind) => ({
      kind,
      at: 0,
      actor: { tenantId: "t-verifier", userId: "verifier" },
      detail: { submissionId: "sub-1", verdict: "success" },
    }));
    expect(events.map((event) => event.kind)).toEqual([...VERDICT_THREE]);
  });
});

/** 捕获参数的假池(PgAuditSink 参数映射与错误翻译的单元形态)。 */
class CapturingPool {
  readonly calls: { sql: string; values: unknown[] }[] = [];
  readonly results: { rows?: unknown[]; error?: Error }[] = [];

  pushError(error: Error): void {
    this.results.push({ error });
  }

  async query(sql: string, values: unknown[] = []): Promise<{ rows: unknown[] }> {
    this.calls.push({ sql, values });
    const result = this.results.shift();
    if (result?.error !== undefined) {
      throw result.error;
    }
    return { rows: result?.rows ?? [] };
  }
}

describe("PgAuditSink(append-only 端口语义;fail-closed,D-API-91)", () => {
  const baseEvent: AuditEvent = {
    kind: "create_session",
    at: 1_760_000_000_123,
    actor: { tenantId: "tenant-a", userId: "user-1" },
    sessionId: "sess-abc",
    detail: { challengeVersion: "1.0.0" },
  };

  it("append 落库参数映射:kind / at / actor / sessionId / detail(JSON 文本)", async () => {
    const pool = new CapturingPool();
    await new PgAuditSink(pool as unknown as import("pg").Pool).append(baseEvent);
    expect(pool.calls).toHaveLength(1);
    const { sql, values } = pool.calls[0]!;
    expect(sql).toMatch(/INSERT INTO audit_log/);
    expect(values[0]).toBe("create_session");
    expect(values[1]).toEqual(new Date(baseEvent.at));
    expect(values[2]).toBe("tenant-a");
    expect(values[3]).toBe("user-1");
    expect(values[4]).toBe("sess-abc");
    expect(values[5]).toBe(JSON.stringify({ challengeVersion: "1.0.0" }));
  });

  it("可选字段缺席:sessionId / detail 以 NULL 落库(行形态完备,归档序列化确定)", async () => {
    const pool = new CapturingPool();
    const event: AuditEvent = {
      kind: "embed_token_consumed",
      at: 1,
      actor: { tenantId: "t", userId: "u" },
      detail: { outcome: "rejected", reason: "signature" },
    };
    await new PgAuditSink(pool as unknown as import("pg").Pool).append(event);
    expect(pool.calls[0]!.values[4]).toBeNull();
    expect(pool.calls[0]!.values[5]).toBe(JSON.stringify({ outcome: "rejected", reason: "signature" }));
  });

  it("落库失败 fail-closed:抛 PersistenceError(store_unavailable),错误面零载荷细节", async () => {
    const pool = new CapturingPool();
    pool.pushError(new Error('duplicate key value violates unique constraint "audit_log_pkey"'));
    let caught: unknown;
    try {
      await new PgAuditSink(pool as unknown as import("pg").Pool).append(baseEvent);
      expect.unreachable("审计落库失败不得静默(D-API-18/33 fail-closed)");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    const persistenceError = caught as PersistenceError;
    expect(persistenceError.code).toBe("store_unavailable");
    // 错误消息 = 稳定语义文案;载荷(jti / tenantId / detail)零回显。
    expect(persistenceError.message).not.toContain("tenant-a");
    expect(persistenceError.message).not.toContain("sess-abc");
    expect(persistenceError.message).not.toContain("challengeVersion");
  });

  it("端口形状零更新 / 零删除:append 之外无任何变更方法(append-only 结构强制)", () => {
    const sink = new PgAuditSink(new CapturingPool() as unknown as import("pg").Pool);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(sink)).filter(
      (name) => name !== "constructor",
    );
    expect(methods).toEqual(["append"]);
  });
});

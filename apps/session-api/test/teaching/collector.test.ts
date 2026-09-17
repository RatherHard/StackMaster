/**
 * 教学事件采集器与装配面(单元测试;WP-82;D-API-150)。
 *
 * 断言面:
 *  1. 幂等采集(重放零新增);
 *  2. **旁路失败语义**:源读失败 / 落库失败一律折叠为采集结果,绝不外抛
 *    (教学采集账 vs 安全审计账的失败语义不同);
 *  3. 截断与窗口信号如实透出(不静默丢数据);
 *  4. 采集面零伪造:落库种类恒落 v1 可采集三值(「提示使用」无采集路径);
 *  5. 装配面与端口面一致:教学端口**没有任何返回行级数据的方法**。
 */

import { describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  MemoryAuthoritativeTeachingSource,
  MemoryTeachingEventStore,
  TEACHING_COLLECTION_FAILURE_REASON,
  TEACHING_EVENT_RETENTION_DAYS,
  TeachingEventCollector,
  buildTeachingCollection,
} from "../../src/teaching/index.js";
import type {
  AuthoritativeTeachingRows,
  AuthoritativeTeachingSource,
  DerivedTeachingEvent,
  TeachingEventStore,
} from "../../src/teaching/index.js";
import { PostgresAuthoritativeTeachingSource } from "../../src/teaching/pg/authoritative-source.js";
import { PostgresTeachingEventStore } from "../../src/teaching/pg/teaching-events-store.js";

const TENANT = "tenant-collector";
const SESSION = "sess-collector-aaaaaaaa";

function rows(overrides: Partial<AuthoritativeTeachingRows> = {}): AuthoritativeTeachingRows {
  return {
    sessions: [
      {
        sessionId: SESSION,
        challengeId: "sm-ch01-write-basics",
        challengeVersion: "1.0.0",
        createdAt: "2026-09-17T10:00:00.000Z",
      },
    ],
    passedVerdicts: [
      {
        verdictId: "8f14e45f-ceea-4a1e-9c1e-2b0b0a1b2c3d",
        sessionId: SESSION,
        verdict: "success",
        challengeId: "sm-ch01-write-basics",
        challengeVersion: "1.0.0",
        createdAt: "2026-09-17T10:02:00.000Z",
      },
    ],
    undos: [
      {
        actionLogId: "7",
        sessionId: SESSION,
        challengeId: "sm-ch01-write-basics",
        challengeVersion: "1.0.0",
        createdAt: "2026-09-17T10:01:00.000Z",
      },
    ],
    truncated: false,
    ...overrides,
  };
}

function rig(): {
  source: MemoryAuthoritativeTeachingSource;
  store: MemoryTeachingEventStore;
  collector: TeachingEventCollector;
} {
  const source = new MemoryAuthoritativeTeachingSource();
  source.seed({ tenantId: TENANT, sessions: rows().sessions, passedVerdicts: rows().passedVerdicts, undos: rows().undos });
  const store = new MemoryTeachingEventStore();
  return { source, store, collector: new TeachingEventCollector({ source, store }) };
}

describe("采集(幂等 / 计数 / 零伪造)", () => {
  it("三类派生并落库:派生数 = 新落库数", async () => {
    const { collector, store } = rig();
    const outcome = await collector.collect(TENANT);
    expect(outcome).toEqual({
      tenantId: TENANT,
      derivedEvents: 3,
      appendedRows: 3,
      truncated: false,
      failed: false,
      failureReason: null,
    });
    expect(store.inspect()).toEqual({
      rowCount: 3,
      kinds: ["challenge_started", "passed", "undo"],
    });
  });

  it("重放采集零新增(幂等锚 = 源权威行)", async () => {
    const { collector, store } = rig();
    await collector.collect(TENANT);
    const second = await collector.collect(TENANT);
    expect(second.appendedRows).toBe(0);
    expect(second.derivedEvents).toBe(3);
    expect(store.inspect().rowCount).toBe(3);
  });

  it("落库种类恒落 v1 可采集三值(「提示使用」零采集路径)", async () => {
    const { collector, store } = rig();
    await collector.collect(TENANT);
    for (const kind of store.inspect().kinds) {
      expect(["challenge_started", "passed", "undo"]).toContain(kind);
    }
    expect(store.inspect().kinds).not.toContain("hint_used");
  });

  it("采集结果键集冻结:无 hint / 无标识符字段表达位", async () => {
    const { collector } = rig();
    const outcome = await collector.collect(TENANT);
    expect(Object.keys(outcome).sort()).toEqual(
      [
        "appendedRows",
        "derivedEvents",
        "failed",
        "failureReason",
        "tenantId",
        "truncated",
      ].sort(),
    );
    expect(Object.keys(outcome)).not.toContain("hintUsed");
    expect(JSON.stringify(outcome)).not.toContain(SESSION);
  });

  it("窗口左界透传到权威面(watermark 分批)", async () => {
    const { collector } = rig();
    const outcome = await collector.collect(TENANT, { sinceIso: "2026-09-17T10:01:30.000Z" });
    // 窗口后只剩通过事件(10:02:00);开始(10:00)与回退(10:01:00)落在窗口外。
    expect(outcome.derivedEvents).toBe(1);
  });

  it("单批读取命中上限 ⇒ truncated 如实透出(不静默)", async () => {
    const source: AuthoritativeTeachingSource = {
      readAuthoritativeRows: async () => ({ ...rows(), truncated: true }),
    };
    const store = new MemoryTeachingEventStore();
    const collector = new TeachingEventCollector({ source, store });
    const outcome = await collector.collect(TENANT);
    expect(outcome.truncated).toBe(true);
    expect(outcome.failed).toBe(false);
  });

  it("空权威面 ⇒ 零派生零落库(不写占位行)", async () => {
    const source = new MemoryAuthoritativeTeachingSource();
    const store = new MemoryTeachingEventStore();
    const collector = new TeachingEventCollector({ source, store });
    const outcome = await collector.collect("tenant-empty");
    expect(outcome).toMatchObject({ derivedEvents: 0, appendedRows: 0, failed: false });
    expect(store.inspect().rowCount).toBe(0);
  });
});

describe("旁路失败语义(采集失败不得影响主链路)", () => {
  it("落库失败 ⇒ 折叠为失败结果,不外抛;原始错误只到观察回调", async () => {
    const source = new MemoryAuthoritativeTeachingSource();
    source.seed({
      tenantId: TENANT,
      sessions: rows().sessions,
      passedVerdicts: rows().passedVerdicts,
      undos: rows().undos,
    });
    const store: TeachingEventStore = {
      appendDerived: async () => {
        throw new Error("pg down");
      },
      purgeExpired: async () => 0,
    };
    const seen: unknown[] = [];
    const collector = new TeachingEventCollector({
      source,
      store,
      onFailure: (_outcome, error) => seen.push(error),
    });
    const outcome = await collector.collect(TENANT);
    expect(outcome.failed).toBe(true);
    expect(outcome.failureReason).toBe(TEACHING_COLLECTION_FAILURE_REASON);
    expect(outcome.derivedEvents).toBe(0);
    expect(seen).toHaveLength(1);
    expect(String(seen[0])).toContain("pg down");
  });

  it("源读失败同样折叠(不外抛),且不写任何行", async () => {
    const source: AuthoritativeTeachingSource = {
      readAuthoritativeRows: async () => {
        throw new Error("authoritative read failed");
      },
    };
    const store = new MemoryTeachingEventStore();
    const collector = new TeachingEventCollector({ source, store });
    await expect(collector.collect(TENANT)).resolves.toMatchObject({
      failed: true,
      failureReason: TEACHING_COLLECTION_FAILURE_REASON,
    });
    expect(store.inspect().rowCount).toBe(0);
  });

  it("无观察回调时同样不抛(失败语义不依赖回调在场)", async () => {
    const source: AuthoritativeTeachingSource = {
      readAuthoritativeRows: async () => {
        throw new Error("boom");
      },
    };
    const collector = new TeachingEventCollector({ source, store: new MemoryTeachingEventStore() });
    const outcome = await collector.collect(TENANT);
    expect(outcome.failed).toBe(true);
  });

  it("失败结果零载荷细节(不含原始错误文本)", async () => {
    const source: AuthoritativeTeachingSource = {
      readAuthoritativeRows: async () => {
        throw new Error("internal stack / private path /secret");
      },
    };
    const collector = new TeachingEventCollector({ source, store: new MemoryTeachingEventStore() });
    const outcome = await collector.collect(TENANT);
    expect(JSON.stringify(outcome)).not.toContain("internal stack");
    expect(JSON.stringify(outcome)).not.toContain("private path");
  });
});

describe("保留期(唯一 sanctioned 删除路径)", () => {
  it("按事件时刻窗口清除;窗口内行保留", async () => {
    const store = new MemoryTeachingEventStore(() => new Date("2026-09-17T12:00:00.000Z").getTime());
    const old: DerivedTeachingEvent = {
      kind: "undo",
      occurredAt: "2026-01-01T00:00:00.000Z",
      challengeId: "sm-ch01-write-basics",
      challengeVersion: "1.0.0",
      subjectDigest: "a".repeat(64),
      sourceRef: "action:1",
      eventCount: 1,
      derivation: "teaching-derive-v1",
    };
    const fresh: DerivedTeachingEvent = { ...old, sourceRef: "action:2", occurredAt: "2026-09-17T11:00:00.000Z" };
    await store.appendDerived(TENANT, [old, fresh]);
    expect(store.inspect().rowCount).toBe(2);
    expect(await store.purgeExpired(TEACHING_EVENT_RETENTION_DAYS)).toBe(1);
    expect(store.inspect()).toEqual({ rowCount: 1, kinds: ["undo"] });
  });

  it("清理后的源行可重新采集(与库层 DELETE 语义同形:唯一键随行消失)", async () => {
    const store = new MemoryTeachingEventStore(() => new Date("2026-09-17T12:00:00.000Z").getTime());
    const event: DerivedTeachingEvent = {
      kind: "undo",
      occurredAt: "2026-01-01T00:00:00.000Z",
      challengeId: "sm-ch01-write-basics",
      challengeVersion: "1.0.0",
      subjectDigest: "a".repeat(64),
      sourceRef: "action:1",
      eventCount: 1,
      derivation: "teaching-derive-v1",
    };
    await store.appendDerived(TENANT, [event]);
    await store.purgeExpired(TEACHING_EVENT_RETENTION_DAYS);
    expect(await store.appendDerived(TENANT, [event])).toBe(1);
  });
});

describe("端口面纪律(结构性零行级读面)", () => {
  it("装配面经 buildTeachingCollection 单点产出 PG 适配器", () => {
    const assembly = buildTeachingCollection({} as unknown as Pool);
    expect(assembly.source).toBeInstanceOf(PostgresAuthoritativeTeachingSource);
    expect(assembly.store).toBeInstanceOf(PostgresTeachingEventStore);
    expect(assembly.aggregates).toBe(assembly.store);
    expect(assembly.collector).toBeInstanceOf(TeachingEventCollector);
  });

  it("采集 / 聚合端口无任何返回行级数据的方法(方法面逐条冻结)", () => {
    const assembly = buildTeachingCollection({} as unknown as Pool);
    const methods = (target: object): string[] =>
      Object.getOwnPropertyNames(Object.getPrototypeOf(target))
        .filter((name) => name !== "constructor")
        .sort();
    expect(methods(assembly.source)).toEqual(["readAuthoritativeRows"]);
    expect(methods(assembly.collector)).toEqual(["collect"]);
    // 写入面与聚合读面由**同一适配器**承载(租户作用域单实现),故两面方法并集相同。
    expect(methods(assembly.store)).toEqual([
      "aggregateByChallenge",
      "appendDerived",
      "purgeExpired",
    ]);
    expect(assembly.aggregates).toBe(assembly.store);
    const union = new Set([assembly.source, assembly.store, assembly.collector].flatMap(methods));
    expect([...union].sort()).toEqual([
      "aggregateByChallenge",
      "appendDerived",
      "collect",
      "purgeExpired",
      "readAuthoritativeRows",
    ]);
    for (const target of [assembly.source, assembly.store, assembly.aggregates, assembly.collector]) {
      for (const name of methods(target)) {
        expect(name).not.toMatch(/^(list|find|get|read)Rows?$|^(list|find)Events?$/);
      }
    }
  });
});

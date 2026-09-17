/**
 * 成绩导出契约一致性测试(D-MP-5 分支 A;WP-78 契约复用,禁写第二套实现)。
 *
 * 机检面(逐条对应 WP-79 的"导出与 WP-78 一致性"):
 *  1. 导出结果**逐字**通过 `HostScoresResponseSchema.parse()`(契约唯一出口);
 *  2. 顶层字段集**恰**为 `items` / `nextCursor`(strictObject:多一个键即拒);
 *  3. 逐条记录字段集锁定为契约 schema 的七字段(由 schema 派生,非手写清单);
 *  4. 下游**不变量**:输出里不出现 `detail` / `reference` / `tenantId` 任何
 *     形式(私有判题明细与租户回显零表达位);
 *  5. 游标语义:多行 + 两页推进 + 终态 `nextCursor = null` + 空页耦合;
 *  6. 契约兜底:存储返回越界裁决字面 ⇒ 导出抛错(绝不下发非契约形态)。
 */
import { describe, expect, it } from "vitest";
import { HostScoresResponseSchema, HostScoreRecordSchema } from "@stackmaster/protocol";

import { exportHostScores, HOST_SCORE_RECORD_FIELDS } from "../src/scores/export.js";
import { MemoryAdminReadStore } from "../src/persistence/memory-read-store.js";
import type { AdminReadStore, ScoresPageRow } from "../src/persistence/ports.js";

const TENANT = "tenant-a";

/** 已播种题目的租户集合(**按 store 实例**;题目主键全局唯一 ⇒ 每租户一份)。 */
const seededByStore = new WeakMap<MemoryAdminReadStore, Set<string>>();

/** 题目登记每租户只播种一次(challenges 主键全局唯一,幂等形态同 PG)。 */
function ensureChallenge(store: MemoryAdminReadStore, tenantId: string): void {
  const seeded = seededByStore.get(store) ?? new Set<string>();
  seededByStore.set(store, seeded);
  if (seeded.has(tenantId)) {
    return;
  }
  seeded.add(tenantId);
  store.seedChallenge({
    tenantId,
    challengeId: `chal-${tenantId}`,
    title: "IT 题目",
    versions: [
      {
        contentVersion: "1.0.0",
        vmProfileVersion: "1.0.0",
        registeredAtEpochSeconds: 1_700_000_000,
      },
    ],
  });
}

function seedRow(
  store: MemoryAdminReadStore,
  index: number,
  options: { tenantId?: string } = {},
): { submissionId: string; scoreRowId: string } {
  const tenantId = options.tenantId ?? TENANT;
  const suffix = String(index).padStart(12, "0");
  const submissionId = `00000000-0000-4000-8000-${suffix}`;
  const scoreRowId = `10000000-0000-4000-8000-${String(9_999 - index).padStart(12, "0")}`;
  const sessionId = `sess-${index}`;
  ensureChallenge(store, tenantId);
  store.seedSubmission({
    tenantId,
    submissionId,
    sessionId,
    revision: 3 + index,
    challengeId: `chal-${tenantId}`,
    challengeVersion: "1.0.0",
    createdAtEpochSeconds: 1_700_000_000 + index,
    verdict: "success",
    decidedAtEpochSeconds: 1_700_000_100 + index,
    scoreRowId,
  });
  return { submissionId, scoreRowId };
}

describe("exportHostScores(契约复用)", () => {
  it("输出逐字通过 HostScoresResponseSchema.parse;顶层字段恰为 items / nextCursor", async () => {
    const store = new MemoryAdminReadStore();
    for (let index = 0; index < 3; index += 1) {
      seedRow(store, index);
    }
    const page = await exportHostScores({ store, tenantId: TENANT, limit: 10 });
    expect(() => HostScoresResponseSchema.parse(page)).not.toThrow();
    expect(Object.keys(page).sort()).toEqual(["items", "nextCursor"]);
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
    // 游标语义:单页取尽 ⇒ 恒 null(键恒在,不省略)。
    expect("nextCursor" in page).toBe(true);
  });

  it("逐条记录字段集锁定为契约七字段,且无 detail / reference / tenantId 任何形式", async () => {
    const store = new MemoryAdminReadStore();
    seedRow(store, 0);
    const page = await exportHostScores({ store, tenantId: TENANT, limit: 10 });
    expect(HOST_SCORE_RECORD_FIELDS).toHaveLength(7);
    for (const item of page.items) {
      expect(Object.keys(item).sort()).toEqual([...HOST_SCORE_RECORD_FIELDS].sort());
      expect(() => HostScoreRecordSchema.parse(item)).not.toThrow();
    }
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("detail");
    expect(serialized).not.toContain("reference");
    expect(serialized).not.toContain("tenantId");
    // 载荷里的标识符只有公开契约定位符(challengeId / challengeVersion 等)。
    expect(serialized).toContain("chal-tenant-a");
    expect(serialized).toContain("1.0.0");
  });

  it("游标推进:两页拼合 = 全量且不重不漏;末页 nextCursor = null", async () => {
    const store = new MemoryAdminReadStore();
    const seeded = Array.from({ length: 5 }, (_, index) => seedRow(store, index));
    const first = await exportHostScores({ store, tenantId: TENANT, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await exportHostScores({
      store,
      tenantId: TENANT,
      limit: 2,
      ...(first.nextCursor === null ? {} : { afterId: first.nextCursor }),
    });
    const third = await exportHostScores({
      store,
      tenantId: TENANT,
      limit: 2,
      ...(second.nextCursor === null ? {} : { afterId: second.nextCursor }),
    });
    expect(third.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items, ...third.items].map((item) => item.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    // 游标恒为本页末行 id(keyset 推进的可核对形态)。
    expect(first.nextCursor).toBe(first.items[first.items.length - 1]?.id);
    // 游标值本身是公开投影(不得是时刻)。
    expect(Number.isNaN(Number(first.nextCursor))).toBe(true);
    expect(seeded.map((row) => row.scoreRowId)).toContain(first.nextCursor);
  });

  it("空页 ⇒ nextCursor 必为 null(跨字段耦合;空批是合法终态)", async () => {
    const store = new MemoryAdminReadStore();
    const page = await exportHostScores({ store, tenantId: TENANT, limit: 10 });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(() => HostScoresResponseSchema.parse(page)).not.toThrow();
    // 反例:空批 + 非空游标被契约拒绝(证明耦合真的在 schema 里生效)。
    expect(() =>
      HostScoresResponseSchema.parse({ items: [], nextCursor: "cursor-1" }),
    ).toThrow();
  });

  it("租户隔离:导出只含绑定租户的行(跨租户零行)", async () => {
    const store = new MemoryAdminReadStore();
    seedRow(store, 0, { tenantId: "tenant-a" });
    seedRow(store, 1, { tenantId: "tenant-b" });    const pageA = await exportHostScores({ store, tenantId: "tenant-a", limit: 10 });
    const pageB = await exportHostScores({ store, tenantId: "tenant-b", limit: 10 });
    expect(pageA.items).toHaveLength(1);
    expect(pageB.items).toHaveLength(1);
    expect(pageA.items[0]?.id).not.toBe(pageB.items[0]?.id);
  });

  it("契约兜底:存储返回越界裁决字面 ⇒ 导出抛错(绝不下发非契约形态)", async () => {
    const hostile: AdminReadStore = {
      implementation: "memory",
      listChallenges: async () => [],
      queryVerdicts: async () => [],
      readScoresPage: async (): Promise<readonly ScoresPageRow[]> => [
        {
          id: "10000000-0000-4000-8000-000000000001",
          submissionId: "00000000-0000-4000-8000-000000000001",
          sessionId: "sess-1",
          challengeId: "chal-1",
          challengeVersion: "1.0.0",
          // 越界字面(不在 11 值冻结结果类型内):不得静默下发。
          verdict: "definitely_not_a_verdict" as never,
          decidedAtEpochSeconds: 1,
        },
      ],
    };
    await expect(
      exportHostScores({ store: hostile, tenantId: TENANT, limit: 10 }),
    ).rejects.toThrow();
  });

  it("契约也拒绝多带字段的信封(证明 strictObject 真的在把关)", () => {
    expect(() =>
      HostScoresResponseSchema.parse({ items: [], nextCursor: null, extra: 1 }),
    ).toThrow();
    expect(() =>
      HostScoreRecordSchema.parse({
        id: "a",
        submissionId: "b",
        sessionId: "c",
        challengeId: "d",
        challengeVersion: "1.0.0",
        verdict: "success",
        decidedAt: 1,
        detail: { secret: true },
      }),
    ).toThrow();
  });
});

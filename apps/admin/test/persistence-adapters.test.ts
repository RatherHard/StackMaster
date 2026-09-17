/**
 * PG 适配器与连接层单元测试(WP-79;**零容器**,确定性)。
 *
 * 分工纪律(与 verifier 同款):
 *  - 本文件用**假 PoolClient** 断言**形状层事实**——发出去的 SQL 文本、
 *    参数绑定顺序、事务控制序(BEGIN → SET LOCAL → 语句 → COMMIT)、
 *    行 → 端口记录的映射、错误翻译。这些是真实 PG 用例**看不见**的部分
 *    (真库里只看得见结果,看不见"我们到底发了什么 SQL")。
 *  - 真实 PG 路径(RLS / 授权 / 三表连接)由容器门控用例承载
 *    (`compose-topology.test.ts` / `runtime.integration.test.ts`)。
 *
 * 本文件同时是**只读纪律的第二重机检**:每条数据语句都断言
 * `assertReadOnlySql(sql) === sql`(幂等 = 该语句确实过了护栏),且
 * `SET LOCAL` 的第三参恒为 `true`(事务局部 ⇒ 连接归池后零租户态残留)。
 */
import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { assertReadOnlySql } from "../src/persistence/read-only-guard.js";
import {
  ADMIN_TENANT_CONTEXT_GUC,
  AdminTenantScope,
  closeAdminPostgresPool,
  createAdminPostgresPool,
} from "../src/persistence/pg-connection.js";
import { PostgresAdminReadStore } from "../src/persistence/pg-read-store.js";
import { AdminStoreError } from "../src/persistence/ports.js";

type Row = Record<string, unknown>;

interface FakePg {
  readonly pool: Pool;
  readonly calls: { sql: string; values: readonly unknown[] | undefined }[];
  releasedCount(): number;
  readonly poolQueries: string[];
}

/** 假连接池:记录每条语句与参数;应答由 responder 按 SQL 文本决定。 */
function fakePg(
  responder: (sql: string, values: readonly unknown[] | undefined) => Row[] = () => [],
): FakePg {
  const calls: { sql: string; values: readonly unknown[] | undefined }[] = [];
  const poolQueries: string[] = [];
  let released = 0;
  const client = {
    query: async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values });
      return { rows: responder(sql, values) };
    },
    release: () => {
      released += 1;
    },
  };
  const pool = {
    connect: async () => client as unknown as PoolClient,
    query: async (sql: string) => {
      poolQueries.push(sql);
      return { rows: [] };
    },
    end: async () => undefined,
  };
  return {
    pool: pool as unknown as Pool,
    calls,
    releasedCount: () => released,
    poolQueries,
  };
}

const TENANT = "tenant-a";
/** 数据语句 = 只读语句(排除事务控制与 `set_config` 租户注入)。 */
const dataCalls = (fake: FakePg) =>
  fake.calls.filter(
    (call) => /^\s*SELECT/i.test(call.sql) && !call.sql.includes("set_config"),
  );

describe("AdminTenantScope(事务控制序)", () => {
  it("BEGIN → SET LOCAL(is_local=true)→ 语句 → COMMIT;release 恒执行", async () => {
    const fake = fakePg();
    const scope = new AdminTenantScope(fake.pool);
    const result = await scope.transaction(TENANT, async () => "ok");
    expect(result).toBe("ok");
    expect(fake.calls.map((call) => call.sql.split(" ")[0])).toEqual([
      "BEGIN",
      "SELECT",
      "COMMIT",
    ]);
    expect(fake.calls[1]?.sql).toContain(`set_config('${ADMIN_TENANT_CONTEXT_GUC}', $1, true)`);
    expect(fake.calls[1]?.values).toEqual([TENANT]);
    expect(fake.releasedCount()).toBe(1);
  });

  it("语句抛错 ⇒ ROLLBACK 且原错误透出(不吞错)", async () => {
    const fake = fakePg();
    const scope = new AdminTenantScope(fake.pool);
    await expect(
      scope.transaction(TENANT, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fake.calls.map((call) => call.sql)).toEqual(["BEGIN", expect.stringContaining("set_config"), "ROLLBACK"]);
    expect(fake.releasedCount()).toBe(1);
  });

  it("ping 只发 SELECT 1 且不经租户 GUC(探针不读租户数据)", async () => {
    const fake = fakePg();
    await new AdminTenantScope(fake.pool).ping();
    expect(fake.poolQueries).toEqual(["SELECT 1"]);
    expect(fake.calls).toEqual([]);
  });

  it("连接池首连失败 ⇒ AdminStoreError(fail-closed,拒绝启动)", async () => {
    await expect(
      createAdminPostgresPool("postgres://admin_ro:admin-ro-dev@127.0.0.1:1/session_api"),
    ).rejects.toThrow(AdminStoreError);
  }, 20_000);

  it("closeAdminPostgresPool 归还池", async () => {
    let ended = 0;
    const pool = { end: async () => void (ended += 1) } as unknown as Pool;
    await closeAdminPostgresPool(pool);
    expect(ended).toBe(1);
  });
});

describe("PostgresAdminReadStore.listChallenges", () => {
  it("两条语句 + 版本链归并;limit 是题目条数", async () => {
    const fake = fakePg((sql) => {
      if (sql.includes("FROM challenges c")) {
        return [
          { challenge_id: "chal-1", title: "第一题" },
          { challenge_id: "chal-2", title: null },
        ];
      }
      if (sql.includes("FROM challenge_versions v")) {
        return [
          {
            challenge_id: "chal-1",
            content_version: "1.0.0",
            vm_profile_version: "1.0.0",
            registered_at: "1700000000",
          },
          {
            challenge_id: "chal-1",
            content_version: "1.1.0",
            vm_profile_version: "1.0.0",
            registered_at: 1_700_000_100,
          },
          {
            challenge_id: "chal-2",
            content_version: "2.0.0",
            vm_profile_version: "2.0.0",
            registered_at: 1_700_000_200,
          },
        ];
      }
      return [];
    });
    const store = new PostgresAdminReadStore(fake.pool);
    const entries = await store.listChallenges({ tenantId: TENANT, limit: 2 });
    expect(entries).toEqual([
      {
        challengeId: "chal-1",
        title: "第一题",
        versions: [
          { contentVersion: "1.0.0", vmProfileVersion: "1.0.0", registeredAtEpochSeconds: 1_700_000_000 },
          { contentVersion: "1.1.0", vmProfileVersion: "1.0.0", registeredAtEpochSeconds: 1_700_000_100 },
        ],
      },
      {
        challengeId: "chal-2",
        title: null,
        versions: [
          { contentVersion: "2.0.0", vmProfileVersion: "2.0.0", registeredAtEpochSeconds: 1_700_000_200 },
        ],
      },
    ]);
    const statements = dataCalls(fake);
    expect(statements).toHaveLength(2);
    expect(statements[0]?.values).toEqual([TENANT, 2]);
    // 版本查询按**题目 id 列表**取,而不是按行 LIMIT(避免"版本多的题挤掉别的题")。
    expect(statements[1]?.values).toEqual([TENANT, ["chal-1", "chal-2"]]);
    // 两条语句都过了护栏(幂等 = 发出去的就是护栏归一化后的那一份)。
    for (const call of statements) {
      expect(assertReadOnlySql(call.sql)).toBe(call.sql);
    }
    // 全程无写语句、无私有列。
    const sent = fake.calls.map((call) => call.sql).join("\n");
    expect(sent).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(sent).not.toContain("private_bundle");
    // 事务局部 GUC(连接归池后零租户态残留)。
    expect(sent).toContain("set_config('app.tenant_id', $1, true)");
    expect(fake.releasedCount()).toBe(1);
  });

  it("零登记 ⇒ 只发一条语句(不做无意义的版本查询)", async () => {
    const fake = fakePg(() => []);
    const store = new PostgresAdminReadStore(fake.pool);
    expect(await store.listChallenges({ tenantId: TENANT, limit: 10 })).toEqual([]);
    expect(dataCalls(fake)).toHaveLength(1);
  });

  it("登记时刻不可解析 ⇒ AdminStoreError + ROLLBACK(不伪造 0)", async () => {
    const fake = fakePg((sql) =>
      sql.includes("FROM challenges c")
        ? [{ challenge_id: "chal-1", title: "t" }]
        : [
            {
              challenge_id: "chal-1",
              content_version: "1.0.0",
              vm_profile_version: "1.0.0",
              registered_at: null,
            },
          ],
    );
    const store = new PostgresAdminReadStore(fake.pool);
    await expect(store.listChallenges({ tenantId: TENANT, limit: 1 })).rejects.toThrow(
      /registered_at 不可解析/,
    );
    expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(fake.releasedCount()).toBe(1);
  });
});

describe("PostgresAdminReadStore.queryVerdicts", () => {
  const verdictRows = (sql: string): Row[] =>
    sql.includes("FROM submissions s")
      ? [
          {
            submission_id: "sub-1",
            revision: "3",
            verdict: "success",
            decided_at: "1700000100",
          },
          { submission_id: "sub-2", revision: 4, verdict: null, decided_at: null },
          // 有裁决字面但时刻不可解析:pending(`LEFT JOIN` 的 pending 语义
          // 优先于半个裁决事实——不得给出"有结果但没时刻"的记录)。
          { submission_id: "sub-3", revision: 5, verdict: "timeout", decided_at: null },
        ]
      : [];

  it("参数绑定序(租户 → 提交 → 题目 → 窗口 → 上限)与 pending/verdicted 映射", async () => {
    const fake = fakePg(verdictRows);
    const store = new PostgresAdminReadStore(fake.pool);
    const rows = await store.queryVerdicts({
      tenantId: TENANT,
      submissionId: "11111111-1111-4111-8111-111111111111",
      challengeId: "chal-1",
      sinceEpochSeconds: 1_700_000_000,
      untilEpochSeconds: 1_700_000_500,
      limit: 3,
    });
    expect(rows).toEqual([
      { submissionId: "sub-1", revision: 3, status: "verdicted", verdict: "success", decidedAtEpochSeconds: 1_700_000_100 },
      { submissionId: "sub-2", revision: 4, status: "pending", verdict: null, decidedAtEpochSeconds: null },
      { submissionId: "sub-3", revision: 5, status: "pending", verdict: null, decidedAtEpochSeconds: null },
    ]);
    expect(dataCalls(fake)[0]?.values).toEqual([
      TENANT,
      "11111111-1111-4111-8111-111111111111",
      "chal-1",
      new Date(1_700_000_000 * 1_000).toISOString(),
      new Date(1_700_000_500 * 1_000).toISOString(),
      3,
    ]);
    // 未提供的过滤面绑定 NULL(而非空串——`$n::uuid IS NULL` 是"不过滤"的唯一形态)。
    const fake2 = fakePg(verdictRows);
    await new PostgresAdminReadStore(fake2.pool).queryVerdicts({ tenantId: TENANT, limit: 10 });
    expect(dataCalls(fake2)[0]?.values).toEqual([TENANT, null, null, null, null, 10]);
    // 私有列结构性未选。
    expect(dataCalls(fake2)[0]?.sql).not.toContain("detail");
    expect(dataCalls(fake2)[0]?.sql).not.toContain("reference");
    expect(assertReadOnlySql(dataCalls(fake2)[0]?.sql ?? "")).toBe(dataCalls(fake2)[0]?.sql);
  });

  it("revision 不可解析 ⇒ AdminStoreError(不把 NaN 当 revision)", async () => {
    const fake = fakePg((sql) =>
      sql.includes("FROM submissions s")
        ? [{ submission_id: "sub-1", revision: "not-a-number", verdict: null, decided_at: null }]
        : [],
    );
    await expect(
      new PostgresAdminReadStore(fake.pool).queryVerdicts({ tenantId: TENANT, limit: 1 }),
    ).rejects.toThrow(/revision 不可解析/);
  });
});

describe("PostgresAdminReadStore.readScoresPage", () => {
  it("keyset 参数(租户 → 游标 → 上限)与七字段映射", async () => {
    const fake = fakePg((sql) =>
      sql.includes("FROM verdicts v")
        ? [
            {
              id: "aaaaaaaa-0000-4000-8000-000000000001",
              submission_id: "sub-1",
              session_id: "sess-1",
              challenge_id: "chal-1",
              challenge_version: "1.0.0",
              verdict: "success",
              decided_at: "1700000100",
            },
          ]
        : [],
    );
    const store = new PostgresAdminReadStore(fake.pool);
    const rows = await store.readScoresPage({
      tenantId: TENANT,
      afterId: "aaaaaaaa-0000-4000-8000-000000000000",
      limit: 1,
    });
    expect(rows).toEqual([
      {
        id: "aaaaaaaa-0000-4000-8000-000000000001",
        submissionId: "sub-1",
        sessionId: "sess-1",
        challengeId: "chal-1",
        challengeVersion: "1.0.0",
        verdict: "success",
        decidedAtEpochSeconds: 1_700_000_100,
      },
    ]);
    const statement = dataCalls(fake)[0];
    expect(statement?.values).toEqual([TENANT, "aaaaaaaa-0000-4000-8000-000000000000", 1]);
    // 游标键 = verdicts.id 升序(禁时刻游标),detail 列未选。
    expect(statement?.sql).toContain("ORDER BY v.id ASC");
    expect(statement?.sql).toContain("v.id > $2::uuid");
    expect(statement?.sql).not.toContain("detail");
  });

  it("裁决时刻不可解析 ⇒ AdminStoreError", async () => {
    const fake = fakePg((sql) =>
      sql.includes("FROM verdicts v")
        ? [
            {
              id: "id-1",
              submission_id: "sub-1",
              session_id: "sess-1",
              challenge_id: "chal-1",
              challenge_version: "1.0.0",
              verdict: "success",
              decided_at: null,
            },
          ]
        : [],
    );
    await expect(
      new PostgresAdminReadStore(fake.pool).readScoresPage({ tenantId: TENANT, limit: 1 }),
    ).rejects.toThrow(/created_at 不可解析/);
  });

  it("驱动层故障 ⇒ 翻译成 AdminStoreError(不伪装成空页)且已回滚", async () => {
    const fake = fakePg((sql) => {
      if (sql.includes("FROM verdicts v")) {
        throw new Error("connection terminated unexpectedly");
      }
      return [];
    });
    const store = new PostgresAdminReadStore(fake.pool);
    await expect(store.readScoresPage({ tenantId: TENANT, limit: 1 })).rejects.toThrow(
      AdminStoreError,
    );
    expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(fake.releasedCount()).toBe(1);
  });

  it("ping 走连接池探针(只读;不经租户 GUC)", async () => {
    const fake = fakePg();
    await new PostgresAdminReadStore(fake.pool).ping();
    expect(fake.poolQueries).toEqual(["SELECT 1"]);
  });
});

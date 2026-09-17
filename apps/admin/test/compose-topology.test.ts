/**
 * 管理面 compose 拓扑例(容器门控;WP-79 第 6 条「compose 拓扑一例」)。
 *
 * 门控:SESSION_API_IT=1 才运行(globalSetup 负责 compose up --wait / down);
 * 否则整组跳过并输出跳过原因(与 verifier / session-api IT 同一开关)。
 *
 * 本套件承载**真实 PG 路径**的四类断言(单元面无法覆盖的部分):
 *  1. 最小授权面:admin_ro 对五个只读表 SELECT 授权在场;INSERT / UPDATE /
 *     DELETE 授权**全假**;`audit_log` 零授权(安全事件账不可写);
 *  2. 行级租户政策(009):五个表 relrowsecurity / relforcerowsecurity 全真,
 *     且存在 TO admin_ro 的 SELECT 政策;
 *  3. 只读实现的面语义:题目登记列表 / 裁决查询(含 pending 态)/ 成绩导出
 *     三面经 `PostgresAdminReadStore` + 连接层 SET LOCAL 真跑;
 *  4. 租户隔离双层:同租户可见、跨租户零行(RLS 谓词 + 查询层过滤),
 *     且 GUC 缺失时零行(fail-closed)。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { PostgresAdminReadStore } from "../src/persistence/pg-read-store.js";
import { exportHostScores } from "../src/scores/export.js";
import {
  ADMIN_ROLE,
  ADMIN_ROLE_PASSWORD,
  IT_CONFIG,
  IT_ENABLED,
  SKIP_REASON,
  ensureAdminGrants,
  ensureAdminRole,
  ensureMigrated,
  insertSession,
  insertSubmission,
  insertVerdict,
  purgeTenant,
  registerChallenge,
  uniqueIds,
  withRole,
} from "./helpers/it.js";

/** 管理面只读表域(最小授权面;audit_log 刻意不在其中)。 */
const ADMIN_READ_TABLES = [
  "challenges",
  "challenge_versions",
  "sessions",
  "submissions",
  "verdicts",
] as const;

describe.skipIf(!IT_ENABLED)(`管理面 compose 拓扑(${SKIP_REASON})`, () => {
  const idsA = uniqueIds("admin-a");
  const idsB = uniqueIds("admin-b");
  let admin: Pool;
  let readStore: PostgresAdminReadStore;
  let roPool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: IT_CONFIG.postgresUrl });
    await ensureAdminRole(admin);
    await ensureMigrated(admin);
    await ensureAdminGrants(admin);

    readStore = new PostgresAdminReadStore(admin);
    roPool = new Pool({
      connectionString: withRole(IT_CONFIG.postgresUrl, ADMIN_ROLE, ADMIN_ROLE_PASSWORD),
    });

    for (const ids of [idsA, idsB]) {
      await registerChallenge(admin, {
        tenantId: ids.tenantId,
        challengeId: `chal-${ids.tenantId}`,
        contentVersion: "1.0.0",
      });
      await insertSession(admin, {
        tenantId: ids.tenantId,
        sessionId: ids.sessionId,
        challengeId: `chal-${ids.tenantId}`,
        challengeVersion: "1.0.0",
      });
    }
    const submissionA = await insertSubmission(admin, {
      tenantId: idsA.tenantId,
      sessionId: idsA.sessionId,
    });
    await insertVerdict(admin, {
      tenantId: idsA.tenantId,
      submissionId: submissionA,
      verdict: "success",
      detail: { hiddenTestIndex: 3 },
    });
    // 未裁决提交(pending 态来源)。
    await insertSubmission(admin, {
      tenantId: idsA.tenantId,
      sessionId: idsA.sessionId,
      revision: 5,
    });
    const submissionB = await insertSubmission(admin, {
      tenantId: idsB.tenantId,
      sessionId: idsB.sessionId,
    });
    await insertVerdict(admin, {
      tenantId: idsB.tenantId,
      submissionId: submissionB,
      verdict: "wrong_answer",
    });
  }, 120_000);

  afterAll(async () => {
    await purgeTenant(admin, idsA.tenantId);
    await purgeTenant(admin, idsB.tenantId);
    await roPool.end();
    await admin.end();
  });

  it("最小授权面:五个只读表 SELECT 在场,INSERT / UPDATE / DELETE 全假", async () => {
    for (const table of ADMIN_READ_TABLES) {
      const result = await roPool.query<{
        select: boolean;
        insert: boolean;
        update: boolean;
        delete: boolean;
      }>(
        `SELECT has_table_privilege($1, $2, 'SELECT') AS select,
                has_table_privilege($1, $2, 'INSERT') AS insert,
                has_table_privilege($1, $2, 'UPDATE') AS update,
                has_table_privilege($1, $2, 'DELETE') AS delete`,
        [ADMIN_ROLE, table],
      );
      const row = result.rows[0];
      expect(row?.["select"], `${table} SELECT`).toBe(true);
      expect(row?.["insert"], `${table} INSERT`).toBe(false);
      expect(row?.["update"], `${table} UPDATE`).toBe(false);
      expect(row?.["delete"], `${table} DELETE`).toBe(false);
    }
  });

  it("audit_log 零授权(安全事件账不可写,也不可读)", async () => {
    const result = await roPool.query<{
      select: boolean;
      insert: boolean;
      update: boolean;
      delete: boolean;
    }>(
      `SELECT has_table_privilege($1, 'audit_log', 'SELECT') AS select,
              has_table_privilege($1, 'audit_log', 'INSERT') AS insert,
              has_table_privilege($1, 'audit_log', 'UPDATE') AS update,
              has_table_privilege($1, 'audit_log', 'DELETE') AS delete`,
      [ADMIN_ROLE],
    );
    const row = result.rows[0];
    expect(row?.["select"]).toBe(false);
    expect(row?.["insert"]).toBe(false);
    expect(row?.["update"]).toBe(false);
    expect(row?.["delete"]).toBe(false);
    // 误写审计账 = 库层确定性拒绝(D-API-136 的结构性第二重保证)。
    await expect(
      roPool.query(
        `INSERT INTO audit_log (kind, at, tenant_id, user_id) VALUES ('submit', now(), $1, 'admin')`,
        [idsA.tenantId],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("行级租户政策(009):五表 ENABLE + FORCE,且存在 TO admin_ro 的 SELECT 政策", async () => {
    for (const table of ADMIN_READ_TABLES) {
      const result = await admin.query<{
        enabled: boolean;
        forced: boolean;
        policies: string;
      }>(
        `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
                (SELECT count(*) FROM pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = $1
                    AND 'admin_ro' = ANY (p.roles) AND p.cmd = 'SELECT')::text AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = $1`,
        [table],
      );
      expect(result.rows[0]?.["enabled"], `${table} RLS`).toBe(true);
      expect(result.rows[0]?.["forced"], `${table} FORCE RLS`).toBe(true);
      expect(Number(result.rows[0]?.["policies"]), `${table} 政策`).toBeGreaterThan(0);
    }
    // 零非 SELECT 政策(管理面政策面只读)。
    const nonSelect = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_policies
        WHERE 'admin_ro' = ANY (roles) AND cmd <> 'SELECT'`,
    );
    expect(nonSelect.rows[0]?.["count"]).toBe("0");
  });

  it("只读面真跑:题目登记 / 裁决查询(pending + verdicted)/ 成绩导出", async () => {
    const challenges = await readStore.listChallenges({ tenantId: idsA.tenantId, limit: 10 });
    expect(challenges).toHaveLength(1);
    expect(challenges[0]?.challengeId).toBe(`chal-${idsA.tenantId}`);
    expect(challenges[0]?.versions[0]?.contentVersion).toBe("1.0.0");
    expect(challenges[0]?.versions[0]?.registeredAtEpochSeconds).toBeGreaterThan(0);

    const verdicts = await readStore.queryVerdicts({ tenantId: idsA.tenantId, limit: 10 });
    expect(verdicts).toHaveLength(2);
    expect(verdicts.some((row) => row.status === "verdicted" && row.verdict === "success")).toBe(true);
    const pending = verdicts.find((row) => row.status === "pending");
    expect(pending?.verdict).toBeNull();
    expect(pending?.decidedAtEpochSeconds).toBeNull();

    const scores = await exportHostScores({
      store: readStore,
      tenantId: idsA.tenantId,
      limit: 10,
    });
    expect(scores.items).toHaveLength(1);
    expect(scores.nextCursor).toBeNull();
    expect(scores.items[0]?.challengeId).toBe(`chal-${idsA.tenantId}`);
    expect(scores.items[0]?.verdict).toBe("success");
    // detail(私有判题明细)结构性不可达:载荷 JSON 里零命中。
    expect(JSON.stringify(scores)).not.toContain("hiddenTestIndex");
    expect(JSON.stringify(scores)).not.toContain("detail");
  });

  it("租户隔离双层:跨租户零行,且 GUC 缺失时零行(fail-closed)", async () => {
    const otherTenantChallenges = await readStore.listChallenges({
      tenantId: idsB.tenantId,
      limit: 10,
    });
    expect(otherTenantChallenges.map((row) => row.challengeId)).toEqual([`chal-${idsB.tenantId}`]);
    // 查询层过滤:用 A 的租户查 B 的题目 → 零行。
    const crossLookup = await readStore.queryVerdicts({
      tenantId: idsA.tenantId,
      challengeId: `chal-${idsB.tenantId}`,
      limit: 10,
    });
    expect(crossLookup).toEqual([]);
    // RLS 层:不经连接层 SET LOCAL 的直连读 = 零行(GUC 缺失 ⇒ 谓词恒假)。
    const raw = await roPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM verdicts`,
    );
    expect(raw.rows[0]?.["count"]).toBe("0");
    const rawChallenges = await roPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM challenge_versions`,
    );
    expect(rawChallenges.rows[0]?.["count"]).toBe("0");
  });
});

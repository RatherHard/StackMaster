/**
 * 容器门控集成测试:行级租户策略(PG RLS)全表域启用与双层红灯矩阵
 * (阶段六 WP-65,D-API-101)。
 *
 * 行级策略是查询层校验之外的第二道结构闸(阶段六硬门槛):跨租户与
 * "不存在"同形态。本套件以 **session_app / verifier 角色直连 PG**(不经
 * 查询层、不经应用进程)承载行级红灯矩阵:
 *
 *  - 结构闸就位机检:租户作用域九表 + action_log 默认分区
 *    relrowsecurity / relforcerowsecurity 全真(全表域启用,零旁路);
 *  - session_app 直连:跨租户 SELECT / UPDATE / DELETE = 零行(与不存在
 *    同形态),跨租户 INSERT 拒(WITH CHECK),SET LOCAL 缺失 = 零行
 *    (fail-closed);
 *  - 生命周期例外窄面(专用 GUC 承载,无 BYPASSRLS 角色):启动恢复
 *    (app.boot_recovery,D-API-63)/ 保留期清理(app.retention_purge,
 *    D-API-55)/ 审计归档切片(app.audit_archive,D-API-92)逐例外断言
 *    "例外生效 + 不外溢其他命令面";
 *  - 注册表公开读面(challenge_versions / challenges):SELECT 全放行
 *    (公开描述包下发读面 = 全局公开登记值,D-API-76),写面 WITH CHECK
 *    租户绑定;
 *  - verifier 角色(信任域 4):跨租户可读(队列消费设计内)+ 零写越权
 *    (REVOKE 维持)+ rolbypassrls = false(RLS 强制保持,政策按角色分立);
 *  - 应用仓储双层成立:生产 PG 仓储(连接层 SET LOCAL 注入,D-API-101)在
 *    强制 RLS 下同租户读写 / 跨租户同形不存在 / 生命周期入口接线
 *    (保留期清理面以独立 scratch 库隔离实跑,避免共享库的跨套件干扰)。
 *
 * 门控:SESSION_API_IT=1 才运行(globalSetup 负责 compose up --wait / down);
 * 否则整组跳过并输出跳过原因。测试连接上的会话级 set_config 仅属测试
 * probe 形态;应用连接层的逐事务 SET LOCAL 注入由仓储面用例独立承载。
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  PgAuditSink,
  PostgresActionLogStore,
  PostgresSessionRepository,
  PostgresSnapshotStore,
  PostgresSubmissionStore,
  PersistenceError,
  createPostgresPool,
} from "../../src/persistence/index.js";
import {
  IT_ENABLED,
  IT_CONFIG,
  SKIP_REASON,
  createScratchDatabase,
  ensureMigrated,
  uniqueIds,
} from "./helpers/it.js";

/** 租户作用域表域(九表;含 action_log 默认分区 = 直连分区访问的第二道闸)。 */
const TENANT_SCOPED_TABLES = [
  "challenges",
  "challenge_versions",
  "sessions",
  "checkpoints",
  "action_log",
  "action_log_default",
  "submissions",
  "verdicts",
  "verifier_runs",
  "audit_log",
] as const;

const SESSION_APP_URL = withRole(IT_CONFIG.postgresUrl, "session_app", "session-app-dev");
const VERIFIER_URL = withRole(IT_CONFIG.postgresUrl, "verifier", "verifier-dev");

function withRole(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}

/** 角色就绪(幂等执行 compose 角色治理 init;host 拓扑亦生效——角色由本套件确保存在)。 */
async function ensureRoles(admin: Pool): Promise<void> {
  const composeDir = fileURLToPath(new URL("../../compose/", import.meta.url));
  for (const file of ["session-api-db-init.sql", "verifier-db-init.sql"]) {
    const sql = await readFile(`${composeDir}${file}`, "utf8");
    await admin.query(sql);
  }
}

/** 在显式事务内以指定 GUC 执行回调(测试 probe 形态;镜像连接层注入语义)。 */
async function withGuc<T>(
  pool: Pool,
  guc: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config($1, 'on', true)`, [guc]);
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe.skipIf(!IT_ENABLED)(`行级租户策略(PG RLS)双层红灯矩阵(容器门控;${SKIP_REASON})`, () => {
  // 每次运行唯一的租户对(A = 授权租户,B = 越权探测目标租户)。
  const tenantA = uniqueIds("rlsa").tenantId;
  const tenantB = uniqueIds("rlsb").tenantId;
  const sessionA = uniqueIds("rlsa").sessionId;
  const sessionB = uniqueIds("rlsb").sessionId;

  let admin: Pool;
  let sessionApp: Pool; // max=1:probe 连接上的会话级 GUC 与单连接语义绑定
  let verifierRole: Pool;

  beforeAll(async () => {
    admin = await createPostgresPool(IT_CONFIG.postgresUrl, 3);
    await ensureMigrated(admin);
    await ensureRoles(admin);
    // 播种双租户数据(admin 连接 = 超级用户,RLS 旁路属管理面凭证形态,
    // D-API-93 降级登记;行级断言只经角色连接承载)。
    await seedTenant(admin, tenantA, sessionA);
    await seedTenant(admin, tenantB, sessionB);
    sessionApp = await createPostgresPool(SESSION_APP_URL, 1);
    verifierRole = await createPostgresPool(VERIFIER_URL, 2);
  }, 60_000);

  afterAll(async () => {
    await sessionApp.end().catch(() => undefined);
    await verifierRole.end().catch(() => undefined);
    await admin.end();
  });

  // ── 结构闸就位机检:全表域启用,零旁路 ──────────────────────────────

  it("RLS 全表域启用:租户作用域九表 + 默认分区 relrowsecurity / relforcerowsecurity 全真", async () => {
    const result = await admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      [TENANT_SCOPED_TABLES],
    );
    expect(result.rows).toHaveLength(TENANT_SCOPED_TABLES.length);
    for (const row of result.rows) {
      expect(row.relrowsecurity, `${row.relname}.relrowsecurity`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname}.relforcerowsecurity`).toBe(true);
    }
  });

  it("零 BYPASSRLS 角色:session_app / verifier rolbypassrls 全 false(RLS 强制保持)", async () => {
    const result = await admin.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
      `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('session_app', 'verifier')`,
    );
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row.rolbypassrls, `${row.rolname}.rolbypassrls`).toBe(false);
      expect(row.rolsuper, `${row.rolname}.rolsuper`).toBe(false);
    }
  });

  // ── session_app 直连红灯矩阵:跨租户与"不存在"同形态 ─────────────────

  it("跨租户 SELECT = 零行(与不存在同形态):会话/快照/提交/裁决/运行/动作/审计全表域", async () => {
    await asTenant(sessionApp, tenantA);
    // 定向跨租户查询 = 零行(查询层 WHERE + 行级政策双层同形)。
    for (const [table, column] of [
      ["sessions", "session_id"],
      ["checkpoints", "session_id"],
      ["submissions", "session_id"],
      ["verdicts", "tenant_id"],
      ["verifier_runs", "tenant_id"],
      ["action_log", "tenant_id"],
      ["audit_log", "tenant_id"],
    ] as const) {
      const result = await sessionApp.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE ${column} = ANY($1::text[])`,
        [[sessionB, tenantB]],
      );
      expect(Number(result.rows[0]!.n), `跨租户 ${table} 可见性`).toBe(0);
    }
    // 全表扫描亦只见本租户(行级政策独立于查询层 WHERE 生效)。
    const all = await sessionApp.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sessions`,
    );
    const ownOnly = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sessions WHERE tenant_id = $1`,
      [tenantA],
    );
    expect(Number(all.rows[0]!.n)).toBe(Number(ownOnly.rows[0]!.n));
  });

  it("跨租户 UPDATE = 零行(与不存在同形态);跨租户 DELETE = 零行", async () => {
    await asTenant(sessionApp, tenantA);
    const updated = await sessionApp.query(
      `UPDATE sessions SET phase = 'closed' WHERE session_id = $1 AND tenant_id = $2`,
      [sessionB, tenantB],
    );
    expect(updated.rowCount).toBe(0);
    // 跨租户删除 = 零行(同形不存在;checkpoints DELETE 为保留期 sanction 面)。
    const deleted = await sessionApp.query(
      `DELETE FROM checkpoints WHERE session_id = $1 AND tenant_id = $2`,
      [sessionB, tenantB],
    );
    expect(deleted.rowCount).toBe(0);
    // 越权目标行原样存活(未被部分修改)。
    const intact = await admin.query<{ phase: string }>(
      `SELECT phase FROM sessions WHERE session_id = $1`,
      [sessionB],
    );
    expect(intact.rows[0]!.phase).toBe("active");
  });

  it("跨租户 INSERT 拒(WITH CHECK):会话行 tenant_id 与注入租户不符即 RLS 拒绝", async () => {
    await asTenant(sessionApp, tenantA);
    await expect(
      sessionApp.query(
        `INSERT INTO sessions (session_id, tenant_id, user_id, challenge_id, challenge_version, phase, seed_strategy)
         VALUES ($1, $2, 'probe', $3, '1.0.0', 'active', 'fixed')`,
        [`sess-rls-probe-${Math.random().toString(16).slice(2, 8)}`, tenantB, `chal-${sessionB}`],
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it("SET LOCAL 缺失 = 零行(fail-closed):未注入租户上下文的连接零可见(与空库同形态)", async () => {
    // 独立连接(max=1、从未注入 GUC)——current_setting('app.tenant_id', true) = NULL,
    // 政策谓词恒假:RLS 下"未声明租户"的查询零行,不因查询层 WHERE 缺席而泄露。
    const fresh = await createPostgresPool(SESSION_APP_URL, 1);
    try {
      const guc = await fresh.query<{ setting: string | null }>(
        `SELECT current_setting('app.tenant_id', true) AS setting`,
      );
      expect(guc.rows[0]!.setting).toBeNull();
      for (const table of ["sessions", "submissions", "audit_log"] as const) {
        const result = await fresh.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
        expect(Number(result.rows[0]!.n), `fail-closed ${table}`).toBe(0);
      }
      // 写面同向 fail-closed:未注入租户的 INSERT 一律 WITH CHECK 拒。
      await expect(
        fresh.query(
          `INSERT INTO audit_log (kind, at, tenant_id, user_id) VALUES ('create_session', now(), 'x', 'y')`,
        ),
      ).rejects.toThrow(/row-level security policy/i);
    } finally {
      await fresh.end().catch(() => undefined);
    }
  });

  // ── 生命周期例外窄面:专用 GUC 承载,无 BYPASSRLS(逐例外断言生效与不外溢)──

  it("启动恢复例外(app.boot_recovery):事务内跨租户枚举 active 行;例外不外溢 UPDATE / DELETE", async () => {
    const count = await withGuc(sessionApp, "app.boot_recovery", (client) =>
      client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM sessions
         WHERE phase = 'active' AND tenant_id = ANY($1::text[])`,
        [[tenantA, tenantB]],
      ),
    );
    expect(Number(count.rows[0]!.n)).toBe(2);
    // 例外窄面:boot GUC 放行的只有 SELECT——UPDATE / DELETE 不因 boot GUC 越权。
    await withGuc(sessionApp, "app.boot_recovery", async (client) => {
      const updated = await client.query(
        `UPDATE sessions SET phase = 'closed' WHERE tenant_id = $1`,
        [tenantB],
      );
      expect(updated.rowCount).toBe(0);
      const deleted = await client.query(`DELETE FROM sessions WHERE tenant_id = $1`, [tenantB]);
      expect(deleted.rowCount).toBe(0);
    });
  });

  it("boot GUC 仅事务内生效(SET LOCAL):事务提交后恢复零可见(fail-closed)", async () => {
    const client = await sessionApp.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.boot_recovery', 'on', true)`);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const after = await sessionApp.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sessions WHERE tenant_id = $1`,
      [tenantB],
    );
    expect(Number(after.rows[0]!.n)).toBe(0);
  });

  it("保留期清理例外(app.retention_purge):租户枚举读跨租户生效;DELETE 永不跨租户(零跨租户 DELETE 政策行)", async () => {
    // 枚举读(唯一跨租户面):purge GUC 下枚举到本套件双租户的待清理租户。
    const tenants = await withGuc(sessionApp, "app.retention_purge", (client) =>
      client.query<{ tenant_id: string }>(
        `SELECT DISTINCT tenant_id FROM sessions
         WHERE phase IN ('closed', 'crashed') AND updated_at <= now() AND session_id LIKE 'sess-it-rls%'
         ORDER BY tenant_id`,
      ),
    );
    expect(
      tenants.rows.map((row) => row.tenant_id),
      "purge GUC 下枚举须包含本套件双租户(共享库含既有运行残留租户)",
    ).toEqual(expect.arrayContaining([tenantA, tenantB]));
    // 跨租户 DELETE 恒零行:仅有 purge GUC(无租户上下文)时 DELETE 零行
    // (RLS 对 DELETE 施加 SELECT 可见 + DELETE 政策双重谓词;清理删除逐租户
    // 注入执行,连接层两段式,D-API-101)。全新连接 = 零会话级租户残留
    // (共享 probe 连接承载前序用例的会话级 GUC,不可作零态探针)。
    const fresh = await createPostgresPool(SESSION_APP_URL, 1);
    try {
      const crossPurge = await withGuc(fresh, "app.retention_purge", (client) =>
        client.query(
          `DELETE FROM sessions
           WHERE phase IN ('closed', 'crashed') AND updated_at <= now() AND session_id LIKE 'sess-it-rls%'`,
        ),
      );
      expect(crossPurge.rowCount).toBe(0);
      // 越权目标行原样存活(未被部分删除)。
      const intact = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM sessions
         WHERE phase IN ('closed', 'crashed') AND session_id LIKE 'sess-it-rls%'`,
      );
      expect(Number(intact.rows[0]!.n)).toBeGreaterThanOrEqual(2);
    } finally {
      await fresh.end().catch(() => undefined);
    }
  });

  it("审计归档例外(app.audit_archive):切片读跨租户可见;未设 = 零行(安全账读面收敛)", async () => {
    await asTenant(sessionApp, tenantA);
    const denied = await sessionApp.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE tenant_id = $1`,
      [tenantB],
    );
    expect(Number(denied.rows[0]!.n)).toBe(0);
    const archived = await withGuc(sessionApp, "app.audit_archive", (client) =>
      client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_log WHERE tenant_id = $1`,
        [tenantB],
      ),
    );
    expect(Number(archived.rows[0]!.n)).toBe(1);
  });

  // ── 注册表公开读面(政策形态论证锚,D-API-76)+ 写面租户绑定 ──────────

  it("challenge_versions 读面全局公开(登记读面):无租户上下文亦可见;写面 WITH CHECK 租户绑定", async () => {
    // 无 GUC 连接:公开登记值(双包摘要 / 对象名 / 签名)跨租户可见。
    const fresh = await createPostgresPool(SESSION_APP_URL, 1);
    try {
      const all = await fresh.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM challenge_versions WHERE tenant_id = ANY($1::text[])`,
        [[tenantA, tenantB]],
      );
      expect(Number(all.rows[0]!.n)).toBe(2);
    } finally {
      await fresh.end().catch(() => undefined);
    }
    // 写面正向先行(行 tenant_id 与注入租户相符 → 受理)。注:探测连接的
    // 会话级 GUC 在"语句失败"后不可依赖(pg pool 对出错连接做丢弃重建,
    // 新连接零会话态)——这正是应用注入面采用"持有连接 + 事务内 SET LOCAL"
    // 的实现理由;负面断言置于本用例末尾,失败后不再依赖注入态。
    await asTenant(sessionApp, tenantA);
    const ownChallenge = `chal-rls-own-${Math.random().toString(16).slice(2, 8)}`;
    await sessionApp.query(
      `INSERT INTO challenges (challenge_id, tenant_id, title) VALUES ($1, $2, 'probe')`,
      [ownChallenge, tenantA],
    );
    await sessionApp.query(
      `INSERT INTO challenge_versions (
         tenant_id, challenge_id, content_version, vm_profile_version,
         private_bundle_sha256, public_descriptor_sha256,
         private_bundle_object, public_descriptor_object, signature, signer_key_id
       ) VALUES ($1, $2, '1.0.0', '1.0.0', repeat('a', 64), repeat('b', 64), 'p', 'd', 'sig', 'default')`,
      [tenantA, ownChallenge],
    );
    // 写面负面:行 tenant_id 与注入租户不符 → WITH CHECK 拒(挑战行取 B 的
    // 既有 id,外键满足、拒绝唯一变量 = 政策而非完整性)。
    await expect(
      sessionApp.query(
        `INSERT INTO challenge_versions (
           tenant_id, challenge_id, content_version, vm_profile_version,
           private_bundle_sha256, public_descriptor_sha256,
           private_bundle_object, public_descriptor_object, signature, signer_key_id
         ) VALUES ($1, $2, '9.9.9', '1.0.0', repeat('a', 64), repeat('b', 64), 'p', 'd', 'sig', 'default')`,
        [tenantB, `chal-${sessionB}`],
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  // ── verifier 角色(信任域 4):跨租户可读(设计内)+ 零写越权(REVOKE 维持)──

  it("verifier 跨租户可读(信任域 4 队列消费设计内):无租户上下文枚举裁决域全量", async () => {
    // verifier 不注入 app.tenant_id:政策 TO verifier USING (true) 按角色放行
    // (RLS 强制保持——非 BYPASSRLS 旁路;跨租户 = 信任域 4 队列消费语义)。
    for (const table of ["submissions", "verifier_runs", "verdicts"] as const) {
      const result = await verifierRole.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE tenant_id = ANY($1::text[])`,
        [[tenantA, tenantB]],
      );
      expect(Number(result.rows[0]!.n), `verifier 跨租户读 ${table}`).toBe(2);
    }
    // 注册表读面(challenges / challenge_versions):前序用例可能已为本租户
    // 追加登记行——断言锚 = 双租户行均跨租户可见(每租户 ≥ 1)。
    const versions = await verifierRole.query<{ tenant_id: string; n: string }>(
      `SELECT tenant_id, count(*)::text AS n FROM challenge_versions
       WHERE tenant_id = ANY($1::text[]) GROUP BY tenant_id`,
      [[tenantA, tenantB]],
    );
    const byTenant = Object.fromEntries(versions.rows.map((row) => [row.tenant_id, Number(row.n)]));
    expect(byTenant[tenantA]).toBeGreaterThanOrEqual(1);
    expect(byTenant[tenantB]).toBe(1);
  });

  it("verifier 零写越权(REVOKE 维持):submissions 写面拒、verdicts / audit_log 零 UPDATE DELETE;合法写面受理", async () => {
    // 队列消费的合法写面:verifier_runs 状态机推进 + 审计发射(裁决域三值)。
    await verifierRole.query(
      `UPDATE verifier_runs SET status = 'running', started_at = now()
       WHERE tenant_id = $1 AND status = 'pending'`,
      [tenantA],
    );
    await verifierRole.query(
      `INSERT INTO audit_log (kind, at, tenant_id, user_id, detail)
       VALUES ('verdict_completed', now(), $1, 'verifier', '{"probe":true}'::jsonb)`,
      [tenantA],
    );
    // 写越权:submissions 零 INSERT / 零 UPDATE(REVOKE 维持;政策放行不等于授权)。
    await expect(
      verifierRole.query(
        `INSERT INTO submissions (tenant_id, session_id, revision, public_status, reference)
         VALUES ($1, 'sess-probe', 1, 'running', '{}'::jsonb)`,
        [tenantA],
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      verifierRole.query(`UPDATE submissions SET public_status = 'won' WHERE tenant_id = $1`, [tenantA]),
    ).rejects.toThrow(/permission denied/i);
    // verdicts 零 UPDATE / 零 DELETE(裁决落库幂等,无改写面)。
    await expect(
      verifierRole.query(`UPDATE verdicts SET verdict = 'success' WHERE tenant_id = $1`, [tenantA]),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      verifierRole.query(`DELETE FROM verdicts WHERE tenant_id = $1`, [tenantA]),
    ).rejects.toThrow(/permission denied/i);
    // audit_log 零 UPDATE / 零 DELETE(append-only,D-API-93 双层)。
    await expect(
      verifierRole.query(`UPDATE audit_log SET user_id = 'x' WHERE tenant_id = $1`, [tenantA]),
    ).rejects.toThrow(/permission denied|append-only/i);
    await expect(
      verifierRole.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [tenantA]),
    ).rejects.toThrow(/permission denied|append-only/i);
  });

  // ── 应用仓储双层成立:连接层 SET LOCAL 注入(D-API-101)在强制 RLS 下运行 ──

  it("生产仓储(连接层注入)在强制 RLS 下:同租户读写、跨租户同形不存在(双层并存)", async () => {
    const sessions = new PostgresSessionRepository(sessionApp);
    const rows = await sessions.listSessionsByTenant(tenantA);
    expect(rows.map((row) => row.sessionId)).toContain(sessionA);
    // 同租户定位 = 行;跨租户定位 = null(查询层 WHERE 与行级政策双层同形)。
    const own = await sessions.findSession(sessionA, tenantA);
    expect(own).not.toBeNull();
    const cross = await sessions.findSession(sessionB, tenantA);
    expect(cross).toBeNull();
    // 租户绑定枚举:GUC = tenantA 时,B 的行不入列(注入租户即可见域)。
    const ownList = await sessions.listSessionsByTenant(tenantA);
    expect(ownList.some((row) => row.sessionId === sessionB)).toBe(false);
    expect(ownList.some((row) => row.sessionId === sessionA)).toBe(true);
    // 跨租户 phase 推进 = session_not_found(0 行更新与不存在同形)。
    await expect(
      sessions.updateSessionPhase(sessionB, tenantA, "closed"),
    ).rejects.toThrow(PersistenceError);
    // 同租户 phase 推进受理(双层并存,零查询回退)。
    await sessions.updateSessionPhase(sessionA, tenantA, "closed");
    await sessions.updateSessionPhase(sessionA, tenantA, "active");
  });

  it("启动恢复枚举经 boot GUC 注入(D-API-63 查询层例外;行级同例外面承载)", async () => {
    const sessions = new PostgresSessionRepository(sessionApp);
    const actives = await sessions.listActiveSessions();
    // 双租户 active 行均可枚举(启动恢复 = 进程生命周期操作;注入面经
    // lifecycleQuery 设 app.boot_recovery,app.tenant_id 保持缺失)。
    const ids = actives.map((row) => row.sessionId);
    expect(ids).toContain(sessionA);
    expect(ids).toContain(sessionB);
  });

  it("快照仓储双层:同租户 save/latest;跨租户 latest = null(与不存在同形)", async () => {
    const snapshots = new PostgresSnapshotStore(sessionApp);
    const saved = await snapshots.save({
      tenantId: tenantA,
      sessionId: sessionA,
      origin: "explicit_checkpoint",
      revision: 1,
      ciphertext: new Uint8Array([1, 2, 3]),
    });
    expect(saved.tenantId).toBe(tenantA);
    const own = await snapshots.latest(sessionA, tenantA);
    expect(own).not.toBeNull();
    const cross = await snapshots.latest(sessionB, tenantA);
    expect(cross).toBeNull();
  });

  it("提交与裁决域仓储双层:入队同锚事务受理;verdict 定位链第二环租户绑定", async () => {
    const submissions = new PostgresSubmissionStore(sessionApp);
    const recorded = await submissions.record({
      tenantId: tenantA,
      sessionId: sessionA,
      revision: 7,
      publicStatus: "running",
      reference: { probe: true },
      logDigest: "a".repeat(64),
    });
    expect(recorded.sessionId).toBe(sessionA);
    // 定位链第一环(三条件)与第二环(行级租户绑定)双层:
    const submission = await submissions.findSubmissionForVerdict(recorded.id, tenantA, sessionA);
    expect(submission).not.toBeNull();
    await admin.query(
      `INSERT INTO verdicts (tenant_id, submission_id, verdict, detail)
       VALUES ($1, $2, 'success', NULL)`,
      [tenantA, recorded.id],
    );
    const ownVerdict = await submissions.findVerdictBySubmissionId(recorded.id, tenantA);
    expect(ownVerdict?.verdict).toBe("success");
    // 跨租户 verdict 读取 = null(与未落库同形态——第二环租户绑定,RLS 同形)。
    const crossVerdict = await submissions.findVerdictBySubmissionId(recorded.id, tenantB);
    expect(crossVerdict).toBeNull();
  });

  it("动作日志与审计落库仓储双层:同租户 append / 查询受理(注入面)", async () => {
    const actionLog = new PostgresActionLogStore(sessionApp);
    await actionLog.append([
      {
        sessionId: sessionA,
        tenantId: tenantA,
        clientSeq: 2,
        revisionAfter: 2,
        action: { type: "write_bytes" },
        submissionRef: null,
      },
    ]);
    const entries = await actionLog.listBySession(sessionA, tenantA);
    expect(entries.length).toBe(2); // 播种 1 + 注入面 append 1
    const cross = await actionLog.countBySession(sessionB, tenantA);
    expect(cross).toBe(0);
    const audit = new PgAuditSink(sessionApp);
    await audit.append({
      kind: "submit",
      at: Date.now(),
      actor: { tenantId: tenantA, userId: "probe" },
      sessionId: sessionA,
      detail: { probe: true },
    });
  });

  // ── 保留期清理入口(生产仓储)经 retention GUC:独立 scratch 库隔离实跑 ──
  // (清理面为全库谓词,共享库上运行会触碰其他套件数据;scratch 库承载
  // 注入面 + 政策例外的端到端断言,zero 干扰。)

  it("保留期清理入口(连接层注入)在强制 RLS 下清理双租户过期行(端到端)", async () => {
    const scratch = await createScratchDatabase();
    try {
      const scratchAdmin = await createPostgresPool(scratch.url, 2);
      try {
        await ensureMigrated(scratchAdmin);
        await ensureRoles(scratchAdmin);
        const t1 = uniqueIds("rlsp1");
        const t2 = uniqueIds("rlsp2");
        await seedTenant(scratchAdmin, t1.tenantId, t1.sessionId);
        await seedTenant(scratchAdmin, t2.tenantId, t2.sessionId);
        const sessionAppScratch = await createPostgresPool(withRole(scratch.url, "session_app", "session-app-dev"), 1);
        try {
          const sessions = new PostgresSessionRepository(sessionAppScratch);
          const snapshots = new PostgresSnapshotStore(sessionAppScratch);
          // 保留期清理(sanction 删除路径)经注入面受理:0 天保留期清理
          // 双租户回填的过期终态行与过期快照行。
          const purgedSessions = await sessions.purgeTerminalSessionsBefore(new Date().toISOString());
          expect(purgedSessions).toBe(2);
          const purgedSnapshots = await snapshots.purgeExpired(0);
          expect(purgedSnapshots).toBe(2);
          // active 行不受影响(保留期只收敛终态行,D-API-55)。
          const remaining = await sessions.listActiveSessions();
          expect(remaining).toHaveLength(2);
        } finally {
          await sessionAppScratch.end().catch(() => undefined);
        }
      } finally {
        await scratchAdmin.end().catch(() => undefined);
      }
    } finally {
      await scratch.drop();
    }
  }, 60_000);
});

/** probe 连接上的会话级租户上下文(测试专用;应用连接层经 SET LOCAL 逐事务注入)。 */
async function asTenant(pool: Pool, tenantId: string): Promise<void> {
  await pool.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
}

/** 双租户播种(admin 超级用户;行级断言只经角色连接承载)。 */
async function seedTenant(pool: Pool, tenantId: string, sessionId: string): Promise<void> {
  const challengeId = `chal-${sessionId}`;
  await pool.query(
    `INSERT INTO challenges (challenge_id, tenant_id, title) VALUES ($1, $2, 'probe')`,
    [challengeId, tenantId],
  );
  await pool.query(
    `INSERT INTO challenge_versions (
       tenant_id, challenge_id, content_version, vm_profile_version,
       private_bundle_sha256, public_descriptor_sha256,
       private_bundle_object, public_descriptor_object, signature, signer_key_id
     ) VALUES ($1, $2, '1.0.0', '1.0.0', repeat('a', 64), repeat('b', 64), 'p', 'd', 'sig', 'default')`,
    [tenantId, challengeId],
  );
  await pool.query(
    `INSERT INTO sessions (session_id, tenant_id, user_id, challenge_id, challenge_version, phase, seed_strategy)
     VALUES ($1, $2, 'user-probe', $3, '1.0.0', 'active', 'fixed')`,
    [sessionId, tenantId, challengeId],
  );
  // 保留期清理断言面:回填时刻的终态行(closed)。
  await pool.query(
    `INSERT INTO sessions (session_id, tenant_id, user_id, challenge_id, challenge_version, phase, seed_strategy, updated_at)
     VALUES ($1, $2, 'user-probe', $3, '1.0.0', 'closed', 'fixed', now() - interval '2 days')`,
    [`${sessionId}-expired`, tenantId, challengeId],
  );
  // 回填过期快照(保留期清理断言面)。
  await pool.query(
    `INSERT INTO checkpoints (tenant_id, session_id, checkpoint_id, origin, revision, ciphertext, byte_size, created_at)
     VALUES ($1, $2, NULL, 'auto_periodic', 1, '\\x00', 1, now() - interval '2 days')`,
    [tenantId, sessionId],
  );
  await pool.query(
    `INSERT INTO submissions (tenant_id, session_id, revision, public_status, reference)
     VALUES ($1, $2, 1, 'running', '{"probe":true}'::jsonb)`,
    [tenantId, sessionId],
  );
  await pool.query(
    `INSERT INTO verifier_runs (tenant_id, submission_id, status, log_digest)
     SELECT tenant_id, id, 'pending', repeat('c', 64) FROM submissions
     WHERE tenant_id = $1 AND session_id = $2`,
    [tenantId, sessionId],
  );
  await pool.query(
    `INSERT INTO verdicts (tenant_id, submission_id, verdict)
     SELECT tenant_id, id, 'wrong_answer' FROM submissions
     WHERE tenant_id = $1 AND session_id = $2`,
    [tenantId, sessionId],
  );
  await pool.query(
    `INSERT INTO action_log (tenant_id, session_id, client_seq, revision_after, action)
     VALUES ($1, $2, 1, 1, '{"type":"step"}'::jsonb)`,
    [tenantId, sessionId],
  );
  await pool.query(
    `INSERT INTO audit_log (kind, at, tenant_id, user_id, session_id, detail)
     VALUES ('create_session', now(), $1, 'user-probe', $2, '{"probe":true}'::jsonb)`,
    [tenantId, sessionId],
  );
}

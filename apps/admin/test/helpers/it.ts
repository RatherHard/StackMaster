/**
 * admin 容器门控集成测试共享设施(D-MP-5 分支 A)。
 *
 * 纪律与 verifier `test/helpers/it.ts` 同款:`SESSION_API_IT !== "1"` 时全部
 * 集成测试跳过(globalSetup 也不做任何 Docker 操作);开启时假定
 * compose/deps.yaml 依赖服务已就绪(globalSetup 或
 * `pnpm --filter @stackmaster/session-api compose:deps:up` 负责 up --wait)。
 *
 * 与 session-api 源码零依赖(信任域测试设施边界):
 *  - 迁移集直接从 `apps/session-api/migrations` 目录按文件序执行(幂等形态);
 *  - 授权脚本直接从 `apps/session-api/compose/admin-db-init.sql` 执行
 *    (compose 一次性 init 服务的同一份文件,零第二实现)。
 *
 * ── 角色引导的**待应用**依赖(如实登记)────────────────────────────────
 * `admin_ro` 的 `CREATE ROLE` 语句归属 `compose/db-roles-init.sql`(角色创建
 * 的唯一来源),本 WP 未被授权编辑该文件(并发占用),故测试侧在引导阶段
 * **自行创建该角色**(与待应用片段逐字同形),使 009 迁移与最小授权断言
 * 可以在本 WP 内真实跑起来。主控应用片段后,本引导成为幂等无操作。
 */
import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

/** 环境门控(与 session-api / verifier IT 同一开关)。 */
export const IT_ENABLED = process.env["SESSION_API_IT"] === "1";

export const SKIP_REASON =
  "跳过原因:SESSION_API_IT != 1(admin 容器门控集成测试仅在 SESSION_API_IT=1 且 compose 依赖服务就绪时运行;" +
  "入口 pnpm --filter @stackmaster/admin test:integration)";

/** 集成测试端点(与 compose/deps.yaml 一致;env 缺省时取 compose 本地值)。 */
export const IT_CONFIG = {
  postgresUrl:
    process.env["ADMIN_POSTGRES_URL"] ??
    "postgres://stackmaster:stackmaster-dev@127.0.0.1:15432/session_api",
  credentialSha256:
    process.env["ADMIN_CREDENTIAL_SHA256"] ??
    "0000000000000000000000000000000000000000000000000000000000000000",
  tenants: (process.env["ADMIN_TENANTS"] ?? "").split(",").filter((value) => value !== ""),
};

/** 管理面只读角色(独立凭证;待应用片段 = compose/db-roles-init.sql)。 */
export const ADMIN_ROLE = "admin_ro";
export const ADMIN_ROLE_PASSWORD = "admin-ro-dev";

/** 只读角色的待应用 CREATE ROLE 片段(与报告中的片段逐字同形)。 */
export const ADMIN_ROLE_BOOTSTRAP_SQL = `DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${ADMIN_ROLE}') THEN
    CREATE ROLE ${ADMIN_ROLE} LOGIN PASSWORD '${ADMIN_ROLE_PASSWORD}';
  END IF;
END
$$;`;

/** 迁移目录(apps/session-api/migrations)。 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../session-api/migrations/", import.meta.url));

/** 管理面授权脚本(apps/session-api/compose/admin-db-init.sql)。 */
const ADMIN_DB_INIT_SQL = fileURLToPath(
  new URL("../../../session-api/compose/admin-db-init.sql", import.meta.url),
);

/** 幂等应用迁移(文件序执行;测试库上重复执行安全)。 */
export async function ensureMigrated(pool: Pool): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(`${MIGRATIONS_DIR}${file}`, "utf8");
    await pool.query(sql);
  }
}

/** 幂等引导只读角色(管理员连接;待应用片段同形)。 */
export async function ensureAdminRole(pool: Pool): Promise<void> {
  await pool.query(ADMIN_ROLE_BOOTSTRAP_SQL);
}

/** 幂等应用管理面最小授权脚本(compose 一次性 init 的同一份文件)。 */
export async function ensureAdminGrants(pool: Pool): Promise<void> {
  const sql = await readFile(ADMIN_DB_INIT_SQL, "utf8");
  await pool.query(sql);
}

/** 以指定角色拼连接串(独立凭证面断言用)。 */
export function withRole(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}

/** 隔离测试数据:每套件唯一租户 / 会话前缀(对残留数据免疫)。 */
export function uniqueIds(prefix: string): { tenantId: string; sessionId: string } {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  return { tenantId: `it-${prefix}-${suffix}`, sessionId: `sess-it-${prefix}-${suffix}` };
}

/** 登记一个题目 + 一个版本行(公开登记值;裁决面关联用)。 */
export async function registerChallenge(
  pool: Pool,
  input: {
    tenantId: string;
    challengeId: string;
    contentVersion: string;
    title?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO challenges (challenge_id, tenant_id, title) VALUES ($1, $2, $3)
     ON CONFLICT (challenge_id) DO NOTHING`,
    [input.challengeId, input.tenantId, input.title ?? "admin IT"],
  );
  await pool.query(
    `INSERT INTO challenge_versions (
       tenant_id, challenge_id, content_version, vm_profile_version,
       private_bundle_sha256, public_descriptor_sha256,
       private_bundle_object, public_descriptor_object, signature
     ) VALUES ($1, $2, $3, '1.0.0', $4, $5, $6, $7, 'it-synthetic-signature')
     ON CONFLICT (challenge_id, content_version) DO NOTHING`,
    [
      input.tenantId,
      input.challengeId,
      input.contentVersion,
      "a".repeat(64),
      "b".repeat(64),
      `${input.challengeId}/${input.contentVersion}/bundle.json`,
      `${input.challengeId}/${input.contentVersion}/descriptor.json`,
    ],
  );
}

/** 插入会话行(成绩 / 裁决的题目标识来源)。 */
export async function insertSession(
  pool: Pool,
  input: {
    tenantId: string;
    sessionId: string;
    challengeId: string;
    challengeVersion: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (
       session_id, tenant_id, user_id, challenge_id, challenge_version,
       phase, seed_strategy, latest_revision
     ) VALUES ($1, $2, $3, $4, $5, 'active', 'fixed', 0)
     ON CONFLICT (session_id) DO NOTHING`,
    [
      input.sessionId,
      input.tenantId,
      `user-${input.sessionId}`,
      input.challengeId,
      input.challengeVersion,
    ],
  );
}

/** 插入提交行(返回 id)。 */
export async function insertSubmission(
  pool: Pool,
  input: {
    tenantId: string;
    sessionId: string;
    revision?: number;
    reference?: unknown;
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO submissions (tenant_id, session_id, revision, public_status, reference)
     VALUES ($1, $2, $3, 'won', $4::jsonb) RETURNING id`,
    [
      input.tenantId,
      input.sessionId,
      input.revision ?? 3,
      JSON.stringify(input.reference ?? { form: "stackmaster-session-submit/1" }),
    ],
  );
  return result.rows[0]?.["id"] ?? "";
}

/** 插入裁决行(返回 id;成绩游标值)。 */
export async function insertVerdict(
  pool: Pool,
  input: { tenantId: string; submissionId: string; verdict: string; detail?: unknown },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO verdicts (tenant_id, submission_id, verdict, detail)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [input.tenantId, input.submissionId, input.verdict, JSON.stringify(input.detail ?? null)],
  );
  return result.rows[0]?.["id"] ?? "";
}

/** 按套件清理本套件创建的数据(子表先删;RLS 对管理面凭证无效——用管理连接)。 */
export async function purgeTenant(pool: Pool, tenantId: string): Promise<void> {
  await pool.query(`DELETE FROM verdicts WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM verifier_runs WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM submissions WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM sessions WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM challenge_versions WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM challenges WHERE tenant_id = $1`, [tenantId]);
}

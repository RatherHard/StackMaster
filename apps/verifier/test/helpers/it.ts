/**
 * verifier 容器门控集成测试共享设施(WP-61)。
 *
 * 纪律与会话编排 test/persistence/helpers/it.ts 同款:SESSION_API_IT !== "1"
 * 时全部集成测试跳过(globalSetup 也不做任何 Docker 操作);开启时假定
 * compose/deps.yaml 依赖服务已就绪(globalSetup 或
 * `pnpm --filter @stackmaster/session-api compose:deps:up` 负责 up --wait)。
 *
 * 迁移应用:verifier 复用 session-api 的迁移集(001~005;裁决域两表与
 * submissions / challenge_versions 是 verifier 的只读 / 写入面)。测试侧
 * 顺序执行 SQL 文件即幂等(全部 IF NOT EXISTS 形态),不引入对 session-api
 * 源码的跨应用依赖(信任域测试设施边界)。
 */
import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

/** 环境门控(与会话编排 IT 同一开关:根级覆盖率 IT 形态一份门控两包生效)。 */
export const IT_ENABLED = process.env["SESSION_API_IT"] === "1";

export const SKIP_REASON =
  "跳过原因:SESSION_API_IT != 1(verifier 容器门控集成测试仅在 SESSION_API_IT=1 且 compose 依赖服务就绪时运行;" +
  "入口 pnpm --filter @stackmaster/verifier test:integration)";

/** 集成测试端点(与 compose/deps.yaml 一致;env 缺省时取 compose 本地值)。 */
export const IT_CONFIG = {
  postgresUrl:
    process.env["VERIFIER_POSTGRES_URL"] ??
    "postgres://stackmaster:stackmaster-dev@127.0.0.1:15432/session_api",
  minioEndpoint: process.env["VERIFIER_MINIO_ENDPOINT"] ?? "127.0.0.1",
  minioPort: Number(process.env["VERIFIER_MINIO_PORT"] ?? "19000"),
  minioAccessKey: process.env["VERIFIER_MINIO_ACCESS_KEY"] ?? "stackmaster-dev",
  minioSecretKey: process.env["VERIFIER_MINIO_SECRET_KEY"] ?? "stackmaster-dev-secret",
  minioBucketPrivate: process.env["VERIFIER_MINIO_BUCKET_PRIVATE"] ?? "private-bundles",
  minioBucketPublic: process.env["VERIFIER_MINIO_BUCKET_PUBLIC"] ?? "public-descriptors",
};

/** 迁移目录(apps/session-api/migrations;verifier 消费面 001~005)。 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../session-api/migrations/", import.meta.url));

/** 幂等应用迁移(文件序执行;测试库上重复执行安全)。 */
export async function ensureMigrated(pool: Pool): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(`${MIGRATIONS_DIR}${file}`, "utf8");
    await pool.query(sql);
  }
}

/** 隔离测试数据:每套件唯一租户 / 会话前缀(对残留数据免疫)。 */
export function uniqueIds(prefix: string): { tenantId: string; sessionId: string } {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  return { tenantId: `it-${prefix}-${suffix}`, sessionId: `sess-it-${prefix}-${suffix}` };
}

/** 登记一个题目版本行(返回签名基线所需的摘要;对象名由调用方落桶后传入)。 */
export async function registerChallengeVersion(
  pool: Pool,
  input: {
    tenantId: string;
    challengeId: string;
    contentVersion: string;
    privateBundleSha256: string;
    publicDescriptorSha256: string;
    privateBundleObject: string;
    publicDescriptorObject: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO challenges (challenge_id, tenant_id, title) VALUES ($1, $2, $3)
     ON CONFLICT (challenge_id) DO NOTHING`,
    [input.challengeId, input.tenantId, "verifier IT"],
  );
  await pool.query(
    `INSERT INTO challenge_versions (
       tenant_id, challenge_id, content_version, vm_profile_version,
       private_bundle_sha256, public_descriptor_sha256,
       private_bundle_object, public_descriptor_object, signature
     ) VALUES ($1, $2, $3, '1.0.0', $4, $5, $6, $7, 'it-synthetic-signature')`,
    [
      input.tenantId,
      input.challengeId,
      input.contentVersion,
      input.privateBundleSha256,
      input.publicDescriptorSha256,
      input.privateBundleObject,
      input.publicDescriptorObject,
    ],
  );
}

/** 插入一条 submission(内部裁决引用形态;返回 id)。 */
export async function insertSubmission(
  pool: Pool,
  input: { tenantId: string; sessionId: string; reference: unknown },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO submissions (tenant_id, session_id, revision, public_status, reference)
     VALUES ($1, $2, 3, 'won', $3::jsonb) RETURNING id`,
    [input.tenantId, input.sessionId, JSON.stringify(input.reference)],
  );
  return result.rows[0]?.["id"] ?? "";
}

/** 插入一条 verifier run(裁决队列行;返回 id)。 */
export async function insertRun(
  pool: Pool,
  input: {
    tenantId: string;
    submissionId: string;
    status?: "pending" | "running" | "completed" | "failed";
    logDigest?: string | null;
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO verifier_runs (tenant_id, submission_id, status, log_digest)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.tenantId, input.submissionId, input.status ?? "pending", input.logDigest ?? null],
  );
  return result.rows[0]?.["id"] ?? "";
}

/** 按套件清理本套件创建的裁决域数据(子表先删;verdicts / runs 以 FK 关联)。 */
export async function purgeSubmissions(pool: Pool, tenantId: string): Promise<void> {
  await pool.query(`DELETE FROM verdicts WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM verifier_runs WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM submissions WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM challenge_versions WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM challenges WHERE tenant_id = $1`, [tenantId]);
}

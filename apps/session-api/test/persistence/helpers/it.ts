/**
 * 容器门控集成测试共享设施(WP-3)。
 *
 * 纪律:SESSION_API_IT !== "1" 时全部集成测试跳过(vitest globalSetup 也不
 * 做任何 Docker 操作);开启时假定 compose/deps.yaml 依赖服务已就绪
 * (test:integration 脚本或 globalSetup 负责 up --wait)。
 */

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { loadMigrationsFromDir, runMigrations } from "../../../src/persistence/index.js";

/** 环境门控(完成标准:环境门控才连真实容器,否则 skip 并输出原因)。 */
export const IT_ENABLED = process.env["SESSION_API_IT"] === "1";

export const SKIP_REASON =
  "跳过原因:SESSION_API_IT != 1(容器门控集成测试仅 在 SESSION_API_IT=1 且 compose 依赖服务就绪时运行;" +
  "入口 pnpm --filter @stackmaster/session-api test:integration)";

/** 集成测试端点(与 compose/deps.yaml 一致;env 缺省时取 compose 本地值)。 */
export const IT_CONFIG = {
  postgresUrl:
    process.env["SESSION_API_POSTGRES_URL"] ??
    "postgres://stackmaster:stackmaster-dev@127.0.0.1:15432/session_api",
  redisUrl: process.env["SESSION_API_REDIS_URL"] ?? "redis://127.0.0.1:16379/0",
  minioEndpoint: process.env["SESSION_API_MINIO_ENDPOINT"] ?? "127.0.0.1",
  minioPort: Number(process.env["SESSION_API_MINIO_PORT"] ?? "19000"),
  minioAccessKey: process.env["SESSION_API_MINIO_ACCESS_KEY"] ?? "stackmaster-dev",
  minioSecretKey: process.env["SESSION_API_MINIO_SECRET_KEY"] ?? "stackmaster-dev-secret",
  minioBucketPrivate: process.env["SESSION_API_MINIO_BUCKET_PRIVATE"] ?? "private-bundles",
  minioBucketPublic: process.env["SESSION_API_MINIO_BUCKET_PUBLIC"] ?? "public-descriptors",
  // 测试专用合成密钥(base64 的 32 字节;与 compose/integration.env 同值)。
  snapshotEncryptionKey:
    process.env["SESSION_API_SNAPSHOT_ENCRYPTION_KEY"] ?? "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
};

/** 迁移目录(apps/session-api/migrations)。 */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/", import.meta.url));

/** 幂等执行迁移(多套件并发安全:runner 内部有咨询锁 + 记录表)。 */
export async function ensureMigrated(pool: Pool): Promise<void> {
  const migrations = await loadMigrationsFromDir(MIGRATIONS_DIR);
  await runMigrations(pool, migrations);
}

/** 隔离测试数据:每套件唯一租户 / 会话前缀(对残留数据免疫)。 */
export function uniqueIds(prefix: string): { tenantId: string; sessionId: string } {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  return { tenantId: `it-${prefix}-${suffix}`, sessionId: `sess-it-${prefix}-${suffix}` };
}

/**
 * 建独立数据库(迁移可重放测试用):从连接串派生管理连接,创建随机命名
 * 库,测试后整体 drop——迁移断言不受其他套件已应用状态影响。
 */
export async function createScratchDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const adminUrl = new URL(IT_CONFIG.postgresUrl);
  adminUrl.pathname = "/postgres";
  const dbName = `session_api_it_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const { Pool } = await import("pg");
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 2 });
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  const url = new URL(IT_CONFIG.postgresUrl);
  url.pathname = `/${dbName}`;
  return {
    url: url.toString(),
    drop: async () => {
      const cleanup = new Pool({ connectionString: adminUrl.toString(), max: 2 });
      await cleanup.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

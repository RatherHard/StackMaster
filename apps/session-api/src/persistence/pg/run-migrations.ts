/**
 * 最小迁移 runner(WP-3;完成标准:迁移脚本可重放,重复执行幂等)。
 *
 * 机制:
 *  - 已应用记录表 `_session_api_migrations`(迁移 id 主键);已应用的迁移
 *    跳过,未应用的按文件名字典序执行;
 *  - 每个迁移独立事务执行,失败即整体中止(fail-closed,不留下半应用态);
 *  - 会话级咨询锁串行化并发 runner(多实例启动竞态防护);
 *  - 迁移 SQL 自身亦要求幂等形态(IF NOT EXISTS / DROP TRIGGER IF EXISTS),
 *    防御"记录表与库状态不一致"的运维态。
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import { PersistenceError } from "../errors.js";

/** 单个迁移(文件名去掉 .sql 即 id;字典序即执行序)。 */
export interface Migration {
  readonly id: string;
  readonly sql: string;
}

const BOOKKEEPING_TABLE = "_session_api_migrations";
const ADVISORY_LOCK_KEY = 0x53544150; // "STAP" 任意固定常量,仅本 runner 使用

/** 从目录加载迁移文件(顺序文件:*_name.sql;按文件名排序)。 */
export async function loadMigrationsFromDir(dir: string): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(
    files.map(async (name) => ({
      id: name.replace(/\.sql$/, ""),
      sql: await readFile(join(dir, name), "utf8"),
    })),
  );
}

export interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * 为 action_log 预建月度原生分区(运维辅助;MVP 期写入由 DEFAULT 分区兜底,
 * 归档轮转与原生分区扩展归阶段六)。注意:若 DEFAULT 分区已持有该月范围的
 * 行,PostgreSQL 会拒绝建分区——先归档再分区是运维序,本函数不做数据搬移。
 *
 * 行级租户策略(007 迁移 / D-API-101):父表政策不自动覆盖分区的直连访问,
 * 新建分区经库层辅助函数 `session_api_apply_action_log_row_security` 单源
 * 补齐(ENABLE/FORCE + 租户政策 + session_app GRANT)——分区轮转后第二道
 * 结构闸全表域保持。
 */
export async function createActionLogPartition(pool: Pool, month: Date): Promise<void> {
  const year = month.getUTCFullYear();
  const monthIndex = month.getUTCMonth();
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  const name = `action_log_${year}_${String(monthIndex + 1).padStart(2, "0")}`;
  const exists = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${name}`],
  );
  if (exists.rows[0]?.exists === true) {
    return; // 幂等:分区已存在
  }
  // 分区边界不接受绑定参数,这里以 ISO 字面量内联(值源自 Date,非用户输入)。
  await pool.query(
    `CREATE TABLE ${name} PARTITION OF action_log
     FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')`,
  );
  // 行级政策单源补齐(政策 / GRANT 字面在 007 迁移内,零第二实现)。
  await pool.query(`SELECT session_api_apply_action_log_row_security($1)`, [name]);
}

/**
 * 执行迁移(可重放):重复调用时已应用迁移全部跳过,零副作用。
 * @param pool 连接池
 * @param migrations 迁移清单(缺省从 apps/session-api/migrations 加载——
 *   由调用方传入目录以保持本模块的 IO 注入形态)
 * @param dir 迁移目录(migrations 缺省时读取)
 */
export async function runMigrations(
  pool: Pool,
  migrations?: readonly Migration[],
  dir?: string,
): Promise<MigrationRunResult> {
  const list = migrations ?? (dir === undefined ? [] : await loadMigrationsFromDir(dir));
  if (migrations === undefined && dir === undefined) {
    throw new PersistenceError("migration_failed", "runMigrations 需要 migrations 清单或目录参数");
  }

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${BOOKKEEPING_TABLE} (
           id TEXT PRIMARY KEY,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`,
      );
      const known = await client.query<{ id: string }>(`SELECT id FROM ${BOOKKEEPING_TABLE}`);
      const appliedIds = new Set(known.rows.map((row) => row.id));
      const applied: string[] = [];
      const skipped: string[] = [];

      for (const migration of list) {
        if (appliedIds.has(migration.id)) {
          skipped.push(migration.id);
          continue;
        }
        try {
          await client.query("BEGIN");
          await client.query(migration.sql);
          await client.query(`INSERT INTO ${BOOKKEEPING_TABLE} (id) VALUES ($1)`, [migration.id]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          // 只上抛稳定语义与迁移 id(错误消息可能携带 SQLSTATE,不携带载荷)。
          throw new PersistenceError(
            "migration_failed",
            `迁移 ${migration.id} 执行失败(已回滚)`,
            { cause: error },
          );
        }
        applied.push(migration.id);
      }
      return { applied, skipped };
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

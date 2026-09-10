/**
 * PostgreSQL 连接工厂(WP-3;ADR-4:PostgreSQL 16+ 唯一权威存储)。
 */

import type { Pool } from "pg";

/** 连接工厂(连接串来自 config.postgresUrl;连接失败在查询时上抛)。 */
export async function createPostgresPool(postgresUrl: string, max = 10): Promise<Pool> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: postgresUrl, max });
  // 首连探针:配置错误(连接串非法 / 库不可达)尽早暴露。
  const client = await pool.connect();
  client.release();
  return pool;
}

/** 关闭连接池(优雅停机步骤;在途查询完成后退出)。 */
export async function closePostgresPool(pool: Pool): Promise<void> {
  await pool.end();
}

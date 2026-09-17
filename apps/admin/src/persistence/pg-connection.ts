/**
 * PostgreSQL 连接层(管理面独立角色 `admin_ro`;D-API-135)。
 *
 * 形态与 `apps/session-api/src/persistence/pg/connection.ts` 的 `TenantScope`
 * **同构但独立实现**:管理面不 import 编排器内部实现(app→app 依赖违背独立
 * 部署,D-API-135),因此连接层是 admin 自己的代码,只共享 GUC 名与语义
 * 约定——约定是契约层事实(007 / 009 迁移的政策谓词都读同一个
 * `app.tenant_id`),不是代码依赖。
 *
 * 租户作用域注入:每个租户作用域查询在显式事务内 `SET LOCAL app.tenant_id`
 * (BEGIN → set_config(..., true) → 语句 → COMMIT)。SET LOCAL 仅事务内
 * 生效,COMMIT 后自动归零 ⇒ 连接归池后零租户态残留;GUC 缺失时政策谓词
 * `tenant_id = current_setting('app.tenant_id', true)` 恒假 ⇒ **零行**
 * (fail-closed)。查询层租户过滤(`WHERE tenant_id = $1`)与 RLS 政策构成
 * 两层:任何一层失效,另一层仍把跨租户访问折叠成"不存在"。
 *
 * 本模块只发事务控制语句(BEGIN / COMMIT / ROLLBACK / set_config)与端口
 * 传来的只读语句;后者逐句过 `assertReadOnlySql`(见 `pg-read-store.ts`)。
 */
import { Pool } from "pg";
import type { PoolClient } from "pg";

import { AdminStoreError } from "./ports.js";

/** 租户上下文 GUC(与 007 / 009 迁移政策谓词同名同义)。 */
export const ADMIN_TENANT_CONTEXT_GUC = "app.tenant_id";

/** 管理面连接池(只读角色;首连失败即拒绝启动,fail-closed)。 */
export async function createAdminPostgresPool(connectionString: string): Promise<Pool> {
  const pool = new Pool({ connectionString, max: 5 });
  try {
    await pool.query("SELECT 1");
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw new AdminStoreError("PostgreSQL 不可达(fail-closed)", error);
  }
  return pool;
}

/** 关闭连接池(优雅停机步骤;在途查询完成后退出)。 */
export async function closeAdminPostgresPool(pool: Pool): Promise<void> {
  await pool.end();
}

/** 租户作用域查询执行器(管理面自有的最小形态)。 */
export class AdminTenantScope {
  constructor(private readonly pool: Pool) {}

  /** 租户作用域事务(SET LOCAL 在事务首语句注入,COMMIT 后自动归零)。 */
  async transaction<T>(tenantId: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        await client.query(`SELECT set_config('${ADMIN_TENANT_CONTEXT_GUC}', $1, true)`, [
          tenantId,
        ]);
        const result = await run(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    } finally {
      client.release();
    }
  }

  /** 只读探针(readiness;不经租户 GUC——探针不读取任何租户数据)。 */
  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }
}

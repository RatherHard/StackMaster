/**
 * PostgreSQL 连接工厂(WP-3;ADR-4:PostgreSQL 16+ 唯一权威存储)。
 *
 * 租户作用域注入(阶段六 WP-65,D-API-101):行级租户策略(007 迁移,
 * RLS)是查询层租户校验(D-API-20)之外的第二道结构闸——本模块的
 * `TenantScope` 是其连接层落点:每个租户作用域查询在显式事务内先
 * `SET LOCAL app.tenant_id`,使 `tenant_id = current_setting('app.tenant_id')`
 * 政策谓词对查询生效。
 *
 * 形态取舍(按现有 connection.ts 形态定,登记于 D-API-101):SET LOCAL 仅
 * 事务内生效,而存储实现是 `Pool.query` 直连形态(非全事务化)——逐事务
 * 包装(BEGIN → SET LOCAL → 语句 → COMMIT)取代"每查询会话级 SET":
 * 后者依赖连接复用纪律且在连接归还后残留租户态(fail-open 危险),前者
 * 在 COMMIT 后由 SET LOCAL 语义自动归零,`app.tenant_id` 缺失 = 政策谓词
 * 恒假 = 零行(fail-closed)。代价 = 每存储调用 +3 次往返,量化对比登记于
 * "RLS 性能成本"风险行(k6 前后对比,D-API-101)。
 */

import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

/** 租户上下文 GUC(应用连接角色的政策谓词绑定面;自定义 GUC 无需授权即可 SET)。 */
export const TENANT_CONTEXT_GUC = "app.tenant_id";

/** 启动恢复例外 GUC(D-API-63 查询层跨租户例外的行级同构;仅启动恢复事务内 SET LOCAL)。 */
export const BOOT_RECOVERY_GUC = "app.boot_recovery";

/** 保留期清理例外 GUC(D-API-55 sanction 删除路径;仅清理调用内 SET LOCAL)。 */
export const RETENTION_PURGE_GUC = "app.retention_purge";

/** 审计归档切片例外 GUC(D-API-92 跨租户运维读面;仅归档事务内 SET LOCAL)。 */
export const AUDIT_ARCHIVE_GUC = "app.audit_archive";

/** 进程生命周期例外 GUC(逐命令窄面政策行承载;与租户上下文互斥使用)。 */
export type LifecycleGuc =
  | typeof BOOT_RECOVERY_GUC
  | typeof RETENTION_PURGE_GUC
  | typeof AUDIT_ARCHIVE_GUC;

/**
 * 租户作用域查询执行器(存储适配器的注入点;由 Pool 派生,构造器零新增
 * 参数——适配器以 `new TenantScope(pool)` 内部持有)。
 */
export class TenantScope {
  constructor(private readonly pool: Pool) {}

  /**
   * 租户作用域单语句:BEGIN → SET LOCAL app.tenant_id → 语句 → COMMIT。
   * 强制 RLS 下 GUC 缺失即零行(fail-closed),注入即双层并存的第一道连接层闸。
   */
  async query<Row extends QueryResultRow>(
    tenantId: string,
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    return this.transaction(tenantId, (client) => client.query<Row>(text, [...values]));
  }

  /**
   * 租户作用域事务(多语句面:D-API-85 提交入队同锚等;SET LOCAL 在事务
   * 首语句注入,COMMIT 后自动归零——连接复用零租户态残留)。
   */
  async transaction<T>(tenantId: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        // 注入失败同走 ROLLBACK(零半开事务归还连接池;fail-closed 收口)。
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
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

  /**
   * 进程生命周期作用域(专用 GUC 承载的 sanctioned 跨租户例外,消费方:
   * 启动恢复枚举 D-API-63 / 保留期租户枚举 D-API-55 / 审计归档切片 D-API-92;
   * 常规请求路径不得调用)。注意:RLS 下 DELETE 永不跨租户(PG 对 DELETE
   * 施加 SELECT 可见 + DELETE 政策双重谓词)——保留期清理为两段式:本方法
   * 只承载枚举读面,删除逐租户经 `query`(租户上下文注入)执行。
   * `app.tenant_id` 保持缺失:生命周期操作非租户作用域数据访问(与查询层
   * 例外同一定性,D-API-63)。
   */
  async lifecycleQuery<Row extends QueryResultRow>(
    guc: LifecycleGuc,
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        await client.query(`SELECT set_config($1, 'on', true)`, [guc]);
        const result = await client.query<Row>(text, [...values]);
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
}

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

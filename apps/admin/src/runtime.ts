/**
 * admin 运行时装配(D-MP-5 分支 A;verifier `runtime.ts` 同款形态)。
 *
 * 装配链:配置(三道闸已过)→ 独立只读连接池(`admin_ro`)→ 只读存储 →
 * 受控日志审计 → 指标 → 凭证校验器 / 租户绑定 / 频率闸 → 路由 → 服务。
 *
 * fail-closed 装配纪律:
 *  - 连接池首连失败即抛(`AdminStoreError`)⇒ 进程不进入服务态;
 *  - 绑定租户为空**不是**启动失败:它是配置内的合法 fail-closed 态
 *    (数据面整体 404 同形,O-MP-6),启动照常,查询全拒;
 *  - 停机句柄按序注册:关服务 → 关连接池 → 刷日志(见 index.ts)。
 */
import type { Logger } from "pino";
import type { FastifyInstance } from "fastify";

import { ControlledLogAdminQueryAudit, ADMIN_AUDIT_ACTOR } from "./audit/admin-audit.js";
import { AdminCredentialVerifier } from "./auth/credential.js";
import { AdminTenantBinding } from "./auth/tenant-binding.js";
import type { AdminConfig } from "./config.js";
import { AdminMetrics } from "./metrics.js";
import { AdminRateLimiter } from "./rate-limit.js";
import {
  closeAdminPostgresPool,
  createAdminPostgresPool,
} from "./persistence/pg-connection.js";
import { PostgresAdminReadStore } from "./persistence/pg-read-store.js";
import type { ShutdownStep } from "./shutdown.js";
import { buildAdminServer } from "./server.js";

export interface AdminRuntime {
  readonly server: FastifyInstance;
  readonly metrics: AdminMetrics;
  readonly closeHandles: readonly ShutdownStep[];
  startServer(): Promise<void>;
}

export async function buildAdminRuntime(
  config: AdminConfig,
  logger: Logger,
): Promise<AdminRuntime> {
  const pool = await createAdminPostgresPool(config.postgresUrl);
  const store = new PostgresAdminReadStore(pool);
  const metrics = new AdminMetrics();
  const tenants = new AdminTenantBinding(config.tenants);
  const audit = new ControlledLogAdminQueryAudit(logger);

  // 绑定租户**数量**入指标(标识符绝不入标签;零标识符纪律)。
  metrics.boundTenants.set(tenants.size);

  const server = await buildAdminServer({
    logger,
    metrics,
    readinessProbes: [
      {
        name: "postgres",
        check: async () => {
          await store.ping();
        },
      },
    ],
    routes: {
      credentials: new AdminCredentialVerifier(config.credentialSha256),
      tenants,
      store,
      audit,
      metrics,
      rateLimiter: new AdminRateLimiter(config.rateLimitPerMinute),
    },
  });

  if (tenants.effective) {
    logger.info({ boundTenants: tenants.size }, "admin credential bound to tenants");
  } else {
    // 不打印任何配置值;只登记 fail-closed 态(数据面整体 404 同形)。
    logger.warn(
      { event: "admin_tenants_empty", actor: ADMIN_AUDIT_ACTOR },
      "admin tenant whitelist empty; data plane fails closed (404 for every query)",
    );
  }

  return {
    server,
    metrics,
    closeHandles: [
      {
        name: "close-admin-server",
        run: async () => {
          await server.close();
        },
      },
      {
        name: "close-postgres",
        run: async () => {
          await closeAdminPostgresPool(pool);
        },
      },
    ],
    async startServer(): Promise<void> {
      await server.listen({ host: config.host, port: config.port });
    },
  };
}

/**
 * 管理面独立入口(信任域 4;D-MP-5 分支 A,2026-09-17 主控定案)。
 *
 * 进程纪律(verifier 同款):
 *  - 配置 fail-closed:三道闸任一不过即非零退出,进程不监听;
 *  - 日志:Pino,零秘密零凭证材料(base 覆盖基础设施指纹);
 *  - 优雅停机:close-admin-server → close-postgres → flush-logs,
 *    SIGTERM / SIGINT / Windows IPC `shutdown` 同一序列,超时强制退出码 1;
 *  - **独立部署**:本进程只注册运维面与三个只读面,不入插件链路
 *    (`docs/项目计划书.md:715`),不持有会话凭证 / 宿主后端令牌(`:807`)。
 */
import process from "node:process";
import { pino } from "pino";

import { ConfigValidationError, loadAdminConfig } from "./config.js";
import { buildAdminRuntime } from "./runtime.js";
import { createShutdownCoordinator } from "./shutdown.js";

const logger = pino({
  level: process.env["ADMIN_LOG_LEVEL"] ?? "info",
  base: undefined,
});

async function main(): Promise<void> {
  let config;
  try {
    config = loadAdminConfig();
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      logger.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const runtime = await buildAdminRuntime(config, logger);
  await runtime.startServer();
  logger.info({ port: config.port }, "admin listening");

  const coordinator = createShutdownCoordinator({
    logger,
    timeoutMs: config.gracefulShutdownTimeoutSeconds * 1_000,
  });
  coordinator.installDefaultTriggers();
  for (const handle of runtime.closeHandles) {
    coordinator.registerStep({ name: handle.name, run: handle.run });
  }
}

main().catch((error) => {
  logger.error(
    { err: error instanceof Error ? error.message : String(error) },
    "admin boot failed",
  );
  process.exit(1);
});

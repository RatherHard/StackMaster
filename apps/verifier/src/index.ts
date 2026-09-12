/**
 * 独立裁决服务入口(信任域 4;WP-61,Q1 定案候选 (b))。
 *
 * 进程纪律(D-API-9 载体纪律的 verifier 延伸,D-API-87):
 *  - 配置 fail-closed:三道闸任一不过即非零退出,进程不监听;
 *  - 日志:Pino,零秘密零引用内容(base 覆盖基础设施指纹);
 *  - 优雅停机:stop-verifier-loop(完成当前批)→ close-postgres → flush-logs,
 *    SIGTERM / SIGINT / Windows IPC `shutdown` 同一序列,超时强制退出码 1;
 *  - 零业务路由、零浏览器可达面(呈现链路走 session-api 读裁决域,
 *    D-API-83;verifier 与编排器经 PG 单向解耦)。
 */
import process from "node:process";
import { pino } from "pino";

import { ConfigValidationError, loadVerifierConfig } from "./config.js";
import { buildVerifierRuntime } from "./runtime.js";
import { createShutdownCoordinator } from "./shutdown.js";

const logger = pino({
  level: process.env["VERIFIER_LOG_LEVEL"] ?? "info",
  base: undefined,
});

async function main(): Promise<void> {
  let config;
  try {
    config = loadVerifierConfig();
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      logger.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const runtime = await buildVerifierRuntime(config, logger);
  await runtime.startServer();
  logger.info({ port: config.port }, "verifier listening");

  const coordinator = createShutdownCoordinator({
    logger,
    timeoutMs: config.gracefulShutdownTimeoutSeconds * 1_000,
  });
  coordinator.installDefaultTriggers();
  for (const handle of runtime.closeHandles) {
    coordinator.registerStep({ name: handle.name, run: handle.run });
  }
  void runtime.loop.run();
}

main().catch((error) => {
  logger.error(
    { err: error instanceof Error ? error.message : String(error) },
    "verifier boot failed",
  );
  process.exit(1);
});

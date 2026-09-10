/**
 * session-api 进程入口(WP-1 进程骨架 + WP-4 全量装配;信任域 2)。
 *
 * 启动序(fail-closed,任一步失败即非零退出,进程不监听):
 *   配置三道闸 → logger → 运行时全量装配(runtime:PostgreSQL 池 → 迁移 →
 *   Redis → MinIO + 建桶 → 认证栈 → 在途会话管理器 → readiness 探针)→
 *   HTTP 服务装配(注入认证插件 / 生命周期路由 / 探针)→ 监听。
 *
 * 优雅停机(SIGTERM / SIGINT / Windows IPC `shutdown`;步骤按注册顺序):
 *   close-wss-channels(活跃通道冲刷发送缓冲后以 close 1001 有序关闭,WP-5
 *   D-API-48)→ stop-accepting-requests → flush-live-sessions(在途会话状态
 *   落盘:编排器恢复点补落 + 快照锚推进,WP-3 SnapshotPersistence)→
 *   close-postgres → close-redis → flush-logs;超时强制退出码 1(D-API-9)。
 */
import { SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS } from "@stackmaster/protocol";
import { loadSessionApiConfig, ConfigValidationError, type SessionApiConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { buildServer } from "./server.js";
import { createShutdownCoordinator } from "./shutdown.js";
import { buildSessionApiRuntime } from "./runtime/runtime.js";

async function main(): Promise<void> {
  const config: SessionApiConfig = loadConfigOrExit();
  const logger = createLogger(config);
  const runtime = await buildSessionApiRuntime(config, logger);
  const server = buildServer(config, logger, {
    authPlugin: runtime.authPlugin,
    sessionRoutes: runtime.sessionRoutes,
    wssChannel: runtime.wssChannel,
    metricsPlugin: runtime.metricsPlugin,
    readinessProbes: runtime.readinessProbes,
  });

  const coordinator = createShutdownCoordinator({
    logger,
    timeoutMs: config.gracefulShutdownTimeoutSeconds * 1000,
  });
  // 活跃 WSS 通道有序关闭(冲刷发送缓冲 → close 1001;WP-5,D-API-48)。
  // 先于 stop-accepting-requests:通道收尾不被 fastify close 的连接回收路径抢先。
  coordinator.registerStep({
    name: "close-wss-channels",
    run: () => runtime.wssRegistry.closeAll(),
  });
  coordinator.registerStep({
    name: "stop-accepting-requests",
    run: () => server.close(),
  });
  // 在途会话状态落盘(WP-3 恢复点 + 会话锚;编排器账本冲刷)。
  coordinator.registerStep({
    name: "flush-live-sessions",
    run: () => runtime.manager.flushAll(),
  });
  // 持久化连接回收(在途落盘之后)。
  for (const handle of runtime.closeHandles) {
    coordinator.registerStep({ name: handle.name, run: handle.run });
  }
  coordinator.registerStep({
    name: "flush-logs",
    run: async () => {
      logger.flush();
    },
  });
  coordinator.installDefaultTriggers();

  await server.listen({ port: config.port, host: config.host });
  const boundPort =
    config.port === 0 ? (server.addresses()[0]?.port ?? 0) : config.port;
  logger.info(
    {
      host: config.host,
      port: boundPort,
      // 受理的协议版本集合(启动登记;N-1 窗口运维观测点,D-API-4)。
      protocolVersions: [...SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS],
    },
    "session-api listening",
  );
}

/** 配置加载失败:logger 尚未建立(level 依赖配置),单行 JSON 落 stderr 后退出。 */
function loadConfigOrExit(): SessionApiConfig {
  try {
    return loadSessionApiConfig();
  } catch (error) {
    const issues =
      error instanceof ConfigValidationError ? error.issues : [String(error)];
    // issues 只含字段名与原因,不含字段值(config.ts 纪律)。
    console.error(
      JSON.stringify({ msg: "session-api 启动被拒绝:配置校验失败", issues }),
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({ msg: "session-api 启动失败", error: String(error) }),
  );
  process.exit(1);
});

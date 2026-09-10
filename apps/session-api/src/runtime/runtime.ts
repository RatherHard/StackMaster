/**
 * 运行时全量装配(任务 B;WP-4 汇合 WP-2 认证面与 WP-3 持久化面,WP-6
 * 汇合限流 / 配额 / 回收与 action_log 落库)。
 *
 * 装配序(fail-closed:任一步失败即抛错,进程不进入服务态):
 *   1. PostgreSQL 连接池 → 迁移执行(失败即拒绝启动);
 *   2. Redis 连接(fail-closed 分级)→ 键值原语 → 认证 token 存储(薄适配,
 *      D-API-33)→ 幂等窗口(Redis 主用 + 进程内降级,D-API-24)+ 路由 / 限流;
 *   3. MinIO 客户端 + 幂等建桶;
 *   4. PG 权威存储(会话 / 快照 / 提交 / 注册表 / 动作日志)+ 快照加密与
 *      恢复服务 + 周期快照策略;
 *   5. 认证栈(签名器单实例同时注入签发路由与凭证 preHandler);
 *   6. 在途会话管理器(编排器域,WP-5 动作通道复用;WP-6 并发预算 /
 *      checkpoint 配额 / action_log 落库在此执行,D-API-52 / 54 / 56);
 *      指标面(WP-8,D-API-70):五指标族 + /metrics 插件在此创建并注入;
 *   7. 限流面(WP-6):每租户 / 每用户请求频率与提交频率闸
 *      (rate:{tenant}:{user} 固定窗口)+ create-session 守卫(D-API-35
 *      接入点的执行面)+ 每会话动作频率(与每连接令牌桶叠加,D-API-53);
 *   8. 生命周期路由插件(REST 五命令);
 *   9. WSS 动作通道(升级认证 / 连接绑定 / 心跳空闲 / 频率 / 背压 / 保持窗口,
 *      WP-5;保持到期回收钩子接线,WP-6 D-API-55);readiness 探针
 *      (PG / Redis / MinIO 可达性;失败细节不透出,D-API-34)。
 *
 * 依赖注入图:config → adapters → ports → manager/plugins;一切端口可注入
 * 替身(测试装配见 test/routes/helpers/session-rig.ts 的内存同构形态)。
 */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { FastifyPluginAsync } from "fastify";
import type { Logger } from "pino";
import type { Pool } from "pg";
import { SessionOrchestrator } from "@stackmaster/session-core";

import type { SessionApiConfig } from "../config.js";
import {
  buildAuthPlugin,
  createTokenSigner,
  InMemoryAuditSink,
  type TokenSigner,
} from "../auth/index.js";
import {
  AutoSnapshotPolicy,
  createMinioClient,
  createPostgresPool,
  createRedisConnection,
  loadMigrationsFromDir,
  PostgresActionLogStore,
  PostgresChallengeRegistry,
  PostgresSessionRepository,
  PostgresSnapshotStore,
  PostgresSubmissionStore,
  RedisIdempotencyWindow,
  RedisKeyValueStore,
  RedisRateLimitCounter,
  RedisRouteStore,
  ResilientIdempotencyWindow,
  runMigrations,
  SnapshotCipher,
  SnapshotPersistence,
  SessionRecoveryService,
  MinioChallengeBundleStore,
  type ChallengeBundleStore,
  type ChallengeRegistry,
  type IdempotencyWindow,
  type MinioLike,
  type RateLimitCounter,
  type RouteStore,
  type SessionRepository,
  type SubmissionStore,
  type SnapshotStore,
  type RedisLike,
} from "../persistence/index.js";
import { buildSessionRoutes } from "../routes/session-routes.js";
import { createSessionAuthContext } from "../auth/auth-context.js";
import { LiveSessionManager } from "../sessions/session-manager.js";
import { SessionMetrics, buildMetricsPlugin } from "../metrics/index.js";
import {
  FixedWindowRateGate,
  RateLimitedCreateSessionGuard,
  SessionActionRateLimiter,
  TerminalSessionCleaner,
  keepaliveExpiryReaper,
} from "../limits/index.js";
import { buildWssChannel, type SessionConnectionRegistry } from "../wss/index.js";
import {
  KeyValueCredentialRevocationStore,
  KeyValueTokenIssuanceStore,
} from "./redis-token-stores.js";

/** 迁移目录(apps/session-api/migrations;src 与 dist 同深度布局共用)。 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** readiness 探针(server.ts /readyz 消费;name 只进受控日志)。 */
export interface ReadinessProbe {
  readonly name: string;
  check(): Promise<void>;
}

/** 关闭句柄(优雅停机步骤的注入形态)。 */
export interface RuntimeCloseHandle {
  readonly name: string;
  run(): Promise<void>;
}

/**
 * 编排器重启恢复(WP-7,D-API-63;计划书 5.3"编排器重启不破坏会话一致性"
 * 的启动期接线,Compose 级复验的消费路径):
 *
 *   listActiveSessions(phase='active')→ 逐会话 `planRecovery`(sessions 行 +
 *   最近密文快照 → 双包 → 解密)+ `SessionOrchestrator.recover`(两步 load +
 *   import_snapshot,D-F8)→ `manager.adoptRecovered` 纳入在途表。
 *
 *  - **fail-open 边界**:单会话恢复失败(版本行缺失 / 双包不可取回 / 无恢复
 *    点 / worker 装载拒绝)只将该会话行置 `crashed`(确定性终态,客户端恢复
 *    路径 = 重新 create_session)并进受控日志——启动永不因单个不可恢复会话
 *    失败,一致性由"不可恢复即终态"保证(不存在半恢复的在途会话);
 *  - server_random 策略的一次性恢复种子由 SessionRecoveryService 的
 *    `recoverySeed` 现场生成(import_snapshot 全量覆盖,原始种子不落存储,
 *    D-API-23);
 *  - 返回恢复的会话数(可观测;零恢复 = 正常冷启动)。
 */
export async function recoverActiveSessions(deps: {
  readonly sessions: SessionRepository;
  readonly recovery: SessionRecoveryService;
  readonly manager: LiveSessionManager;
  readonly logger: Logger;
  readonly workerCommand?: import("@stackmaster/session-core").WorkerCommandSpec;
}): Promise<number> {
  const actives = await deps.sessions.listActiveSessions();
  let recovered = 0;
  for (const row of actives) {
    try {
      const plan = await deps.recovery.planRecovery(row.sessionId, row.tenantId);
      const orchestrator = await SessionOrchestrator.recover({
        sessionId: plan.sessionId,
        privateBundle: plan.load.privateBundle,
        publicDescriptor: plan.load.publicDescriptor,
        ...(plan.load.sessionSeedHex === undefined ? {} : { sessionSeedHex: plan.load.sessionSeedHex }),
        snapshot: plan.snapshot,
        ...(deps.workerCommand === undefined ? {} : { workerCommand: deps.workerCommand }),
        // 恢复会话的认证上下文按持久化身份重建(身份只来自持久化凭证链,
        // 与 create-session 同一派生形态)。
        auth: createSessionAuthContext({
          sessionId: row.sessionId,
          tenantId: row.tenantId,
          userId: row.userId,
        }),
      });
      await deps.manager.adoptRecovered({
        session: orchestrator,
        tenantId: plan.tenantId,
        userId: plan.userId,
        challengeId: plan.challenge.challengeId,
        challengeVersion: plan.challenge.challengeVersion,
        seedStrategy: plan.seedStrategy,
      });
      recovered += 1;
    } catch (error) {
      // fail-open:置 crashed(幂等;行不存在同形忽略)后继续,启动不受阻。
      deps.logger.warn(
        {
          sessionId: row.sessionId,
          tenantId: row.tenantId,
          reason: error instanceof Error ? error.message : "session recovery failed",
        },
        "session recovery failed at startup; session marked crashed",
      );
      await deps.sessions
        .updateSessionPhase(row.sessionId, row.tenantId, "crashed")
        .catch(() => undefined);
    }
  }
  return recovered;
}

export interface SessionApiRuntime {
  readonly pool: Pool;
  readonly redis: RedisLike;
  readonly bundleStore: ChallengeBundleStore;
  readonly registry: ChallengeRegistry;
  readonly sessions: SessionRepository;
  readonly snapshots: SnapshotStore;
  readonly submissions: SubmissionStore;
  readonly snapshotPersistence: SnapshotPersistence;
  readonly recovery: SessionRecoveryService;
  readonly idempotencyWindow: IdempotencyWindow;
  readonly routeStore: RouteStore;
  readonly rateLimitCounter: RateLimitCounter;
  /**
   * 动作日志存储(WP-6 已接线:LiveSessionManager.submit 把 SubmitReference
   * 内的权威动作日志增量落库,仅已接受动作、与提交引用同锚;append-only,
   * D-API-56)。
   */
  readonly actionLog: import("../persistence/ports.js").ActionLogStore;
  /** 终态会话保留窗口清理入口(T0 无 cron,可调用;运维定时调用,D-API-55)。 */
  readonly terminalCleaner: TerminalSessionCleaner;
  readonly manager: LiveSessionManager;
  readonly signer: TokenSigner;
  readonly audit: InMemoryAuditSink;
  readonly authPlugin: FastifyPluginAsync;
  readonly sessionRoutes: FastifyPluginAsync;
  /** WSS 动作通道插件(GET /sessions/channel;WP-5,D-API-40)。 */
  readonly wssChannel: FastifyPluginAsync;
  /** 指标端点插件(GET /metrics;WP-8,D-API-70)。 */
  readonly metricsPlugin: FastifyPluginAsync;
  /** 连接注册表(多连接踢旧 / 断线保持计时器;停机步骤 close-wss-channels)。 */
  readonly wssRegistry: SessionConnectionRegistry;
  readonly readinessProbes: readonly ReadinessProbe[];
  /** 关闭句柄(停机序列在 flush-live-sessions 之后逐个执行)。 */
  readonly closeHandles: readonly RuntimeCloseHandle[];
}

export interface BuildRuntimeOptions {
  /** 可注入 worker 进程描述(测试假 worker;生产缺省由 session-core 定位)。 */
  readonly workerCommand?: import("@stackmaster/session-core").WorkerCommandSpec;
}

/**
 * 全量装配(fail-closed):迁移失败 / 依赖不可达即抛错——调用方(main)
 * 以非零退出拒绝启动。
 */
export async function buildSessionApiRuntime(
  config: SessionApiConfig,
  logger: Logger,
  options: BuildRuntimeOptions = {},
): Promise<SessionApiRuntime> {
  // ── 1. PostgreSQL(唯一权威存储;迁移失败即拒绝启动)──
  const pool = await createPostgresPool(config.postgresUrl);
  try {
    const migrations = await loadMigrationsFromDir(MIGRATIONS_DIR);
    const result = await runMigrations(pool, migrations);
    logger.info(
      { applied: result.applied.length, skipped: result.skipped.length },
      "database migrations settled",
    );
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  // ── 2. Redis(fail-closed 分级;连接不可达即拒绝启动)──
  const redis = await createRedisConnection(config.redisUrl);
  const kv = new RedisKeyValueStore(redis);
  const issuanceStore = new KeyValueTokenIssuanceStore(kv);
  const revocationStore = new KeyValueCredentialRevocationStore(kv);
  const idempotencyWindow = new ResilientIdempotencyWindow(
    new RedisIdempotencyWindow(redis, config.idempotencyWindowTtlSeconds),
    config.idempotencyWindowTtlSeconds,
    (event) => logger.warn(event, "idempotency window degraded to in-process backend"),
  );
  const routeStore = new RedisRouteStore(redis);
  const rateLimitCounter = new RedisRateLimitCounter(redis);

  // ── 3. MinIO(对象存储;幂等建桶)──
  const minio: MinioLike = await createMinioClient({
    endpoint: config.minioEndpoint,
    port: config.minioPort,
    accessKey: config.minioAccessKey,
    secretKey: config.minioSecretKey,
  });
  const bundleStore = new MinioChallengeBundleStore(minio, {
    bucketPrivate: config.minioBucketPrivate,
    bucketPublic: config.minioBucketPublic,
  });
  try {
    await bundleStore.ensureBuckets();
  } catch (error) {
    (redis as unknown as { disconnect(): void }).disconnect();
    await pool.end().catch(() => undefined);
    throw error;
  }

  // ── 4. PG 权威存储 + 快照加密 + 恢复 + 周期策略 ──
  const sessions = new PostgresSessionRepository(pool);
  const snapshots = new PostgresSnapshotStore(pool);
  const submissions = new PostgresSubmissionStore(pool);
  const registry = new PostgresChallengeRegistry(pool);
  const actionLog = new PostgresActionLogStore(pool);
  const cipher = SnapshotCipher.fromBase64Key(config.snapshotEncryptionKey);
  const snapshotPersistence = new SnapshotPersistence({ store: snapshots, cipher });
  const recovery = new SessionRecoveryService({
    sessions,
    registry,
    bundles: bundleStore,
    snapshots,
    cipher,
    recoverySeed: () =>
      // 一次性恢复种子(D-API-23:现场 CSPRNG,不落任何存储)。
      randomBytes(32).toString("hex"),
  });
  const autoSnapshot = new AutoSnapshotPolicy({ everyNRevisions: config.autoSnapshotEveryRevisions });

  // ── 5. 认证栈(签名器单实例;审计为内存实现——PG 落库归阶段六审计面)──
  const signer = await createTokenSigner(config.signingKey);
  const audit = new InMemoryAuditSink();
  const authPlugin = buildAuthPlugin({ config, signer, issuanceStore, revocationStore, audit });

  // ── 6. 在途会话管理器(WP-6 执行面:并发预算 / 配额 / action_log 落库)──
  // 指标面(WP-8,D-API-70):五指标族 + /metrics 插件在此创建并注入 manager。
  const metrics = new SessionMetrics();
  const metricsPlugin = buildMetricsPlugin(metrics);
  const manager = new LiveSessionManager({
    registry,
    bundles: bundleStore,
    sessions,
    submissions,
    snapshotPersistence,
    audit,
    logger,
    clientSeqLimit: config.maxClientSeqPerSession,
    autoSnapshot,
    actionLog,
    snapshots,
    quotaLimits: {
      maxCheckpointsPerSession: config.maxCheckpointsPerSession,
      snapshotByteBudget: config.snapshotByteBudget,
      tenantStorageQuotaBytes: config.tenantStorageQuotaBytes,
    },
    maxConcurrentSessionsPerTenant: config.maxConcurrentSessionsPerTenant,
    metrics,
    ...(options.workerCommand === undefined ? {} : { workerCommand: options.workerCommand }),
  });

  // ── 6.5 编排器重启恢复(WP-7,D-API-63):active 会话行 → 两步恢复 →
  //    纳入在途表(fail-open:不可恢复即 crashed,启动不受阻)。恢复在
  //    HTTP 服务装配之前完成,接单即处于一致状态。
  const recoveredSessions = await recoverActiveSessions({
    sessions,
    recovery,
    manager,
    logger,
    ...(options.workerCommand === undefined ? {} : { workerCommand: options.workerCommand }),
  });
  if (recoveredSessions > 0) {
    logger.info({ recovered: recoveredSessions }, "live sessions recovered from snapshots at startup");
  }

  // ── 7. 限流面(WP-6;rate:{tenant}:{user} 固定窗口,Redis 计数器载体)──
  const requestRateGate = new FixedWindowRateGate({
    counter: rateLimitCounter,
    limitPerWindow: config.rateLimitRequestsPerMinute,
  });
  const submitRateGate = new FixedWindowRateGate({
    counter: rateLimitCounter,
    limitPerWindow: config.submissionsPerMinute,
  });
  const createSessionGuard = new RateLimitedCreateSessionGuard({
    rateGate: requestRateGate,
    liveCountByTenant: (tenantId) => manager.liveCountByTenant(tenantId),
    maxConcurrentSessionsPerTenant: config.maxConcurrentSessionsPerTenant,
    logger,
  });
  const sessionActionLimiter = new SessionActionRateLimiter({
    capacityPerSecond: config.wssMessageRatePerSecond,
  });
  const terminalCleaner = new TerminalSessionCleaner({ sessions, snapshots });

  // ── 8. 生命周期路由插件 ──
  const sessionRoutes = buildSessionRoutes({
    config,
    manager,
    logger,
    guards: {
      maxJsonDepth: config.maxJsonDepth,
      maxArrayLength: 256,
      maxStringLength: 4096,
    },
    signer,
    issuanceStore,
    revocationStore,
    audit,
    allowedOrigins: config.allowedOrigins,
    createSessionGuard,
    requestRateGate: (tenantId, userId) =>
      requestRateGate.acquireOrThrow(`rate:${tenantId}:${userId}`, "request_rate"),
    submitRateGate: (tenantId, userId) =>
      submitRateGate.acquireOrThrow(`rate:${tenantId}:${userId}:submit`, "submission_rate"),
  });

  // ── 9. WSS 动作通道(WP-5;WP-6 每会话闸与保持到期回收钩子在此挂载)──
  const wssChannelAssembly = buildWssChannel({
    manager,
    idempotencyWindow,
    routeStore,
    signer,
    revocationStore,
    allowedOrigins: config.allowedOrigins,
    logger,
    heartbeatIntervalSeconds: config.wssHeartbeatIntervalSeconds,
    idleTimeoutSeconds: config.wssIdleTimeoutSeconds,
    messageRatePerSecond: config.wssMessageRatePerSecond,
    sessionActionLimiter,
    sendBufferLimit: config.wssSendBufferLimit,
    disconnectKeepaliveSeconds: config.disconnectKeepaliveSeconds,
    // 保持窗口到期回收(D-API-55):会话关闭 + worker 回收 + 会话行对齐。
    onKeepaliveExpiry: keepaliveExpiryReaper(manager, logger),
    limits: {
      maxJsonDepth: config.maxJsonDepth,
      maxArrayLength: 256,
      maxStringLength: 4096,
    },
  });

  // ── readiness 探针(任一失败 → 503;失败方只进受控日志,D-API-34)──
  const readinessProbes: readonly ReadinessProbe[] = [
    {
      name: "postgres",
      check: async () => {
        await pool.query("SELECT 1");
      },
    },
    {
      name: "redis",
      check: async () => {
        await redis.call("PING");
      },
    },
    {
      name: "minio",
      check: async () => {
        if (!(await minio.bucketExists(config.minioBucketPrivate))) {
          throw new Error("private bucket missing");
        }
      },
    },
  ];

  const closeHandles: readonly RuntimeCloseHandle[] = [
    {
      name: "close-postgres",
      run: async () => {
        await pool.end();
      },
    },
    {
      name: "close-redis",
      run: async () => {
        (redis as unknown as { disconnect(): void }).disconnect();
      },
    },
  ];

  return {
    pool,
    redis,
    bundleStore,
    registry,
    sessions,
    snapshots,
    submissions,
    snapshotPersistence,
    recovery,
    idempotencyWindow,
    routeStore,
    rateLimitCounter,
    actionLog,
    terminalCleaner,
    manager,
    signer,
    audit,
    authPlugin,
    sessionRoutes,
    wssChannel: wssChannelAssembly.plugin,
    wssRegistry: wssChannelAssembly.registry,
    metricsPlugin,
    readinessProbes,
    closeHandles,
  };
}

/**
 * 运行时装配(WP-61):config → adapters → ports → loop / server。
 *
 * 装配序(fail-closed,任一步失败即非零退出,进程不进入服务态):
 *   1. PostgreSQL 连接池(裁决域独立角色;连接失败即拒绝启动);
 *   2. MinIO 只读客户端(仅 private-buckets GET;越权 = 拒绝启动方向);
 *   3. worker 二进制解析(STACKMASTER_WORKER_BIN → target 产物序;缺失即
 *      拒绝启动——裁决服务的存在意义就是重放,无引擎即 fail-closed);
 *   4. readiness 探针(PG SELECT 1 / MinIO 授权可达探测);
 *   5. 消费循环(claim → adjudicate → persist)+ 运维面(healthz/readyz/metrics)。
 */
import type { Logger } from "pino";
import type { Pool } from "pg";

import type { VerifierConfig } from "./config.js";
import { VerifierMetrics } from "./metrics.js";
import {
  PostgresChallengeSource,
  PostgresVerdictQueue,
  createPostgresPool,
} from "./persistence/pg-stores.js";
import {
  MinioRegisteredBundleSource,
  createMinioReadonlyClient,
} from "./persistence/minio-bundle-source.js";
import { createVerifierLoop, type VerifierLoop } from "./verifier.js";
import { buildVerifierServer, type ReadinessProbe } from "./server.js";
import { resolveWorkerBinary } from "./worker/worker-binary.js";
import type { WorkerCommandSpec } from "./worker/verify-client.js";

/** verifier 运行时(进程内只读装配产物)。 */
export interface VerifierRuntime {
  readonly pool: Pool;
  readonly metrics: VerifierMetrics;
  readonly loop: VerifierLoop;
  /** 监听并返回实际绑定端口(PORT=0 临时端口时由内核指派;集成测试消费)。 */
  readonly startServer: () => Promise<number>;
  readonly closeHandles: readonly { readonly name: string; run(): Promise<void> }[];
}

export interface BuildRuntimeOptions {
  /** 可注入 worker 进程描述(测试假 worker;生产缺省解析二进制)。 */
  readonly workerSpec?: WorkerCommandSpec;
  /** 可注入 PG 连接池(测试内存形态)。 */
  readonly pool?: Pool;
}

export async function buildVerifierRuntime(
  config: VerifierConfig,
  logger: Logger,
  options: BuildRuntimeOptions = {},
): Promise<VerifierRuntime> {
  // ── 1. PostgreSQL(裁决域;独立角色)──
  const pool = options.pool ?? (await createPostgresPool(config.postgresUrl));
  const queue = new PostgresVerdictQueue(pool);
  const challenges = new PostgresChallengeSource(pool);

  // ── 2. MinIO 只读客户端(仅 GET;双包各归其桶)──
  const minio = await createMinioReadonlyClient({
    endpoint: config.minioEndpoint,
    port: config.minioPort,
    accessKey: config.minioAccessKey,
    secretKey: config.minioSecretKey,
  });
  const bundles = new MinioRegisteredBundleSource(
    minio,
    config.minioBucketPrivate,
    config.minioBucketPublic,
  );

  // ── 3. worker 二进制(同锁:与 session-api 同一构建,版本策略 §四.4)──
  const workerSpec: WorkerCommandSpec =
    options.workerSpec ??
    (() => {
      const binary = resolveWorkerBinary();
      if (binary === null) {
        throw new Error(
          "vm-worker 二进制解析失败(STACKMASTER_WORKER_BIN 或 vm-engine/target 产物;fail-closed)",
        );
      }
      return { command: binary };
    })();

  // ── 4. 指标与管线 ──
  const metrics = new VerifierMetrics();
  const adjudicator = {
    queue,
    challenges,
    bundles,
    maxAttempts: config.maxRunAttempts,
    maxActionLogBytes: config.maxActionLogBytes,
    verifyTimeoutMs: config.verifyTimeoutMs,
    workerSpec,
    logger,
    onVerdict: (verdict: string) => metrics.recordVerdict(verdict),
    onOutcome: (outcome: "completed" | "failed") => metrics.recordRunOutcome(outcome),
  };
  const loop = createVerifierLoop({
    adjudicator,
    batchSize: config.claimBatchSize,
    maxAttempts: config.maxRunAttempts,
    pollIntervalMs: config.pollIntervalMs,
    logger,
    onQueueDepth: (depth) => metrics.queueDepth.set(depth),
  });

  // ── 5. readiness 探针(失败方不透出,D-API-34 同款)──
  const readinessProbes: readonly ReadinessProbe[] = [
    {
      name: "postgres",
      check: async () => {
        await pool.query("SELECT 1");
      },
    },
    {
      name: "minio",
      check: async () => {
        await bundles.probe();
      },
    },
  ];

  // ── 6. 运维面(healthz / readyz / metrics;零业务路由)──
  const server = await buildVerifierServer({ logger, metrics, readinessProbes });
  const startServer = async (): Promise<number> => {
    await server.listen({ port: config.port, host: config.host });
    const address = server.server.address();
    return typeof address === "object" && address !== null ? address.port : config.port;
  };

  const closeHandles = [
    {
      name: "stop-verifier-loop",
      run: async () => {
        loop.stop();
      },
    },
    {
      name: "close-verifier-server",
      run: async () => {
        await server.close();
      },
    },
    {
      name: "close-verifier-postgres",
      run: async () => {
        await pool.end();
      },
    },
  ] as const;

  return { pool, metrics, loop, startServer, closeHandles };
}

/**
 * verifier 运行配置加载与启动校验(信任域 4;D-API-9 工程载体纪律的
 * `VERIFIER_` 前缀延伸,D-API-87)。
 *
 * 启动校验三道闸(session-api 同款,fail-closed):
 *  1. 必备键缺失(`VERIFIER_POSTGRES_URL` / MinIO 端点与凭证)即拒绝启动;
 *  2. 未知保留键:`VERIFIER_` 前缀是本应用保留命名空间,未登记键即拒绝;
 *  3. 取值非法:类型 / 范围 / 枚举校验,配置不得超过天花板(默认值 +
 *     天花板双闸,D-API-31 同形态)。
 *
 * 校验失败消息只含字段名与原因,绝不含字段值(错误面不得成为密钥外泄
 * 通道)。空字符串环境变量一律按"未提供"处理(容器编排占位形态)。
 */
import { z } from "zod";
import { MAX_FRAME_BYTES } from "./protocol-limits.js";

/** 应用保留的环境变量前缀:未登记的 `VERIFIER_*` 键触发启动拒绝。 */
const RESERVED_ENV_PREFIX = "VERIFIER_";

/** 轮询间隔缺省(毫秒;D-API-85:轮询间隔为实现期参数,WP-61 定值)。 */
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** 轮询间隔天花板(毫秒)。 */
export const POLL_INTERVAL_MS_CEILING = 60_000;
/** 批量认领缺省(SKIP LOCKED 单批行数;D-API-85)。 */
export const DEFAULT_CLAIM_BATCH_SIZE = 4;
/** 批量认领天花板。 */
export const CLAIM_BATCH_SIZE_CEILING = 100;
/** 单 submission 重试上限缺省(耗尽后查询面恒为 pending,D-API-84 / 85)。 */
export const DEFAULT_MAX_RUN_ATTEMPTS = 3;
/** 重试上限天花板。 */
export const MAX_RUN_ATTEMPTS_CEILING = 100;
/**
 * verify 帧内规范化动作日志字节上限缺省(4 MiB):verify 请求帧 =
 * 双包 + 动作日志,帧层硬顶 `MAX_FRAME_BYTES`(16 MiB,D-F2);服务侧
 * 预检取帧预算的一半,为双包(单包天花板 4 MiB)之外的保守余量。超限
 * = 确定性拒裁方向(run failed;裁决不可用 ≠ 判负,D-API-84)。
 */
export const DEFAULT_MAX_ACTION_LOG_BYTES = 4_194_304;
/** 动作日志字节天花板 = 帧上限(协议 D-F2)。 */
export const MAX_ACTION_LOG_BYTES_CEILING = MAX_FRAME_BYTES;
/** verify 往返超时缺省(毫秒;重放 CPU 密集,长日志留足余量)。 */
export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
/** verify 往返超时天花板(毫秒)。 */
export const VERIFY_TIMEOUT_MS_CEILING = 600_000;
/** 优雅停机宽限缺省(秒)。 */
export const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS = 10;

/** 必备环境变量登记表(缺失即拒绝启动)。 */
const REQUIRED_ENV_KEYS: readonly string[] = [
  "VERIFIER_POSTGRES_URL",
  "VERIFIER_MINIO_ENDPOINT",
  "VERIFIER_MINIO_ACCESS_KEY",
  "VERIFIER_MINIO_SECRET_KEY",
];

/** 环境变量保留键集合(未知保留键 = 拼写错误,拒绝启动)。 */
const KNOWN_ENV_KEYS: readonly string[] = [
  "VERIFIER_HOST",
  "VERIFIER_PORT",
  "VERIFIER_LOG_LEVEL",
  "VERIFIER_LOG_ERROR_STACKS",
  "VERIFIER_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS",
  "VERIFIER_POSTGRES_URL",
  "VERIFIER_MINIO_ENDPOINT",
  "VERIFIER_MINIO_PORT",
  "VERIFIER_MINIO_ACCESS_KEY",
  "VERIFIER_MINIO_SECRET_KEY",
  "VERIFIER_MINIO_BUCKET_PRIVATE",
  "VERIFIER_MINIO_BUCKET_PUBLIC",
  "VERIFIER_POLL_INTERVAL_MS",
  "VERIFIER_CLAIM_BATCH_SIZE",
  "VERIFIER_MAX_RUN_ATTEMPTS",
  "VERIFIER_MAX_ACTION_LOG_BYTES",
  "VERIFIER_VERIFY_TIMEOUT_MS",
];

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  VERIFIER_HOST: z.string().min(1).default("127.0.0.1"),
  // PORT=0(临时端口)仅 NODE_ENV=test 合法——集成测试随机端口起真实进程。
  VERIFIER_PORT: z.coerce.number().int().min(0).max(65535).default(3100),
  VERIFIER_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  // 内部堆栈默认不入日志(受控排障的显式演进开关,D-API-9 同款)。
  VERIFIER_LOG_ERROR_STACKS: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .default(false),
  VERIFIER_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(300)
    .default(DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS),
  VERIFIER_MINIO_PORT: z.coerce.number().int().min(1).max(65535).default(9000),
  VERIFIER_MINIO_BUCKET_PRIVATE: z.string().min(3).max(63).default("private-bundles"),
  VERIFIER_MINIO_BUCKET_PUBLIC: z.string().min(3).max(63).default("public-descriptors"),
  // ── 队列与裁决面(WP-61;D-API-85 实现期参数落定)──
  VERIFIER_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(50)
    .max(POLL_INTERVAL_MS_CEILING)
    .default(DEFAULT_POLL_INTERVAL_MS),
  VERIFIER_CLAIM_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(1)
    .max(CLAIM_BATCH_SIZE_CEILING)
    .default(DEFAULT_CLAIM_BATCH_SIZE),
  VERIFIER_MAX_RUN_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_RUN_ATTEMPTS_CEILING)
    .default(DEFAULT_MAX_RUN_ATTEMPTS),
  VERIFIER_MAX_ACTION_LOG_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_ACTION_LOG_BYTES_CEILING)
    .default(DEFAULT_MAX_ACTION_LOG_BYTES),
  VERIFIER_VERIFY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(VERIFY_TIMEOUT_MS_CEILING)
    .default(DEFAULT_VERIFY_TIMEOUT_MS),
  // 必备键(缺失由闸 1 上报;Schema 仅承担透传与类型闸)。
  VERIFIER_POSTGRES_URL: z.string().min(1),
  VERIFIER_MINIO_ENDPOINT: z.string().min(1),
  VERIFIER_MINIO_ACCESS_KEY: z.string().min(1),
  VERIFIER_MINIO_SECRET_KEY: z.string().min(1),
});

/** verifier 运行配置(启动校验后的冻结形态,进程内只读)。 */
export interface VerifierConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  readonly logErrorStacks: boolean;
  readonly gracefulShutdownTimeoutSeconds: number;
  /** PostgreSQL 连接串(裁决域;独立角色,与 session-api 不共享凭证)。 */
  readonly postgresUrl: string;
  readonly minioEndpoint: string;
  readonly minioPort: number;
  readonly minioAccessKey: string;
  readonly minioSecretKey: string;
  /** 私有判题包桶(仅 GET;最小授权面 = 桶内对象只读)。 */
  readonly minioBucketPrivate: string;
  /** 公开描述包桶(公开产物,零秘密面;双包各归其桶,001 迁移对象名语义)。 */
  readonly minioBucketPublic: string;
  /** 队列轮询间隔(毫秒;SKIP LOCKED 轮询节拍,D-API-85)。 */
  readonly pollIntervalMs: number;
  /** 批量认领行数。 */
  readonly claimBatchSize: number;
  /** 单 submission 最大 run 次数(耗尽后查询面恒为 pending)。 */
  readonly maxRunAttempts: number;
  /** verify 帧内动作日志字节上限(超限确定性拒裁方向)。 */
  readonly maxActionLogBytes: number;
  /** 单次 verify 往返超时(毫秒;超时 = 进程收割 + run failed)。 */
  readonly verifyTimeoutMs: number;
}

/** 启动校验拒绝(issues 只含字段名与原因,不含字段值)。 */
export class ConfigValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`verifier 启动被拒绝:配置校验失败(${issues.length} 项):${issues.join("; ")}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export function loadVerifierConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  requiredKeys: readonly string[] = REQUIRED_ENV_KEYS,
): VerifierConfig {
  // 空字符串按"未提供"处理(容器编排占位),不进入取值校验。
  const provided: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== "") {
      provided[key] = value;
    }
  }

  const issues: string[] = [];

  // 闸 2:未知保留键(fail-closed 的拼写错误保护)。
  const unknownKeys = Object.keys(provided)
    .filter((key) => key.startsWith(RESERVED_ENV_PREFIX) && !KNOWN_ENV_KEYS.includes(key))
    .sort();
  for (const key of unknownKeys) {
    issues.push(`字段 ${key}:未登记的保留键(拼写错误或未实现的配置面)`);
  }

  // 闸 1:必备键缺失。
  const missingKeys = requiredKeys.filter((key) => !(key in provided)).sort();
  for (const key of missingKeys) {
    issues.push(`字段 ${key}:必备环境变量缺失`);
  }

  const parsed = envSchema.safeParse(provided);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path.length > 0 ? issue.path.join(".") : "(顶层)";
      issues.push(`字段 ${field}:${issue.message}`);
    }
    throw new ConfigValidationError(issues);
  }
  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }

  const raw = parsed.data;
  // PORT=0(临时端口)仅测试环境合法(与 session-api 同一裁决点)。
  if (raw.VERIFIER_PORT === 0 && raw.NODE_ENV !== "test") {
    throw new ConfigValidationError([
      "字段 VERIFIER_PORT:0(临时端口)仅允许 NODE_ENV=test",
    ]);
  }

  return {
    nodeEnv: raw.NODE_ENV,
    host: raw.VERIFIER_HOST,
    port: raw.VERIFIER_PORT,
    logLevel: raw.VERIFIER_LOG_LEVEL,
    logErrorStacks: raw.VERIFIER_LOG_ERROR_STACKS,
    gracefulShutdownTimeoutSeconds: raw.VERIFIER_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS,
    postgresUrl: raw.VERIFIER_POSTGRES_URL,
    minioEndpoint: raw.VERIFIER_MINIO_ENDPOINT,
    minioPort: raw.VERIFIER_MINIO_PORT,
    minioAccessKey: raw.VERIFIER_MINIO_ACCESS_KEY,
    minioSecretKey: raw.VERIFIER_MINIO_SECRET_KEY,
    minioBucketPrivate: raw.VERIFIER_MINIO_BUCKET_PRIVATE,
    minioBucketPublic: raw.VERIFIER_MINIO_BUCKET_PUBLIC,
    pollIntervalMs: raw.VERIFIER_POLL_INTERVAL_MS,
    claimBatchSize: raw.VERIFIER_CLAIM_BATCH_SIZE,
    maxRunAttempts: raw.VERIFIER_MAX_RUN_ATTEMPTS,
    maxActionLogBytes: raw.VERIFIER_MAX_ACTION_LOG_BYTES,
    verifyTimeoutMs: raw.VERIFIER_VERIFY_TIMEOUT_MS,
  };
}

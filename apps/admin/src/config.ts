/**
 * admin 运行配置加载与启动校验(信任域 4;D-MP-5 分支 A;决策登记
 * D-API-134)。载体纪律 = verifier `VERIFIER_` 前缀先例(D-API-87)的
 * `ADMIN_` 前缀延伸。
 *
 * 启动校验三道闸(verifier / session-api 同款,fail-closed):
 *  1. 必备键缺失(`ADMIN_POSTGRES_URL` / `ADMIN_CREDENTIAL_SHA256`)即拒绝启动;
 *  2. 未知保留键:`ADMIN_` 前缀是本应用保留命名空间,未登记键即拒绝
 *     (拼写错误不得静默落默认);
 *  3. 取值非法:类型 / 范围 / 枚举校验,配置不得超过天花板(默认值 +
 *     天花板双闸,D-API-31 同形态)。
 *
 * 独立凭证(硬约束,`docs/项目计划书.md:807`「提交凭证不得使用管理后台
 * 凭证或长期 URL 参数」的反向同一条):管理面凭证是 `ADMIN_` 命名空间下的
 * 独立值,**绝不复用会话凭证**(`SESSION_*` 签名 / 会话 token)与宿主后端
 * 令牌(`SESSION_API_HOST_BACKEND_TOKEN`)。本模块只读取 `ADMIN_` 与
 * `NODE_ENV`,对任何其他前缀零引用(测试锚点:凭证独立性机检)。
 * 凭证以 **sha256 摘要**形式入配置(`ADMIN_CREDENTIAL_SHA256`):进程内存
 * 与容器环境里都不存在明文凭证,呈递值比对走"双侧 sha256 + timingSafeEqual"
 * (长度差异折叠进摘要比较,长度侧信道零透出,与 `hostBackendTokenMatches`
 * 同款形态)。
 *
 * 校验失败消息只含字段名与原因,绝不含字段值(错误面不得成为密钥外泄通道)。
 * 空字符串环境变量一律按"未提供"处理(容器编排占位形态)。
 */
import { z } from "zod";
import { IDENTIFIER_CHARSET_PATTERN, OPAQUE_ID_MAX_LENGTH } from "@stackmaster/protocol";

/** 应用保留的环境变量前缀:未登记的 `ADMIN_*` 键触发启动拒绝。 */
const RESERVED_ENV_PREFIX = "ADMIN_";

/** 批量导出缺省(单页成绩记录条数;与 WP-78 `HOST_SCORES_BATCH` 同量级)。 */
export const DEFAULT_SCORES_BATCH = 100;
/** 批量导出的**查询层**天花板(WP-78 批量上限的 admin 侧同源口径)。 */
export const SCORES_BATCH_CEILING = 500;
/** 裁决列表单页天花板。 */
export const VERDICT_PAGE_CEILING = 500;
/** 裁决列表单页缺省。 */
export const DEFAULT_VERDICT_PAGE = 100;
/** 题目登记列表缺省条数。 */
export const DEFAULT_CHALLENGE_PAGE = 200;

/** 每客户端 IP 每分钟查询次数缺省(read-only 面的暴力猜凭证闸)。 */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;
/** 频率天花板(触顶配置值即拒绝启动,而非静默截断)。 */
export const RATE_LIMIT_PER_MINUTE_CEILING = 6_000;

/** 凭证摘要形态:小写十六进制 sha256。 */
export const CREDENTIAL_SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * 绑定租户白名单条数天花板(与 O-MP-6「单宿主 / 单租户或少量租户」部署
 * 口径一致:白名单是凭证 → 租户集合的绑定,不是租户目录的全量镜像)。
 */
export const MAX_BOUND_TENANTS = 64;

/** 优雅停机宽限缺省(秒)。 */
export const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS = 10;

/** 必备环境变量登记表(缺失即拒绝启动)。 */
const REQUIRED_ENV_KEYS: readonly string[] = [
  "ADMIN_POSTGRES_URL",
  "ADMIN_CREDENTIAL_SHA256",
];

/** 环境变量保留键集合(未知保留键 = 拼写错误,拒绝启动)。 */
const KNOWN_ENV_KEYS: readonly string[] = [
  "ADMIN_HOST",
  "ADMIN_PORT",
  "ADMIN_LOG_LEVEL",
  "ADMIN_LOG_ERROR_STACKS",
  "ADMIN_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS",
  "ADMIN_POSTGRES_URL",
  "ADMIN_CREDENTIAL_SHA256",
  "ADMIN_TENANTS",
  "ADMIN_SCORES_BATCH",
  "ADMIN_RATE_LIMIT_PER_MINUTE",
];

/**
 * 租户白名单条目:冻结标识符字符集(`OpaqueIdSchema` 同源,服务端签发
 * tenantId 天然满足)。白名单条目不合规 = 取值闸拒绝启动——**不得**
 * 静默丢弃非法条目(静默丢弃会让"我配了这个租户"与"管理面查不到该租户"
 * 变成不可区分的静默故障)。
 */
const TenantEntrySchema = z
  .string()
  .min(1)
  .max(OPAQUE_ID_MAX_LENGTH)
  .regex(IDENTIFIER_CHARSET_PATTERN, "租户标识符只允许 A-Z a-z 0-9 下划线与连字符");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ADMIN_HOST: z.string().min(1).default("127.0.0.1"),
  // PORT=0(临时端口)仅 NODE_ENV=test 合法——集成测试随机端口起真实进程。
  ADMIN_PORT: z.coerce.number().int().min(0).max(65535).default(3200),
  ADMIN_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  // 内部堆栈默认不入日志(受控排障的显式演进开关,D-API-9 同款)。
  ADMIN_LOG_ERROR_STACKS: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .default(false),
  ADMIN_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(300)
    .default(DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS),
  // 必备键(缺失由闸 1 上报;Schema 仅承担透传与类型闸)。
  ADMIN_POSTGRES_URL: z.string().min(1),
  ADMIN_CREDENTIAL_SHA256: z
    .string()
    .regex(CREDENTIAL_SHA256_PATTERN, "凭证摘要必须为小写十六进制 sha256(64 位)"),
  // 绑定租户白名单(O-MP-6 同源形态:逗号分隔;缺失 / 为空 = fail-closed,
  // 管理面数据查询整体 404 同形;非配置缺失即启动拒绝)。
  ADMIN_TENANTS: z.string().default(""),
  ADMIN_SCORES_BATCH: z.coerce
    .number()
    .int()
    .min(1)
    .max(SCORES_BATCH_CEILING)
    .default(DEFAULT_SCORES_BATCH),
  ADMIN_RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(RATE_LIMIT_PER_MINUTE_CEILING)
    .default(DEFAULT_RATE_LIMIT_PER_MINUTE),
});

/** admin 运行配置(启动校验后的冻结形态,进程内只读)。 */
export interface AdminConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  readonly logErrorStacks: boolean;
  readonly gracefulShutdownTimeoutSeconds: number;
  /** 管理面数据面连接串(独立只读角色 `admin_ro`;与 session-api / verifier 不共享凭证)。 */
  readonly postgresUrl: string;
  /** 管理面凭证的 sha256 摘要(小写十六进制;明文凭证不入进程内存)。 */
  readonly credentialSha256: string;
  /**
   * 凭证绑定的租户白名单(去重、保序)。**为空数组 = 管理面数据查询整体
   * 404 同形**(fail-closed,防枚举;与跨租户 / 不存在同形态)。
   */
  readonly tenants: readonly string[];
  /** 成绩导出单页条数(≤ 天花板)。 */
  readonly scoresBatch: number;
  /** 每客户端 IP 每分钟查询次数上限。 */
  readonly rateLimitPerMinute: number;
}

/** 启动校验拒绝(issues 只含字段名与原因,不含字段值)。 */
export class ConfigValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`admin 启动被拒绝:配置校验失败(${issues.length} 项):${issues.join("; ")}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

/**
 * 解析绑定租户白名单:逗号分隔 → 去重保序。空串 / 全空白 = 空数组
 * (fail-closed 的配置态,不是配置错误——与 O-MP-6「白名单缺失或为空 ⇒
 * 数据面整体 404 同形」一致)。
 */
export function parseTenantWhitelist(raw: string): readonly string[] {
  const seen = new Set<string>();
  const tenants: string[] = [];
  for (const part of raw.split(",")) {
    const tenant = part.trim();
    if (tenant === "" || seen.has(tenant)) {
      continue;
    }
    seen.add(tenant);
    tenants.push(tenant);
  }
  return tenants;
}

export function loadAdminConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  requiredKeys: readonly string[] = REQUIRED_ENV_KEYS,
): AdminConfig {
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

  const raw = parsed.data;
  const tenants = parseTenantWhitelist(raw.ADMIN_TENANTS);

  // 闸 3 续:白名单条目逐条走冻结标识符字符集(非法条目拒绝启动,不静默丢弃)。
  if (tenants.length > MAX_BOUND_TENANTS) {
    issues.push(
      `字段 ADMIN_TENANTS:绑定租户条数 ${tenants.length} 超过天花板 ${MAX_BOUND_TENANTS}(凭证 → 租户集合绑定,非租户目录镜象)`,
    );
  }
  for (const tenant of tenants) {
    if (!TenantEntrySchema.safeParse(tenant).success) {
      issues.push(`字段 ADMIN_TENANTS:条目不合规(冻结标识符字符集 / 长度上限)`);
      break;
    }
  }
  // PORT=0(临时端口)仅测试环境合法(与 session-api / verifier 同一裁决点)。
  if (raw.ADMIN_PORT === 0 && raw.NODE_ENV !== "test") {
    issues.push("字段 ADMIN_PORT:0(临时端口)仅允许 NODE_ENV=test");
  }
  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }

  return {
    nodeEnv: raw.NODE_ENV,
    host: raw.ADMIN_HOST,
    port: raw.ADMIN_PORT,
    logLevel: raw.ADMIN_LOG_LEVEL,
    logErrorStacks: raw.ADMIN_LOG_ERROR_STACKS,
    gracefulShutdownTimeoutSeconds: raw.ADMIN_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS,
    postgresUrl: raw.ADMIN_POSTGRES_URL,
    credentialSha256: raw.ADMIN_CREDENTIAL_SHA256,
    tenants,
    scoresBatch: raw.ADMIN_SCORES_BATCH,
    rateLimitPerMinute: raw.ADMIN_RATE_LIMIT_PER_MINUTE,
  };
}

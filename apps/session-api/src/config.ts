/**
 * 运行配置加载与启动校验(WP-1 工程载体;计划书 5.8 密钥管理,fail-closed)。
 *
 * 启动校验三道闸,任一不过即以 ConfigValidationError 拒绝启动(进程非零退出):
 *  1. 必备键缺失:REQUIRED_ENV_KEYS 登记表中的键未提供——机制先行,WP-2 / WP-3
 *     落地签发密钥、存储端点时在此登记(权威 API 语义规约 D-API-9);
 *  2. 未知保留键:`SESSION_API_` 前缀是本应用保留命名空间,出现未登记键即拒绝
 *     ——拼写错误不得静默落到默认值(fail-closed);
 *  3. 取值非法:类型 / 范围 / 枚举校验,含 D-API-4 的两个运维参数
 *     (N-1 版本窗口天数、幂等窗口 TTL)。
 *
 * 校验失败消息只含字段名与原因,绝不含字段值——配置值可能是未来的密钥,
 * 错误面不得成为密钥外泄通道(9.1 受控日志纪律的启动期对应物)。
 *
 * 空字符串环境变量一律按"未提供"处理(容器编排的常见占位形态),走默认值
 * 或触发必备键缺失,不进入取值校验。
 */
import { createPrivateKey } from "node:crypto";
import {
  MAX_CHECKPOINTS_PER_SESSION,
  MAX_EMBED_TOKEN_TTL_SECONDS,
  MAX_SESSION_CREDENTIAL_TTL_SECONDS,
  MAX_WSS_FRAME_BYTES,
} from "@stackmaster/protocol";
import { z } from "zod";

/** 应用保留的环境变量前缀:未登记的 `SESSION_API_*` 键触发启动拒绝。 */
const RESERVED_ENV_PREFIX = "SESSION_API_";

/** D-API-4:N-1 版本窗口默认时长(天);`0` = 立即下线旧版(合法取值)。 */
export const DEFAULT_N1_WINDOW_DAYS = 90;

/** D-API-4:幂等窗口 TTL 默认值(秒);语义见会话编排语义规约 D-W8-9。 */
export const DEFAULT_IDEMPOTENCY_WINDOW_TTL_SECONDS = 300;

/** 默认宽限停机超时(秒):超过即强制退出(退出码 1),防止进程悬挂。 */
export const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS = 10;

/** WP-3:快照加密密钥字节长度(AES-256-GCM 要求 32 字节;base64 编码提供)。 */
export const SNAPSHOT_ENCRYPTION_KEY_BYTES = 32;

/** WP-3:快照保留期默认值(天;计划书 5.7"保留策略:会话与快照保留期可配置")。 */
export const DEFAULT_SNAPSHOT_RETENTION_DAYS = 30;

/** WP-3:周期性自动快照默认触发间隔(revision 数;D-API-25,6.3 周期性 COW 快照)。 */
export const DEFAULT_AUTO_SNAPSHOT_EVERY_REVISIONS = 50;

/** WP-3:MinIO 对象存储端口与桶名默认值。 */
export const DEFAULT_MINIO_PORT = 9000;
export const DEFAULT_MINIO_BUCKET_PRIVATE = "private-bundles";
export const DEFAULT_MINIO_BUCKET_PUBLIC = "public-descriptors";

/** WP-2:embed token 签发 TTL 默认值(秒);上限 = MAX_EMBED_TOKEN_TTL_SECONDS(604800)。 */
export const DEFAULT_EMBED_TOKEN_TTL_SECONDS = 3600;

/** WP-2:会话凭证签发 TTL 默认值(秒);上限 = MAX_SESSION_CREDENTIAL_TTL_SECONDS(86400)。 */
export const DEFAULT_SESSION_CREDENTIAL_TTL_SECONDS = 3600;

/** WP-4 请求护栏(8.3 纪律;D-API-31):数值护栏 = 常量默认值 + 配置上限
 * 双闸形态,配置不得超过天花板(配置闸 Schema `max` = 天花板常量,超限拒绝启动)。
 */
/** 单请求体字节上限默认值(命令体最坏形态 = embedToken 4096 字符 + 信封,64 KiB 充裕)。 */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 65536;
/** 单请求体字节天花板(fastify bodyLimit 配置上限;与单帧协议护栏同值)。 */
export const REQUEST_BODY_BYTES_CEILING = MAX_WSS_FRAME_BYTES;
/** 请求体 JSON 嵌套深度默认值(命令体最坏深度 ≈ 4;16 充裕)。 */
export const DEFAULT_MAX_JSON_DEPTH = 16;
/** 请求体 JSON 嵌套深度天花板。 */
export const MAX_JSON_DEPTH_CEILING = 64;
/** 单会话 clientSeq 预算默认值(协议 §4.4 实现期配置;教学会话 65536 步充裕)。 */
export const DEFAULT_MAX_CLIENT_SEQ_PER_SESSION = 65536;
/** 单会话 clientSeq 预算天花板。 */
export const MAX_CLIENT_SEQ_PER_SESSION_CEILING = 10_000_000;

/**
 * WP-5 WSS 通道(8.2 / D-API-42 ~ D-API-45):默认值 + 天花板双闸,
 * 与 WP-4 请求护栏同一形态。
 */
/** 心跳间隔默认值(秒;协议层 ping 周期,D-API-6 / D-API-42)。 */
export const DEFAULT_WSS_HEARTBEAT_INTERVAL_SECONDS = 30;
/** 心跳间隔天花板(秒)。 */
export const WSS_HEARTBEAT_INTERVAL_CEILING = 3600;
/** 空闲超时默认值(秒;pong / 入站消息静默判定,必须大于心跳间隔)。 */
export const DEFAULT_WSS_IDLE_TIMEOUT_SECONDS = 60;
/** 空闲超时天花板(秒)。 */
export const WSS_IDLE_TIMEOUT_CEILING = 86400;
/** 通道消息频率默认值(次/秒;令牌桶容量 = 速率,D-API-43;保守教学规模)。 */
export const DEFAULT_WSS_MESSAGE_RATE_PER_SECOND = 30;
/** 通道消息频率天花板(次/秒)。 */
export const WSS_MESSAGE_RATE_PER_SECOND_CEILING = 10000;
/** 发送缓冲帧数上限默认值(背压,D-API-44)。 */
export const DEFAULT_WSS_SEND_BUFFER_LIMIT = 256;
/** 发送缓冲帧数上限天花板。 */
export const WSS_SEND_BUFFER_LIMIT_CEILING = 10000;
/** 断线保持窗口默认值(秒;教学场景重连余量,D-API-45)。 */
export const DEFAULT_DISCONNECT_KEEPALIVE_SECONDS = 300;
/** 断线保持窗口天花板(秒)。 */
export const DISCONNECT_KEEPALIVE_CEILING = 86400;

/**
 * WP-6 限流、配额与会话资源回收(8.2 / 9.2 / D-API-50 ~ D-API-55):
 * 与 WP-4 / WP-5 同一形态——常量默认值 + 配置天花板双闸(保守默认 +
 * 配置化;超限 = 确定性拒绝 + 冻结错误形态)。
 */
/** 每租户 / 每用户请求频率默认值(次/分钟;rate:{tenant}:{user} 固定窗口)。 */
export const DEFAULT_RATE_LIMIT_REQUESTS_PER_MINUTE = 120;
/** 每租户 / 每用户请求频率天花板(次/分钟)。 */
export const RATE_LIMIT_REQUESTS_PER_MINUTE_CEILING = 100000;
/** 每租户并发会话预算默认值(教学规模保守值;D-API-52)。 */
export const DEFAULT_MAX_CONCURRENT_SESSIONS_PER_TENANT = 8;
/** 每租户并发会话预算天花板。 */
export const MAX_CONCURRENT_SESSIONS_PER_TENANT_CEILING = 10000;
/** 提交频率默认值(次/分钟,按 (tenant,user) 计量;D-API-50)。 */
export const DEFAULT_SUBMISSIONS_PER_MINUTE = 30;
/** 提交频率天花板(次/分钟)。 */
export const SUBMISSIONS_PER_MINUTE_CEILING = 100000;
/** 每会话 checkpoint 配额默认值 = 协议外圈护栏(配额必须 ≤ 协议上限,D-API-54)。 */
export const DEFAULT_MAX_CHECKPOINTS_PER_SESSION = MAX_CHECKPOINTS_PER_SESSION;
/** 每会话 checkpoint 配额天花板 = 协议上限(256;契约层硬顶)。 */
export const MAX_CHECKPOINTS_PER_SESSION_CEILING = MAX_CHECKPOINTS_PER_SESSION;
/** 单快照信封字节预算默认值(1 MiB;引擎状态信封最坏形态的保守外圈)。 */
export const DEFAULT_SNAPSHOT_BYTE_BUDGET = 1048576;
/** 单快照信封字节预算天花板(64 MiB)。 */
export const SNAPSHOT_BYTE_BUDGET_CEILING = 67108864;
/** 每租户存储配额默认值(256 MiB 已持久化快照密文;D-API-54)。 */
export const DEFAULT_TENANT_STORAGE_QUOTA_BYTES = 268435456;
/** 每租户存储配额天花板(1 TiB)。 */
export const TENANT_STORAGE_QUOTA_BYTES_CEILING = 1099511627776;
/** 终态会话保留窗口默认值(天;与快照保留期同量级的保守默认,D-API-55)。 */
export const DEFAULT_TERMINAL_SESSION_RETENTION_DAYS = 30;
/** 终态会话保留窗口天花板(天)。 */
export const TERMINAL_SESSION_RETENTION_DAYS_CEILING = 3650;

/**
 * 阶段五 WP-50 公开描述包下发通道(8.3 / D-API-76):与 WP-4 ~ WP-6 同一
 * 形态——常量默认值 + 配置天花板双闸(配置超过天花板拒绝启动)。
 */
/** 公开描述包响应体字节上限默认值(256 KiB;公开 Schema 最坏形态 ≈ 数十 KiB,充裕)。 */
export const DEFAULT_MAX_DESCRIPTOR_BYTES = 262144;
/** 公开描述包响应体字节天花板(4 MiB;护栏防桶内对象被替换为巨型载荷)。 */
export const MAX_DESCRIPTOR_BYTES_CEILING = 4194304;

/**
 * 阶段六 WP-64 审计归档面(D-API-92):与既有面同一形态——常量默认值 +
 * 配置天花板双闸。归档是运维事件账(不上审计,D-API-90),运行事实走
 * 受控日志 + /metrics 计数器。
 */
/** 归档节拍默认值(秒;进程内定时面,D-API-92)。 */
export const DEFAULT_AUDIT_ARCHIVE_INTERVAL_SECONDS = 3600;
/** 归档节拍天花板(秒;7 天——超过即失去"定期"语义)。 */
export const AUDIT_ARCHIVE_INTERVAL_SECONDS_CEILING = 604800;
/** 单批归档行数默认值(切片窗口行上限;批越大对象越大,保守值)。 */
export const DEFAULT_AUDIT_ARCHIVE_BATCH = 10000;
/** 单批归档行数天花板。 */
export const AUDIT_ARCHIVE_BATCH_CEILING = 1000000;
/** 审计在线保留窗口默认值(天;切片上界 = now - 窗口;本阶段归档为副本形态,在线行不删)。 */
export const DEFAULT_AUDIT_RETENTION_DAYS = 30;
/** 审计在线保留窗口天花板(天;与终态会话保留窗口同档)。 */
export const AUDIT_RETENTION_DAYS_CEILING = 3650;
/** 审计归档桶缺省名(独立桶:审计副本与双包域分桶,最小授权面各自独立)。 */
export const DEFAULT_AUDIT_BUCKET = "audit-archive";

/**
 * 阶段六 WP-63 裁决重询限流(D-API-84 / D-API-86):与既有频率类同形——
 * 常量默认值 + 配置天花板双闸。数值复核归 WP-65(Q6,k6 证据驱动)。
 */
/** 裁决查询频率默认值(次/分钟;rate:{tenant}:{user}:verdict 固定窗口 60 s)。 */
export const DEFAULT_VERDICT_QUERIES_PER_MINUTE = 30;
/** 裁决查询频率天花板(次/分钟)。 */
export const VERDICT_QUERIES_PER_MINUTE_CEILING = 100000;

/**
 * 必备环境变量登记表(缺失即拒绝启动)。
 *
 * WP-1 骨架期无必备密钥;WP-2 登记凭证签名密钥、WP-3 登记存储端点时逐项
 * 补入。登记键名必须带 `SESSION_API_` 前缀(保留命名空间,受未知键闸校验)。
 * WP-3 已登记(2026-09-10):PostgreSQL / Redis / MinIO 端点与快照加密密钥;
 * WP-2 已登记(2026-09-10):凭证签名密钥(Ed25519 PEM)与签发端点宿主后端
 * 共享凭证(bearer)。
 */
const REQUIRED_ENV_KEYS: readonly string[] = [
  // WP-2:embed token / 会话凭证的签名私钥(仅信任域 2 可达,D-API-10)。
  "SESSION_API_SIGNING_KEY",
  // WP-2:embed token 签发端点的宿主后端共享凭证(bearer;服务端间)。
  "SESSION_API_HOST_BACKEND_TOKEN",
  "SESSION_API_POSTGRES_URL",
  "SESSION_API_REDIS_URL",
  "SESSION_API_MINIO_ENDPOINT",
  "SESSION_API_MINIO_ACCESS_KEY",
  "SESSION_API_MINIO_SECRET_KEY",
  "SESSION_API_SNAPSHOT_ENCRYPTION_KEY",
];

/** 环境变量保留键集合(未知保留键 = 拼写错误,拒绝启动)。 */
const KNOWN_ENV_KEYS: readonly string[] = [
  "SESSION_API_HOST",
  "SESSION_API_PORT",
  "SESSION_API_LOG_LEVEL",
  "SESSION_API_LOG_ERROR_STACKS",
  "SESSION_PROTOCOL_N1_WINDOW_DAYS",
  "IDEMPOTENCY_WINDOW_TTL_SECONDS",
  "SESSION_API_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS",
  "SESSION_API_POSTGRES_URL",
  "SESSION_API_REDIS_URL",
  "SESSION_API_MINIO_ENDPOINT",
  "SESSION_API_MINIO_PORT",
  "SESSION_API_MINIO_ACCESS_KEY",
  "SESSION_API_MINIO_SECRET_KEY",
  "SESSION_API_MINIO_BUCKET_PRIVATE",
  "SESSION_API_MINIO_BUCKET_PUBLIC",
  "SESSION_API_SNAPSHOT_ENCRYPTION_KEY",
  "SESSION_API_SNAPSHOT_RETENTION_DAYS",
  "SESSION_API_AUTO_SNAPSHOT_EVERY_REVISIONS",
  // ── WP-2 认证与凭证面(2026-09-10)──
  "SESSION_API_SIGNING_KEY",
  "SESSION_API_HOST_BACKEND_TOKEN",
  "SESSION_API_ALLOWED_ORIGINS",
  "SESSION_API_EMBED_TOKEN_TTL_SECONDS",
  "SESSION_API_SESSION_CREDENTIAL_TTL_SECONDS",
  // ── WP-4 请求护栏与 clientSeq 预算(2026-09-10;D-API-31)──
  "SESSION_API_MAX_REQUEST_BODY_BYTES",
  "SESSION_API_MAX_JSON_DEPTH",
  "SESSION_API_MAX_CLIENT_SEQ_PER_SESSION",
  // ── WP-5 WSS 通道(2026-09-10;D-API-42 ~ D-API-45)──
  "SESSION_API_WSS_HEARTBEAT_INTERVAL_SECONDS",
  "SESSION_API_WSS_IDLE_TIMEOUT_SECONDS",
  "SESSION_API_WSS_MESSAGE_RATE_PER_SECOND",
  "SESSION_API_WSS_SEND_BUFFER_LIMIT",
  "SESSION_API_DISCONNECT_KEEPALIVE_SECONDS",
  // ── WP-6 限流、配额与会话资源回收(2026-09-10;D-API-50 ~ D-API-55)──
  "SESSION_API_RATE_LIMIT_REQUESTS_PER_MINUTE",
  "SESSION_API_MAX_CONCURRENT_SESSIONS_PER_TENANT",
  "SESSION_API_SUBMISSIONS_PER_MINUTE",
  "SESSION_API_MAX_CHECKPOINTS_PER_SESSION",
  "SESSION_API_SNAPSHOT_BYTE_BUDGET",
  "SESSION_API_TENANT_STORAGE_QUOTA_BYTES",
  "SESSION_API_TERMINAL_SESSION_RETENTION_DAYS",
  // ── 阶段五 WP-50 公开描述包下发通道(2026-09-11;D-API-76)──
  "SESSION_API_MAX_DESCRIPTOR_BYTES",
  // ── 阶段六 WP-64 审计归档面(2026-09-12;D-API-92)──
  "SESSION_API_AUDIT_ARCHIVE_INTERVAL_SECONDS",
  "SESSION_API_AUDIT_ARCHIVE_BATCH",
  "SESSION_API_AUDIT_RETENTION_DAYS",
  "SESSION_API_AUDIT_BUCKET",
  // ── 阶段六 WP-63 裁决重询限流(2026-09-12;D-API-84 / D-API-86)──
  "SESSION_API_VERDICT_QUERIES_PER_MINUTE",
];

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // 本应用自有键统一走 SESSION_API_ 保留前缀(与 KNOWN_ENV_KEYS 一一对应);
  // NODE_ENV 是 Node 运行时约定,N1 窗口 / 幂等 TTL 两键沿用 D-API-4 冻结键名。
  SESSION_API_HOST: z.string().min(1).default("127.0.0.1"),
  // PORT=0(临时端口)仅在 NODE_ENV=test 合法——集成测试以随机端口起真实进程。
  SESSION_API_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  SESSION_API_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  // 受控日志通道的演进开关:内部堆栈默认不入日志(阶段三任务分解 WP-1
  // redaction 纪律);显式开启仅在受控排障环境,默认值恒为 false。
  // 严格枚举而非 coerce.boolean:coerce 会把 "false" 判真(fail-closed 反例);
  // default 挂在枚举→布尔管道之后,取输出类型(false = 键缺席)。
  SESSION_API_LOG_ERROR_STACKS: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .default(false),
  SESSION_PROTOCOL_N1_WINDOW_DAYS: z.coerce.number().int().min(0).default(DEFAULT_N1_WINDOW_DAYS),
  IDEMPOTENCY_WINDOW_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_IDEMPOTENCY_WINDOW_TTL_SECONDS),
  SESSION_API_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(300)
    .default(DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS),
  // ── WP-3 持久化面(2026-09-10;端点与密钥为必备键,见 REQUIRED_ENV_KEYS)──
  SESSION_API_MINIO_PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_MINIO_PORT),
  SESSION_API_MINIO_BUCKET_PRIVATE: z.string().min(3).max(63).default(DEFAULT_MINIO_BUCKET_PRIVATE),
  SESSION_API_MINIO_BUCKET_PUBLIC: z.string().min(3).max(63).default(DEFAULT_MINIO_BUCKET_PUBLIC),
  SESSION_API_SNAPSHOT_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_SNAPSHOT_RETENTION_DAYS),
  SESSION_API_AUTO_SNAPSHOT_EVERY_REVISIONS: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_AUTO_SNAPSHOT_EVERY_REVISIONS),
  // WP-3 必备键(缺失由闸 1 上报;Schema 仅承担透传与类型闸——
  // 注意空字符串在进入 Schema 前已按"未提供"剔除)。
  SESSION_API_POSTGRES_URL: z.string().min(1),
  SESSION_API_REDIS_URL: z.string().min(1),
  SESSION_API_MINIO_ENDPOINT: z.string().min(1),
  SESSION_API_MINIO_ACCESS_KEY: z.string().min(1),
  SESSION_API_MINIO_SECRET_KEY: z.string().min(1),
  SESSION_API_SNAPSHOT_ENCRYPTION_KEY: z.string().min(1),
  // ── WP-2 认证与凭证面(2026-09-10;D-API-19 配置键登记)──
  // 签名私钥:Ed25519 PKCS#8 PEM(启动期按 createPrivateKey 解析 + 密钥类型
  // 校验,fail-closed;校验消息仅字段名与结构原因,绝不回显取值)。
  SESSION_API_SIGNING_KEY: z
    .string()
    .min(1)
    .superRefine((value, ctx) => {
      if (!isEd25519PrivateKeyPem(value)) {
        ctx.addIssue({ code: "custom", message: "必须是 Ed25519 私钥 PEM(PKCS#8)" });
      }
    }),
  // 宿主后端共享凭证:最低长度护栏(共享密钥不得过短;取值本身绝不回显)。
  SESSION_API_HOST_BACKEND_TOKEN: z.string().min(16, "宿主后端共享凭证过短(至少 16 字符)"),
  // CORS 精确来源白名单:逗号分隔;空缺 = 不允许任何跨源(默认 [],fail-closed)。
  SESSION_API_ALLOWED_ORIGINS: z
    .string()
    .superRefine((value, ctx) => {
      const origins = splitAllowedOrigins(value);
      if (origins.length === 0) {
        ctx.addIssue({ code: "custom", message: "至少提供一个精确来源,或直接不提供该键" });
      }
      for (const origin of origins) {
        if (!isExactOrigin(origin)) {
          ctx.addIssue({
            code: "custom",
            message: "每一项必须是形如 https://host[:port] 的精确来源(禁通配、禁路径、禁尾斜杠)",
          });
        }
      }
    })
    .optional(),
  SESSION_API_EMBED_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_EMBED_TOKEN_TTL_SECONDS)
    .default(DEFAULT_EMBED_TOKEN_TTL_SECONDS),
  SESSION_API_SESSION_CREDENTIAL_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_SESSION_CREDENTIAL_TTL_SECONDS)
    .default(DEFAULT_SESSION_CREDENTIAL_TTL_SECONDS),
  // ── WP-4 请求护栏(D-API-31):默认值 + 天花板双闸,配置不得超过天花板 ──
  SESSION_API_MAX_REQUEST_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(REQUEST_BODY_BYTES_CEILING)
    .default(DEFAULT_MAX_REQUEST_BODY_BYTES),
  SESSION_API_MAX_JSON_DEPTH: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_JSON_DEPTH_CEILING)
    .default(DEFAULT_MAX_JSON_DEPTH),
  SESSION_API_MAX_CLIENT_SEQ_PER_SESSION: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_CLIENT_SEQ_PER_SESSION_CEILING)
    .default(DEFAULT_MAX_CLIENT_SEQ_PER_SESSION),
  // ── WP-5 WSS 通道(D-API-42 ~ D-API-45):默认值 + 天花板双闸 ──
  SESSION_API_WSS_HEARTBEAT_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(WSS_HEARTBEAT_INTERVAL_CEILING)
    .default(DEFAULT_WSS_HEARTBEAT_INTERVAL_SECONDS),
  SESSION_API_WSS_IDLE_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(WSS_IDLE_TIMEOUT_CEILING)
    .default(DEFAULT_WSS_IDLE_TIMEOUT_SECONDS),
  SESSION_API_WSS_MESSAGE_RATE_PER_SECOND: z.coerce
    .number()
    .int()
    .min(1)
    .max(WSS_MESSAGE_RATE_PER_SECOND_CEILING)
    .default(DEFAULT_WSS_MESSAGE_RATE_PER_SECOND),
  SESSION_API_WSS_SEND_BUFFER_LIMIT: z.coerce
    .number()
    .int()
    .min(1)
    .max(WSS_SEND_BUFFER_LIMIT_CEILING)
    .default(DEFAULT_WSS_SEND_BUFFER_LIMIT),
  SESSION_API_DISCONNECT_KEEPALIVE_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(DISCONNECT_KEEPALIVE_CEILING)
    .default(DEFAULT_DISCONNECT_KEEPALIVE_SECONDS),
  // ── WP-6 限流、配额与会话资源回收(D-API-50 ~ D-API-55):默认值 + 天花板双闸 ──
  SESSION_API_RATE_LIMIT_REQUESTS_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(RATE_LIMIT_REQUESTS_PER_MINUTE_CEILING)
    .default(DEFAULT_RATE_LIMIT_REQUESTS_PER_MINUTE),
  SESSION_API_MAX_CONCURRENT_SESSIONS_PER_TENANT: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_CONCURRENT_SESSIONS_PER_TENANT_CEILING)
    .default(DEFAULT_MAX_CONCURRENT_SESSIONS_PER_TENANT),
  SESSION_API_SUBMISSIONS_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(SUBMISSIONS_PER_MINUTE_CEILING)
    .default(DEFAULT_SUBMISSIONS_PER_MINUTE),
  // 配额必须 ≤ 协议外圈护栏(天花板 = MAX_CHECKPOINTS_PER_SESSION = 256;
  // 权威 API 语义规约 §四登记表的契约前提)。
  SESSION_API_MAX_CHECKPOINTS_PER_SESSION: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_CHECKPOINTS_PER_SESSION_CEILING)
    .default(DEFAULT_MAX_CHECKPOINTS_PER_SESSION),
  SESSION_API_SNAPSHOT_BYTE_BUDGET: z.coerce
    .number()
    .int()
    .min(1)
    .max(SNAPSHOT_BYTE_BUDGET_CEILING)
    .default(DEFAULT_SNAPSHOT_BYTE_BUDGET),
  SESSION_API_TENANT_STORAGE_QUOTA_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(TENANT_STORAGE_QUOTA_BYTES_CEILING)
    .default(DEFAULT_TENANT_STORAGE_QUOTA_BYTES),
  SESSION_API_TERMINAL_SESSION_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(TERMINAL_SESSION_RETENTION_DAYS_CEILING)
    .default(DEFAULT_TERMINAL_SESSION_RETENTION_DAYS),
  // ── 阶段五 WP-50 公开描述包下发通道(D-API-76):默认值 + 天花板双闸 ──
  SESSION_API_MAX_DESCRIPTOR_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_DESCRIPTOR_BYTES_CEILING)
    .default(DEFAULT_MAX_DESCRIPTOR_BYTES),
  // ── 阶段六 WP-64 审计归档面(D-API-92):默认值 + 天花板双闸 ──
  SESSION_API_AUDIT_ARCHIVE_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(AUDIT_ARCHIVE_INTERVAL_SECONDS_CEILING)
    .default(DEFAULT_AUDIT_ARCHIVE_INTERVAL_SECONDS),
  SESSION_API_AUDIT_ARCHIVE_BATCH: z.coerce
    .number()
    .int()
    .min(1)
    .max(AUDIT_ARCHIVE_BATCH_CEILING)
    .default(DEFAULT_AUDIT_ARCHIVE_BATCH),
  SESSION_API_AUDIT_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(AUDIT_RETENTION_DAYS_CEILING)
    .default(DEFAULT_AUDIT_RETENTION_DAYS),
  SESSION_API_AUDIT_BUCKET: z.string().min(3).max(63).default(DEFAULT_AUDIT_BUCKET),
  // ── 阶段六 WP-63 裁决重询限流(D-API-84 / D-API-86):默认值 + 天花板双闸 ──
  SESSION_API_VERDICT_QUERIES_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(VERDICT_QUERIES_PER_MINUTE_CEILING)
    .default(DEFAULT_VERDICT_QUERIES_PER_MINUTE),
});

/** 会话编排器运行配置(启动校验后的冻结形态,进程内只读)。 */
export interface SessionApiConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  /** 内部堆栈是否入受控日志(默认 false,纪律见 logger.ts)。 */
  readonly logErrorStacks: boolean;
  /** D-API-4:N-1 版本窗口时长(天);0 = 立即下线旧版。 */
  readonly n1WindowDays: number;
  /** D-API-4:幂等窗口 TTL(秒);语义不变(D-W8-9)。 */
  readonly idempotencyWindowTtlSeconds: number;
  /** 优雅停机宽限超时(秒);超时强制退出码 1。 */
  readonly gracefulShutdownTimeoutSeconds: number;
  // ── WP-3 持久化面 ──
  /** PostgreSQL 连接串(唯一权威存储;ADR-4)。 */
  readonly postgresUrl: string;
  /** Redis 连接串(只存可重建、带 TTL 状态;不作权威)。 */
  readonly redisUrl: string;
  /** MinIO / S3 端点(私有判题包、公开描述包;静态加密与最小权限归桶策略)。 */
  readonly minioEndpoint: string;
  readonly minioPort: number;
  readonly minioAccessKey: string;
  readonly minioSecretKey: string;
  /** 私有判题包桶(服务端专用;默认 private-bundles)。 */
  readonly minioBucketPrivate: string;
  /** 公开描述包桶(CDN 发布归阶段五;默认 public-descriptors)。 */
  readonly minioBucketPublic: string;
  /**
   * 快照应用层整包加密密钥(AES-256-GCM;base64 编码的 32 字节;D-W8-11,
   * D-API-21)。仅启动期做形态校验,值本身绝不入日志与错误消息。
   */
  readonly snapshotEncryptionKey: string;
  /** 快照保留期(天;计划书 5.7 保留策略)。 */
  readonly snapshotRetentionDays: number;
  /** 周期性自动快照触发间隔(revision 数;D-API-25)。 */
  readonly autoSnapshotEveryRevisions: number;
  // ── WP-2 认证与凭证面 ──
  /**
   * 凭证签名私钥(Ed25519 PKCS#8 PEM;D-API-10)。仅信任域 2 可达,
   * 绝不入日志与错误响应(调用纪律 + logger redact 兜底)。
   */
  readonly signingKey: string;
  /** embed token 签发端点的宿主后端共享凭证(bearer;比较走常数时间路径)。 */
  readonly hostBackendToken: string;
  /** CORS 精确来源白名单;空数组 = 不允许任何跨源(fail-closed 默认)。 */
  readonly allowedOrigins: readonly string[];
  /** embed token 签发 TTL(秒);≤ MAX_EMBED_TOKEN_TTL_SECONDS(协议外圈护栏)。 */
  readonly embedTokenTtlSeconds: number;
  /** 会话凭证签发 TTL(秒);≤ MAX_SESSION_CREDENTIAL_TTL_SECONDS(协议外圈护栏)。 */
  readonly sessionCredentialTtlSeconds: number;
  // ── WP-4 请求护栏(D-API-31)──
  /** 单请求体字节上限(fastify bodyLimit);≤ REQUEST_BODY_BYTES_CEILING。 */
  readonly maxRequestBodyBytes: number;
  /** 请求体 JSON 嵌套深度上限;≤ MAX_JSON_DEPTH_CEILING。 */
  readonly maxJsonDepth: number;
  /** 单会话 clientSeq 预算(协议 §4.4);触顶确定性拒绝,恢复 = 重新 create_session。 */
  readonly maxClientSeqPerSession: number;
  // ── WP-5 WSS 通道(D-API-42 ~ D-API-45)──
  /** 心跳间隔(秒;RFC 6455 协议层 ping 周期,D-API-6)。 */
  readonly wssHeartbeatIntervalSeconds: number;
  /** 空闲超时(秒;pong / 入站消息静默判定;恒大于心跳间隔)。 */
  readonly wssIdleTimeoutSeconds: number;
  /** 通道消息频率(次/秒;令牌桶容量 = 速率,D-API-43)。 */
  readonly wssMessageRatePerSecond: number;
  /** 发送缓冲帧数上限(背压,D-API-44)。 */
  readonly wssSendBufferLimit: number;
  /** 断线保持窗口(秒;到期回收执行面归 WP-6,D-API-45)。 */
  readonly disconnectKeepaliveSeconds: number;
  // ── WP-6 限流、配额与会话资源回收(D-API-50 ~ D-API-55)──
  /** 每租户 / 每用户请求频率(次/分钟;rate:{tenant}:{user} 固定窗口 60 s)。 */
  readonly rateLimitRequestsPerMinute: number;
  /** 每租户并发会话预算(在途会话数上限;D-API-52)。 */
  readonly maxConcurrentSessionsPerTenant: number;
  /** 提交频率(次/分钟;按 (tenant,user) 计量的固定窗口)。 */
  readonly submissionsPerMinute: number;
  /** 每会话 checkpoint 配额(≤ 协议 MAX_CHECKPOINTS_PER_SESSION;D-API-54)。 */
  readonly maxCheckpointsPerSession: number;
  /** 单快照信封字节预算(信封规范化 JSON 字节口径;D-API-54)。 */
  readonly snapshotByteBudget: number;
  /** 每租户已持久化快照字节配额(checkpoints 行密文字节合计口径;D-API-54)。 */
  readonly tenantStorageQuotaBytes: number;
  /** 终态会话保留窗口(天;可调用清理入口驱动,T0 无 cron;D-API-55)。 */
  readonly terminalSessionRetentionDays: number;
  // ── 阶段五 WP-50 公开描述包下发通道(D-API-76)──
  /** 公开描述包响应体字节上限(桶内对象取回后、解析前强制);≤ MAX_DESCRIPTOR_BYTES_CEILING。 */
  readonly maxDescriptorBytes: number;
  // ── 阶段六 WP-64 审计归档面(D-API-92)──
  /** 审计归档节拍(秒;进程内定时面);≤ AUDIT_ARCHIVE_INTERVAL_SECONDS_CEILING。 */
  readonly auditArchiveIntervalSeconds: number;
  /** 单批归档行数上限(切片窗口);≤ AUDIT_ARCHIVE_BATCH_CEILING。 */
  readonly auditArchiveBatch: number;
  /** 审计在线保留窗口(天;切片上界 = now - 窗口;副本形态在线行不删);≤ AUDIT_RETENTION_DAYS_CEILING。 */
  readonly auditRetentionDays: number;
  /** 审计归档桶(独立桶;缺省 audit-archive)。 */
  readonly auditBucket: string;
  // ── 阶段六 WP-63 裁决重询限流(D-API-84 / D-API-86)──
  /** 裁决查询频率(次/分钟;rate:{tenant}:{user}:verdict 固定窗口 60 s)。 */
  readonly verdictQueriesPerMinute: number;
}

/** 启动校验拒绝(issues 只含字段名与原因,不含字段值)。 */
export class ConfigValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    // message 携带全部条目(仅字段名与原因,绝不含字段值),使
    // `toThrow(/字段名/)` 与 stderr 单行输出共享同一信息面。
    super(
      `session-api 启动被拒绝:配置校验失败(${issues.length} 项):${issues.join("; ")}`,
    );
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join(".") : "(顶层)";
    return `字段 ${field}:${issue.message}`;
  });
}

/**
 * 加载并校验运行配置。
 *
 * @param env 环境变量源(默认 process.env;测试注入字面对象)。
 * @param requiredKeys 必备键登记表(默认模块级 REQUIRED_ENV_KEYS;测试注入
 *   合成键以验证缺失拒绝路径)。
 */
export function loadSessionApiConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  requiredKeys: readonly string[] = REQUIRED_ENV_KEYS,
): SessionApiConfig {
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
  const missingKeys = requiredKeys
    .filter((key) => !(key in provided))
    .sort();
  for (const key of missingKeys) {
    issues.push(`字段 ${key}:必备环境变量缺失`);
  }

  const parsed = envSchema.safeParse(provided);
  if (!parsed.success) {
    issues.push(...formatZodIssues(parsed.error));
    throw new ConfigValidationError(issues);
  }

  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }

  const raw = parsed.data;

  // PORT=0(临时端口)仅测试环境合法;独立于 Schema 闸,保证取值与环境的
  // 组合约束有唯一裁决点。
  if (raw.SESSION_API_PORT === 0 && raw.NODE_ENV !== "test") {
    throw new ConfigValidationError([
      "字段 SESSION_API_PORT:0(临时端口)仅允许 NODE_ENV=test",
    ]);
  }

  // WSS 心跳 / 空闲组合约束:空闲超时必须大于心跳间隔(否则每个心跳节拍都
  // 判定空闲;D-API-42 的唯一裁决点,与 PORT 组合闸同形态)。
  if (raw.SESSION_API_WSS_IDLE_TIMEOUT_SECONDS <= raw.SESSION_API_WSS_HEARTBEAT_INTERVAL_SECONDS) {
    throw new ConfigValidationError([
      "字段 SESSION_API_WSS_IDLE_TIMEOUT_SECONDS:必须大于 SESSION_API_WSS_HEARTBEAT_INTERVAL_SECONDS(空闲判定以心跳节拍驱动)",
    ]);
  }

  // WP-3(D-W8-11 / D-API-21):快照加密密钥形态校验——base64 可解码且恰为
  // 32 字节(AES-256)。仅校验长度与编码,绝不回显任何取值片段。
  const keyIssues = validateSnapshotEncryptionKeyShape(provided["SESSION_API_SNAPSHOT_ENCRYPTION_KEY"]);
  if (keyIssues !== null) {
    throw new ConfigValidationError([`字段 SESSION_API_SNAPSHOT_ENCRYPTION_KEY:${keyIssues}`]);
  }

  return {
    nodeEnv: raw.NODE_ENV,
    host: raw.SESSION_API_HOST,
    port: raw.SESSION_API_PORT,
    logLevel: raw.SESSION_API_LOG_LEVEL,
    logErrorStacks: raw.SESSION_API_LOG_ERROR_STACKS,
    n1WindowDays: raw.SESSION_PROTOCOL_N1_WINDOW_DAYS,
    idempotencyWindowTtlSeconds: raw.IDEMPOTENCY_WINDOW_TTL_SECONDS,
    gracefulShutdownTimeoutSeconds: raw.SESSION_API_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS,
    postgresUrl: raw.SESSION_API_POSTGRES_URL,
    redisUrl: raw.SESSION_API_REDIS_URL,
    minioEndpoint: raw.SESSION_API_MINIO_ENDPOINT,
    minioPort: raw.SESSION_API_MINIO_PORT,
    minioAccessKey: raw.SESSION_API_MINIO_ACCESS_KEY,
    minioSecretKey: raw.SESSION_API_MINIO_SECRET_KEY,
    minioBucketPrivate: raw.SESSION_API_MINIO_BUCKET_PRIVATE,
    minioBucketPublic: raw.SESSION_API_MINIO_BUCKET_PUBLIC,
    snapshotEncryptionKey: raw.SESSION_API_SNAPSHOT_ENCRYPTION_KEY,
    snapshotRetentionDays: raw.SESSION_API_SNAPSHOT_RETENTION_DAYS,
    autoSnapshotEveryRevisions: raw.SESSION_API_AUTO_SNAPSHOT_EVERY_REVISIONS,
    signingKey: raw.SESSION_API_SIGNING_KEY,
    hostBackendToken: raw.SESSION_API_HOST_BACKEND_TOKEN,
    allowedOrigins:
      raw.SESSION_API_ALLOWED_ORIGINS === undefined
        ? []
        : splitAllowedOrigins(raw.SESSION_API_ALLOWED_ORIGINS),
    embedTokenTtlSeconds: raw.SESSION_API_EMBED_TOKEN_TTL_SECONDS,
    sessionCredentialTtlSeconds: raw.SESSION_API_SESSION_CREDENTIAL_TTL_SECONDS,
    maxRequestBodyBytes: raw.SESSION_API_MAX_REQUEST_BODY_BYTES,
    maxJsonDepth: raw.SESSION_API_MAX_JSON_DEPTH,
    maxClientSeqPerSession: raw.SESSION_API_MAX_CLIENT_SEQ_PER_SESSION,
    wssHeartbeatIntervalSeconds: raw.SESSION_API_WSS_HEARTBEAT_INTERVAL_SECONDS,
    wssIdleTimeoutSeconds: raw.SESSION_API_WSS_IDLE_TIMEOUT_SECONDS,
    wssMessageRatePerSecond: raw.SESSION_API_WSS_MESSAGE_RATE_PER_SECOND,
    wssSendBufferLimit: raw.SESSION_API_WSS_SEND_BUFFER_LIMIT,
    disconnectKeepaliveSeconds: raw.SESSION_API_DISCONNECT_KEEPALIVE_SECONDS,
    rateLimitRequestsPerMinute: raw.SESSION_API_RATE_LIMIT_REQUESTS_PER_MINUTE,
    maxConcurrentSessionsPerTenant: raw.SESSION_API_MAX_CONCURRENT_SESSIONS_PER_TENANT,
    submissionsPerMinute: raw.SESSION_API_SUBMISSIONS_PER_MINUTE,
    maxCheckpointsPerSession: raw.SESSION_API_MAX_CHECKPOINTS_PER_SESSION,
    snapshotByteBudget: raw.SESSION_API_SNAPSHOT_BYTE_BUDGET,
    tenantStorageQuotaBytes: raw.SESSION_API_TENANT_STORAGE_QUOTA_BYTES,
    terminalSessionRetentionDays: raw.SESSION_API_TERMINAL_SESSION_RETENTION_DAYS,
    maxDescriptorBytes: raw.SESSION_API_MAX_DESCRIPTOR_BYTES,
    auditArchiveIntervalSeconds: raw.SESSION_API_AUDIT_ARCHIVE_INTERVAL_SECONDS,
    auditArchiveBatch: raw.SESSION_API_AUDIT_ARCHIVE_BATCH,
    auditRetentionDays: raw.SESSION_API_AUDIT_RETENTION_DAYS,
    auditBucket: raw.SESSION_API_AUDIT_BUCKET,
    verdictQueriesPerMinute: raw.SESSION_API_VERDICT_QUERIES_PER_MINUTE,
  };
}

/**
 * 快照加密密钥形态校验(启动期;失败原因只描述结构,不含取值)。
 * 返回 null 表示合法;否则返回一句话原因。
 */
function validateSnapshotEncryptionKeyShape(value: string | undefined): string | null {
  if (value === undefined || value === "") {
    // 必备键缺失已由闸 1 上报,这里不重复报。
    return null;
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64");
  } catch {
    return "必须是 base64 编码的 32 字节密钥(解码失败)";
  }
  if (decoded.length !== SNAPSHOT_ENCRYPTION_KEY_BYTES) {
    return `必须是 base64 编码的 ${SNAPSHOT_ENCRYPTION_KEY_BYTES} 字节密钥(解码后长度不符)`;
  }
  return null;
}

/** WP-2:Ed25519 私钥 PEM 形态校验(可解析且密钥类型正确;不回显取值)。 */
function isEd25519PrivateKeyPem(value: string): boolean {
  try {
    return createPrivateKey(value).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

/** WP-2:逗号分隔的来源白名单拆分(去空白、去空项)。 */
function splitAllowedOrigins(value: string): readonly string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** WP-2:精确来源形态(URL 可解析、origin 与输入完全一致、仅 http/https)。 */
function isExactOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === value && (url.protocol === "https:" || url.protocol === "http:");
  } catch {
    return false;
  }
}

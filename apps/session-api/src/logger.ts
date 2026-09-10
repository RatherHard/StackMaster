/**
 * Pino 结构化日志工厂(WP-1 工程载体;计划书 5.8 / 9.1 的编排器落点,
 * ZR-B7 服务器侧登记,见 docs/develop/秘密零驻留CI检查项映射.md)。
 *
 * 字段纪律(计划书 5.8:请求 ID、会话 ID、租户、revision):
 *  - requestId 由 server.ts 的 genReqId 生成 / 净化,随每条请求日志自动在场;
 *  - sessionId / tenantId / revision 经 [`withSessionFields`] 白名单化绑定,
 *     防止零散字段命名漂移(编排逻辑 WP-4 / WP-5 接入时沿用)。
 *
 * redaction 纪律(三层,与"内部堆栈、文件路径、私有包内容、seed / flag 语料
 * 永不入日志"的 WP-1 门禁对应):
 *  - 绝对禁入:私有包内容、seed / flag 语料、凭证令牌——REDACT_PATHS 对浅层
 *    误放做兜底遮蔽(censor 为固定占位符,不回显长度);主控制是调用纪律:
 *    本服务永不记录请求 / 响应体原文与头部;
 *  - 内部堆栈与文件路径:err 序列化器只保留 type + message,堆栈默认不入日志
 *    (config.ts 的 LOG_ERROR_STACKS 为受控排障的显式演进开关,默认关闭);
 *  - 响应面:错误细节不经 HTTP 响应外流(server.ts 以冻结 `PublicError` 形态
 *    承接);ZR-B7 的浏览器可达响应面检查归阶段四 / 五运行时。
 *
 * pino 的路径通配只覆盖浅层(`key` / `*.key` / `*.key.*`);深层嵌套的兜底靠
 * "永不记录原文"的调用纪律——遮蔽路径是纵深防御,不是许可。
 */
import { pino, type Logger } from "pino";
import type { SessionApiConfig } from "./config.js";

/** 绝对禁入日志的字段名(值遮蔽;键名本身可入日志)。 */
const SECRET_FIELD_NAMES: readonly string[] = [
  "authorization",
  "cookie",
  "set-cookie",
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "password",
  "secret",
  "signingKey",
  "apiKey",
  "credential",
  "claims",
  "seed",
  "seedHex",
  "flag",
  "privateBundle",
];

/** 固定遮蔽占位符:不回显原值、不回显长度。 */
export const REDACTION_CENSOR = "[Redacted]";

/** pino redact 路径表(SECRET_FIELD_NAMES 派生:顶层与浅层嵌套,至多三层)。 */
export const REDACT_PATHS: readonly string[] = SECRET_FIELD_NAMES.flatMap((name) => [
  name,
  `*.${name}`,
  `*.${name}.*`,
  `*.*.${name}`,
]);

/**
 * 会话域一等日志字段(白名单;字段纪律的唯一入口)。
 * sessionId 等标识符的取值合法性由上游认证 / 会话表保证,这里只做形态约束。
 */
export interface SessionLogFields {
  readonly sessionId?: string;
  readonly tenantId?: string;
  readonly revision?: number;
}

/** 白名单化子 logger:编排逻辑记录会话域事件的统一入口(字段纪律)。 */
export function withSessionFields(log: Logger, fields: SessionLogFields): Logger {
  return log.child(fields);
}

/**
 * 错误序列化:只保留 type + message——内部堆栈与文件路径不入日志。
 * `stack` 字段受 config.logErrorStacks 显式开关控制(默认 false,受控排障用)。
 */
export function serializeError(err: unknown, includeStack = false): object {
  if (err instanceof Error) {
    const serialized: { type: string; message: string; stack?: string } = {
      type: err.name,
      message: err.message,
    };
    if (includeStack) {
      serialized.stack = err.stack;
    }
    return serialized;
  }
  return { type: "NonError", message: String(err) };
}

/**
 * 创建服务 logger。
 *
 * @param config 运行配置(level 与堆栈开关来源)。
 * @param destination 输出流(默认 stdout;测试注入捕获流)。
 */
export function createLogger(config: SessionApiConfig, destination?: NodeJS.WritableStream): Logger {
  return pino(
    {
      level: config.logLevel,
      // base 覆盖默认的 pid/hostname——主机名属基础设施指纹,不入日志。
      base: { app: "session-api", env: config.nodeEnv },
      redact: { paths: [...REDACT_PATHS], censor: REDACTION_CENSOR },
      serializers: {
        err: (err: unknown) => serializeError(err, config.logErrorStacks),
        // 请求对象白名单序列化:method / url 之外的一切(头部、连接细节)
        // 结构性不入日志;凭证不入 URL 是上游纪律(D-API-3 传输卫生)。
        req: (req: { method?: string; url?: string }) => ({
          method: req.method,
          url: req.url,
        }),
      },
    },
    destination,
  );
}

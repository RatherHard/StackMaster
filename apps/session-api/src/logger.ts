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
 * 请求 URL 的日志脱敏(WP-91;D-LT-3 ⓪ 项「查询串脱敏」的落地)。
 *
 * **为什么必须存在**:`req` 序列化器此前**原样打印 `req.url`(含查询串)**。
 * 而启动票据的承载方式(D-LT-2 方案 A)恰好把票据放在查询串里
 * (`?t=<ticket>`)⇒ 票据会随每一次换票请求落进访问日志。pino 的 `redact`
 * 是**按字段名**遮蔽的,对"值内嵌在字符串里的秘密"结构性无效 ⇒ 必须在
 * 序列化器里先剥掉。这是**应用侧**的处置;反代侧的脱敏是运维硬要求,
 * 但本仓库不给未实测的配置片段(D-API-138 纪律)。
 *
 * **取值选择 = 剥离整个查询串(而不是只 censor `t`)**:
 *  - 只 censor 已知的票据参数名(`LAUNCH_TICKET_QUERY_PARAM`)依赖"每一个
 *    未来出现的查询参数都被正确分类为是否携带秘密"——这正是本仓库反复踩过
 *    的**漂移面**(改一处忘一处)。整体剥离**结构性免疫**参数名漂移:无论
 *    以后谁加了什么参数,都不可能泄漏。
 *  - **代价如实登记**:日志丢失查询串内容。对本服务是可接受的 —— 查询串里
 *    的诊断信息(`cursor` / `limit` / `tenantId`)要么可从其它已记录字段
 *    重建,要么不是排障所必需;而**假阴性的代价是凭证泄漏**,两者不对称。
 *  - **刻意不发标记**:不输出 `?[Redacted]` 之类的占位符 —— 那会让日志面
 *    多一个"这里原本有查询串"的可观察位,而它对本控制的目的毫无贡献。
 *
 * **纯函数**(无 IO、无时钟、无随机),故可被单测穷举形态;主控制是
 * **运行时断言**(机检取日志捕获里的全部 `req.url`,断言不含票据)。
 *
 * fragment(`#`)一并剥离:`u` + `#` 之外的形态在生产 HTTP 请求行里不出现
 * (fragment 不过线路),但本函数是通用原语,不依赖该前提。
 */
export function redactRequestUrl(url: string | undefined): string | undefined {
  if (typeof url !== "string") {
    return url;
  }
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
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
        // 结构性不入日志。
        //
        // ⚠ **url 必须经 `redactRequestUrl`**(WP-91;D-LT-3 ⓪):此前这里是
        // `url: req.url` 原样透出,而启动票据的承载方式(D-LT-2 方案 A)把票据
        // 放在 `?t=` 里 ⇒ 票据会落访问日志。pino `redact` 按字段名遮蔽,对
        // "值内嵌在字符串里的秘密"无效,故剥离必须在**序列化器内**完成。
        // 该控制有**运行时断言**护航(test/launch/log-redaction.test.ts 取
        // 捕获日志的全部 req.url 断言不含票据),不靠这条注释。
        req: (req: { method?: string; url?: string }) => ({
          method: req.method,
          url: redactRequestUrl(req.url),
        }),
      },
    },
    destination,
  );
}

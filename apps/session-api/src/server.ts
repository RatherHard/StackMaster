/**
 * HTTP 服务装配(WP-1 工程载体骨架 + WP-4 全量装配挂载点)。
 *
 * 骨架面(WP-1,保持不动):健康检查 /healthz(liveness,恒 200)、请求 ID
 * 纪律、错误响应面兜底。WP-4 在此之上挂载(deps 注入形态,保持可测):
 *  - 认证插件(embed token 签发端点 + Cookie / CORS,D-API-11~17);
 *  - REST 生命周期路由(五个会话命令,D-API-1 / D-API-30);
 *  - readiness 端点 GET /readyz(D-API-9 预留的本阶段落地,D-API-34):
 *    探针注入(PG / Redis / MinIO 可达性),任一不可达 = 503 + 冻结
 *    PublicError,失败方不透出(细节只进受控日志)。
 *
 * 两条错误底线不变:
 *  - 一切错误响应 = 冻结 `PublicError` 形态(会话动作协议 §七 #8),零框架
 *    细节、零校验器细节透出——细节只进受控日志(9.1 / ZR-B7 服务器侧);
 *  - 错误载荷常量在装配期过一遍冻结 Schema 自检,契约漂移即拒绝启动。
 *
 * 请求 ID:接受客户端 `x-request-id`(宿主后端跨服务关联)但只接受冻结
 * 标识符字符集(语义文档 §2.1),非法或缺失即服务端生成——客户端输入永不
 * 原样进入日志字段(日志注入面收口)。
 */
import { randomUUID } from "node:crypto";
import fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyPluginAsync,
} from "fastify";
import {
  IDENTIFIER_CHARSET_PATTERN,
  OPAQUE_ID_MAX_LENGTH,
  PublicErrorSchema,
  type PublicError,
} from "@stackmaster/protocol";
import type { SessionApiConfig } from "./config.js";
import { REQUEST_TOO_LARGE_ERROR } from "./routes/error-mapping.js";
import { METRICS_ROUTE } from "./metrics/index.js";
import type { ReadinessProbe } from "./runtime/runtime.js";

/** 健康检查端点(liveness;恒 200,语义不变)。 */
export const HEALTH_ROUTE = "/healthz";

/** 指标端点路径(WP-8 挂载点;插件由 deps.metricsPlugin 注入,D-API-70)。 */
export { METRICS_ROUTE };

/** readiness 端点(D-API-9 预留:存储依赖可达性;任一不可达 503)。 */
export const READY_ROUTE = "/readyz";

/** 客户端请求 ID 头(受限字符集校验后回显,见 genReqId)。 */
const REQUEST_ID_HEADER = "x-request-id";

// 冻结 PublicError 形态的骨架期错误载荷(粗化级:只填 code + message;
// 静态文案,无任何内部细节)。装配期 Schema 自检,漂移即抛错拒绝启动。
const NOT_FOUND_ERROR: PublicError = PublicErrorSchema.parse({
  code: "invalid_input_format",
  message: "resource not found",
});
const INVALID_REQUEST_ERROR: PublicError = PublicErrorSchema.parse({
  code: "invalid_input_format",
  message: "invalid request",
});
const INTERNAL_ERROR_ERROR: PublicError = PublicErrorSchema.parse({
  code: "internal_error",
  message: "internal error",
});
/** readiness 失败的统一形态(全部探针失败同形,不透出失败方,D-API-34)。 */
const NOT_READY_ERROR: PublicError = PublicErrorSchema.parse({
  code: "internal_error",
  message: "dependencies unavailable",
});

/** 服务装配依赖(WP-4 挂载点;全部可选——骨架形态为零依赖缺省)。 */
export interface SessionApiServerDeps {
  /** 认证插件(embed token 签发端点 + Cookie / CORS;WP-2 装配)。 */
  readonly authPlugin?: FastifyPluginAsync;
  /** REST 生命周期路由插件(五个会话命令;WP-4 装配)。 */
  readonly sessionRoutes?: FastifyPluginAsync;
  /** WSS 动作通道插件(GET /sessions/channel;WP-5 装配,D-API-40)。 */
  readonly wssChannel?: FastifyPluginAsync;
  /** 指标端点插件(GET /metrics;WP-8 装配,D-API-70;缺省不挂载)。 */
  readonly metricsPlugin?: FastifyPluginAsync;
  /** readiness 探针(缺省 = 依赖未接线,readyz 恒 503)。 */
  readonly readinessProbes?: readonly ReadinessProbe[];
}

function sanitizedRequestId(raw: unknown): string {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  return (
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= OPAQUE_ID_MAX_LENGTH &&
    IDENTIFIER_CHARSET_PATTERN.test(candidate)
  )
    ? candidate
    : randomUUID();
}

/**
 * 装配 HTTP 服务(不监听;listen 由入口 main 负责,便于测试 inject)。
 * logger 参数取 FastifyBaseLogger(pino Logger 的结构子集):createLogger 的
 * 返回值天然满足,fastify 内部 child logger 推断不受 pino 全量类型漂移影响。
 */
export function buildServer(
  config: SessionApiConfig,
  logger: FastifyBaseLogger,
  deps: SessionApiServerDeps = {},
): FastifyInstance {
  const app = fastify({
    loggerInstance: logger,
    genReqId: (request) => sanitizedRequestId(request.headers[REQUEST_ID_HEADER]),
    // 请求护栏:请求体字节上限(8.3;config 数值护栏,D-API-31)。
    // 超限是框架级 413,错误兜底映射为冻结 PublicError。
    bodyLimit: config.maxRequestBodyBytes,
  });

  // 请求 ID 回显:跨服务关联面(宿主后端 → session-api)。genReqId 已把
  // 客户端输入净化为冻结字符集,回显值即日志 reqId,二者单一真源。
  app.addHook("onRequest", async (request, reply) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
  });

  app.get(HEALTH_ROUTE, async () => ({ status: "ok" }));

  // readiness(D-API-34):探针全部通过才 200;任一失败 503 + 统一冻结形态
  // (不透出失败方);未接线(无探针)同样 503——依赖未知不可谎报就绪。
  app.get(READY_ROUTE, async (request, reply) => {
    const probes = deps.readinessProbes ?? [];
    for (const probe of probes) {
      try {
        await probe.check();
      } catch (error) {
        request.log.error({ err: error, probe: probe.name }, "readiness probe failed");
        return reply.code(503).send(NOT_READY_ERROR);
      }
    }
    if (probes.length === 0) {
      return reply.code(503).send(NOT_READY_ERROR);
    }
    return { status: "ok" };
  });

  // 认证面与生命周期路由(deps 注入)。fastify 的 register 只排队插件,
  // 实际加载发生在 ready / listen;插件装配错误(如签名密钥非法)在该时刻
  // 上抛 → 装配错误路径,进程不进服务态(fail-closed)。
  if (deps.authPlugin !== undefined) {
    app.register(deps.authPlugin);
  }
  if (deps.sessionRoutes !== undefined) {
    app.register(deps.sessionRoutes);
  }
  if (deps.wssChannel !== undefined) {
    app.register(deps.wssChannel);
  }
  if (deps.metricsPlugin !== undefined) {
    app.register(deps.metricsPlugin);
  }

  // 未匹配路由(含方法不匹配):冻结 PublicError 形态,无框架默认报文。
  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send(NOT_FOUND_ERROR);
  });

  // 兜底错误处理:任何未捕获错误(含框架级 4xx,如畸形 JSON)一律冻结
  // 形态;原始错误只进受控日志(经 err 序列化器,堆栈默认剥离)。
  // 413(请求体超限)单列:请求护栏的冻结呈现(D-API-31)。
  app.setErrorHandler((fastifyError: FastifyError, request, reply) => {
    request.log.error({ err: fastifyError }, "request failed");
    const statusCode =
      typeof fastifyError.statusCode === "number" &&
      fastifyError.statusCode >= 400 &&
      fastifyError.statusCode < 500
        ? fastifyError.statusCode
        : 500;
    if (statusCode === 413) {
      return reply.code(413).send(REQUEST_TOO_LARGE_ERROR);
    }
    return reply
      .code(statusCode)
      .send(statusCode < 500 ? INVALID_REQUEST_ERROR : INTERNAL_ERROR_ERROR);
  });

  return app;
}

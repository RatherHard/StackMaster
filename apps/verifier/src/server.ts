/**
 * verifier 服务装配(WP-61):Fastify 最小运维面(healthz / readyz /
 * metrics;D-API-70 纪律延伸)与依赖注入图。
 *
 * 零业务路由、零浏览器可达面(信任域 4:独立凭证与网络域,呈现链路走
 * session-api 读裁决域,verifier 零查询面,D-API-83)。日志纪律沿 D-API-9:
 * Pino、base 覆盖基础设施指纹、错误面零内部细节。
 */
import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";

import type { VerifierMetrics } from "./metrics.js";

export interface ReadinessProbe {
  readonly name: string;
  check(): Promise<void>;
}

export interface VerifierServerOptions {
  readonly logger: Logger;
  readonly metrics: VerifierMetrics;
  readonly readinessProbes: readonly ReadinessProbe[];
}

export async function buildVerifierServer(
  options: VerifierServerOptions,
): Promise<FastifyInstance> {
  const { default: fastify } = await import("fastify");
  const server = fastify({
    // 运维面三路由走应用级 Pino(受控日志单一出口);框架内部日志静默。
    logger: false,
    // 零业务载荷面:最小请求体上限(运维面无请求体语义)。
    bodyLimit: 4096,
  });

  server.get("/healthz", async () => ({ status: "ok" }));

  server.get("/readyz", async (_request, reply) => {
    for (const probe of options.readinessProbes) {
      try {
        await probe.check();
      } catch (error) {
        // 失败方不透出(仅受控日志携带探针名,D-API-34 同款)。
        options.logger.warn(
          { probe: probe.name, err: error instanceof Error ? error.message : String(error) },
          "readiness probe failed",
        );
        await reply.code(503).send({
          code: "internal_error",
          message: "dependencies unavailable",
        });
        return reply;
      }
    }
    return { status: "ok" };
  });

  server.get("/metrics", async (_request, reply) => {
    const text = await options.metrics.render();
    await reply.type("text/plain; version=0.0.4; charset=utf-8").send(text);
    return reply;
  });

  return server;
}

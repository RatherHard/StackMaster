/**
 * admin 服务装配(D-MP-5 分支 A):Fastify 运维面(healthz / readyz /
 * metrics;D-API-70 纪律延伸,verifier 同款)+ 管理面只读路由 + 最小只读页。
 *
 * 纪律:
 *  - 三运维路由与 verifier 逐字同形(healthz 恒 200;readyz 探针失败 =
 *    503 冻结形态且**失败方不透出**;metrics = prometheus 文本);
 *  - **零业务写路由**:本服务注册的全部业务路由都是 GET(D-API-135);
 *  - 安全头统一注入(`http/security-headers.ts`,CSP `frame-ancestors 'none'`
 *    与插件链路分离);
 *  - 日志纪律沿 D-API-9:Pino、`logger: false`(框架内部日志静默,应用级
 *    Pino 是唯一出口)、错误面零内部细节。
 */
import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";

import { CONSOLE_CSS, CONSOLE_HTML, CONSOLE_JS } from "./console/page-source.js";
import { adminSecurityHeaders } from "./http/security-headers.js";
import type { AdminMetrics } from "./metrics.js";
import { ADMIN_ROUTES, buildAdminRoutes, type AdminRouteDeps } from "./routes/admin-routes.js";

export interface ReadinessProbe {
  readonly name: string;
  check(): Promise<void>;
}

export interface AdminServerOptions {
  readonly logger: Logger;
  readonly metrics: AdminMetrics;
  readonly readinessProbes: readonly ReadinessProbe[];
  /** 管理面只读路由依赖;未提供 = 只装配运维面(运维面单元测试形态)。 */
  readonly routes?: AdminRouteDeps;
  /** 最小只读页(缺省提供;测试可关)。 */
  readonly console?: boolean;
}

/** 最小只读页的静态资产路由(同源三份;零内联脚本 / 零内联样式)。 */
export const CONSOLE_ROUTES = {
  page: "/",
  script: "/admin.js",
  style: "/admin.css",
} as const;

export async function buildAdminServer(options: AdminServerOptions): Promise<FastifyInstance> {
  const { default: fastify } = await import("fastify");
  const server = fastify({
    // 运维面与只读面共用应用级 Pino(受控日志单一出口);框架内部日志静默。
    logger: false,
    // 零请求体语义(管理面全部 GET);最小上限即结构性拒绝任何请求体面。
    bodyLimit: 4096,
  });

  // 安全头统一注入(全部响应;常量单一来源 = http/security-headers.ts)。
  server.addHook("onSend", async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(adminSecurityHeaders())) {
      reply.header(name, value);
    }
    return payload;
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

  if (options.console !== false) {
    server.get(CONSOLE_ROUTES.page, async (_request, reply) => {
      await reply.type("text/html; charset=utf-8").send(CONSOLE_HTML);
      return reply;
    });
    server.get(CONSOLE_ROUTES.script, async (_request, reply) => {
      await reply.type("text/javascript; charset=utf-8").send(CONSOLE_JS);
      return reply;
    });
    server.get(CONSOLE_ROUTES.style, async (_request, reply) => {
      await reply.type("text/css; charset=utf-8").send(CONSOLE_CSS);
      return reply;
    });
  }

  if (options.routes !== undefined) {
    await server.register(buildAdminRoutes(options.routes));
  }

  return server;
}

/** 只读面路由清单(测试锚点:全部业务路由必须是 GET)。 */
export const ADMIN_DATA_ROUTES: readonly string[] = [
  ADMIN_ROUTES.challenges,
  ADMIN_ROUTES.verdicts,
  ADMIN_ROUTES.scores,
];

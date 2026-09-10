/**
 * /metrics 路由插件(阶段三 WP-8;D-API-70)。
 *
 * 挂载形态:Fastify 插件注入(server.ts deps.metricsPlugin),不触碰既有
 * 路由与错误面——/metrics 恒 200 + Prometheus 文本格式;未匹配路由与错误
 * 兜底路径不变(server.ts 骨架纪律)。响应体 = 白名单指标族的聚合值,
 * 零请求 / 响应体片段、零标识符、零秘密(标签纪律机检见 metrics.ts)。
 *
 * T0 边界登记:/metrics 与服务同端口、未认证(运维面);生产部署的暴露面
 * 收敛(内网段 / 反向代理准入 / 独立端口)是部署面配置事项,不是本端点的
 * 语义变更(D-API-70)。
 */
import type { FastifyPluginAsync } from "fastify";

import type { SessionMetrics } from "./metrics.js";

/** 指标端点路径(与既有 /healthz / /readyz 同族的运维路由)。 */
export const METRICS_ROUTE = "/metrics";

/** 构造 /metrics 插件:恒 200,Prometheus 文本格式(渲染失败 = 500 兜底面)。 */
export function buildMetricsPlugin(metrics: SessionMetrics): FastifyPluginAsync {
  return async (app) => {
    app.get(METRICS_ROUTE, async (_request, reply) => {
      const body = await metrics.render();
      void reply.header("content-type", metrics.contentType);
      return body;
    });
  };
}

/**
 * admin 指标面(D-MP-5 分支 A;D-API-70 / 71 纪律延伸,verifier 形态)。
 *
 * 指标族(标签有界枚举域,零秘密零标识符):
 *  - `admin_queries_total{surface,outcome}`(counter):只读面查询计数,
 *    surface ∈ {console, challenges, verdicts, scores}(冻结字面),
 *    outcome ∈ {ok, denied, not_found, rate_limited, error};
 *  - `admin_query_duration_seconds`(histogram):只读面单次查询时延;
 *  - `admin_bound_tenants`(gauge):**数量**(不是标识符)——绑定租户条数。
 *    只承载计数是刻意的:标签零标识符纪律(tenantId 进标签即把租户目录
 *    变成可读的时序侧信道,D-API-71 同族)。
 *
 * Registry 不采集默认进程指标;秘密语料对渲染输出零命中是测试锚点。
 */
import client from "prom-client";

/** 指标名白名单(渲染面机检的判定基准)。 */
export const METRIC_FAMILIES: readonly string[] = [
  "admin_queries_total",
  "admin_query_duration_seconds",
  "admin_bound_tenants",
];

/** 只读面枚举(有界;`console` = 静态只读页自身)。 */
export const ADMIN_SURFACES = ["console", "challenges", "verdicts", "scores"] as const;
export type AdminSurface = (typeof ADMIN_SURFACES)[number];

/** 查询结局枚举(有界;与响应状态码一一对应,零状态细节泄漏)。 */
export const ADMIN_OUTCOMES = [
  "ok",
  "denied",
  "not_found",
  "rate_limited",
  "error",
] as const;
export type AdminOutcome = (typeof ADMIN_OUTCOMES)[number];

export class AdminMetrics {
  readonly registry: client.Registry;
  readonly queriesTotal: client.Counter<string>;
  readonly queryDuration: client.Histogram<string>;
  readonly boundTenants: client.Gauge<string>;

  constructor() {
    this.registry = new client.Registry();
    this.queriesTotal = new client.Counter({
      name: "admin_queries_total",
      help: "Admin read-only surface queries",
      labelNames: ["surface", "outcome"],
      registers: [this.registry],
    });
    this.queryDuration = new client.Histogram({
      name: "admin_query_duration_seconds",
      help: "Admin read-only query duration",
      registers: [this.registry],
    });
    this.boundTenants = new client.Gauge({
      name: "admin_bound_tenants",
      help: "Number of credential-bound tenants (count only, never identifiers)",
      registers: [this.registry],
    });
  }

  recordQuery(surface: AdminSurface, outcome: AdminOutcome, seconds: number): void {
    this.queriesTotal.inc({ surface, outcome });
    this.queryDuration.observe(seconds);
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}

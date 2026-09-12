/**
 * verifier 指标面(WP-61;D-API-70 / 71 纪律延伸)。
 *
 * 指标族(标签有界枚举域,零秘密零标识符):
 *  - `verifier_queue_depth`(gauge):pending run 数(队列深度观察,
 *    D-API-72 语义延伸;数字进 T2 规模化判据);
 *  - `verifier_runs_total{outcome}`(counter):run 终态计数,
 *    outcome ∈ {completed, failed};
 *  - `verifier_verdicts_total{verdict}`(counter):裁决面计数,
 *    verdict ∈ 11 值冻结枚举(有界域);
 *  - `verifier_verify_duration_seconds`(histogram):单 run 裁决时延。
 *
 * Registry 不采集默认进程指标;秘密语料对渲染输出零命中是测试锚点。
 */
import client from "prom-client";

/** 指标名白名单(渲染面机检的判定基准)。 */
export const METRIC_FAMILIES: readonly string[] = [
  "verifier_queue_depth",
  "verifier_runs_total",
  "verifier_verdicts_total",
  "verifier_verify_duration_seconds",
];

export class VerifierMetrics {
  readonly registry: client.Registry;
  readonly queueDepth: client.Gauge<string>;
  readonly runsTotal: client.Counter<string>;
  readonly verdictsTotal: client.Counter<string>;
  readonly verifyDuration: client.Histogram<string>;

  constructor() {
    this.registry = new client.Registry();
    this.queueDepth = new client.Gauge({
      name: "verifier_queue_depth",
      help: "Pending verifier runs awaiting adjudication",
      registers: [this.registry],
    });
    this.runsTotal = new client.Counter({
      name: "verifier_runs_total",
      help: "Verifier run terminal states",
      labelNames: ["outcome"],
      registers: [this.registry],
    });
    this.verdictsTotal = new client.Counter({
      name: "verifier_verdicts_total",
      help: "Recorded verdicts by 11-value result type",
      labelNames: ["verdict"],
      registers: [this.registry],
    });
    this.verifyDuration = new client.Histogram({
      name: "verifier_verify_duration_seconds",
      help: "Per-run adjudication duration",
      registers: [this.registry],
    });
  }

  recordRunOutcome(outcome: "completed" | "failed"): void {
    this.runsTotal.inc({ outcome });
  }

  recordVerdict(verdict: string): void {
    this.verdictsTotal.inc({ verdict });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}

/**
 * 指标面最小集(阶段三 WP-8;计划书 5.8 可观测清单的 MVP 子集,D-API-70)。
 *
 * 指标族(Prometheus 文本格式,经 GET /metrics 暴露;阶段四 WP-41 增调试面):
 *   - session_api_action_rtt_seconds        动作 RTT(histogram;p50/p95 由分位计算)
 *   - session_api_live_sessions             并发会话数(gauge)
 *   - session_api_action_queue_depth        编排器动作队列深度(gauge;manager 在途动作调用数)
 *   - session_api_worker_processes          Worker 池占用(gauge;T0 每会话单进程,D-API-72)
 *   - session_api_projection_delta_bytes    投影增量字节数(histogram;已接受动作)
 *   - session_api_debug_worker_processes    调试 worker 占用(gauge;WP-41)
 *   - session_api_debug_frames_total        调试通道帧计数(counter;WP-41)
 *   - session_api_debug_budget_rejections_total  调试帧限额拒绝计数(counter;挤占观察)
 *
 * 标签纪律(D-API-71,机检可断言):
 *  - 指标名与标签名取白名单(METRIC_FAMILIES;`assertMetricsTextDiscipline`
 *    对 /metrics 输出逐行机检,越名 / 越标签即违例,红灯反例证明可检出);
 *  - 标签值只允许有界枚举域:action ∈ 12 冻结动作类型(+ `other` 兜底),
 *    outcome ∈ {accepted, rejected, error}——基数恒定,与流量规模无关;
 *  - **会话 ID / 用户 / 租户 / 题目标识不入标签**(Prometheus 基数爆炸防护),
 *    这些维度只进受控日志(Pino 白名单化字段,D-API-9 日志纪律);
 *  - 指标载荷零秘密:聚合数值 + 有界枚举,不含任何请求 / 响应体片段;
 *    `scanSecretCorpus`(ZR-B1 / B6 语料)对渲染输出零命中是测试锚点。
 *
 * 本模块是纯观测面:任何指标调用不得改变既有路由 / 错误 / 编排行为;
 * prom-client Registry 不采集默认进程指标——/metrics 上出现的指标名全部
 * 落在白名单内(不泄露内部细节的机检前提)。
 */
import client from "prom-client";

import { scanSecretCorpus } from "../persistence/secret-scanner.js";

/** 12 冻结动作类型(与会话动作协议 `ActionObjectSchema` 判别字面量同源;
 * 机检白名单的有界域;协议演进时在此同步,未登记类型折叠为 `other`)。 */
export const KNOWN_ACTION_TYPES: ReadonlySet<string> = new Set([
  "write_bytes",
  "push",
  "pop",
  "call",
  "ret",
  "step",
  "run_to_event",
  "pause",
  "undo",
  "checkout_checkpoint",
  "create_checkpoint",
  "reset",
]);

/** 动作结果类(有界三值;`error` = 编排器域异常,细节只进受控日志)。 */
export type ActionOutcome = "accepted" | "rejected" | "error";

/** 白名单:指标族 → (help, 允许的标签名集合)。标签值域另有有界枚举约束。 */
export interface MetricFamilySpec {
  readonly name: string;
  readonly help: string;
  readonly labels: readonly string[];
  readonly type: "histogram" | "gauge" | "counter";
}

export const METRIC_FAMILIES: readonly MetricFamilySpec[] = [
  {
    name: "session_api_action_rtt_seconds",
    help: "动作往返时长(manager.applyAction 入口到响应/异常;秒)",
    labels: ["action", "outcome"],
    type: "histogram",
  },
  {
    name: "session_api_live_sessions",
    help: "并发会话数(在途会话管理器持有量)",
    labels: [],
    type: "gauge",
  },
  {
    name: "session_api_action_queue_depth",
    help: "编排器动作队列深度(manager 在途动作调用数;单会话串行上限为逐会话 1)",
    labels: [],
    type: "gauge",
  },
  {
    name: "session_api_worker_processes",
    help: "Worker 池占用(本编排器进程持有的 vm-worker 子进程数;T0 = 每在途会话 1)",
    labels: [],
    type: "gauge",
  },
  {
    name: "session_api_projection_delta_bytes",
    help: "投影增量字节数(已接受动作的 ProjectionDelta 序列化字节)",
    labels: ["action"],
    type: "histogram",
  },
  {
    name: "session_api_debug_worker_processes",
    help: "调试 worker 占用(本编排器进程持有的调试实例子进程数;按需 +1,WP-41)",
    labels: [],
    type: "gauge",
  },
  {
    name: "session_api_debug_frames_total",
    help: "调试通道帧计数(按帧类型与结果;类型取 5 值请求帧 + other 兜底,WP-41)",
    labels: ["frame", "outcome"],
    type: "counter",
  },
  {
    name: "session_api_debug_budget_rejections_total",
    help: "调试帧被每会话动作预算拒绝计数(与解题共用同一预算的挤占观察,ADR-DC1 条款 6)",
    labels: [],
    type: "counter",
  },
  {
    name: "session_api_audit_archive_batches_total",
    help: "审计归档批计数(outcome ∈ {completed, failed};idle 稳态不计数;运维事件账,D-API-92)",
    labels: ["outcome"],
    type: "counter",
  },
];

/** 动作 RTT 直方图分桶(秒):覆盖本地亚毫秒到看门狗超时上限的量级。 */
export const ACTION_RTT_BUCKETS: readonly number[] = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/** 投影增量字节直方图分桶(字节):教学增量 0.5 KiB ~ 1 MiB 量级。 */
export const PROJECTION_BYTES_BUCKETS: readonly number[] = [
  128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144,
  524288, 1048576,
];

/** 调试通道帧类型标签值(有界域:5 值请求帧 + `other` 兜底,基数防护)。 */
export const KNOWN_DEBUG_FRAME_TYPES: ReadonlySet<string> = new Set([
  "debug_attach",
  "debug_window",
  "debug_step",
  "debug_run_to_breakpoint",
  "debug_search",
]);

/** 动作标签值折叠:非冻结动作类型折叠为 `other`(基数防护兜底)。 */
function actionLabel(actionType: string): string {
  return KNOWN_ACTION_TYPES.has(actionType) ? actionType : "other";
}

/** 调试帧类型标签值折叠:非 5 值请求帧折叠为 `other`(基数防护兜底)。 */
function debugFrameLabel(frameType: string): string {
  return KNOWN_DEBUG_FRAME_TYPES.has(frameType) ? frameType : "other";
}

/** 指标面(纯观测;任何方法不得抛错打断业务路径——prom-client 同步更新)。 */
export class SessionMetrics {
  readonly #registry: client.Registry;
  readonly #actionRtt: client.Histogram<"action" | "outcome">;
  readonly #liveSessions: client.Gauge;
  readonly #queueDepth: client.Gauge;
  readonly #workerProcesses: client.Gauge;
  readonly #projectionBytes: client.Histogram<"action">;
  readonly #debugWorkerProcesses: client.Gauge;
  readonly #debugFrames: client.Counter<"frame" | "outcome">;
  readonly #debugBudgetRejections: client.Counter;
  readonly #auditArchiveBatches: client.Counter<"outcome">;

  constructor(registry: client.Registry = new client.Registry()) {
    this.#registry = registry;
    const spec = (index: number): MetricFamilySpec => {
      const found = METRIC_FAMILIES[index];
      if (found === undefined) {
        throw new Error(`METRIC_FAMILIES[${index}] 未登记`);
      }
      return found;
    };
    this.#actionRtt = new client.Histogram({
      name: "session_api_action_rtt_seconds",
      help: spec(0).help,
      labelNames: ["action", "outcome"] as const,
      buckets: [...ACTION_RTT_BUCKETS],
      registers: [registry],
    });
    this.#liveSessions = new client.Gauge({
      name: "session_api_live_sessions",
      help: spec(1).help,
      registers: [registry],
    });
    this.#queueDepth = new client.Gauge({
      name: "session_api_action_queue_depth",
      help: spec(2).help,
      registers: [registry],
    });
    this.#workerProcesses = new client.Gauge({
      name: "session_api_worker_processes",
      help: spec(3).help,
      registers: [registry],
    });
    this.#projectionBytes = new client.Histogram({
      name: "session_api_projection_delta_bytes",
      help: spec(4).help,
      labelNames: ["action"] as const,
      buckets: [...PROJECTION_BYTES_BUCKETS],
      registers: [registry],
    });
    this.#debugWorkerProcesses = new client.Gauge({
      name: "session_api_debug_worker_processes",
      help: spec(5).help,
      registers: [registry],
    });
    this.#debugFrames = new client.Counter({
      name: "session_api_debug_frames_total",
      help: spec(6).help,
      labelNames: ["frame", "outcome"] as const,
      registers: [registry],
    });
    this.#debugBudgetRejections = new client.Counter({
      name: "session_api_debug_budget_rejections_total",
      help: spec(7).help,
      registers: [registry],
    });
    this.#auditArchiveBatches = new client.Counter({
      name: "session_api_audit_archive_batches_total",
      help: spec(8).help,
      labelNames: ["outcome"] as const,
      registers: [registry],
    });
  }

  /** 动作 RTT 观测(秒)。 */
  observeActionRtt(actionType: string, outcome: ActionOutcome, durationSeconds: number): void {
    this.#actionRtt.observe({ action: actionLabel(actionType), outcome }, durationSeconds);
  }

  /** 投影增量字节观测(已接受动作;delta 为 null 时零观测)。 */
  observeProjectionDelta(actionType: string, bytes: number | null): void {
    if (bytes !== null) {
      this.#projectionBytes.observe({ action: actionLabel(actionType) }, bytes);
    }
  }

  /** 并发会话数置值(在途会话管理器是唯一真源)。 */
  setLiveSessions(count: number): void {
    this.#liveSessions.set(count);
  }

  /** 队列深度置值(在途动作调用数)。 */
  setQueueDepth(count: number): void {
    this.#queueDepth.set(count);
  }

  /** Worker 池占用置值(T0 每会话单进程)。 */
  setWorkerProcesses(count: number): void {
    this.#workerProcesses.set(count);
  }

  /** 调试 worker 占用置值(调试编排器是唯一真源;WP-41)。 */
  setDebugWorkerProcesses(count: number): void {
    this.#debugWorkerProcesses.set(count);
  }

  /** 调试通道帧计数(WP-41;outcome 有界三值,语义同 ActionOutcome)。 */
  observeDebugFrame(frameType: string, outcome: ActionOutcome): void {
    this.#debugFrames.inc({ frame: debugFrameLabel(frameType), outcome });
  }

  /** 调试帧被每会话动作预算拒绝计数(挤占观察,ADR-DC1 条款 6)。 */
  observeDebugBudgetRejection(): void {
    this.#debugBudgetRejections.inc();
  }

  /** 审计归档批计数(WP-64,D-API-92;运维事件账的 /metrics 载体,outcome 有界二值)。 */
  observeAuditArchiveBatch(outcome: "completed" | "failed"): void {
    this.#auditArchiveBatches.inc({ outcome });
  }

  /** 渲染 Prometheus 文本格式(经 /metrics 暴露;输出受白名单机检约束)。 */
  async render(): Promise<string> {
    return this.#registry.metrics();
  }

  /** registry 内容类型(Content-Type 响应头;Prometheus 文本格式版本)。 */
  get contentType(): string {
    return this.#registry.contentType;
  }
}

// ── /metrics 输出机检(标签纪律的白名单扫描器;测试锚点,非运行时硬闸)──

/** 机检违例(条目携带规则 ID;红灯反例与零命中断言同套件运行)。 */
export interface MetricsDisciplineViolation {
  readonly id:
    | "unknown-metric-name"
    | "unknown-label-name"
    | "secret-corpus-hit"
    | "session-id-shaped-value";
  readonly detail: string;
}

/** 冻结标识符形态(会话 ID 等服务端签发标识;语义文档 §2.1 字符集)。 */
const IDENTIFIER_VALUE_PATTERN = /\b(sess|req|cp|sub)-[A-Za-z0-9_-]{8,}\b/;

/**
 * /metrics 渲染文本机检(D-API-71):
 *  1. HELP/TYPE 声明的指标名 ⊆ 白名单(unknown-metric-name);
 *  2. 样本行的标签名 ⊆ 该指标族白名单(unknown-label-name);
 *  3. ZR-B1 / B6 秘密语料零命中(secret-corpus-hit);
 *  4. 服务端签发标识符形态值(会话 ID 等)零出现(session-id-shaped-value)。
 * 返回违例列表(空 = 合法);测试同时运行红灯反例证明扫描器可检出。
 */
export function assertMetricsTextDiscipline(text: string): MetricsDisciplineViolation[] {
  const violations: MetricsDisciplineViolation[] = [];
  const specs = new Map(METRIC_FAMILIES.map((family) => [family.name, family]));
  const declared = new Set<string>();
  // histogram/gauge 在输出中还会展开 _bucket/_count/_sum 后缀样本;声明名以 HELP 行为准。
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("# HELP ")) {
      const name = line.slice(7).trim().split(/\s+/)[0] ?? "";
      declared.add(name);
      if (!specs.has(name)) {
        violations.push({ id: "unknown-metric-name", detail: `HELP 声明了白名单外指标 ${name}` });
      }
    } else if (line.startsWith("# TYPE ")) {
      const name = line.slice(7).trim().split(/\s+/)[0] ?? "";
      if (!specs.has(name)) {
        violations.push({ id: "unknown-metric-name", detail: `TYPE 声明了白名单外指标 ${name}` });
      }
    } else if (line !== "" && !line.startsWith("#")) {
      const sampleMatch = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(.+)$/.exec(line);
      if (sampleMatch === null || sampleMatch[1] === undefined) {
        continue;
      }
      const baseName = sampleMatch[1];
      const family =
        specs.get(baseName) ??
        [...specs.values()].find(
          (candidate) => baseName.startsWith(`${candidate.name}_`) && declared.has(candidate.name),
        );
      if (family === undefined) {
        violations.push({
          id: "unknown-metric-name",
          detail: `样本行出现白名单外指标 ${baseName}`,
        });
        continue;
      }
      const labelKeys = (sampleMatch[3] ?? "")
        .split(",")
        .map((pair) => pair.split("=")[0]?.trim() ?? "")
        .filter((key) => key !== "");
      // 直方图展开样本的分位标签 `le` 是 prom-client 结构性标签,不在族级白名单内。
      const allowedLabels =
        family.type === "histogram" ? [...family.labels, "le"] : family.labels;
      for (const key of labelKeys) {
        if (!allowedLabels.includes(key)) {
          violations.push({
            id: "unknown-label-name",
            detail: `${baseName} 出现白名单外标签 ${key}`,
          });
        }
      }
    }
  }
  for (const hit of scanSecretCorpus(text)) {
    violations.push({ id: "secret-corpus-hit", detail: `秘密语料命中 ${hit.id}` });
  }
  const identifierMatch = IDENTIFIER_VALUE_PATTERN.exec(text);
  if (identifierMatch !== null) {
    violations.push({
      id: "session-id-shaped-value",
      detail: `输出含服务端签发标识符形态值(基数/关联面纪律):${identifierMatch[0].slice(0, 12)}…`,
    });
  }
  return violations;
}

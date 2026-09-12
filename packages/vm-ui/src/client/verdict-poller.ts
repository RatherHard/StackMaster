/**
 * VerdictPoller —— 正式裁决重询状态机(阶段六 WP-63;D-API-83 / D-API-84)。
 *
 * 职责:submit 受理后跟随 submissionId 轮询裁决呈现通道
 * (`GET /verdicts/:submissionId`,插件 ↔ session-api 直连 HTTP;**宿主
 * postMessage 零权威语义不破**——裁决数据不经嵌入协议帧,V-9),把异步
 * 裁决状态机(pending → verdicted 单向)投影为确定性呈现状态:
 *
 *  - `idle`:未跟随任何提交;
 *  - `pending`:已提交、裁决未落库(「已提交 · 裁决进行中」;呈现零进度
 *    语义——不误读为通过 / 失败,任务分解 §六风险表定案锚);
 *  - `verdicted`:裁决已落库(11 值字面;终态,**verdicted 即停**);
 *  - `unavailable`:重询连续失败触顶(「裁决暂不可用」;停询、不中断会话、
 *    **不判负**——fail-closed 方向登记,D-API-84)。
 *
 * 重询节奏(定案,记 D-API-97):
 *  - **确定性间隔**:首询立即,其后恒定 `baseIntervalMs`(缺省 2500ms;
 *    SESSION_API_VERDICT_QUERIES_PER_MINUTE 默认 30/min 预算内留余量,
 *    零 429 稳态);
 *  - **失败退避**:429 / 网络失败按指数退避(delay = min(base·2^n, max),
 *    缺省上限 30s)——零重试风暴;
 *  - **失败预算**:连续失败 `maxConsecutiveFailures`(缺省 5)次 → 停询并
 *    呈现 unavailable;断线期在途失败不计入(断线由连接横幅明示);
 *  - **停止条件定案**:verdicted 即停;断线暂停、重连恢复(预算重置);
 *    stop() / 新 follow() 停旧跟新(显式重新提交入口;旧 submission 与旧
 *    裁决不动,D-API-84)。
 *
 * 全部时钟与定时器可注入:判定是确定性的(同 (响应序列, 连接事件序列)
 * 恒同呈现序列,I-4)。
 */
import type { VerdictQueryResponse, VerdictResult } from "@stackmaster/protocol";

import type { ConnectionStatusEvent } from "./session-client.js";
import {
  defaultTimerCanceler,
  defaultTimerScheduler,
  type TimerCanceler,
  type TimerHandle,
  type TimerScheduler,
} from "./transport.js";

/** 裁决查询面(SessionClient 结构子集;测试注入替身)。 */
export interface VerdictQuerySink {
  queryVerdict(submissionId: string): Promise<VerdictQueryResponse>;
  onConnectionStatus(listener: (event: ConnectionStatusEvent) => void): () => void;
}

/** 裁决呈现状态机(D-API-84 两态 + 呈现面的 unavailable 降级态)。 */
export type VerdictPresentation =
  | { readonly kind: "idle" }
  | { readonly kind: "pending"; readonly submissionId: string }
  | { readonly kind: "verdicted"; readonly submissionId: string; readonly verdict: VerdictResult }
  | { readonly kind: "unavailable"; readonly submissionId: string };

export interface VerdictPollerOptions {
  readonly sink: VerdictQuerySink;
  /** 确定性轮询间隔 ms(缺省 2500;30/min 限流预算内留余量)。 */
  readonly baseIntervalMs?: number;
  /** 退避上限 ms(缺省 30000)。 */
  readonly maxIntervalMs?: number;
  /** 连续失败预算(缺省 5;触顶 → unavailable 停询)。 */
  readonly maxConsecutiveFailures?: number;
  readonly scheduleTimer?: TimerScheduler;
  readonly cancelTimer?: TimerCanceler;
}

const DEFAULT_BASE_INTERVAL_MS = 2500;
const DEFAULT_MAX_INTERVAL_MS = 30000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

export class VerdictPoller {
  readonly #sink: VerdictQuerySink;
  readonly #baseIntervalMs: number;
  readonly #maxIntervalMs: number;
  readonly #maxConsecutiveFailures: number;
  readonly #scheduleTimer: TimerScheduler;
  readonly #cancelTimer: TimerCanceler;
  readonly #listeners = new Set<(presentation: VerdictPresentation) => void>();

  #presentation: VerdictPresentation = { kind: "idle" };
  #timerHandle: TimerHandle | null = null;
  #consecutiveFailures = 0;
  /** 连接可用性(断线暂停;重连恢复)。 */
  #connected = true;
  /** 代际计数:follow/stop 使在途查询结果作废(防旧结果写入新呈现)。 */
  #generation = 0;
  #disposed = false;
  readonly #statusDisposer: () => void;

  constructor(options: VerdictPollerOptions) {
    this.#sink = options.sink;
    this.#baseIntervalMs = options.baseIntervalMs ?? DEFAULT_BASE_INTERVAL_MS;
    this.#maxIntervalMs = options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
    this.#maxConsecutiveFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
    this.#scheduleTimer = options.scheduleTimer ?? defaultTimerScheduler;
    this.#cancelTimer = options.cancelTimer ?? defaultTimerCanceler;
    // 连接状态机:断线暂停、重连恢复(D-API-84 停止条件定案)。
    this.#statusDisposer = options.sink.onConnectionStatus((event) => {
      if (this.#disposed) {
        return;
      }
      if (event.status === "connected") {
        this.#onReconnected();
      } else if (event.status === "disconnected" || event.status === "reconnecting" || event.status === "connecting") {
        this.#onConnectionLost();
      }
    });
  }

  /** 当前呈现状态(视图读取面)。 */
  get presentation(): VerdictPresentation {
    return this.#presentation;
  }

  /** 呈现变更订阅(返回退订函数)。 */
  onChange(listener: (presentation: VerdictPresentation) => void): () => void {
    return addListener(this.#listeners, listener);
  }

  /**
   * 跟随新提交(显式 submit / 重新提交入口):旧跟随停询(旧 submission 与
   * 旧裁决不动),新 submission 从 pending 起步并立即首询。
   */
  follow(submissionId: string): void {
    this.#assertNotDisposed();
    this.#generation += 1;
    this.#cancelScheduledTimer();
    this.#consecutiveFailures = 0;
    this.#setPresentation({ kind: "pending", submissionId });
    this.#scheduleNext(submissionId, this.#generation, 0);
  }

  /** 停止跟随(回到 idle;在途查询结果经代际计数作废)。 */
  stop(): void {
    this.#assertNotDisposed();
    this.#generation += 1;
    this.#cancelScheduledTimer();
    this.#consecutiveFailures = 0;
    this.#setPresentation({ kind: "idle" });
  }

  /** 释放全部资源(测试收尾 / client 换绑)。 */
  dispose(): void {
    this.#disposed = true;
    this.#generation += 1;
    this.#cancelScheduledTimer();
    this.#statusDisposer();
    this.#listeners.clear();
  }

  // ── 内部:轮询循环(代际计数守卫;失败退避;断线暂停)────────────────────

  #scheduleNext(submissionId: string, generation: number, delayMs: number): void {
    if (this.#disposed || generation !== this.#generation) {
      return;
    }
    this.#cancelScheduledTimer();
    this.#timerHandle = this.#scheduleTimer(() => {
      this.#timerHandle = null;
      if (!this.#disposed && generation === this.#generation) {
        void this.#runQuery(submissionId, generation);
      }
    }, delayMs);
  }

  async #runQuery(submissionId: string, generation: number): Promise<void> {
    if (this.#disposed || generation !== this.#generation) {
      return;
    }
    let response: VerdictQueryResponse;
    try {
      response = await this.#sink.queryVerdict(submissionId);
    } catch {
      // 失败路径(429 / 5xx / 网络失败同型):断线期不计入预算(断线由
      // 连接横幅明示,重连恢复);预算触顶 → unavailable 停询(不判负)。
      if (this.#disposed || generation !== this.#generation) {
        return;
      }
      if (!this.#connected) {
        return;
      }
      this.#consecutiveFailures += 1;
      if (this.#consecutiveFailures >= this.#maxConsecutiveFailures) {
        this.#cancelScheduledTimer();
        this.#setPresentation({ kind: "unavailable", submissionId });
        return;
      }
      // 退避序:base·2^(n-1) → 首次重试 = base,其后 2×、4×(上限 max)。
      const delayMs = Math.min(
        this.#baseIntervalMs * 2 ** (this.#consecutiveFailures - 1),
        this.#maxIntervalMs,
      );
      this.#scheduleNext(submissionId, generation, delayMs);
      return;
    }
    if (this.#disposed || generation !== this.#generation) {
      return;
    }
    if (response.status === "verdicted" && response.verdict !== undefined) {
      // 终态:verdicted 即停(单向不可逆;11 值字面为唯一公开裁决承载)。
      this.#cancelScheduledTimer();
      this.#consecutiveFailures = 0;
      this.#setPresentation({ kind: "verdicted", submissionId, verdict: response.verdict });
      return;
    }
    // pending:未决期零信息增量,按确定性间隔继续(成功重置失败预算)。
    this.#consecutiveFailures = 0;
    this.#scheduleNext(submissionId, generation, this.#baseIntervalMs);
  }

  #onConnectionLost(): void {
    this.#connected = false;
    // 暂停:清除已排程查询(重连时重新起步;呈现保持 pending)。
    this.#cancelScheduledTimer();
  }

  #onReconnected(): void {
    const wasConnected = this.#connected;
    this.#connected = true;
    const current = this.#presentation;
    if (wasConnected || current.kind !== "pending" || this.#disposed) {
      return;
    }
    // 恢复:预算重置,立即重询。
    this.#consecutiveFailures = 0;
    this.#scheduleNext(current.submissionId, this.#generation, 0);
  }

  #cancelScheduledTimer(): void {
    if (this.#timerHandle !== null) {
      this.#cancelTimer(this.#timerHandle);
      this.#timerHandle = null;
    }
  }

  #setPresentation(presentation: VerdictPresentation): void {
    this.#presentation = presentation;
    for (const listener of [...this.#listeners]) {
      listener(presentation);
    }
  }

  #assertNotDisposed(): void {
    if (this.#disposed) {
      throw new Error("VerdictPoller 已 dispose");
    }
  }
}

function addListener<T>(listeners: Set<T>, listener: T): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

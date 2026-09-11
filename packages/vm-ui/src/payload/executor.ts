/**
 * Payload 步进执行器(WP-F6 / FE-WS-04b / Q3 定案 / M8 变通口径)。
 *
 * 职责:把编译产物(`PayloadProgram`)按**原子动作粒度**逐步经 WSS 提交:
 *  - 每个原子动作 = 一步(主控 Q3 定案);断点标记 = 步进暂停点(M7 变通);
 *  - 逐动作提交:**等 onActionResponse(onActionRejected)后再提交下一步**;
 *  - 断点到达 / 暂停按钮 → 停在当前原子边界(不产生半步语义);
 *  - rejected(budget_exhausted 或其他)→ 暂停 + 可解释错误回调;
 *    重试由用户手动步进(光标不动——被拒动作未执行,revision 不前进);
 *  - 完成 → done 状态;状态机 idle | running | paused | done | error;
 *  - 动作通道可注入(`PayloadActionSink`——`SessionClient` 结构兼容);
 *    步进间隔与等待函数可注入,便于测试与限流实测调参(M9 / D-API-50~53
 *    联调反馈面,不改契约)。
 *
 * 已知取舍(登记):会话级动作通道不携带发起方关联——payload 执行期间,
 * 其他来源的动作(如工作区「指令步进」)的响应会被本执行器当作自己的
 * 下一步推进。教学 UI 约定:payload 运行/暂停期间不要混用其他动作入口;
 * 关联精确化(幂等键回执)留给 WP-F7/F8 演进。
 */
import type { ActionObject, ActionResponse, PublicError } from "@stackmaster/protocol";

import type { PayloadProgram, PayloadStep } from "./compiler/types.js";

/** 动作提交面(SessionClient 结构兼容;测试用 fake 注入)。 */
export interface PayloadActionSink {
  sendAction(action: ActionObject): void;
  onActionResponse(listener: (response: ActionResponse) => void): () => void;
  onActionRejected(listener: (error: PublicError, response: ActionResponse) => void): () => void;
}

/** 执行器状态机。 */
export type PayloadExecutorStatus = "idle" | "running" | "paused" | "done" | "error";

/** 暂停原因。 */
export type PayloadPauseReason = "breakpoint" | "user" | "step";

/** 状态变化事件。 */
export interface PayloadExecutorStateEvent {
  readonly status: PayloadExecutorStatus;
  /** 下一个待处理步骤下标(游标)。 */
  readonly cursor: number;
}

/** 单步被接受事件(动作已执行,投影 revision 前进)。 */
export interface PayloadStepAcceptedEvent {
  readonly index: number;
  readonly step: PayloadStep;
  readonly response: ActionResponse;
}

/** 暂停事件。 */
export interface PayloadPausedEvent {
  readonly index: number;
  readonly reason: PayloadPauseReason;
}

/** 错误事件(动作被拒 = 可解释 PublicError;通道/客户端错误 = message)。 */
export interface PayloadExecutorErrorEvent {
  /** 被拒 / 提交失败的动作步骤下标(游标停留处;重试由用户手动步进)。 */
  readonly index: number;
  /** 服务端可解释错误(rejected 耦合:code + message + explanation)。 */
  readonly error: PublicError | null;
  /** 客户端侧错误文案(sendAction 抛错等;error 为 null 时必有)。 */
  readonly message: string | null;
}

/** 执行器装配选项(时钟 / 等待可注入,便于测试)。 */
export interface PayloadExecutorOptions {
  /** 相邻两步之间的最小间隔 ms(0 = 不等待;限流实测联调用)。 */
  readonly stepIntervalMs?: number;
  /** 等待注入(缺省 setTimeout;测试可注入立即 resolve 的假等待)。 */
  readonly delay?: (ms: number) => Promise<void>;
}

/** 等待一帧响应的内部 deferred。 */
interface ResponseOutcome {
  readonly accepted: boolean;
  readonly response: ActionResponse;
  readonly error: PublicError | null;
  /** 客户端侧错误文案(sendAction 抛错;error 为 null 时携带)。 */
  readonly clientMessage?: string;
}

export class PayloadStepExecutor {
  readonly #sink: PayloadActionSink;
  readonly #stepIntervalMs: number;
  readonly #delay: (ms: number) => Promise<void>;
  readonly #listeners = {
    state: new Set<(event: PayloadExecutorStateEvent) => void>(),
    step: new Set<(event: PayloadStepAcceptedEvent) => void>(),
    paused: new Set<(event: PayloadPausedEvent) => void>(),
    error: new Set<(event: PayloadExecutorErrorEvent) => void>(),
  };

  #program: PayloadProgram | null = null;
  #status: PayloadExecutorStatus = "idle";
  #cursor = 0;
  #pauseRequested = false;
  #pumping = false;
  /** 游标停在未消费的断点标记上(恢复时先消费该标记,再继续推进)。 */
  #sittingOnBreakpoint = false;
  /** 代际计数:load() 换程序使在途 pump 循环作废(防旧程序写入新游标)。 */
  #generation = 0;
  #resolveResponse: ((outcome: ResponseOutcome) => void) | null = null;

  constructor(sink: PayloadActionSink, options: PayloadExecutorOptions = {}) {
    this.#sink = sink;
    this.#stepIntervalMs = options.stepIntervalMs ?? 0;
    this.#delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    sink.onActionResponse((response) => {
      this.#resolveResponse?.({ accepted: true, response, error: null });
    });
    sink.onActionRejected((error, response) => {
      this.#resolveResponse?.({ accepted: false, response, error });
    });
  }

  // ── 事件订阅(返回退订函数)──────────────────────────────────────────────

  onStateChange(listener: (event: PayloadExecutorStateEvent) => void): () => void {
    return addListener(this.#listeners.state, listener);
  }

  onStepAccepted(listener: (event: PayloadStepAcceptedEvent) => void): () => void {
    return addListener(this.#listeners.step, listener);
  }

  onPaused(listener: (event: PayloadPausedEvent) => void): () => void {
    return addListener(this.#listeners.paused, listener);
  }

  onError(listener: (event: PayloadExecutorErrorEvent) => void): () => void {
    return addListener(this.#listeners.error, listener);
  }

  // ── 状态面 ───────────────────────────────────────────────────────────────

  get status(): PayloadExecutorStatus {
    return this.#status;
  }

  /** 下一个待处理步骤下标(程序长度 = steps.length;done 时 == 长度)。 */
  get cursor(): number {
    return this.#cursor;
  }

  /** 当前加载的程序(未加载为 null)。 */
  get program(): PayloadProgram | null {
    return this.#program;
  }

  // ── 驱动面 ───────────────────────────────────────────────────────────────

  /**
   * 装载程序(重置游标与状态为 idle)。运行中调用 = 换程序:在途 pump
   * 循环经代际计数作废(确定性收敛,不产生跨程序写入)。
   */
  load(program: PayloadProgram): void {
    this.#generation += 1;
    this.#program = program;
    this.#cursor = 0;
    this.#pauseRequested = false;
    this.#sittingOnBreakpoint = false;
    this.#setStatus("idle");
  }

  /** 连续运行:从当前游标推进,直到 done / 断点 / 暂停请求 / 错误。 */
  run(): void {
    if (!this.#canStart()) {
      return;
    }
    this.#pauseRequested = false;
    this.#setStatus("running");
    void this.#pump(this.#generation, false);
  }

  /**
   * 单步(FE-WS-04b 积木步进):推进恰好一个原子动作后暂停;游标停在
   * 未消费的断点标记上时,先暂停于断点(不执行动作)。
   */
  stepOnce(): void {
    if (!this.#canStart()) {
      return;
    }
    this.#setStatus("running");
    void this.#pump(this.#generation, true);
  }

  /** 请求暂停(协作式:停在下一个原子边界;运行中才有效)。 */
  pause(): void {
    if (this.#status === "running") {
      this.#pauseRequested = true;
    }
  }

  // ── 内部泵 ───────────────────────────────────────────────────────────────

  #canStart(): boolean {
    if (this.#program === null) {
      return false;
    }
    // running 中重复 run/stepOnce 为 no-op;error/paused/done/idle 均可
    // 手动继续(budget_exhausted 的重试 = 用户手动步进,主控定案)。
    return this.#status !== "running";
  }

  async #pump(generation: number, singleStep: boolean): Promise<void> {
    if (this.#pumping) {
      return;
    }
    this.#pumping = true;
    try {
      // 从断点暂停中恢复:游标停在未消费的断点标记上 = 消费该标记
      // (观察完毕;恢复态独立于状态机,run/stepOnce 均先经过此处)。
      if (this.#sittingOnBreakpoint && this.#program?.steps[this.#cursor]?.kind === "breakpoint") {
        this.#cursor += 1;
      }
      this.#sittingOnBreakpoint = false;
      for (;;) {
        if (generation !== this.#generation) {
          return; // 程序被 load() 换掉:本循环作废。
        }
        const step = this.#program?.steps[this.#cursor];
        if (step === undefined) {
          this.#setStatus("done");
          return;
        }
        if (step.kind === "breakpoint") {
          // 到达断点:停在标记处(不消费——供 UI 呈现"当前停在断点")。
          this.#sittingOnBreakpoint = true;
          this.#setStatus("paused");
          this.#emitPaused(this.#cursor, "breakpoint");
          return;
        }
        // 原子动作步:提交 → 等响应 → 再提交下一步(时序纪律)。
        const outcome = await this.#submitAndWait(step);
        if (generation !== this.#generation) {
          return;
        }
        if (!outcome.accepted) {
          // rejected(含 budget_exhausted / 限流):光标不动(动作未执行),
          // 状态 error;重试由用户手动步进。可解释错误经 onError 分发。
          this.#setStatus("error");
          this.#emitError(this.#cursor, outcome.error, outcome.clientMessage ?? null);
          return;
        }
        this.#emitStep(this.#cursor, step, outcome.response);
        this.#cursor += 1;
        if (this.#pauseRequested) {
          this.#pauseRequested = false;
          this.#setStatus("paused");
          this.#emitPaused(this.#cursor, "user");
          return;
        }
        if (singleStep) {
          const finished = this.#program === null || this.#cursor >= this.#program.steps.length;
          this.#setStatus(finished ? "done" : "paused");
          if (!finished) {
            this.#emitPaused(this.#cursor, "step");
          }
          return;
        }
        if (this.#stepIntervalMs > 0) {
          await this.#delay(this.#stepIntervalMs);
          if (generation !== this.#generation) {
            return;
          }
        }
      }
    } finally {
      this.#pumping = false;
    }
  }

  /** 提交一个原子动作并等待响应(rejected 也以 outcome 返回,不抛错)。 */
  async #submitAndWait(step: PayloadStep): Promise<ResponseOutcome> {
    if (step.kind !== "action") {
      // 类型面不变式:泵循环已过滤断点标记(防御性,不可达)。
      return { accepted: true, response: emptyAcceptedResponse(), error: null };
    }
    const waitForResponse = new Promise<ResponseOutcome>((resolve) => {
      this.#resolveResponse = resolve;
    });
    try {
      this.#sink.sendAction(step.action);
    } catch (error) {
      this.#resolveResponse = null;
      // sendAction 断线 / 无会话抛 SessionClientError:转为 error 态(可
      // 重连后手动重试),不排队、不本地补执行(动作只能经认证 WSS)。
      return {
        accepted: false,
        response: emptyAcceptedResponse(),
        error: null,
        clientMessage: error instanceof Error ? error.message : String(error),
      };
    }
    const outcome = await waitForResponse;
    this.#resolveResponse = null;
    return outcome;
  }

  #setStatus(status: PayloadExecutorStatus): void {
    if (this.#status === status) {
      // 单步收尾会先置 running 再立刻置 paused/done:同态去重仍发事件吗?
      // 状态机语义:同值不重发(调用方以 paused 事件为准)。
      return;
    }
    this.#status = status;
    for (const listener of [...this.#listeners.state]) {
      listener({ status, cursor: this.#cursor });
    }
  }

  #emitPaused(index: number, reason: PayloadPauseReason): void {
    for (const listener of [...this.#listeners.paused]) {
      listener({ index, reason });
    }
  }

  #emitStep(index: number, step: PayloadStep, response: ActionResponse): void {
    for (const listener of [...this.#listeners.step]) {
      listener({ index, step, response });
    }
  }

  #emitError(index: number, error: PublicError | null, message: string | null): void {
    for (const listener of [...this.#listeners.error]) {
      listener({ index, error, message });
    }
  }
}

function addListener<T>(listeners: Set<T>, listener: T): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 占位响应(仅类型面占位;真实响应恒来自 sink 回调)。 */
function emptyAcceptedResponse(): ActionResponse {
  return {
    requestId: "local",
    revision: 0,
    status: "running",
    projectionDelta: null,
    publicEvents: [],
  };
}

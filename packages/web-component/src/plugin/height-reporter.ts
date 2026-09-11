/**
 * height_changed 上报管道(D-API-77:内容变化驱动 + rAF 合流 + 每秒硬上限
 * 30 + MAX_EMBED_HEIGHT_PX 护栏;嵌入协议 §三 / §4.4 auto_resize 行)。
 *
 * 管线:notifyContentHeightChange()(内容变化驱动,组件内由 ResizeObserver
 * 挂接;亦可手动触发)→ rAF 合流(一帧至多一次,尾沿携带最新测量值)→
 * 高度护栏(≤ 1 丢弃;> MAX_EMBED_HEIGHT_PX 超大即不发 + 计数)→ 收紧
 * (clamp 到 maxHeightPx ≤ 冻结常量,超上限装配拒绝)→ V-10 每秒上限
 * (TypeRateLimiter 复用,Q4 定案:限速构件双侧同构)→ send 回调。
 *
 * 仅当 auto_resize 已授予时组件才装配本报告器(§4.4:未授予 → 固定高度
 * 不发 height_changed);本类自身不重复裁决授予面。
 */
import { MAX_EMBED_HEIGHT_PX } from "@stackmaster/protocol";
import { TypeRateLimiter } from "@stackmaster/embed-runtime";

/** rAF 合流调度注入(jsdom 测试以手工队列假体替换)。 */
export interface FrameSchedulerLike {
  requestAnimationFrame(fn: () => void): unknown;
  cancelAnimationFrame(handle: unknown): void;
}

export interface HeightReporterOptions {
  /** 内容高度测量注入(组件默认 () => this.scrollHeight;测试注入定值)。 */
  readonly measure: () => number;
  /** 发送回调(已过全部护栏;组件内组装 height_changed 信封并发送)。 */
  readonly send: (heightPx: number) => void;
  /** 收紧上限(≤ MAX_EMBED_HEIGHT_PX;构造越上限直接抛错拒绝装配,D-API-77)。 */
  readonly maxHeightPx?: number;
  /** 每秒硬上限(默认 30,clamp 1–120;D-API-77 heightChangedMaxPerSecond)。 */
  readonly maxPerSecond?: number;
  /** 时钟注入(限速滑动窗口;默认 performance.now)。 */
  readonly clock?: () => number;
  /** rAF 调度注入(默认全局 requestAnimationFrame/cancelAnimationFrame)。 */
  readonly frameScheduler?: FrameSchedulerLike;
  /** 超大丢弃计数钩子(组件接本地计数面;护栏命中可读出)。 */
  readonly onOversizeDrop?: () => void;
  /** 限速丢弃计数钩子(V-10 出站自限命中的本地可读面)。 */
  readonly onRateLimitDrop?: () => void;
}

const HEIGHT_CHANGED_MAX_PER_SECOND_DEFAULT = 30;
const HEIGHT_CHANGED_MAX_PER_SECOND_MAX = 120;

export class HeightReporter {
  readonly #measure: () => number;
  readonly #send: (heightPx: number) => void;
  readonly #maxHeightPx: number;
  readonly #limiter: TypeRateLimiter;
  readonly #frames: FrameSchedulerLike;
  readonly #onOversizeDrop: (() => void) | null;
  readonly #onRateLimitDrop: (() => void) | null;
  #frameHandle: unknown = null;
  #disposed = false;

  public constructor(options: HeightReporterOptions) {
    const rawMax = options.maxHeightPx ?? MAX_EMBED_HEIGHT_PX;
    if (!Number.isInteger(rawMax) || rawMax < 1 || rawMax > MAX_EMBED_HEIGHT_PX) {
      throw new Error(
        `maxHeightPx 必须为 1..${String(MAX_EMBED_HEIGHT_PX)} 的整数(协议冻结上限只可收紧、不可放宽),收到 ${String(rawMax)}`,
      );
    }
    const rawLimit = options.maxPerSecond ?? HEIGHT_CHANGED_MAX_PER_SECOND_DEFAULT;
    if (!Number.isInteger(rawLimit) || rawLimit < 1) {
      throw new Error(`maxPerSecond 必须为正整数,收到 ${String(rawLimit)}`);
    }
    this.#measure = options.measure;
    this.#send = options.send;
    this.#maxHeightPx = rawMax;
    this.#onOversizeDrop = options.onOversizeDrop ?? null;
    this.#onRateLimitDrop = options.onRateLimitDrop ?? null;
    this.#limiter = new TypeRateLimiter(
      options.clock ?? (() => performance.now()),
      () => Math.min(rawLimit, HEIGHT_CHANGED_MAX_PER_SECOND_MAX),
    );
    const globalFrames = (globalThis as {
      requestAnimationFrame?: FrameSchedulerLike["requestAnimationFrame"];
      cancelAnimationFrame?: FrameSchedulerLike["cancelAnimationFrame"];
    });
    this.#frames =
      options.frameScheduler ??
      (globalFrames.requestAnimationFrame !== undefined && globalFrames.cancelAnimationFrame !== undefined
        ? {
            // 显式绑定 window(rAF 是 method,脱离 this 调用 = Illegal invocation)。
            requestAnimationFrame: (fn) => globalFrames.requestAnimationFrame?.(fn),
            cancelAnimationFrame: (handle) => globalFrames.cancelAnimationFrame?.(handle),
          }
        : // 无 rAF 环境(SSR / 部分测试):降级为微任务直发(合流语义近似;
          // 真实浏览器路径恒经 rAF)。
          {
            requestAnimationFrame: (fn: () => void) => Promise.resolve().then(fn),
            cancelAnimationFrame: () => undefined,
          });
  }

  /** 内容高度变化入口:标脏并入帧(一帧至多一次,尾沿测量最新值)。 */
  public notifyContentHeightChange(): void {
    if (this.#disposed || this.#frameHandle !== null) {
      return;
    }
    this.#frameHandle = this.#frames.requestAnimationFrame(() => {
      this.#frameHandle = null;
      this.#flush();
    });
  }

  /** 释放:取消在途帧;之后 notify 为 no-op。 */
  public dispose(): void {
    this.#disposed = true;
    if (this.#frameHandle !== null) {
      this.#frames.cancelAnimationFrame(this.#frameHandle);
      this.#frameHandle = null;
    }
  }

  #flush(): void {
    const measured = Math.round(this.#measure());
    // Schema 下限 1:无可测量高度(0)不发送,静默(非违规,不出计数)。
    if (!Number.isFinite(measured) || measured < 1) {
      return;
    }
    // 超大护栏:实际内容高度超过协议冻结上限即整条不发 + 计数(D-API-77 /
    // 嵌入协议 §三;heightPx 1..100000,clamp 语义不适用于超上限的原始值)。
    if (measured > MAX_EMBED_HEIGHT_PX) {
      this.#onOversizeDrop?.();
      return;
    }
    // 收紧(clamp 到 maxHeightPx ≤ 冻结常量):收紧是载荷护栏,不是丢弃。
    const heightPx = Math.min(measured, this.#maxHeightPx);
    // V-10:每秒硬上限(超限丢弃 + 本地计数,零反馈)。
    if (!this.#limiter.tryAcquire("height_changed")) {
      this.#onRateLimitDrop?.();
      return;
    }
    this.#send(heightPx);
  }
}

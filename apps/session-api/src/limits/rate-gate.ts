/**
 * 固定窗口频率闸(任务分解 WP-6 第 1 条;D-API-50)。
 *
 * 载体 = WP-3 `RateLimitCounter`(Redis 固定窗口原子计数,`rate:{tenant}:{user}`
 * 键域;内存实现同构,测试可换)。窗口锚定于窗口内首次计数(TTL 自首增起算),
 * 计数 ≤ 限额放行、超限确定性拒绝——拒绝不回退计数(窗口自然过期后重置)。
 *
 * 确定性(I-4):同一 (键, 窗口, 计数序列) 恒同一结论;计数器内部状态
 * (当前计数 / 窗口锚)不透出。Redis 不可用时计数器以 `store_unavailable`
 * 立即上抛(D-API-24 分级:rate 键域 fail-closed),本闸不降级、不放行。
 */

import { RateLimitExceeded, type RateLimitDimension } from "./errors.js";

/** 频率窗口时长(秒):配置键以"每分钟"计量,窗口恒 60 s(D-API-50)。 */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

export interface FixedWindowRateGateOptions {
  /** 固定窗口计数器(WP-3 端口;Redis 或内存实现)。 */
  readonly counter: import("../persistence/ports.js").RateLimitCounter;
  /** 窗口内允许的次数(触顶即拒;config 启动校验已保证正整数)。 */
  readonly limitPerWindow: number;
  /** 窗口时长(秒;默认 60)。 */
  readonly windowSeconds?: number;
}

export class FixedWindowRateGate {
  readonly #counter: FixedWindowRateGateOptions["counter"];
  readonly #limit: number;
  readonly #windowSeconds: number;

  constructor(options: FixedWindowRateGateOptions) {
    if (!Number.isInteger(options.limitPerWindow) || options.limitPerWindow < 1) {
      throw new Error("FixedWindowRateGate:limitPerWindow 必须为正整数(config 启动校验已拦截)");
    }
    this.#counter = options.counter;
    this.#limit = options.limitPerWindow;
    this.#windowSeconds = options.windowSeconds ?? RATE_LIMIT_WINDOW_SECONDS;
  }

  /**
   * 尝试占用一个窗口名额:窗口内计数 ≤ 限额返回 true(放行),超限返回
   * false(确定性拒绝本请求;计数不回退)。
   */
  async tryAcquire(key: string): Promise<boolean> {
    const count = await this.#counter.increment(key, this.#windowSeconds);
    return count <= this.#limit;
  }

  /**
   * 占用窗口名额,触顶即抛确定性拒绝异常(REST 路由闸的装配形态;异常经
   * error-mapping 呈现 429 + 冻结形态,D-API-50)。
   */
  async acquireOrThrow(key: string, dimension: RateLimitDimension): Promise<void> {
    if (!(await this.tryAcquire(key))) {
      throw new RateLimitExceeded(dimension, `fixed window quota ${this.#limit} exceeded for ${key}`);
    }
  }
}

/**
 * 通道消息频率限制(任务分解 WP-5 第 1 条,计划书 8.2;D-API-43)。
 *
 * 令牌桶:容量 = 速率 = `SESSION_API_WSS_MESSAGE_RATE_PER_SECOND`——桶满时
 * 允许等量突发,长期平均不超过速率。通道级(每连接一个实例,连接随进程
 * 固定,无需跨实例共享);**与 WP-6 每会话动作频率限制同源**:WP-6 复用本类
 * 承载"每会话"计量(按 sessionId 建桶),或经 `RateLimitCounter`(Redis 固定
 * 窗口)承载跨实例聚合——两者的触顶呈现统一为确定性拒绝(冻结错误形态)。
 *
 * 判定是纯函数:仅依赖 (注入时钟, 取令牌历史),同一事件序列恒同一结论
 * (I-4 确定性拒绝);不透出桶内余量等内部状态。
 */
export interface MessageRateLimiterOptions {
  /** 桶容量与每秒补充速率(同值;config.wssMessageRatePerSecond)。 */
  readonly capacityPerSecond: number;
  /** 注入时钟(默认 Date.now;测试可注入以验证确定性)。 */
  readonly now?: () => number;
}

export class MessageRateLimiter {
  readonly #capacity: number;
  readonly #now: () => number;
  #tokens: number;
  #lastRefillMs: number;

  constructor(options: MessageRateLimiterOptions) {
    if (!Number.isFinite(options.capacityPerSecond) || options.capacityPerSecond <= 0) {
      throw new Error("MessageRateLimiter:capacityPerSecond 必须为正数(config 启动校验已拦截)");
    }
    this.#capacity = options.capacityPerSecond;
    this.#now = options.now ?? Date.now;
    this.#tokens = this.#capacity;
    this.#lastRefillMs = this.#now();
  }

  /**
   * 尝试取一个令牌:有令牌返回 true(放行),否则 false(确定性拒绝本消息,
   * 不消耗任何余量)。补充按经过时间线性折算,上限为桶容量。
   */
  tryTake(): boolean {
    const nowMs = this.#now();
    const elapsedSeconds = Math.max(0, nowMs - this.#lastRefillMs) / 1000;
    if (elapsedSeconds > 0) {
      this.#tokens = Math.min(this.#capacity, this.#tokens + elapsedSeconds * this.#capacity);
      this.#lastRefillMs = nowMs;
    }
    if (this.#tokens < 1) {
      return false;
    }
    this.#tokens -= 1;
    return true;
  }
}

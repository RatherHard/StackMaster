/**
 * 每会话动作频率限制(任务分解 WP-6 第 1 条;D-API-53)。
 *
 * 与 WP-5 每连接令牌桶**同源实现**:直接复用 `MessageRateLimiter`(时钟可注入、
 * 判定为纯函数),计量键从"每连接"换"每会话"(按 sessionId 建桶)。两道闸
 * 叠加:每连接桶随连接新建(重连即满桶),每会话桶跨连接存活(重连不重置
 * 预算——封堵"断线重连刷新令牌桶"的绕行向量);容量同取
 * `SESSION_API_WSS_MESSAGE_RATE_PER_SECOND`(D-API-43 同源)。
 *
 * 生命周期:桶在会话首帧惰性创建;断线保持到期回收(D-API-55)时逐出——
 * 教学规模会话数下不做容量上限(会话本身受并发预算约束,桶数 ≤ 在途会话数)。
 */
import { MessageRateLimiter } from "../wss/message-rate-limiter.js";

export interface SessionActionRateLimiterOptions {
  /** 桶容量与每秒补充速率(同值;与每连接令牌桶同取通道消息频率)。 */
  readonly capacityPerSecond: number;
  /** 注入时钟(默认 Date.now;测试可注入以验证确定性)。 */
  readonly now?: () => number;
}

export class SessionActionRateLimiter {
  readonly #capacity: number;
  readonly #now: (() => number) | undefined;
  readonly #buckets = new Map<string, MessageRateLimiter>();

  constructor(options: SessionActionRateLimiterOptions) {
    if (!Number.isFinite(options.capacityPerSecond) || options.capacityPerSecond <= 0) {
      throw new Error("SessionActionRateLimiter:capacityPerSecond 必须为正数(config 启动校验已拦截)");
    }
    this.#capacity = options.capacityPerSecond;
    this.#now = options.now;
  }

  /** 当前追踪的会话桶数(可观测 / 测试断言)。 */
  get trackedSessionCount(): number {
    return this.#buckets.size;
  }

  /**
   * 尝试取一个令牌:有令牌返回 true(放行),否则 false(确定性拒绝本帧,
   * 不消耗任何余量)。判定是纯函数:仅依赖 (注入时钟, 取令牌历史)。
   */
  tryTake(sessionId: string): boolean {
    let bucket = this.#buckets.get(sessionId);
    if (bucket === undefined) {
      bucket = new MessageRateLimiter({
        capacityPerSecond: this.#capacity,
        ...(this.#now === undefined ? {} : { now: this.#now }),
      });
      this.#buckets.set(sessionId, bucket);
    }
    return bucket.tryTake();
  }

  /** 会话回收时逐出桶(断线保持到期回收路径;不存在时无操作)。 */
  evict(sessionId: string): void {
    this.#buckets.delete(sessionId);
  }
}

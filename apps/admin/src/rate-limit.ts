/**
 * 只读面频率闸(D-MP-5 分支 A)。
 *
 * 形态:**每客户端 IP 固定窗口**计数器(内存态,单实例口径)。
 *  - 管理面是共享凭证面(单宿主 / 少量租户部署口径,D-API-134),凭证
 *    猜解的主要成本来自网络往返;固定窗口频率闸把猜解速率压到配置上限
 *    (缺省 120/min),而不是靠"凭证要长"这类无法机检的口号。
 *  - 键 = 客户端 IP(非秘密、非凭证材料);**绝不**用凭证摘要做键——那会
 *    让秘密材料进入限流器的内存键空间,并使不同错误凭证各自获得独立桶
 *    (等于没有闸:攻击者换一个错凭证就是一个新桶)。
 *  - 桶表有界(过期清扫 + 上限兜底驱逐),内存占用不随来源数无界增长。
 *  - 触顶 = 429 + 冻结形态(复用 protocol `PublicErrorSchema` 的
 *    `budget_exhausted` 码;与 D-API-50 频率类冻结形态同码同文案族,
 *    零限流器状态透出)。
 */
import { PublicErrorSchema, type PublicError } from "@stackmaster/protocol";

/** 窗口长度(毫秒;固定窗口口径,60 秒)。 */
export const RATE_WINDOW_MS = 60_000;

/** 桶表上限(超出即驱逐最早写入的桶;来源数攻击不得让内存无界增长)。 */
export const MAX_RATE_BUCKETS = 10_000;

/** 限流触顶的冻结响应体(429;码 / 文案与 D-API-50 频率类同族)。 */
export const ADMIN_RATE_LIMITED_ERROR: PublicError = PublicErrorSchema.parse({
  code: "budget_exhausted",
  message: "rate limit exceeded",
});

/** 限流触顶响应体(测试锚点:路由必须逐字节发送本常量)。 */
export const ADMIN_RATE_LIMITED_STATUS = 429;

export class AdminRateLimiter {
  readonly #limit: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, { windowStart: number; count: number }>();

  constructor(
    limitPerMinute: number,
    now: () => number = () => Date.now(),
    private readonly maxBuckets: number = MAX_RATE_BUCKETS,
  ) {
    this.#limit = limitPerMinute;
    this.#now = now;
  }

  /** 放行判定(副作用:消耗一个名额)。 */
  allow(key: string): boolean {
    const now = this.#now();
    const bucket = this.#buckets.get(key);
    if (bucket === undefined || now - bucket.windowStart >= RATE_WINDOW_MS) {
      if (this.#buckets.size >= this.maxBuckets) {
        // 上限兜底:清掉已过窗的桶;若仍满则驱逐最早写入的一个。
        for (const [existing, value] of this.#buckets) {
          if (now - value.windowStart >= RATE_WINDOW_MS) {
            this.#buckets.delete(existing);
          }
        }
        if (this.#buckets.size >= this.maxBuckets) {
          const oldest = this.#buckets.keys().next();
          if (!oldest.done) {
            this.#buckets.delete(oldest.value);
          }
        }
      }
      this.#buckets.set(key, { windowStart: now, count: 1 });
      return true;
    }
    if (bucket.count >= this.#limit) {
      return false;
    }
    bucket.count += 1;
    return true;
  }
}

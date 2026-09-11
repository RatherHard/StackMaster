/**
 * 按消息类型的滑动窗口限速器(V-10;D-API-77 频率参数)。
 *
 * 每 embed 会话按消息类型独立计数,1 s 滑动窗口;超限 = 丢弃 + 计数
 * (V-12 零反馈)。入站(height_changed)与出站自限(theme_changed /
 * language_changed)共用同一实现,上限经构造注入(D-API-77 两个独立参数)。
 * 时钟注入:测试以假钟推进窗口滑动,零真实等待。
 */
export class TypeRateLimiter {
  private readonly windows = new Map<string, number[]>();

  public constructor(
    private readonly clock: () => number,
    private readonly limitOf: (type: string) => number,
  ) {}

  /**
   * 申请一次发送配额:窗口内配额未尽则记账并返回 true;超限返回 false
   * (调用方丢弃 + 计 v10-rate-limit)。
   */
  public tryAcquire(type: string): boolean {
    const now = this.clock();
    const cutoff = now - 1000;
    const window = (this.windows.get(type) ?? []).filter((t) => t > cutoff);
    if (window.length >= this.limitOf(type)) {
      this.windows.set(type, window);
      return false;
    }
    window.push(now);
    this.windows.set(type, window);
    return true;
  }
}

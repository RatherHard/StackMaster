/**
 * 有界发送缓冲(任务分解 WP-5 第 6 条,背压;D-API-44)。
 *
 * 出站帧一律先入本缓冲再写入 socket(单飞写:同一时刻至多一帧在写回调中
 * 等待完成)——不做服务端无界队列。慢消费者的表现是写回调迟迟不回调,队列
 * 随之堆积;队列长度达到上限即触发溢出路径(由构造方注入 onOverflow):
 * 尽力直发一帧错误说明后断开(关闭码 1013),断开走断线恢复路径(§4.2.3)。
 *
 * 溢出是一次性状态(overflowed):溢出后的 enqueue 一律拒绝,防止溢出路径
 * 本身再制造无界写;缓冲 dispose 后同理。帧序由 FIFO 保证——帧序 = 执行序
 * 的传输面前提(D-API-46)。
 */

/** 帧写出口(对 ws.WebSocket#send(data, cb) 的结构镜像;测试可注入替身)。 */
export type FrameWriteSink = (
  data: string,
  onWritten: (error: Error | null | undefined) => void,
) => void;

export interface BoundedSendBufferOptions {
  readonly sink: FrameWriteSink;
  /** 队列帧数上限(config.wssSendBufferLimit;≥ 1)。 */
  readonly limit: number;
  /** 溢出回调(超限断开路径:错误帧 + 关闭;至多触发一次)。 */
  readonly onOverflow: () => void;
  /** 写失败回调(连接级故障只进受控日志;'close' 事件随后收尾)。 */
  readonly onWriteError?: (error: Error) => void;
}

export class BoundedSendBuffer {
  readonly #options: BoundedSendBufferOptions;
  readonly #queue: string[] = [];
  readonly #drainWaiters: (() => void)[] = [];
  #writing = false;
  #disposed = false;
  #overflowed = false;

  constructor(options: BoundedSendBufferOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new Error("BoundedSendBuffer:limit 必须为正整数(config 启动校验已拦截)");
    }
    this.#options = options;
  }

  /** 在写或在队帧数(可观测 / 测试断言)。 */
  get pendingCount(): number {
    return this.#queue.length + (this.#writing ? 1 : 0);
  }

  /** 是否已溢出(溢出后拒绝一切新帧)。 */
  get overflowed(): boolean {
    return this.#overflowed;
  }

  /**
   * 入队一帧(已序列化文本):成功返回 true;缓冲已溢出 / 已释放,或本次入队
   * 即触发溢出,返回 false(调用方不得再入队)。
   */
  enqueue(text: string): boolean {
    if (this.#disposed || this.#overflowed) {
      return false;
    }
    if (this.#queue.length >= this.#options.limit) {
      this.#overflowed = true;
      this.#options.onOverflow();
      this.#settleWaiters();
      return false;
    }
    this.#queue.push(text);
    this.#drain();
    return true;
  }

  /**
   * 等待队列清空(优雅停机的有序冲刷,D-API-48);超时返回 false(调用方
   * 仍可关闭连接)。已清空立即返回 true。
   */
  async waitDrained(timeoutMs: number): Promise<boolean> {
    if (this.isDrained()) {
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const index = this.#drainWaiters.indexOf(settle);
        if (index >= 0) {
          this.#drainWaiters.splice(index, 1);
        }
        resolve(this.isDrained());
      }, timeoutMs);
      timer.unref();
      const settle = (): void => {
        clearTimeout(timer);
        resolve(this.isDrained());
      };
      this.#drainWaiters.push(settle);
    });
  }

  /** 是否已清空(无在写且无在队帧)。 */
  isDrained(): boolean {
    return this.pendingCount === 0;
  }

  /** 释放:丢弃队列,等待器全部落定;此后 enqueue 一律拒绝。 */
  dispose(): void {
    this.#disposed = true;
    this.#queue.length = 0;
    this.#settleWaiters();
  }

  #settleWaiters(): void {
    const waiters = this.#drainWaiters.splice(0, this.#drainWaiters.length);
    for (const waiter of waiters) {
      waiter();
    }
  }

  #drain(): void {
    if (this.#writing || this.#disposed) {
      return;
    }
    const next = this.#queue.shift();
    if (next === undefined) {
      this.#settleWaiters();
      return;
    }
    this.#writing = true;
    this.#options.sink(next, (error) => {
      this.#writing = false;
      if (error !== null && error !== undefined) {
        this.#options.onWriteError?.(error);
      }
      this.#drain();
    });
  }
}

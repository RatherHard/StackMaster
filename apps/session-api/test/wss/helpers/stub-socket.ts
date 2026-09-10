/**
 * 通道测试替身 socket(对 src/wss ChannelSocket 结构面的测试实现):
 * 写回调由测试手动释放(模拟慢消费者),事件由测试手动派发——绕开 injectWS
 * Duplexify 传输对"客户端发起 close → 服务端 close 事件"的传播局限,直接
 * 驱动 ActionChannelConnection 的事件面。
 */

interface PendingWrite {
  readonly data: string;
  readonly settle: (error?: Error) => void;
}

export class StubChannelSocket {
  /** 全部已请求写(含已回调;出序即下发序)。 */
  readonly sent: string[] = [];
  /** 尚未回调的写(慢消费者挂起面)。 */
  readonly pending: PendingWrite[] = [];
  readonly closes: { code?: number; reason?: string }[] = [];
  terminated = false;
  pingCount = 0;
  readonly #listeners = new Map<string, ((...args: never[]) => void)[]>();

  send(data: string, cb?: (err?: Error) => void): void {
    this.sent.push(data);
    this.pending.push({ data, settle: (error) => cb?.(error) });
  }

  ping(): void {
    this.pingCount += 1;
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  terminate(): void {
    this.terminated = true;
  }

  on(event: string, listener: (...args: never[]) => void): void {
    const existing = this.#listeners.get(event) ?? [];
    existing.push(listener);
    this.#listeners.set(event, existing);
  }

  // ── 测试驱动面 ──────────────────────────────────────────────────────────

  emitMessage(data: Buffer, isBinary = false): void {
    for (const listener of this.#listeners.get("message") ?? []) {
      (listener as (d: Buffer, b: boolean) => void)(data, isBinary);
    }
  }

  emitPong(): void {
    for (const listener of this.#listeners.get("pong") ?? []) {
      (listener as () => void)();
    }
  }

  emitClose(code = 1000): void {
    for (const listener of this.#listeners.get("close") ?? []) {
      (listener as (c: number, r: Buffer) => void)(code, Buffer.alloc(0));
    }
  }

  /** 释放当前全部挂起写回调(消费者追上一批;drain 会产生新的挂起写)。 */
  flushWrites(): void {
    for (const write of this.pending.splice(0, this.pending.length)) {
      write.settle();
    }
  }

  /** 反复释放直至无挂起写(微任务间 drain 出队后续帧)。 */
  async drainFully(rounds = 8): Promise<void> {
    for (let i = 0; i < rounds && this.pending.length > 0; i += 1) {
      this.flushWrites();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

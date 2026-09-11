/**
 * 测试假体(确定性纪律;与 embed-runtime test/helpers 同款形态):
 * 时钟 / 调度器 / parent 窗口 / 监听窗口 / port 全部为记录型假体——零真实等待、
 * 零网络、零真实 postMessage;MessageEvent 由 jsdom 构造(origin / source /
 * ports 可注入任意假体)。
 */
import type {
  PluginListenWindow,
  PluginParentWindow,
  PluginScheduler,
} from "../src/plugin/handshake.js";

/** 测试用宿主 origin(ready 的 event.origin / V-11 钉住值)。 */
export const HOST_ORIGIN = "https://host.example";

/** 测试用 esid(恰 22 字符 base64url 字符集,过 EmbedSessionIdSchema)。 */
export const TEST_ESID = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"; // 32 字符合法字符集。

/** 假时钟:手动推进的单调毫秒钟。 */
export class FakeClock {
  private t = 0;
  public now(): number {
    return this.t;
  }
  public advance(ms: number): void {
    this.t += ms;
  }
}

/** 假调度器:到期任务表;runDue 按到期时间序执行全部到期回调。 */
export class FakeScheduler implements PluginScheduler {
  private next = 1;
  private readonly tasks = new Map<number, { at: number; fn: () => void }>();

  public constructor(private readonly clock: FakeClock) {}

  public setTimeout(fn: () => void, delayMs: number): number {
    const id = this.next;
    this.next += 1;
    this.tasks.set(id, { at: this.clock.now() + delayMs, fn });
    return id;
  }

  public clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  /** 执行全部到期任务(回调内新设任务若也到期则继续执行;返回执行数)。 */
  public runDue(): number {
    let ran = 0;
    for (;;) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= this.clock.now())
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      const [, task] = due;
      this.tasks.delete(due[0]);
      task.fn();
      ran += 1;
    }
    return ran;
  }

  public get pendingCount(): number {
    return this.tasks.size;
  }
}

/** 一次 postToParent 调用的记录。 */
export interface ParentPostCall {
  readonly message: unknown;
  readonly targetOrigin: string;
}

/** 假 parent 窗口(window.parent 替身):记录全部出站调用。 */
export class FakeParentWindow implements PluginParentWindow {
  public readonly calls: ParentPostCall[] = [];

  public postMessage(message: unknown, targetOrigin: string): void {
    this.calls.push({ message, targetOrigin });
  }

  public get callCount(): number {
    return this.calls.length;
  }

  /** 按序取一条记录(越界即抛错——测试索引访问的确定性形态)。 */
  public at(index: number): ParentPostCall {
    const call = this.calls[index];
    if (call === undefined) {
      throw new Error(`postMessage 记录不存在:index=${String(index)},共 ${String(this.calls.length)} 条`);
    }
    return call;
  }

  /** 出站序列化形态(V-12 / V-13 断言用:零额外回复 / 零凭证)。 */
  public serializedOutbound(): string {
    return JSON.stringify(this.calls);
  }

  /** 最后一条出站信封(类型收窄由调用方断言)。 */
  public get lastMessage(): unknown {
    return this.calls[this.calls.length - 1]?.message;
  }

  public get lastTargetOrigin(): string | undefined {
    return this.calls[this.calls.length - 1]?.targetOrigin;
  }
}

/** 假监听窗口(globalThis message 监听面替身)。 */
export class FakeListenWindow implements PluginListenWindow {
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  public addEventListener(type: "message", listener: (event: MessageEvent) => void): void {
    if (type === "message") this.listeners.add(listener);
  }

  public removeEventListener(type: "message", listener: (event: MessageEvent) => void): void {
    if (type === "message") this.listeners.delete(listener);
  }

  /** 模拟宿主 → 插件的一条 message 事件(origin / source / ports 可注入)。 */
  public dispatchMessage(init: {
    data: unknown;
    origin?: string;
    source?: unknown;
    ports?: readonly unknown[];
  }): void {
    const event = new MessageEvent("message", {
      origin: init.origin ?? "",
      source: (init.source ?? null) as MessageEventSource | null,
      data: init.data,
      ports: (init.ports ?? []) as MessagePort[],
    });
    for (const listener of [...this.listeners]) listener(event);
  }
}

/** 假 MessagePort(onmessage 可写、postMessage 记录;零真实通道)。 */
export class FakePort {
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public readonly sent: unknown[] = [];

  public postMessage(message: unknown): void {
    this.sent.push(message);
  }

  /** 测试注入:模拟宿主经 port 下发一条消息。 */
  public dispatch(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

/** 手工驱动的 rAF 假体:登记回调,flush 时全部执行(合流语义由上游保证)。 */
export class FakeFrames {
  private queued: Array<() => void> = [];

  public requestAnimationFrame(fn: () => void): number {
    this.queued.push(fn);
    return this.queued.length;
  }

  public cancelAnimationFrame(handle: unknown): void {
    void handle; // 合流语义由 flush 检查;句柄不做精细回收。
  }

  /** 执行并清空队列(一帧);返回执行数。 */
  public flush(): number {
    const queued = this.queued;
    this.queued = [];
    for (const fn of queued) fn();
    return queued.length;
  }

  public get pendingCount(): number {
    return this.queued.length;
  }
}

/** 构造合法 ready 信封(结构化对象形态,WP-51 wire 形态)。 */export function readyMessage(
  sessionId: string,
  overrides: {
    seq?: number;
    grantedCapabilities?: string[];
    theme?: string;
    language?: string;
    extra?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    protocolVersion: 1,
    type: "ready",
    sessionId,
    seq: overrides.seq ?? 1,
    payload: {
      grantedCapabilities: overrides.grantedCapabilities ?? ["theme", "language", "auto_resize"],
      config: { theme: overrides.theme ?? "light", language: overrides.language ?? "zh-CN" },
    },
    ...overrides.extra,
  };
}

/** 构造控制消息信封。 */
export function controlMessage(
  type: "theme_changed" | "language_changed",
  sessionId: string,
  seq: number,
  value: string,
): Record<string, unknown> {
  return {
    protocolVersion: 1,
    type,
    sessionId,
    seq,
    payload: type === "theme_changed" ? { theme: value } : { language: value },
  };
}

/** 等待微任务队列排空(引导配置取回 / createSession 链路的确定性推进)。 */
export async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

/* ── 会话通道假体(端到端集成:mock session-api 的 REST / WSS 面)────────── */

/** 标准公开投影夹具(经冻结 Schema 自检构造;形态同 vm-ui 测试基建)。 */
export function makeProjection(): Record<string, unknown> {
  return {
    revision: 0,
    visibleRegions: [
      {
        regionId: "region-stack",
        label: "stack",
        startAddressHex: "0x1000",
        byteLength: 4096,
        permissions: "rw",
        bytesHex: "0102030405060708",
        truncated: false,
      },
    ],
    visibleRegisters: [
      { name: "RSP", valueHex: "0xB000" },
      { name: "RBP", valueHex: "0xB008" },
    ],
    callStackSummary: [],
    controlFlow: { currentInstruction: { addressHex: "0x0040", text: "push rbp" }, pausedOn: null },
    semanticHighlights: [
      {
        kind: "buffer_start",
        targetRegionId: "region-stack",
        startAddressHex: "0x1000",
        byteLength: 4,
        label: "buffer",
      },
    ],
    status: "paused",
  };
}

/** create_session 冻结响应形态(201 体;响应信封无 protocolVersion 字段)。 */
export function createSessionResponseBody(sessionId: string): Record<string, unknown> {
  return {
    command: "create_session",
    payload: { sessionId, revision: 0, projection: makeProjection() },
  };
}

/** 可手工驱动的假 WebSocket(vm-ui 测试基建同款形态的最小子集)。 */
export class FakeWebSocket {
  public readonly url: string;
  public onopen: ((event: unknown) => void) | null = null;
  public onclose: ((event: { code: number; reason: string }) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public readonly sent: string[] = [];

  public constructor(url: string) {
    this.url = url;
    // onopen 在工厂返回、SessionClient 挂好回调之后异步触发。
    queueMicrotask(() => {
      this.onopen?.(new Event("open"));
    });
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(code = 1000, reason = ""): void {
    this.onclose?.({ code, reason });
  }
}

/** mock fetch 假体的请求记录形态。 */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}


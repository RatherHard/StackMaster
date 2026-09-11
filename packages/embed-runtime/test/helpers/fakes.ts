/**
 * 测试假体(确定性纪律):时钟 / 调度器 / 宿主窗口 / iframe 与插件窗口全部
 * 为记录型假体——零真实等待、零网络、零真实 postMessage;MessageEvent 由
 * jsdom 构造(origin / source 可注入任意假窗口)。
 */
import {
  createEmbedSession,
  EMBED_SESSION_EVENTS,
  type EmbedHandshakeCompleteDetail,
  type EmbedHeightChangedDetail,
  type EmbedReloadInitiatedDetail,
  type EmbedSessionOptions,
  type EmbedSessionUnavailableDetail,
  type EmbedSessionUnavailableReason,
  type EmbedViolationCountersChangedDetail,
  type RandomBytesFn,
} from "../../src/index.js";

/** 测试用插件来源(非 opaque 路径的 V-1 预期值)。 */
export const PLUGIN_ORIGIN = "https://plugin.example";
/** 测试用插件 URL(不含 fragment;esid 由 SDK 附加)。 */
export const PLUGIN_URL = "https://plugin.example/vm/index.html";

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
export class FakeScheduler {
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
      const [id, task] = due;
      this.tasks.delete(id);
      task.fn();
      ran += 1;
    }
    return ran;
  }

  public get pendingCount(): number {
    return this.tasks.size;
  }
}

/** 假宿主窗口:记录监听器;dispatchMessage 注入 origin / source / data。 */
export class FakeHostWindow {
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  public addEventListener(type: "message", listener: (event: MessageEvent) => void): void {
    if (type === "message") this.listeners.add(listener);
  }

  public removeEventListener(type: "message", listener: (event: MessageEvent) => void): void {
    if (type === "message") this.listeners.delete(listener);
  }

  /** 模拟插件向宿主 window 发来一条 message 事件。 */
  public dispatchMessage(origin: string, source: unknown, data: unknown): void {
    const event = new MessageEvent("message", {
      origin,
      source: source as MessageEventSource | null,
      data,
    });
    for (const listener of [...this.listeners]) listener(event);
  }
}

/** 一次 contentWindow.postMessage 调用的记录。 */
export interface PostMessageCall {
  readonly message: unknown;
  readonly targetOrigin: string;
  readonly transfer: readonly Transferable[] | undefined;
}

/** 假插件窗口(iframe.contentWindow 替身):记录全部出站调用。 */
export class FakePluginWindow {
  public readonly calls: PostMessageCall[] = [];

  public postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void {
    this.calls.push({ message, targetOrigin, transfer });
  }

  public get callCount(): number {
    return this.calls.length;
  }

  /** 出站载荷的序列化形态(V-12 / V-13 断言用:零回复 / 零凭证)。 */
  public serializedOutbound(): string {
    return JSON.stringify(this.calls.map((call) => ({ m: call.message, o: call.targetOrigin })));
  }
}

/** 假 iframe:contentWindow 可变(重载模拟:换成新窗口实例)。 */
export class FakeIframe {
  public contentWindow: FakePluginWindow | null;

  public constructor(contentWindow: FakePluginWindow | null = new FakePluginWindow()) {
    this.contentWindow = contentWindow;
  }
}

/**
 * 确定性随机源:每次调用产出不同的合法 base64url 字节序列(仅大写字母,
 * 字符集与 22 字符长度满足 EmbedSessionIdSchema;真实熵由 CSPRNG 保证,
 * 本假体只为测试确定性)。
 */
export function deterministicRandomBytes(): RandomBytesFn {
  let call = 0;
  return (size: number) => {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) {
      out[i] = 65 + ((call * 17 + i * 5) % 26);
    }
    call += 1;
    return out;
  };
}

/** 会话事件收集器(事件驱动 API 面的断言锚)。 */
export interface RecordedEvents {
  handshake: EmbedHandshakeCompleteDetail[];
  unavailable: EmbedSessionUnavailableDetail[];
  counters: EmbedViolationCountersChangedDetail[];
  height: EmbedHeightChangedDetail[];
  reloads: EmbedReloadInitiatedDetail[];
}

export interface Harness {
  readonly clock: FakeClock;
  readonly scheduler: FakeScheduler;
  readonly hostWindow: FakeHostWindow;
  readonly iframe: FakeIframe;
  readonly session: ReturnType<typeof createEmbedSession>;
  readonly events: RecordedEvents;
  readonly plugin: FakePluginWindow;
}

/** 组装假体并创建会话(挂接 iframe、收集全部事件)。 */
export function startHarness(
  options: Partial<EmbedSessionOptions> = {},
  random: RandomBytesFn = deterministicRandomBytes(),
): Harness {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const hostWindow = new FakeHostWindow();
  const iframe = new FakeIframe();
  const events: RecordedEvents = {
    handshake: [],
    unavailable: [],
    counters: [],
    height: [],
    reloads: [],
  };
  const session = createEmbedSession({
    pluginOrigin: PLUGIN_ORIGIN,
    pluginUrl: PLUGIN_URL,
    config: { theme: "light", language: "zh-CN" },
    randomBytes: random,
    clock: () => clock.now(),
    scheduler,
    hostWindow,
    ...options,
  });
  const record = <T>(list: T[]): (event: Event) => void => {
    return (event: Event) => {
      list.push((event as CustomEvent<T>).detail);
    };
  };
  session.addEventListener(EMBED_SESSION_EVENTS.handshakeComplete, record(events.handshake));
  session.addEventListener(EMBED_SESSION_EVENTS.sessionUnavailable, record(events.unavailable));
  session.addEventListener(
    EMBED_SESSION_EVENTS.violationCountersChanged,
    record(events.counters),
  );
  session.addEventListener(EMBED_SESSION_EVENTS.heightChanged, record(events.height));
  session.addEventListener(EMBED_SESSION_EVENTS.reloadInitiated, record(events.reloads));
  session.attachIframe(iframe);
  return { clock, scheduler, hostWindow, iframe, session, events, plugin: iframe.contentWindow as FakePluginWindow };
}

/** 构造合法 hello 信封(JSON 字符串形态,与真实插件 postMessage 一致)。 */
export function helloJson(
  sessionId: string,
  overrides: {
    seq?: number;
    supportedVersions?: number[];
    capabilities?: string[];
    protocolVersion?: number;
    extra?: Record<string, unknown>;
  } = {},
): string {
  return JSON.stringify({
    protocolVersion: overrides.protocolVersion ?? 1,
    type: "hello",
    sessionId,
    seq: overrides.seq ?? 1,
    payload: {
      supportedVersions: overrides.supportedVersions ?? [1],
      capabilities: overrides.capabilities ?? ["theme", "language", "auto_resize"],
    },
    ...overrides.extra,
  });
}

/** 构造 height_changed 信封(JSON 字符串)。 */
export function heightChangedJson(sessionId: string, seq: number, heightPx = 320): string {
  return JSON.stringify({
    protocolVersion: 1,
    type: "height_changed",
    sessionId,
    seq,
    payload: { heightPx },
  });
}

/** 走完常规握手(非 opaque:load → hello → ready 已发出)。 */
export function completeHandshake(
  harness: Harness,
  overrides: {
    capabilities?: string[];
    supportedVersions?: number[];
    seq?: number;
    origin?: string;
  } = {},
): void {
  harness.session.notifyIframeLoad();
  harness.hostWindow.dispatchMessage(
    overrides.origin ?? PLUGIN_ORIGIN,
    harness.iframe.contentWindow,
    helloJson(harness.session.getEmbedSessionId(), overrides),
  );
}

/** 不可用原因的便捷断言值。 */
export const UNAVAILABLE_REASONS: readonly EmbedSessionUnavailableReason[] = [
  "handshake-timeout",
  "version-negotiation-failed",
  "disposed",
];

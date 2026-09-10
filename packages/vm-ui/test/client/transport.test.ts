/**
 * transport.ts 测试(WP-F2):浏览器 WebSocket 适配器、缺省调度面、
 * WSS 通道 URL 解析(Node 无 location 环境的确定性失败)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserWebSocketAdapter,
  defaultFrameCanceler,
  defaultFrameScheduler,
  defaultWebSocketFactory,
  defaultTimerCanceler,
  defaultTimerScheduler,
  resolveWebSocketUrl,
  type WsLikeCloseEvent,
  type WsLikeMessageEvent,
} from "../../src/client/transport.js";
import { SessionClientError } from "../../src/client/session-errors.js";

/** 浏览器 WebSocket 的结构替身(事件以可写属性承载,与 DOM 同形)。 */
class NativeWebSocketFake {
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.onclose?.({ code: code ?? 1005, reason: reason ?? "" });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BrowserWebSocketAdapter", () => {
  it("send / close 透传原生套接字", () => {
    const native = new NativeWebSocketFake();
    const adapter = new BrowserWebSocketAdapter(native as unknown as WebSocket);

    adapter.send("frame-text");
    expect(native.sent).toEqual(["frame-text"]);

    adapter.close(1000, "bye");
    expect(native.closed).toEqual({ code: 1000, reason: "bye" });
  });

  it("事件绑定收窄为最小结构面(open / message / close / error)", () => {
    const native = new NativeWebSocketFake();
    const adapter = new BrowserWebSocketAdapter(native as unknown as WebSocket);

    const events: string[] = [];
    let closeEvent: WsLikeCloseEvent | null = null;
    let messageData: unknown = null;
    adapter.onopen = () => events.push("open");
    adapter.onmessage = (event: WsLikeMessageEvent) => {
      messageData = event.data;
      events.push("message");
    };
    adapter.onclose = (event: WsLikeCloseEvent) => {
      closeEvent = event;
      events.push("close");
    };
    adapter.onerror = () => events.push("error");

    // 原生事件 → 适配面(参数收窄)。
    const nativeWithEvents = native as unknown as {
      onopen: (() => void) | null;
      onmessage: ((event: { data: string }) => void) | null;
      onclose: ((event: { code: number; reason: string }) => void) | null;
      onerror: (() => void) | null;
    };
    nativeWithEvents.onopen?.();
    nativeWithEvents.onmessage?.({ data: "payload" });
    nativeWithEvents.onclose?.({ code: 1000, reason: "idle timeout" });
    nativeWithEvents.onerror?.();

    expect(events).toEqual(["open", "message", "close", "error"]);
    expect(messageData).toBe("payload");
    expect(closeEvent).toEqual({ code: 1000, reason: "idle timeout" });
    // 读取面回读(可空处理器)。
    expect(adapter.onopen).toBeTypeOf("function");
    expect(adapter.onclose).toBeTypeOf("function");
  });

  it("处理器可置空卸载", () => {
    const native = new NativeWebSocketFake();
    const adapter = new BrowserWebSocketAdapter(native as unknown as WebSocket);
    adapter.onopen = null;
    adapter.onmessage = null;
    adapter.onclose = null;
    adapter.onerror = null;
    expect(adapter.onopen).toBeNull();
    expect(adapter.onmessage).toBeNull();
    expect(adapter.onclose).toBeNull();
    expect(adapter.onerror).toBeNull();
    // 卸载后原生事件不触发(null 安全调用)。
    const nativeWithEvents = native as unknown as { onopen: (() => void) | null };
    expect(() => nativeWithEvents.onopen?.()).not.toThrow();
  });
});

describe("缺省工厂与调度面", () => {
  it("defaultWebSocketFactory 产出 WsLikeSocket 适配面(注册即用)", () => {
    const socket = defaultWebSocketFactory("ws://127.0.0.1:1/sessions/channel");
    expect(socket).toBeInstanceOf(BrowserWebSocketAdapter);
    expect(socket.onopen).toBeNull();
    socket.onerror = () => undefined; // 测试环境连接必然失败:吞掉错误事件。
    socket.close();
  });

  it("缺省 rAF 调度/取消在 requestAnimationFrame 环境走帧回调", () => {
    const global = globalThis as {
      requestAnimationFrame?: unknown;
      cancelAnimationFrame?: unknown;
    };
    const originalRaf = global.requestAnimationFrame;
    const originalCancel = global.cancelAnimationFrame;
    const pending = new Map<number, () => void>();
    let nextHandle = 1;
    let cancelled: number | null = null;
    global.requestAnimationFrame = (callback: () => void) => {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, callback);
      return handle;
    };
    global.cancelAnimationFrame = (handle: number) => {
      cancelled = handle;
    };
    try {
      let ran = false;
      const handle = defaultFrameScheduler(() => {
        ran = true;
      });
      expect(handle).toBeGreaterThan(0);
      expect(ran).toBe(false);
      pending.get(handle)?.();
      expect(ran).toBe(true);
      defaultFrameCanceler(handle);
      expect(cancelled).toBe(handle);
    } finally {
      global.requestAnimationFrame = originalRaf;
      global.cancelAnimationFrame = originalCancel;
    }
  });

  it("缺省定时器调度/取消为全局 setTimeout / clearTimeout", async () => {
    let ran = false;
    const handle = defaultTimerScheduler(() => {
      ran = true;
    }, 1);
    defaultTimerCanceler(handle); // 取消后再排一个真定时器验证 cancel 形态可用。
    const second = defaultTimerScheduler(() => undefined, 1);
    defaultTimerCanceler(second);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toBe(false);
  });
});

describe("resolveWebSocketUrl", () => {
  it("http(s) baseUrl 映射为 ws(s) 并拼接 /sessions/channel", () => {
    expect(resolveWebSocketUrl("http://127.0.0.1:13000")).toBe(
      "ws://127.0.0.1:13000/sessions/channel",
    );
    expect(resolveWebSocketUrl("https://example.host")).toBe("wss://example.host/sessions/channel");
  });

  it("无 baseUrl 时回退浏览器同源 location(jsdom 环境验证)", () => {
    const url = resolveWebSocketUrl(undefined);
    expect(url.startsWith("ws://")).toBe(true);
    expect(url.endsWith("/sessions/channel")).toBe(true);
  });

  it("无 baseUrl 且无 location(Node)抛 invalid_url", () => {
    const global = globalThis as { location?: unknown };
    const original = global.location;
    vi.stubGlobal("location", undefined);
    try {
      expect(() => resolveWebSocketUrl(undefined)).toThrow(SessionClientError);
    } finally {
      vi.stubGlobal("location", original);
    }
  });
});

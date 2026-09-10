/**
 * 可注入传输层抽象(WP-F2):SessionClient 的浏览器 / Node 双面接缝。
 *
 * 设计目标:SessionClient 不绑定具体 fetch / WebSocket / rAF / 时钟实现——
 *  - 浏览器:同源 fetch(credentials: "include" 自动携带会话 Cookie)+
 *    原生 WebSocket(升级请求自动带同源 Cookie);
 *  - Node 集成冒烟(WP-F7 Playwright 之前的路径):注入 undici fetch + `ws`
 *    包装(手动呈递 Cookie 头),复用同一客户端实现(接入方式见 README);
 *  - 测试:注入假实现全链路驱动,不开真实套接字。
 */
import { SessionClientError } from "./session-errors.js";

/** WSS 消息事件的最小结构面(浏览器 MessageEvent 的结构子集)。 */
export interface WsLikeMessageEvent {
  readonly data: unknown;
}

/** WSS 关闭事件的最小结构面(RFC 6455 关闭码 + 原因短句)。 */
export interface WsLikeCloseEvent {
  readonly code: number;
  readonly reason: string;
}

/**
 * WebSocket 最小结构面(SessionClient 消费;浏览器 WebSocket 经
 * BrowserWebSocketAdapter 适配,测试/Node 直接实现本接口)。
 */
export interface WsLikeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: WsLikeMessageEvent) => void) | null;
  onclose: ((event: WsLikeCloseEvent) => void) | null;
  onerror: (() => void) | null;
}

/** WebSocket 工厂:按 URL 产出未连接的套接字(连接发起方是 SessionClient)。 */
export type WebSocketFactory = (url: string) => WsLikeSocket;

/**
 * 浏览器 WebSocket 适配器:把原生 WebSocket 包装成 WsLikeSocket 的窄面
 * (事件参数收窄为最小结构面,SessionClient 不依赖 DOM 事件类型)。
 */
export class BrowserWebSocketAdapter implements WsLikeSocket {
  readonly #native: WebSocket;

  constructor(native: WebSocket) {
    this.#native = native;
  }

  send(data: string): void {
    this.#native.send(data);
  }

  close(code?: number, reason?: string): void {
    this.#native.close(code, reason);
  }

  get onopen(): (() => void) | null {
    return this.#openHandler;
  }

  set onopen(handler: (() => void) | null) {
    this.#openHandler = handler;
    this.#native.onopen = () => handler?.();
  }

  get onmessage(): ((event: WsLikeMessageEvent) => void) | null {
    return this.#messageHandler;
  }

  set onmessage(handler: ((event: WsLikeMessageEvent) => void) | null) {
    this.#messageHandler = handler;
    this.#native.onmessage = (event: MessageEvent) => handler?.({ data: event.data });
  }

  get onclose(): ((event: WsLikeCloseEvent) => void) | null {
    return this.#closeHandler;
  }

  set onclose(handler: ((event: WsLikeCloseEvent) => void) | null) {
    this.#closeHandler = handler;
    this.#native.onclose = (event: CloseEvent) =>
      handler?.({ code: event.code, reason: event.reason });
  }

  get onerror(): (() => void) | null {
    return this.#errorHandler;
  }

  set onerror(handler: (() => void) | null) {
    this.#errorHandler = handler;
    this.#native.onerror = () => handler?.();
  }

  #openHandler: (() => void) | null = null;
  #messageHandler: ((event: WsLikeMessageEvent) => void) | null = null;
  #closeHandler: ((event: WsLikeCloseEvent) => void) | null = null;
  #errorHandler: (() => void) | null = null;
}

/** 缺省 WebSocket 工厂:浏览器原生 WebSocket(同源升级自动携带会话 Cookie)。 */
export const defaultWebSocketFactory: WebSocketFactory = (url) =>
  new BrowserWebSocketAdapter(new WebSocket(url));

/** rAF 调度面:合帧回调注册(返回句柄)与取消。 */
export type FrameScheduler = (callback: () => void) => number;
export type FrameCanceler = (handle: number) => void;

/**
 * 缺省 rAF:浏览器 requestAnimationFrame;无 rAF 的环境(Node / SSR)降级为
 * 微任务批处理(queueMicrotask,不可取消,句柄恒 0——dispose 以 disposed
 * 标记拦截迟到回调)。
 */
export const defaultFrameScheduler: FrameScheduler = (callback) => {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(() => callback());
  }
  queueMicrotask(callback);
  return 0;
};

/** 缺省 rAF 取消:句柄 0 为微任务降级形态,不可取消,静默忽略。 */
export const defaultFrameCanceler: FrameCanceler = (handle) => {
  if (handle !== 0 && typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(handle);
  }
};

/** 定时器句柄(跨浏览器 number 与 Node Timeout 的不透明面)。 */
export type TimerHandle = unknown;

export type TimerScheduler = (callback: () => void, delayMs: number) => TimerHandle;
export type TimerCanceler = (handle: TimerHandle) => void;

/** 缺省定时器:全局 setTimeout / clearTimeout(重连指数退避承载)。 */
export const defaultTimerScheduler: TimerScheduler = (callback, delayMs) =>
  setTimeout(callback, delayMs);

export const defaultTimerCanceler: TimerCanceler = (handle) => {
  clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
};

/** WSS 通道服务端路由(冻结路由表 D-API-1;路径归 session-api 实现面)。 */
export const WSS_CHANNEL_PATH = "/sessions/channel";

/**
 * 解析 WSS 通道 URL:`GET /sessions/channel` 的 WebSocket 升级地址。
 *  - 有 baseUrl:http(s) → ws(s) 同 host 拼接;
 *  - 无 baseUrl:浏览器同源(location);两者皆无(Node 未配 baseUrl)抛错。
 */
export function resolveWebSocketUrl(baseUrl: string | undefined): string {
  let url: URL;
  if (baseUrl !== undefined && baseUrl !== "") {
    url = new URL(WSS_CHANNEL_PATH, baseUrl);
  } else {
    const location = (globalThis as { location?: { href: string } }).location;
    if (location === undefined) {
      throw new SessionClientError(
        "invalid_url",
        "未提供 baseUrl 且当前环境无 location:无法解析 WSS 通道地址(Node 集成须显式注入 baseUrl)",
      );
    }
    url = new URL(WSS_CHANNEL_PATH, location.href);
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

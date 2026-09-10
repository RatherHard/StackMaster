/**
 * WP-F2 测试基建:协议夹具与 mock 传输面(session-client 全链路测试用)。
 *
 * 夹具一律经冻结 Schema 自检构造(漂移即测试红灯);mock fetch 带浏览器
 * Cookie 罐语义(Set-Cookie → 后续请求携带),mock WebSocket 手工驱动
 * open / message / close 事件,不开真实套接字。
 */
import {
  ActionResponseSchema,
  ProjectionDeltaSchema,
  PublicStateProjectionSchema,
  WssFrameSchema,
  SESSION_ACTION_PROTOCOL_VERSION,
  type ActionObject,
  type ActionResponse,
  type ProjectionDelta,
  type PublicStateProjection,
  type WssFrame,
} from "@stackmaster/protocol";

import type {
  TimerCanceler,
  TimerScheduler,
  WsLikeCloseEvent,
  WsLikeMessageEvent,
  WsLikeSocket,
} from "../../src/client/transport.js";

// ── 常量与夹具 ──────────────────────────────────────────────────────────────

export const SESSION_ID = "session-0001";
export const CREATE_INPUT = {
  challengeId: "challenge-0001",
  challengeVersion: "1.0.0",
  embedSessionId: "embed-session-fixture-0001",
  embedToken: "embed-token-fixture-0001",
} as const;
export const SESSION_COOKIE = "sm_session=fixture-cookie-value";

/** 标准公开投影夹具:区域 region-stack @0x1000(窗口 8 字节)+ 寄存器 RSP/RIP。 */
export function makeProjection(overrides: Partial<PublicStateProjection> = {}): PublicStateProjection {
  return PublicStateProjectionSchema.parse({
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
    controlFlow: {
      currentInstruction: { addressHex: "0x0040", text: "push rbp" },
      pausedOn: null,
    },
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
    ...overrides,
  });
}

/** 投影增量夹具(经冻结 Schema 自检)。 */
export function makeDelta(overrides: Partial<ProjectionDelta> = {}): ProjectionDelta {
  return ProjectionDeltaSchema.parse({
    revision: 1,
    dirtyRanges: [],
    changedRegisters: [],
    ...overrides,
  });
}

/** ActionResponse 夹具(经冻结 Schema 自检;rejected 耦合由 Schema 机检)。 */
export function makeActionResponse(
  overrides: Partial<ActionResponse> & Pick<ActionResponse, "revision" | "status">,
): ActionResponse {
  return ActionResponseSchema.parse({
    requestId: "srv-request-0001",
    projectionDelta: null,
    publicEvents: [],
    ...overrides,
  });
}

/** 服务端出站帧封装(经冻结 Schema 自检;协议版本恒锚定 v1)。 */
export function serverFrame(
  type: "action_response" | "error" | "action",
  payload: unknown,
  seq = 1,
  requestId?: string,
): WssFrame {
  return WssFrameSchema.parse({
    protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
    type,
    sessionId: SESSION_ID,
    seq,
    ...(requestId === undefined ? {} : { requestId }),
    payload,
  });
}

/** step 动作(无参动作的 args 空对象形态)。 */
export function stepAction(): ActionObject {
  return { type: "step", args: {} };
}

/** write_bytes 动作夹具。 */
export function writeAction(addressHex: string, bytesHex: string): ActionObject {
  return { type: "write_bytes", args: { addressHex, bytesHex } };
}

// ── 微任务冲刷(REST mock / sync 兑现等待)────────────────────────────────

export async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

// ── Mock fetch:浏览器 Cookie 罐语义 ─────────────────────────────────────────

export interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit;
  /** mock 浏览器注入的 Cookie 头(jar 非空时携带;模拟 credentials: "include")。 */
  readonly cookieHeader: string | null;
}

export interface MockResponse {
  readonly status: number;
  readonly body: unknown;
  /** 模拟 Set-Cookie 响应头(单值;mock 罐解析 name=value 前缀对)。 */
  readonly setCookie?: string;
  /** true = json() 拒绝(模拟非 JSON 响应体:网关错误页等)。 */
  readonly malformedJson?: boolean;
}

export interface MockFetch {
  readonly fetch: typeof fetch;
  readonly calls: readonly RecordedRequest[];
  /** 最近一次调用便捷访问。 */
  lastCall(): RecordedRequest;
}

export function createMockFetch(handler: (request: RecordedRequest) => MockResponse): MockFetch {
  const calls: RecordedRequest[] = [];
  const jar = new Map<string, string>();
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    // 相对路径按 mock 基址解析(浏览器同源语义的替身;绝对 URL 不受影响)。
    const url = new URL(typeof input === "string" ? input : input.toString(), "http://mock.local").toString();
    const requestInit: RequestInit = init ?? {};
    const cookieHeader =
      jar.size === 0
        ? null
        : [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    const request: RecordedRequest = { url, init: requestInit, cookieHeader };
    calls.push(request);
    const response = handler(request);
    if (response.setCookie !== undefined) {
      const pair = response.setCookie.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      headers: { get: (name: string) => (name === "set-cookie" ? (response.setCookie ?? null) : null) },
      json: async () => {
        if (response.malformedJson === true) {
          throw new SyntaxError("unexpected token (mock non-json body)");
        }
        return response.body;
      },
    };
  }) as unknown as typeof fetch;
  return {
    fetch: fetchImpl,
    calls,
    lastCall: () => {
      const last = calls[calls.length - 1];
      if (last === undefined) {
        throw new Error("mock fetch:无已记录请求");
      }
      return last;
    },
  };
}

// ── Fake WebSocket:手工驱动的套接字 ────────────────────────────────────────

export class FakeWebSocket implements WsLikeSocket {
  static instances: FakeWebSocket[] = [];

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  static get last(): FakeWebSocket {
    const last = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (last === undefined) {
      throw new Error("fake websocket:尚无实例");
    }
    return last;
  }

  readonly url: string;
  /** 已发送的帧(JSON 解析后;非字符串形态)。 */
  readonly sent: unknown[] = [];
  closed = false;
  closeCode: number | null = null;
  closeReason = "";

  onopen: (() => void) | null = null;
  onmessage: ((event: WsLikeMessageEvent) => void) | null = null;
  onclose: ((event: WsLikeCloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.closed) {
      throw new Error("fake websocket:send on closed socket");
    }
    this.sent.push(JSON.parse(data) as unknown);
  }

  /** 客户端面 close(与浏览器语义一致:触发自身 onclose)。 */
  close(code = 1005, reason = ""): void {
    this.serverCloses(code, reason);
  }

  // ── 测试驱动面(模拟服务端行为)──

  serverAccepts(): void {
    this.onopen?.();
  }

  serverSends(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  serverSendsText(text: string): void {
    this.onmessage?.({ data: text });
  }

  serverCloses(code: number, reason: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.onclose?.({ code, reason });
  }
}

export function fakeWebSocketFactory(url: string): FakeWebSocket {
  return new FakeWebSocket(url);
}

// ── Fake rAF / Fake timers ──────────────────────────────────────────────────

/** 手工冲刷的帧调度器(每帧回调注册后由 flush 统一执行)。 */
export class FakeFrames {
  readonly #pending = new Map<number, () => void>();
  readonly #nextHandle = { value: 1 };

  readonly raf = (callback: () => void): number => {
    const handle = this.#nextHandle.value;
    this.#nextHandle.value += 1;
    this.#pending.set(handle, callback);
    return handle;
  };

  readonly cancelRaf = (handle: number): void => {
    this.#pending.delete(handle);
  };

  get scheduledCount(): number {
    return this.#pending.size;
  }

  /** 执行全部挂起帧回调(本轮注册的不递归执行)。 */
  flush(): void {
    const callbacks = [...this.#pending.values()];
    this.#pending.clear();
    for (const callback of callbacks) {
      callback();
    }
  }
}

/** 手工推进的定时器队列(重连退避测试用)。 */
export class FakeTimers {
  readonly #pending: { handle: number; due: number; callback: () => void }[] = [];
  readonly #nextHandle = { value: 1 };
  currentTime = 0;

  readonly schedule: TimerScheduler = (callback, delayMs) => {
    const handle = this.#nextHandle.value;
    this.#nextHandle.value += 1;
    this.#pending.push({ handle, due: this.currentTime + delayMs, callback });
    return { handle };
  };

  readonly cancel: TimerCanceler = (handle) => {
    const value = (handle as { handle: number }).handle;
    const index = this.#pending.findIndex((timer) => timer.handle === value);
    if (index >= 0) {
      this.#pending.splice(index, 1);
    }
  };

  get size(): number {
    return this.#pending.length;
  }

  /** 推进到最近的定时器并执行(微任务冲刷后返回是否执行了)。 */
  async runNext(): Promise<boolean> {
    this.#pending.sort((a, b) => a.due - b.due);
    const next = this.#pending.shift();
    if (next === undefined) {
      return false;
    }
    this.currentTime = next.due;
    next.callback();
    await settle();
    return true;
  }
}

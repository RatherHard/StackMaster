/**
 * DebugChannelClient —— 浏览器 ↔ 编排器调试通道客户端(WP-F8;WP-40 协议
 * 语义 §二/§三/§四/§九;ADR-DC1 条款 1 / 决议 3 / §六 R3)。
 *
 * 与既有 WSS 动作通道(SessionClient)同构的最小连接面,**独立端点 + 独立
 * 协议版本**(既有通道零触碰,D-API-2 不受影响):
 *  - **连接级版本锚定**:本客户端所有帧恒携带
 *    `DEBUG_CHANNEL_PROTOCOL_VERSION`(首帧定版,服务端拒绝漂移);
 *  - **attach 自动化**:连接打开即发送 `debug_attach`(origin 由构造选项
 *    承载:revision 起点 / checkpoint 日志位置引用,禁止真实快照字节);
 *    attach → `debug_attached` → 服务端推送 `debug_function_table` 恰一次;
 *    每次暂停推送暂停落点的 `debug_instruction_stream`(§九推送模型);
 *  - **方向检查**:客户端只发 5 值请求帧;收到 C→S 类型帧按契约漂移处理;
 *  - **requestId 关联**:请求帧携带生成器签发的 requestId;响应对应帧回显
 *    同一值(传输层关联);推送帧不带 requestId(§九,唯一例外 = attach
 *    伴生的 function_table 回显 attach 的 requestId);
 *  - **无自动重连(v1 登记)**:调试通道是展示通道,重连 = 重新 attach
 *    (重放对齐由服务端承担);断线后由用户重新切换调试模式或再次 connect;
 *  - 错误帧 = 冻结 PublicError 形态(16 错误码封闭枚举零扩展)。
 *
 * 纪律:本客户端只消费调试通道数据(其公开性由零装载保证,ADR-DC1 条款 2),
 * 不旁路真实私有包内容;浏览器只保存公开投影与 UI 状态。传输层可注入
 * (复用 client/transport.ts 的 WsLikeSocket / WebSocketFactory)。
 */
import {
  DEBUG_CHANNEL_PROTOCOL_VERSION,
  DEBUG_SERVER_TO_CLIENT_TYPES,
  DebugFrameSchema,
  type DebugAttachOrigin,
  type DebugFrame,
  type PublicError,
} from "@stackmaster/protocol";

import {
  defaultWebSocketFactory,
  type WebSocketFactory,
  type WsLikeSocket,
} from "./transport.js";

// ── 公开类型 ───────────────────────────────────────────────────────────────

/** 调试通道连接状态(简化三态:连接中 / 已连接 / 已断开;v1 无自动重连)。 */
export type DebugChannelStatus = "connecting" | "connected" | "disconnected";

/** 调试通道事件(S→C 帧 + 连接状态的判别联合;数据源订阅消费)。 */
export type DebugChannelEvent =
  | { readonly kind: "attached"; readonly payload: DebugAttachedPayload }
  | { readonly kind: "window-data"; readonly payload: DebugWindowDataPayload }
  | { readonly kind: "paused"; readonly payload: DebugPausedPayload }
  | { readonly kind: "search-results"; readonly payload: DebugSearchResultsPayload }
  | { readonly kind: "instruction-stream"; readonly payload: DebugChannelInstructionStreamPayload }
  | { readonly kind: "function-table"; readonly payload: DebugChannelFunctionTablePayload }
  | { readonly kind: "error"; readonly error: PublicError }
  | { readonly kind: "status"; readonly status: DebugChannelStatus };

/** debug_instruction_stream 载荷(经冻结 Schema 校验后的形态)。 */
export type DebugChannelInstructionStreamPayload = Extract<
  DebugFrame,
  { type: "debug_instruction_stream" }
>["payload"];
/** debug_function_table 载荷(经冻结 Schema 校验后的形态)。 */
export type DebugChannelFunctionTablePayload = Extract<
  DebugFrame,
  { type: "debug_function_table" }
>["payload"];
/** 伪指令流单条展示条目(text 伪汇编 + 可选伪机器码 / 跳转目标)。 */
export type DebugFrameInstruction = DebugChannelInstructionStreamPayload["instructions"][number];
/** 函数表单条(label + 起始地址 + 字节长度)。 */
export type DebugFunctionEntry = DebugChannelFunctionTablePayload["functions"][number];
/** debug_window_data 载荷。 */
export type DebugWindowDataPayload = Extract<DebugFrame, { type: "debug_window_data" }>["payload"];
/** debug_paused 载荷。 */
export type DebugPausedPayload = Extract<DebugFrame, { type: "debug_paused" }>["payload"];
/** debug_search_results 载荷。 */
export type DebugSearchResultsPayload = Extract<
  DebugFrame,
  { type: "debug_search_results" }
>["payload"];
/** debug_attached 载荷。 */
export type DebugAttachedPayload = Extract<DebugFrame, { type: "debug_attached" }>["payload"];

/** 调试通道请求失败(错误帧 / 通道未连接 / dispose 兜底;code 自由承载)。 */
export class DebugChannelClientError extends Error {
  /** 客户端本地码(not_connected / disposed / send_failed 等)或服务端错误帧码。 */
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DebugChannelClientError";
    this.code = code;
  }
}

/** 在途请求条目(按 requestId 关联;断线 / dispose 即弃)。 */
interface PendingRequest {
  readonly resolve: (payload: unknown) => void;
  readonly reject: (error: DebugChannelClientError) => void;
}

/** 客户端可发送的请求帧类型(C→S 五值封闭;attach 由连接生命周期自动发送)。 */
export type DebugClientRequestType = Extract<
  DebugFrame["type"],
  "debug_window" | "debug_step" | "debug_run_to_breakpoint" | "debug_search"
>;

/** DebugChannelClient 装配依赖(全部可注入;缺省 = 浏览器原生面)。 */
export interface DebugChannelClientOptions {
  /** 会话 id(帧绑定会话;服务端与连接凭证比对,不一致拒绝)。 */
  readonly sessionId: string;
  /** attach 起点(revision 起点 / checkpoint 日志位置引用)。 */
  readonly origin: DebugAttachOrigin;
  /** 显式通道 URL(缺省按 baseUrl / 同源解析 `/sessions/debug-channel`)。 */
  readonly channelUrl?: string;
  /** 服务端 base URL(与 SessionClient 同语义;Node 集成必须提供)。 */
  readonly baseUrl?: string;
  /** WebSocket 工厂注入(缺省浏览器原生;测试注入假套接字)。 */
  readonly webSocketFactory?: WebSocketFactory;
  /** requestId 生成注入(缺省 crypto.randomUUID;测试注入确定性生成器)。 */
  readonly generateRequestId?: () => string;
}

/** 调试通道服务端路由(实现面登记,同 WP-41 端点;非冻结契约)。 */
export const DEBUG_CHANNEL_PATH = "/sessions/debug-channel";

// ── DebugChannelClient ─────────────────────────────────────────────────────

export class DebugChannelClient {
  readonly #sessionId: string;
  readonly #origin: DebugAttachOrigin;
  readonly #webSocketFactory: WebSocketFactory;
  readonly #generateRequestId: () => string;
  readonly #channelUrl: string | undefined;
  readonly #baseUrl: string | undefined;

  readonly #listeners = new Set<(event: DebugChannelEvent) => void>();
  readonly #pending = new Map<string, PendingRequest>();

  #socket: WsLikeSocket | null = null;
  #status: DebugChannelStatus = "disconnected";
  #seq = 0;
  #disposed = false;

  constructor(options: DebugChannelClientOptions) {
    this.#sessionId = options.sessionId;
    this.#origin = options.origin;
    this.#channelUrl = options.channelUrl;
    this.#baseUrl = options.baseUrl;
    this.#webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.#generateRequestId = options.generateRequestId ?? defaultRequestId;
  }

  /** 当前连接状态。 */
  get status(): DebugChannelStatus {
    return this.#status;
  }

  /** 帧绑定的会话 id(诊断面)。 */
  get sessionId(): string {
    return this.#sessionId;
  }

  /** 订阅调试通道事件;返回退订函数。 */
  onEvent(listener: (event: DebugChannelEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * 打开调试通道(幂等:已连接 / 连接中为 no-op)。连接打开即自动发送
   * `debug_attach`(origin 构造选项承载);attach 应答经 `attached` 事件
   * 与 attach requestId 的在途关联双通道分发。
   */
  connect(): void {
    this.#assertNotDisposed();
    if (this.#socket !== null) {
      return;
    }
    const url =
      this.#channelUrl ??
      resolveDebugChannelUrl(this.#baseUrl);
    const socket = this.#webSocketFactory(url);
    this.#socket = socket;
    this.#seq = 0;
    this.#setStatus("connecting");
    socket.onopen = () => {
      if (this.#socket !== socket || this.#disposed) {
        return;
      }
      this.#setStatus("connected");
      // attach 自动化:连接即请求重放对齐(§四;origin 判别联合互斥)。
      // attach 应答经事件面(attached / error)分发;不挂在途表。
      const requestId = this.#generateRequestId();
      this.#sendFrame("debug_attach", { origin: this.#origin }, requestId);
    };
    socket.onmessage = (event) => {
      if (this.#socket === socket && !this.#disposed) {
        this.#onFrameText(event.data);
      }
    };
    socket.onclose = () => {
      if (this.#socket !== socket || this.#disposed) {
        return;
      }
      this.#socket = null;
      this.#rejectAllPending("debug_channel_closed", "调试通道已关闭:在途请求作废(重新连接即重新 attach)");
      this.#setStatus("disconnected");
    };
    socket.onerror = () => {
      // 错误事件不携带语义;失败面统一由 close 事件收尾(与既有通道同纪律)。
    };
  }

  /** 主动断开(在途请求作废;状态收敛 disconnected)。 */
  disconnect(): void {
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      try {
        socket.close(1000, "client disconnect");
      } catch {
        // 关闭失败无进一步处置面(onclose 兜底状态收敛)。
      }
    }
    this.#rejectAllPending("debug_channel_closed", "调试通道已关闭:在途请求作废(重新连接即重新 attach)");
    if (this.#status !== "disconnected") {
      this.#setStatus("disconnected");
    }
  }

  /** 释放全部资源(测试收尾;之后一切请求抛错)。 */
  dispose(): void {
    this.#disposed = true;
    this.disconnect();
    this.#listeners.clear();
    this.#rejectAllPending("disposed", "DebugChannelClient 已 dispose");
  }

  // ── 请求面(C→S 四帧;attach 由 connect 自动发送)────────────────────────

  /** 任意地址窗口读取(1..4096 字节;回执合并进数据源缓存)。 */
  requestWindow(addressHex: string, byteLength: number): Promise<DebugWindowDataPayload> {
    return this.#request(
      "debug_window",
      { addressHex, byteLength },
      "请求窗口读取失败",
    ) as Promise<DebugWindowDataPayload>;
  }

  /** 全内存字节检索(回执 hits 按地址升序;truncated 为 presence-only)。 */
  requestSearch(patternHex: string, maxHits?: number): Promise<DebugSearchResultsPayload> {
    return this.#request(
      "debug_search",
      maxHits === undefined ? { patternHex } : { patternHex, maxHits },
      "全内存检索失败",
    ) as Promise<DebugSearchResultsPayload>;
  }

  /** 单步执行恰好一条指令(回执 = debug_paused,reason=step 或预算兜底)。 */
  step(): Promise<DebugPausedPayload> {
    return this.#request("debug_step", {}, "调试单步失败") as Promise<DebugPausedPayload>;
  }

  /** 运行到断点(至少 1 个地址;回执 = debug_paused)。 */
  runToBreakpoint(breakpoints: readonly string[]): Promise<DebugPausedPayload> {
    return this.#request(
      "debug_run_to_breakpoint",
      { breakpoints: [...breakpoints] },
      "运行到断点失败",
    ) as Promise<DebugPausedPayload>;
  }

  // ── 内部:帧装配与分发 ───────────────────────────────────────────────────

  #request(
    type: DebugClientRequestType,
    payload: unknown,
    failureLabel: string,
  ): Promise<unknown> {
    this.#assertNotDisposed();
    const socket = this.#socket;
    if (socket === null || this.#status !== "connected") {
      return Promise.reject(
        new DebugChannelClientError(
          "not_connected",
          `调试通道未连接:${failureLabel}被取消(等待重新连接后重试)`,
        ),
      );
    }
    const requestId = this.#generateRequestId();
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      try {
        this.#sendFrame(type, payload, requestId);
      } catch (error) {
        this.#pending.delete(requestId);
        reject(
          new DebugChannelClientError("send_failed", `${failureLabel}(帧发送失败)`, { cause: error }),
        );
      }
    });
  }

  #sendFrame(type: DebugFrame["type"], payload: unknown, requestId?: string): void {
    const socket = this.#socket;
    if (socket === null) {
      throw new DebugChannelClientError("not_connected", "调试通道未连接:无法发送帧");
    }
    const frame: Record<string, unknown> = {
      protocolVersion: DEBUG_CHANNEL_PROTOCOL_VERSION,
      type,
      sessionId: this.#sessionId,
      seq: this.#nextSeq(),
      ...(requestId === undefined ? {} : { requestId }),
      payload,
    };
    socket.send(JSON.stringify(frame));
  }

  #onFrameText(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      this.#emitDrift("调试通道帧 JSON 不可解析");
      return;
    }
    const result = DebugFrameSchema.safeParse(parsed);
    if (!result.success) {
      this.#emitDrift("调试通道帧契约形态漂移");
      return;
    }
    const frame = result.data;
    if (!(DEBUG_SERVER_TO_CLIENT_TYPES as readonly string[]).includes(frame.type)) {
      // 方向违规(客户端只发 C→S 五帧;收到 C→S 类型 = 契约漂移)。
      this.#emitDrift("调试通道帧方向违规");
      return;
    }
    if (frame.sessionId !== this.#sessionId) {
      this.#emitDrift("调试通道帧会话绑定不匹配");
      return;
    }
    // 方向检查通过:帧已收窄为 S→C 七值(类型系统不跨该运行时判别,单点断言)。
    this.#dispatch(frame as Extract<DebugFrame, { type: DebugServerToClientFrameType }>);
  }

  #dispatch(frame: Extract<DebugFrame, { type: DebugServerToClientFrameType }>): void {
    const requestId = frame.requestId;
    const pending =
      requestId === undefined ? undefined : this.#pending.get(requestId);
    switch (frame.type) {
      case "error":
        // 错误帧:带 requestId → 关联在途请求拒绝;不带 → 全部在途兜底拒绝
        // (通道级失败,§三.2)并照常分发事件。
        if (requestId !== undefined && pending !== undefined) {
          this.#pending.delete(requestId);
          pending.reject(new DebugChannelClientError(frame.payload.code, frame.payload.message));
        } else {
          this.#rejectAllPending(frame.payload.code, frame.payload.message);
        }
        this.#emit({ kind: "error", error: frame.payload });
        return;
      case "debug_attached":
        if (requestId !== undefined && pending !== undefined) {
          this.#pending.delete(requestId);
          pending.resolve(frame.payload);
        }
        this.#emit({ kind: "attached", payload: frame.payload });
        return;
      case "debug_paused":
        if (requestId !== undefined && pending !== undefined) {
          this.#pending.delete(requestId);
          pending.resolve(frame.payload);
        }
        this.#emit({ kind: "paused", payload: frame.payload });
        return;
      case "debug_window_data":
        if (requestId !== undefined && pending !== undefined) {
          this.#pending.delete(requestId);
          pending.resolve(frame.payload);
        }
        this.#emit({ kind: "window-data", payload: frame.payload });
        return;
      case "debug_search_results":
        if (requestId !== undefined && pending !== undefined) {
          this.#pending.delete(requestId);
          pending.resolve(frame.payload);
        }
        this.#emit({ kind: "search-results", payload: frame.payload });
        return;
      case "debug_instruction_stream":
        // 推送帧不带 requestId(§九);只分发事件(数据源并入缓存)。
        this.#emit({ kind: "instruction-stream", payload: frame.payload });
        return;
      case "debug_function_table":
        // attach 应答族伴生上下文(可能回显 attach requestId)或纯推送。
        if (requestId !== undefined && pending !== undefined) {
          this.#pending.delete(requestId);
          pending.resolve(frame.payload);
        }
        this.#emit({ kind: "function-table", payload: frame.payload });
        return;
    }
  }

  #rejectAllPending(code: string, message: string): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) {
      entry.reject(new DebugChannelClientError(code, message));
    }
  }

  #emit(event: DebugChannelEvent): void {
    for (const listener of [...this.#listeners]) {
      listener(event);
    }
  }

  #emitDrift(reason: string): void {
    // 客户端侧畸形帧兜底:零服务端细节透出,复用冻结 internal_error 形态。
    this.#emit({
      kind: "error",
      error: { code: "internal_error", message: reason },
    });
  }

  #setStatus(status: DebugChannelStatus): void {
    this.#status = status;
    this.#emit({ kind: "status", status });
  }

  #nextSeq(): number {
    this.#seq += 1;
    return this.#seq;
  }

  #assertNotDisposed(): void {
    if (this.#disposed) {
      throw new DebugChannelClientError("disposed", "DebugChannelClient 已 dispose");
    }
  }
}

/** S→C 七值类型(方向检查用;C→S 帧到达即契约漂移)。 */
type DebugServerToClientFrameType = Extract<
  DebugFrame["type"],
  | "debug_attached"
  | "debug_window_data"
  | "debug_paused"
  | "debug_search_results"
  | "debug_instruction_stream"
  | "debug_function_table"
  | "error"
>;

/** 缺省 requestId:crypto.randomUUID(UUID v4 天然满足 OpaqueId 字符集)。 */
function defaultRequestId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (crypto?.randomUUID === undefined) {
    throw new DebugChannelClientError(
      "contract_drift",
      "当前环境无 crypto.randomUUID:请注入 generateRequestId",
    );
  }
  return crypto.randomUUID();
}

/**
 * 解析调试通道 URL:`GET /sessions/debug-channel` 的 WebSocket 升级地址
 * (有 baseUrl → ws(s) 同 host 拼接;无 → 浏览器同源;两者皆无抛错)。
 */
export function resolveDebugChannelUrl(baseUrl: string | undefined): string {
  let url: URL;
  if (baseUrl !== undefined && baseUrl !== "") {
    url = new URL(DEBUG_CHANNEL_PATH, baseUrl);
  } else {
    const location = (globalThis as { location?: { href: string } }).location;
    if (location === undefined) {
      throw new DebugChannelClientError(
        "invalid_url",
        "未提供 baseUrl 且当前环境无 location:无法解析调试通道地址(Node 集成须显式注入 baseUrl)",
      );
    }
    url = new URL(DEBUG_CHANNEL_PATH, location.href);
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

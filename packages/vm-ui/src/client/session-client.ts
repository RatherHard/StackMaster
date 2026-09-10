/**
 * SessionClient —— 浏览器 ↔ 编排器的会话客户端(WP-F2)。
 *
 * 职责与契约形态(与 protocol 冻结面一字不差):
 *  - **REST 5 命令**(D-API-1 路由表;12 动作不设 REST 镜像,WSS-only):
 *      POST /sessions                  create_session(201 + Set-Cookie)
 *      POST /sessions/projection-sync  sync_projection(断线重连对齐 / truncated 重对齐)
 *      POST /sessions/checkpoints      list_checkpoints
 *      POST /sessions/submissions      submit(响应只含 {submissionId, revision})
 *      POST /sessions/close            close_session
 *    请求体 = 冻结 SessionCommandRequest 信封;`credentials: "include"`
 *    (会话凭证 Cookie 交付,D-API-12;响应体零凭证字段)。
 *  - **认证 WSS**:GET /sessions/channel 升级即 Cookie 认证;客户端→服务端
 *    仅 `action` 帧;每帧携带 protocolVersion(连接级版本锚定 = 首帧即锚,
 *    服务端拒绝漂移,D-API-2);心跳 / 空闲(30s/60s)由服务端负责,客户端
 *    不实现(浏览器 WebSocket 自动回应 pong)。
 *  - **动作提交**:ActionRequest{protocolVersion, sessionId, clientSeq(自 1
 *    严格递增,会话级,不随重连重置), baseRevision(= 最近已知投影 revision),
 *    idempotencyKey(每动作唯一,内存账本保证不复用), action};响应按传输层
 *    requestId 关联。`rejected` 耦合:projectionDelta 必为 null、
 *    userVisibleError 必在(经 Schema 机检)→ 错误事件分发,revision 不前进。
 *  - **断线重连**:断线保留最近一次公开投影(只展示,零本地 VM 降级);
 *    自动重连(指数退避,delay = min(initial·2^n, max))→ 成功后立即 REST
 *    projection-sync 重新对齐 → 以新 revision 继续。dirtyRange 带 `truncated`
 *    标记的动作响应同样触发 sync-projection(9.1 sanctioned 路径)。
 *  - **rAF 合帧**(第十章):投影增量先入队,requestAnimationFrame 回调里
 *    批量应用到 store 并合帧通知视图(每帧至多一次);无 rAF 环境(Node/SSR)
 *    降级为微任务批处理。
 *  - **连接状态机**:connecting | connected | reconnecting | disconnected;
 *    服务端踢旧连接(错误帧 "connection replaced" + close 1008)处理为单
 *    连接策略(不再自动重连,避免两客户端互踢循环);close 1000(服务端语义
 *    = 空闲超时)/ 1001(停机)/ 1009(帧超限)/ 1013(背压)语义化并自动重连。
 *
 * 传输层可注入(fetch / WebSocket 工厂 / rAF / 定时器 / 时钟 / 幂等键生成),
 * Node 集成冒烟可注入 undici + `ws`(README 登记接入方式);本 WP 不强制跑
 * compose E2E(留给 WP-F7 Playwright 最小集)。
 */
import {
  PublicErrorSchema,
  SESSION_ACTION_PROTOCOL_VERSION,
  SessionCommandResponseSchema,
  WssFrameSchema,
  type ActionObject,
  type ActionRequest,
  type ActionResponse,
  type PublicError,
  type PublicStateProjection,
  type SessionCommandRequest,
  type SessionCommandResponse,
  type WssFrame,
} from "@stackmaster/protocol";

import { ProjectionStore } from "./projection-store.js";
import {
  defaultFrameCanceler,
  defaultFrameScheduler,
  defaultTimerCanceler,
  defaultTimerScheduler,
  defaultWebSocketFactory,
  resolveWebSocketUrl,
  type FrameCanceler,
  type FrameScheduler,
  type TimerCanceler,
  type TimerHandle,
  type TimerScheduler,
  type WebSocketFactory,
  type WsLikeSocket,
} from "./transport.js";
import { SessionClientError, SessionCommandError } from "./session-errors.js";

// ── 公开类型 ───────────────────────────────────────────────────────────────

/** create_session 载荷(题目上下文三方比对输入 + embed token;身份零承载)。 */
export type CreateSessionInput = Extract<SessionCommandRequest, { command: "create_session" }>["payload"];

/** REST 5 命令的响应类型(冻结 SessionCommandResponse 判别分支)。 */
export type CreateSessionResponse = Extract<SessionCommandResponse, { command: "create_session" }>;
export type SyncProjectionResponse = Extract<SessionCommandResponse, { command: "sync_projection" }>;
export type ListCheckpointsResponse = Extract<SessionCommandResponse, { command: "list_checkpoints" }>;
export type SubmitResponse = Extract<SessionCommandResponse, { command: "submit" }>;
export type CloseSessionResponse = Extract<SessionCommandResponse, { command: "close_session" }>;

/** 连接状态机四态。 */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

/** 断线原因(close code 的语义化映射;服务端登记见 D-API-48)。 */
export type DisconnectReason =
  /** close 1000:服务端语义 = 空闲超时(pong / 入站静默超限;可重连)。 */
  | "idle-timeout"
  /** close 1001:服务端优雅停机(可重连)。 */
  | "server-shutdown"
  /** close 1008 + "connection replaced" 错误帧:同会话新连接踢旧(不重连)。 */
  | "connection-replaced"
  /** close 1008(无 replaced 错误帧):升级后未认证等策略关闭(不重连)。 */
  | "unauthenticated"
  /** close 1013:发送缓冲超限背压断开(可重连)。 */
  | "backpressure"
  /** close 1009:帧超过 MAX_WSS_FRAME_BYTES(可重连)。 */
  | "frame-too-large"
  /** 客户端主动 disconnect(不重连)。 */
  | "client-closed"
  /** 其余关闭码 / 异常断开(可重连)。 */
  | "abnormal";

/** 连接状态事件。 */
export interface ConnectionStatusEvent {
  /** 事件发生时刻(注入时钟;视图诊断用)。 */
  readonly at: number;
  readonly status: ConnectionStatus;
  /** 关闭码(非关闭路径为 null)。 */
  readonly closeCode: number | null;
  /** 语义化断线原因(非关闭路径为 null)。 */
  readonly reason: DisconnectReason | null;
  /** 当前重连尝试序(0 = 首连 / 非重连路径)。 */
  readonly attempt: number;
  /** 下一次重连退避延迟(reconnecting 时携带;其余 null)。 */
  readonly retryDelayMs: number | null;
}

/** 通道级错误事件来源(PublicError 形态;服务端错误帧与客户端侧畸形帧兜底)。 */
export type ChannelErrorSource = "server-frame" | "client-frame";

/** SessionClient 装配依赖(全部可注入;缺省 = 浏览器原生面)。 */
export interface SessionClientOptions {
  /** fetch 注入(缺省 globalThis.fetch;Node 集成可传 undici.fetch)。 */
  readonly fetch?: typeof fetch;
  /** WebSocket 工厂注入(缺省浏览器原生 WebSocket 适配)。 */
  readonly webSocketFactory?: WebSocketFactory;
  /** rAF 调度注入(缺省 requestAnimationFrame;无 rAF 环境降级微任务)。 */
  readonly raf?: FrameScheduler;
  readonly cancelRaf?: FrameCanceler;
  /** 重连退避定时器注入(缺省 setTimeout / clearTimeout)。 */
  readonly scheduleTimer?: TimerScheduler;
  readonly cancelTimer?: TimerCanceler;
  /** 时钟注入(退避计算的测试锚点)。 */
  readonly now?: () => number;
  /** 幂等键生成注入(缺省 crypto.randomUUID;字符集 [A-Za-z0-9_-])。 */
  readonly generateIdempotencyKey?: () => string;
  /** 服务端 base URL(缺省浏览器同源;Node 集成必须提供)。 */
  readonly baseUrl?: string;
  /** 重连退避参数(指数:delay = min(initial·2^n, maxDelay);无抖动保测试确定性)。 */
  readonly reconnect?: {
    readonly initialDelayMs?: number;
    readonly maxDelayMs?: number;
  };
}

/** 在途动作账本条目(按传输层 requestId 关联;断线即弃——对齐走 sync)。 */
interface PendingAction {
  readonly idempotencyKey: string;
}

/** 服务端踢旧连接的错误帧文案(session-api WSS_CONNECTION_REPLACED_ERROR)。 */
const CONNECTION_REPLACED_MESSAGE = "connection replaced";

/** 默认重连退避(指数;上限可配)。 */
const RECONNECT_INITIAL_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 8000;

// ── SessionClient ──────────────────────────────────────────────────────────

export class SessionClient {
  readonly #store = new ProjectionStore();
  readonly #fetch: typeof fetch;
  readonly #webSocketFactory: WebSocketFactory;
  readonly #raf: FrameScheduler;
  readonly #cancelRaf: FrameCanceler;
  readonly #scheduleTimer: TimerScheduler;
  readonly #cancelTimer: TimerCanceler;
  readonly #now: () => number;
  readonly #generateIdempotencyKey: () => string;
  readonly #baseUrl: string | undefined;
  readonly #reconnectInitialDelayMs: number;
  readonly #reconnectMaxDelayMs: number;

  // ── 事件面 ──
  readonly #statusListeners = new Set<(event: ConnectionStatusEvent) => void>();
  readonly #projectionListeners = new Set<() => void>();
  readonly #actionResponseListeners = new Set<(response: ActionResponse) => void>();
  readonly #actionRejectedListeners = new Set<
    (error: PublicError, response: ActionResponse) => void
  >();
  readonly #channelErrorListeners = new Set<
    (error: PublicError, source: ChannelErrorSource) => void
  >();
  readonly #commandErrorListeners = new Set<(error: SessionCommandError) => void>();

  // ── 会话账本(客户端内存;只存公开投影与序号/键账本,零凭证材料)──
  #sessionId: string | null = null;
  #clientSeq = 0;
  readonly #issuedIdempotencyKeys = new Set<string>();

  // ── 通道状态 ──
  #socket: WsLikeSocket | null = null;
  #status: ConnectionStatus = "disconnected";
  #transportSeq = 0;
  #reconnectAttempt = 0;
  #reconnectTimer: TimerHandle | null = null;
  #pendingByRequestId = new Map<string, PendingAction>();
  #replacedByNewConnection = false;
  #needsSyncOnConnect = false;
  #intentionalClose = false;
  #disposed = false;

  // ── rAF 合帧 ──
  #frameScheduled = false;
  #frameHandle: number | null = null;
  #pendingOps: ActionResponse[] = [];
  #projectionDirty = false;
  #syncRequested = false;
  readonly #storeUnsubscribe: () => void;

  constructor(options: SessionClientOptions = {}) {
    this.#fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.#webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.#raf = options.raf ?? defaultFrameScheduler;
    this.#cancelRaf = options.cancelRaf ?? defaultFrameCanceler;
    this.#scheduleTimer = options.scheduleTimer ?? defaultTimerScheduler;
    this.#cancelTimer = options.cancelTimer ?? defaultTimerCanceler;
    this.#now = options.now ?? Date.now;
    this.#generateIdempotencyKey = options.generateIdempotencyKey ?? defaultIdempotencyKey;
    this.#baseUrl = options.baseUrl;
    this.#reconnectInitialDelayMs = options.reconnect?.initialDelayMs ?? RECONNECT_INITIAL_DELAY_MS;
    this.#reconnectMaxDelayMs = options.reconnect?.maxDelayMs ?? RECONNECT_MAX_DELAY_MS;
    // store 变更 → 标脏并入帧(合帧通知视图的唯一入口)。
    this.#storeUnsubscribe = this.#store.subscribe(() => {
      this.#projectionDirty = true;
      this.#scheduleFrame();
    });
  }

  /** 公开投影存储(数据源层消费;视图禁止直读——纪律见 README)。 */
  get store(): ProjectionStore {
    return this.#store;
  }

  /** 最近一次公开投影快照(断线保留;无会话为 null)。 */
  get projection(): PublicStateProjection | null {
    return this.#store.snapshot;
  }

  /** 当前会话(create_session 签发;未建会话为 null)。 */
  get sessionId(): string | null {
    return this.#sessionId;
  }

  /** 当前连接状态。 */
  get status(): ConnectionStatus {
    return this.#status;
  }

  /** 已签发的动作序(会话级严格递增,自 1;诊断面)。 */
  get lastClientSeq(): number {
    return this.#clientSeq;
  }

  // ── 订阅(返回退订函数)─────────────────────────────────────────────────

  /** 连接状态机事件(立即分发,不合帧)。 */
  onConnectionStatus(listener: (event: ConnectionStatusEvent) => void): () => void {
    return addListener(this.#statusListeners, listener);
  }

  /** 投影变更通知(每帧至多一次;视图据此重读数据源)。 */
  onProjectionChanged(listener: () => void): () => void {
    return addListener(this.#projectionListeners, listener);
  }

  /** 动作响应(含 rejected;离散事件,立即分发——时间线 / 诊断消费)。 */
  onActionResponse(listener: (response: ActionResponse) => void): () => void {
    return addListener(this.#actionResponseListeners, listener);
  }

  /** 拒绝动作的用户可见错误(rejected 耦合:userVisibleError 必在)。 */
  onActionRejected(listener: (error: PublicError, response: ActionResponse) => void): () => void {
    return addListener(this.#actionRejectedListeners, listener);
  }

  /** 通道级错误帧(畸形 / 版本 / 绑定 / 429 限流 budget_exhausted / 踢旧)。 */
  onChannelError(listener: (error: PublicError, source: ChannelErrorSource) => void): () => void {
    return addListener(this.#channelErrorListeners, listener);
  }

  /** REST 命令失败(非 2xx 的冻结 PublicError;内部自动 sync 失败也经此分发)。 */
  onCommandError(listener: (error: SessionCommandError) => void): () => void {
    return addListener(this.#commandErrorListeners, listener);
  }

  // ── REST 5 命令(D-API-1 冻结路由表;凭证 Cookie,响应体零凭证字段)────

  /** POST /sessions — create_session(201 + Set-Cookie;新会话重置客户端账本)。 */
  async createSession(input: CreateSessionInput): Promise<CreateSessionResponse> {
    // 新会话 = 账本重置:旧通道按客户端主动关闭收尾(单连接策略),幂等键
    // 与 clientSeq 随新会话作废(协议账本以会话为界)。
    this.#intentionalClose = true;
    this.#closeSocketQuietly();
    this.#sessionId = null;
    this.#clientSeq = 0;
    this.#issuedIdempotencyKeys.clear();
    this.#pendingByRequestId.clear();

    const response = await this.#postCommand({
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
      command: "create_session",
      payload: input,
    }, REST_PATHS.create);
    if (response.command !== "create_session") {
      throw contractDrift(`create_session 响应命令漂移:${String(response.command)}`);
    }
    this.#sessionId = response.payload.sessionId;
    this.#store.replaceProjection(response.payload.projection);
    return response;
  }

  /** POST /sessions/projection-sync — sync_projection(只重发、不重询)。 */
  async syncProjection(): Promise<SyncProjectionResponse> {
    const response = await this.#postCommand({
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
      command: "sync_projection",
      payload: { sessionId: this.#requireSessionId() },
    }, REST_PATHS.projectionSync);
    if (response.command !== "sync_projection") {
      throw contractDrift(`sync_projection 响应命令漂移:${String(response.command)}`);
    }
    this.#store.replaceProjection(response.payload.projection);
    return response;
  }

  /** POST /sessions/checkpoints — list_checkpoints(按创建顺序排列)。 */
  async listCheckpoints(): Promise<ListCheckpointsResponse> {
    const response = await this.#postCommand({
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
      command: "list_checkpoints",
      payload: { sessionId: this.#requireSessionId() },
    }, REST_PATHS.checkpoints);
    if (response.command !== "list_checkpoints") {
      throw contractDrift(`list_checkpoints 响应命令漂移:${String(response.command)}`);
    }
    return response;
  }

  /** POST /sessions/submissions — submit(裁决引用 SERVER_ONLY,不下发)。 */
  async submit(): Promise<SubmitResponse> {
    const response = await this.#postCommand({
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
      command: "submit",
      payload: { sessionId: this.#requireSessionId() },
    }, REST_PATHS.submissions);
    if (response.command !== "submit") {
      throw contractDrift(`submit 响应命令漂移:${String(response.command)}`);
    }
    return response;
  }

  /** POST /sessions/close — close_session(终态;成功后主动断开动作通道)。 */
  async closeSession(): Promise<CloseSessionResponse> {
    const response = await this.#postCommand({
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
      command: "close_session",
      payload: { sessionId: this.#requireSessionId() },
    }, REST_PATHS.close);
    if (response.command !== "close_session") {
      throw contractDrift(`close_session 响应命令漂移:${String(response.command)}`);
    }
    // 会话已终态:主动断开通道(重连只会得到 session_terminal 拒绝)。
    this.disconnect();
    return response;
  }

  // ── 认证 WSS 通道 ────────────────────────────────────────────────────────

  /** 打开动作通道(幂等:已连接 / 连接中 / 重连中为 no-op)。 */
  connect(): void {
    this.#assertNotDisposed();
    if (this.#socket !== null || this.#reconnectTimer !== null) {
      return;
    }
    this.#intentionalClose = false;
    this.#replacedByNewConnection = false;
    this.#setStatus({
      at: this.#now(),
      status: "connecting",
      closeCode: null,
      reason: null,
      attempt: 0,
      retryDelayMs: null,
    });
    this.#openSocket();
  }

  /**
   * 提交动作(仅 WSS;REST 无镜像)。信封与账本由客户端装配:
   * clientSeq 自 1 严格递增(会话级)、baseRevision = 最近已知投影 revision、
   * idempotencyKey 每动作唯一。断线 / 未建会话抛 SessionClientError——
   * 断线期不排队投递(对齐语义归 sync-projection,调用方可在重连后重试)。
   */
  sendAction(action: ActionObject): void {
    const socket = this.#socket;
    if (socket === null || this.#status !== "connected") {
      throw new SessionClientError(
        "not_connected",
        "动作通道未连接:断线期间不投递动作(等待重连对齐后重试)",
      );
    }
    const sessionId = this.#requireSessionId();
    const idempotencyKey = this.#newIdempotencyKey();
    this.#clientSeq += 1;
    const request: ActionRequest = {
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
      sessionId,
      clientSeq: this.#clientSeq,
      baseRevision: this.#store.revision ?? 0,
      idempotencyKey,
      action,
    };
    // 传输帧信封(8.2 基线):seq 为连接内严格递增(重连后归零重来),
    // requestId 以幂等键承载(响应帧回显,传输层关联与载荷账本同键)。
    const frame: WssFrame = {
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
      type: "action",
      sessionId,
      seq: this.#nextTransportSeq(),
      requestId: idempotencyKey,
      payload: request,
    };
    this.#pendingByRequestId.set(idempotencyKey, { idempotencyKey });
    socket.send(JSON.stringify(frame));
  }

  /** 主动断开(不重连;保留最近公开投影)。 */
  disconnect(): void {
    this.#intentionalClose = true;
    this.#cancelReconnectTimer();
    this.#closeSocketQuietly();
    if (this.#status !== "disconnected") {
      this.#setStatus({
        at: this.#now(),
        status: "disconnected",
        closeCode: null,
        reason: "client-closed",
        attempt: 0,
        retryDelayMs: null,
      });
    }
  }

  /** 释放全部资源(测试收尾;之后一切调用抛错或为 no-op)。 */
  dispose(): void {
    this.#disposed = true;
    this.#intentionalClose = true;
    this.#cancelReconnectTimer();
    this.#closeSocketQuietly();
    if (this.#frameHandle !== null) {
      this.#cancelRaf(this.#frameHandle);
      this.#frameHandle = null;
      this.#frameScheduled = false;
    }
    this.#pendingOps = [];
    this.#storeUnsubscribe();
    this.#statusListeners.clear();
    this.#projectionListeners.clear();
    this.#actionResponseListeners.clear();
    this.#actionRejectedListeners.clear();
    this.#channelErrorListeners.clear();
    this.#commandErrorListeners.clear();
  }

  // ── 通道内部状态机 ───────────────────────────────────────────────────────

  #openSocket(): void {
    const url = resolveWebSocketUrl(this.#baseUrl);
    const socket = this.#webSocketFactory(url);
    this.#socket = socket;
    this.#transportSeq = 0;
    socket.onopen = () => {
      if (this.#socket !== socket || this.#disposed) {
        return;
      }
      this.#reconnectAttempt = 0;
      this.#setStatus({
        at: this.#now(),
        status: "connected",
        closeCode: null,
        reason: null,
        attempt: 0,
        retryDelayMs: null,
      });
      // 重连成功:立即 REST projection-sync 重新对齐(9.1 sanctioned 路径),
      // 之后以新 revision 继续 sendAction。首连不 sync(初始投影随 create_session)。
      if (this.#needsSyncOnConnect) {
        this.#needsSyncOnConnect = false;
        void this.syncProjection().catch((error: unknown) => {
          this.#emitCommandError(error);
        });
      }
    };
    socket.onmessage = (event) => {
      if (this.#socket === socket && !this.#disposed) {
        this.#onFrameText(event.data);
      }
    };
    socket.onclose = (event) => {
      if (this.#socket !== socket || this.#disposed) {
        return;
      }
      this.#socket = null;
      this.#onSocketClosed(event.code);
    };
    socket.onerror = () => {
      // 错误事件不携带语义;失败面统一由 close 事件收尾(浏览器同款纪律)。
    };
  }

  #onSocketClosed(closeCode: number): void {
    if (this.#disposed) {
      return;
    }
    // 在途响应弃单:断线窗口内响应不可达,对齐语义归重连后的 sync-projection。
    this.#pendingByRequestId.clear();
    if (this.#intentionalClose) {
      this.#setStatus({
        at: this.#now(),
        status: "disconnected",
        closeCode,
        reason: "client-closed",
        attempt: 0,
        retryDelayMs: null,
      });
      return;
    }
    const classification = classifyCloseCode(closeCode, this.#replacedByNewConnection);
    if (!classification.reconnectable) {
      this.#setStatus({
        at: this.#now(),
        status: "disconnected",
        closeCode,
        reason: classification.reason,
        attempt: 0,
        retryDelayMs: null,
      });
      return;
    }
    // 指数退避自动重连(delay = min(initial·2^n, max);保留最近投影只展示)。
    const attempt = this.#reconnectAttempt + 1;
    this.#reconnectAttempt = attempt;
    this.#needsSyncOnConnect = true;
    const delayMs = Math.min(
      this.#reconnectInitialDelayMs * 2 ** (attempt - 1),
      this.#reconnectMaxDelayMs,
    );
    this.#setStatus({
      at: this.#now(),
      status: "reconnecting",
      closeCode,
      reason: classification.reason,
      attempt,
      retryDelayMs: delayMs,
    });
    this.#reconnectTimer = this.#scheduleTimer(() => {
      this.#reconnectTimer = null;
      if (!this.#disposed && this.#socket === null && !this.#intentionalClose) {
        this.#openSocket();
      }
    }, delayMs);
  }

  #onFrameText(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      this.#emitChannelDrift("通道帧 JSON 不可解析");
      return;
    }
    const result = WssFrameSchema.safeParse(parsed);
    if (!result.success) {
      this.#emitChannelDrift("通道帧契约形态漂移");
      return;
    }
    const frame = result.data;
    if (frame.type === "error") {
      if (frame.payload.message === CONNECTION_REPLACED_MESSAGE) {
        // 单连接策略:本连接已被同会话新连接取代(close 1008 将随后到达)。
        this.#replacedByNewConnection = true;
      }
      for (const listener of [...this.#channelErrorListeners]) {
        listener(frame.payload, "server-frame");
      }
      return;
    }
    if (frame.type !== "action_response") {
      // 方向违规(客户端→服务端仅 action;服务端→客户端仅 action_response/error)。
      this.#emitChannelDrift("通道帧方向违规");
      return;
    }
    const response = frame.payload;
    if (frame.requestId !== undefined) {
      this.#pendingByRequestId.delete(frame.requestId);
    }
    for (const listener of [...this.#actionResponseListeners]) {
      listener(response);
    }
    if (response.status === "rejected") {
      // rejected 耦合(Schema 机检):delta 必为 null、userVisibleError 必在;
      // revision 不前进,投影不动。
      if (response.userVisibleError !== undefined) {
        for (const listener of [...this.#actionRejectedListeners]) {
          listener(response.userVisibleError, response);
        }
      }
      return;
    }
    // 已执行动作:响应入队(rAF 帧内批量应用);dirtyRange 带 truncated 标记
    // ⇒ 触发 sync-projection 重新对齐(DirtyRange 截断语义)。
    this.#pendingOps.push(response);
    if (response.projectionDelta?.dirtyRanges.some((range) => range.truncated === true)) {
      this.#syncRequested = true;
    }
    this.#scheduleFrame();
  }

  // ── rAF 合帧:增量先入队,帧回调里批量应用 + 合帧通知 ────────────────────

  #scheduleFrame(): void {
    if (this.#frameScheduled || this.#disposed) {
      return;
    }
    this.#frameScheduled = true;
    this.#frameHandle = this.#raf(() => {
      // 帧回调期间保持 frameScheduled:true——应用过程触发的 store 变更只标脏,
      // 合并进本帧的末尾通知(每帧至多一次),不产生残余帧。
      try {
        this.#runFrame();
      } finally {
        this.#frameScheduled = false;
        this.#frameHandle = null;
      }
    });
  }

  #runFrame(): void {
    if (this.#disposed) {
      return;
    }
    const responses = this.#pendingOps;
    this.#pendingOps = [];
    for (const response of responses) {
      if (response.projectionDelta !== null) {
        // revision 错位(理论不可达:响应按执行序到达)时应用失败 ⇒ 触发
        // sync-projection 兜底重对齐,禁止本地推导补齐。
        if (!this.#store.applyDelta(response.projectionDelta)) {
          this.#syncRequested = true;
        }
      } else {
        this.#store.advanceRevision(response.revision);
      }
    }
    if (this.#projectionDirty) {
      this.#projectionDirty = false;
      for (const listener of [...this.#projectionListeners]) {
        listener();
      }
    }
    if (this.#syncRequested) {
      this.#syncRequested = false;
      void this.syncProjection().catch((error: unknown) => {
        this.#emitCommandError(error);
      });
    }
  }

  // ── REST 与账本内部件 ────────────────────────────────────────────────────

  async #postCommand(
    request: SessionCommandRequest,
    path: string,
  ): Promise<SessionCommandResponse> {
    let httpResponse: Awaited<ReturnType<typeof fetch>>;
    try {
      httpResponse = await this.#fetch(this.#restUrl(path), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch (error) {
      throw new SessionClientError("rest_failed", `会话命令网络失败:${path}`, { cause: error });
    }
    if (!httpResponse.ok) {
      const publicError = await parsePublicErrorBody(httpResponse);
      const commandError = new SessionCommandError(httpResponse.status, publicError);
      for (const listener of [...this.#commandErrorListeners]) {
        listener(commandError);
      }
      throw commandError;
    }
    let body: unknown;
    try {
      body = await httpResponse.json();
    } catch (error) {
      throw contractDrift(`会话命令响应非 JSON:${path}`, error);
    }
    const parsed = SessionCommandResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw contractDrift(`会话命令响应契约漂移:${path}`);
    }
    return parsed.data;
  }

  #restUrl(path: string): string {
    return this.#baseUrl === undefined || this.#baseUrl === ""
      ? path
      : new URL(path, this.#baseUrl).toString();
  }

  #requireSessionId(): string {
    if (this.#sessionId === null) {
      throw new SessionClientError("no_session", "尚未 createSession:命令需要服务端签发的会话上下文");
    }
    return this.#sessionId;
  }

  #newIdempotencyKey(): string {
    let key = this.#generateIdempotencyKey();
    // 内存账本兜底防撞(生成器冲突即重生成;正常 UUID 路径零循环)。
    while (this.#issuedIdempotencyKeys.has(key)) {
      key = this.#generateIdempotencyKey();
    }
    this.#issuedIdempotencyKeys.add(key);
    return key;
  }

  #nextTransportSeq(): number {
    this.#transportSeq += 1;
    return this.#transportSeq;
  }

  #closeSocketQuietly(): void {
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      try {
        socket.close(1000, "client disconnect");
      } catch {
        // 关闭失败无进一步处置面(onclose 兜底状态收敛)。
      }
    }
  }

  #cancelReconnectTimer(): void {
    if (this.#reconnectTimer !== null) {
      this.#cancelTimer(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  #setStatus(event: ConnectionStatusEvent): void {
    this.#status = event.status;
    for (const listener of [...this.#statusListeners]) {
      listener(event);
    }
  }

  #emitChannelDrift(reason: string): void {
    // 客户端侧畸形帧兜底:零服务端细节透出,复用冻结 internal_error 形态。
    const error = PublicErrorSchema.parse({ code: "internal_error", message: reason });
    for (const listener of [...this.#channelErrorListeners]) {
      listener(error, "client-frame");
    }
  }

  #emitCommandError(error: unknown): void {
    // 内部自动命令(重连后 sync / truncated 后 sync)的失败没有同步抛出点:
    // SessionCommandError 原样分发,其余(本地拒绝 / 契约漂移)合成为
    // internal_error 兜底形态分发,零服务端细节透出。
    const commandError =
      error instanceof SessionCommandError
        ? error
        : new SessionCommandError(
            0,
            PublicErrorSchema.parse({ code: "internal_error", message: "sync-projection failed" }),
          );
    for (const listener of [...this.#commandErrorListeners]) {
      listener(commandError);
    }
  }

  #assertNotDisposed(): void {
    if (this.#disposed) {
      throw new SessionClientError("not_connected", "SessionClient 已 dispose");
    }
  }
}

/** REST 冻结路由表(D-API-1;路径归 session-api 实现面登记)。 */
const REST_PATHS = {
  create: "/sessions",
  projectionSync: "/sessions/projection-sync",
  checkpoints: "/sessions/checkpoints",
  submissions: "/sessions/submissions",
  close: "/sessions/close",
} as const;

// ── 帮助函数 ────────────────────────────────────────────────────────────────

function addListener<T>(listeners: Set<T>, listener: T): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * close code → 语义化断线原因(服务端登记:D-API-48)。注意 close 1000 在
 * 本通道被服务端用作空闲超时(非 RFC "正常关闭"),可重连;1008 = 踢旧 /
 * 未认证策略关闭,不自动重连(避免互踢循环)。
 */
function classifyCloseCode(
  code: number,
  replaced: boolean,
): { readonly reason: DisconnectReason; readonly reconnectable: boolean } {
  switch (code) {
    case 1000:
      return { reason: "idle-timeout", reconnectable: true };
    case 1001:
      return { reason: "server-shutdown", reconnectable: true };
    case 1008:
      return replaced
        ? { reason: "connection-replaced", reconnectable: false }
        : { reason: "unauthenticated", reconnectable: false };
    case 1009:
      return { reason: "frame-too-large", reconnectable: true };
    case 1013:
      return { reason: "backpressure", reconnectable: true };
    default:
      return { reason: "abnormal", reconnectable: true };
  }
}

/** 非 2xx 响应体 → 冻结 PublicError(不可解析时 internal_error 兜底)。 */
async function parsePublicErrorBody(response: Awaited<ReturnType<typeof fetch>>): Promise<PublicError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const parsed = PublicErrorSchema.safeParse(body);
  return parsed.success
    ? parsed.data
    : PublicErrorSchema.parse({
        code: "internal_error",
        message: `会话命令失败(HTTP ${response.status})`,
      });
}

function contractDrift(message: string, cause?: unknown): SessionClientError {
  return new SessionClientError("contract_drift", message, { cause });
}

/** 缺省幂等键:crypto.randomUUID(UUID v4 天然满足字符集约束)。 */
function defaultIdempotencyKey(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (crypto?.randomUUID === undefined) {
    throw new SessionClientError(
      "contract_drift",
      "当前环境无 crypto.randomUUID:请注入 generateIdempotencyKey",
    );
  }
  return crypto.randomUUID();
}

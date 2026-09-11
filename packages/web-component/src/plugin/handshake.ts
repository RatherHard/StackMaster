/**
 * 插件侧嵌入握手状态机(WP-52;嵌入协议 §4.1 插件侧行为要点 / §4.3 / §4.4 /
 * §4.5 / §五 V-1' V-5 V-7 V-8 V-10 V-11 V-12 的插件角色编排)。
 *
 * 角色与 WP-51 embed-runtime(宿主侧)非对称(Q4 定案「分层同源」):协议
 * 解析器同源(protocol 包),无状态构件复用 embed-runtime 导出面(esid 校验、
 * TypeRateLimiter、违规计数键词汇),角色编排(发起方 / 被授予方)在本类自实现:
 *
 *  - **hello 发起**:esid 自 fragment 读取后发出(seq 自 1 起、supportedVersions
 *    = [1]、capabilities 默认声明全部三项);`T_handshake` 窗口内按上限重发,
 *    每次 seq 递增(§4.3 不向宿主重试风暴);hello 阶段 targetOrigin = "*"
 *    (接收面唯一为 window.parent,宿主侧 V-1/V-1'/V-5/V-7 全量补偿,§4.1);
 *  - **ready 消费**:V-1'(source === window.parent)→ V-2 → V-3 → V-4 → V-5
 *    → V-7(高水位)→ 防御性 V-8(granted ⊆ 本端声明集)→ 通过即**钉住宿主
 *    origin**(V-11:此后发送一律明确 targetOrigin;入站一律核对该 origin);
 *    ready 重发:seq 更大接受并幂等重放初始化(§4.5),更小丢弃;
 *  - **方向过滤**:只接受 EMBED_HOST_TO_PLUGIN_TYPES(V-6);theme_changed /
 *    language_changed 未授予时收到即丢弃 + 计数(V-8 / §4.4 三行表);
 *  - **port 路径**:宿主转移 port(WP-51 wire 形态:转移消息 data=null,port
 *    在 event.ports[0])后,控制面消息改走 port(端点绑定,免 origin 校验);
 *    凭证信封 {kind: stackmaster:embed-credential, credential} 为 D-API-75
 *    备用通道 b(默认路径 a 为主,元素侧优先消费引导配置);
 *  - **失败静默**(V-12):一切校验失败丢弃 + 本地计数,零反馈零中断;计数
 *    键与宿主侧同词汇(VIOLATION_COUNTER_KEYS,13.3 E2E 同一断言锚)。
 *
 * 确定性纪律:时钟 / 调度器 / parent 窗口 / 监听窗口 / 期望 source 全部注入。
 */
import {
  EMBED_CAPABILITIES,
  EMBED_HOST_TO_PLUGIN_TYPES,
  EMBED_PROTOCOL_VERSION,
  EmbedMessageSchema,
  MAX_EMBED_MESSAGE_BYTES,
  type EmbedCapability,
  type EmbedMessage,
  type EmbedTheme,
} from "@stackmaster/protocol";
import {
  CONTROL_MESSAGE_MAX_PER_SECOND_DEFAULT,
  CONTROL_MESSAGE_MAX_PER_SECOND_MAX,
  CONTROL_MESSAGE_MAX_PER_SECOND_MIN,
  EMBED_PORT_CREDENTIAL_KIND,
  HANDSHAKE_TIMEOUT_MS_DEFAULT,
  HANDSHAKE_TIMEOUT_MS_MAX,
  HANDSHAKE_TIMEOUT_MS_MIN,
  HELLO_MAX_RETRIES_DEFAULT,
  HELLO_MAX_RETRIES_MAX,
  HELLO_MAX_RETRIES_MIN,
  VIOLATION_COUNTER_KEYS,
  TypeRateLimiter,
} from "@stackmaster/embed-runtime";

/* ------------------------------------------------------------------ */
/* 事件面                                                              */
/* ------------------------------------------------------------------ */

/** 握手会话事件名(元素经 addEventListener 订阅)。 */
export const PWN_EMBED_EVENTS = {
  /** 握手完成(含 ready 幂等重放;detail.replay 区分首达 / 重放)。 */
  ready: "pwn-embed-ready",
  /** T_handshake 窗口耗尽仍未就绪(§4.3 降级显示;会话保持,迟到 ready 可恢复)。 */
  degraded: "pwn-embed-degraded",
  /** 运行中主题切换(已过 V-5/V-6/V-7/V-8/V-10)。 */
  themeChanged: "pwn-embed-theme-changed",
  /** 运行中语言切换(同上)。 */
  languageChanged: "pwn-embed-language-changed",
  /** 违规计数变化(V-12 插件本地面;携带全键快照)。 */
  violation: "pwn-embed-violation",
  /** port 凭证信封到达(D-API-75 备用通道 b)。 */
  credential: "pwn-embed-credential",
} as const;

/** pwn-embed-ready detail。 */
export interface PluginReadyDetail {
  readonly grantedCapabilities: readonly EmbedCapability[];
  readonly config: { readonly theme: EmbedTheme; readonly language: string };
  /** true = ready 幂等重放(宿侧重试,seq 更大;§4.5)。 */
  readonly replay: boolean;
  /** 本次 ready 钉住的宿主 origin(V-11)。 */
  readonly pinnedOrigin: string;
}

/** pwn-embed-degraded detail。 */
export interface PluginDegradedDetail {
  readonly reason: "handshake-timeout";
}

/** pwn-embed-theme-changed detail。 */
export interface PluginThemeChangedDetail {
  readonly theme: EmbedTheme;
}

/** pwn-embed-language-changed detail。 */
export interface PluginLanguageChangedDetail {
  readonly language: string;
}

/** pwn-embed-violation detail(counters 为快照,命中键可读出)。 */
export interface PluginViolationDetail {
  readonly key: string;
  readonly counters: Readonly<Record<string, number>>;
}

/** pwn-embed-credential detail。 */
export interface PluginCredentialDetail {
  readonly credential: string;
}

/* ------------------------------------------------------------------ */
/* 传输层注入面                                                        */
/* ------------------------------------------------------------------ */

/** 发起窗口最小面(window.parent 的结构类型;测试注入记录型假体)。 */
export interface PluginParentWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}

/** 监听窗口最小面(默认 globalThis;测试注入假窗口)。 */
export interface PluginListenWindow {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export interface PluginScheduler {
  setTimeout(fn: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PluginEmbedHandshakeOptions {
  /** 嵌入会话标识(fragment 一次性读取值;V-5 绑定锚)。 */
  readonly esid: string;
  /** 本端支持版本集(默认 [EMBED_PROTOCOL_VERSION];V-3 受理集)。 */
  readonly supportedVersions?: readonly number[];
  /** hello 能力声明(默认全部三项;§4.4 空数组 = 完全静态形态)。 */
  readonly capabilities?: readonly EmbedCapability[];
  /** T_handshake(默认 10000,clamp 3000–30000;D-API-77)。 */
  readonly handshakeTimeoutMs?: number;
  /** hello 重试上限(默认 3,clamp 0–10;语义 = 首发之外的窗口内重发预算)。 */
  readonly helloMaxRetries?: number;
  /** 控制消息入站每秒上限(V-10 外圈;默认 10,clamp 1–120)。 */
  readonly controlMessageMaxPerSecond?: number;
  /* ---- 传输层注入(测试确定性;默认浏览器全局)---- */
  readonly clock?: () => number;
  readonly scheduler?: PluginScheduler;
  readonly parentWindow?: PluginParentWindow;
  readonly expectedSource?: unknown;
  readonly listenWindow?: PluginListenWindow;
}

/** 会话状态(awaiting-ready = hello 已发出等待 ready;degraded = 窗口耗尽)。 */
export type PluginHandshakeState = "awaiting-ready" | "ready" | "degraded";

/** 默认传输实现(浏览器全局;构造时固化)。 */
function defaultParentWindow(): PluginParentWindow | null {
  const parent = (globalThis as { parent?: PluginParentWindow }).parent;
  return parent !== undefined && typeof parent.postMessage === "function" ? parent : null;
}

function defaultListenWindow(): PluginListenWindow | null {
  const win = globalThis as unknown as Partial<PluginListenWindow>;
  return typeof win.addEventListener === "function" && typeof win.removeEventListener === "function"
    ? (win as PluginListenWindow)
    : null;
}

const defaultScheduler: PluginScheduler = {
  setTimeout: (fn, delayMs) => setTimeout(fn, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

/** clamp(D-API-77 clamp 语义;边界值取默认常量,与宿主侧同源)。 */
function clampInteger(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** 已绑定的控制面 port 最小面(真实 MessagePort 的结构子集)。 */
interface BoundPort {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage?(message: unknown): void;
}

/* ------------------------------------------------------------------ */
/* 状态机                                                              */
/* ------------------------------------------------------------------ */

export class PluginEmbedHandshake extends EventTarget {
  readonly #esid: string;
  readonly #supportedVersions: readonly number[];
  readonly #capabilities: readonly EmbedCapability[];
  readonly #handshakeTimeoutMs: number;
  readonly #helloMaxRetries: number;
  readonly #parentWindow: PluginParentWindow;
  readonly #expectedSource: unknown;
  readonly #listenWindow: PluginListenWindow;
  readonly #clock: () => number;
  readonly #scheduler: PluginScheduler;
  /** V-10 入站外圈(控制消息按类型限速;与宿主自限同款构件,Q4 复用面)。 */
  readonly #inboundLimiter: TypeRateLimiter;
  readonly #counters = new Map<string, number>();

  #state: PluginHandshakeState = "awaiting-ready";
  /** 本端发送序(会话内严格递增,自 1;hello 与 height_changed 共用)。 */
  #sendSeq = 0;
  /** 对端(宿主)seq 高水位(V-7;重载后新文档从零重开,§4.5)。 */
  #peerSeqHighWater = 0;
  #granted: EmbedCapability[] = [];
  #config: { theme: EmbedTheme; language: string } | null = null;
  #pinnedOrigin: string | null = null;
  /** 最近一次 window message 的 origin(ready 的 V-11 钉住值来源)。 */
  #lastWindowOrigin: string | null = null;
  /** 已绑定的控制面 port(绑定后宿主控制消息可经 port 到达,§4.2)。 */
  #activePort: BoundPort | null = null;
  #windowTimer: unknown = null;
  #retryTimer: unknown = null;
  #sendsInWindow = 0;
  #started = false;
  #disposed = false;

  readonly #boundListener = (event: MessageEvent): void => {
    this.handleMessageEvent(event);
  };

  readonly #onRetryTimer = (): void => {
    this.#retryTimer = null;
    if (this.#disposed || this.#state === "ready") {
      return;
    }
    if (this.#sendsInWindow < this.#helloMaxRetries + 1) {
      this.#sendHello();
      const interval = Math.max(1, Math.floor(this.#handshakeTimeoutMs / (this.#helloMaxRetries + 1)));
      this.#retryTimer = this.#scheduler.setTimeout(this.#onRetryTimer, interval);
    }
  };

  public constructor(options: PluginEmbedHandshakeOptions) {
    super();
    this.#esid = options.esid;
    this.#supportedVersions = options.supportedVersions ?? [EMBED_PROTOCOL_VERSION];
    this.#capabilities = options.capabilities ?? [...EMBED_CAPABILITIES];
    this.#handshakeTimeoutMs = clampInteger(
      options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS_DEFAULT,
      HANDSHAKE_TIMEOUT_MS_MIN,
      HANDSHAKE_TIMEOUT_MS_MAX,
    );
    this.#helloMaxRetries = clampInteger(
      options.helloMaxRetries ?? HELLO_MAX_RETRIES_DEFAULT,
      HELLO_MAX_RETRIES_MIN,
      HELLO_MAX_RETRIES_MAX,
    );
    const controlLimit = clampInteger(
      options.controlMessageMaxPerSecond ?? CONTROL_MESSAGE_MAX_PER_SECOND_DEFAULT,
      CONTROL_MESSAGE_MAX_PER_SECOND_MIN,
      CONTROL_MESSAGE_MAX_PER_SECOND_MAX,
    );
    this.#clock = options.clock ?? (() => performance.now());
    this.#scheduler = options.scheduler ?? defaultScheduler;
    const parent = options.parentWindow ?? defaultParentWindow();
    if (parent === null) {
      throw new Error("环境缺少 window.parent postMessage 面:请经 parentWindow 选项注入");
    }
    this.#parentWindow = parent;
    this.#expectedSource = options.expectedSource ?? parent;
    const listen = options.listenWindow ?? defaultListenWindow();
    if (listen === null) {
      throw new Error("环境缺少 window message 监听面:请经 listenWindow 选项注入");
    }
    this.#listenWindow = listen;
    this.#inboundLimiter = new TypeRateLimiter(this.#clock, () => controlLimit);
  }

  /* ---------------------------------------------------------------- */
  /* 只读诊断面                                                         */
  /* ---------------------------------------------------------------- */

  public get state(): PluginHandshakeState {
    return this.#state;
  }

  public get pinnedOrigin(): string | null {
    return this.#pinnedOrigin;
  }

  public get grantedCapabilities(): readonly EmbedCapability[] {
    return [...this.#granted];
  }

  public get readyConfig(): { theme: EmbedTheme; language: string } | null {
    return this.#config === null ? null : { ...this.#config };
  }

  /** 全键稳定快照(未命中补 0,含本地扩展键;与宿主侧形态一致)。 */
  public getViolationCounters(): Readonly<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const key of Object.values(VIOLATION_COUNTER_KEYS)) {
      out[key] = this.#counters.get(key) ?? 0;
    }
    for (const [key, value] of this.#counters.entries()) {
      if (!(key in out)) {
        out[key] = value;
      }
    }
    return Object.freeze(out);
  }

  /* ---------------------------------------------------------------- */
  /* 生命周期与发送面                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * 启动握手:监听宿主消息 + 发出首个 hello(seq=1,targetOrigin "*")+ 启动
   * T_handshake 窗口(幂等;重复 start 为 no-op)。
   */
  public start(): void {
    if (this.#started || this.#disposed) {
      return;
    }
    this.#started = true;
    this.#listenWindow.addEventListener("message", this.#boundListener);
    this.#beginWindow();
  }

  /**
   * 用户可见重试入口(§4.5):同会话重发 hello(seq 递增,不清零),重开
   * T_handshake 窗口与重试预算;已就绪 / 已释放为 no-op。
   */
  public retry(): void {
    if (this.#disposed || this.#state === "ready") {
      return;
    }
    this.#beginWindow();
  }

  /**
   * 上报内容高度(组件在 auto_resize 已授予时才装配高度管道;此处做运行期
   * 复核:未就绪 / 未授予静默忽略——发送义务纪律,不是违规计数面)。
   */
  public sendHeightChanged(heightPx: number): boolean {
    if (this.#disposed || this.#state !== "ready" || !this.#granted.includes("auto_resize")) {
      return false;
    }
    const envelope: EmbedMessage = {
      protocolVersion: EMBED_PROTOCOL_VERSION,
      type: "height_changed",
      sessionId: this.#esid,
      seq: ++this.#sendSeq,
      payload: { heightPx },
    };
    this.#postToHost(envelope);
    return true;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearWindowTimers();
    this.#listenWindow.removeEventListener("message", this.#boundListener);
    if (this.#activePort !== null) {
      this.#activePort.onmessage = null;
      this.#activePort = null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* 入站流水线                                                          */
  /* ---------------------------------------------------------------- */

  /** window message 入口(port 转移识别 → 身份校验 → 契约校验 → 分发)。 */
  handleMessageEvent(event: MessageEvent): void {
    if (this.#disposed) return;
    // port 转移消息(WP-51 wire 形态):data 恒为 null、port 在 ports[0];
    // 转移消息零载荷、零绑定值(V-13 前置形态),port 本体即全部语义。
    if (event.ports.length > 0) {
      this.#bindPort(event.ports[0]);
      return;
    }
    if (typeof event.origin === "string" && event.origin !== "") {
      this.#lastWindowOrigin = event.origin;
    }
    if (!this.#checkWindowIdentity(event)) return;
    this.#ingest(event.data);
  }

  /**
   * V-1'(source 严格等于期望窗口——独立来源与 opaque 语义同款绑定)+ 握手
   * 后 V-1(event.origin 与钉住值严格相等)。hello 阶段宿主 origin 未知,
   * 不核 origin(ready 的 event.origin 即钉住值)。
   */
  #checkWindowIdentity(event: MessageEvent): boolean {
    if (event.source !== this.#expectedSource) {
      this.#record(VIOLATION_COUNTER_KEYS.v1pSourceMismatch);
      return false;
    }
    if (this.#pinnedOrigin !== null && event.origin !== this.#pinnedOrigin) {
      this.#record(VIOLATION_COUNTER_KEYS.v1OriginMismatch);
      return false;
    }
    return true;
  }

  /** port 绑定(§4.2 控制面强化;端点经绑定,消息免 origin / source 校验)。 */
  #bindPort(port: MessageEvent["ports"][number] | undefined): void {
    if (port === undefined || this.#activePort !== null) {
      return;
    }
    const typed = port as BoundPort;
    typed.onmessage = (event: MessageEvent) => {
      if (!this.#disposed) {
        this.#ingest(event.data);
      }
    };
    this.#activePort = typed;
  }

  /**
   * 共同校验链(V-2 → V-3 → V-4 → V-5 → V-6;window 与 port 两条到达路径
   * 同一管线——V-2 语义与宿主侧 embed-runtime 逐条同构)。
   */
  #ingest(data: unknown): void {
    const parsed = this.#parseWithinSizeLimit(data);
    if (parsed === null) return;

    // port 凭证信封(D-API-75 备用通道 b):先于 EmbedMessage 解析判定;
    // credential 对浏览器不透明——只搬运给消费方,零解析零校验内容。
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { kind?: unknown }).kind === EMBED_PORT_CREDENTIAL_KIND
    ) {
      const credential = (parsed as { credential?: unknown }).credential;
      if (typeof credential === "string" && credential !== "") {
        this.#emit(PWN_EMBED_EVENTS.credential, { credential } satisfies PluginCredentialDetail);
      } else {
        this.#record(VIOLATION_COUNTER_KEYS.v4SchemaInvalid);
      }
      return;
    }

    // V-3:版本受理集(冻结期 [1];缺版本 / 非正整数按 V-4 拒绝)。
    const rawVersion = (parsed as { protocolVersion?: unknown }).protocolVersion;
    if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion) || rawVersion < 1) {
      this.#record(VIOLATION_COUNTER_KEYS.v4SchemaInvalid);
      return;
    }
    if (!this.#supportedVersions.includes(rawVersion)) {
      this.#record(VIOLATION_COUNTER_KEYS.v3UnsupportedVersion);
      return;
    }
    // V-4:契约 strictObject 校验(未知类型 / 字段 / 坏枚举 / 坏标识符;V-9 的
    // 伪造字段在此结构性落网)。
    const message = EmbedMessageSchema.safeParse(parsed);
    if (!message.success) {
      this.#record(VIOLATION_COUNTER_KEYS.v4SchemaInvalid);
      return;
    }
    // V-5:esid 全等。
    if (message.data.sessionId !== this.#esid) {
      this.#record(VIOLATION_COUNTER_KEYS.v5SessionMismatch);
      return;
    }
    // V-6:方向集(插件只收宿主 → 插件方向)。
    if (!(EMBED_HOST_TO_PLUGIN_TYPES as readonly string[]).includes(message.data.type)) {
      this.#record(VIOLATION_COUNTER_KEYS.v6WrongDirection);
      return;
    }
    if (message.data.type === "ready") {
      this.#processReady(message.data);
      return;
    }
    if (message.data.type === "theme_changed" || message.data.type === "language_changed") {
      this.#processControlMessage(message.data);
      return;
    }
    // 防御性不可达(V-6 已过滤插件 → 宿主方向类型)。
    this.#record(VIOLATION_COUNTER_KEYS.v6WrongDirection);
  }

  /**
   * V-2:结构化对象(WP-51 wire 形态)或字符串 JSON 两种到达形态,序列化
   * 字节 ≤ MAX_EMBED_MESSAGE_BYTES 且可解析为 JSON 对象;否则丢弃 + 计数。
   */
  #parseWithinSizeLimit(data: unknown): object | null {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (typeof data === "object" && data !== null) {
      try {
        const serialized: unknown = JSON.stringify(data);
        if (typeof serialized !== "string") {
          this.#record(VIOLATION_COUNTER_KEYS.v2NonJson);
          return null;
        }
        text = serialized;
      } catch {
        this.#record(VIOLATION_COUNTER_KEYS.v2NonJson);
        return null;
      }
    } else {
      this.#record(VIOLATION_COUNTER_KEYS.v2NonJson);
      return null;
    }
    if (new TextEncoder().encode(text).length > MAX_EMBED_MESSAGE_BYTES) {
      this.#record(VIOLATION_COUNTER_KEYS.v2Oversized);
      return null;
    }
    let value: unknown;
    if (typeof data === "object") {
      value = data; // 结构化对象形态:零重序列化消费。
    } else {
      try {
        value = JSON.parse(text);
      } catch {
        this.#record(VIOLATION_COUNTER_KEYS.v2NonJson);
        return null;
      }
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.#record(VIOLATION_COUNTER_KEYS.v2NonJson);
      return null;
    }
    return value;
  }

  /** ready 处理:V-7(高水位)→ 防御性 V-8 → 钉住 origin → 幂等初始化重放。 */
  #processReady(message: Extract<EmbedMessage, { type: "ready" }>): void {
    if (message.seq <= this.#peerSeqHighWater) {
      this.#record(VIOLATION_COUNTER_KEYS.v7StaleSeq);
      return;
    }
    // 防御性 V-8:granted ⊆ 本端声明集(§4.4 是宿主义务,本端不信任类型标注)。
    const overGranted = message.payload.grantedCapabilities.some(
      (capability) => !this.#capabilities.includes(capability),
    );
    if (overGranted) {
      this.#record(VIOLATION_COUNTER_KEYS.v8CapabilityViolation);
      return;
    }
    const firstCompletion = this.#state !== "ready";
    this.#peerSeqHighWater = message.seq;
    this.#granted = [...message.payload.grantedCapabilities];
    this.#config = { ...message.payload.config };
    // V-11:钉住宿主 origin(此后发送一律明确 targetOrigin;入站核对该值)。
    // 已钉住时保持原值(V-1 已闸:不同 origin 到不了这里)。
    this.#pinnedOrigin = this.#pinnedOrigin ?? this.#lastWindowOrigin ?? "*";
    this.#state = "ready";
    this.#clearWindowTimers();
    this.#emit(PWN_EMBED_EVENTS.ready, {
      grantedCapabilities: [...this.#granted],
      config: { ...this.#config },
      replay: !firstCompletion,
      pinnedOrigin: this.#pinnedOrigin,
    } satisfies PluginReadyDetail);
  }

  /** theme_changed / language_changed:V-7 → V-8(授予面)→ V-10 → 事件。 */
  #processControlMessage(
    message: Extract<EmbedMessage, { type: "theme_changed" | "language_changed" }>,
  ): void {
    if (message.seq <= this.#peerSeqHighWater) {
      this.#record(VIOLATION_COUNTER_KEYS.v7StaleSeq);
      return;
    }
    const capability: EmbedCapability = message.type === "theme_changed" ? "theme" : "language";
    // V-8(§4.4 三行表):未授予能力对应的消息出现即丢弃 + 计数,不中断会话。
    if (!this.#granted.includes(capability)) {
      this.#record(VIOLATION_COUNTER_KEYS.v8CapabilityViolation);
      return;
    }
    this.#peerSeqHighWater = message.seq;
    // V-10 入站外圈(宿主自限之外的第二道闸;超限丢弃 + 计数,零反馈)。
    if (!this.#inboundLimiter.tryAcquire(message.type)) {
      this.#record(VIOLATION_COUNTER_KEYS.v10RateLimit);
      return;
    }
    if (message.type === "theme_changed") {
      this.#emit(
        PWN_EMBED_EVENTS.themeChanged,
        { theme: message.payload.theme } satisfies PluginThemeChangedDetail,
      );
    } else {
      this.#emit(PWN_EMBED_EVENTS.languageChanged, {
        language: message.payload.language,
      } satisfies PluginLanguageChangedDetail);
    }
  }

  /* ---------------------------------------------------------------- */
  /* hello 窗口(§4.3:窗口内重发预算;耗尽即降级显示)                    */
  /* ---------------------------------------------------------------- */

  /**
   * 开启(或重开)一个 T_handshake 窗口:立即发出 hello 并按固定间隔重发,
   * 窗口内总发送次数 = 1 + helloMaxRetries(首发 + 重试预算;D-API-77 语义
   * 的登记解释见 WP-52 决策草稿)。窗口到期仍未就绪 → 降级事件(会话保持:
   * 迟到的 ready 通过全部校验后仍可完成握手——慢网韧性,不属校验失败)。
   */
  #beginWindow(): void {
    this.#clearWindowTimers();
    this.#sendsInWindow = 0;
    this.#sendHello();
    const maxSends = this.#helloMaxRetries + 1;
    if (maxSends > 1) {
      const interval = Math.max(1, Math.floor(this.#handshakeTimeoutMs / maxSends));
      this.#retryTimer = this.#scheduler.setTimeout(this.#onRetryTimer, interval);
    }
    this.#windowTimer = this.#scheduler.setTimeout(() => {
      this.#windowTimer = null;
      if (this.#disposed || this.#state === "ready") {
        return;
      }
      this.#state = "degraded";
      this.#emit(PWN_EMBED_EVENTS.degraded, { reason: "handshake-timeout" } satisfies PluginDegradedDetail);
    }, this.#handshakeTimeoutMs);
  }

  /** hello 发送(seq 递增;targetOrigin 恒为 "*"——V-11 场景 (b),钉住前唯一例外)。 */
  #sendHello(): void {
    this.#sendsInWindow += 1;
    const envelope: EmbedMessage = {
      protocolVersion: EMBED_PROTOCOL_VERSION,
      type: "hello",
      sessionId: this.#esid,
      seq: ++this.#sendSeq,
      payload: {
        supportedVersions: [...this.#supportedVersions],
        capabilities: [...this.#capabilities],
      },
    };
    this.#parentWindow.postMessage(envelope, "*");
  }

  /** 就绪后统一发送面(V-11):一律钉住的明确 targetOrigin;port 在位时走 port。 */
  #postToHost(envelope: EmbedMessage): void {
    const port = this.#activePort;
    if (port !== null && typeof port.postMessage === "function") {
      port.postMessage(envelope);
      return;
    }
    this.#parentWindow.postMessage(envelope, this.#pinnedOrigin ?? "*");
  }

  #clearWindowTimers(): void {
    if (this.#windowTimer !== null) {
      this.#scheduler.clearTimeout(this.#windowTimer);
      this.#windowTimer = null;
    }
    if (this.#retryTimer !== null) {
      this.#scheduler.clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
  }

  #record(key: string): void {
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + 1);
    this.#emit(PWN_EMBED_EVENTS.violation, {
      key,
      counters: this.getViolationCounters(),
    } satisfies PluginViolationDetail);
  }

  #emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

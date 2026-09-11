/**
 * EmbedSession —— 宿主侧嵌入会话(WP-51 core;框架无关,零业务数据)。
 *
 * 状态机:`idle → awaiting-hello → ready`;任一状态可因超时 / 版本协商失败
 * (§4.3)/ dispose 进入 `unavailable`(停止控制面投递)。reload() 生成新
 * esid、旧值立即作废(V-5)、重走完整握手(对端 seq 高水位不继承,§4.5)。
 *
 * 入站流水线(每条 message 事件按序执行,任一步失败即丢弃 + 计数,零反馈):
 *   不可用后迟到消息 → V-1/V-1'(来源 / source 三重绑定之一)→ V-2(字节
 *   上限 + JSON 对象)→ V-3(版本受理集)→ V-4(版本 Schema strictObject)
 *   → V-5(esid 全等)→ V-6(方向集)→ 状态机分发(V-7 高水位 / V-8 能力
 *   一致性 / V-10 频率)。V-9 信封冻结由 protocol Schema 结构性保证(伪造
 *   即 V-4);V-11 发送面 targetOrigin 纪律在 deliverToPlugin 统一执行;
 *   V-12 失败静默是上述全部分支的统一失败处理;V-13 凭证只走
 *   deliverTokenViaPort(port 转移前置),发送面无任何凭证载荷。
 *
 * 本 SDK 不感知任何业务数据(动作 / 投影 / 错误不经此通道——那是插件 ↔
 * session-api 认证通道的事,嵌入协议 §4.1 注记)。
 */
import {
  EMBED_CAPABILITIES,
  EMBED_PLUGIN_TO_HOST_TYPES,
  EMBED_PROTOCOL_VERSION,
  EmbedLanguageSchema,
  EmbedThemeSchema,
  MAX_EMBED_MESSAGE_BYTES,
  type EmbedCapability,
  type EmbedMessage,
  type EmbedTheme,
} from "@stackmaster/protocol";
import {
  EmbedCapabilityNotGrantedError,
  EmbedInvalidOptionError,
  EmbedPortDeliveryError,
  EmbedUnavailableError,
} from "./errors.js";
import {
  EMBED_SESSION_EVENTS,
  type EmbedHandshakeCompleteDetail,
  type EmbedHeightChangedDetail,
  type EmbedReloadInitiatedDetail,
  type EmbedSessionState,
  type EmbedSessionUnavailableDetail,
  type EmbedSessionUnavailableReason,
  type EmbedViolationCountersChangedDetail,
} from "./events.js";
import { negotiateEmbedProtocolVersion } from "./negotiation.js";
import {
  resolveEmbedSessionOptions,
  type EmbedIframeLike,
  type EmbedInitialConfig,
  type EmbedMessagePortLike,
  type EmbedSessionOptions,
  type ResolvedEmbedSessionOptions,
} from "./options.js";
import { TypeRateLimiter } from "./rate-limiter.js";
import { VIOLATION_COUNTER_KEYS, ViolationCounters, type ViolationCounterKey } from "./counters.js";
import { generateEmbedSessionId, validateEmbedSessionId } from "./session-id.js";
import { assertAllVersionsHaveSchema, EMBED_MESSAGE_SCHEMAS } from "./version-registry.js";

/**
 * port 凭证信封的 kind 标记(D-API-75 备用通道的实现面;WP-52 插件侧按此
 * 消费)。port 转移消息本体为零载荷(只转移 port2,不携带任何凭证或绑定值,
 * V-13);token 只经 port 以本信封下发——port 端点经绑定,无 origin 歧义。
 */
export const EMBED_PORT_CREDENTIAL_KIND = "stackmaster:embed-credential";

/** hello / height_changed 分支的精确收窄(判别联合的 Extract 形态)。 */
type HelloMessage = Extract<EmbedMessage, { type: "hello" }>;
type HeightChangedMessage = Extract<EmbedMessage, { type: "height_changed" }>;

/** 宿主侧可对外读出的运维参数快照(D-API-77 构造参数面)。 */
export interface EmbedSessionResolvedParameters {
  readonly pluginOrigin: string;
  readonly opaqueOrigin: boolean;
  readonly supportedVersions: readonly number[];
  readonly grantableCapabilities: readonly EmbedCapability[];
  readonly handshakeTimeoutMs: number;
  readonly heightChangedMaxPerSecond: number;
  readonly controlMessageMaxPerSecond: number;
  readonly helloMaxRetries: number;
  readonly maxHeightPx: number;
}

export class EmbedSession extends EventTarget {
  private readonly opts: ResolvedEmbedSessionOptions;
  private readonly counters = new ViolationCounters();
  /** V-10:每 embed 会话按消息类型限速(height_changed 与控制消息分别取参)。 */
  private readonly rateLimiter: TypeRateLimiter;
  private sessionIdValue: string;
  private stateValue: EmbedSessionState = "idle";
  private peerSeqHighWater = 0;
  private sendSeqValue = 0;
  private grantedCapabilitiesValue: EmbedCapability[] = [];
  private negotiatedVersionValue: number | null = null;
  private iframe: EmbedIframeLike | null = null;
  private handshakeTimer: unknown = null;
  /** 已转移的控制面 port(§4.2 强化 / D-API-75 备用通道;null = 未转移)。 */
  private activePort: EmbedMessagePortLike | null = null;
  private disposed = false;

  private readonly boundListener = (event: MessageEvent): void => {
    this.handleMessage(event);
  };

  public constructor(options: EmbedSessionOptions) {
    super();
    assertAllVersionsHaveSchema(options.supportedVersions ?? [EMBED_PROTOCOL_VERSION]);
    this.opts = resolveEmbedSessionOptions(options);
    this.sessionIdValue =
      options.sessionId === undefined
        ? generateEmbedSessionId(this.opts.randomBytes)
        : validateEmbedSessionId(options.sessionId);
    this.rateLimiter = new TypeRateLimiter(this.opts.clock, (type) =>
      type === "height_changed"
        ? this.opts.heightChangedMaxPerSecond
        : this.opts.controlMessageMaxPerSecond,
    );
    // 尽早监听:快插件可能在 iframe load 事件之前就发出 hello。
    this.opts.hostWindow.addEventListener("message", this.boundListener);
  }

  /* ---------------------------------------------------------------- */
  /* 只读状态面                                                          */
  /* ---------------------------------------------------------------- */

  /** 当前嵌入会话标识(重载后轮换)。 */
  public getEmbedSessionId(): string {
    return this.sessionIdValue;
  }

  public getState(): EmbedSessionState {
    return this.stateValue;
  }

  /** 协商结果版本(握手完成前 null)。 */
  public getNegotiatedVersion(): number | null {
    return this.negotiatedVersionValue;
  }

  public getGrantedCapabilities(): readonly EmbedCapability[] {
    return this.grantedCapabilitiesValue;
  }

  /** 初始外观配置(随 ready 下发的同一值)。 */
  public getConfig(): EmbedInitialConfig {
    return { ...this.opts.config };
  }

  /** 违规计数快照(V-12 宿主本地面;每次变化伴随 violation-counters-changed)。 */
  public getViolationCounters(): Readonly<Record<string, number>> {
    return this.counters.snapshot();
  }

  /** port 是否已转移(转移后控制面消息改走 port,§4.2)。 */
  public isPortActive(): boolean {
    return this.activePort !== null;
  }

  /** 运维参数快照(D-API-77 构造参数面;供宿主诊断 / 模拟页展示)。 */
  public getResolvedParameters(): EmbedSessionResolvedParameters {
    return {
      pluginOrigin: this.opts.pluginOrigin,
      opaqueOrigin: this.opts.opaqueOrigin,
      supportedVersions: [...this.opts.supportedVersions],
      grantableCapabilities: [...this.opts.grantableCapabilities],
      handshakeTimeoutMs: this.opts.handshakeTimeoutMs,
      heightChangedMaxPerSecond: this.opts.heightChangedMaxPerSecond,
      controlMessageMaxPerSecond: this.opts.controlMessageMaxPerSecond,
      helloMaxRetries: this.opts.helloMaxRetries,
      maxHeightPx: this.opts.maxHeightPx,
    };
  }

  /* ---------------------------------------------------------------- */
  /* 生命周期                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * iframe src(硬门槛:fragment 只放 `#esid=<esid>`,零权限语义、零凭证;
   * token 不进 URL query——V-13)。
   */
  public buildIframeSrc(): string {
    return `${this.opts.pluginUrl}#esid=${this.sessionIdValue}`;
  }

  /**
   * 挂接 iframe(实时读取 contentWindow:iframe 重载后自动指向新文档窗口,
   * V-1' 的 source 绑定随之正确轮换)。
   */
  public attachIframe(iframe: EmbedIframeLike): void {
    this.iframe = iframe;
  }

  /** iframe load 事件挂钩:idle → awaiting-hello,启动 T_handshake(幂等)。 */
  public notifyIframeLoad(): void {
    if (this.stateValue !== "idle") {
      // awaiting-hello 重复 load / ready 后 load / 不可用后 load:一律忽略。
      return;
    }
    this.stateValue = "awaiting-hello";
    this.startHandshakeTimer();
  }

  /**
   * iframe 重载(§4.5):生成新 esid、旧值立即作废(V-5)、对端 seq 高水位
   * 与能力授予全部清零、重走完整握手;如适用申请新 embed token 由宿主自理
   * (旧 token 因会话绑定不匹配自然失效)。返回新 esid 与新 iframe src。
   */
  public reload(): EmbedReloadInitiatedDetail {
    this.clearHandshakeTimer();
    this.closePort();
    this.sessionIdValue = generateEmbedSessionId(this.opts.randomBytes);
    this.peerSeqHighWater = 0;
    this.sendSeqValue = 0;
    this.grantedCapabilitiesValue = [];
    this.negotiatedVersionValue = null;
    this.stateValue = "idle";
    const detail: EmbedReloadInitiatedDetail = {
      sessionId: this.sessionIdValue,
      iframeSrc: this.buildIframeSrc(),
    };
    this.emit(EMBED_SESSION_EVENTS.reloadInitiated, detail);
    return detail;
  }

  /** 释放会话:停止监听与计时、关闭 port、标记不可用(disposed)。 */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.opts.hostWindow.removeEventListener("message", this.boundListener);
    this.closePort();
    this.markUnavailable("disposed");
  }

  /* ---------------------------------------------------------------- */
  /* 控制面发送 API                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * 经 MessageChannel port 下发凭证(D-API-75 备用通道;opaque 部署形态)。
   * **port 转移是必需前置**(V-13):本方法先转移 port2(转移消息零载荷,
   * 不携带任何凭证或绑定值),再经 port1 下发 token——token 绝不经
   * `targetOrigin: "*"` 的裸 postMessage 承载。仅握手完成后可用。
   */
  public deliverTokenViaPort(token: string): void {
    if (this.stateValue !== "ready") {
      throw new EmbedPortDeliveryError(
        "port 交付是握手后路径(D-API-75 备用通道):仅在 handshake-complete 后可用,port 转移为必需前置",
      );
    }
    if (typeof token !== "string" || token === "") {
      throw new EmbedPortDeliveryError("token 必须为非空字符串");
    }
    const target = this.iframe?.contentWindow ?? null;
    if (target === null) {
      throw new EmbedPortDeliveryError("未挂接 iframe 或 contentWindow 不可用:port 无法转移");
    }
    const channel = this.opts.channelFactory();
    // V-11:非 opaque 插件恒用明确 targetOrigin;opaque 目标允许 "*"。
    const targetOrigin = this.opts.opaqueOrigin ? "*" : this.opts.pluginOrigin;
    // 转移消息零载荷:除 port2 本体外不携带任何凭证或绑定值(V-13)。
    target.postMessage(null, targetOrigin, [channel.port2 as unknown as Transferable]);
    channel.port1.postMessage({ kind: EMBED_PORT_CREDENTIAL_KIND, credential: token });
    this.activePort = channel.port1;
  }

  /**
   * 运行中主题切换(仅 `theme` 已授予;§4.4 降级矩阵的宿主义务)。
   * 返回是否发出(V-10 超限 = 丢弃 + 计数,返回 false)。
   */
  public sendThemeChanged(theme: EmbedTheme): boolean {
    const parsed = EmbedThemeSchema.safeParse(theme);
    if (!parsed.success) {
      throw new EmbedInvalidOptionError("theme 取值非法(冻结三值:light / dark / auto)");
    }
    this.assertControlPlaneAllowed("theme");
    // V-10:超限 = 丢弃 + 计数(seq 不消费;宿主侧跳号对插件同样可接受,V-7)。
    if (!this.rateLimiter.tryAcquire("theme_changed")) {
      this.recordCounter(VIOLATION_COUNTER_KEYS.v10RateLimit);
      return false;
    }
    const envelope: EmbedMessage = {
      protocolVersion: EMBED_PROTOCOL_VERSION,
      type: "theme_changed",
      sessionId: this.sessionIdValue,
      seq: ++this.sendSeqValue,
      payload: { theme },
    };
    this.deliverToPlugin(envelope);
    return true;
  }

  /**
   * 运行中语言切换(仅 `language` 已授予;BCP-47 规范语法子集)。
   * 返回是否发出(V-10 超限 = 丢弃 + 计数,返回 false)。
   */
  public sendLanguageChanged(language: string): boolean {
    const parsed = EmbedLanguageSchema.safeParse(language);
    if (!parsed.success) {
      throw new EmbedInvalidOptionError("language 取值非法(BCP-47 规范语法子集)");
    }
    this.assertControlPlaneAllowed("language");
    if (!this.rateLimiter.tryAcquire("language_changed")) {
      this.recordCounter(VIOLATION_COUNTER_KEYS.v10RateLimit);
      return false;
    }
    const envelope: EmbedMessage = {
      protocolVersion: EMBED_PROTOCOL_VERSION,
      type: "language_changed",
      sessionId: this.sessionIdValue,
      seq: ++this.sendSeqValue,
      payload: { language },
    };
    this.deliverToPlugin(envelope);
    return true;
  }

  private assertControlPlaneAllowed(capability: EmbedCapability): void {
    if (this.disposed || this.stateValue === "unavailable") {
      throw new EmbedUnavailableError("embed 会话不可用:控制面投递已停止(§4.5)");
    }
    if (this.stateValue !== "ready") {
      throw new EmbedUnavailableError("握手未完成:控制面消息只能在 ready 后发送");
    }
    if (!this.grantedCapabilitiesValue.includes(capability)) {
      throw new EmbedCapabilityNotGrantedError(
        `能力 ${capability} 未授予:宿主不得发送对应控制消息(§4.4 降级矩阵,V-8)`,
      );
    }
  }

  /** 发送就绪消息(握手完成;seq 为宿主发送侧严格递增)。 */
  private sendReady(): void {
    const envelope: EmbedMessage = {
      // 协商结果必属宿主受理集(装配期保证全部受理版本已注册 Schema),
      // 冻结期恒为字面量 1;断言只表达该不变量。
      protocolVersion: (this.negotiatedVersionValue ?? EMBED_PROTOCOL_VERSION) as typeof EMBED_PROTOCOL_VERSION,
      type: "ready",
      sessionId: this.sessionIdValue,
      seq: ++this.sendSeqValue,
      payload: {
        grantedCapabilities: [...this.grantedCapabilitiesValue],
        config: { ...this.opts.config },
      },
    };
    this.deliverToPlugin(envelope);
  }

  /**
   * 统一发送面(V-11):port 已转移 → 消息走 port(端点经绑定);否则经
   * iframe.contentWindow.postMessage——非 opaque 插件恒用明确 targetOrigin,
   * 仅 opaque 目标允许 "*"(§4.1 / §4.2)。
   */
  private deliverToPlugin(message: EmbedMessage): void {
    if (this.activePort !== null) {
      this.activePort.postMessage(message);
      return;
    }
    const target = this.iframe?.contentWindow ?? null;
    if (target === null) {
      // 防御性(握手身份检查已保证挂接):不向对端反馈任何异常。
      return;
    }
    const targetOrigin = this.opts.opaqueOrigin ? "*" : this.opts.pluginOrigin;
    target.postMessage(message, targetOrigin);
  }

  /* ---------------------------------------------------------------- */
  /* 入站流水线                                                          */
  /* ---------------------------------------------------------------- */

  private handleMessage(event: MessageEvent): void {
    if (this.disposed) return;
    // 不可用后迟到消息:丢弃 + 计数(§4.5 停止控制面投递的通道面延伸)。
    if (this.stateValue === "unavailable") {
      this.recordCounter(VIOLATION_COUNTER_KEYS.unavailableDrop);
      return;
    }
    if (!this.checkPeerIdentity(event)) return;
    const body = this.parseWithinSizeLimit(event.data);
    if (!body.ok) return;

    // V-3:版本在受理集(N-1 窗口);缺版本 / 非正整数按 V-4(Schema 拒绝)。
    const rawVersion = (body.value as { protocolVersion?: unknown }).protocolVersion;
    if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion) || rawVersion < 1) {
      this.recordCounter(VIOLATION_COUNTER_KEYS.v4SchemaInvalid);
      return;
    }
    if (!this.opts.supportedVersions.includes(rawVersion)) {
      this.recordCounter(VIOLATION_COUNTER_KEYS.v3UnsupportedVersion);
      return;
    }
    const schema = EMBED_MESSAGE_SCHEMAS.get(rawVersion);
    if (schema === undefined) {
      // 装配期已保证;fail-closed 兜底。
      this.recordCounter(VIOLATION_COUNTER_KEYS.v3UnsupportedVersion);
      return;
    }
    // V-4:按对应版本 EmbedMessageSchema strictObject 校验(未知类型 / 字段 /
    // 坏枚举 / 坏标识符一律拒绝;V-9 伪造字段在此结构性落网)。
    const parsedMessage = schema.safeParse(body.value);
    if (!parsedMessage.success) {
      this.recordCounter(VIOLATION_COUNTER_KEYS.v4SchemaInvalid);
      return;
    }
    const message = parsedMessage.data;

    // V-5:esid 全等(重载轮换后旧值不再匹配)。
    if (message.sessionId !== this.sessionIdValue) {
      this.recordCounter(VIOLATION_COUNTER_KEYS.v5SessionMismatch);
      return;
    }
    // V-6:方向集(宿主只收 plugin → host 类型)。
    if (!(EMBED_PLUGIN_TO_HOST_TYPES as readonly string[]).includes(message.type)) {
      this.recordCounter(VIOLATION_COUNTER_KEYS.v6WrongDirection);
      return;
    }

    if (message.type === "hello") {
      if (this.stateValue === "ready") {
        // 状态违规(§4.5 / §三接收端行为要点):丢弃 + 计数,不回任何消息。
        this.recordCounter(VIOLATION_COUNTER_KEYS.stateHelloAfterReady);
        return;
      }
      this.processHello(message);
      return;
    }
    if (message.type === "height_changed") {
      if (this.stateValue !== "ready") {
        // 就绪前授予集为空:auto_resize 必然未授予(V-8)。
        this.recordCounter(VIOLATION_COUNTER_KEYS.v8CapabilityViolation);
        return;
      }
      this.processHeightChanged(message);
      return;
    }
    // 防御性不可达(V-6 已过滤宿主 → 插件方向类型)。
    this.recordCounter(VIOLATION_COUNTER_KEYS.v6WrongDirection);
  }

  /**
   * V-1 / V-1':非 opaque 对端 event.origin 严格等于插件来源,并复核
   * source 与挂接 iframe 的对应关系(V-5 的窗口绑定);opaque 对端不采信
   * origin("null" 不是信任信号),只认 source === iframe.contentWindow。
   */
  private checkPeerIdentity(event: MessageEvent): boolean {
    const source: unknown = event.source;
    const boundWindow: unknown = this.iframe?.contentWindow ?? null;
    if (this.opts.opaqueOrigin) {
      if (boundWindow === null || source !== boundWindow) {
        this.recordCounter(VIOLATION_COUNTER_KEYS.v1pSourceMismatch);
        return false;
      }
      return true;
    }
    if (event.origin !== this.opts.pluginOrigin) {
      this.recordCounter(VIOLATION_COUNTER_KEYS.v1OriginMismatch);
      return false;
    }
    if (source !== boundWindow) {
      this.recordCounter(VIOLATION_COUNTER_KEYS.v1pSourceMismatch);
      return false;
    }
    return true;
  }

  /**
   * V-2:事件数据序列化字节 ≤ MAX_EMBED_MESSAGE_BYTES 才 JSON 解析;只接受
   * 可解析为 JSON 对象的数据(字符串 / 结构化对象两种到达形态都覆盖)。
   */
  private parseWithinSizeLimit(data: unknown): { ok: true; value: unknown } | { ok: false } {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (typeof data === "object" && data !== null) {
      try {
        const serialized: unknown = JSON.stringify(data);
        if (typeof serialized !== "string") {
          this.recordCounter(VIOLATION_COUNTER_KEYS.v2NonJson);
          return { ok: false };
        }
        text = serialized;
      } catch {
        this.recordCounter(VIOLATION_COUNTER_KEYS.v2NonJson);
        return { ok: false };
      }
    } else {
      this.recordCounter(VIOLATION_COUNTER_KEYS.v2NonJson);
      return { ok: false };
    }
    if (new TextEncoder().encode(text).length > MAX_EMBED_MESSAGE_BYTES) {
      this.recordCounter(VIOLATION_COUNTER_KEYS.v2Oversized);
      return { ok: false };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.recordCounter(VIOLATION_COUNTER_KEYS.v2NonJson);
      return { ok: false };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.recordCounter(VIOLATION_COUNTER_KEYS.v2NonJson);
      return { ok: false };
    }
    return { ok: true, value: parsed };
  }

  /** hello 处理(§4.1):V-7 → 版本协商(max-wins)→ 能力授予 → 发 ready。 */
  private processHello(message: HelloMessage): void {
    // V-7:对 hello 同样生效(重试 seq 递增,§4.3;重复 / 过期丢弃)。
    if (message.seq <= this.peerSeqHighWater) {
      this.recordCounter(VIOLATION_COUNTER_KEYS.v7StaleSeq);
      return;
    }
    // 版本协商:双方支持集交集取最大;交集为空 → §4.3 失败路径。
    const negotiated = negotiateEmbedProtocolVersion(
      this.opts.supportedVersions,
      message.payload.supportedVersions,
    );
    if (negotiated === null) {
      this.recordCounter(VIOLATION_COUNTER_KEYS.v3UnsupportedVersion);
      this.markUnavailable("version-negotiation-failed");
      return;
    }
    this.negotiatedVersionValue = negotiated;
    // 能力授予:granted ⊆ hello.capabilities(与宿主可授予集求交,冻结枚举序)。
    this.grantedCapabilitiesValue = EMBED_CAPABILITIES.filter(
      (capability) =>
        message.payload.capabilities.includes(capability) &&
        this.opts.grantableCapabilities.includes(capability),
    );
    this.peerSeqHighWater = message.seq;
    const firstCompletion = this.stateValue !== "ready";
    this.stateValue = "ready";
    this.clearHandshakeTimer();
    this.sendReady();
    if (firstCompletion) {
      const detail: EmbedHandshakeCompleteDetail = {
        sessionId: this.sessionIdValue,
        negotiatedVersion: negotiated,
        grantedCapabilities: [...this.grantedCapabilitiesValue],
        config: { ...this.opts.config },
      };
      this.emit(EMBED_SESSION_EVENTS.handshakeComplete, detail);
    }
  }

  /** height_changed 处理:V-7 → V-8 → V-10 → 高度收紧 → 事件。 */
  private processHeightChanged(message: HeightChangedMessage): void {
    // V-7:高水位(重复 / 过期丢弃;跳号允许)。
    if (message.seq <= this.peerSeqHighWater) {
      this.recordCounter(VIOLATION_COUNTER_KEYS.v7StaleSeq);
      return;
    }
    // V-8:仅 auto_resize 已授予时允许出现。
    if (!this.grantedCapabilitiesValue.includes("auto_resize")) {
      this.recordCounter(VIOLATION_COUNTER_KEYS.v8CapabilityViolation);
      return;
    }
    this.peerSeqHighWater = message.seq;
    // V-10:每秒硬上限(超限丢弃 + 计数)。
    if (!this.rateLimiter.tryAcquire("height_changed")) {
      this.recordCounter(VIOLATION_COUNTER_KEYS.v10RateLimit);
      return;
    }
    // 宿主布局收紧(maxHeightPx ≤ 协议冻结常量):收紧是宿主自由,不是违规。
    const heightPx = Math.min(message.payload.heightPx, this.opts.maxHeightPx);
    const detail: EmbedHeightChangedDetail = {
      sessionId: this.sessionIdValue,
      heightPx,
      clamped: heightPx !== message.payload.heightPx,
      seq: message.seq,
    };
    this.emit(EMBED_SESSION_EVENTS.heightChanged, detail);
  }

  /* ---------------------------------------------------------------- */
  /* 计时 / 计数 / 事件工具                                               */
  /* ---------------------------------------------------------------- */

  private startHandshakeTimer(): void {
    this.clearHandshakeTimer();
    this.handshakeTimer = this.opts.scheduler.setTimeout(() => {
      this.handshakeTimer = null;
      // T_handshake 内未收 hello:标记不可用(§4.5),停止控制面投递。
      if (this.stateValue === "awaiting-hello") {
        this.markUnavailable("handshake-timeout");
      }
    }, this.opts.handshakeTimeoutMs);
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      this.opts.scheduler.clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private markUnavailable(reason: EmbedSessionUnavailableReason): void {
    this.clearHandshakeTimer();
    this.stateValue = "unavailable";
    const detail: EmbedSessionUnavailableDetail = { sessionId: this.sessionIdValue, reason };
    this.emit(EMBED_SESSION_EVENTS.sessionUnavailable, detail);
  }

  private closePort(): void {
    if (this.activePort !== null) {
      this.activePort.close?.();
      this.activePort = null;
    }
  }

  /** 计数 + violation-counters-changed 事件(V-12 宿主本地面,零对端反馈)。 */
  private recordCounter(key: ViolationCounterKey): void {
    this.counters.record(key);
    const detail: EmbedViolationCountersChangedDetail = {
      sessionId: this.sessionIdValue,
      counters: this.counters.snapshot(),
    };
    this.emit(EMBED_SESSION_EVENTS.violationCountersChanged, detail);
  }

  private emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

/** 创建宿主侧嵌入会话(创建 iframe 前调用;esid 在此生成)。 */
export function createEmbedSession(options: EmbedSessionOptions): EmbedSession {
  return new EmbedSession(options);
}

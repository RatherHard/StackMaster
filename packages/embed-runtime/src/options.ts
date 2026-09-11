/**
 * embed-runtime 宿主侧 SDK —— 构造选项面与传输层注入(D-API-77)。
 *
 * 运维参数(D-API-77 定案,构造选项为配置载体;协议冻结常量
 * MAX_EMBED_MESSAGE_BYTES / MAX_EMBED_HEIGHT_PX 引用不重造、不提供放宽入口):
 *  - handshakeTimeoutMs(T_handshake,宿主侧:iframe load 后未收 hello 即
 *    标记 embed 会话不可用,§4.5)默认 10000,clamp 3000–30000;
 *  - heightChangedMaxPerSecond(V-10,按消息类型)默认 30,clamp 1–120;
 *  - controlMessageMaxPerSecond(V-10,宿主自控低频控制消息)默认 10,clamp 1–120;
 *  - helloMaxRetries(§4.3 插件侧重试预算,0–10)默认 3——宿主侧不消费该值
 *    发起重试(握手完成后再收 hello 一律按状态违规丢弃 + 计数,§4.5),
 *    该项仅为构造参数面完整性保留(react-wrapper 薄封装透传给宿主诊断面);
 *  - maxHeightPx(宿主布局收紧)只可收紧 ≤ MAX_EMBED_HEIGHT_PX,超上限
 *    拒绝装配(EmbedInvalidOptionError)。
 *
 * 传输层(clock / 随机源 / 调度器 / postMessage 宿主窗口 / MessageChannel)
 * 全部注入:测试以假体替换获得确定性(参照 session-api 时钟注入先例与
 * CLAUDE.md 确定性纪律)。默认实现只依赖浏览器全局(crypto.getRandomValues
 * / performance.now / setTimeout / MessageChannel),零 node 内建依赖。
 */
import {
  EMBED_CAPABILITIES,
  EMBED_PROTOCOL_VERSION,
  MAX_EMBED_HEIGHT_PX,
  type EmbedCapability,
  type EmbedTheme,
} from "@stackmaster/protocol";
import { EmbedInvalidOptionError } from "./errors.js";

/* ------------------------------------------------------------------ */
/* D-API-77 参数默认值与边界                                            */
/* ------------------------------------------------------------------ */

/** T_handshake 默认值(10 s 量级:覆盖慢网下 iframe 加载 + 握手往返)。 */
export const HANDSHAKE_TIMEOUT_MS_DEFAULT = 10000;
export const HANDSHAKE_TIMEOUT_MS_MIN = 3000;
export const HANDSHAKE_TIMEOUT_MS_MAX = 30000;

/** `height_changed` 每秒硬上限默认值(V-10;动画帧级节流的兜底外圈)。 */
export const HEIGHT_CHANGED_MAX_PER_SECOND_DEFAULT = 30;
export const HEIGHT_CHANGED_MAX_PER_SECOND_MIN = 1;
export const HEIGHT_CHANGED_MAX_PER_SECOND_MAX = 120;

/** `theme_changed` / `language_changed` 每秒上限默认值(V-10;宿主自控)。 */
export const CONTROL_MESSAGE_MAX_PER_SECOND_DEFAULT = 10;
export const CONTROL_MESSAGE_MAX_PER_SECOND_MIN = 1;
export const CONTROL_MESSAGE_MAX_PER_SECOND_MAX = 120;

/** `hello` 重试上限默认值(§4.3;插件侧预算,见文件头注释)。 */
export const HELLO_MAX_RETRIES_DEFAULT = 3;
export const HELLO_MAX_RETRIES_MIN = 0;
export const HELLO_MAX_RETRIES_MAX = 10;

/**
 * 宿主支持的嵌入协议版本集(N-1 窗口受理集,V-3 的实现面)。冻结期恒为
 * `[EMBED_PROTOCOL_VERSION]`(与 protocol 包 SUPPORTED_SESSION_ACTION_PROTOCOL_
 * VERSIONS 同款约定);破坏性变更递增版本后在此追加 N-1,并同步版本 → Schema
 * 注册表(embed-session.ts 内)。构造时对"声明了但无对应 Schema 的版本"
 * fail-closed 拒绝装配——宿主不得声明自己无法校验的版本。
 */
export const SUPPORTED_EMBED_PROTOCOL_VERSIONS: readonly number[] = [EMBED_PROTOCOL_VERSION];

/* ------------------------------------------------------------------ */
/* 传输层注入接口                                                       */
/* ------------------------------------------------------------------ */

/** 单调时钟注入(毫秒;测试注入假钟获得确定性)。 */
export type EmbedRuntimeClock = () => number;

/** 定时器注入(T_handshake 超时用;句柄不透明)。 */
export interface EmbedRuntimeScheduler {
  setTimeout(fn: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** CSPRNG 随机字节注入(esid 生成,≥128 bit;默认 crypto.getRandomValues)。 */
export type RandomBytesFn = (size: number) => Uint8Array;

/** 宿主侧 message 事件宿主窗口注入(SDK 在其上监听来自插件的 message)。 */
export interface EmbedRuntimeHostWindow {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
    options?: AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
    options?: EventListenerOptions,
  ): void;
}

/**
 * 目标窗口最小面(iframe.contentWindow 的结构类型):只需 postMessage。
 * 用最小结构而非 DOM Window,使测试可以注入记录型假窗口。
 */
export interface EmbedTargetWindow {
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
}

/** iframe 最小面:实时读取 contentWindow(重载后自动指向新文档窗口)。 */
export interface EmbedIframeLike {
  readonly contentWindow: EmbedTargetWindow | null;
}

/** MessagePort 最小面(SDK 只发送,不接收)。 */
export interface EmbedMessagePortLike {
  postMessage(message: unknown): void;
  close?(): void;
}

/** MessageChannel 最小面(测试注入假通道;默认 new MessageChannel())。 */
export interface EmbedMessageChannelLike {
  readonly port1: EmbedMessagePortLike;
  readonly port2: EmbedMessagePortLike;
}

/* ------------------------------------------------------------------ */
/* 构造选项与解析结果                                                    */
/* ------------------------------------------------------------------ */

/** ready.config 初始外观配置(冻结契约:theme 三值 + BCP-47 language)。 */
export interface EmbedInitialConfig {
  readonly theme: EmbedTheme;
  readonly language: string;
}

/** createEmbedSession 构造选项(宿主侧 SDK 公开参数面)。 */
export interface EmbedSessionOptions {
  /** 预期插件来源(V-1:非 opaque 对端 event.origin 严格相等;宿主自建 iframe 天然已知)。 */
  readonly pluginOrigin: string;
  /** 插件 URL(iframe src 基址;fragment 由 SDK 统一附加,只放 esid——硬门槛)。 */
  readonly pluginUrl: string;
  /** 初始外观配置(随 ready 下发;嵌入协议 §三)。 */
  readonly config: EmbedInitialConfig;
  /** opaque 部署形态(sandbox 无 allow-same-origin)→ V-1' source 绑定代替 V-1。 */
  readonly opaqueOrigin?: boolean;
  /** 宿主支持版本集(N-1 受理集;默认 SUPPORTED_EMBED_PROTOCOL_VERSIONS)。 */
  readonly supportedVersions?: readonly number[];
  /** 宿主愿意授予的能力集(实际授予 = ∩ hello.capabilities,V-8)。默认全部。 */
  readonly grantableCapabilities?: readonly EmbedCapability[];
  /** T_handshake(§4.5 宿主侧超时;默认 10000,clamp 3000–30000)。 */
  readonly handshakeTimeoutMs?: number;
  /** `height_changed` 每秒上限(V-10;默认 30,clamp 1–120)。 */
  readonly heightChangedMaxPerSecond?: number;
  /** 控制消息每秒上限(V-10;默认 10,clamp 1–120)。 */
  readonly controlMessageMaxPerSecond?: number;
  /** `hello` 重试上限(§4.3;默认 3,clamp 0–10;见文件头注释的宿主侧语义)。 */
  readonly helloMaxRetries?: number;
  /** 宿主高度收紧上限(≤ 协议冻结常量,超上限拒绝装配;默认 = 冻结常量)。 */
  readonly maxHeightPx?: number;
  /** 显式指定 esid(默认由注入随机源生成;必须满足 protocol EmbedSessionIdSchema)。 */
  readonly sessionId?: string;
  /* ---- 传输层注入(测试确定性;默认实现见 default* 常量)---- */
  readonly clock?: EmbedRuntimeClock;
  readonly scheduler?: EmbedRuntimeScheduler;
  readonly randomBytes?: RandomBytesFn;
  readonly channelFactory?: () => EmbedMessageChannelLike;
  readonly hostWindow?: EmbedRuntimeHostWindow;
}

/** 解析后的选项(全部字段就位;clamp 与校验已完成)。 */
export interface ResolvedEmbedSessionOptions {
  readonly pluginOrigin: string;
  readonly pluginUrl: string;
  readonly config: EmbedInitialConfig;
  readonly opaqueOrigin: boolean;
  readonly supportedVersions: readonly number[];
  readonly grantableCapabilities: readonly EmbedCapability[];
  readonly handshakeTimeoutMs: number;
  readonly heightChangedMaxPerSecond: number;
  readonly controlMessageMaxPerSecond: number;
  readonly helloMaxRetries: number;
  readonly maxHeightPx: number;
  readonly clock: EmbedRuntimeClock;
  readonly scheduler: EmbedRuntimeScheduler;
  readonly randomBytes: RandomBytesFn;
  readonly channelFactory: () => EmbedMessageChannelLike;
  readonly hostWindow: EmbedRuntimeHostWindow;
}

/* ------------------------------------------------------------------ */
/* clamp / 校验助手                                                     */
/* ------------------------------------------------------------------ */

/** 非负整数校验(非整数 / NaN / 负数 = 装配拒绝;数值语义错误不允许静默纠正)。 */
function requireNonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new EmbedInvalidOptionError(`选项 ${name} 必须为非负整数,收到 ${String(value)}`);
  }
  return value;
}

/** 区间 clamp(越界取边界值;D-API-77 的 clamp 语义)。 */
function clampInteger(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

const defaultClock: EmbedRuntimeClock = () => performance.now();

const defaultScheduler: EmbedRuntimeScheduler = {
  setTimeout: (fn, delayMs) => setTimeout(fn, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

const defaultRandomBytes: RandomBytesFn = (size) => {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef === undefined || typeof cryptoRef.getRandomValues !== "function") {
    throw new EmbedInvalidOptionError(
      "环境缺少 crypto.getRandomValues:esid 是握手认证值(V-5),必须由 CSPRNG 生成;请经 randomBytes 选项注入随机源",
    );
  }
  const out = new Uint8Array(size);
  cryptoRef.getRandomValues(out);
  return out;
};

const defaultChannelFactory = (): EmbedMessageChannelLike => {
  const channelCtor = (globalThis as {
    MessageChannel?: new () => EmbedMessageChannelLike;
  }).MessageChannel;
  if (channelCtor === undefined) {
    throw new EmbedInvalidOptionError(
      "环境缺少 MessageChannel:port 转移路径不可用;请经 channelFactory 选项注入通道工厂",
    );
  }
  return new channelCtor();
};

const defaultHostWindow = (): EmbedRuntimeHostWindow => {
  const win = globalThis as unknown as Partial<EmbedRuntimeHostWindow>;
  if (typeof win.addEventListener !== "function" || typeof win.removeEventListener !== "function") {
    throw new EmbedInvalidOptionError(
      "环境缺少 window message 监听面:请经 hostWindow 选项注入宿主窗口",
    );
  }
  return win as EmbedRuntimeHostWindow;
};

/**
 * 解析并校验构造选项(装配期一次;所有越界 / 语义错误在此抛
 * EmbedInvalidOptionError,不进入运行期静默路径)。
 */
export function resolveEmbedSessionOptions(options: EmbedSessionOptions): ResolvedEmbedSessionOptions {
  if (typeof options.pluginOrigin !== "string" || options.pluginOrigin === "") {
    throw new EmbedInvalidOptionError("选项 pluginOrigin 必须为非空字符串(V-1 预期来源)");
  }
  if (typeof options.pluginUrl !== "string" || options.pluginUrl === "") {
    throw new EmbedInvalidOptionError("选项 pluginUrl 必须为非空字符串(iframe src 基址)");
  }
  if (options.pluginUrl.includes("#")) {
    // fragment 纪律(硬门槛):iframe URL fragment 只放 `#esid=<esid>`——
    // 基址携带自定义 fragment 会破坏 esid 定位,装配期即拒绝。
    throw new EmbedInvalidOptionError("选项 pluginUrl 不得携带 fragment(esid 由 SDK 统一附加)");
  }
  if (typeof options.config?.theme !== "string" || typeof options.config?.language !== "string") {
    throw new EmbedInvalidOptionError("选项 config 必须包含 theme 与 language(ready 初始配置)");
  }

  const handshakeTimeoutMs = clampInteger(
    requireNonNegativeInteger(options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS_DEFAULT, "handshakeTimeoutMs"),
    HANDSHAKE_TIMEOUT_MS_MIN,
    HANDSHAKE_TIMEOUT_MS_MAX,
  );
  const heightChangedMaxPerSecond = clampInteger(
    requireNonNegativeInteger(
      options.heightChangedMaxPerSecond ?? HEIGHT_CHANGED_MAX_PER_SECOND_DEFAULT,
      "heightChangedMaxPerSecond",
    ),
    HEIGHT_CHANGED_MAX_PER_SECOND_MIN,
    HEIGHT_CHANGED_MAX_PER_SECOND_MAX,
  );
  const controlMessageMaxPerSecond = clampInteger(
    requireNonNegativeInteger(
      options.controlMessageMaxPerSecond ?? CONTROL_MESSAGE_MAX_PER_SECOND_DEFAULT,
      "controlMessageMaxPerSecond",
    ),
    CONTROL_MESSAGE_MAX_PER_SECOND_MIN,
    CONTROL_MESSAGE_MAX_PER_SECOND_MAX,
  );
  const helloMaxRetries = clampInteger(
    requireNonNegativeInteger(options.helloMaxRetries ?? HELLO_MAX_RETRIES_DEFAULT, "helloMaxRetries"),
    HELLO_MAX_RETRIES_MIN,
    HELLO_MAX_RETRIES_MAX,
  );

  // maxHeightPx:宿主可收紧、不可放宽——超过协议冻结常量即拒绝装配(D-API-77)。
  const maxHeightPxRaw = requireNonNegativeInteger(
    options.maxHeightPx ?? MAX_EMBED_HEIGHT_PX,
    "maxHeightPx",
  );
  if (maxHeightPxRaw > MAX_EMBED_HEIGHT_PX) {
    throw new EmbedInvalidOptionError(
      `选项 maxHeightPx(${String(maxHeightPxRaw)})超过协议冻结上限 MAX_EMBED_HEIGHT_PX(${String(MAX_EMBED_HEIGHT_PX)}):宿主只可收紧、不可放宽`,
    );
  }

  const supportedVersions = options.supportedVersions ?? SUPPORTED_EMBED_PROTOCOL_VERSIONS;
  if (supportedVersions.length === 0) {
    throw new EmbedInvalidOptionError("选项 supportedVersions 不得为空(V-3 受理集)");
  }
  for (const version of supportedVersions) {
    if (!Number.isInteger(version) || version < 1) {
      throw new EmbedInvalidOptionError(`supportedVersions 含非法版本值 ${String(version)}`);
    }
  }

  const grantableCapabilities = options.grantableCapabilities ?? [...EMBED_CAPABILITIES];
  for (const capability of grantableCapabilities) {
    if (!EMBED_CAPABILITIES.includes(capability)) {
      throw new EmbedInvalidOptionError(`grantableCapabilities 含未知能力 ${String(capability)}`);
    }
  }

  return {
    pluginOrigin: options.pluginOrigin,
    pluginUrl: options.pluginUrl,
    config: { theme: options.config.theme, language: options.config.language },
    opaqueOrigin: options.opaqueOrigin === true,
    supportedVersions: [...supportedVersions],
    grantableCapabilities: [...grantableCapabilities],
    handshakeTimeoutMs,
    heightChangedMaxPerSecond,
    controlMessageMaxPerSecond,
    helloMaxRetries,
    maxHeightPx: maxHeightPxRaw,
    clock: options.clock ?? defaultClock,
    scheduler: options.scheduler ?? defaultScheduler,
    randomBytes: options.randomBytes ?? defaultRandomBytes,
    channelFactory: options.channelFactory ?? defaultChannelFactory,
    hostWindow: options.hostWindow ?? defaultHostWindow(),
  };
}

/**
 * @stackmaster/embed-runtime —— 宿主侧嵌入协议 SDK(阶段五 WP-51;框架无关 core)。
 *
 * 职责(嵌入协议 §三 / §四 / §五;docs/contracts/嵌入协议.md 为实现权威):
 *  - 宿主侧握手状态机(idle → awaiting-hello → ready)与 `T_handshake` 超时、
 *    iframe 重载轮换(新 esid、旧值作废、seq 高水位不继承,§4.5);
 *  - V-1 ~ V-13 逐规则执行:入站校验失败一律「丢弃 + 本地计数」(V-12,
 *    零反馈零中断),违规计数面经 violation-counters-changed 事件可读出;
 *  - 版本协商(max-wins)与能力授予(granted ⊆ hello.capabilities,V-8);
 *  - opaque origin 路径(V-1' source 绑定,不采信 origin === "null")与
 *    MessageChannel port 转移(deliverTokenViaPort:D-API-75 备用通道,
 *    port 转移为凭证交付必需前置,V-13);
 *  - 零业务数据:动作 / 投影 / 错误不经本 SDK(插件 ↔ session-api 认证通道,
 *    嵌入协议 §4.1 注记)。
 *
 * 确定性纪律:时钟 / 随机源 / 调度器 / postMessage 宿主窗口 / MessageChannel
 * 全部经构造选项注入(D-API-77 参数面同在构造选项;协议冻结常量引用
 * @stackmaster/protocol,不重造、不提供放宽入口)。
 *
 * 依赖纪律:浏览器可达包,只依赖 @stackmaster/protocol 公开入口;
 * EmbedTokenClaims 解析器不经本包消费(浏览器对 token 不解析,token 对本
 * SDK 是不透明字符串——deliverTokenViaPort 只搬运不解析)。
 */
export {
  CONTROL_MESSAGE_MAX_PER_SECOND_DEFAULT,
  CONTROL_MESSAGE_MAX_PER_SECOND_MAX,
  CONTROL_MESSAGE_MAX_PER_SECOND_MIN,
  HANDSHAKE_TIMEOUT_MS_DEFAULT,
  HANDSHAKE_TIMEOUT_MS_MAX,
  HANDSHAKE_TIMEOUT_MS_MIN,
  HELLO_MAX_RETRIES_DEFAULT,
  HELLO_MAX_RETRIES_MAX,
  HELLO_MAX_RETRIES_MIN,
  HEIGHT_CHANGED_MAX_PER_SECOND_DEFAULT,
  HEIGHT_CHANGED_MAX_PER_SECOND_MAX,
  HEIGHT_CHANGED_MAX_PER_SECOND_MIN,
  SUPPORTED_EMBED_PROTOCOL_VERSIONS,
  resolveEmbedSessionOptions,
  type EmbedInitialConfig,
  type EmbedIframeLike,
  type EmbedMessageChannelLike,
  type EmbedMessagePortLike,
  type EmbedRuntimeClock,
  type EmbedRuntimeHostWindow,
  type EmbedRuntimeScheduler,
  type EmbedSessionOptions,
  type EmbedTargetWindow,
  type RandomBytesFn,
  type ResolvedEmbedSessionOptions,
} from "./options.js";
export {
  EmbedCapabilityNotGrantedError,
  EmbedInvalidOptionError,
  EmbedPortDeliveryError,
  EmbedRuntimeError,
  EmbedUnavailableError,
} from "./errors.js";
export {
  EMBED_SESSION_EVENTS,
  type EmbedHandshakeCompleteDetail,
  type EmbedHeightChangedDetail,
  type EmbedReloadInitiatedDetail,
  type EmbedSessionState,
  type EmbedSessionUnavailableDetail,
  type EmbedSessionUnavailableReason,
  type EmbedViolationCountersChangedDetail,
} from "./events.js";
export {
  VIOLATION_COUNTER_KEYS,
  ViolationCounters,
  type ViolationCounterKey,
  type ViolationCountersSnapshot,
} from "./counters.js";
export { TypeRateLimiter } from "./rate-limiter.js";
export {
  EMBED_SESSION_ID_RANDOM_BYTES,
  bytesToBase64Url,
  generateEmbedSessionId,
  validateEmbedSessionId,
} from "./session-id.js";
export { negotiateEmbedProtocolVersion } from "./negotiation.js";
export { EMBED_MESSAGE_SCHEMAS, type VersionedEmbedSchema } from "./version-registry.js";
export { EMBED_PORT_CREDENTIAL_KIND, EmbedSession, createEmbedSession } from "./embed-session.js";
export type { EmbedSessionResolvedParameters } from "./embed-session.js";
/* 契约类型再导出(消费方面向本包编程,免直接依赖 protocol 类型面)。 */
export type { EmbedCapability, EmbedMessage, EmbedTheme } from "@stackmaster/protocol";
export {
  EMBED_CAPABILITIES,
  EMBED_HOST_TO_PLUGIN_TYPES,
  EMBED_MESSAGE_TYPES,
  EMBED_PLUGIN_TO_HOST_TYPES,
  EMBED_PROTOCOL_VERSION,
} from "@stackmaster/protocol";

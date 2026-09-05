/**
 * EmbedMessage —— 宿主平台 ↔ iframe 插件 Shell 的 postMessage 消息信封(WP-5)。
 *
 * 承载范围(计划书 8.2):仅加载、主题、语言、自适应高度与生命周期控制,
 * 以及 handshake(初始握手与能力声明)。VM 动作与公开投影**不经**本协议:
 * 它们走浏览器 ↔ 编排器的认证 HTTPS / WSS 通道(6.2),postMessage 的来源
 * 校验不能替代 API 认证与授权(9.2 边界 2)。
 *
 * 信封六字段(8.2 冻结):protocolVersion / type / sessionId / seq /
 * requestId? / payload。整体分类 BOUNDARY:两侧发送内容均为对端输入,
 * 接收端按同一契约重新校验(5.6),不信任发送方类型标注。
 *
 * sessionId 即嵌入会话标识,由宿主以 CSPRNG 生成、经 iframe URL fragment
 * 一次性下发,并兼任 opaque origin 场景的握手认证值(不可预测、一次性;
 * 设计与威胁模型见 docs/contracts/嵌入协议.md §四 / §六)。
 *
 * 消息类型为封闭枚举:拒绝未知类型(8.2);方向由类型唯一决定
 * (EMBED_PLUGIN_TO_HOST_TYPES / EMBED_HOST_TO_PLUGIN_TYPES),接收端必须
 * 拒绝"自己只会发送"的方向(规则 V-6)。扩展消息 = 协议版本演进。
 */
import { z } from "zod";
import { IDENTIFIER_CHARSET_PATTERN, OpaqueIdSchema } from "../common/identifiers.js";
import { OPAQUE_ID_MAX_LENGTH } from "../common/limits.js";
import {
  EMBED_LANGUAGE_MAX_LENGTH,
  MAX_EMBED_CAPABILITIES,
  MAX_EMBED_HEIGHT_PX,
  MAX_EMBED_SUPPORTED_VERSIONS,
} from "../common/limits.js";
import { EMBED_PROTOCOL_VERSION } from "../version.js";

/**
 * 嵌入会话标识熵下限:128-bit CSPRNG 值的 base64url 编码恰为 22 字符。
 * `sessionId` 兼任 opaque origin 场景的握手认证值(知识证明,V-5),
 * 熵下限使"不可预测"从文档要求进入契约层可测面——低于下限的值在 Schema
 * 校验即拒绝,不依赖宿主签发侧自觉(安全审查 M-2 收口)。
 */
export const EMBED_SESSION_ID_MIN_LENGTH = 22;

export const EmbedSessionIdSchema = z
  .string()
  .min(
    EMBED_SESSION_ID_MIN_LENGTH,
    `嵌入会话标识过短:握手认证值至少 ${EMBED_SESSION_ID_MIN_LENGTH} 字符(128-bit CSPRNG 的 base64url 编码)`,
  )
  .max(OPAQUE_ID_MAX_LENGTH, `嵌入会话标识超过最大长度 ${OPAQUE_ID_MAX_LENGTH}`)
  .regex(IDENTIFIER_CHARSET_PATTERN, "嵌入会话标识只允许 A-Z a-z 0-9 下划线与连字符");

/** 全部嵌入消息类型(WP-5 冻结,与计划书 8.2 的承载范围一致)。 */
export const EMBED_MESSAGE_TYPES = [
  "hello",
  "ready",
  "height_changed",
  "theme_changed",
  "language_changed",
] as const;

export type EmbedMessageType = (typeof EMBED_MESSAGE_TYPES)[number];

/** 插件 → 宿主方向的消息类型(接收端方向检查;规则 V-6,docs/contracts/嵌入协议.md §五)。 */
export const EMBED_PLUGIN_TO_HOST_TYPES = ["hello", "height_changed"] as const;

/** 宿主 → 插件方向的消息类型。 */
export const EMBED_HOST_TO_PLUGIN_TYPES = ["ready", "theme_changed", "language_changed"] as const;

export type EmbedPluginToHostType = (typeof EMBED_PLUGIN_TO_HOST_TYPES)[number];
export type EmbedHostToPluginType = (typeof EMBED_HOST_TO_PLUGIN_TYPES)[number];

/** 插件可选能力(封闭枚举;宿主不支持的能力走降级路径,13.3)。 */
export const EMBED_CAPABILITIES = ["theme", "language", "auto_resize"] as const;

export type EmbedCapability = (typeof EMBED_CAPABILITIES)[number];

export const EmbedCapabilitySchema = z.enum(EMBED_CAPABILITIES);

/** 主题取值;`auto` 表示插件跟随自身 `prefers-color-scheme`。 */
export const EMBED_THEMES = ["light", "dark", "auto"] as const;

export type EmbedTheme = (typeof EMBED_THEMES)[number];

export const EmbedThemeSchema = z.enum(EMBED_THEMES);

/**
 * 语言标签:BCP-47 规范语法子集(如 `zh`、`zh-CN`、`en-US`)。
 * 不含私有用语法(`x-…`)、祖传标签与扩展;模式约束与长度上限
 * (EMBED_LANGUAGE_MAX_LENGTH,BCP-47 规范上限)在 TS 与 JSON Schema
 * 两侧使用同一字符串。
 */
export const EMBED_LANGUAGE_PATTERN_SOURCE = "^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$";

const EMBED_LANGUAGE_PATTERN = new RegExp(EMBED_LANGUAGE_PATTERN_SOURCE);

export const EmbedLanguageSchema = z
  .string()
  .min(2)
  .max(EMBED_LANGUAGE_MAX_LENGTH, `语言标签超过 BCP-47 最大长度 ${EMBED_LANGUAGE_MAX_LENGTH}`)
  .regex(EMBED_LANGUAGE_PATTERN, "语言标签不符合 BCP-47 规范语法子集");

/** `hello`(插件 → 宿主):握手起点,携带版本协商候选集与能力声明。 */
export const EmbedHelloPayloadSchema = z.strictObject({
  /** 插件支持的协议版本集合(至少含当前版本);宿主取双方支持的最高版本。 */
  supportedVersions: z
    .array(z.number().int().min(1))
    .min(1)
    .max(MAX_EMBED_SUPPORTED_VERSIONS, `版本候选集超过上限 ${MAX_EMBED_SUPPORTED_VERSIONS}`),
  /** 插件实现的可选能力;宿主经 `ready.grantedCapabilities` 返回其支持子集。 */
  capabilities: z
    .array(EmbedCapabilitySchema)
    .max(MAX_EMBED_CAPABILITIES, `能力声明超过上限 ${MAX_EMBED_CAPABILITIES}`),
});

/** `ready`(宿主 → 插件):握手完成,授予能力并下发初始外观配置。 */
export const EmbedReadyConfigSchema = z.strictObject({
  theme: EmbedThemeSchema,
  language: EmbedLanguageSchema,
});

export const EmbedReadyPayloadSchema = z.strictObject({
  /** 宿主授予的能力子集(⊆ hello.capabilities 语义由接收端重新校验,规则 V-8)。 */
  grantedCapabilities: z
    .array(EmbedCapabilitySchema)
    .max(MAX_EMBED_CAPABILITIES, `能力授予超过上限 ${MAX_EMBED_CAPABILITIES}`),
  config: EmbedReadyConfigSchema,
});

/** `height_changed`(插件 → 宿主):自适应高度(仅授予 auto_resize 后发送)。 */
export const EmbedHeightChangedPayloadSchema = z.strictObject({
  heightPx: z
    .number()
    .int()
    .min(1)
    .max(MAX_EMBED_HEIGHT_PX, `高度超过协议上限 ${MAX_EMBED_HEIGHT_PX}`),
});

/** `theme_changed`(宿主 → 插件):运行中主题切换。 */
export const EmbedThemeChangedPayloadSchema = z.strictObject({ theme: EmbedThemeSchema });

/** `language_changed`(宿主 → 插件):运行中语言切换。 */
export const EmbedLanguageChangedPayloadSchema = z.strictObject({
  language: EmbedLanguageSchema,
});

/**
 * 嵌入消息信封:判别联合使每个分支在 JSON Schema 中携带 `type` 常量与
 * 对应 payload Schema——type ↔ payload 耦合由结构表达,不依赖跨字段 refinement,
 * 保证 TS 与 Rust 校验结论一致(Rust 以 serde + schemars 消费)。
 */
export const EmbedMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    protocolVersion: z.literal(EMBED_PROTOCOL_VERSION),
    type: z.literal("hello"),
    sessionId: EmbedSessionIdSchema,
    /** 发送方会话内严格递增序号,自 1 起;接收端维护高水位拒绝重复与过期(规则 V-7)。 */
    seq: z.number().int().min(1),
    /** 可选请求关联 ID:请求-响应对的消息携带同一值(本版本无强制使用的消息对)。 */
    requestId: OpaqueIdSchema.optional(),
    payload: EmbedHelloPayloadSchema,
  }),
  z.strictObject({
    protocolVersion: z.literal(EMBED_PROTOCOL_VERSION),
    type: z.literal("ready"),
    sessionId: EmbedSessionIdSchema,
    seq: z.number().int().min(1),
    requestId: OpaqueIdSchema.optional(),
    payload: EmbedReadyPayloadSchema,
  }),
  z.strictObject({
    protocolVersion: z.literal(EMBED_PROTOCOL_VERSION),
    type: z.literal("height_changed"),
    sessionId: EmbedSessionIdSchema,
    seq: z.number().int().min(1),
    requestId: OpaqueIdSchema.optional(),
    payload: EmbedHeightChangedPayloadSchema,
  }),
  z.strictObject({
    protocolVersion: z.literal(EMBED_PROTOCOL_VERSION),
    type: z.literal("theme_changed"),
    sessionId: EmbedSessionIdSchema,
    seq: z.number().int().min(1),
    requestId: OpaqueIdSchema.optional(),
    payload: EmbedThemeChangedPayloadSchema,
  }),
  z.strictObject({
    protocolVersion: z.literal(EMBED_PROTOCOL_VERSION),
    type: z.literal("language_changed"),
    sessionId: EmbedSessionIdSchema,
    seq: z.number().int().min(1),
    requestId: OpaqueIdSchema.optional(),
    payload: EmbedLanguageChangedPayloadSchema,
  }),
]);

export type EmbedMessage = z.infer<typeof EmbedMessageSchema>;

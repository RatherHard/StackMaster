/**
 * DebugFrame —— 浏览器 ↔ 编排器调试通道(独立 WSS 端点)的消息传输帧
 * (阶段四 WP-40 冻结;ADR-DC1 条款 1 / 决议 3 / §六 R3)。
 *
 * 通道独立:独立端点、独立协议版本(DEBUG_CHANNEL_PROTOCOL_VERSION,不随
 * 会话动作协议演进)、独立帧族;不复用、不扩展 ActionObjectSchema 的封闭
 * 枚举,既有 WSS 通道(WssFrame / D-API-2)零改动。信封六字段与计划书 8.2
 * 基线同形,连接级版本锚定在调试通道内自建同款:首帧 protocolVersion 即本
 * 连接的解释版本,此后任何帧携带其他版本一律拒绝(语义文档 §四)。
 *
 * 帧类型为 12 值封闭枚举,方向由类型唯一决定(DEBUG_CLIENT_TO_SERVER_TYPES /
 * DEBUG_SERVER_TO_CLIENT_TYPES,接收端方向检查同嵌入协议 V-6 纪律);
 * 扩展 = 调试协议版本演进,心跳走 RFC 6455 协议层 ping/pong,不设应用层
 * 心跳帧(D-API-6 同款)。
 *
 * 展示载荷(debug_window_data / debug_paused / debug_search_results /
 * debug_instruction_stream / debug_function_table 与 debug_attached 对齐态)
 * 值来源 ⊆ 调试变体镜像字节 + 公开代码区 + 玩家输入(封闭集),公开性由
 * 零装载在构造上保证(ADR-DC1 条款 2:调试 worker 不装载真实私有判题包 /
 * 真实种子;分类论证:WP-1 清单 §6.8)。错误帧 = 冻结 PublicError 形态,
 * 16 错误码封闭枚举零扩展;通道级失败(未认证 / 畸形帧 / 频率超限 / 超限额
 * ——限额与解题共用同一每会话预算 D-API-50~53,条款 6)同样只产出该形态。
 *
 * 伪指令流与函数表是服务端生成的**展示数据**,源 = 公开代码区字节,引擎
 * 可执行 IR 不出进程(D5 边界在调试通道同样适用,ADR-DC1 条款 8)。
 */
import { z } from "zod";
import {
  AddressHexSchema,
  BytesHexSchema,
  NonEmptyBytesHexSchema,
} from "../common/hex.js";
import { OpaqueIdSchema } from "../common/identifiers.js";
import {
  DEBUG_FUNCTION_TABLE_MAX_ENTRIES,
  DEBUG_INSTRUCTION_STREAM_MAX_ITEMS,
  DEBUG_MAX_BREAKPOINTS,
  DEBUG_SEARCH_MAX_HITS,
  DEBUG_SEARCH_PATTERN_MAX_BYTES,
  DEBUG_WINDOW_MAX_BYTES,
  MAX_REGION_BYTE_LENGTH,
} from "../common/limits.js";
import { PublicTextSchema } from "../common/public-text.js";
import { PublicErrorSchema } from "../error/public-error.js";
import { PublicStatusSchema } from "../projection/public-status.js";
import { DEBUG_CHANNEL_PROTOCOL_VERSION } from "../version.js";

/** 全部调试通道消息类型(封闭枚举;扩展 = 调试协议版本演进)。 */
export const DEBUG_MESSAGE_TYPES = [
  // 客户端 → 服务端(请求帧,玩家输入回传,服务端按同一契约重新校验)
  "debug_attach",
  "debug_window",
  "debug_step",
  "debug_run_to_breakpoint",
  "debug_search",
  // 服务端 → 客户端(对齐态与展示帧)
  "debug_attached",
  "debug_window_data",
  "debug_paused",
  "debug_search_results",
  "debug_instruction_stream",
  "debug_function_table",
  // 双向通道级错误帧
  "error",
] as const;

export type DebugMessageType = (typeof DEBUG_MESSAGE_TYPES)[number];

/** 客户端 → 服务端方向的消息类型(接收端方向检查;嵌入协议 V-6 同纪律)。 */
export const DEBUG_CLIENT_TO_SERVER_TYPES = [
  "debug_attach",
  "debug_window",
  "debug_step",
  "debug_run_to_breakpoint",
  "debug_search",
] as const;

/** 服务端 → 客户端方向的消息类型。 */
export const DEBUG_SERVER_TO_CLIENT_TYPES = [
  "debug_attached",
  "debug_window_data",
  "debug_paused",
  "debug_search_results",
  "debug_instruction_stream",
  "debug_function_table",
  "error",
] as const;

export type DebugClientToServerType = (typeof DEBUG_CLIENT_TO_SERVER_TYPES)[number];
export type DebugServerToClientType = (typeof DEBUG_SERVER_TO_CLIENT_TYPES)[number];

/** debug_paused 暂停原因(封闭枚举):单步落点 / 断点命中 / 程序自行停机 / 预算耗尽。 */
export const DEBUG_PAUSE_REASONS = ["step", "breakpoint", "program_halt", "budget"] as const;

export type DebugPauseReason = (typeof DEBUG_PAUSE_REASONS)[number];

export const DebugPauseReasonSchema = z.enum(DEBUG_PAUSE_REASONS);

/**
 * debug_window 响应字节:非空偶长 hex;协议上限与 DEBUG_WINDOW_MAX_BYTES
 * 挂钩(当前与 NonEmptyBytesHexSchema 的 4096 字节上限同值,显式再校验使
 * 通道上限成为本帧的自证约束,不依赖 hex 公共 Schema 的巧合同值)。
 */
const WindowBytesHexSchema = NonEmptyBytesHexSchema.max(
  DEBUG_WINDOW_MAX_BYTES * 2,
  `窗口数据超过调试通道上限(${DEBUG_WINDOW_MAX_BYTES} 字节)`,
);

/**
 * debug_search 检索模式:非空偶长 hex(奇数位 hex 在契约层即拒);
 * 上限 DEBUG_SEARCH_PATTERN_MAX_BYTES 字节。
 */
const DebugSearchPatternHexSchema = BytesHexSchema.min(
  2,
  "检索模式至少 1 字节",
).max(
  DEBUG_SEARCH_PATTERN_MAX_BYTES * 2,
  `检索模式超过调试通道上限(${DEBUG_SEARCH_PATTERN_MAX_BYTES} 字节)`,
);

/**
 * debug_attach 起点(互斥二选一,由判别联合以结构表达,不依赖跨字段规则):
 * - `revision`:从动作日志 revision 0 确定性重放到该 revision(含);
 * - `checkpoint`:重放到该 checkpoint 对应的日志位置。
 * attach 后编排器将调试实例重放对齐到起点,再以 debug_attached 回执
 * (语义文档 §四)。禁止真实 checkpoint 快照恢复进调试进程(快照含秘密,
 * ADR-DC1 条款 3)——checkpoint 起点只是日志位置引用,不携带快照字节。
 */
export const DebugAttachOriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("revision"),
    revision: z.number().int().min(0),
  }),
  z.strictObject({
    kind: z.literal("checkpoint"),
    checkpointId: OpaqueIdSchema,
  }),
]);

export type DebugAttachOrigin = z.infer<typeof DebugAttachOriginSchema>;

/** `debug_attach`(客户端 → 服务端):绑定会话并请求重放对齐。 */
export const DebugAttachPayloadSchema = z.strictObject({
  origin: DebugAttachOriginSchema,
});

/** `debug_window`(客户端 → 服务端):任意地址窗口读取(上限 DEBUG_WINDOW_MAX_BYTES)。 */
export const DebugWindowPayloadSchema = z.strictObject({
  addressHex: AddressHexSchema,
  byteLength: z
    .number()
    .int()
    .min(1)
    .max(DEBUG_WINDOW_MAX_BYTES, `窗口超过调试通道上限(${DEBUG_WINDOW_MAX_BYTES} 字节)`),
});

/** `debug_step`(客户端 → 服务端):单步执行恰好一条指令(步数不作自由度暴露)。 */
export const DebugStepPayloadSchema = z.strictObject({});

/** `debug_run_to_breakpoint`(客户端 → 服务端):运行直到命中任一地址断点。 */
export const DebugRunToBreakpointPayloadSchema = z.strictObject({
  breakpoints: z
    .array(AddressHexSchema)
    .min(1, "至少携带 1 个断点地址")
    .max(DEBUG_MAX_BREAKPOINTS, `断点数量超过上限 ${DEBUG_MAX_BREAKPOINTS}`),
});

/** `debug_search`(客户端 → 服务端):全内存字节检索(可选拒绝预算上限)。 */
export const DebugSearchPayloadSchema = z.strictObject({
  patternHex: DebugSearchPatternHexSchema,
  maxHits: z
    .number()
    .int()
    .min(1)
    .max(DEBUG_SEARCH_MAX_HITS, `命中上限超过协议级上限 ${DEBUG_SEARCH_MAX_HITS}`)
    .optional(),
});

/** `debug_attached`(服务端 → 客户端):attach 完成 + 重放对齐后的状态回执。 */
export const DebugAttachedPayloadSchema = z.strictObject({
  /** 对齐后的调试实例 revision(重放进度锚点,与权威会话 revision 语义平行)。 */
  revision: z.number().int().min(0),
  /** 对齐后的调试实例状态(与 PublicStatus 同枚举;won/failed 为调试实例终态)。 */
  status: PublicStatusSchema,
  /** 对齐后处于暂停态时出现:暂停落点的当前指令地址。 */
  paused: z
    .strictObject({
      addressHex: AddressHexSchema,
    })
    .optional(),
});

/** `debug_window_data`(服务端 → 客户端):窗口读取回执(presence-only 截断标记同 DirtyRange)。 */
export const DebugWindowDataPayloadSchema = z.strictObject({
  /** 回执窗口起始地址(请求回显;值来源 ⊆ 变体镜像布局)。 */
  addressHex: AddressHexSchema,
  /** 窗口字节(值来源 ⊆ 调试变体镜像内存,零装载保证公开性)。 */
  bytesHex: WindowBytesHexSchema,
  /**
   * presence-only 截断标记:窗口跨区域边界或触达服务端生效上限时出现,
   * 出现即 true,不含省略字节数(§4.3 DirtyRange 同款)。
   */
  truncated: z.literal(true).optional(),
});

/** `debug_paused`(服务端 → 客户端):执行暂停事件回执。 */
export const DebugPausedPayloadSchema = z.strictObject({
  reason: DebugPauseReasonSchema,
  /** 暂停落点的当前指令地址。 */
  addressHex: AddressHexSchema,
});

/** 检索单命中:命中地址 + 命中处字节回显(与 patternHex 等长,语义文档 §三)。 */
export const DebugSearchHitSchema = z.strictObject({
  addressHex: AddressHexSchema,
  bytesHex: NonEmptyBytesHexSchema,
});

/** `debug_search_results`(服务端 → 客户端):全内存检索回执。 */
export const DebugSearchResultsPayloadSchema = z.strictObject({
  hits: z
    .array(DebugSearchHitSchema)
    .max(DEBUG_SEARCH_MAX_HITS, `命中数超过协议级上限 ${DEBUG_SEARCH_MAX_HITS}`),
  /** presence-only 截断标记:命中数超出上限 / maxHits 预算时出现,不含省略命中数。 */
  truncated: z.literal(true).optional(),
});

/**
 * 伪指令流单条:服务端生成的展示条目——text 为伪汇编展示文本(非可执行 IR,
 * D5),bytesHex? 为该地址处的公开代码区字节,jumpTargetHex? 为跳转目标
 * (pwndbg 式跳转链的承载面;仅控制转移条目出现)。
 */
export const DebugInstructionSchema = z.strictObject({
  addressHex: AddressHexSchema,
  bytesHex: BytesHexSchema.optional(),
  text: PublicTextSchema(),
  jumpTargetHex: AddressHexSchema.optional(),
});

/** `debug_instruction_stream`(服务端 → 客户端):伪指令流批量回执(按需分批拉取)。 */
export const DebugInstructionStreamPayloadSchema = z.strictObject({
  instructions: z.array(DebugInstructionSchema).max(
    DEBUG_INSTRUCTION_STREAM_MAX_ITEMS,
    `指令流批量超过上限 ${DEBUG_INSTRUCTION_STREAM_MAX_ITEMS}`,
  ),
  /** presence-only 截断标记:源代码区还有未携带条目时出现,不含省略条目数。 */
  truncated: z.literal(true).optional(),
});

/** 函数表单条:服务端从公开代码区符号面生成的函数边界与标签。 */
export const DebugFunctionEntrySchema = z.strictObject({
  label: PublicTextSchema(),
  startAddressHex: AddressHexSchema,
  byteLength: z
    .number()
    .int()
    .min(1)
    .max(MAX_REGION_BYTE_LENGTH, `函数字节长度超过协议级上限 ${MAX_REGION_BYTE_LENGTH}`),
});

/** `debug_function_table`(服务端 → 客户端):函数表回执。 */
export const DebugFunctionTablePayloadSchema = z.strictObject({
  functions: z.array(DebugFunctionEntrySchema).max(
    DEBUG_FUNCTION_TABLE_MAX_ENTRIES,
    `函数表超过上限 ${DEBUG_FUNCTION_TABLE_MAX_ENTRIES}`,
  ),
  /** presence-only 截断标记:函数表未全量携带时出现,不含省略条目数。 */
  truncated: z.literal(true).optional(),
});

/**
 * 调试通道信封字段(每分支同形;type ↔ payload 耦合由判别联合结构表达,
 * TS 与 Rust 校验结论一致)。sessionId 帧绑定会话:必须与连接绑定凭证的
 * 会话一致,不一致拒绝(同一 Cookie 凭证模型,复用认证实现)。
 */
const DebugFrameEnvelope = {
  /** 连接级锚定:首帧版本即本连接的解释版本,此后任何帧携带其他版本一律拒绝。 */
  protocolVersion: z.literal(DEBUG_CHANNEL_PROTOCOL_VERSION),
  sessionId: OpaqueIdSchema,
  /** 发送方连接内严格递增(允许跳号);传输层关联与诊断用,非权威序号。 */
  seq: z.number().int().min(1),
  /** 可选发送方关联值;响应对应帧回显同一值(传输层关联)。 */
  requestId: OpaqueIdSchema.optional(),
} as const;

/**
 * 调试通道消息帧判别联合:统一信封六字段(8.2 基线同形),type ↔ payload
 * 耦合由结构表达,TS 与 Rust 校验结论一致(与 EmbedMessage 同形)。
 */
export const DebugFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...DebugFrameEnvelope,
    type: z.literal("debug_attach"),
    payload: DebugAttachPayloadSchema,
  }),
  z.strictObject({
    ...DebugFrameEnvelope,
    type: z.literal("debug_window"),
    payload: DebugWindowPayloadSchema,
  }),
  z.strictObject({
    ...DebugFrameEnvelope,
    type: z.literal("debug_step"),
    payload: DebugStepPayloadSchema,
  }),
  z.strictObject({
    ...DebugFrameEnvelope,
    type: z.literal("debug_run_to_breakpoint"),
    payload: DebugRunToBreakpointPayloadSchema,
  }),
  z.strictObject({
    ...DebugFrameEnvelope,
    type: z.literal("debug_search"),
    payload: DebugSearchPayloadSchema,
  }),
  z.strictObject({
    ...DebugFrameEnvelope,
    type: z.literal("debug_attached"),
    payload: DebugAttachedPayloadSchema,
  }),
  z.strictObject({
    ...DebugFrameEnvelope,
    type: z.literal("debug_window_data"),
    payload: DebugWindowDataPayloadSchema,
  }),
  z.strictObject({
    ...DebugFrameEnvelope,
    type: z.literal("debug_paused"),
    payload: DebugPausedPayloadSchema,
  }),
  z.strictObject({
    ...DebugFrameEnvelope,
    type: z.literal("debug_search_results"),
    payload: DebugSearchResultsPayloadSchema,
  }),
  z.strictObject({
    ...DebugFrameEnvelope,
    type: z.literal("debug_instruction_stream"),
    payload: DebugInstructionStreamPayloadSchema,
  }),
  z.strictObject({
    ...DebugFrameEnvelope,
    type: z.literal("debug_function_table"),
    payload: DebugFunctionTablePayloadSchema,
  }),
  z.strictObject({
    ...DebugFrameEnvelope,
    type: z.literal("error"),
    /** 错误帧 = 冻结 PublicError 形态:16 错误码封闭枚举零扩展(通道面零扩权)。 */
    payload: PublicErrorSchema,
  }),
]);

export type DebugFrame = z.infer<typeof DebugFrameSchema>;

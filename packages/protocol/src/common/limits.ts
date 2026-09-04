/**
 * 协议级资源护栏常量(冻结)。
 *
 * 这些是协议层的硬上限:题目级预算由公开描述包声明(计划书 7.1 公开部分)
 * 且必须 ≤ 协议上限;服务端在执行前按题目预算重新校验(6.2 第 6 条),
 * 超出协议上限的请求在契约校验层即被拒绝,不进入执行。
 *
 * 数值依据见 docs/数据分类与秘密零驻留清单.md 决策 D3/D4 与
 * packages/protocol/docs/会话动作协议语义.md。
 */

/** write_bytes 单动作字节上限(4096 B;与 D3 的投影单策略上限同量级)。 */
export const MAX_WRITE_BYTES = 4096;

/** 每动作 publicEvents 数组长度上限(D4 冻结;超限由服务端确定性聚合)。 */
export const MAX_PUBLIC_EVENTS_PER_ACTION = 256;

/**
 * create_checkpoint 可选标签最大长度(玩家自报内容,BOUNDARY)。
 * 计数口径:按 Unicode code point 计(JSON Schema maxLength 口径);TS 侧 Zod
 * 按 UTF-16 码元计,对增补平面字符只会更严(保守方向),WP-6 golden fixture
 * 不得以增补平面字符断言长度边界。
 */
export const CHECKPOINT_LABEL_MAX_LENGTH = 128;

/**
 * 服务端签发不透明标识符(sessionId / requestId / checkpointId)与客户端幂等键
 * 的最大长度。计数口径同上;字符集约束见 identifiers.ts(语义文档 §2.1)。
 */
export const OPAQUE_ID_MAX_LENGTH = 128;

/* ------------------------------------------------------------------ */
/* 投影与错误契约护栏(WP-3;依据 WP-1 决策 D1–D4 与 §4.2–§4.4)          */
/* ------------------------------------------------------------------ */

/** 调用栈摘要深度上限(D1/D2 冻结:超限截断,截断以 presence-only 标记表达,不含计数)。 */
export const CALL_STACK_MAX_DEPTH = 64;

/** maxBytesPerRange 策略默认值(D3 冻结:256 字节)。 */
export const MAX_BYTES_PER_RANGE_DEFAULT = 256;

/** maxBytesPerRange 单策略上限(D3 冻结:4096 字节;与 MAX_WRITE_BYTES 同值)。 */
export const MAX_BYTES_PER_RANGE_MAX = 4096;

/** 单 revision 投影字节总预算(D3 冻结:8192 字节;超限按地址升序承载并打截断标记)。 */
export const MAX_PROJECTION_BYTES_PER_REVISION = 8192;

/** 单 ProjectionDelta 的 dirtyRanges 数组上限(与每动作公开事件上限同量级的协议护栏)。 */
export const MAX_DIRTY_RANGES_PER_DELTA = 256;

/** 单个公开区域 byteLength 的协议级上限(16 MiB 外圈护栏;区域粒度 4 KiB 倍数与题目级内存预算由题目包校验)。 */
export const MAX_REGION_BYTE_LENGTH = 0x1000000;

/** 投影可见区域数护栏(PublicStateProjection.visibleRegions 与 ProjectionPolicy.visibleRegions 共用)。 */
export const MAX_VISIBLE_REGIONS = 64;

/** ProjectionPolicy.visibleObjects 数组护栏(策略整体 SERVER_ONLY,本值仅为组装期外圈护栏)。 */
export const MAX_VISIBLE_OBJECTS = 64;

/** 投影可见寄存器数护栏(PublicStateProjection.visibleRegisters / changedRegisters / 策略声明集共用;G2/D3.1:32 → 64,与 challenge-schema 上限对齐)。 */
export const MAX_VISIBLE_REGISTERS = 64;

/** 单投影 / 单增量的语义高亮数护栏。 */
export const MAX_SEMANTIC_HIGHLIGHTS = 32;

/**
 * 公开展示文本(区域 label、functionLabel、SemanticHighlight.label、
 * currentInstruction.text)最大长度。计数口径同 CHECKPOINT_LABEL_MAX_LENGTH
 * (JSON Schema maxLength = code point;Zod 按 UTF-16 码元,保守方向)。
 */
export const PUBLIC_TEXT_MAX_LENGTH = 128;

/** PublicError.message 最大长度(E-5:静态模板展开;与 provisional 阶段的 512 一致)。 */
export const ERROR_MESSAGE_MAX_LENGTH = 512;

/** PublicError explanation.hints 单条提示最大长度(静态模板文本)。 */
export const ERROR_HINT_MAX_LENGTH = 256;

/** PublicError explanation.hints 条数上限(教学提示分层:一级原因 + 逐步排查)。 */
export const MAX_ERROR_HINTS = 4;

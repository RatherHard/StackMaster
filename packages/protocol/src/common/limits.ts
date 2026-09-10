/**
 * 协议级资源护栏常量(冻结)。
 *
 * 这些是协议层的硬上限:题目级预算由公开描述包声明(计划书 7.1 公开部分)
 * 且必须 ≤ 协议上限;服务端在执行前按题目预算重新校验(6.2 第 6 条),
 * 超出协议上限的请求在契约校验层即被拒绝,不进入执行。
 *
 * 数值依据见 docs/contracts/数据分类与秘密零驻留清单.md 决策 D3/D4 与
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

/* ------------------------------------------------------------------ */
/* 嵌入协议护栏(WP-5;计划书 8.1 / 8.2)                                */
/* ------------------------------------------------------------------ */

/**
 * 单条嵌入消息的序列化字节上限(64 KiB)。嵌入协议只承载加载、主题、语言、
 * 自适应高度与生命周期控制,不含投影与动作负载——投影走浏览器 ↔ 编排器的
 * 认证通道(8.2),不经 postMessage。接收端在 JSON.parse 前按本值拒绝
 * (校验规则 V-2,docs/contracts/嵌入协议.md §五)。
 */
export const MAX_EMBED_MESSAGE_BYTES = 65536;

/** hello.supportedVersions 数组长度上限(版本协商候选集外圈护栏)。 */
export const MAX_EMBED_SUPPORTED_VERSIONS = 8;

/**
 * 能力声明 / 授予数组长度上限(与冻结枚举 EmbedCapability 的基数一致:
 * theme / language / auto_resize;扩展能力 = 协议版本演进,不靠枚举外预留)。
 */
export const MAX_EMBED_CAPABILITIES = 3;

/** 语言标签最大长度(BCP-47 规范语法上限;模式约束见 embed-message.ts)。 */
export const EMBED_LANGUAGE_MAX_LENGTH = 35;

/**
 * height_changed 携带的高度上限(像素;协议外圈护栏,防止伪造巨型高度值
 * 冲击宿主布局;实际渲染上限由宿主按布局自行收紧)。
 */
export const MAX_EMBED_HEIGHT_PX = 100000;

/**
 * embed token 有效期上限(秒;7 天外圈护栏)。计划书 9.2 要求短期、单用途
 * 或有限次数的 token;具体签发 TTL 属阶段五运维参数,必须 ≤ 本值。
 */
export const MAX_EMBED_TOKEN_TTL_SECONDS = 604800;

/* ------------------------------------------------------------------ */
/* 会话级命令与传输信封护栏(阶段三 WP-0;计划书 8.2 / 8.3 / 9.1)        */
/* ------------------------------------------------------------------ */

/**
 * embed token 签名载体的序列化长度上限(字符)。载体格式(JWT / PASETO /
 * 自有格式)是签发侧实现决策(D-API-3),本值仅为外圈护栏——七字段 claims
 * 加签名的任何紧凑载体都远低于此;token 值禁入 URL query、日志与错误响应
 * (嵌入协议 V-13 / WP-2 传输卫生同纪律)。
 */
export const EMBED_TOKEN_MAX_LENGTH = 4096;

/**
 * 会话凭证(session-api 签发的会话级凭证)有效期上限(秒;24 小时外圈护栏)。
 * 实现推荐 ≤ 会话 wall-clock 预算(3600 s,引擎进程协议装配常量)+ 续期余量;
 * 具体签发 TTL 属阶段三运维参数(D-API-4),必须 ≤ 本值。
 */
export const MAX_SESSION_CREDENTIAL_TTL_SECONDS = 86400;

/**
 * `list_checkpoints` 响应的 checkpoints 数组长度上限(协议外圈护栏)。
 * 每会话 checkpoint 数量的权威预算归编排器配额面(WP-6,与公开
 * `resourceLimits` 对齐),必须 ≤ 本值;超限在契约层即拒绝。
 */
export const MAX_CHECKPOINTS_PER_SESSION = 256;

/**
 * 单条 WSS 消息帧的序列化字节上限(1 MiB 外圈护栏;8.3 请求护栏纪律)。
 * 载荷最坏形态(ActionResponse:8192 B 投影 + 256 条聚合事件)远低于此;
 * 实现侧护栏(WP-5 消息频率与大小限制)必须 ≤ 本值。接收端在 JSON.parse
 * 前按本值拒绝,超限走冻结 `PublicError` 错误帧,零校验器细节透出(基线 #8)。
 */
export const MAX_WSS_FRAME_BYTES = 1048576;

/* ------------------------------------------------------------------ */
/* 调试通道护栏(阶段四 WP-40;ADR-DC1,语义见调试通道协议语义文档)       */
/* ------------------------------------------------------------------ */

/**
 * debug_window 单窗口字节上限(4096 字节,与 D3 的 maxBytesPerRange 单策略
 * 上限 MAX_BYTES_PER_RANGE_MAX 同值同量级)。任意地址窗口仅存在于调试通道
 * (D3 对公开投影维持冻结,ADR-DC1 条款 8);上限是资源护栏,超限在契约层拒绝。
 */
export const DEBUG_WINDOW_MAX_BYTES = 4096;

/** debug_search 检索模式字节上限(模式回显与命中上下文的展示粒度由服务端收紧)。 */
export const DEBUG_SEARCH_PATTERN_MAX_BYTES = 256;

/** debug_run_to_breakpoint.breakpoints 地址数组上限(资源护栏,非自由度限制)。 */
export const DEBUG_MAX_BREAKPOINTS = 64;

/**
 * debug_search_results.hits 数组上限(256,与每动作公开事件上限同量级)。
 * 超限由服务端按地址升序确定性承载至预算耗尽、以 presence-only `truncated`
 * 标记表达(不含省略命中数,§4.3 DirtyRange 同款)。
 */
export const DEBUG_SEARCH_MAX_HITS = 256;

/** debug_instruction_stream.instructions 批量上限(伪指令流按需分批拉取)。 */
export const DEBUG_INSTRUCTION_STREAM_MAX_ITEMS = 256;

/** debug_function_table.functions 条目上限(超限以 presence-only `truncated` 标记表达)。 */
export const DEBUG_FUNCTION_TABLE_MAX_ENTRIES = 256;

/* ------------------------------------------------------------------ */
/* 调试变体镜像护栏(阶段四 WP-40;server-only 契约,ADR-DC1 条款 2/5)    */
/* ------------------------------------------------------------------ */

/** 调试变体镜像 memoryRegions 数组上限(外圈护栏;题目级内存预算归题目包校验)。 */
export const DEBUG_VARIANT_MAX_REGIONS = 64;

/** 调试变体镜像 registers 数组上限(与 challenge-schema 的 MAX_VM_REGISTERS 同值量级)。 */
export const DEBUG_VARIANT_MAX_REGISTERS = 256;

/** 调试变体镜像 canarySlots 数组上限(与区域数护栏同量级)。 */
export const DEBUG_VARIANT_MAX_CANARY_SLOTS = 64;

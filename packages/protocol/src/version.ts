/**
 * 协议版本常量(计划书 5.6:每类契约携带独立版本号)。
 *
 * SESSION_ACTION_PROTOCOL_VERSION 是会话动作协议(ActionRequest / ActionResponse、
 * 12 种动作 args、结果类型)的版本;破坏性变更递增版本并保留 N-1 兼容窗口(5.6)。
 * EMBED_PROTOCOL_VERSION 是嵌入协议(postMessage 信封与 handshake,WP-5)的版本,
 * 与会话动作协议互不重叠;题目包 Schema(WP-4)与引擎进程协议各自独立版本。
 */

/** 会话动作协议当前版本(ActionRequest.protocolVersion 的唯一合法值)。 */
export const SESSION_ACTION_PROTOCOL_VERSION = 1;

/**
 * 当前受理的会话动作协议版本集合(N-1 兼容窗口的实现约定锚点,5.6 / 语义文档 §5.2)。
 *
 * 冻结期恒为 `[SESSION_ACTION_PROTOCOL_VERSION]`;破坏性变更递增版本后,窗口期
 * 在此追加 N-1(如 `[2, 1]`),服务端按路由对各版本以其独立 Schema 双版本受理,
 * 窗口期结束移除旧值。窗口时长为实现期运维参数(权威 API 语义规约 D-API-4),
 * 不属契约面。WSS 传输帧与 REST 命令体共用本集合(传输帧随会话动作协议同一
 * 版本编号演进,D-API-2)。
 */
export const SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS: readonly number[] = [
  SESSION_ACTION_PROTOCOL_VERSION,
];

/**
 * 引擎进程协议当前版本(5.6 第 4 类契约;阶段二 WP-1 登记,版本策略 §二)。
 *
 * 覆盖编排器 / verifier ↔ vm-worker 的进程帧格式与命令信封(语义权威:
 * docs/develop/引擎进程协议.md);投影 / 错误 / 动作 Schema 面仍随
 * SESSION_ACTION_PROTOCOL_VERSION 演进,两者不共用编号空间。worker 启动经
 * ready 帧自报本版本,编排器比对不一致即拒绝建会话(fail-closed)。
 * Rust 侧镜像常量:vm-engine/vm-worker(`protocol::version`),双侧一致性由
 * contract-smoke 机检。
 */
export const ENGINE_PROCESS_PROTOCOL_VERSION = 1;

/** 嵌入协议当前版本(EmbedMessage.protocolVersion 的唯一合法值;WP-5)。 */
export const EMBED_PROTOCOL_VERSION = 1;

/**
 * 会话动作协议 JSON Schema 的 $id 命名空间(仅作标识符,不承诺可解析)。
 * 版本段从协议版本常量派生:破坏性变更递增版本时,$id 目录随之切换。
 */
export const SESSION_ACTION_SCHEMA_BASE_ID = `https://stackmaster.dev/schemas/session-action/v${SESSION_ACTION_PROTOCOL_VERSION}`;

/* ------------------------------------------------------------------ */
/* 裁决呈现通道(阶段六 WP-60;权威 API 语义规约 D-API-83 / D-API-86)      */
/* ------------------------------------------------------------------ */

/**
 * 裁决呈现通道当前版本(阶段六边界裁决 2 候选新契约面 (a) 的版本常量)。
 *
 * 裁决呈现通道是 REST 查询面(`GET /verdicts/:submissionId`,D-API-83)的
 * 响应体契约族:独立于会话动作协议版本演进(与调试通道同款独立编号先例,
 * DEBUG_CHANNEL_PROTOCOL_VERSION)——新契约面按 5.6 携带独立版本号,
 * 破坏性变更递增本常量并保留 N-1 兼容窗口,既有契约面零触碰。
 */
export const VERDICT_CHANNEL_PROTOCOL_VERSION = 1;

/**
 * 当前受理的裁决呈现通道版本集合(N-1 兼容窗口的实现约定锚点)。
 *
 * 约定与 SUPPORTED_DEBUG_CHANNEL_PROTOCOL_VERSIONS 同款:冻结期恒为
 * `[VERDICT_CHANNEL_PROTOCOL_VERSION]`;破坏性变更递增版本后,窗口期在此
 * 追加 N-1,窗口期结束移除旧值。
 */
export const SUPPORTED_VERDICT_CHANNEL_PROTOCOL_VERSIONS: readonly number[] = [
  VERDICT_CHANNEL_PROTOCOL_VERSION,
];

/**
 * 裁决呈现通道 JSON Schema 的 $id 命名空间(仅作标识符,不承诺可解析)。
 * 版本段从裁决呈现通道版本常量派生;响应载荷本身不携带版本字段
 * (沿 SessionCommandResponse 先例:N-1 受理是路由级事实,回显版本判定
 * 细节即扩大探测面;契约版本由本命名空间承载,清单 §6.10)。
 */
export const VERDICT_SCHEMA_BASE_ID = `https://stackmaster.dev/schemas/verdict/v${VERDICT_CHANNEL_PROTOCOL_VERSION}`;

/** 嵌入协议 JSON Schema 的 $id 命名空间(独立于会话动作协议,5.6)。 */
export const EMBED_SCHEMA_BASE_ID = `https://stackmaster.dev/schemas/embed/v${EMBED_PROTOCOL_VERSION}`;

/* ------------------------------------------------------------------ */
/* 调试通道协议(阶段四 WP-40;ADR-DC1 条款 1 / 决议 3 / §六 R3)          */
/* ------------------------------------------------------------------ */

/**
 * 调试通道协议当前版本(DebugFrame.protocolVersion 的唯一合法值)。
 *
 * 调试通道是独立 WSS 端点上的独立协议(ADR-DC1 决议 3 / R3):独立协议版本、
 * 独立帧族,**不随会话动作协议演进**——既有通道的连接级版本锚定(D-API-2,
 * "传输帧随会话动作协议同一版本编号演进、不另设版本常量")只针对既有通道,
 * 其冻结面零改动;调试协议快速迭代不应反复搅动已冻结面,故独立编号。
 * 连接级锚定机制在调试通道内自建同款:首帧版本即本连接的解释版本,此后任何
 * 帧携带其他版本一律拒绝(语义见 docs/调试通道协议语义.md)。
 */
export const DEBUG_CHANNEL_PROTOCOL_VERSION = 1;

/**
 * 当前受理的调试通道协议版本集合(N-1 兼容窗口的实现约定锚点)。
 *
 * 约定与 SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS 同款:冻结期恒为
 * `[DEBUG_CHANNEL_PROTOCOL_VERSION]`;破坏性变更递增版本后,窗口期在此追加
 * N-1(如 `[2, 1]`),窗口期结束移除旧值。
 */
export const SUPPORTED_DEBUG_CHANNEL_PROTOCOL_VERSIONS: readonly number[] = [
  DEBUG_CHANNEL_PROTOCOL_VERSION,
];

/**
 * 调试通道协议 JSON Schema 的 $id 命名空间(仅作标识符,不承诺可解析)。
 * 版本段从调试通道协议版本常量派生;调试通道帧与调试变体镜像
 * (server-only 注册,编排器 ↔ 调试 worker 进程间契约)同属本命名空间。
 */
export const DEBUG_SCHEMA_BASE_ID = `https://stackmaster.dev/schemas/debug/v${DEBUG_CHANNEL_PROTOCOL_VERSION}`;

/** @stackmaster/protocol 包版本(与 package.json 同步;非协议版本)。 */
export const PROTOCOL_PACKAGE_VERSION = "0.1.0";

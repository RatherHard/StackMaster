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

/** 嵌入协议 JSON Schema 的 $id 命名空间(独立于会话动作协议,5.6)。 */
export const EMBED_SCHEMA_BASE_ID = `https://stackmaster.dev/schemas/embed/v${EMBED_PROTOCOL_VERSION}`;

/** @stackmaster/protocol 包版本(与 package.json 同步;非协议版本)。 */
export const PROTOCOL_PACKAGE_VERSION = "0.1.0";

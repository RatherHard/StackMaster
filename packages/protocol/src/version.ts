/**
 * 协议版本常量(计划书 5.6:每类契约携带独立版本号)。
 *
 * SESSION_ACTION_PROTOCOL_VERSION 是会话动作协议(ActionRequest / ActionResponse、
 * 12 种动作 args、结果类型)的版本;破坏性变更递增版本并保留 N-1 兼容窗口(5.6)。
 * 嵌入协议信封(WP-5)、题目包 Schema(WP-4)与引擎进程协议各自独立版本。
 */

/** 会话动作协议当前版本(ActionRequest.protocolVersion 的唯一合法值)。 */
export const SESSION_ACTION_PROTOCOL_VERSION = 1;

/** @stackmaster/protocol 包版本(与 package.json 同步;非协议版本)。 */
export const PROTOCOL_PACKAGE_VERSION = "0.1.0";

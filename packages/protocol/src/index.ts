/**
 * @stackmaster/protocol —— 跨语言契约唯一来源(计划书 5.6、ADR-5)。
 *
 * 本包承载 Zod 契约 → JSON Schema 2020-12 产出管线:嵌入协议、会话动作协议、
 * 引擎进程协议与公开数据类型。JSON Schema 是 TypeScript 与 Rust 的共同权威
 * (Rust 以 serde + schemars 消费),生成产物提交在 schema/ 目录。
 *
 * 已冻结契约:
 * - WP-2 会话动作协议 v1:ActionRequest(12 种动作)、ActionResponse、11 种结果类型;
 *   语义见 docs/会话动作协议语义.md。
 *
 * 待后续 WP 填入:
 * - WP-3 投影与错误契约(projectionDelta / publicEvents / userVisibleError 的
 *   完整 Schema,当前为 src/session-action/provisional.ts 前置声明);
 * - WP-5 嵌入协议消息信封。
 *
 * 依赖纪律(5.5):本包是所有 TS 包唯一可依赖的跨域共享面,自身不得依赖任何
 * 工作区包或 vm-engine 产物(tooling/dependency-cruiser.cjs 强制)。
 * 注意:JSON Schema 生成器(src/schema/generate.ts)依赖 node:fs,
 * 刻意不从本入口导出——浏览器可达包只允许导入本入口。
 */
export * from "./version.js";
export * from "./common/limits.js";
export * from "./common/hex.js";
export * from "./common/identifiers.js";
export * from "./common/classification.js";
export * from "./session-action/action-args.js";
export * from "./session-action/action-object.js";
export * from "./session-action/action-request.js";
export * from "./session-action/action-response.js";
export * from "./session-action/verdict-result.js";
export * from "./session-action/provisional.js";
export * from "./schema/registry.js";

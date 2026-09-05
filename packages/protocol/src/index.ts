/**
 * @stackmaster/protocol —— 跨语言契约唯一来源(计划书 5.6、ADR-5)。
 *
 * 本包承载 Zod 契约 → JSON Schema 2020-12 产出管线:嵌入协议、会话动作协议、
 * 引擎进程协议与公开数据类型。JSON Schema 是 TypeScript 与 Rust 的共同权威
 * (Rust 以 serde + schemars 消费),生成产物提交在 schema/ 目录。
 *
 * 已冻结契约:
 * - WP-2 会话动作协议 v1:ActionRequest(12 种动作)、ActionResponse、11 种结果类型;
 *   语义见 docs/会话动作协议语义.md;
 * - WP-3 投影与错误契约:PublicStateProjection 及其子类型、ProjectionDelta /
 *   DirtyRange、PublicError(16 值错误码 + 逐 code 能力矩阵);
 *   语义见 docs/投影与错误契约语义.md;
 * - WP-5 嵌入协议 v1:EmbedMessage(postMessage 消息信封,5 种消息类型,
 *   握手与能力声明);embed token 绑定字段 EmbedTokenClaims 的**解析器**
 *   不从本入口导出(浏览器对 token 不解析,见 docs/contracts/嵌入协议.md §2.2);
 *   语义见 docs/contracts/嵌入协议.md。
 *
 * server-only 边界(WP-1 §五):ProjectionPolicy(载荷禁下发的 server-only 类型)
 * 与 EmbedTokenClaims(凭证解析器)不从本入口导出,仅经子路径
 * @stackmaster/protocol/server-only 供后端包消费——浏览器可达包导入该子路径
 * 即违规(dependency-cruiser 强制);"Schema 存在不等于可下发"。
 *
 * 依赖纪律(5.5):本包是所有 TS 包唯一可依赖的跨域共享面,自身不得依赖任何
 * 工作区包或 vm-engine 产物(tooling/dependency-cruiser.cjs 强制)。
 * 注意:JSON Schema 生成器(src/schema/generate.ts)依赖 node:fs,
 * 刻意不从本入口导出——浏览器可达包只允许导入本入口。
 */
export * from "./version.js";
export * from "./common/limits.js";
export * from "./common/canonical-json.js";
export * from "./common/hex.js";
export * from "./common/identifiers.js";
export * from "./common/classification.js";
export * from "./common/public-text.js";
export * from "./common/register-name.js";
export * from "./session-action/action-args.js";
export * from "./session-action/action-object.js";
export * from "./session-action/action-request.js";
export * from "./session-action/action-response.js";
export * from "./session-action/verdict-result.js";
export * from "./projection/public-status.js";
export * from "./projection/visible-memory-region.js";
export * from "./projection/public-register.js";
export * from "./projection/public-call-frame.js";
export * from "./projection/public-control-flow.js";
export * from "./projection/semantic-highlight.js";
export * from "./projection/public-event.js";
export * from "./projection/public-state-projection.js";
export * from "./projection/projection-delta.js";
export * from "./error/public-error-code.js";
export * from "./error/public-error.js";
export * from "./embed/embed-message.js";
export * from "./schema/registry.js";

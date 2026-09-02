/**
 * @stackmaster/protocol —— 跨语言契约唯一来源(计划书 5.6、ADR-5)。
 *
 * 本包承载 Zod 契约 → JSON Schema 2020-12 产出管线:嵌入协议、会话动作协议、
 * 引擎进程协议与公开数据类型。JSON Schema 是 TypeScript 与 Rust 的共同权威
 * (Rust 以 serde + schemars 消费)。
 *
 * WP-0 基线占位:契约内容由 WP-2(会话动作协议 v0)、WP-3(投影与错误契约)、
 * WP-5(嵌入协议信封)填入;字段分类与可见性规则见
 * docs/数据分类与秘密零驻留清单.md(`x-sm-class` 标签随 Schema 一并冻结)。
 *
 * 依赖纪律(5.5):本包是所有 TS 包唯一可依赖的跨域共享面,
 * 自身不得依赖任何工作区包或 vm-engine 产物(tooling/dependency-cruiser.cjs 强制)。
 */
export const PROTOCOL_PACKAGE_VERSION = "0.1.0";

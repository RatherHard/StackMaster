//! 跨语言契约冒烟 crate(计划书 5.6;阶段一 WP-6 交付物)。
//!
//! 证明 protocol / challenge-schema 的 JSON Schema 可被 Rust 侧消费
//! (jsonschema 校验 + serde 反序列化 + schemars 镜像),并锁定规范化
//! JSON 序列化(docs/contracts/规范化JSON序列化.md)的双语言一致:
//! TS 生成摘要清单,本 crate 全量复算比对。
//!
//! WP-1 起,规范化序列化(canonical)、严格解析(strict_value)与语义承接
//! (semantic)**提升为引擎模块**(`vm_engine/vm-worker` 的
//! `vm_worker::contract`),本 crate 经路径依赖消费同一实现——消除阶段一
//! 的第二套实现,冒烟从此校验引擎实际使用的代码。

pub use vm_worker::contract::{canonical, semantic, strict_value};

pub mod bundle_builder;
pub mod mirrors;
pub mod smoke;

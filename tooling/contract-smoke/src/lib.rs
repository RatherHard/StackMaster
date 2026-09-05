//! 跨语言契约冒烟 crate(计划书 5.6;阶段一 WP-6 交付物)。
//!
//! 证明 protocol / challenge-schema 的 JSON Schema 可被 Rust 侧消费
//! (jsonschema 校验 + serde 反序列化 + schemars 镜像),并锁定规范化
//! JSON 序列化(docs/规范化JSON序列化.md)的双语言一致:
//! TS 生成摘要清单,本 crate 全量复算比对。

pub mod canonical;
pub mod mirrors;
pub mod semantic;
pub mod smoke;
pub mod strict_value;

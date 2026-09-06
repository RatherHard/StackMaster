//! `vm-worker` 库目标:引擎进程协议(WP-1 冻结面)与 Rust 契约消费面。
//!
//! 交付物结构(docs/develop/引擎进程协议.md 为协议语义权威):
//!
//! - [`contract`]:契约消费面——规范化 JSON 序列化(`stackmaster-canonical-json/1`,
//!   自 tooling/contract-smoke 提升)、严格 JSON 解析(重复键 / 孤立代理项拒绝)、
//!   superRefine 语义承接、冻结 JSON Schema 校验器、serde 类型镜像;
//! - [`protocol`]:进程协议——版本常量、stdio NDJSON 帧层(fail-closed)、
//!   命令信封与 Worker 状态机骨架(引擎面接线归 WP-3 ~ WP-8)。
//!
//! 职责边界:本 crate 是引擎四 crate 中唯一允许 std 的 crate——时钟、随机源
//! 与 stdio 由本进程层实现并注入引擎 crate(引擎三 crate 无 std::time / rand /
//! std::io);`VmState`、私有题目包、隐藏测试与 seed 只存在于本进程内(秘密零驻留)。
#![forbid(unsafe_code)]

pub mod contract;
pub mod protocol;

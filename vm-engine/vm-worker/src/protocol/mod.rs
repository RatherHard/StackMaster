//! 引擎进程协议(WP-1 冻结面;docs/develop/引擎进程协议.md 为语义权威)。
//!
//! - `version`:协议版本常量与帧上限(§二、§三冻结值);
//! - `frame`:stdio NDJSON 帧层——单帧上限、帧边界与半包处理,全部
//!   fail-closed(§三);
//! - `message`:命令 / 响应信封的 serde 形态(§四命令面);
//! - `worker`:Worker 状态机骨架(启动自报 → 装载 → 命令循环 → 关闭;
//!   引擎面接线归 WP-3 ~ WP-8)。

pub mod frame;
pub mod message;
pub mod version;
pub mod worker;

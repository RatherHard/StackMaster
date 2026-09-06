//! `vm-worker` 二进制:单会话进程入口(信任域 3,ADR-7)。
//!
//! 进程边界形态:TS 编排器 spawn 本进程,经 stdio JSON 帧协议通信(ADR-3;
//! 禁止 FFI / N-API 内嵌)。协议命令面、帧格式与 `ENGINE_PROCESS_PROTOCOL_VERSION`
//! 在 WP-1 冻结(docs/develop/引擎进程协议.md)后接线;本文件 WP-0 仅建立
//! 二进制载体与纪律边界。
//!
//! 职责边界:本 crate 是引擎四 crate 中唯一允许 std 的 crate——时钟、随机源
//! 与 stdio 由本进程层实现并注入引擎 crate(引擎三 crate 无 std::time / rand /
//! std::io);`VmState`、私有题目包、隐藏测试与 seed 只存在于本进程内(秘密零驻留)。
#![forbid(unsafe_code)]

fn main() {
    // WP-1 接线引擎进程协议主循环(装载 → 动作 → 快照 / 关闭)。
}

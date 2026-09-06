//! `vm-core`:纯 VM 语义——状态模型、内存 / 寄存器、指令执行、判题语义。
//!
//! 信任域 3(计划书 5.2),仅被 vm-runtime / projection / vm-worker 依赖(5.5)。
//! 本 crate 是"私有题目包 + 动作 → 状态转换 → 脱敏投影"链路中的权威状态转换层,
//! 对上层只暴露纯同步状态机接口;时钟与随机源由 trait 注入(6.3),实现归 vm-worker。
//!
//! # 确定性纪律(ADR-8;CLAUDE.md "Rust 引擎纪律")
//!
//! - `#![no_std]`:结构性禁止 `std::time` / `std::io` / `std::net` / `std::fs`——
//!   这些路径在本 crate 内不可解析(ENG-2;第二层 clippy 禁用清单见
//!   `tooling/engine-lints/clippy.toml`,由 `tooling/check-engine-discipline.mjs` 应用);
//! - `#![forbid(unsafe_code)]`:纯 safe Rust(ENG-1);
//! - 测试代码经 `#[cfg(test)] extern crate std;` 获得测试 harness,不影响生产构建图;
//! - release 构建开启 `overflow-checks`(workspace profile;ENG-3),
//!   溢出触发 panic,由上层按 `engine_error` 安全终止,不静默回绕。
#![no_std]
#![forbid(unsafe_code)]

// 测试 harness(libtest)需要 std;仅测试构建链接,生产图保持无 std。
#[cfg(test)]
extern crate std;

#[cfg(test)]
mod overflow_probe {
    /// ENG-3 运行时反例:release 构建必须开启 overflow-checks。
    ///
    /// 若 workspace profile 缺失 `overflow-checks = true`,本测试在
    /// `cargo test --release` 下因静默回绕而不 panic → 红灯。
    /// black_box 阻止常量折叠,确保溢出发生在运行时。
    #[test]
    #[should_panic(expected = "attempt to add with overflow")]
    fn release_overflow_checks_active() {
        let a = core::hint::black_box(250u8);
        let b = core::hint::black_box(10u8);
        let _ = a + b;
    }
}

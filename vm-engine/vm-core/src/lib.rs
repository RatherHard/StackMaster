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
//! - 堆分配经 `alloc`(BTreeMap / Vec / Box / String):迭代顺序确定(BTreeMap 按键序),
//!   满足 6.3 状态哈希与回放确定性;std 仅经 cfg(test) 属性链接测试 harness,不影响生产图;
//! - release 构建开启 `overflow-checks`(workspace profile;ENG-3),
//!   溢出触发 panic,由上层按 `engine_error` 安全终止,不静默回绕。
//!
//! # WP-3 状态模型与内存 / 寄存器语义(阶段二任务分解)
//!
//! - [`arch`]:archBits ∈ {32, 64} 声明化;架构值 64 位容器承载、高位按位宽掩蔽,
//!   全部算术 / 移位 / 比较在掩蔽域内进行(G1/D1;计划书 6.2);
//! - [`memory`]:VMA 权限模型(r/w/x、六类区域、4KB 倍数)+ 固定大小分页(G3/D2);
//!   读 / 写 / 取指权限检查与统一拒绝路径(I-9);字节模式代码区 W^X(D4.5);
//! - [`registers`]:双命名空间保留模型(一般寄存器自由命名 + `FLAG` 保留区)、
//!   必选核心寄存器 `RSP` / `RBP` / `RIP`、上限 256(G2/D3.1;WP-1 §12.5);
//! - [`state`]:`VmState` 8 字段 Rust 建模,字段集合与 WP-1 冻结表
//!   (`docs/contracts/数据分类与秘密零驻留清单.md` §3.2)一一对应,不增不删;
//!   本类型无 serde 派生、无序列化路径——SERVER_ONLY 类型只有禁令,没有契约(§3.1 规则 1)。
//!
//! 上层 crate 依赖方向:vm-runtime / projection / vm-worker → vm-core(5.5)。
#![no_std]
#![forbid(unsafe_code)]

extern crate alloc;

pub mod arch;
pub mod memory;
pub mod registers;
pub mod state;

// 测试 harness(libtest)需要 std;仅测试构建链接,生产图保持无 std。
#[cfg(test)]
extern crate std;

/// 测试共用:确定性伪随机源(xorshift64*;固定种子可复现,替代 `rand`——
/// ENG-4 禁止随机源 crate,属性测试的"生成"必须由测试内确定性生成器承担)。
#[cfg(test)]
pub(crate) mod testing {
    pub struct Xorshift64Star(u64);

    impl Xorshift64Star {
        pub fn new(seed: u64) -> Self {
            // 零种子是 xorshift 的不动点;混入固定常数避免全零序列。
            Self(seed ^ 0x9E37_79B9_7F4A_7C15)
        }

        pub fn next_u64(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }

        /// `n = 0` 视为取 0(调用方自行避免)。
        pub fn next_below(&mut self, n: u64) -> u64 {
            self.next_u64() % n.max(1)
        }
    }
}

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

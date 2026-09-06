//! `VmState` 状态模型(WP-3;计划书 6.2、`docs/contracts/数据分类与秘密零驻留清单.md`
//! §3.2 冻结表、D1 约束 5)。
//!
//! # 冻结表一一对应(不增不删)
//!
//! | 冻结字段 | 本模块 | 冻结语义要点 |
//! |---|---|---|
//! | `registers` | [`VmState::registers`] | 寄存器全集 → 架构值映射 + FLAG 位([`RegisterFile`]) |
//! | `memory` | [`VmState::memory`] | 分页虚拟内存,VMA 为基本单元([`VirtualMemory`]) |
//! | `callFrames` | [`VmState::call_frames`] | 调用帧内部栈:函数标识、返回地址、saved `RBP`、内部参数 |
//! | `instructionPointer` | [`VmState::instruction_pointer`] | 当前执行位置(archBits 位宽架构值) |
//! | `privateEventLog` | [`VmState::private_event_log`] | 私有事件 append-only 日志,公开事件的全集来源 |
//! | `constraints` | [`VmState::constraints`] | 运行约束权威执行状态(含谓词 / 回退两类本阶段冻结新增预算) |
//! | `seedState` | [`VmState::seed_state`] | 随机源状态:策略、版本、内部状态字节(seed 零驻留) |
//! | `status` | [`VmState::status`] | `running` / `paused` / `won` / `failed`;won/failed 会话终态 |
//!
//! # SERVER_ONLY 归属的两条结构性保证(§3.1)
//!
//! - **无序列化路径**:本 crate 零依赖(ENG-4),`VmState` 及其子类型没有
//!   serde 派生、没有 JSON 形态——契约侧"SERVER_ONLY 类型没有契约,只有禁令"
//!   在类型层面成立;投影下发只经 WP-7 的白名单生成面;
//! - **零驻留**:本类型只在 worker 进程内构造与流转(ADR-7);跨进程只传
//!   WP-1 冻结协议帧,不传状态本体。
//!
//! # 确定性
//!
//! 全部容器(BTreeMap / Vec)迭代有序;状态哈希的规范顺序由此保证;
//! 状态转换是纯同步函数,时钟与随机源由 trait 注入(实现归 vm-worker)。

use alloc::string::String;
use alloc::vec::Vec;

use crate::arch::{ArchBits, ArchValue};
use crate::memory::{ExecutionMode, MemoryConfigError, RegionContents, RegionSpec, VirtualMemory};
use crate::registers::{RegisterError, RegisterFile};

/// 权威 VM 状态机四态(冻结表 `status` 行;公开面 `PublicStatus` 的粗化归 WP-7 / D1)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VmStatus {
    /// 运行中。
    Running,
    /// 已暂停(动作 `pause` / `run_to_event` 触发)。
    Paused,
    /// 已达成目标条件(会话终态)。
    Won,
    /// 已触发失败条件(会话终态)。
    Failed,
}

impl VmStatus {
    /// won / failed 为会话终态(D1 约束 5):终态后不再接受状态变更动作。
    pub fn is_terminal(self) -> bool {
        matches!(self, VmStatus::Won | VmStatus::Failed)
    }
}

/// 调用帧(冻结表 `callFrames` 行:函数标识、返回地址、saved `RBP`、内部参数;
/// 创建 / 销毁语义与 Canary 检测归 WP-4 调用语义)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallFrame {
    /// 函数标识(公开面经 D2 裁剪为 `functionLabel`;来源 = 公开符号表 / 静态模板)。
    pub function_label: String,
    /// 返回地址(archBits 位宽)。
    pub return_address: ArchValue,
    /// saved `RBP`(调用者帧基址)。
    pub saved_rbp: ArchValue,
    /// 内部参数(私有布局信息;不直接公开)。
    pub args: Vec<ArchValue>,
}

/// 私有事件类别(冻结表 `privateEventLog` 行:内部事件、隐藏判定事件、
/// 公开事件的全集来源;公开面六类经 WP-7 白名单过滤后下发,序号 / 条目数
/// 等聚合信息不直接暴露——D4)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VmEventKind {
    /// 读内存。
    Read,
    /// 写内存。
    Write,
    /// 调用。
    Call,
    /// 返回。
    Ret,
    /// 系统调用(封闭单值伪操作 / 作者接口派发)。
    Syscall,
    /// 异常边界。
    Exception,
    /// 内部事件(隐藏判定 / 私有目标条件求值痕迹;永不进入公开面)。
    Internal,
}

/// 私有事件(append-only;结构为引擎内部形态,可随语义演进——冻结表 §3.2 前言)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VmEvent {
    /// 私有事件序号(引擎内单调;公开事件流的独立稠密编号是 WP-7 生成面的另一序列)。
    pub seq: u64,
    /// 事件类别。
    pub kind: VmEventKind,
    /// 相关地址(如有)。
    pub address: Option<ArchValue>,
    /// 相关字节数(如有)。
    pub byte_length: Option<u64>,
    /// 载荷字节(如有;值来源纪律 I-10 由生成侧保证)。
    pub payload: Option<Vec<u8>>,
}

/// 资源预算耗尽(方向 = `resource_limit`;上限值与剩余额由调用方记录)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceLimitError {
    /// 本次请求量。
    pub requested: u64,
    /// 剩余额度。
    pub available: u64,
}

/// 可回退预算:已用 / 上限(`undo` / `reset` 恢复状态时随状态一起回到历史值)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Budget {
    /// 已用量。
    pub used: u64,
    /// 上限(资源护栏)。
    pub limit: u64,
}

impl Budget {
    /// 构造。
    pub fn new(used: u64, limit: u64) -> Self {
        Self { used, limit }
    }

    /// 剩余额度(已用超限的病态状态按 0 计,不再放大)。
    pub fn remaining(&self) -> u64 {
        self.limit.saturating_sub(self.used)
    }

    /// 是否已耗尽。
    pub fn is_exhausted(&self) -> bool {
        self.used >= self.limit
    }

    /// 记账:超限即拒绝(方向 = `resource_limit`)。
    pub fn charge(&mut self, amount: u64) -> Result<(), ResourceLimitError> {
        let available = self.remaining();
        if amount > available {
            return Err(ResourceLimitError {
                requested: amount,
                available,
            });
        }
        self.used += amount;
        Ok(())
    }
}

/// 会话累计预算:跨 `undo` / `reset` **不重置**(冻结表 `constraints` 行;D1 约束 5:
/// 防回退神谕)。独立类型以防止与可回退预算混用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CumulativeBudget {
    /// 已用(会话累计)。
    pub used: u64,
    /// 上限(资源护栏)。
    pub limit: u64,
}

impl CumulativeBudget {
    /// 构造。
    pub fn new(used: u64, limit: u64) -> Self {
        Self { used, limit }
    }

    /// 剩余额度。
    pub fn remaining(&self) -> u64 {
        self.limit.saturating_sub(self.used)
    }

    /// 是否已耗尽。
    pub fn is_exhausted(&self) -> bool {
        self.used >= self.limit
    }

    /// 记账:超限即拒绝(方向 = `resource_limit`)。
    pub fn charge(&mut self, amount: u64) -> Result<(), ResourceLimitError> {
        let available = self.remaining();
        if amount > available {
            return Err(ResourceLimitError {
                requested: amount,
                available,
            });
        }
        self.used += amount;
        Ok(())
    }
}

/// 运行时约束的权威执行状态(冻结表 `constraints` 行,逐项对应;完整下发可帮助
/// 选手把动作顶到限额做探测——公开部分由公开描述包单独声明,不是本字段的投影)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeConstraints {
    /// 执行步数。
    pub steps: Budget,
    /// 内存字节上限(静态护栏)。
    pub memory_bytes_limit: u64,
    /// wall-clock 预算登记(引擎无时钟;实际超时由 worker 进程层执行,WP-8)。
    pub wall_clock_ms_limit: u64,
    /// 调用深度上限。
    pub call_depth_limit: u32,
    /// 动作日志长度。
    pub action_log: Budget,
    /// 输出字节上限。
    pub output_bytes: Budget,
    /// 单动作超时登记(引擎无时钟;worker 进程层执行,WP-8)。
    pub timeout_ms_limit: u64,
    /// 私有谓词求值次数(按会话累计,**跨 undo / reset 不重置**;WP-5 强制执行)。
    pub predicate_evals: CumulativeBudget,
    /// 回退 / 重置次数预算(本阶段冻结新增;D1 约束 5)。
    pub rollback_ops: Budget,
}

/// seed 策略(冻结表 `seedState` 行;策略与 seed 互斥 R5 由契约层保证)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedStrategy {
    /// 固定 seed(私有包 `seedPolicy.seedHex`)。
    Fixed,
    /// 每会话服务端随机(编排器生成、按会话锁定并传入;worker 只消费——
    /// 阶段二风险表裁决;派生路径写回放元数据归 WP-6,不含 seed 值)。
    ServerRandomPerSession,
}

/// 随机源状态(冻结表 `seedState` 行)。
///
/// **seed 零驻留**:种子值与状态字节即随机化秘密本身,只存在于 worker 进程内;
/// 随机数经注入的 rng trait 派生(6.3;trait 注入归 WP-5 / WP-6 接线),
/// 公开面只允许"存在随机化"的事实声明。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedState {
    /// 策略。
    pub strategy: SeedStrategy,
    /// 状态版本(策略元数据;不进公开描述包)。
    pub version: u32,
    /// 内部状态字节(秘密)。
    pub state_bytes: Vec<u8>,
}

/// 状态装配输入(引擎侧类型;worker 装载管线从契约镜像转换而来,WP-8 接线)。
#[derive(Debug, Clone)]
pub struct VmStateConfig {
    /// 架构位宽(公开包 `vmProfile.archBits`,公开常量、单点读取)。
    pub arch: ArchBits,
    /// 执行模式(字节模式触发代码区 W^X,D4.5)。
    pub execution_mode: ExecutionMode,
    /// 页大小(D2 区间)。
    pub page_size: u64,
    /// 内存区域规约。
    pub regions: Vec<RegionSpec>,
    /// 区域初始内容(与区域一一对应)。
    pub region_contents: Vec<RegionContents>,
    /// 初始寄存器(全寄存器,含 FLAG 值)。
    pub registers: Vec<(String, ArchValue)>,
    /// FLAG 声明集(`vmProfile.flagRegisterNames`)。
    pub flag_register_names: Vec<String>,
    /// 初始指令指针。
    pub initial_instruction_pointer: ArchValue,
    /// 运行约束。
    pub constraints: RuntimeConstraints,
    /// 随机源状态。
    pub seed_state: SeedState,
}

/// 状态装配错误(装载管线的状态侧聚合;方向 = challenge_invalid)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateInitError {
    /// 寄存器面拒绝。
    Registers(RegisterError),
    /// 内存面拒绝。
    Memory(MemoryConfigError),
}

/// 权威 VM 状态(冻结表 §3.2 的 8 字段,不增不删;纯后端类型,无序列化路径)。
#[derive(Debug, Clone)]
pub struct VmState {
    /// 寄存器全集 → 架构值映射 + FLAG 位。
    pub registers: RegisterFile,
    /// 分页虚拟内存(VMA 基本单元;COW 快照归 WP-6)。
    pub memory: VirtualMemory,
    /// 调用帧内部栈。
    pub call_frames: Vec<CallFrame>,
    /// 当前执行位置(archBits 位宽架构值)。
    pub instruction_pointer: ArchValue,
    /// 私有事件 append-only 日志(公开事件全集来源)。
    pub private_event_log: Vec<VmEvent>,
    /// 运行约束权威执行状态。
    pub constraints: RuntimeConstraints,
    /// 随机源状态(seed 零驻留)。
    pub seed_state: SeedState,
    /// 权威状态机(won / failed 终态)。
    pub status: VmStatus,
}

impl VmState {
    /// 装配初始状态:寄存器与内存全量校验,其余字段取初值
    /// (调用栈空、事件日志空、`running`)。
    pub fn new(config: VmStateConfig) -> Result<Self, StateInitError> {
        let registers = RegisterFile::new(config.registers, &config.flag_register_names)
            .map_err(StateInitError::Registers)?;
        let memory = VirtualMemory::new(
            config.arch,
            config.page_size,
            config.execution_mode,
            config.regions,
            config.region_contents,
        )
        .map_err(StateInitError::Memory)?;
        Ok(Self {
            registers,
            memory,
            call_frames: Vec::new(),
            instruction_pointer: config.initial_instruction_pointer,
            private_event_log: Vec::new(),
            constraints: config.constraints,
            seed_state: config.seed_state,
            status: VmStatus::Running,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arch::ArchBits;
    use crate::memory::{Permissions, RegionKind};
    use alloc::vec;

    const A32: ArchBits = ArchBits::B32;

    fn constraints() -> RuntimeConstraints {
        RuntimeConstraints {
            steps: Budget::new(0, 1_000_000),
            memory_bytes_limit: 64 * 1024 * 1024,
            wall_clock_ms_limit: 5_000,
            call_depth_limit: 64,
            action_log: Budget::new(0, 10_000),
            output_bytes: Budget::new(0, 4096),
            timeout_ms_limit: 1_000,
            predicate_evals: CumulativeBudget::new(0, 100),
            rollback_ops: Budget::new(0, 200),
        }
    }

    fn seed() -> SeedState {
        SeedState {
            strategy: SeedStrategy::Fixed,
            version: 1,
            state_bytes: vec![0xAA, 0xBB],
        }
    }

    fn config() -> VmStateConfig {
        let regions = vec![
            RegionSpec::new(
                "code",
                RegionKind::Code,
                None,
                0x40_0000,
                4096,
                Permissions::parse("rx").unwrap(),
                A32,
            )
            .unwrap(),
            RegionSpec::new(
                "stack",
                RegionKind::Stack,
                None,
                0x7FFF_F000,
                4096,
                Permissions::parse("rw").unwrap(),
                A32,
            )
            .unwrap(),
        ];
        let contents = vec![
            RegionContents {
                region_id: String::from("code"),
                bytes: vec![0x90, 0xC3],
            },
            RegionContents {
                region_id: String::from("stack"),
                bytes: vec![],
            },
        ];
        let registers = vec![
            (String::from("RSP"), ArchValue::new(0x7FFF_FFF8, A32)),
            (String::from("RBP"), ArchValue::new(0x7FFF_FFF8, A32)),
            (String::from("RIP"), ArchValue::new(0x40_0000, A32)),
            (String::from("FLAG_KEY"), ArchValue::new(0, A32)),
        ];
        VmStateConfig {
            arch: A32,
            execution_mode: ExecutionMode::Ir,
            page_size: 4096,
            regions,
            region_contents: contents,
            registers,
            flag_register_names: vec![String::from("FLAG_KEY")],
            initial_instruction_pointer: ArchValue::new(0x40_0000, A32),
            constraints: constraints(),
            seed_state: seed(),
        }
    }

    /// 冻结表 §3.2 八字段一一对应的见证:逐字段读取一遍(增删字段即编译失败)。
    #[test]
    fn frozen_field_set_is_exactly_eight_fields() {
        let state = VmState::new(config()).unwrap();
        // 1 registers  2 memory  3 callFrames  4 instructionPointer
        let _ = (
            &state.registers,
            &state.memory,
            &state.call_frames,
            &state.instruction_pointer,
        );
        // 5 privateEventLog  6 constraints  7 seedState  8 status
        let _ = (
            &state.private_event_log,
            &state.constraints,
            &state.seed_state,
            &state.status,
        );
        // 初始形态:栈空、日志空、running;核心寄存器与 IP 就位。
        assert!(state.call_frames.is_empty());
        assert!(state.private_event_log.is_empty());
        assert_eq!(state.status, VmStatus::Running);
        assert_eq!(state.instruction_pointer.get(), 0x40_0000);
        assert_eq!(state.registers.rsp().unwrap().get(), 0x7FFF_FFF8);
        assert_eq!(
            state.memory.region_by_id("code").unwrap().kind,
            RegionKind::Code
        );
        assert_eq!(state.seed_state.strategy, SeedStrategy::Fixed);
    }

    #[test]
    fn assemble_propagates_register_and_memory_rejections() {
        // 寄存器面:缺 FLAG 初始值。
        let mut bad = config();
        bad.registers.retain(|(name, _)| name != "FLAG_KEY");
        assert!(matches!(
            VmState::new(bad),
            Err(StateInitError::Registers(RegisterError::MissingFlagValue(
                _
            )))
        ));
        // 内存面:W^X(字节模式可写代码区)。
        let mut bad = config();
        bad.execution_mode = ExecutionMode::ByteCode;
        bad.regions[0].permissions = Permissions::parse("rwx").unwrap();
        assert!(matches!(
            VmState::new(bad),
            Err(StateInitError::Memory(
                MemoryConfigError::CodeWritableInByteMode { .. }
            ))
        ));
    }

    #[test]
    fn status_terminality_matches_d1_constraint5() {
        assert!(!VmStatus::Running.is_terminal());
        assert!(!VmStatus::Paused.is_terminal());
        assert!(VmStatus::Won.is_terminal());
        assert!(VmStatus::Failed.is_terminal());
    }

    #[test]
    fn budget_charge_boundary() {
        let mut b = Budget::new(0, 10);
        assert!(b.charge(10).is_ok());
        assert!(b.is_exhausted());
        assert_eq!(b.remaining(), 0);
        assert_eq!(
            b.charge(1),
            Err(ResourceLimitError {
                requested: 1,
                available: 0
            })
        );
        // 恰好到限即成功,超 1 即拒绝。
        let mut c = Budget::new(8, 10);
        assert!(c.charge(2).is_ok());
        assert_eq!(
            c.charge(1),
            Err(ResourceLimitError {
                requested: 1,
                available: 0
            })
        );
    }

    #[test]
    fn cumulative_budget_has_no_reset_path() {
        // 类型系统承载"跨 undo/reset 不重置":VmState 状态回退由 WP-6 快照实现,
        // 快照恢复不得触碰 CumulativeBudget——此处验证其记账行为与语义文档一致。
        let mut p = CumulativeBudget::new(98, 100);
        assert!(p.charge(2).is_ok());
        assert_eq!(
            p.charge(1),
            Err(ResourceLimitError {
                requested: 1,
                available: 0
            })
        );
        assert_eq!(p.used, 100);
    }

    #[test]
    fn event_log_is_append_only_in_shape() {
        let mut state = VmState::new(config()).unwrap();
        state.private_event_log.push(VmEvent {
            seq: 0,
            kind: VmEventKind::Write,
            address: Some(ArchValue::new(0x7FFF_FFF8, A32)),
            byte_length: Some(4),
            payload: Some(vec![1, 2, 3, 4]),
        });
        state.private_event_log.push(VmEvent {
            seq: 1,
            kind: VmEventKind::Internal,
            address: None,
            byte_length: None,
            payload: None,
        });
        assert_eq!(state.private_event_log.len(), 2);
        assert_eq!(state.private_event_log[0].kind, VmEventKind::Write);
        assert_eq!(state.private_event_log[1].kind, VmEventKind::Internal);
    }

    #[test]
    fn runtime_constraints_field_correspondence() {
        // 冻结表 constraints 行逐项:步数 / 内存 / wall-clock / 调用深度 /
        // 动作日志长度 / 输出上限 / 超时 / 谓词求值累计 / 回退重置预算。
        let c = constraints();
        assert_eq!(c.steps.limit, 1_000_000);
        assert_eq!(c.memory_bytes_limit, 64 * 1024 * 1024);
        assert_eq!(c.wall_clock_ms_limit, 5_000);
        assert_eq!(c.call_depth_limit, 64);
        assert_eq!(c.action_log.limit, 10_000);
        assert_eq!(c.output_bytes.limit, 4096);
        assert_eq!(c.timeout_ms_limit, 1_000);
        assert_eq!(c.predicate_evals.limit, 100);
        assert_eq!(c.rollback_ops.limit, 200);
    }

    #[test]
    fn seed_state_stays_private_by_shape() {
        // SeedState 无序列化路径;状态字节只经引擎内部字段流转。
        let s = seed();
        assert_eq!(s.strategy, SeedStrategy::Fixed);
        assert_eq!(s.version, 1);
        assert_eq!(s.state_bytes, vec![0xAA, 0xBB]);
        let s2 = SeedState {
            strategy: SeedStrategy::ServerRandomPerSession,
            version: 1,
            state_bytes: vec![0x11; 32],
        };
        assert_ne!(s, s2);
    }

    /// 32 / 64 双位宽行为矩阵(完成标准):同一逻辑状态装配在两位宽下,
    /// 掩蔽域算术、内存读写、小端访问、栈顶行为全部按各自位宽正确执行。
    #[test]
    fn full_state_behavior_matrix_at_both_widths() {
        for (arch, stack_top, stack_base) in [
            // 32 位:栈区 [0x7FFF_F000, 0x7FFF_FFFF],栈顶 0x7FFF_FFF8。
            (ArchBits::B32, 0x7FFF_FFF8u64, 0x7FFF_F000u64),
            // 64 位:栈区 [2^63 − 4096, 2^63 − 1],栈顶 2^63 − 8。
            (
                ArchBits::B64,
                0x7FFF_FFFF_FFFF_FFF8u64,
                0x7FFF_FFFF_FFFF_F000u64,
            ),
        ] {
            let stack_len = 4096u64;
            let regions = vec![
                RegionSpec::new(
                    "stack",
                    RegionKind::Stack,
                    None,
                    stack_base,
                    stack_len,
                    Permissions::parse("rw").unwrap(),
                    arch,
                )
                .unwrap(),
            ];
            let cfg = VmStateConfig {
                arch,
                execution_mode: ExecutionMode::Ir,
                page_size: 4096,
                regions,
                region_contents: vec![RegionContents {
                    region_id: String::from("stack"),
                    bytes: vec![],
                }],
                registers: vec![
                    (String::from("RSP"), ArchValue::new(stack_top, arch)),
                    (String::from("RBP"), ArchValue::new(stack_top, arch)),
                    (String::from("RIP"), ArchValue::new(0x40, arch)),
                ],
                flag_register_names: vec![],
                initial_instruction_pointer: ArchValue::new(0x40, arch),
                constraints: constraints(),
                seed_state: seed(),
            };
            let mut state = VmState::new(cfg).unwrap();
            // 掩蔽域算术经状态寄存器:push 语义(栈指针下移 8)+ 小端落盘。
            let qword = ArchValue::new(0x0123_4567_89AB_CDEF, arch);
            let new_rsp = state
                .registers
                .rsp()
                .unwrap()
                .sub(ArchValue::new(8, arch), arch);
            state.registers.set("RSP", new_rsp).unwrap();
            state.memory.write_le(new_rsp, qword, 8).unwrap();
            // 读回一致(64 位值在 32 位架构下被掩蔽为低 32 位)。
            let back = state.memory.read_le(new_rsp, 8, arch).unwrap();
            assert_eq!(back, ArchValue::new(0x0123_4567_89AB_CDEF, arch));
            // pop 语义:恢复栈指针。
            let popped = state
                .registers
                .rsp()
                .unwrap()
                .add(ArchValue::new(8, arch), arch);
            state.registers.set("RSP", popped).unwrap();
            assert_eq!(state.registers.rsp().unwrap().get(), stack_top);
            // 末字节访问合法,越出即统一拒绝(两位宽各自的地址域)。
            assert!(
                state
                    .memory
                    .check(
                        ArchValue::new(stack_base + stack_len - 1, arch),
                        1,
                        crate::memory::PermKind::Write
                    )
                    .is_ok()
            );
            assert!(
                state
                    .memory
                    .check(
                        ArchValue::new(stack_base + stack_len, arch),
                        1,
                        crate::memory::PermKind::Write
                    )
                    .is_err()
            );
        }
    }
}

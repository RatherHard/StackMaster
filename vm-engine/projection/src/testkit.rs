//! 测试装置(cfg(test);差分测试套件与模块测试共用的最小教学题目装配)。
//!
//! fixture 布局(32 位 IR 模式;秘密与 seed 由变体注入,**永不入 git**——
//! 差分测试的秘密是合成字节,不是真实题目内容):
//!
//! ```text
//! code   @ 0x0040_0000  4096  r-x  可见(代码区,MVP 恒公开)
//! buffer @ 0x2000_0000  4096  rw-  可见(教学缓冲区)
//! gate   @ 0x2100_0000  4096  r--  可见(只读面:教学性失败 permission_denied)
//! secret @ 0x5000_0000  4096  rw-  隐藏(秘密汇:长度 / 内容变体的注入点)
//! stack  @ 0x7FFF_F000  4096  rw-  可见
//! 寄存器:RSP / RBP / RIP(核心)+ RAX(可见)+ RKEY(秘密汇,隐藏)+ FLAG_K(FLAG 保留区)
//! ```

use alloc::borrow::ToOwned;
use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;

use vm_core::arch::{ArchBits, ArchValue};
use vm_core::exec::Engine;
use vm_core::instr::{BaselineOp, Instruction, Operand, Program};
use vm_core::memory::{ExecutionMode, Permissions, RegionContents, RegionKind, RegionSpec};
use vm_core::state::{SeedState, SeedStrategy, VmStateConfig};

use crate::policy::{ErrorDetailLevel, ProjectionPolicy, ProjectionPolicySpec, SecretSinkSet};
use crate::project::{GenerationView, HighlightDeclaration, ProjectionStatics};

pub(crate) const A32: ArchBits = ArchBits::B32;

pub(crate) const CODE_BASE: u64 = 0x0040_0000;
pub(crate) const BUFFER_BASE: u64 = 0x2000_0000;
pub(crate) const GATE_BASE: u64 = 0x2100_0000;
pub(crate) const SECRET_BASE: u64 = 0x5000_0000;
pub(crate) const STACK_BASE: u64 = 0x7FFF_F000;
pub(crate) const STACK_TOP: u64 = 0x7FFF_FFF8;
pub(crate) const PAGE: u64 = 4096;

/// 级别变体策略(差分套件的 coarse / educational 双级别)。
pub(crate) fn policy_with_level(level: ErrorDetailLevel) -> ProjectionPolicy {
    ProjectionPolicy::assemble(
        ProjectionPolicySpec {
            visible_regions: vec![
                String::from("code"),
                String::from("buffer"),
                String::from("gate"),
                String::from("stack"),
            ],
            visible_objects: Vec::new(),
            visible_registers: vec![String::from("RAX"), String::from("RSP")],
            max_bytes_per_range: None,
            error_detail_level: level,
        },
        // 秘密汇:RKEY(显式声明)+ FLAG_K(FLAG 命名初始寄存器)。
        &SecretSinkSet::new(vec![String::from("RKEY"), String::from("FLAG_K")]),
    )
    .expect("fixture 策略装配")
}

pub(crate) fn statics() -> ProjectionStatics {
    ProjectionStatics::assemble(
        vec![
            (String::from("code"), String::from("代码区")),
            (String::from("buffer"), String::from("教学缓冲区")),
            (String::from("gate"), String::from("只读数据")),
            (String::from("stack"), String::from("栈")),
        ],
        vec![HighlightDeclaration {
            kind: crate::types::HighlightKind::BufferStart,
            target_region_id: String::from("buffer"),
            start: BUFFER_BASE,
            byte_length: 8,
            label: String::from("缓冲区起点"),
        }],
    )
    .expect("fixture 静态声明面装配")
}

pub(crate) fn program() -> Program {
    Program::Ir {
        instructions: vec![
            Instruction {
                op: vm_core::instr::Op::Baseline(BaselineOp::Mov),
                operands: vec![
                    Operand::Register(String::from("RAX")),
                    Operand::Immediate(ArchValue::new(0x41, A32)),
                ],
            },
            // 内存写指令(run_to_event(Write) 的暂停锚;写入可见栈区)。
            Instruction {
                op: vm_core::instr::Op::Baseline(BaselineOp::Mov),
                operands: vec![
                    Operand::Memory {
                        base: Some(String::from("RSP")),
                        // -8 的 32 位补码形态(掩蔽域容器承载)。
                        displacement: ArchValue::new(0xFFFF_FFF8, A32),
                    },
                    Operand::Register(String::from("RAX")),
                ],
            },
            // 第 3 条:call 的返回落点(index 2,ret 合法性依赖其存在)。
            Instruction {
                op: vm_core::instr::Op::Baseline(BaselineOp::Mov),
                operands: vec![
                    Operand::Register(String::from("RAX")),
                    Operand::Register(String::from("RAX")),
                ],
            },
        ],
        entrypoint_index: 0,
    }
}

/// 秘密区内容:合成秘密字节(变体注入点)+ 零填充到区域长度的装载内容形态。
fn secret_content(secret: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::from(secret);
    bytes.resize(PAGE as usize, 0);
    bytes
}

/// 引擎装配(秘密 / seed / 布局变体注入;见 `PROBE_ADDR` 布局说明)。
pub(crate) fn build_engine(secret: &[u8], seed: &[u8], hidden_mapped: bool) -> Engine {
    let secret_base = if hidden_mapped {
        SECRET_BASE
    } else {
        SECRET_ALT_BASE
    };
    let regions = vec![
        RegionSpec::new(
            "code",
            RegionKind::Code,
            None,
            CODE_BASE,
            PAGE,
            Permissions::parse("rx").unwrap(),
            A32,
        )
        .unwrap(),
        RegionSpec::new(
            "buffer",
            RegionKind::Heap,
            None,
            BUFFER_BASE,
            PAGE,
            Permissions::parse("rw").unwrap(),
            A32,
        )
        .unwrap(),
        RegionSpec::new(
            "gate",
            RegionKind::Global,
            None,
            GATE_BASE,
            PAGE,
            Permissions::parse("r").unwrap(),
            A32,
        )
        .unwrap(),
        RegionSpec::new(
            "secret",
            RegionKind::Key,
            None,
            secret_base,
            PAGE,
            Permissions::parse("rw").unwrap(),
            A32,
        )
        .unwrap(),
        RegionSpec::new(
            "stack",
            RegionKind::Stack,
            None,
            STACK_BASE,
            PAGE,
            Permissions::parse("rw").unwrap(),
            A32,
        )
        .unwrap(),
    ];
    let config = VmStateConfig {
        arch: A32,
        execution_mode: ExecutionMode::Ir,
        page_size: PAGE,
        regions,
        region_contents: vec![
            RegionContents {
                region_id: String::from("code"),
                bytes: vec![0u8; PAGE as usize],
            },
            RegionContents {
                region_id: String::from("buffer"),
                bytes: vec![0u8; PAGE as usize],
            },
            RegionContents {
                region_id: String::from("gate"),
                bytes: vec![0u8; PAGE as usize],
            },
            RegionContents {
                region_id: String::from("secret"),
                bytes: secret_content(secret),
            },
            RegionContents {
                region_id: String::from("stack"),
                bytes: vec![0u8; PAGE as usize],
            },
        ],
        registers: vec![
            (String::from("RSP"), ArchValue::new(STACK_TOP, A32)),
            (String::from("RBP"), ArchValue::new(STACK_TOP, A32)),
            (String::from("RIP"), ArchValue::new(0, A32)),
            (String::from("RAX"), ArchValue::new(0, A32)),
            // 秘密汇寄存器:预置值含秘密派生字节(差分测试的注入面)。
            (String::from("RKEY"), ArchValue::new(0, A32)),
            (String::from("FLAG_K"), ArchValue::new(0, A32)),
        ],
        flag_register_names: vec![String::from("FLAG_K")],
        initial_instruction_pointer: ArchValue::new(0, A32),
        constraints: vm_core::state::RuntimeConstraints {
            steps: vm_core::state::Budget::new(0, 1_000_000),
            memory_bytes_limit: 64 * 1024 * 1024,
            wall_clock_ms_limit: 5_000,
            call_depth_limit: 64,
            action_log: vm_core::state::Budget::new(0, 10_000),
            output_bytes: vm_core::state::Budget::new(0, 4096),
            timeout_ms_limit: 1_000,
            predicate_evals: vm_core::state::CumulativeBudget::new(0, 100),
            rollback_ops: vm_core::state::Budget::new(0, 200),
        },
        seed_state: SeedState {
            strategy: SeedStrategy::Fixed,
            version: 1,
            state_bytes: seed.to_owned(),
        },
    };
    Engine::new(vm_core::exec::EngineConfig {
        state: config,
        program: program(),
        custom_instructions: Vec::new(),
        interfaces: Vec::new(),
        canary_slots: Vec::new(),
    })
    .expect("fixture 引擎装配")
}

/// 生成视图(引擎字段装配;借用生命周期由调用方锚定)。
pub(crate) fn view_for<'a>(
    policy: &'a ProjectionPolicy,
    statics: &'a ProjectionStatics,
    engine: &'a Engine,
    pause_reason: Option<crate::types::PauseKind>,
) -> GenerationView<'a> {
    GenerationView {
        policy,
        statics,
        program: engine.program(),
        customs: engine.custom_instructions(),
        pause_reason,
    }
}

/// 布局变体:I-9 探针的双布局——`hidden_mapped = true` 时秘密区在
/// 0x5000_0000(隐藏映射);false 时秘密区移至 0x6000_0000,探针地址下方
/// **未映射**。两布局除秘密区位置外完全一致(探针地址、其余区域不变)。
pub(crate) const PROBE_ADDR: u64 = 0x5000_0000;
pub(crate) const SECRET_ALT_BASE: u64 = 0x6000_0000;

/// 泄漏扫描(语料法兜底,ZR-B1 同法):响应文本中是否出现秘密字节的
/// 十六进制形态(小写 bytesHex 域 / 大写 valueHex 域)。true = 检出泄漏。
pub(crate) fn leak_detected(responses: &[String], secret: &[u8]) -> bool {
    let lower = crate::canon::hex_encode_lower(secret);
    let mut upper = String::from("0x");
    for byte in secret {
        upper.push(b"0123456789ABCDEF"[(byte >> 4) as usize] as char);
        upper.push(b"0123456789ABCDEF"[(byte & 0xF) as usize] as char);
    }
    responses
        .iter()
        .any(|text| text.contains(&lower) || text.contains(&upper))
}

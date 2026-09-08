#![allow(dead_code)] // 共用装配器按测试目标取用,允许未用项
//! 集成测试共用装配器:确定性测试引擎(IR 程序:一步装载 RAX,两步后
//! `syscall exit(0)`)、判题驱动(可配置成功条件)、身份与回放上下文。
//!
//! ENG-4 禁止随机源 crate:一切"变体"由测试内确定性生成器承担。

use std::string::String;
use std::vec;
use std::vec::Vec;

#[allow(dead_code)] // 变体生成器按测试需要取用
/// 确定性伪随机源(xorshift64*;固定种子可复现)。
pub struct Xorshift64Star(u64);

#[allow(dead_code)]
impl Xorshift64Star {
    pub fn new(seed: u64) -> Self {
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
}

use vm_core::arch::{ArchBits, ArchValue};
use vm_core::exec::{CanarySlotSpec, Engine, EngineConfig};
use vm_core::instr::{BaselineOp, Instruction, Op, Operand, Program};
use vm_core::judge::Judge;
use vm_core::judge::predicate::ConditionL1;
use vm_core::judge::spec::{JudgingConfigLimits, JudgingContext, JudgingSpec};
use vm_core::memory::{ExecutionMode, Permissions, RegionContents, RegionKind, RegionSpec};
use vm_core::state::{
    Budget, CumulativeBudget, RuntimeConstraints, SeedState, SeedStrategy, VmStateConfig,
};
use vm_runtime::action_log::{ReplayContext, SeedReplayMeta};
use vm_runtime::identity::EngineIdentity;
use vm_runtime::runtime::{SessionConfig, SessionRuntime};

pub const A32: ArchBits = ArchBits::B32;
pub const STACK_BASE: u64 = 0x7FFF_F000;
pub const SCRATCH_BASE: u64 = 0x3000_0000;
pub const CODE_BASE: u64 = 0x40_0000;

/// IR 程序:`mov RAX, I` → `syscall exit(0)`(首步装载,次步终止)。
pub fn test_program(load_value: u64) -> Program {
    Program::Ir {
        instructions: vec![
            Instruction {
                op: Op::Baseline(BaselineOp::Mov),
                operands: vec![
                    Operand::Register(String::from("RAX")),
                    Operand::Immediate(ArchValue::new(load_value, A32)),
                ],
            },
            Instruction {
                op: Op::Baseline(BaselineOp::Syscall),
                operands: vec![Operand::Immediate(ArchValue::new(0, A32))],
            },
        ],
        entrypoint_index: 0,
    }
}

/// 测试引擎:code(rx)/ stack(rw,栈顶载荷)/ scratch(w)。
pub fn build_engine() -> Engine {
    build_engine_with_constraints(test_constraints())
}

/// 指定约束装配(资源上限专项测试用)。
pub fn build_engine_with_constraints(constraints: RuntimeConstraints) -> Engine {
    let regions = vec![
        RegionSpec::new(
            "code",
            RegionKind::Code,
            None,
            CODE_BASE,
            4096,
            Permissions::parse("rx").unwrap(),
            A32,
        )
        .unwrap(),
        RegionSpec::new(
            "stack",
            RegionKind::Stack,
            None,
            STACK_BASE,
            4096,
            Permissions::parse("rw").unwrap(),
            A32,
        )
        .unwrap(),
        RegionSpec::new(
            "scratch",
            RegionKind::Custom,
            Some("scratch"),
            SCRATCH_BASE,
            4096,
            Permissions::parse("w").unwrap(),
            A32,
        )
        .unwrap(),
    ];
    let mut stack_bytes = vec![0u8; 4096];
    stack_bytes[0x100..0x104].copy_from_slice(&[0x11, 0x22, 0x33, 0x44]);
    let contents = vec![
        RegionContents {
            region_id: String::from("code"),
            bytes: vec![],
        },
        RegionContents {
            region_id: String::from("stack"),
            bytes: stack_bytes,
        },
        RegionContents {
            region_id: String::from("scratch"),
            bytes: vec![],
        },
    ];
    let config = VmStateConfig {
        arch: A32,
        execution_mode: ExecutionMode::Ir,
        page_size: 4096,
        regions,
        region_contents: contents,
        registers: vec![
            (String::from("RSP"), ArchValue::new(STACK_BASE + 0x100, A32)),
            (String::from("RBP"), ArchValue::new(STACK_BASE + 0x100, A32)),
            // IR 模式:instructionPointer = 指令索引(编译产物直读)。
            (String::from("RIP"), ArchValue::new(0, A32)),
            (String::from("RAX"), ArchValue::new(0, A32)),
            (String::from("FLAG_KEY"), ArchValue::new(0, A32)),
        ],
        flag_register_names: vec![String::from("FLAG_KEY")],
        initial_instruction_pointer: ArchValue::new(0, A32),
        constraints,
        seed_state: SeedState {
            strategy: SeedStrategy::Fixed,
            version: 1,
            state_bytes: vec![0xAA, 0xBB, 0xCC, 0xDD, 0x11, 0x22, 0x33, 0x44],
        },
    };
    Engine::new(EngineConfig {
        state: config,
        program: test_program(0x11),
        custom_instructions: vec![],
        interfaces: vec![],
        canary_slots: Vec::<CanarySlotSpec>::new(),
    })
    .expect("测试引擎装配必须成功")
}

/// 测试约束(预算充裕;专项测试按需收窄)。
pub fn test_constraints() -> RuntimeConstraints {
    RuntimeConstraints {
        steps: Budget::new(0, 100_000),
        memory_bytes_limit: 64 * 1024 * 1024,
        wall_clock_ms_limit: 5_000,
        call_depth_limit: 64,
        action_log: Budget::new(0, 512),
        output_bytes: Budget::new(0, 4096),
        timeout_ms_limit: 1_000,
        predicate_evals: CumulativeBudget::new(0, 100_000),
        rollback_ops: Budget::new(0, 64),
    }
}

/// 空判题面(成功恒假;全动作允许)。
pub fn vacuous_spec() -> JudgingSpec {
    JudgingSpec {
        success_condition: ConditionL1::vacuous_false(),
        failure_conditions: vec![],
        stages: vec![],
        hidden_tests: vec![],
        limits: JudgingConfigLimits {
            max_predicate_eval_steps: 100_000,
        },
    }
}

/// 装配判题驱动。
pub fn build_judge(engine: &mut Engine) -> Judge {
    build_judge_with(vacuous_spec(), engine)
}

/// 指定判题面装配。
pub fn build_judge_with(spec: JudgingSpec, engine: &mut Engine) -> Judge {
    let context = JudgingContext {
        virtual_file_ids: vec![],
        input_sink: None,
    };
    Judge::assemble(spec, &context, engine).expect("测试判题面装配必须成功")
}

/// 测试身份(自报面)。
pub fn identity() -> EngineIdentity {
    EngineIdentity {
        vm_engine_version: String::from("0.1.0"),
        engine_build_id: String::from("test-build"),
    }
}

/// 测试回放上下文(记录项 #1–#5;arch 32)。
pub fn context() -> ReplayContext {
    ReplayContext {
        challenge_id: String::from("stack-overflow-101"),
        challenge_content_version: String::from("1.0.0"),
        vm_profile_version: String::from("1.0.0"),
        vm_engine_version: String::from("0.1.0"),
        engine_build_id: String::from("test-build"),
        verdict_rule_version: String::from("1.0.0"),
        challenge_bundle_hash: "ab".repeat(32),
        vm_profile_hash: "cd".repeat(32),
        arch_bits: 32,
        seed_policy: SeedReplayMeta {
            strategy: String::from("fixed"),
            derivation: None,
        },
    }
}

/// 按默认约束组装完整会话。
pub fn build_runtime() -> SessionRuntime {
    build_runtime_with(vacuous_spec(), test_constraints())
}

/// 按指定判题面与约束组装完整会话。
pub fn build_runtime_with(spec: JudgingSpec, constraints: RuntimeConstraints) -> SessionRuntime {
    let mut engine = build_engine_with_constraints(constraints);
    let judge = build_judge_with(spec, &mut engine);
    SessionRuntime::new(SessionConfig {
        identity: identity(),
        context: context(),
        engine,
        judge,
    })
    .expect("测试会话装配必须成功")
}

/// 回放装配器(每次全新引擎 + 判题;确定性装配)。
pub fn fresh_config() -> SessionConfig {
    let mut engine = build_engine();
    let judge = build_judge(&mut engine);
    SessionConfig {
        identity: identity(),
        context: context(),
        engine,
        judge,
    }
}

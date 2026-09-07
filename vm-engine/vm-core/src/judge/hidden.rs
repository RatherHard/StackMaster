//! 隐藏测试执行驱动(WP-5;7 值可达判定分类器 + (输入, 预期判定) 对执行)。
//! 语义规约:`docs/develop/判题语义规约.md` §七(D-H1 / D-H2)。
//!
//! 隐藏测试是(输入, 预期判定)对(WP-1 §12.3),不是条件表达式;正式裁决
//! (11 值结果类型)归阶段六 verifier——本模块交付 verifier 复用的执行语义:
//! 判定细节(谓词内容、隐藏测试结果)只写 Internal 私有事件,公开面只有结果类型。

use alloc::string::String;
use alloc::vec::Vec;

use crate::exec::{Engine, ExecError, RunOutcome};
use crate::judge::predicate::{evaluate_l1, predicate_count};
use crate::judge::spec::{HiddenTestSpec, JudgingContext, JudgingSpec};
use crate::state::{VmEvent, VmEventKind};

/// 隐藏测试类别(Schema `hiddenTests[].kind` 镜像)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HiddenTestKind {
    /// 参考载荷:载荷写入输入槽后运行至程序终止(规约 §七)。
    ReferencePayload,
    /// 谓词探针:不应用载荷,在基线上直接求值 `successCondition`。
    PredicateProbe,
}

impl HiddenTestKind {
    /// 协议字符串形态。
    pub fn as_str(self) -> &'static str {
        match self {
            HiddenTestKind::ReferencePayload => "reference_payload",
            HiddenTestKind::PredicateProbe => "predicate_probe",
        }
    }

    /// 协议字符串 → 枚举。
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "reference_payload" => Some(HiddenTestKind::ReferencePayload),
            "predicate_probe" => Some(HiddenTestKind::PredicateProbe),
            _ => None,
        }
    }
}

/// 可达判定枚举(7 值;`hiddenTests[].expectedResult` 的词汇面。
/// `challenge_invalid` / `replay_mismatch` / `cancelled` / `engine_error`
/// 非可授权期望,D6)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerdictKind {
    /// 隐藏测试与目标条件全部通过。
    Success,
    /// 提交 / 重放结果不满足目标条件。
    WrongAnswer,
    /// 输入动作本身违规(如载荷写入被拒)。
    InvalidAction,
    /// VM 程序崩溃(教学语义:invalid_rip / 未声明派发 / Canary 破坏)。
    ProgramCrash,
    /// 内存访问违规。
    MemoryFault,
    /// 步数等预算超限。
    ResourceLimit,
    /// wall-clock 超时(引擎无时钟;worker 看门狗补充,分类器不产生)。
    Timeout,
}

impl VerdictKind {
    /// 协议字符串形态(与 `verdict-result` Schema 枚举对齐)。
    pub fn as_str(self) -> &'static str {
        match self {
            VerdictKind::Success => "success",
            VerdictKind::WrongAnswer => "wrong_answer",
            VerdictKind::InvalidAction => "invalid_action",
            VerdictKind::ProgramCrash => "program_crash",
            VerdictKind::MemoryFault => "memory_fault",
            VerdictKind::ResourceLimit => "resource_limit",
            VerdictKind::Timeout => "timeout",
        }
    }

    /// 协议字符串 → 枚举。
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "success" => VerdictKind::Success,
            "wrong_answer" => VerdictKind::WrongAnswer,
            "invalid_action" => VerdictKind::InvalidAction,
            "program_crash" => VerdictKind::ProgramCrash,
            "memory_fault" => VerdictKind::MemoryFault,
            "resource_limit" => VerdictKind::ResourceLimit,
            "timeout" => VerdictKind::Timeout,
            _ => return None,
        })
    }

    /// 内部事件载荷的判别值(规约 §1.5;仅引擎内部使用)。
    fn tag(self) -> u8 {
        match self {
            VerdictKind::Success => 1,
            VerdictKind::WrongAnswer => 2,
            VerdictKind::InvalidAction => 3,
            VerdictKind::ProgramCrash => 4,
            VerdictKind::MemoryFault => 5,
            VerdictKind::ResourceLimit => 6,
            VerdictKind::Timeout => 7,
        }
    }
}

/// 隐藏测试驱动错误(方向 = challenge_invalid 的预算语义,同规约 §1.3)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HiddenTestError {
    /// 谓词求值次数预算耗尽(分类器复核成功条件的记账)。
    PredicateBudgetExhausted {
        /// 本次请求量。
        requested: u64,
        /// 剩余额度。
        available: u64,
    },
}

/// 单个隐藏测试的执行结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HiddenTestOutcome {
    /// 测试声明序。
    pub test_index: usize,
    /// 测试标识。
    pub test_id: String,
    /// 实际判定。
    pub verdict: VerdictKind,
    /// 与 `expectedResult` 是否一致。
    pub passed: bool,
}

/// 执行全部隐藏测试(规约 §七):基线 = 传入引擎当前状态;每个测试从同一基线的
/// 独立克隆出发,互不影响;基线只追加 Internal 事件与判题预算记账。
pub fn run_hidden_tests(
    spec: &JudgingSpec,
    context: &JudgingContext,
    engine: &mut Engine,
) -> Result<Vec<HiddenTestOutcome>, HiddenTestError> {
    let mut outcomes = Vec::with_capacity(spec.hidden_tests.len());
    for (test_index, test) in spec.hidden_tests.iter().enumerate() {
        let verdict = run_one(spec, context, engine, test)?;
        let passed = verdict == test.expected;
        log_test_result(engine, test_index, verdict, passed);
        outcomes.push(HiddenTestOutcome {
            test_index,
            test_id: test.test_id.clone(),
            verdict,
            passed,
        });
    }
    Ok(outcomes)
}

fn run_one(
    spec: &JudgingSpec,
    context: &JudgingContext,
    engine: &mut Engine,
    test: &HiddenTestSpec,
) -> Result<VerdictKind, HiddenTestError> {
    match test.kind {
        HiddenTestKind::PredicateProbe => {
            // 基线直接求值成功条件(预算记入基线,规约 §1.3)。
            charge_baseline(engine, predicate_count(&spec.success_condition))?;
            let met = evaluate_l1(engine, &spec.success_condition).unwrap_or(false);
            Ok(if met {
                VerdictKind::Success
            } else {
                VerdictKind::WrongAnswer
            })
        }
        HiddenTestKind::ReferencePayload => {
            let mut clone = engine.clone();
            if !test.payload.is_empty() {
                // 装配已保证输入槽存在;写入被拒 = 输入动作违规(invalid_action)。
                let sink = context.input_sink.expect("装配复验已保证输入槽存在");
                if clone.action_write_bytes(sink, &test.payload).is_err() {
                    return Ok(VerdictKind::InvalidAction);
                }
            }
            // 运行至程序终止;非 halted 而步数预算耗尽 ⇒ resource_limit。
            let mut outcome = RunOutcome::Stepped;
            while matches!(outcome, RunOutcome::Stepped) {
                if clone.is_halted() {
                    outcome = RunOutcome::Halted;
                    break;
                }
                if clone.state.constraints.steps.remaining() == 0 {
                    return Ok(VerdictKind::ResourceLimit);
                }
                outcome = clone.step();
            }
            classify_outcome(outcome, spec, &clone, engine)
        }
    }
}

/// 结局分类(规约 §七表):异常面映射 WP-4 方向注释的对偶;正常终止在
/// **克隆终态**上复核成功条件(载荷效果的判定基准),记账落基线。
fn classify_outcome(
    outcome: RunOutcome,
    spec: &JudgingSpec,
    clone: &Engine,
    baseline: &mut Engine,
) -> Result<VerdictKind, HiddenTestError> {
    match outcome {
        RunOutcome::Failed { error } => Ok(match error {
            ExecError::MemoryFault(_) => VerdictKind::MemoryFault,
            ExecError::ResourceLimit(_) => VerdictKind::ResourceLimit,
            ExecError::InvalidRip { .. }
            | ExecError::InvalidSyscallDispatch { .. }
            | ExecError::CanaryViolation { .. }
            | ExecError::InvariantBroken(_) => VerdictKind::ProgramCrash,
        }),
        // 正常终止(exit / 已停 / 步尽而程序已停):在克隆终态上复核成功条件。
        RunOutcome::Exited { .. }
        | RunOutcome::Halted
        | RunOutcome::Stepped
        | RunOutcome::Paused { .. } => {
            charge_baseline(baseline, predicate_count(&spec.success_condition))?;
            let met = evaluate_l1(clone, &spec.success_condition).unwrap_or(false);
            Ok(if met {
                VerdictKind::Success
            } else {
                VerdictKind::WrongAnswer
            })
        }
    }
}

/// 基线引擎的谓词预算记账(克隆上的求值不计入克隆——克隆即丢弃;
/// 判定复核的记账落基线,规约 §七)。
fn charge_baseline(engine: &mut Engine, amount: u64) -> Result<(), HiddenTestError> {
    engine
        .state
        .constraints
        .predicate_evals
        .charge(amount)
        .map_err(|e| HiddenTestError::PredicateBudgetExhausted {
            requested: e.requested,
            available: e.available,
        })
}

fn log_test_result(engine: &mut Engine, test_index: usize, verdict: VerdictKind, passed: bool) {
    let seq = engine.state.private_event_log.len() as u64;
    let index_bytes = (test_index as u32).to_le_bytes();
    let mut payload = Vec::with_capacity(7);
    payload.push(0x05);
    payload.extend_from_slice(&index_bytes);
    payload.push(verdict.tag());
    payload.push(u8::from(passed));
    engine.state.private_event_log.push(VmEvent {
        seq,
        kind: VmEventKind::Internal,
        address: None,
        byte_length: None,
        payload: Some(payload),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arch::ArchValue;
    use crate::instr::{Instruction, Op, Operand, Program};
    use crate::judge::predicate::{ConditionL1, Predicate};
    use crate::judge::spec::HiddenTestSpec;
    use crate::judge::spec::tests::{
        A32, base_engine, engine_with_regions, file_context, vacuous_spec,
    };
    use crate::memory::{Permissions, RegionKind, RegionSpec};
    use alloc::string::ToString;

    fn v(raw: u64) -> ArchValue {
        ArchValue::new(raw, A32)
    }

    fn test_spec(
        id: &str,
        kind: HiddenTestKind,
        payload: &[u8],
        expected: VerdictKind,
    ) -> HiddenTestSpec {
        HiddenTestSpec {
            test_id: id.to_string(),
            kind,
            payload: payload.to_vec(),
            expected,
        }
    }

    fn spec_with(success: ConditionL1, tests: Vec<HiddenTestSpec>) -> JudgingSpec {
        let mut spec = vacuous_spec();
        spec.success_condition = success;
        spec.hidden_tests = tests;
        spec
    }

    fn success_on_rax(value: u64) -> ConditionL1 {
        ConditionL1::of(Predicate::RegisterEquals {
            register: String::from("RAX"),
            value: v(value),
        })
    }

    /// verdict 分类器矩阵:异常面 × 复核条件的全部可达结局。
    #[test]
    fn verdict_classifier_matrix() {
        // ① exit + 条件真(克隆终态 RAX=0)⇒ success;② 条件假 ⇒ wrong_answer。
        let spec = spec_with(success_on_rax(0), alloc::vec![]);
        let mut engine = engine_with_regions(); // 程序 = syscall exit(0)
        let mut clone = engine.clone();
        let outcome = clone.step(); // Exited{0}
        assert_eq!(
            classify_outcome(outcome, &spec, &clone, &mut engine).unwrap(),
            VerdictKind::Success
        );
        let spec_false = spec_with(success_on_rax(0xFFFF), alloc::vec![]);
        let mut engine = engine_with_regions();
        let mut clone = engine.clone();
        let outcome = clone.step();
        assert_eq!(
            classify_outcome(outcome, &spec_false, &clone, &mut engine).unwrap(),
            VerdictKind::WrongAnswer
        );
        // ③ invalid_rip ⇒ program_crash(单 mov 程序执行后越界取指)。
        let regions = single_region_set("stack");
        let program = Program::Ir {
            instructions: alloc::vec![Instruction {
                op: Op::Baseline(crate::instr::BaselineOp::Mov),
                operands: alloc::vec![
                    Operand::Register(String::from("RAX")),
                    Operand::Immediate(v(1)),
                ],
            }],
            entrypoint_index: 0,
        };
        let crasher = base_engine(regions, alloc::vec![0u8; 4096], program, 0);
        let mut baseline = crasher.clone();
        let mut clone = crasher;
        clone.step(); // mov
        let spec = spec_with(success_on_rax(1), alloc::vec![]);
        let outcome = clone.step(); // ip=1 越界取指 → invalid_rip
        assert_eq!(
            classify_outcome(outcome, &spec, &clone, &mut baseline).unwrap(),
            VerdictKind::ProgramCrash
        );
        // ④ 运行期数据访问违规(MemoryFault)⇒ memory_fault:经
        //    Failed{MemoryFault} 归类(动作级写入失败归 invalid_action,见下)。
    }

    fn single_region_set(region_id: &str) -> Vec<RegionSpec> {
        alloc::vec![
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
                region_id,
                RegionKind::Stack,
                None,
                0x7FFF_F000,
                4096,
                Permissions::parse("rw").unwrap(),
                A32,
            )
            .unwrap(),
        ]
    }

    /// reference_payload 全流程(隔离):载荷写入输入槽 → 运行 → 分类 → 比对,
    /// 基线状态不动(仅 Internal 事件与预算)。
    #[test]
    fn reference_payload_flow_isolated() {
        // 程序 = mov RAX, 0x2E; syscall exit —— payload 修栈不改寄存器,期望 success。
        let regions = single_region_set("stack");
        let program = Program::Ir {
            instructions: alloc::vec![
                Instruction {
                    op: Op::Baseline(crate::instr::BaselineOp::Mov),
                    operands: alloc::vec![
                        Operand::Register(String::from("RAX")),
                        Operand::Immediate(v(0x2E)),
                    ],
                },
                Instruction {
                    op: Op::Baseline(crate::instr::BaselineOp::Syscall),
                    operands: alloc::vec![Operand::Immediate(v(0))],
                },
            ],
            entrypoint_index: 0,
        };
        let mut engine = base_engine(regions, alloc::vec![0u8; 4096], program, 0);
        let spec = spec_with(
            success_on_rax(0x2E),
            alloc::vec![test_spec(
                "t-ref",
                HiddenTestKind::ReferencePayload,
                &[0xAA, 0xBB],
                VerdictKind::Success,
            )],
        );
        let log_len_before = engine.state.private_event_log.len();
        let budget_before = engine.state.constraints.predicate_evals.used;
        let ip_before = engine.state.instruction_pointer;
        let outcomes = run_hidden_tests(&spec, &file_context(), &mut engine).unwrap();
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].verdict, VerdictKind::Success);
        assert!(outcomes[0].passed);
        // 基线隔离:执行位置与内存不动,事件日志恰增 1 条 Internal。
        assert_eq!(engine.state.instruction_pointer, ip_before);
        assert_eq!(engine.state.private_event_log.len(), log_len_before + 1);
        assert!(
            engine.state.constraints.predicate_evals.used > budget_before,
            "分类器复核成功条件须记入基线预算"
        );
    }

    /// 输入槽写入被拒(越权地址)⇒ invalid_action。
    #[test]
    fn payload_write_rejection_is_invalid_action() {
        let mut engine = engine_with_regions();
        let context = JudgingContext {
            virtual_file_ids: file_context().virtual_file_ids,
            // 落在只读代码区:write_bytes 动作被统一拒绝路径拒绝。
            input_sink: Some(v(0x40_0000)),
        };
        let spec = spec_with(
            ConditionL1::vacuous_true(),
            alloc::vec![test_spec(
                "t-bad",
                HiddenTestKind::ReferencePayload,
                &[0x1],
                VerdictKind::InvalidAction,
            )],
        );
        let outcomes = run_hidden_tests(&spec, &context, &mut engine).unwrap();
        assert_eq!(outcomes[0].verdict, VerdictKind::InvalidAction);
        assert!(outcomes[0].passed);
    }

    /// 预算耗尽 ⇒ resource_limit(克隆步数预算 = 0)。
    #[test]
    fn exhausted_step_budget_is_resource_limit() {
        let regions = single_region_set("stack");
        let program = Program::Ir {
            instructions: alloc::vec![Instruction {
                op: Op::Baseline(crate::instr::BaselineOp::Mov),
                operands: alloc::vec![
                    Operand::Register(String::from("RAX")),
                    Operand::Immediate(v(1)),
                ],
            }],
            entrypoint_index: 0,
        };
        let mut engine = base_engine(regions, alloc::vec![0u8; 4096], program, 0);
        engine.state.constraints.steps = crate::state::Budget::new(0, 0);
        let spec = spec_with(
            ConditionL1::vacuous_true(),
            alloc::vec![test_spec(
                "t-zero",
                HiddenTestKind::ReferencePayload,
                &[],
                VerdictKind::ResourceLimit,
            )],
        );
        let outcomes = run_hidden_tests(&spec, &file_context(), &mut engine).unwrap();
        assert_eq!(outcomes[0].verdict, VerdictKind::ResourceLimit);
        assert!(outcomes[0].passed);
    }

    /// predicate_probe:直接求值成功条件;假 ⇒ wrong_answer。
    #[test]
    fn predicate_probe_flow() {
        let mut engine = engine_with_regions();
        let spec = spec_with(
            success_on_rax(0xFFFF),
            alloc::vec![test_spec(
                "t-probe",
                HiddenTestKind::PredicateProbe,
                &[],
                VerdictKind::WrongAnswer,
            )],
        );
        let outcomes = run_hidden_tests(&spec, &file_context(), &mut engine).unwrap();
        assert_eq!(outcomes[0].verdict, VerdictKind::WrongAnswer);
        assert!(outcomes[0].passed);
    }

    /// 结果只入 Internal 私有事件:载荷形态 = 标签 + 索引 + verdict 判别值 + 通过位。
    #[test]
    fn results_only_in_internal_events() {
        let mut engine = engine_with_regions();
        let spec = spec_with(
            ConditionL1::vacuous_true(),
            alloc::vec![
                test_spec(
                    "t-a",
                    HiddenTestKind::PredicateProbe,
                    &[],
                    VerdictKind::Success
                ),
                test_spec(
                    "t-b",
                    HiddenTestKind::PredicateProbe,
                    &[],
                    VerdictKind::Success
                ),
            ],
        );
        let outcomes = run_hidden_tests(&spec, &file_context(), &mut engine).unwrap();
        assert!(outcomes.iter().all(|o| o.passed));
        let internal: Vec<&VmEvent> = engine
            .state
            .private_event_log
            .iter()
            .filter(|e| e.kind == VmEventKind::Internal)
            .collect();
        assert_eq!(internal.len(), 2);
        assert_eq!(
            internal[0].payload.as_deref(),
            Some(&[0x05, 0, 0, 0, 0, 1, 1][..])
        );
        assert_eq!(
            internal[1].payload.as_deref(),
            Some(&[0x05, 1, 0, 0, 0, 1, 1][..])
        );
    }

    /// 隐藏测试驱动的基线谓词预算耗尽 ⇒ challenge_invalid 方向上抛。
    #[test]
    fn hidden_test_budget_exhaustion() {
        let mut engine = engine_with_regions();
        // 基线预算压到恰不够一次复核(probe 复核 1 谓词)。
        engine.state.constraints.predicate_evals = crate::state::CumulativeBudget::new(0, 0);
        let spec = spec_with(
            success_on_rax(0),
            alloc::vec![test_spec(
                "t-x",
                HiddenTestKind::PredicateProbe,
                &[],
                VerdictKind::Success,
            )],
        );
        assert_eq!(
            run_hidden_tests(&spec, &file_context(), &mut engine),
            Err(HiddenTestError::PredicateBudgetExhausted {
                requested: 1,
                available: 0
            })
        );
    }

    /// 词汇面:kind 与 verdict 的协议字符串往返。
    #[test]
    fn vocabulary_roundtrip() {
        assert_eq!(
            HiddenTestKind::parse("reference_payload"),
            Some(HiddenTestKind::ReferencePayload)
        );
        assert_eq!(
            HiddenTestKind::parse("predicate_probe"),
            Some(HiddenTestKind::PredicateProbe)
        );
        assert_eq!(HiddenTestKind::parse("nope"), None);
        for verdict in [
            VerdictKind::Success,
            VerdictKind::WrongAnswer,
            VerdictKind::InvalidAction,
            VerdictKind::ProgramCrash,
            VerdictKind::MemoryFault,
            VerdictKind::ResourceLimit,
            VerdictKind::Timeout,
        ] {
            assert_eq!(VerdictKind::parse(verdict.as_str()), Some(verdict));
        }
        assert_eq!(VerdictKind::parse("engine_error"), None, "非可授权期望(D6)");
    }
}

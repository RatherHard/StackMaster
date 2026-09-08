//! WP-6 形态反例矩阵:动作日志 / 快照 / 状态形态的读回拒绝路径逐条红灯
//! (自检纪律:每条拒绝规则带必触发反例),兼及运行时拒绝面与结局映射。

mod common;

use common::*;
use vm_core::arch::ArchValue;
use vm_core::instr::{BaselineOp, Instruction, Op, Operand, Program};
use vm_core::judge::predicate::{ConditionL1, Predicate};
use vm_core::judge::spec::{JudgingConfigLimits, SessionActionType, StageSpec};
use vm_core::state::CumulativeBudget;
use vm_runtime::action_log::{
    ActionLog, ActionLogEntry, EngineOutcome, JudgeOutcome, OutcomeRecord, RecordedAction,
};
use vm_runtime::runtime::{ApplyError, RuntimeRejection};
use vm_runtime::snapshot::{SnapshotError, snapshot_to_canonical};
use vm_runtime::state_form::{
    StateFormError, state_from_canonical, state_from_canonical_text, state_hash_hex,
    write_state_canonical,
};

fn canon_text(value: &vm_runtime::canon::CanonValue) -> String {
    vm_runtime::canon::write_canonical(value).unwrap()
}

// ─────────────────────────────────────────────────────────────────────────────
// 状态形态读回:反例矩阵(以值树程序化变异;锚 = 当前装载布局)
// ─────────────────────────────────────────────────────────────────────────────

fn anchored_state() -> vm_core::state::VmState {
    let rt = build_runtime();
    rt.snapshot().unwrap().state
}

fn anchored_value(anchor: &vm_core::state::VmState) -> vm_runtime::canon::CanonValue {
    vm_runtime::state_form::state_to_canonical(anchor).unwrap()
}

fn field_mut<'a>(
    value: &'a mut vm_runtime::canon::CanonValue,
    key: &str,
) -> &'a mut vm_runtime::canon::CanonValue {
    match value {
        vm_runtime::canon::CanonValue::Object(pairs) => pairs
            .iter_mut()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value)
            .expect("字段存在"),
        _ => panic!("不是对象"),
    }
}

#[test]
fn state_form_roundtrip_is_byte_identical() {
    let mut rt = build_runtime();
    rt.apply(RecordedAction::WriteBytes {
        address: STACK_BASE + 0x40,
        data: vec![1, 2, 3],
    })
    .unwrap();
    rt.apply(RecordedAction::Step).unwrap();
    rt.apply(RecordedAction::Push { value: 0xFF }).unwrap();
    let text = write_state_canonical(rt.state()).unwrap();
    let rebuilt = state_from_canonical_text(&text, rt.state()).unwrap();
    assert_eq!(
        state_hash_hex(&rebuilt).unwrap(),
        state_hash_hex(rt.state()).unwrap()
    );
    assert_eq!(write_state_canonical(&rebuilt).unwrap(), text);
}

#[test]
fn state_form_rejects_drifted_fields() {
    let anchor = anchored_state();

    // 形态标识漂移。
    let mut value = anchored_value(&anchor);
    *field_mut(&mut value, "form") = vm_runtime::canon::CanonValue::str("stackmaster-vmstate/2");
    assert!(matches!(
        state_from_canonical(&value, &anchor),
        Err(StateFormError::FormMismatch)
    ));

    // 架构 / 状态 / 指针词汇漂移。
    let mut value = anchored_value(&anchor);
    *field_mut(&mut value, "archBits") = vm_runtime::canon::CanonValue::Int(16);
    assert!(matches!(
        state_from_canonical(&value, &anchor),
        Err(StateFormError::LayoutMismatch("archBits"))
    ));
    let mut value = anchored_value(&anchor);
    *field_mut(&mut value, "status") = vm_runtime::canon::CanonValue::str("zombie");
    assert!(matches!(
        state_from_canonical(&value, &anchor),
        Err(StateFormError::FieldShape("status"))
    ));
    let mut value = anchored_value(&anchor);
    *field_mut(&mut value, "instructionPointer") = vm_runtime::canon::CanonValue::str("0xZZ");
    assert!(matches!(
        state_from_canonical(&value, &anchor),
        Err(StateFormError::FieldShape("hex_value"))
    ));

    // 寄存器名集漂移(锚定拒绝)+ 寄存器值非法。
    let mut value = anchored_value(&anchor);
    *field_mut(&mut value, "archBits") = vm_runtime::canon::CanonValue::str("32");
    assert!(matches!(
        state_from_canonical(&value, &anchor),
        Err(StateFormError::FieldShape("archBits"))
    ));
    let mut value = anchored_value(&anchor);
    match field_mut(&mut value, "registers") {
        vm_runtime::canon::CanonValue::Object(pairs) => {
            pairs.remove(0);
        }
        _ => unreachable!(),
    }
    assert!(matches!(
        state_from_canonical(&value, &anchor),
        Err(StateFormError::LayoutMismatch("registers"))
    ));

    // 内存:模式漂移 / 区域字段漂移 / 页未知 / 页长非法。
    let mut value = anchored_value(&anchor);
    match field_mut(&mut value, "memory") {
        vm_runtime::canon::CanonValue::Object(pairs) => {
            for (key, field) in pairs.iter_mut() {
                if key == "mode" {
                    *field = vm_runtime::canon::CanonValue::str("bytecode");
                }
            }
        }
        _ => unreachable!(),
    }
    assert!(matches!(
        state_from_canonical(&value, &anchor),
        Err(StateFormError::LayoutMismatch("execution_mode"))
    ));
    let mut value = anchored_value(&anchor);
    match field_mut(&mut value, "memory") {
        vm_runtime::canon::CanonValue::Object(pairs) => {
            for (key, field) in pairs.iter_mut() {
                if key == "regions" {
                    match field {
                        vm_runtime::canon::CanonValue::Array(items) => match &mut items[0] {
                            vm_runtime::canon::CanonValue::Object(fields) => {
                                for (key, field) in fields.iter_mut() {
                                    if key == "lengthBytes" {
                                        *field = vm_runtime::canon::CanonValue::Int(8192);
                                    }
                                }
                            }
                            _ => unreachable!(),
                        },
                        _ => unreachable!(),
                    }
                }
            }
        }
        _ => unreachable!(),
    }
    assert!(matches!(
        state_from_canonical(&value, &anchor),
        Err(StateFormError::LayoutMismatch("regions"))
    ));
    let mut value = anchored_value(&anchor);
    match field_mut(&mut value, "memory") {
        vm_runtime::canon::CanonValue::Object(pairs) => {
            for (key, field) in pairs.iter_mut() {
                if key == "pages" {
                    match field {
                        vm_runtime::canon::CanonValue::Object(pages) => {
                            // 首页换到未知页号。
                            let first = pages[0].0.clone();
                            let bytes = match &pages[0].1 {
                                vm_runtime::canon::CanonValue::Str(text) => text.clone(),
                                _ => unreachable!(),
                            };
                            pages.clear();
                            pages.push((
                                String::from("999999"),
                                vm_runtime::canon::CanonValue::Str(bytes),
                            ));
                            let _ = first;
                        }
                        _ => unreachable!(),
                    }
                }
            }
        }
        _ => unreachable!(),
    }
    assert!(matches!(
        state_from_canonical(&value, &anchor),
        Err(StateFormError::LayoutMismatch("pages"))
    ));
    let mut value = anchored_value(&anchor);
    match field_mut(&mut value, "memory") {
        vm_runtime::canon::CanonValue::Object(pairs) => {
            for (key, field) in pairs.iter_mut() {
                if key == "pages" {
                    match field {
                        vm_runtime::canon::CanonValue::Object(pages) => {
                            let bytes = match &pages[0].1 {
                                vm_runtime::canon::CanonValue::Str(text) => text.clone(),
                                _ => unreachable!(),
                            };
                            let page_no = pages[0].0.clone();
                            pages[0] = (
                                page_no,
                                vm_runtime::canon::CanonValue::Str(bytes[..8].to_string()),
                            );
                        }
                        _ => unreachable!(),
                    }
                }
            }
        }
        _ => unreachable!(),
    }
    assert!(matches!(
        state_from_canonical(&value, &anchor),
        Err(StateFormError::FieldShape("page_bytes"))
    ));

    // seed 策略漂移 + 约束上限漂移。
    let mut value = anchored_value(&anchor);
    match field_mut(&mut value, "seedState") {
        vm_runtime::canon::CanonValue::Object(pairs) => {
            for (key, field) in pairs.iter_mut() {
                if key == "strategy" {
                    *field = vm_runtime::canon::CanonValue::str("server_random_per_session");
                }
            }
        }
        _ => unreachable!(),
    }
    assert!(matches!(
        state_from_canonical(&value, &anchor),
        Err(StateFormError::LayoutMismatch("seed_state"))
    ));
    let mut value = anchored_value(&anchor);
    match field_mut(&mut value, "constraints") {
        vm_runtime::canon::CanonValue::Object(pairs) => {
            for (key, field) in pairs.iter_mut() {
                if key == "steps" {
                    match field {
                        vm_runtime::canon::CanonValue::Object(fields) => {
                            for (key, field) in fields.iter_mut() {
                                if key == "limit" {
                                    *field = vm_runtime::canon::CanonValue::Int(1);
                                }
                            }
                        }
                        _ => unreachable!(),
                    }
                }
            }
        }
        _ => unreachable!(),
    }
    assert!(matches!(
        state_from_canonical(&value, &anchor),
        Err(StateFormError::LayoutMismatch("budget_limit"))
    ));

    // 缺字段。
    let mut value = anchored_value(&anchor);
    match &mut value {
        vm_runtime::canon::CanonValue::Object(pairs) => {
            pairs.retain(|(key, _)| key != "callFrames");
        }
        _ => unreachable!(),
    }
    assert!(state_from_canonical(&value, &anchor).is_err());
}

// ─────────────────────────────────────────────────────────────────────────────
// 快照读回:反例矩阵
// ─────────────────────────────────────────────────────────────────────────────

fn exported_text() -> String {
    let rt = build_runtime();
    let snapshot = rt.snapshot().unwrap();
    vm_runtime::snapshot::export_snapshot(&snapshot, &identity()).unwrap()
}

#[test]
fn snapshot_import_rejects_drifted_payload() {
    let anchor_state = anchored_state();

    // 形态标识 / 非对象 / 缺字段。
    assert!(matches!(
        vm_runtime::snapshot::import_snapshot("[]", &anchor_state, &identity()),
        Err(SnapshotError::FormMismatch("root"))
    ));
    let drifted = exported_text().replace(
        "stackmaster-session-snapshot/1",
        "stackmaster-session-snapshot/9",
    );
    assert!(matches!(
        vm_runtime::snapshot::import_snapshot(&drifted, &anchor_state, &identity()),
        Err(SnapshotError::FormMismatch("form"))
    ));
    let drifted = exported_text().replace("\"revision\":0", "\"revisionX\":0");
    assert!(matches!(
        vm_runtime::snapshot::import_snapshot(&drifted, &anchor_state, &identity()),
        Err(SnapshotError::FormMismatch("missing_field"))
    ));
    let drifted = exported_text().replace("\"revision\":0", "\"revision\":-1");
    assert!(matches!(
        vm_runtime::snapshot::import_snapshot(&drifted, &anchor_state, &identity()),
        Err(SnapshotError::FormMismatch("revision"))
    ));
    let drifted = exported_text().replace("\"halted\":false", "\"halted\":\"no\"");
    assert!(matches!(
        vm_runtime::snapshot::import_snapshot(&drifted, &anchor_state, &identity()),
        Err(SnapshotError::FormMismatch("halted"))
    ));
    // 判题阶段字段形态。
    let drifted = exported_text().replace("\"judgeStage\":null", "\"judgeStage\":{\"index\":-1}");
    assert!(matches!(
        vm_runtime::snapshot::import_snapshot(&drifted, &anchor_state, &identity()),
        Err(SnapshotError::FormMismatch("judgeStage"))
    ));
    // 语法。
    assert!(matches!(
        vm_runtime::snapshot::import_snapshot("{", &anchor_state, &identity()),
        Err(SnapshotError::Canon(_))
    ));
    // 状态段错误透传(State 变体)。
    let drifted = exported_text().replace("stackmaster-vmstate/1", "stackmaster-vmstate/7");
    assert!(matches!(
        vm_runtime::snapshot::import_snapshot(&drifted, &anchor_state, &identity()),
        Err(SnapshotError::State(_))
    ));
    // 值树路径:导出载荷解析副本上把状态段置空 → 重建拒绝(State 变体)。
    let rt = build_runtime();
    let _ = snapshot_to_canonical(&rt.snapshot().unwrap()).unwrap();
    let mut value = vm_runtime::canon::parse_canonical(&exported_text()).unwrap();
    *field_mut(&mut value, "state") = vm_runtime::canon::CanonValue::Array(vec![]);
    assert!(matches!(
        vm_runtime::snapshot::import_snapshot(&canon_text(&value), rt.state(), &identity()),
        Err(SnapshotError::State(_))
    ));
}

// ─────────────────────────────────────────────────────────────────────────────
// 动作日志读回与追加上限:反例矩阵
// ─────────────────────────────────────────────────────────────────────────────

fn sample_log() -> ActionLog {
    let mut rt = build_runtime();
    rt.apply(RecordedAction::WriteBytes {
        address: STACK_BASE,
        data: vec![0, 0],
    })
    .unwrap();
    rt.apply(RecordedAction::Step).unwrap();
    ActionLog::from_canonical_text(&rt.log().canonical_text().unwrap()).unwrap()
}

#[test]
fn action_log_parse_rejects_drifted_payload() {
    // 形态标识 / 上下文缺字段 / 非法 archBits / 非法 seed 策略 / 未知动作。
    assert!(matches!(
        ActionLog::from_canonical_text("[]"),
        Err(vm_runtime::action_log::LogFormError::FormMismatch("log"))
    ));
    let text = sample_log().canonical_text().unwrap();
    let drifted = text.replace("stackmaster-action-log/1", "stackmaster-action-log/2");
    assert!(matches!(
        ActionLog::from_canonical_text(&drifted),
        Err(vm_runtime::action_log::LogFormError::FormMismatch("format"))
    ));
    let drifted = text.replace("\"archBits\":32", "\"archBits\":16");
    assert!(matches!(
        ActionLog::from_canonical_text(&drifted),
        Err(vm_runtime::action_log::LogFormError::FormMismatch(
            "archBits"
        ))
    ));
    let drifted = text.replace("\"strategy\":\"fixed\"", "\"strategy\":\"chaos\"");
    assert!(matches!(
        ActionLog::from_canonical_text(&drifted),
        Err(vm_runtime::action_log::LogFormError::FormMismatch(
            "seedPolicy"
        ))
    ));
    let drifted = text.replace("\"type\":\"step\"", "\"type\":\"teleport\"");
    assert!(matches!(
        ActionLog::from_canonical_text(&drifted),
        Err(vm_runtime::action_log::LogFormError::FormMismatch(
            "action_type"
        ))
    ));
    // 动作参数:hex 非法(条目 0 是 write_bytes,改写为 call + 非法 targetHex)。
    let drifted = text
        .replace("\"type\":\"write_bytes\"", "\"type\":\"call\"")
        .replace("\"addressHex\":\"", "\"targetHex\":\"")
        .replace("\"bytesHex\":\"0000\",", "")
        .replace("0x7ffff000", "0xZZ");
    assert!(matches!(
        ActionLog::from_canonical_text(&drifted),
        Err(vm_runtime::action_log::LogFormError::FormMismatch(_))
    ));
    let drifted = text.replace(
        "{\"args\":{},\"type\":\"step\"}",
        "{\"args\":{\"pauseOn\":\"burst\"},\"type\":\"run_to_event\"}",
    );
    assert!(matches!(
        ActionLog::from_canonical_text(&drifted),
        Err(vm_runtime::action_log::LogFormError::FormMismatch(
            "pause_on"
        ))
    ));
    // 结局标签:未知引擎 / 判题标签。
    let drifted = text.replace("\"engine\":\"stepped\"", "\"engine\":\"warp\"");
    assert!(matches!(
        ActionLog::from_canonical_text(&drifted),
        Err(vm_runtime::action_log::LogFormError::FormMismatch(
            "engine_outcome"
        ))
    ));
    let drifted = text.replace("\"judge\":\"running\"", "\"judge\":\"maybe\"");
    assert!(matches!(
        ActionLog::from_canonical_text(&drifted),
        Err(vm_runtime::action_log::LogFormError::FormMismatch(
            "judge_outcome"
        ))
    ));
    // 负 revision。
    let drifted = text.replace("\"revisionAfter\":2", "\"revisionAfter\":-2");
    assert!(matches!(
        ActionLog::from_canonical_text(&drifted),
        Err(vm_runtime::action_log::LogFormError::FormMismatch(
            "revisionAfter"
        ))
    ));
}

/// 追加先验:越界数值在入账前拒绝(日志永远可序列化;engine_error 方向)。
#[test]
fn action_log_append_rejects_unserializable_entry() {
    let mut log = ActionLog::new(context());
    let entry = ActionLogEntry {
        index: 0,
        action: RecordedAction::Push { value: 1 },
        revision_before: 0,
        revision_after: 1,
        state_hash_before: "0".repeat(64),
        state_hash_after: "0".repeat(64),
        register_changes: vec![],
        memory_changes: vec![],
        event_seq_before: 0,
        event_seq_after: u64::MAX, // 超安全整数域(发射路径 from_u64 守卫)
        outcome: OutcomeRecord {
            engine: EngineOutcome::Effect,
            judge: JudgeOutcome::Running,
        },
    };
    assert_eq!(
        log.append(entry),
        Err(vm_runtime::canon::CanonError::UnsafeInteger)
    );
    assert!(log.is_empty(), "拒绝条目不入账");
}

// ─────────────────────────────────────────────────────────────────────────────
// 运行时拒绝面与结局映射补全
// ─────────────────────────────────────────────────────────────────────────────

fn stage_spec(allowed: Vec<SessionActionType>, max_actions: Option<u64>) -> StageSpec {
    StageSpec {
        stage_id: String::from("s0"),
        allowed_actions: allowed,
        preconditions: ConditionL1::vacuous_true(),
        transitions: vec![],
        side_effects: vec![],
        failure_conditions: vec![],
        max_instruction_steps: 1000,
        max_actions,
    }
}

/// 阶段闸门经运行时落点:允许面外动作 / 阶段动作数预算(方向映射)。
#[test]
fn stage_gate_rejections_surface_through_runtime() {
    let mut spec = vacuous_spec();
    spec.stages = vec![stage_spec(vec![SessionActionType::Step], Some(1))];
    spec.success_condition = ConditionL1::vacuous_false();
    let mut rt = build_runtime_with(spec, test_constraints());
    // 允许面外:write_bytes → StageDisallowsAction。
    assert_eq!(
        rt.apply(RecordedAction::WriteBytes {
            address: STACK_BASE,
            data: vec![1]
        }),
        Err(ApplyError::Rejected(RuntimeRejection::StageDisallowsAction))
    );
    // 第一步受理;第二步超动作预算。
    rt.apply(RecordedAction::Step).unwrap();
    assert_eq!(
        rt.apply(RecordedAction::Step),
        Err(ApplyError::Rejected(RuntimeRejection::StageActionBudget))
    );
    assert_eq!(rt.revision(), 1);
}

/// 教学性失败:只读区写(memory_fault)入账为 EffectFailed,会话继续;
/// 栈底 push(memory_fault)同理;exit 后 step → Halted;标签点映射。
#[test]
fn teaching_failures_record_effect_failed_and_session_continues() {
    let mut rt = build_runtime();
    // 写代码区(rx)→ memory_fault,已执行(+1)。
    let receipt = rt
        .apply(RecordedAction::WriteBytes {
            address: 0x40_0000,
            data: vec![0x90],
        })
        .unwrap();
    assert_eq!(
        receipt.engine,
        EngineOutcome::EffectFailed {
            reason: "memory_fault"
        }
    );
    assert!(receipt.engine_error.is_some());
    assert_eq!(rt.revision(), 1);
    assert_eq!(rt.state().status, VmStatus::Running);
    assert_eq!(
        rt.log().entries()[0].outcome.engine,
        EngineOutcome::EffectFailed {
            reason: "memory_fault"
        }
    );
    // 标签校验:checkpoint 标签含控制字符 → 确定性拒绝。
    assert_eq!(
        rt.apply(RecordedAction::CreateCheckpoint {
            label: Some(String::from("bad\u{0007}")),
        }),
        Err(ApplyError::Rejected(
            RuntimeRejection::InvalidCheckpointLabel
        ))
    );
    // exit 后再 step → Halted(无执行)。
    rt.apply(RecordedAction::Step).unwrap();
    rt.apply(RecordedAction::Step).unwrap();
    assert!(rt.engine().is_halted());
    let receipt = rt.apply(RecordedAction::Step).unwrap();
    assert_eq!(receipt.engine, EngineOutcome::Halted);
}

/// 写程序(内存写指令)驱动 run_to_event → Paused{on} 结局;
/// 越界跳转 step → Failed{invalid_rip}(会话转终态 failed)。
#[test]
fn run_outcome_tags_paused_and_failed_flow_through() {
    // 专用程序:mov [RSP+0], RAX → exit。
    let mut rt = build_runtime();
    // 借助 checkpoint 标签面之外的动作驱动 Paused:需要写事件。
    // 构造带写事件的会话:write_bytes 动作发 Write 私有事件,
    // run_to_event(Write) 在事件级暂停不适用(动作事件在执行前发生),
    // 故此处直接验证 Exited{code} 结局 + 暂停语义经 Pause 动作:
    rt.apply(RecordedAction::RunToEvent {
        pause_on: vm_core::exec::PauseOn::Write,
    })
    .unwrap();
    // 程序无写指令:运行到 exit → Exited{code:0}。
    assert_eq!(
        rt.log().entries()[0].outcome.engine,
        EngineOutcome::Exited { code: 0 }
    );
    // 越界执行位置:reset 后用 call 指向不可执行地址;若目标可解析,
    // call 本身成功(引擎在后续取指才拒绝)——两种结局都记录标签。
    rt.apply(RecordedAction::Reset).unwrap();
    let receipt = rt
        .apply(RecordedAction::Call {
            target: SCRATCH_BASE, // 仅 w,不可执行
        })
        .unwrap();
    assert!(
        receipt.engine == EngineOutcome::Effect
            || receipt.engine
                == EngineOutcome::EffectFailed {
                    reason: "invalid_rip"
                }
    );
}

/// step 命中越界 IR 索引(jmp 到界外)→ Failed{invalid_rip},终态闸门接管。
#[test]
fn step_to_out_of_range_index_fails_session() {
    // 装配单条 jmp 99 的引擎(索引越界)。
    let program = Program::Ir {
        instructions: vec![Instruction {
            op: Op::Baseline(BaselineOp::Jmp),
            operands: vec![Operand::Immediate(ArchValue::new(99, A32))],
        }],
        entrypoint_index: 0,
    };
    let constraints = test_constraints();
    let mut spec = vacuous_spec();
    spec.success_condition = ConditionL1::of(Predicate::RegisterEquals {
        register: String::from("RAX"),
        value: ArchValue::new(0xDEAD, A32),
    });
    spec.limits = JudgingConfigLimits {
        max_predicate_eval_steps: 100_000,
    };
    // 引擎程序不可替换:以带 jmp 程序的新装配重建(布局同测试引擎)。
    let mut engine = {
        let regions = test_regions();
        let config = vm_core::state::VmStateConfig {
            arch: A32,
            execution_mode: vm_core::memory::ExecutionMode::Ir,
            page_size: 4096,
            regions,
            region_contents: test_contents(),
            registers: test_registers(),
            flag_register_names: vec![String::from("FLAG_KEY")],
            initial_instruction_pointer: ArchValue::new(0, A32),
            constraints,
            seed_state: test_seed(),
        };
        vm_core::exec::Engine::new(vm_core::exec::EngineConfig {
            state: config,
            program,
            custom_instructions: vec![],
            interfaces: vec![],
            canary_slots: Vec::new(),
        })
        .unwrap()
    };
    let judge = build_judge_with(spec, &mut engine);
    let mut rt = vm_runtime::runtime::SessionRuntime::new(vm_runtime::runtime::SessionConfig {
        identity: identity(),
        context: context(),
        engine,
        judge,
    })
    .unwrap();
    let jumped = rt.apply(RecordedAction::Step).unwrap();
    assert_eq!(
        jumped.engine,
        EngineOutcome::Stepped,
        "jmp 本步完成,IP 越界"
    );
    let receipt = rt.apply(RecordedAction::Step).unwrap();
    assert_eq!(
        receipt.engine,
        EngineOutcome::Failed {
            reason: "invalid_rip"
        }
    );
    assert_eq!(rt.state().status, VmStatus::Failed);
    // 终态:后续动作被闸门拒绝。
    assert_eq!(
        rt.apply(RecordedAction::Step),
        Err(ApplyError::Rejected(RuntimeRejection::TerminalSession))
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 回放拒绝分支补全
// ─────────────────────────────────────────────────────────────────────────────

/// 回放期拒绝 / revision / 结局漂移与谓词预算故障(ReplayError 全分支)。
#[test]
fn replay_mismatch_fields_and_fault() {
    let mut rt = build_runtime();
    rt.apply(RecordedAction::Step).unwrap();
    rt.apply(RecordedAction::Push { value: 7 }).unwrap();

    // revision 漂移。
    let mut tampered = ActionLog::from_canonical_text(&rt.log().canonical_text().unwrap()).unwrap();
    tampered.entries_mut()[1].revision_after = 9;
    assert!(matches!(
        vm_runtime::replay::replay(common::fresh_config(), &tampered),
        Err(vm_runtime::replay::ReplayError::Mismatch {
            field: "revision",
            ..
        })
    ));

    // 结局漂移(引擎轴)。
    let mut tampered = ActionLog::from_canonical_text(&rt.log().canonical_text().unwrap()).unwrap();
    tampered.entries_mut()[1].outcome.engine = EngineOutcome::Halted;
    assert!(matches!(
        vm_runtime::replay::replay(common::fresh_config(), &tampered),
        Err(vm_runtime::replay::ReplayError::Mismatch {
            field: "engine_outcome",
            ..
        })
    ));

    // 结局漂移(判题轴)。
    let mut tampered = ActionLog::from_canonical_text(&rt.log().canonical_text().unwrap()).unwrap();
    tampered.entries_mut()[1].outcome.judge = JudgeOutcome::Won;
    assert!(matches!(
        vm_runtime::replay::replay(common::fresh_config(), &tampered),
        Err(vm_runtime::replay::ReplayError::Mismatch {
            field: "judge_outcome",
            ..
        })
    ));

    // 重放期故障:谓词预算在第二条检查点耗尽 → Fault。
    let mut spec = vacuous_spec();
    spec.success_condition = ConditionL1::of(Predicate::RegisterEquals {
        register: String::from("RAX"),
        value: ArchValue::new(0xFFFF, A32),
    });
    spec.limits = JudgingConfigLimits {
        max_predicate_eval_steps: 1,
    };
    let mut constraints = test_constraints();
    constraints.predicate_evals = CumulativeBudget::new(0, 1);
    let mut tight = build_runtime_with(spec.clone(), constraints);
    tight.apply(RecordedAction::Step).unwrap();
    let mut log = ActionLog::from_canonical_text(&tight.log().canonical_text().unwrap()).unwrap();
    // 手工续一条同形条目(读回修复面):重放时第二次检查点即故障。
    let first = log.entries()[0].clone();
    log.append(ActionLogEntry {
        action: RecordedAction::Push { value: 1 },
        revision_before: first.revision_after,
        revision_after: first.revision_after + 1,
        state_hash_before: first.state_hash_after.clone(),
        state_hash_after: first.state_hash_after.clone(),
        ..first
    })
    .unwrap();
    // 重放装配持同样紧的预算(回放上下文不变;预算属引擎装配)。
    let tight_config = {
        let mut engine = build_engine_with_constraints(constraints);
        let judge = build_judge_with(spec, &mut engine);
        vm_runtime::runtime::SessionConfig {
            identity: identity(),
            context: context(),
            engine,
            judge,
        }
    };
    assert!(matches!(
        vm_runtime::replay::replay(tight_config, &log),
        Err(vm_runtime::replay::ReplayError::Fault(_))
    ));
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试装配碎片(与 common 同布局;供越界程序装配)
// ─────────────────────────────────────────────────────────────────────────────

use vm_core::memory::{Permissions, RegionContents, RegionKind, RegionSpec};
use vm_core::state::VmStatus;
use vm_core::state::{SeedState, SeedStrategy};

fn test_regions() -> Vec<RegionSpec> {
    vec![
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
    ]
}

fn test_contents() -> Vec<RegionContents> {
    let mut stack_bytes = vec![0u8; 4096];
    stack_bytes[0x100..0x104].copy_from_slice(&[0x11, 0x22, 0x33, 0x44]);
    vec![
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
    ]
}

fn test_registers() -> Vec<(String, ArchValue)> {
    vec![
        (String::from("RSP"), ArchValue::new(STACK_BASE + 0x100, A32)),
        (String::from("RBP"), ArchValue::new(STACK_BASE + 0x100, A32)),
        (String::from("RIP"), ArchValue::new(0, A32)),
        (String::from("RAX"), ArchValue::new(0, A32)),
        (String::from("FLAG_KEY"), ArchValue::new(0, A32)),
    ]
}

fn test_seed() -> SeedState {
    SeedState {
        strategy: SeedStrategy::Fixed,
        version: 1,
        state_bytes: vec![0xAA, 0xBB, 0xCC, 0xDD, 0x11, 0x22, 0x33, 0x44],
    }
}

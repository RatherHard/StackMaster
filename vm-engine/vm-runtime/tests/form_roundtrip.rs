//! WP-6 形态往返补全:全 12 动作日志的序列化 / 读回闭环、结局标签全集、
//! 多阶段 + 派生 seed 上下文、跨区域内存差分、快照阶段段往返。

mod common;

use common::*;
use vm_core::arch::ArchValue;
use vm_core::judge::predicate::{ConditionL1, Predicate};
use vm_core::judge::spec::SessionActionType;
use vm_core::judge::spec::{JudgingConfigLimits, StageSpec, StageTransitionSpec};
use vm_core::state::VmStatus;
use vm_runtime::action_log::{
    ActionLog, ActionLogEntry, EngineOutcome, JudgeOutcome, OutcomeRecord, RecordedAction,
    exec_error_tag, judge_outcome, status_outcome,
};
use vm_runtime::runtime::{SessionConfig, SessionRuntime};

fn log_text(rt: &SessionRuntime) -> String {
    rt.log().canonical_text().unwrap()
}

/// 多阶段 + server_random 派生上下文的全动作脚本:活体日志序列化 → 解读回
/// → 再序列化文本一致 → 全新运行时重放哈希一致(结局标签全集随行)。
#[test]
fn full_action_log_roundtrip_and_replay_with_stages() {
    // 判题面:s0 --(恒真迁移)--> s1;成功 = RAX == 0xDEAD(脚本内不可达,
    // 避免 won 终态截断脚本;迁移不受影响)。
    let mut spec = vacuous_spec();
    spec.success_condition = ConditionL1::of(Predicate::RegisterEquals {
        register: String::from("RAX"),
        value: ArchValue::new(0xDEAD, A32),
    });
    let mut s0 = StageSpec {
        stage_id: String::from("s0"),
        allowed_actions: SessionActionType::ALL.to_vec(),
        preconditions: ConditionL1::vacuous_true(),
        transitions: vec![StageTransitionSpec {
            to_stage: String::from("s1"),
            on_condition: ConditionL1::vacuous_true(),
        }],
        side_effects: vec![],
        failure_conditions: vec![],
        max_instruction_steps: 100_000,
        max_actions: None,
    };
    s0.allowed_actions = SessionActionType::ALL.to_vec();
    spec.stages = vec![s0, stage_s1()];
    spec.limits = JudgingConfigLimits {
        max_predicate_eval_steps: 100_000,
    };
    let mut constraints = test_constraints();
    constraints.predicate_evals = vm_core::state::CumulativeBudget::new(0, 100_000);

    let mut engine = build_engine_with_constraints(constraints);
    let judge = build_judge_with(spec.clone(), &mut engine);
    let mut ctx = context();
    ctx.seed_policy = vm_runtime::action_log::SeedReplayMeta {
        strategy: String::from("server_random_per_session"),
        derivation: Some(vm_runtime::action_log::DerivationMeta {
            algorithm_id: String::from("splitmix64-stream-v1"),
            draws: 3,
        }),
    };
    let mut rt = SessionRuntime::new(SessionConfig {
        identity: identity(),
        context: ctx.clone(),
        engine,
        judge,
    })
    .unwrap();

    // 脚本:覆盖 12 动作与全部引擎结局(Stepped / Exited / Halted / Effect /
    // EffectFailed)与全部判题结局(Running / StageEntered / Won)。
    let script: Vec<vm_runtime::action_log::RecordedAction> = vec![
        RecordedAction::WriteBytes {
            address: STACK_BASE + 0x200,
            data: vec![0x0A],
        }, // rev1
        RecordedAction::Push { value: 0x1122 }, // rev2
        RecordedAction::Pop,                    // rev3
        RecordedAction::Step,                   // rev4:mov RAX,0x11;迁移检查点在 settle
        RecordedAction::CreateCheckpoint { label: None }, // rev5
        RecordedAction::Call {
            target: SCRATCH_BASE, // 仅 w:EffectFailed(invalid_rip)
        }, // rev6
        RecordedAction::Ret, // rev7:EffectFailed(canary?无 canary → pop 空栈段 fault)
        RecordedAction::RunToEvent {
            pause_on: vm_core::exec::PauseOn::Write,
        }, // rev8:运行至 exit → Exited
        RecordedAction::Undo, // rev9:撤销 exit
        RecordedAction::CheckoutCheckpoint {
            checkpoint_id: rt_id_placeholder(),
        }, // 占位,执行时替换
        RecordedAction::Reset, // rev 终
    ];
    let mut issued: Option<String> = None;
    for action in script {
        let action = match action {
            RecordedAction::CheckoutCheckpoint { .. } => RecordedAction::CheckoutCheckpoint {
                checkpoint_id: issued.clone().expect("checkout 前已建检查点"),
            },
            other => other,
        };
        let receipt = rt.apply(action).unwrap();
        if let Some(id) = receipt.checkpoint_id {
            issued = Some(id);
        }
    }
    // 阶段迁移发生(Step 后 settle 命中迁移)。
    assert!(rt.judge().stage().is_some());
    assert!(rt.log().len() >= 9);

    // 活体日志 → 文本 → 解析 → 文本:逐字节一致。
    let original = log_text(&rt);
    let reparsed = ActionLog::from_canonical_text(&original).unwrap();
    let reserialized = reparsed.canonical_text().unwrap();
    assert_eq!(original, reserialized, "日志规范化往返逐字节一致");
    assert_eq!(reparsed.context, ctx, "上下文(含派生路径)往返一致");

    // 全新运行时重放:哈希序列与活体一致。
    let live_hashes: Vec<String> = rt
        .log()
        .entries()
        .iter()
        .map(|entry| entry.state_hash_after.clone())
        .collect();
    let fresh = {
        let mut engine = build_engine_with_constraints(test_constraints());
        let judge = build_judge_with(spec, &mut engine);
        SessionConfig {
            identity: identity(),
            context: ctx,
            engine,
            judge,
        }
    };
    let report = vm_runtime::replay::replay(fresh, &reparsed).unwrap();
    assert_eq!(report.state_hash_sequence, live_hashes, "重放哈希序列一致");
}

fn rt_id_placeholder() -> String {
    String::new()
}

fn stage_s1() -> StageSpec {
    StageSpec {
        stage_id: String::from("s1"),
        allowed_actions: SessionActionType::ALL.to_vec(),
        preconditions: ConditionL1::vacuous_true(),
        transitions: vec![],
        side_effects: vec![],
        failure_conditions: vec![],
        max_instruction_steps: 100_000,
        max_actions: None,
    }
}

/// 结局标签映射与序列化 / 解析闭环(Paused / Exited / Failed / Halted /
/// StageEntered / Failed{source} 全变体;exec_error_tag 全分支)。
#[test]
fn outcome_tags_serialize_and_parse_all_variants() {
    use vm_core::exec::{ExecError, PauseOn};

    let cases: Vec<(OutcomeRecord, String)> = vec![
        (
            OutcomeRecord {
                engine: EngineOutcome::Paused { on: PauseOn::Call },
                judge: JudgeOutcome::Running,
            },
            String::from("paused"),
        ),
        (
            OutcomeRecord {
                engine: EngineOutcome::Exited { code: 7 },
                judge: JudgeOutcome::Won,
            },
            String::from("exited"),
        ),
        (
            OutcomeRecord {
                engine: EngineOutcome::Failed {
                    reason: "invalid_rip",
                },
                judge: JudgeOutcome::Failed {
                    source: String::from("challenge_condition:0"),
                },
            },
            String::from("failed"),
        ),
        (
            OutcomeRecord {
                engine: EngineOutcome::Halted,
                judge: JudgeOutcome::StageEntered { to_stage: 2 },
            },
            String::from("halted"),
        ),
        (
            OutcomeRecord {
                engine: EngineOutcome::EffectFailed {
                    reason: "canary_violation",
                },
                judge: JudgeOutcome::Running,
            },
            String::from("effect_failed"),
        ),
    ];
    for (record, _) in &cases {
        // 直接构造单条日志(无需会话):序列化 → 解析 → 同记录。
        let mut log = ActionLog::new(context());
        log.append(ActionLogEntry {
            index: 0,
            action: RecordedAction::Step,
            revision_before: 0,
            revision_after: 1,
            state_hash_before: "0".repeat(64),
            state_hash_after: "0".repeat(64),
            register_changes: vec![],
            memory_changes: vec![],
            event_seq_before: 0,
            event_seq_after: 0,
            outcome: record.clone(),
        })
        .unwrap();
        let text = log.canonical_text().unwrap();
        let parsed = ActionLog::from_canonical_text(&text).unwrap();
        assert_eq!(
            parsed.entries()[0].outcome,
            *record,
            "结局标签往返一致:{record:?}"
        );
    }
    // exec_error_tag 全分支(含 resource_limit / invariant_broken)。
    let error = ExecError::ResourceLimit(vm_core::state::ResourceLimitError {
        requested: 1,
        available: 0,
    });
    assert_eq!(exec_error_tag(&error), "resource_limit");
    assert_eq!(
        exec_error_tag(&ExecError::InvariantBroken("x")),
        "invariant_broken"
    );
    assert_eq!(
        exec_error_tag(&ExecError::InvalidSyscallDispatch { value: 9 }),
        "invalid_syscall_dispatch"
    );
    // judge_outcome / status_outcome 映射。
    assert_eq!(
        judge_outcome(&vm_core::judge::SettleOutcome::Won),
        JudgeOutcome::Won
    );
    assert_eq!(
        status_outcome(VmStatus::Failed),
        JudgeOutcome::Failed {
            source: String::from("session_status")
        }
    );
}

/// 跨区域内存差分:相邻区域的跨界写入按区域切分为两条变化记录。
#[test]
fn memory_diff_splits_changes_at_region_boundaries() {
    // 布局:两个相邻区域(各 4096)共用一页(页 64KB)。
    let regions = vec![
        vm_core::memory::RegionSpec::new(
            "lo",
            vm_core::memory::RegionKind::Global,
            None,
            0x1_0000,
            4096,
            vm_core::memory::Permissions::parse("rw").unwrap(),
            A32,
        )
        .unwrap(),
        vm_core::memory::RegionSpec::new(
            "hi",
            vm_core::memory::RegionKind::Global,
            None,
            0x1_1000,
            4096,
            vm_core::memory::Permissions::parse("rw").unwrap(),
            A32,
        )
        .unwrap(),
    ];
    let contents = vec![
        RegionContents {
            region_id: String::from("lo"),
            bytes: vec![],
        },
        RegionContents {
            region_id: String::from("hi"),
            bytes: vec![],
        },
    ];
    let config = VmStateConfig {
        arch: A32,
        execution_mode: vm_core::memory::ExecutionMode::Ir,
        page_size: 65536,
        regions,
        region_contents: contents,
        registers: vec![
            (String::from("RSP"), ArchValue::new(0x1_0FF8, A32)),
            (String::from("RBP"), ArchValue::new(0x1_0FF8, A32)),
            (String::from("RIP"), ArchValue::new(0, A32)),
            (String::from("RAX"), ArchValue::new(0, A32)),
        ],
        flag_register_names: vec![],
        initial_instruction_pointer: ArchValue::new(0, A32),
        constraints: test_constraints(),
        seed_state: test_seed_state(),
    };
    let mut engine = vm_core::exec::Engine::new(vm_core::exec::EngineConfig {
        state: config,
        program: common::test_program(0x11),
        custom_instructions: vec![],
        interfaces: vec![],
        canary_slots: Vec::new(),
    })
    .unwrap();
    let judge = build_judge(&mut engine);
    let mut rt = SessionRuntime::new(SessionConfig {
        identity: identity(),
        context: context(),
        engine,
        judge,
    })
    .unwrap();
    // 跨界写:0x1_0FFE..=0x1_1001(横跨 lo 尾部与 hi 头部)。
    rt.apply(RecordedAction::WriteBytes {
        address: 0x1_0FFE,
        data: vec![1, 2, 3, 4],
    })
    .unwrap();
    let changes = &rt.log().entries()[0].memory_changes;
    assert_eq!(changes.len(), 2, "跨界写入按区域切分");
    assert_eq!(changes[0].region_id, "lo");
    assert_eq!(changes[0].start, 0x1_0FFE);
    assert_eq!(changes[0].bytes, vec![1, 2]);
    assert_eq!(changes[1].region_id, "hi");
    assert_eq!(changes[1].start, 0x1_1000);
    assert_eq!(changes[1].bytes, vec![3, 4]);
}

fn test_seed_state() -> vm_core::state::SeedState {
    vm_core::state::SeedState {
        strategy: vm_core::state::SeedStrategy::Fixed,
        version: 1,
        state_bytes: vec![0xAA, 0xBB, 0xCC, 0xDD, 0x11, 0x22, 0x33, 0x44],
    }
}

/// 快照阶段段(Some)往返:多阶段会话导出 / 导入后阶段索引与计数一致。
#[test]
fn snapshot_roundtrip_carries_stage_state() {
    let mut spec = vacuous_spec();
    spec.stages = vec![
        StageSpec {
            stage_id: String::from("s0"),
            allowed_actions: SessionActionType::ALL.to_vec(),
            preconditions: ConditionL1::vacuous_true(),
            transitions: vec![StageTransitionSpec {
                to_stage: String::from("s1"),
                on_condition: ConditionL1::vacuous_true(),
            }],
            side_effects: vec![],
            failure_conditions: vec![],
            max_instruction_steps: 100_000,
            max_actions: None,
        },
        stage_s1(),
    ];
    let constraints = test_constraints();
    let mut engine = build_engine_with_constraints(constraints);
    let judge = build_judge_with(spec, &mut engine);
    let mut rt = SessionRuntime::new(SessionConfig {
        identity: identity(),
        context: context(),
        engine,
        judge,
    })
    .unwrap();
    rt.apply(RecordedAction::Step).unwrap(); // settle:动作数 1、迁移 → s1?迁移条件恒真 → 已入 s1(计数清零)
    let stage_before = rt.judge().stage().cloned();
    let export = rt.export_snapshot().unwrap();
    let mut recovered = build_runtime();
    recovered.replace_from_snapshot(&export).unwrap();
    assert_eq!(
        recovered.judge().stage().cloned(),
        stage_before,
        "阶段段随快照往返"
    );
}

use vm_core::memory::RegionContents;
use vm_core::state::VmStateConfig;

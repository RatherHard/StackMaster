//! WP-6 集成测试:revision 语义、undo / checkout / reset 内容回退、COW 有界性、
//! 动作日志记录清单、快照导出 / 导入与替换恢复、资源上限。

mod common;

use std::collections::BTreeSet;

use common::*;
use vm_core::judge::predicate::{ConditionL1, Predicate};
use vm_core::judge::spec::SessionActionType;
use vm_core::state::CumulativeBudget;
use vm_runtime::action_log::RecordedAction;
use vm_runtime::runtime::{ApplyError, RuntimeError, RuntimeRejection};

fn v(raw: u64) -> RecordedAction {
    RecordedAction::Push { value: raw }
}

fn write_stack(offset: u64, bytes: &[u8]) -> RecordedAction {
    RecordedAction::WriteBytes {
        address: STACK_BASE + offset,
        data: bytes.to_vec(),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// revision 单调与拒绝语义(会话动作协议 §4.1,ZR-P5)
// ─────────────────────────────────────────────────────────────────────────────

/// 被接受的动作(含管理类与 pause / create_checkpoint)恒 +1;
/// 被拒绝的动作(空历史 undo)revision 不动——增量 ∈ {0, +1}。
#[test]
fn revision_monotonic_with_delta_zero_or_one() {
    let mut rt = build_runtime();
    assert_eq!(rt.revision(), 0);
    // 空历史 undo:执行前拒绝,revision 不动。
    assert_eq!(
        rt.apply(RecordedAction::Undo),
        Err(ApplyError::Rejected(RuntimeRejection::NothingToUndo))
    );
    assert_eq!(rt.revision(), 0);
    assert!(rt.log().is_empty(), "被拒绝的动作不入日志");
    // 五类被接受动作各 +1。
    rt.apply(write_stack(0x200, &[0x01])).unwrap();
    assert_eq!(rt.revision(), 1);
    rt.apply(RecordedAction::Pause).unwrap();
    assert_eq!(rt.revision(), 2);
    let receipt = rt
        .apply(RecordedAction::CreateCheckpoint { label: None })
        .unwrap();
    assert_eq!(rt.revision(), 3);
    assert!(
        receipt.checkpoint_id.is_some(),
        "create_checkpoint 回传 worker 签发 ID"
    );
    rt.apply(RecordedAction::Undo).unwrap();
    assert_eq!(rt.revision(), 4);
    rt.apply(RecordedAction::Reset).unwrap();
    assert_eq!(rt.revision(), 5);
    assert_eq!(rt.log().len(), 5, "每个被接受动作恰一条日志");
}

/// 终态会话(won)拒绝一切 12 动作(D1 约束 5);拒绝确定性(I-4):
/// 同输入两次拒绝结论一致。
#[test]
fn terminal_session_rejects_all_twelve_actions_deterministically() {
    let mut spec = vacuous_spec();
    spec.success_condition = ConditionL1::of(Predicate::MemoryEquals {
        region_id: String::from("stack"),
        offset_bytes: 0x200,
        bytes: vec![0xDE, 0xAD, 0xBE, 0xEF],
    });
    let mut rt = build_runtime_with(spec, test_constraints());
    rt.apply(write_stack(0x200, &[0xDE, 0xAD, 0xBE, 0xEF]))
        .unwrap();
    assert_eq!(rt.state().status, vm_core::state::VmStatus::Won);
    for action_type in SessionActionType::ALL {
        let action = match action_type {
            SessionActionType::WriteBytes => write_stack(0x210, &[0]),
            SessionActionType::Push => v(1),
            SessionActionType::Pop => RecordedAction::Pop,
            SessionActionType::Call => RecordedAction::Call { target: CODE_BASE },
            SessionActionType::Ret => RecordedAction::Ret,
            SessionActionType::Step => RecordedAction::Step,
            SessionActionType::RunToEvent => RecordedAction::RunToEvent {
                pause_on: vm_core::exec::PauseOn::Write,
            },
            SessionActionType::Pause => RecordedAction::Pause,
            SessionActionType::Undo => RecordedAction::Undo,
            SessionActionType::CheckoutCheckpoint => RecordedAction::CheckoutCheckpoint {
                checkpoint_id: String::from("cp-0001-0123456789abcdef"),
            },
            SessionActionType::Reset => RecordedAction::Reset,
            SessionActionType::CreateCheckpoint => RecordedAction::CreateCheckpoint {
                label: Some(String::from("x")),
            },
        };
        let first = rt.apply(action.clone());
        let second = rt.apply(action);
        assert_eq!(
            first,
            Err(ApplyError::Rejected(RuntimeRejection::TerminalSession)),
            "{action_type:?} 应被终态闸门拒绝"
        );
        assert_eq!(first, second, "拒绝必须确定性(I-4)");
        assert_eq!(rt.revision(), 1, "拒绝不推进 revision");
    }
    assert_eq!(rt.log().len(), 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// undo / checkout / reset:内容回退、版本前进
// ─────────────────────────────────────────────────────────────────────────────

/// undo = 内容回退(哈希回到前一内容)、版本前进;连续 undo 沿内容时间线
/// 继续回退;恢复可撤销已发生的 exit(halted 随快照回退)。
#[test]
fn undo_rolls_content_back_and_revision_forward() {
    let mut rt = build_runtime();
    rt.apply(write_stack(0x200, &[0x01])).unwrap(); // rev1
    let hash_after_first = rt.apply(write_stack(0x201, &[0x02])).unwrap().state_hash; // rev2
    let hash_before_second = rt.log().entries()[0].state_hash_after.clone();
    // undo:内容回退到 rev1 内容(哈希相等),revision 前进到 3。
    let receipt = rt.apply(RecordedAction::Undo).unwrap();
    assert_eq!(receipt.revision, 3);
    assert_eq!(
        receipt.state_hash, hash_before_second,
        "内容回退 = 前一内容哈希"
    );
    assert_ne!(receipt.state_hash, hash_after_first);
    // 连续 undo:回到初始内容;此后空历史拒绝。
    let initial_hash = rt.log().entries()[0].state_hash_before.clone();
    let receipt = rt.apply(RecordedAction::Undo).unwrap();
    assert_eq!(receipt.state_hash, initial_hash);
    assert_eq!(rt.revision(), 4);
    assert_eq!(
        rt.apply(RecordedAction::Undo),
        Err(ApplyError::Rejected(RuntimeRejection::NothingToUndo))
    );
    // exit 随 undo 回退:step 两步到 exit,undo 后引擎不再 halted。
    let mut rt2 = build_runtime();
    rt2.apply(RecordedAction::Step).unwrap();
    let receipt = rt2.apply(RecordedAction::Step).unwrap();
    assert!(rt2.engine().is_halted(), "exit 后 halted");
    rt2.apply(RecordedAction::Undo).unwrap();
    assert!(
        !rt2.engine().is_halted(),
        "undo 撤销 exit(halted 随快照回退)"
    );
    assert_eq!(receipt.judge, vm_runtime::action_log::JudgeOutcome::Running);
}

/// checkout:归属校验(未知 ID 确定性拒绝)、内容恢复(新 revision 旧内容)、
/// checkout 可被后续 undo 撤销。
#[test]
fn checkout_resolves_ownership_and_restores_content() {
    let mut rt = build_runtime();
    rt.apply(write_stack(0x200, &[0x0A])).unwrap(); // rev1
    let cp = rt
        .apply(RecordedAction::CreateCheckpoint {
            label: Some(String::from("基线")),
        })
        .unwrap();
    let checkpoint_id = cp.checkpoint_id.expect("worker 签发 ID");
    rt.apply(write_stack(0x201, &[0x0B])).unwrap(); // rev3
    let checkpoint_hash = rt.log().entries()[1].state_hash_after.clone();
    // 未知 ID:确定性拒绝。
    let rejection = rt.apply(RecordedAction::CheckoutCheckpoint {
        checkpoint_id: String::from("cp-9999-deadbeefdeadbeef"),
    });
    assert_eq!(
        rejection,
        Err(ApplyError::Rejected(RuntimeRejection::UnknownCheckpoint {
            checkpoint_id: String::from("cp-9999-deadbeefdeadbeef"),
        }))
    );
    assert_eq!(rt.revision(), 3, "被拒绝的 checkout 不推进");
    // 合法 checkout:内容 = checkpoint 内容,revision 前进。
    let receipt = rt
        .apply(RecordedAction::CheckoutCheckpoint {
            checkpoint_id: checkpoint_id.clone(),
        })
        .unwrap();
    assert_eq!(receipt.revision, 4);
    assert_eq!(receipt.state_hash, checkpoint_hash);
    // checkout 可被 undo 撤销(回 checkout 前内容)。
    let pre_checkout_hash = rt.log().entries()[2].state_hash_after.clone();
    let receipt = rt.apply(RecordedAction::Undo).unwrap();
    assert_eq!(receipt.state_hash, pre_checkout_hash);
    assert_eq!(rt.checkpoints().len(), 1);
    // 确定性 ID:同内容重建(经 reset 重演)得到相同 ID 形态空间(签发序递增)。
    let cp2 = rt
        .apply(RecordedAction::CreateCheckpoint { label: None })
        .unwrap()
        .checkpoint_id
        .unwrap();
    assert_ne!(checkpoint_id, cp2, "签发序防碰撞");
    assert!(checkpoint_id.starts_with("cp-0001-"));
    assert!(cp2.starts_with("cp-0002-"));
}

/// reset:内容 = 初始状态哈希、revision 前进;谓词累计预算跨 reset 不重置
/// (D1 约束 5);判题侧回初始阶段。
#[test]
fn reset_restores_initial_content_and_keeps_cumulative_budget() {
    let mut spec = vacuous_spec();
    // 每个检查点消耗 1 谓词(成功条件 1 谓词)。
    spec.success_condition = ConditionL1::of(Predicate::RegisterEquals {
        register: String::from("RAX"),
        value: vm_core::arch::ArchValue::new(0xFFFF, A32),
    });
    let mut constraints = test_constraints();
    constraints.predicate_evals = CumulativeBudget::new(0, 100_000);
    let mut rt = build_runtime_with(spec, constraints);
    rt.apply(write_stack(0x200, &[0x01])).unwrap();
    rt.apply(write_stack(0x201, &[0x02])).unwrap();
    // 谓词累计:两次检查点各 1。
    let used_before = rt.state().constraints.predicate_evals.used;
    assert_eq!(used_before, 2);
    let receipt = rt.apply(RecordedAction::Reset).unwrap();
    assert_eq!(rt.revision(), 3);
    assert_eq!(
        rt.state().constraints.predicate_evals.used,
        used_before,
        "累计预算跨 reset 不重置(D1 约束 5)"
    );
    // reset 内容 = 初始内容(排除跨 reset 保留的累计预算后哈希逐字节一致):
    // 以全新引擎装配同一初始内容、手工代入 carried 累计量,哈希必须相等。
    let mut fresh = build_engine_with_constraints(test_constraints());
    let _ = build_judge(&mut fresh);
    fresh.state.constraints.predicate_evals =
        CumulativeBudget::new(used_before, test_constraints().predicate_evals.limit);
    assert_eq!(
        receipt.state_hash,
        vm_runtime::state_form::state_hash_hex(&fresh.state).unwrap(),
        "reset 内容 = 初始状态(累计预算保留语义下)"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// COW 快照:内存增长有界 + 快照隔离(vm-core Rc 页承载)
// ─────────────────────────────────────────────────────────────────────────────

/// 有界性:K 个快照 + K 次单页写入下,跨(活体 + 全部快照)的页存储分配数
/// 只随脏页数增长,不随快照数 × 总页数增长;每次写入后快照保持冻结视图。
#[test]
fn cow_snapshot_memory_growth_is_bounded_by_dirty_pages() {
    let mut rt = build_runtime();
    let base_pages: Vec<u64> = rt.state().memory.page_ids().collect();
    let base_count = base_pages.len();
    let rounds: usize = 8;
    let mut snapshots = vec![rt.snapshot().unwrap()];
    for round in 0..rounds {
        rt.apply(write_stack(0x300 + round as u64, &[round as u8 + 1]))
            .unwrap();
        snapshots.push(rt.snapshot().unwrap());
    }
    // 跨全部快照 + 活体的页存储身份去重计数。
    let mut distinct: BTreeSet<usize> = BTreeSet::new();
    for page_no in &base_pages {
        for snapshot in &snapshots {
            distinct.insert(snapshot.state.memory.page_identity(*page_no).unwrap());
        }
        distinct.insert(rt.state().memory.page_identity(*page_no).unwrap());
    }
    // 全量复制 = base_count × (rounds + 2);COW 下每轮写同页至多 +1 次复制。
    assert!(
        distinct.len() <= base_count + rounds + 1,
        "页存储分配 {}/上限 {}——必须随脏页有界",
        distinct.len(),
        base_count + rounds + 1
    );
    assert!(
        distinct.len() < base_count * (rounds + 2),
        "禁止随快照数 × 总页数的全量复制增长"
    );
    // 快照隔离:第 k 个快照的栈页内容停在捕获时刻。
    for (round, snapshot) in snapshots.iter().enumerate() {
        let page = snapshot.state.memory.page_bytes(STACK_BASE / 4096).unwrap();
        for done in 0..round {
            let expected = (done as u8) + 1;
            // 第 done 轮写入发生在快照 round 之前 ⇒ 已见;否则为零。
            if done < round {
                assert_eq!(
                    page[0x300 + done],
                    expected,
                    "快照 {round} 缺第 {done} 轮写入"
                );
            } else {
                assert_eq!(page[0x300 + done], 0, "快照 {round} 不应见到未来写入");
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 动作日志:6.3 记录清单逐项 + append-only
// ─────────────────────────────────────────────────────────────────────────────

/// 日志条目与 6.3 清单一一对应:类型与参数、前后哈希、内存 / 寄存器变化、
/// 事件序号、上下文(题目版本 / Profile / 引擎版本)。
#[test]
fn action_log_entries_carry_the_6_3_record_list() {
    let mut rt = build_runtime();
    rt.apply(write_stack(0x200, &[0xAA, 0xBB])).unwrap();
    rt.apply(RecordedAction::Step).unwrap();
    let log = rt.log();
    assert_eq!(
        log.context,
        context(),
        "上下文 = 会话常量(题目/Profile/引擎/seed 策略)"
    );
    // 条目 0:write_bytes——内存变化(区域归属 + 合并区间 + 字节)与事件序。
    let entry0 = &log.entries()[0];
    assert!(
        matches!(
            entry0.action,
            RecordedAction::WriteBytes { address, ref data }
                if address == STACK_BASE + 0x200 && data == &[0xAA, 0xBB]
        ),
        "类型与参数"
    );
    assert_eq!(entry0.revision_before, 0);
    assert_eq!(entry0.revision_after, 1);
    assert!(!entry0.state_hash_before.is_empty());
    assert!(!entry0.state_hash_after.is_empty());
    assert_eq!(
        entry0.state_hash_before,
        build_runtime().state_hash_hex().unwrap()
    );
    assert_eq!(entry0.memory_changes.len(), 1, "内存变化");
    assert_eq!(entry0.memory_changes[0].region_id, "stack");
    assert_eq!(entry0.memory_changes[0].start, STACK_BASE + 0x200);
    assert_eq!(entry0.memory_changes[0].bytes, vec![0xAA, 0xBB]);
    assert!(entry0.register_changes.is_empty(), "写内存不改寄存器");
    assert_eq!(entry0.event_seq_before, 0, "事件序号");
    assert_eq!(entry0.event_seq_after, 1);
    // 条目 1:step——寄存器变化(RAX 装载)+ RIP 前进 + 指令无内存事件序增量。
    let entry1 = &log.entries()[1];
    assert!(matches!(entry1.action, RecordedAction::Step));
    assert!(
        entry1
            .register_changes
            .iter()
            .any(|c| c.name == "RAX" && c.from == 0 && c.to == 0x11),
        "mov RAX, 0x11 装载进入寄存器变化"
    );
    assert!(
        entry1.register_changes.iter().any(|c| c.name == "RIP"),
        "RIP 前进入寄存器变化"
    );
    assert!(entry1.memory_changes.is_empty());
    // append-only:日志无任何截断 / 重写面(类型系统外,行为断言)。
    let len_before = rt.log().len();
    rt.apply(RecordedAction::Undo).unwrap();
    assert_eq!(rt.log().len(), len_before + 1, "undo 也是追加条目");
    assert_eq!(
        rt.log().entries()[len_before - 1].index as usize,
        len_before - 1
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 资源上限(引擎侧落点)
// ─────────────────────────────────────────────────────────────────────────────

/// 动作日志长度结构上限:达限后确定性拒绝(resource_limit 方向),日志不越界。
#[test]
fn action_log_structural_cap_rejects_when_full() {
    let mut constraints = test_constraints();
    constraints.action_log = vm_core::state::Budget::new(0, 3);
    let mut rt = build_runtime_with(vacuous_spec(), constraints);
    for _ in 0..3 {
        rt.apply(write_stack(0x200, &[1])).unwrap();
    }
    assert_eq!(rt.log().len(), 3);
    assert_eq!(
        rt.apply(write_stack(0x201, &[2])),
        Err(ApplyError::Rejected(RuntimeRejection::ActionLogFull {
            limit: 3
        }))
    );
    assert_eq!(rt.revision(), 3, "拒绝不推进");
}

/// 回退累计预算:undo / checkout / reset 的进程级累计达 `rollback_ops.limit`
/// 后拒绝(可回退预算 used 之外的反神谕兜底)。
#[test]
fn rollback_cumulative_budget_caps_undo_checkout_reset() {
    let mut constraints = test_constraints();
    constraints.rollback_ops = vm_core::state::Budget::new(0, 2);
    let mut rt = build_runtime_with(vacuous_spec(), constraints);
    rt.apply(write_stack(0x200, &[1])).unwrap(); // rev1
    rt.apply(RecordedAction::Undo).unwrap(); // 回退 1
    rt.apply(write_stack(0x201, &[2])).unwrap(); // rev3
    rt.apply(RecordedAction::Undo).unwrap(); // 回退 2
    rt.apply(write_stack(0x202, &[3])).unwrap(); // rev5
    // 第 3 次回退:超累计上限。
    assert_eq!(
        rt.apply(RecordedAction::Undo),
        Err(ApplyError::Rejected(
            RuntimeRejection::RollbackBudgetExhausted { total: 3, limit: 2 }
        ))
    );
    // 已执行动作不受影响(回退预算只闸回退类)。
    rt.apply(write_stack(0x203, &[4])).unwrap();
    assert_eq!(rt.revision(), 6);
}

/// 谓词累计预算耗尽:已执行动作入账后,检查点故障按 challenge_invalid 方向
/// 安全终止上抛(非玩家可及 resource_limit;规约 §1.3)。
#[test]
fn predicate_budget_exhaustion_surfaces_as_fault() {
    let mut spec = vacuous_spec();
    spec.success_condition = ConditionL1::of(Predicate::RegisterEquals {
        register: String::from("RAX"),
        value: vm_core::arch::ArchValue::new(0xFFFF, A32),
    });
    spec.limits.max_predicate_eval_steps = 2;
    let mut constraints = test_constraints();
    constraints.predicate_evals = CumulativeBudget::new(0, 2);
    let mut rt = build_runtime_with(spec, constraints);
    rt.apply(write_stack(0x200, &[1])).unwrap(); // 检查点 1(1 谓词)
    rt.apply(write_stack(0x201, &[2])).unwrap(); // 检查点 2(累计 2,恰达上限)
    assert_eq!(
        rt.apply(write_stack(0x202, &[3])),
        Err(ApplyError::Fault(RuntimeError::PredicateBudgetExhausted {
            requested: 1,
            available: 0
        }))
    );
}

/// 内存总量静态护栏:区域总量超 `memory_bytes_limit` 拒绝装载。
#[test]
fn memory_budget_static_guard_rejects_oversized_layout() {
    let mut constraints = test_constraints();
    constraints.memory_bytes_limit = 8 * 1024; // 三个 4KB 区域 = 12KB > 8KB
    let mut engine = build_engine_with_constraints(constraints);
    let judge = build_judge(&mut engine);
    let result = vm_runtime::runtime::SessionRuntime::new(vm_runtime::runtime::SessionConfig {
        identity: identity(),
        context: context(),
        engine,
        judge,
    });
    assert!(matches!(
        result,
        Err(RuntimeError::MemoryBudgetExceeded {
            total,
            limit
        }) if total == 3 * 4096 && limit == 8 * 1024
    ));
}

/// 身份与上下文矛盾(装配缺陷)在装配期拒绝(engine_error 方向)。
#[test]
fn identity_context_mismatch_rejected_at_assembly() {
    let mut engine = build_engine();
    let judge = build_judge(&mut engine);
    let mut context = context();
    context.vm_engine_version = String::from("9.9.9");
    let result = vm_runtime::runtime::SessionRuntime::new(vm_runtime::runtime::SessionConfig {
        identity: identity(),
        context,
        engine,
        judge,
    });
    assert!(matches!(result, Err(RuntimeError::IdentityMismatch)));
}

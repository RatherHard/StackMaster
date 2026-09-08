//! WP-6 完成标准:回放一致性(黄金回放 fixture:同一日志多次重放哈希一致)
//! 与快照导出 / 导入、崩溃替换恢复、版本锁定。

mod common;

use common::*;
use vm_core::judge::predicate::ConditionL1;
use vm_core::state::VmStatus;
use vm_runtime::action_log::{ActionLog, RecordedAction};
use vm_runtime::replay::{ReplayError, replay};
use vm_runtime::snapshot::SnapshotError;
use vm_runtime::state_form::state_hash_hex;

/// 黄金脚本:覆盖执行 / 暂停 / checkpoint / undo 链 / checkout / reset 的
/// 确定性动作序列(13 个被接受动作)。
fn golden_script() -> Vec<RecordedAction> {
    vec![
        RecordedAction::WriteBytes {
            address: STACK_BASE + 0x200,
            data: vec![0xDE, 0xAD, 0xBE, 0xEF],
        },
        RecordedAction::Step,
        RecordedAction::Push { value: 0x1122_3344 },
        RecordedAction::Pop,
        RecordedAction::Pause,
        RecordedAction::WriteBytes {
            address: SCRATCH_BASE,
            data: vec![1, 2, 3],
        },
        RecordedAction::CreateCheckpoint {
            label: Some(String::from("基线")),
        },
        RecordedAction::Step,
        RecordedAction::Undo,
        RecordedAction::WriteBytes {
            address: STACK_BASE + 0x300,
            data: vec![9],
        },
        RecordedAction::Undo,
        RecordedAction::CheckoutCheckpoint {
            checkpoint_id: String::new(), // 运行时以实际签发 ID 替换
        },
        RecordedAction::Reset,
    ]
}

/// 黄金回放 fixture:活体执行的状态哈希序列 = 日志重放一次 = 重放两次 =
/// 规范化序列化→解析→再重放(三路一致,逐字节);revision 序列单调 +1。
#[test]
fn golden_replay_hash_sequence_identical_across_three_runs() {
    // 活体执行(记录真实 checkpoint ID)。
    let mut rt = build_runtime();
    let script = golden_script();
    let mut live_hashes: Vec<String> = Vec::new();
    let mut live_revisions: Vec<u64> = Vec::new();
    let mut issued_checkpoint: Option<String> = None;
    for action in script.clone() {
        let action = match action {
            RecordedAction::CheckoutCheckpoint { .. } => RecordedAction::CheckoutCheckpoint {
                checkpoint_id: issued_checkpoint
                    .clone()
                    .expect("checkout 前必有 create_checkpoint"),
            },
            other => other,
        };
        let receipt = rt.apply(action).unwrap();
        if let Some(id) = receipt.checkpoint_id {
            issued_checkpoint = Some(id);
        }
        live_hashes.push(receipt.state_hash);
        live_revisions.push(receipt.revision);
    }
    assert_eq!(live_revisions.first(), Some(&1));
    assert_eq!(
        live_revisions.last(),
        Some(&13),
        "13 个被接受动作,revision 单调 +1"
    );

    // 黄金日志:活体会话的权威日志。
    let log = rt.log();
    let canonical_text = log.canonical_text().unwrap();

    // 路 1:同一日志在全新运行时重放。
    let report1 = replay(common::fresh_config(), log).unwrap();
    // 路 2:再重放一次(任意时点重放一致)。
    let report2 = replay(common::fresh_config(), log).unwrap();
    // 路 3:规范化序列化 → 解析 → 再重放(日志是自含重放载体)。
    let reparsed = ActionLog::from_canonical_text(&canonical_text).unwrap();
    assert_eq!(
        reparsed.hash_hex().unwrap(),
        log.hash_hex().unwrap(),
        "日志规范化哈希往返一致"
    );
    let report3 = replay(common::fresh_config(), &reparsed).unwrap();

    assert_eq!(report1.state_hash_sequence, live_hashes, "重放 1 = 活体");
    assert_eq!(report2.state_hash_sequence, live_hashes, "重放 2 = 活体");
    assert_eq!(
        report3.state_hash_sequence, live_hashes,
        "解析后重放 = 活体"
    );
    assert_eq!(report1.revision_sequence, live_revisions);
    assert_eq!(report1, report2);
    assert_eq!(report1, report3);
}

/// 篡改检测:日志任一字段漂移在对应条目被捕获(state_hash / revision /
/// acceptance),不静默通过。
#[test]
fn replay_detects_tampered_log() {
    let mut rt = build_runtime();
    rt.apply(RecordedAction::WriteBytes {
        address: STACK_BASE + 0x200,
        data: vec![0x01],
    })
    .unwrap();
    rt.apply(RecordedAction::Step).unwrap();
    let log = rt.log();
    // 篡改 1:条目 0 的后置状态哈希。
    let mut tampered = ActionLog::from_canonical_text(&log.canonical_text().unwrap()).unwrap();
    tampered.entries_mut()[0].state_hash_after = "0".repeat(64);
    let _ = &tampered;
    match replay(common::fresh_config(), &tampered) {
        Err(ReplayError::Mismatch {
            entry,
            field: "state_hash",
            ..
        }) => assert_eq!(entry, 0),
        other => panic!("应报 state_hash 漂移,实际 {other:?}"),
    }
    // 篡改 2:条目 1 的动作参数(push 值改变 ⇒ 重放哈希漂移)。
    let mut rt2 = build_runtime();
    rt2.apply(RecordedAction::Step).unwrap();
    rt2.apply(RecordedAction::Push { value: 1 }).unwrap();
    let mut tampered =
        ActionLog::from_canonical_text(&rt2.log().canonical_text().unwrap()).unwrap();
    tampered.entries_mut()[1].action = RecordedAction::Push { value: 2 };
    match replay(common::fresh_config(), &tampered) {
        Err(ReplayError::Mismatch {
            entry,
            field: "state_hash",
            ..
        }) => assert_eq!(entry, 1),
        other => panic!("应报动作参数漂移,实际 {other:?}"),
    }
    // 篡改 3:上下文错配(引擎版本)⇒ ContextMismatch。
    let mut config = common::fresh_config();
    config.context.vm_engine_version = String::from("9.9.9");
    assert_eq!(replay(config, log), Err(ReplayError::ContextMismatch));
}

// ─────────────────────────────────────────────────────────────────────────────
// 快照导出 / 导入与崩溃替换恢复
// ─────────────────────────────────────────────────────────────────────────────

/// 快照往返:导出 → 全新运行时导入 → 状态哈希 / revision / 判题阶段逐项一致;
/// 恢复后动作继续 +1;导入后 undo 不可用(历史随进程消失,协议 §4.7 退化)。
#[test]
fn snapshot_roundtrip_and_replace_recovery() {
    let mut rt = build_runtime();
    rt.apply(RecordedAction::WriteBytes {
        address: STACK_BASE + 0x200,
        data: vec![0x5A],
    })
    .unwrap();
    rt.apply(RecordedAction::Step).unwrap();
    let export = rt.export_snapshot().unwrap();
    let source_hash = rt.state_hash_hex().unwrap();

    // 全新运行时(模拟崩溃后的新进程:load 完成,内容待替换)。
    let mut recovered = build_runtime();
    let revision = recovered.replace_from_snapshot(&export).unwrap();
    assert_eq!(revision, 2, "恢复携带快照 revision");
    assert_eq!(
        recovered.state_hash_hex().unwrap(),
        source_hash,
        "内容逐字节一致"
    );
    assert_eq!(
        recovered.judge().stage(),
        rt.judge().stage(),
        "判题阶段随快照承载"
    );
    // 历史与 checkpoint 随进程消失:undo 确定性拒绝(编排器账本承接)。
    assert_eq!(
        recovered.apply(RecordedAction::Undo),
        Err(vm_runtime::runtime::ApplyError::Rejected(
            vm_runtime::runtime::RuntimeRejection::NothingToUndo
        ))
    );
    // 恢复后动作继续,revision 在快照值上 +1。
    let receipt = recovered
        .apply(RecordedAction::WriteBytes {
            address: STACK_BASE + 0x201,
            data: vec![0xA5],
        })
        .unwrap();
    assert_eq!(receipt.revision, 3);
    // 累计预算自快照续算(崩溃替换不构成预算重置后门;D1 约束 5)。
    assert_eq!(
        recovered.state().constraints.predicate_evals.used,
        rt.state().constraints.predicate_evals.used
    );
}

/// 快照版本绑定:引擎版本 / 构建 ID 与运行时不一致 → challenge_invalid 方向。
#[test]
fn snapshot_import_enforces_version_lock() {
    let mut rt = build_runtime();
    rt.apply(RecordedAction::Pause).unwrap();
    let export = rt.export_snapshot().unwrap();
    let mut recovered = build_runtime();
    // 版本漂移。
    let drifted = export.replace(
        "\"vmEngineVersion\":\"0.1.0\"",
        "\"vmEngineVersion\":\"9.9.9\"",
    );
    assert!(matches!(
        recovered.replace_from_snapshot(&drifted),
        Err(SnapshotError::Version(_))
    ));
    // 构建漂移。
    let drifted = export.replace(
        "\"engineBuildId\":\"test-build\"",
        "\"engineBuildId\":\"other\"",
    );
    assert!(matches!(
        recovered.replace_from_snapshot(&drifted),
        Err(SnapshotError::Version(_))
    ));
    // 形态漂移。
    let drifted = export.replace(
        "stackmaster-session-snapshot/1",
        "stackmaster-session-snapshot/2",
    );
    assert!(matches!(
        recovered.replace_from_snapshot(&drifted),
        Err(SnapshotError::FormMismatch(_))
    ));
    // 语法漂移。
    assert!(matches!(
        recovered.replace_from_snapshot("{not json"),
        Err(SnapshotError::Canon(_))
    ));
    // 合法载荷未受影响(拒绝后可重试,进程状态未被污染)。
    assert_eq!(recovered.revision(), 0);
    assert_eq!(recovered.replace_from_snapshot(&export).unwrap(), 1);
}

/// 状态形态:重建与原状态哈希逐字节一致;布局 / 形态漂移被锚定拒绝。
#[test]
fn state_form_rebuild_matches_and_rejects_layout_drift() {
    let mut rt = build_runtime();
    rt.apply(RecordedAction::WriteBytes {
        address: SCRATCH_BASE,
        data: vec![7, 7],
    })
    .unwrap();
    let text = vm_runtime::state_form::write_state_canonical(rt.state()).unwrap();
    let rebuilt = vm_runtime::state_form::state_from_canonical_text(&text, rt.state()).unwrap();
    assert_eq!(
        state_hash_hex(&rebuilt).unwrap(),
        state_hash_hex(rt.state()).unwrap(),
        "状态形态往返 = 同一状态"
    );
    // 形态标识漂移。
    let drifted = text.replace("stackmaster-vmstate/1", "stackmaster-vmstate/2");
    assert!(vm_runtime::state_form::state_from_canonical_text(&drifted, rt.state()).is_err());
    // 布局锚定:寄存器名集漂移的形态被锚拒绝(装载布局承载声明面)。
    let drifted = text.replace("\"RAX\":\"0x00000000\"", "\"RBX\":\"0x00000000\"");
    assert_ne!(drifted, text, "形态文本应含 RAX 键");
    assert!(matches!(
        vm_runtime::state_form::state_from_canonical_text(&drifted, rt.state()),
        Err(vm_runtime::state_form::StateFormError::LayoutMismatch(
            "registers"
        ))
    ));
    // 终态词汇:paused 会话往返。
    rt.apply(RecordedAction::Pause).unwrap();
    assert_eq!(rt.state().status, VmStatus::Paused);
    let text = vm_runtime::state_form::write_state_canonical(rt.state()).unwrap();
    let rebuilt = vm_runtime::state_form::state_from_canonical_text(&text, rt.state()).unwrap();
    assert_eq!(rebuilt.status, VmStatus::Paused);
}

/// won 终态被快照完整承载(交互 won 后崩溃替换,恢复会话仍是 won 终态)。
#[test]
fn snapshot_carries_terminal_status() {
    let mut spec = vacuous_spec();
    spec.success_condition = ConditionL1::of(vm_core::judge::predicate::Predicate::MemoryEquals {
        region_id: String::from("stack"),
        offset_bytes: 0x200,
        bytes: vec![0x42],
    });
    let mut rt = build_runtime_with(spec, test_constraints());
    rt.apply(RecordedAction::WriteBytes {
        address: STACK_BASE + 0x200,
        data: vec![0x42],
    })
    .unwrap();
    assert_eq!(rt.state().status, VmStatus::Won);
    let export = rt.export_snapshot().unwrap();
    let mut recovered = build_runtime();
    recovered.replace_from_snapshot(&export).unwrap();
    assert_eq!(recovered.state().status, VmStatus::Won);
    // 终态闸门在恢复侧同样生效。
    assert!(recovered.apply(RecordedAction::Step).is_err());
}

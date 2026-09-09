//! WP-9 确定性黄金向量:跨 profile(debug / release)与跨平台(x86-64 /
//! ARM64)一致性。本测试把黄金脚本的状态哈希序列、revision 序列、checkpoint
//! 签发 ID 与动作日志摘要**硬编码为提交进仓库的常量**——任何引擎语义漂移、
//! 平台差异(哈希算法 / 迭代序 / 端序 / usize 宽度)或构建 profile 差异都会
//! 使命中常量红灯,这是 13.1"同引擎跨平台与 debug / release 结果一致"的
//! 机检落点(跨平台运行面:`.github/workflows/cross-platform.yml`)。
//!
//! 引擎语义按版本策略冻结:这些常量变化 = `vmEngineVersion` 必须演进,
//! 属引擎语义变更而非测试修正。
//!
//! 向量生成环境:stable-x86_64-pc-windows-msvc,rustc 1.98.1,
//! debug 与 release(overflow-checks = true)双 profile 逐字节一致后固化。

mod common;

use common::*;
use vm_core::state::VmStatus;
use vm_runtime::action_log::RecordedAction;

/// 黄金脚本:与 `golden_replay.rs` 同构的 13 动作确定性序列(执行 / 暂停 /
/// checkpoint / undo 链 / checkout / reset 全覆盖)。
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

/// 逐步后置状态哈希(64 hex;动作 7 / 9 / 11 / 12 内容不变故哈希相同
/// ——checkpoint / undo / checkout 的"内容回退、版本前进"语义在向量中
/// 直接可见)。
const EXPECTED_STATE_HASHES: [&str; 13] = [
    "a009f90c84c6cb307dd1b9b8f5da0e7e90f2e61a54a436224ddf11199748ff23",
    "92144ae457f522c97f75c10247f6086480f0f0402c0543b05e24bb7da99a0cf8",
    "849d944711f6a41c140b3cca6d71e1f5a37431d3b747b0284c1a879449e4e207",
    "638740f8e0910f7b431bce77fc529030baf1235e1a405927f6a0ba0b8231f16f",
    "e7033cd6f022d9302f0fc5ad0a41e28a40ed8433e2fb4b63d6891cd41816bb53",
    "26af4d3aa4fdc147381831cbeb730cef5f3d31f5fb17912bac4252756c8fa98d",
    "26af4d3aa4fdc147381831cbeb730cef5f3d31f5fb17912bac4252756c8fa98d",
    "fd1781dbdc97ffa140cd8316bb8e9d683ffc6afe1c891d7376001cb3376668ae",
    "26af4d3aa4fdc147381831cbeb730cef5f3d31f5fb17912bac4252756c8fa98d",
    "d0d692c208b290b0d4d93326e90274b41ecd0a850767a3508ac8b09b4a6c219f",
    "26af4d3aa4fdc147381831cbeb730cef5f3d31f5fb17912bac4252756c8fa98d",
    "26af4d3aa4fdc147381831cbeb730cef5f3d31f5fb17912bac4252756c8fa98d",
    "e7825b4316db4d3025c345f64f1fe35f05e42f9807725bd52ba9186c962c8a6f",
];

/// revision 序列:被接受动作恒 +1(1..=13;ZR-P5)。
const EXPECTED_REVISIONS: [u64; 13] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

/// checkpoint 签发 ID(确定性:签发序 + 内容指纹 16 hex,D-F7)。
const EXPECTED_CHECKPOINT_ID: &str = "cp-0001-ad7aa4a0d491fed4";

/// 动作日志规范化提交内容哈希(§三 #6)。
const EXPECTED_LOG_HASH: &str = "4d8f6772f21a90380517d2f8603a98a4b293e8511d0acc0ee28a597e95717964";

/// 终态:reset 后回到 running(非终态)。
const EXPECTED_STATUS: VmStatus = VmStatus::Running;

#[test]
fn golden_vectors_match_across_profiles_and_platforms() {
    let mut rt = build_runtime();
    let mut issued_checkpoint: Option<String> = None;
    let mut hashes: Vec<String> = Vec::new();
    let mut revisions: Vec<u64> = Vec::new();
    for action in golden_script() {
        let action = match action {
            RecordedAction::CheckoutCheckpoint { .. } => RecordedAction::CheckoutCheckpoint {
                checkpoint_id: issued_checkpoint
                    .clone()
                    .expect("checkout 前必有 create_checkpoint"),
            },
            other => other,
        };
        let receipt = rt.apply(action).unwrap();
        if let Some(id) = receipt.checkpoint_id.clone() {
            issued_checkpoint = Some(id);
        }
        hashes.push(receipt.state_hash);
        revisions.push(receipt.revision);
    }

    let expected_hashes: Vec<String> = EXPECTED_STATE_HASHES
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(hashes, expected_hashes, "状态哈希序列偏离黄金向量");
    assert_eq!(revisions, EXPECTED_REVISIONS.to_vec(), "revision 序列偏离");
    assert_eq!(
        issued_checkpoint.as_deref(),
        Some(EXPECTED_CHECKPOINT_ID),
        "checkpoint 确定性 ID 偏离"
    );
    assert_eq!(
        rt.log().hash_hex().unwrap(),
        EXPECTED_LOG_HASH,
        "动作日志摘要偏离"
    );
    assert_eq!(rt.state().status, EXPECTED_STATUS);
}

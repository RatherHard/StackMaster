//! WP-9 proptest 属性:COW 快照一致性(随机写入序列 × 快照点)。
//!
//! 属性(计划书 6.3"COW 快照,不逐步复制完整状态"的属性化表达):
//! 1. **不可变性**:任一快照点克隆的状态,其内容哈希在后续一切变异下
//!    保持不变(写时复制不回写既有共享页);
//! 2. **有界性**:活体 + 全部快照的页存储**身份**去重总数不超过初始页数
//!    ——克隆共享未脏页,增长只按脏页计(与 `session_runtime.rs` 的
//!    有界性测试互为属性化 / 确定性两路);
//! 3. **revision 单调**:被接受写入恒 +1(ZR-P5 的属性化表达)。
//!
//! RNG 固定种子(可复现、无 OS 熵依赖、miri 安全),理由见
//! vm-core `arch.rs` 的 WP-9 注释。

mod common;

use std::collections::BTreeSet;

use common::*;
use proptest::prelude::*;
use vm_core::state::VmState;
use vm_runtime::action_log::RecordedAction;
use vm_runtime::state_form::state_hash_hex;

fn wp9_prop_config() -> proptest::test_runner::Config {
    let mut config = proptest::test_runner::Config::with_cases(if cfg!(miri) { 8 } else { 64 });
    config.rng_seed = proptest::test_runner::RngSeed::Fixed(0xC0FF_EE11);
    // 关闭失败持久化:理由见 vm-core arch.rs 的 WP-9 注释。
    config.failure_persistence = None;
    config
}

proptest! {
    #![proptest_config(wp9_prop_config())]

    #[test]
    fn prop_cow_snapshots_immutable_and_page_bounded(
        // 写入偏移(区域内,确保 len ≤ 0x200 不越界)与 1–16 字节载荷。
        writes in proptest::collection::vec(
            (0u64..0x0E00, proptest::collection::vec(any::<u8>(), 1..17)),
            1..20,
        ),
    ) {
        let mut rt = build_runtime();
        let mut snapshots: Vec<(String, VmState)> = Vec::new();
        // 本属性中每个迭代恰为一次被接受写入:第 index 个写入的后置
        // revision 必为 index + 1(ZR-P5:被接受恒 +1)。
        for (index, (offset, data)) in writes.into_iter().enumerate() {
            // 确定性混合的快照点:每 5 个写入取一次克隆快照(快照不推进
            // revision,内容哈希不受影响)。
            if index % 5 == 0 {
                snapshots.push((rt.state_hash_hex().unwrap(), rt.state().clone()));
            }
            let receipt = rt
                .apply(RecordedAction::WriteBytes {
                    address: STACK_BASE + offset,
                    data,
                })
                .expect("栈区内写入必须被接受");
            prop_assert_eq!(receipt.revision, index as u64 + 1, "revision 单调 +1");
        }

        // 属性 1:全部快照的哈希在后续变异下不变(COW 不回写共享页)。
        for (hash, state) in &snapshots {
            prop_assert!(state_hash_hex(state).unwrap() == *hash, "快照被后续写入污染");
        }

        // 属性 2:页存储身份去重**有界**——增长只由快照点数决定、与写入
        // 次数无关。测试布局恰 3 个单页区域(code / stack / scratch);每个
        // 快照至多持有写入前的一代页版本,活体持有当前代,故全部身份
        // ≤ 初始页数 3 + 快照数(克隆与活体共享未脏页)。写入 1 次与写入
        // 1 万次的身份总数上界相同——"按脏页而非按写次增长"的属性化表达。
        let mut identities: BTreeSet<usize> = BTreeSet::new();
        let mut collect = |state: &VmState| {
            for page_no in state.memory.page_ids() {
                if let Some(id) = state.memory.page_identity(page_no) {
                    identities.insert(id);
                }
            }
        };
        collect(rt.state());
        for (_, state) in &snapshots {
            collect(state);
        }
        let bound = 3 + snapshots.len();
        prop_assert!(
            identities.len() <= bound,
            "页身份去重 {} 超上界 {}(初始 3 页 + 快照数)",
            identities.len(),
            bound
        );
    }
}

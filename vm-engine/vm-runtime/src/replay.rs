//! 回放一致性(WP-6 完成标准;计划书 6.3、9.1、ADR-8):同一动作日志在任意
//! 时点以全新运行时重放,得到**逐字节一致**的状态哈希序列。
//!
//! # 单一实现纪律(ADR-8)
//!
//! 重放不在本模块另写执行器——[`replay`] 以日志条目驱动
//! [`SessionRuntime::apply`](crate::runtime::SessionRuntime::apply)(与交互
//! 执行同一代码路径),逐条比对:
//!
//! - **受理性**:交互期被接受的动 作在重放期必须同样被接受(确定性 I-4 的
//!   推论;重放期遭拒绝即语义漂移);
//! - **revision 序列**:单调 +1 的账本逐项相等;
//! - **状态哈希序列**:规范化状态形态的 SHA-256 逐项相等(逐字节一致);
//! - **结局记录**:引擎 / 判题结局标签逐项相等(行为等价,不只是状态等价)。
//!
//! 上下文一致性:日志携带的回放上下文(版本策略 §三 #1–#5)必须与重放装配
//! 完全一致,否则 [`ReplayError::ContextMismatch`]——verifier 用错题目包 /
//! 引擎版本时在此拒绝(`replay_mismatch` / `challenge_invalid` 方向,归阶段六
//! 响应面映射)。

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::action_log::ActionLog;
use crate::runtime::{ApplyError, RuntimeError, SessionConfig, SessionRuntime};
use vm_core::state::VmStatus;

/// 重放报告:逐项状态哈希序列与 revision 序列(黄金回放比对的证据面)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayReport {
    /// 每条目后置状态哈希(64 hex;与日志逐项一致是完成标准)。
    pub state_hash_sequence: Vec<String>,
    /// 每条目后置 revision(单调 +1)。
    pub revision_sequence: Vec<u64>,
    /// 重放终态(won / failed / running / paused;阶段六 verify 裁决面的
    /// 结果映射输入。additive:WP-61 增补,既有逐项比对语义零改动)。
    pub final_status: VmStatus,
}

/// 重放失败(方向注释:`Mismatch` / `ContextMismatch` → `replay_mismatch` /
/// `challenge_invalid` 响应面,归阶段六;`Fault` → 引擎安全终止方向)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplayError {
    /// 日志上下文与重放装配不一致(题目包 / 引擎版本 / seed 策略错配)。
    ContextMismatch,
    /// 条目级不一致:重放产物与日志记录漂移。
    Mismatch {
        /// 首个漂移条目序。
        entry: u64,
        /// 漂移字段。
        field: &'static str,
        /// 日志记录值。
        expected: String,
        /// 重放实际值。
        actual: String,
    },
    /// 运行时故障(安全终止方向)。
    Fault(RuntimeError),
}

/// 以日志驱动全新运行时重放,逐项比对(见模块头)。
pub fn replay(config: SessionConfig, log: &ActionLog) -> Result<ReplayReport, ReplayError> {
    replay_with_final(config, log).map(|(report, _)| report)
}

/// 以日志驱动全新运行时重放,逐项比对并返回**重放终态运行时**(阶段六 WP-62
/// 隐藏测试执行基线;additive:既有 [`replay`] 委托本函数,逐项比对语义零
/// 改动——终态运行时仅 verify 命令面的判题驱动消费,基线之上每测试独立克隆)。
pub fn replay_with_final(
    config: SessionConfig,
    log: &ActionLog,
) -> Result<(ReplayReport, SessionRuntime), ReplayError> {
    if log.context != config.context {
        return Err(ReplayError::ContextMismatch);
    }
    let mut runtime = SessionRuntime::new(config).map_err(ReplayError::Fault)?;
    let mut report = ReplayReport {
        state_hash_sequence: Vec::with_capacity(log.len()),
        revision_sequence: Vec::with_capacity(log.len()),
        final_status: VmStatus::Running,
    };
    for entry in log.entries() {
        let receipt = match runtime.apply(entry.action.clone()) {
            Ok(receipt) => receipt,
            // 重放期故障 = 引擎安全终止方向;拒绝 = 交互期受理、重放期拒绝,
            // 即语义漂移(I-4 被破坏)。
            Err(ApplyError::Fault(error)) => return Err(ReplayError::Fault(error)),
            Err(ApplyError::Rejected(rejection)) => {
                return Err(ReplayError::Mismatch {
                    entry: entry.index,
                    field: "acceptance",
                    expected: String::from("accepted"),
                    actual: format!("{rejection:?}"),
                });
            }
        };
        if receipt.revision != entry.revision_after {
            return Err(ReplayError::Mismatch {
                entry: entry.index,
                field: "revision",
                expected: entry.revision_after.to_string(),
                actual: receipt.revision.to_string(),
            });
        }
        if receipt.state_hash != entry.state_hash_after {
            return Err(ReplayError::Mismatch {
                entry: entry.index,
                field: "state_hash",
                expected: entry.state_hash_after.clone(),
                actual: receipt.state_hash.clone(),
            });
        }
        if receipt.engine != entry.outcome.engine {
            return Err(ReplayError::Mismatch {
                entry: entry.index,
                field: "engine_outcome",
                expected: format!("{:?}", entry.outcome.engine),
                actual: format!("{:?}", receipt.engine),
            });
        }
        if receipt.judge != entry.outcome.judge {
            return Err(ReplayError::Mismatch {
                entry: entry.index,
                field: "judge_outcome",
                expected: format!("{:?}", entry.outcome.judge),
                actual: format!("{:?}", receipt.judge),
            });
        }
        report.state_hash_sequence.push(receipt.state_hash);
        report.revision_sequence.push(receipt.revision);
    }
    report.final_status = runtime.state().status;
    Ok((report, runtime))
}

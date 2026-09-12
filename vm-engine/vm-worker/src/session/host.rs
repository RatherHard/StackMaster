//! 会话托管(WP-8):协议命令 → [`SessionRuntime`] 执行链路与响应面装配。
//!
//! # 动作链路(apply_action)
//!
//! ```text
//! ActionCallMirror
//!   →(write_bytes:题目预算复检 + 写目标三分类,D-P1 执行前判定)
//!   → SessionRuntime::apply(gate → 执行 → settle → 日志 → revision)
//!   → 已执行:投影响应面(executed_action;教学性失败按能力矩阵粗化)
//!     + 刷新缓存完整投影(下一动作的 before,同策略同静态面)
//!   → 执行前拒绝:rejected 响应面(revision 不动、无增量、无事件)
//! ```
//!
//! 拒绝路径(含写分类)不触碰运行时——revision 不动、无日志条目,与
//! `SessionRuntime` 的"拒绝不入账"语义一致(I-4:同一 (输入, 会话状态)
//! 恒同响应)。
//!
//! # 故障方向
//!
//! [`HostFault`] 为安全终止方向:运行时故障(谓词预算耗尽 = challenge_invalid
//! 方向;其余 = engine_error 方向)、投影生成缺陷、快照形态错误。worker 层
//! 处置 = 尽力而为命令级错误响应 + 非零退出(进程不复用,恢复走崩溃替换)。

use projection::error::{RejectionReason, from_exec_error, objective_not_met};
use projection::policy::{ProjectionPolicy, WriteTargetClass};
use projection::project::{GenerationView, ProjectionStatics, full_projection};
use projection::response;
use projection::types::{ActionProjection, PauseKind, PublicStateProjection};
use vm_core::state::VmState;
use vm_runtime::action_log::RecordedAction;
use vm_runtime::runtime::{ApplyError, RuntimeError, RuntimeRejection, SessionRuntime};
use vm_runtime::snapshot::SnapshotError;

use crate::contract::mirrors::ActionCallMirror;
use crate::protocol::message::{CheckpointExport, SnapshotEnvelope};
use crate::session::assemble::{self, SessionComponents};

/// 托管故障(安全终止方向;`reason` 只进受控日志)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostFault {
    /// 运行时故障(谓词预算耗尽 / 判题内部 / 表单化失败)。
    Runtime(RuntimeError),
    /// 投影生成缺陷(装配后不可达;引擎缺陷方向)。
    Projection(projection::ProjectionError),
    /// 快照导出 / 导入形态错误(challenge_invalid 方向)。
    Snapshot(SnapshotError),
    /// 出站形态自检失败(worker 缺陷方向)。
    ContractInconsistency,
}

/// 已执行动作的响应面(完整 `ActionProjection` + create_checkpoint 的
/// 快照回执信封,D-F7)。
pub struct ExecutedAction {
    /// 响应投影面五字段(revision / status / delta / events / error)。
    pub response: ActionProjection,
    /// `create_checkpoint` 成功时的回执信封(其余动作恒 `None`;D-F7)。
    pub checkpoint_export: Option<CheckpointExport>,
}

/// 一次 apply 的两种确定性别形态(§4.4 耦合:rejected 无增量无事件)。
pub enum ApplyResult {
    /// 已执行(含教学性失败)。
    Executed(ExecutedAction),
    /// 执行前拒绝。
    Rejected(ActionProjection),
}

/// 单会话托管:运行时 + 投影策略 + 静态声明面 + 缓存完整投影。
pub struct SessionHost {
    runtime: SessionRuntime,
    policy: ProjectionPolicy,
    statics: ProjectionStatics,
    timeout_ms_per_action: u64,
    max_write_bytes_per_action: u64,
    pause_reason: Option<PauseKind>,
    last_projection: PublicStateProjection,
}

impl SessionHost {
    /// 自装配产物构建(初始完整投影生成;失败 = 引擎缺陷方向)。
    pub fn new(components: SessionComponents) -> Result<Self, HostFault> {
        let projection = {
            let view = Self::view_of(
                &components.policy,
                &components.statics,
                &components.runtime,
                None,
            );
            full_projection(
                components.runtime.revision(),
                &view,
                components.runtime.state(),
            )
            .map_err(HostFault::Projection)?
        };
        Ok(Self {
            timeout_ms_per_action: components.timeout_ms_per_action,
            max_write_bytes_per_action: components.max_write_bytes_per_action,
            runtime: components.runtime,
            policy: components.policy,
            statics: components.statics,
            pause_reason: None,
            last_projection: projection,
        })
    }

    /// 当前权威 revision。
    pub fn revision(&self) -> u64 {
        self.runtime.revision()
    }

    /// 权威动作日志只读视图(export_action_log 的数据源;阶段六 WP-61)。
    pub fn action_log(&self) -> &vm_runtime::action_log::ActionLog {
        self.runtime.log()
    }

    /// 单动作 wall-clock 上限(看门狗读取)。
    pub fn timeout_ms_per_action(&self) -> u64 {
        self.timeout_ms_per_action
    }

    /// 查询完整投影:以当前状态重新生成并刷新缓存(query_projection 与
    /// 快照导入后的重同步取数;不执行、不推进 revision)。
    pub fn projection(&mut self) -> Result<&PublicStateProjection, HostFault> {
        let view = self.view();
        let projection = full_projection(self.runtime.revision(), &view, self.runtime.state())
            .map_err(HostFault::Projection)?;
        self.last_projection = projection;
        Ok(&self.last_projection)
    }

    /// 应用一个动作(见模块文档动作链路)。
    pub fn apply(&mut self, action: &ActionCallMirror) -> Result<ApplyResult, HostFault> {
        let arch = self.runtime.engine().arch();
        let recorded = assemble::recorded_action(action, arch)
            .map_err(|_| HostFault::ContractInconsistency)?;

        // write_bytes 的执行前判定(D-P1 / 协议 §3.1 重新校验点):
        // ① 可见性三分类(I-9 语义优先——不可见目标不泄露预算事实);
        // ② 题目级写入预算(公开包声明;协议上限已由 Schema 承担)。
        if let RecordedAction::WriteBytes { address, data } = &recorded {
            let length = data.len() as u64;
            match self
                .policy
                .classify_write_range(&self.runtime.state().memory, *address, length)
            {
                WriteTargetClass::Covered { region_id } => {
                    if length > self.max_write_bytes_per_action {
                        let reason = RejectionReason::WriteExceedsChallengeBudget {
                            region_id,
                            allowed: self.max_write_bytes_per_action,
                            requested: length,
                        };
                        return self.rejected(reason);
                    }
                }
                WriteTargetClass::CrossesBoundary {
                    region_id, covered, ..
                } => {
                    let reason = RejectionReason::WriteCrossesVisibleBoundary {
                        region_id,
                        covered,
                        requested: length,
                        address: *address,
                    };
                    return self.rejected(reason);
                }
                WriteTargetClass::Invisible => {
                    let reason = RejectionReason::InvisibleWriteTarget { address: *address };
                    return self.rejected(reason);
                }
            }
        }

        let receipt = match self.runtime.apply(recorded) {
            Ok(receipt) => receipt,
            Err(ApplyError::Rejected(rejection)) => {
                return self.rejected(rejection_reason(&rejection));
            }
            Err(ApplyError::Fault(fault)) => return Err(HostFault::Runtime(fault)),
        };

        // 暂停原因(动作后权威):命中暂停事件 → 该类别;状态离开 paused → 清空。
        match receipt.engine {
            vm_runtime::action_log::EngineOutcome::Paused { on } => {
                self.pause_reason = Some(pause_kind(on));
            }
            _ => {
                if !matches!(
                    self.runtime.state().status,
                    vm_core::state::VmStatus::Paused
                ) {
                    self.pause_reason = None;
                }
            }
        }

        let view = self.view();
        // 教学性失败粗化:引擎层错误优先,其次判定失败(零解释形态)。
        let error = match &receipt.engine_error {
            Some(engine_error) => Some(
                from_exec_error(engine_error, &self.policy, &self.runtime.state().memory)
                    .map_err(HostFault::Projection)?,
            ),
            None => match receipt.judge {
                vm_runtime::action_log::JudgeOutcome::Failed { .. } => Some(
                    objective_not_met(&self.policy, &self.runtime.state().memory)
                        .map_err(HostFault::Projection)?,
                ),
                _ => None,
            },
        };
        // 本动作私有事件段(动作日志条目锚定;回退步 undo / checkout / reset
        // 的日志收缩 → 空段:历史回退不重发历史事件,与差分套件同纪律)。
        let entry = self
            .runtime
            .log()
            .entries()
            .get(receipt.entry_index as usize)
            .ok_or(HostFault::ContractInconsistency)?;
        let (before_seq, after_seq) = (
            entry.event_seq_before as usize,
            entry.event_seq_after as usize,
        );
        let events: &[vm_core::state::VmEvent] = if after_seq > before_seq
            && after_seq <= self.runtime.state().private_event_log.len()
        {
            &self.runtime.state().private_event_log[before_seq..after_seq]
        } else {
            &[]
        };
        let response = response::executed_action(
            receipt.revision,
            &view,
            &self.last_projection,
            self.runtime.state(),
            events,
            error,
        )
        .map_err(HostFault::Projection)?;
        // 刷新缓存完整投影(下一动作的 before;同策略同静态声明面,I-4)。
        let fresh = full_projection(receipt.revision, &view, self.runtime.state())
            .map_err(HostFault::Projection)?;
        self.last_projection = fresh;

        let checkpoint_export = match &receipt.checkpoint_id {
            Some(checkpoint_id) => Some(CheckpointExport {
                checkpoint_id: checkpoint_id.clone(),
                snapshot: self.snapshot_envelope()?,
            }),
            None => None,
        };
        Ok(ApplyResult::Executed(ExecutedAction {
            response,
            checkpoint_export,
        }))
    }

    /// 执行前拒绝(不触碰运行时)。
    fn rejected(&mut self, reason: RejectionReason) -> Result<ApplyResult, HostFault> {
        let response = response::rejected_from_reason(
            self.runtime.revision(),
            &reason,
            &self.policy,
            self.runtime.state(),
        )
        .map_err(HostFault::Projection)?;
        Ok(ApplyResult::Rejected(response))
    }

    /// 快照信封导出(export_snapshot 与 create_checkpoint 回执共用)。
    pub fn snapshot_envelope(&self) -> Result<SnapshotEnvelope, HostFault> {
        let payload = self.payload_value()?;
        Ok(SnapshotEnvelope {
            snapshot_format_version: 1,
            vm_engine_version: self.runtime.identity().vm_engine_version.clone(),
            engine_build_id: self.runtime.identity().engine_build_id.clone(),
            revision: self.runtime.revision(),
            payload,
        })
    }

    /// 快照替换恢复(import_snapshot;规范化载荷文本形态交运行时复验)。
    /// 恢复后刷新缓存投影;暂停原因不进快照,确定性清空(D-W8-8)。
    pub fn replace_from_snapshot(&mut self, payload: &serde_json::Value) -> Result<(), HostFault> {
        let text = serde_json::to_string(payload).map_err(|_| HostFault::ContractInconsistency)?;
        let canonical = crate::contract::canonical::canonicalize_json_text(&text)
            .map_err(|_| HostFault::Snapshot(SnapshotError::FormMismatch("payload")))?;
        self.runtime
            .replace_from_snapshot(&canonical)
            .map_err(HostFault::Snapshot)?;
        self.pause_reason = None;
        self.projection()?;
        Ok(())
    }

    /// 状态只读引用(测试锚点)。
    pub fn state(&self) -> &VmState {
        self.runtime.state()
    }

    fn payload_value(&self) -> Result<serde_json::Value, HostFault> {
        let text = self.runtime.export_snapshot().map_err(HostFault::Runtime)?;
        serde_json::from_str(&text).map_err(|_| HostFault::ContractInconsistency)
    }

    fn view(&self) -> GenerationView<'_> {
        Self::view_of(
            &self.policy,
            &self.statics,
            &self.runtime,
            self.pause_reason,
        )
    }

    fn view_of<'a>(
        policy: &'a ProjectionPolicy,
        statics: &'a ProjectionStatics,
        runtime: &'a SessionRuntime,
        pause_reason: Option<PauseKind>,
    ) -> GenerationView<'a> {
        GenerationView {
            policy,
            statics,
            program: runtime.engine().program(),
            customs: runtime.engine().custom_instructions(),
            pause_reason,
        }
    }
}

/// 暂停事件 → 投影暂停类别(同源五枚举一一映射)。
fn pause_kind(on: vm_core::exec::PauseOn) -> PauseKind {
    match on {
        vm_core::exec::PauseOn::Read => PauseKind::Read,
        vm_core::exec::PauseOn::Write => PauseKind::Write,
        vm_core::exec::PauseOn::Call => PauseKind::Call,
        vm_core::exec::PauseOn::Ret => PauseKind::Ret,
        vm_core::exec::PauseOn::Exception => PauseKind::Exception,
    }
}

/// `RuntimeRejection` → 投影拒绝原因(worker 侧命令级映射的粗化单点在
/// `projection::error::rejection_error`;本映射只做枚举平移)。
pub fn rejection_reason(rejection: &RuntimeRejection) -> RejectionReason {
    match rejection {
        RuntimeRejection::TerminalSession => RejectionReason::TerminalSession,
        RuntimeRejection::StageDisallowsAction => RejectionReason::StageDisallowsAction,
        RuntimeRejection::StageActionBudget => RejectionReason::StageActionBudget,
        RuntimeRejection::NothingToUndo => RejectionReason::NothingToUndo,
        RuntimeRejection::UnknownCheckpoint { .. } => RejectionReason::UnknownCheckpoint,
        RuntimeRejection::InvalidCheckpointLabel => RejectionReason::InvalidCheckpointLabel,
        RuntimeRejection::ActionLogFull { .. } => RejectionReason::ActionLogFull,
        RuntimeRejection::RollbackBudgetExhausted { .. } => {
            RejectionReason::RollbackBudgetExhausted
        }
    }
}

/// rejection_error 的再导出(供 worker.rs 以单一入口粗化运行时拒绝)。
pub fn coarse_rejection_error(
    rejection: &RuntimeRejection,
    host: &SessionHost,
) -> Result<ActionProjection, HostFault> {
    let response = response::rejected_from_reason(
        host.revision(),
        &rejection_reason(rejection),
        &host.policy,
        host.state(),
    )
    .map_err(HostFault::Projection)?;
    Ok(response)
}

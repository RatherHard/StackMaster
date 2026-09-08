//! 会话运行时(WP-6):12 动作的权威执行循环与回放一致性(ADR-8 同一份代码)。
//!
//! # 执行链路(D-J1 引擎侧接线;计划书 6.2)
//!
//! ```text
//! gate(终态 / 阶段允许动作 / 阶段动作数预算)──拒绝 ⇒ revision 不动、无日志条目
//!   → 执行前结构闸门(日志长度 / 回退累计预算)
//!   → 执行(引擎动作原语 / step / run_to_event / 内容恢复)
//!   → settle(检查点:阶段记账 → 失败优先 → 成功 → 迁移)
//!   → 前后状态哈希 + 内存 / 寄存器 / 事件序差分 → append-only 日志追加
//!   → revision += 1(revision = 已执行(非拒绝)动作数,会话动作协议 §4.1)
//! ```
//!
//! # 语义裁决
//!
//! - **revision 单调**:被接受的动作(含 undo / checkout / reset / pause /
//!   create_checkpoint)恒 +1;被拒绝的动作(参数 / 终态 / 归属 / 预算闸门)
//!   不推进(增量 ∈ {0, +1},ZR-P5);
//! - **undo = 内容回退、版本前进**(§4.1):弹出历史栈顶快照恢复内容,
//!   undo 自身入日志但不压栈——连续 undo 沿内容时间线继续回退;
//!   空历史 undo = 确定性拒绝;
//! - **checkout / reset**:压当前快照后恢复目标内容(checkout 后可被 undo
//!   撤销);reset 走 `Engine::reset` + `Judge::reset` 权威路径;
//! - **判题阶段状态随快照回退**(判题语义规约 §一 / §4.6;WP-5 settle ①
//!   "受理即计数"的管理类增量随恢复一并回退);
//! - **累计预算跨回退不重置**(D1 约束 5):`predicate_evals` 由
//!   `Engine::restore_session` / `reset` 保留当前累计;回退次数另有进程级
//!   累计计数(`rollback_ops.limit` 为上限)兜底防回退神谕;
//! - **拒绝的确定性**(I-4):一切拒绝是 `(输入, 会话状态)` 的确定性函数。
//!
//! # 资源计数(9.1 中引擎侧落点;其余归 worker 进程层 WP-8)
//!
//! | 约束 | 强制点 |
//! |---|---|
//! | 执行步数 / 调用深度 | vm-core 预算(`constraints.steps` / `call_depth_limit`) |
//! | 谓词求值 | vm-core 判题累计预算(`predicate_evals`,WP-5) |
//! | 动作日志长度 | 本模块:追加上限 = `action_log.limit`(结构护栏,以日志真实长度为准——预算 `used` 是可回退状态量) |
//! | 回退 / 重置次数 | 本模块:进程级累计 ≤ `rollback_ops.limit`(可回退预算 used 之外的反神谕兜底) |
//! | 内存总量 | 本模块:装载静态护栏(`memory_bytes_limit`) |
//! | wall-clock / 单动作超时 / 输入输出字节 | worker 进程层(WP-8;引擎 crate 无时钟) |

use alloc::string::String;
use alloc::vec::Vec;

use vm_core::arch::ArchValue;
use vm_core::exec::{Engine, ExecError, RunOutcome};
use vm_core::judge::{
    ActionClass, ActionRejection, ActionReport, Judge, JudgeError, SettleOutcome,
};
use vm_core::state::VmState;

use crate::action_log::{
    ActionLog, ActionLogEntry, EngineOutcome, JudgeOutcome, OutcomeRecord, RecordedAction,
    ReplayContext, exec_error_tag, judge_outcome,
};
use crate::identity::{EngineIdentity, VersionLockError};
use crate::sha256::Sha256;
use crate::snapshot::{CheckpointStore, SessionSnapshot};
use crate::state_form::{state_hash_hex, state_to_canonical};

// ─────────────────────────────────────────────────────────────────────────────
// 装配与错误面
// ─────────────────────────────────────────────────────────────────────────────

/// 会话装配输入(引擎 + 判题 + 身份 + 回放上下文)。
pub struct SessionConfig {
    /// 运行时引擎身份(worker 自报注入)。
    pub identity: EngineIdentity,
    /// 回放上下文(版本策略 §三记录项的会话锚)。
    pub context: ReplayContext,
    /// 装配完成的引擎(私有包 → 契约镜像 → EngineConfig,WP-8 接线)。
    pub engine: Engine,
    /// 装配完成的判题驱动。
    pub judge: Judge,
}

/// 运行时故障(方向注释:worker 映射——均为确定性安全终止)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeError {
    /// 身份 / 上下文不一致(引擎版本锁定;方向 `challenge_invalid`)。
    VersionLock(VersionLockError),
    /// 装配上下文与引擎身份矛盾(装配缺陷;方向 `engine_error`)。
    IdentityMismatch,
    /// 内存总量超静态护栏(方向 `challenge_invalid`)。
    MemoryBudgetExceeded {
        /// 区域字节总量。
        total: u64,
        /// 护栏值。
        limit: u64,
    },
    /// 谓词求值累计预算耗尽(方向 `challenge_invalid` 安全终止;规约 §1.3)。
    PredicateBudgetExhausted {
        /// 本次请求量。
        requested: u64,
        /// 剩余额度。
        available: u64,
    },
    /// 判题求值命中装配后不可达路径(方向 `engine_error`)。
    JudgeInternal,
    /// 状态哈希 / 日志序列化失败(整数越安全整数域;方向 `engine_error`)。
    Form(crate::canon::CanonError),
}

impl From<crate::canon::CanonError> for RuntimeError {
    fn from(value: crate::canon::CanonError) -> Self {
        RuntimeError::Form(value)
    }
}

impl From<RuntimeError> for ApplyError {
    fn from(value: RuntimeError) -> Self {
        ApplyError::Fault(value)
    }
}

impl From<crate::canon::CanonError> for ApplyError {
    fn from(value: crate::canon::CanonError) -> Self {
        ApplyError::Fault(RuntimeError::Form(value))
    }
}

/// 执行前确定性拒绝(revision 不动、无日志条目;I-4)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeRejection {
    /// 终态会话拒绝一切 12 动作(D1 约束 5)。
    TerminalSession,
    /// 当前阶段允许动作集不含该动作。
    StageDisallowsAction,
    /// 阶段动作数预算已达上限。
    StageActionBudget,
    /// 无可撤销动作(空历史 undo)。
    NothingToUndo,
    /// checkpoint 归属解析失败(6.3 归属校验)。
    UnknownCheckpoint {
        /// 携带的未知 ID。
        checkpoint_id: String,
    },
    /// checkpoint 标签非法(> 128 字节或含 C0 / C1 控制字符;协议 §3.2)。
    InvalidCheckpointLabel,
    /// 动作日志长度达结构上限(方向 `resource_limit`)。
    ActionLogFull {
        /// 上限。
        limit: u64,
    },
    /// 回退 / 重置累计次数达预算上限(方向 `resource_limit`)。
    RollbackBudgetExhausted {
        /// 累计(含本次请求)。
        total: u64,
        /// 上限。
        limit: u64,
    },
}

/// 动作处理错误:拒绝(确定性,会话继续)或故障(安全终止)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyError {
    /// 执行前确定性拒绝。
    Rejected(RuntimeRejection),
    /// 运行时故障(安全终止方向)。
    Fault(RuntimeError),
}

/// 动作回执(响应面生成 = WP-8;此处承载引擎侧事实)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionReceipt {
    /// 后置 revision(权威账本)。
    pub revision: u64,
    /// 本动作的日志条目序。
    pub entry_index: u64,
    /// 引擎结局。
    pub engine: EngineOutcome,
    /// 判题结局(检查点产出)。
    pub judge: JudgeOutcome,
    /// 已执行动作的引擎层错误(教学性失败;响应面按能力矩阵粗化,WP-7)。
    pub engine_error: Option<ExecError>,
    /// 后置状态哈希(64 hex)。
    pub state_hash: String,
    /// `create_checkpoint` 成功时回传的 worker 签发 ID(D-F7)。
    pub checkpoint_id: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// 会话运行时
// ─────────────────────────────────────────────────────────────────────────────

/// 单会话权威运行时:引擎 + 判题 + 快照历史 + checkpoint 表 + 动作日志 +
/// revision 账本。交互执行与回放重演共用本实现(ADR-8:禁止第二套实现)。
pub struct SessionRuntime {
    identity: EngineIdentity,
    context: ReplayContext,
    engine: Engine,
    judge: Judge,
    revision: u64,
    history: Vec<SessionSnapshot>,
    checkpoints: CheckpointStore,
    log: ActionLog,
    rollbacks_total: u64,
}

impl SessionRuntime {
    /// 装配:身份一致性 + 内存静态护栏;初始 revision = 0(协议 `loaded`
    /// 的 `initialRevision`)。
    pub fn new(config: SessionConfig) -> Result<Self, RuntimeError> {
        if config.context.vm_engine_version != config.identity.vm_engine_version
            || config.context.engine_build_id != config.identity.engine_build_id
        {
            return Err(RuntimeError::IdentityMismatch);
        }
        let total: u64 = config
            .engine
            .state
            .memory
            .regions()
            .map(|region| region.byte_length)
            .sum();
        let limit = config.engine.state.constraints.memory_bytes_limit;
        if total > limit {
            return Err(RuntimeError::MemoryBudgetExceeded { total, limit });
        }
        let log = ActionLog::new(config.context.clone());
        Ok(Self {
            identity: config.identity,
            context: config.context,
            engine: config.engine,
            judge: config.judge,
            revision: 0,
            history: Vec::new(),
            checkpoints: CheckpointStore::default(),
            log,
            rollbacks_total: 0,
        })
    }

    // ── 只读观察面 ────────────────────────────────────────────────────────

    /// 当前权威 revision。
    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// 权威状态引用(只读;投影面归 WP-7)。
    pub fn state(&self) -> &VmState {
        &self.engine.state
    }

    /// 引擎引用(只读)。
    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    /// 判题驱动引用(只读)。
    pub fn judge(&self) -> &Judge {
        &self.judge
    }

    /// 动作日志(append-only 只读视图)。
    pub fn log(&self) -> &ActionLog {
        &self.log
    }

    /// checkpoint 表(编排器 list-checkpoints 账本的数据源)。
    pub fn checkpoints(&self) -> &CheckpointStore {
        &self.checkpoints
    }

    /// 回放上下文。
    pub fn context(&self) -> &ReplayContext {
        &self.context
    }

    /// 当前状态哈希(64 hex)。
    pub fn state_hash_hex(&self) -> Result<String, RuntimeError> {
        Ok(state_hash_hex(&self.engine.state)?)
    }

    /// 当前内容快照(COW;导出与 checkpoint 的载体)。
    pub fn snapshot(&self) -> Result<SessionSnapshot, RuntimeError> {
        Ok(SessionSnapshot {
            state: self.engine.state.clone(),
            judge_stage: self.judge.stage().cloned(),
            halted: self.engine.is_halted(),
            revision: self.revision,
        })
    }

    /// 快照导出(规范化载荷文本;`payload` 形态 = `stackmaster-session-snapshot/1`)。
    pub fn export_snapshot(&self) -> Result<String, RuntimeError> {
        Ok(crate::snapshot::export_snapshot(
            &self.snapshot()?,
            &self.identity,
        )?)
    }

    // ── 动作主入口 ────────────────────────────────────────────────────────

    /// 受理一个动作:闸门 → 执行(或内容恢复)→ 检查点 → 日志 → revision。
    /// 拒绝不推进任何状态(I-4 确定性);故障为安全终止方向。
    pub fn apply(&mut self, action: RecordedAction) -> Result<ActionReceipt, ApplyError> {
        // ① 闸门(终态 / 阶段允许动作 / 阶段动作数预算)。
        let action_type = action.action_type();
        match self.judge.gate(&self.engine, action_type) {
            Ok(_) => {}
            Err(ActionRejection::Terminal) => {
                return Err(ApplyError::Rejected(RuntimeRejection::TerminalSession));
            }
            Err(ActionRejection::StageDisallowsAction) => {
                return Err(ApplyError::Rejected(RuntimeRejection::StageDisallowsAction));
            }
            Err(ActionRejection::StageActionBudget) => {
                return Err(ApplyError::Rejected(RuntimeRejection::StageActionBudget));
            }
        }
        // ② 执行前结构闸门:日志长度(append-only 真实占用;可回退预算 used
        //    的结构性兜底)。
        let log_limit = self.engine.state.constraints.action_log.limit;
        if self.log.len() as u64 >= log_limit {
            return Err(ApplyError::Rejected(RuntimeRejection::ActionLogFull {
                limit: log_limit,
            }));
        }
        // ③ 分派:管理四动作走内容恢复路径,其余走执行路径。
        match action {
            RecordedAction::Undo => self.apply_undo(),
            RecordedAction::CheckoutCheckpoint { checkpoint_id } => {
                self.apply_checkout(checkpoint_id)
            }
            RecordedAction::Reset => self.apply_reset(),
            RecordedAction::CreateCheckpoint { label } => self.apply_create_checkpoint(label),
            execution => self.apply_execution(execution),
        }
    }

    // ── 执行类动作 ────────────────────────────────────────────────────────

    fn apply_execution(&mut self, action: RecordedAction) -> Result<ActionReceipt, ApplyError> {
        let before = self.capture_snapshot();
        let hash_before = state_hash_hex(&self.engine.state)?;
        let steps_before = self.engine.state.constraints.steps.used;
        let events_before = self.engine.state.private_event_log.len() as u64;
        // 动作前快照入历史栈(undo / 回退链的承载;COW 页共享,压栈廉价)。
        self.history.push(before.clone());
        // 执行(教学性失败不中断日志链;§4.1"已执行"语义)。
        let (engine_outcome, engine_error) = self.execute(&action);
        // 检查点(阶段预算 → 失败 → 成功 → 迁移)。
        let steps_executed = self.engine.state.constraints.steps.used - steps_before;
        let settle = self.settle(ActionReport {
            class: ActionClass::Execution,
            steps_executed,
        })?;
        self.finish_action(
            action,
            &before,
            hash_before,
            events_before,
            settle,
            engine_outcome,
            engine_error,
        )
    }

    fn execute(&mut self, action: &RecordedAction) -> (EngineOutcome, Option<ExecError>) {
        let arch = self.engine.arch();
        let at = |raw: u64| ArchValue::new(raw, arch);
        match action {
            RecordedAction::WriteBytes { address, data } => {
                effect_result(self.engine.action_write_bytes(at(*address), data))
            }
            RecordedAction::Push { value } => effect_result(self.engine.action_push(at(*value))),
            RecordedAction::Pop => match self.engine.action_pop() {
                Ok(_) => (EngineOutcome::Effect, None),
                Err(error) => (effect_failed(&error), Some(error)),
            },
            RecordedAction::Call { target } => effect_result(self.engine.action_call(at(*target))),
            RecordedAction::Ret => effect_result(self.engine.action_ret()),
            RecordedAction::Step => run_outcome(self.engine.step()),
            RecordedAction::RunToEvent { pause_on } => {
                run_outcome(self.engine.run_to_event(*pause_on))
            }
            RecordedAction::Pause => {
                self.engine.pause();
                (EngineOutcome::Effect, None)
            }
            // 管理类动作不经本路径(apply 分派);防御性兜底按无操作计。
            _ => (EngineOutcome::Effect, None),
        }
    }

    // ── 管理类动作:undo / checkout / reset / create_checkpoint ──────────

    fn apply_undo(&mut self) -> Result<ActionReceipt, ApplyError> {
        if self.history.is_empty() {
            return Err(ApplyError::Rejected(RuntimeRejection::NothingToUndo));
        }
        self.check_rollback_budget()?;
        let before = self.capture_snapshot();
        let hash_before = state_hash_hex(&self.engine.state)?;
        let events_before = self.engine.state.private_event_log.len() as u64;
        let settle = self.settle(ActionReport {
            class: ActionClass::Management,
            steps_executed: 0,
        })?;
        // 内容回退、版本前进(§4.1):弹出栈顶;undo 自身不压栈——连续 undo
        // 沿内容时间线继续回退。settle 的阶段计数增量随恢复一并回退(规约 §4.6)。
        let target = self.history.pop().expect("空历史已在闸门拒绝");
        self.engine.restore_session(target.state, target.halted);
        self.judge.restore_stage(target.judge_stage);
        self.rollbacks_total += 1;
        self.finish_action(
            RecordedAction::Undo,
            &before,
            hash_before,
            events_before,
            settle,
            EngineOutcome::Effect,
            None,
        )
    }

    fn apply_checkout(&mut self, checkpoint_id: String) -> Result<ActionReceipt, ApplyError> {
        // 归属校验(6.3):本进程 checkpoint 表内解析。
        let target = match self.checkpoints.resolve(&checkpoint_id) {
            Some(checkpoint) => checkpoint.snapshot.clone(),
            None => {
                return Err(ApplyError::Rejected(RuntimeRejection::UnknownCheckpoint {
                    checkpoint_id,
                }));
            }
        };
        self.check_rollback_budget()?;
        let before = self.capture_snapshot();
        let hash_before = state_hash_hex(&self.engine.state)?;
        let events_before = self.engine.state.private_event_log.len() as u64;
        let settle = self.settle(ActionReport {
            class: ActionClass::Management,
            steps_executed: 0,
        })?;
        // 压当前快照(checkout 本身可被后续 undo 撤销),再恢复目标内容。
        self.history.push(before.clone());
        self.engine.restore_session(target.state, target.halted);
        self.judge.restore_stage(target.judge_stage);
        self.rollbacks_total += 1;
        self.finish_action(
            RecordedAction::CheckoutCheckpoint { checkpoint_id },
            &before,
            hash_before,
            events_before,
            settle,
            EngineOutcome::Effect,
            None,
        )
    }

    fn apply_reset(&mut self) -> Result<ActionReceipt, ApplyError> {
        self.check_rollback_budget()?;
        let before = self.capture_snapshot();
        let hash_before = state_hash_hex(&self.engine.state)?;
        let events_before = self.engine.state.private_event_log.len() as u64;
        let settle = self.settle(ActionReport {
            class: ActionClass::Management,
            steps_executed: 0,
        })?;
        self.history.push(before.clone());
        // reset 权威路径:引擎回初始状态(累计预算保留)+ 判题侧回初始阶段。
        self.engine.reset();
        self.judge.reset(&mut self.engine);
        self.rollbacks_total += 1;
        self.finish_action(
            RecordedAction::Reset,
            &before,
            hash_before,
            events_before,
            settle,
            EngineOutcome::Effect,
            None,
        )
    }

    fn apply_create_checkpoint(
        &mut self,
        label: Option<String>,
    ) -> Result<ActionReceipt, ApplyError> {
        // 标签形态复验(协议 §3.2:≤ 128 字符、拒绝 C0 / C1 控制字符)。
        if let Some(text) = &label
            && (text.len() > 128
                || text
                    .chars()
                    .any(|c| (c as u32) < 0x20 || (0x7F..=0x9F).contains(&(c as u32))))
        {
            return Err(ApplyError::Rejected(
                RuntimeRejection::InvalidCheckpointLabel,
            ));
        }
        let before = self.capture_snapshot();
        let hash = state_hash_hex(&self.engine.state)?;
        let events = self.engine.state.private_event_log.len() as u64;
        // 内容不变;settle 的阶段动作计数不被恢复覆盖(受理即计数)。
        let settle = self.settle(ActionReport {
            class: ActionClass::Management,
            steps_executed: 0,
        })?;
        self.history.push(before.clone());
        let mut receipt = self.finish_action(
            RecordedAction::CreateCheckpoint {
                label: label.clone(),
            },
            &before,
            hash.clone(),
            events,
            settle,
            EngineOutcome::Effect,
            None,
        )?;
        // 快照入表(签发确定性 ID;回执通道 = D-F7)。
        let snapshot = self.snapshot()?;
        let checkpoint = self
            .checkpoints
            .create(label.as_deref(), receipt.entry_index, snapshot)
            .map_err(RuntimeError::Form)?;
        receipt.checkpoint_id = Some(checkpoint.checkpoint_id.clone());
        Ok(receipt)
    }

    // ── 公共尾段:差分 → 日志 → revision ─────────────────────────────────

    /// 公共尾段:差分 → 日志 → revision。
    #[allow(clippy::too_many_arguments)] // 尾段参数为差分面固定七元组,拆分反损可读性
    fn finish_action(
        &mut self,
        action: RecordedAction,
        before: &SessionSnapshot,
        hash_before: String,
        events_before: u64,
        settle: SettleOutcome,
        engine_outcome: EngineOutcome,
        engine_error: Option<ExecError>,
    ) -> Result<ActionReceipt, ApplyError> {
        let hash_after = state_hash_hex(&self.engine.state)?;
        let register_changes = diff_registers(&before.state, &self.engine.state);
        let memory_changes = diff_memory(&before.state, &self.engine.state);
        let entry = ActionLogEntry {
            index: 0,
            action,
            revision_before: self.revision,
            revision_after: self.revision + 1,
            state_hash_before: hash_before,
            state_hash_after: hash_after.clone(),
            register_changes,
            memory_changes,
            event_seq_before: events_before,
            event_seq_after: self.engine.state.private_event_log.len() as u64,
            outcome: OutcomeRecord {
                engine: engine_outcome.clone(),
                judge: judge_outcome(&settle),
            },
        };
        self.log.append(entry).map_err(RuntimeError::Form)?;
        self.revision += 1;
        Ok(ActionReceipt {
            revision: self.revision,
            entry_index: self.log.len() as u64 - 1,
            engine: engine_outcome,
            judge: judge_outcome(&settle),
            engine_error,
            state_hash: hash_after,
            checkpoint_id: None,
        })
    }

    /// 检查点(settle;判题预算耗尽映射为安全终止方向故障)。
    fn settle(&mut self, report: ActionReport) -> Result<SettleOutcome, ApplyError> {
        self.judge
            .settle(&mut self.engine, report)
            .map_err(|error| {
                ApplyError::Fault(match error {
                    JudgeError::PredicateBudgetExhausted {
                        requested,
                        available,
                    } => RuntimeError::PredicateBudgetExhausted {
                        requested,
                        available,
                    },
                    JudgeError::Internal(_) => RuntimeError::JudgeInternal,
                })
            })
    }

    /// 回退累计预算(进程级反神谕兜底;`rollback_ops.limit` 为上限)。
    fn check_rollback_budget(&self) -> Result<(), ApplyError> {
        let limit = self.engine.state.constraints.rollback_ops.limit;
        let total = self.rollbacks_total + 1;
        if total > limit {
            return Err(ApplyError::Rejected(
                RuntimeRejection::RollbackBudgetExhausted { total, limit },
            ));
        }
        Ok(())
    }

    fn capture_snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            state: self.engine.state.clone(),
            judge_stage: self.judge.stage().cloned(),
            halted: self.engine.is_halted(),
            revision: self.revision,
        }
    }

    // ── 快照替换恢复(引擎进程协议 D-F8;编排器驱动归 WP-8)──────────────

    /// 导入规范化快照载荷并整体替换当前内容:恢复引擎状态(判题阶段 /
    /// `halted` / revision 随载荷),清空历史与 checkpoint 表,动作日志重开。
    ///
    /// 累计预算语义:交互回退(undo / checkout / reset)保留**当前**累计
    /// (D1 约束 5,防回退神谕);崩溃替换是同一逻辑会话的续命,累计预算自
    /// **快照**续算(否则恢复即成预算重置的后门)。回退累计计数为进程级
    /// 结构护栏,随新进程重开——其跨进程锚定归阶段三持久化(以重放日志复核)。
    pub fn replace_from_snapshot(
        &mut self,
        text: &str,
    ) -> Result<u64, crate::snapshot::SnapshotError> {
        let snapshot = crate::snapshot::import_snapshot(text, &self.engine.state, &self.identity)?;
        let carried_predicate_evals = snapshot.state.constraints.predicate_evals;
        self.engine.restore_session(snapshot.state, snapshot.halted);
        // restore_session 保留当前累计(交互回退语义);替换恢复改为快照续算。
        self.engine.state.constraints.predicate_evals = carried_predicate_evals;
        self.judge.restore_stage(snapshot.judge_stage);
        self.revision = snapshot.revision;
        self.history.clear();
        self.checkpoints.clear();
        self.rollbacks_total = 0;
        self.log = ActionLog::new(self.context.clone());
        Ok(self.revision)
    }

    /// 引擎身份引用(锁定复核面)。
    pub fn identity(&self) -> &EngineIdentity {
        &self.identity
    }

    /// 快照内容指纹(规范化形态的 SHA-256,64 hex;签发 / 导出同源)。
    pub fn snapshot_fingerprint(snapshot: &SessionSnapshot) -> Result<String, RuntimeError> {
        let text = crate::canon::write_canonical(&state_to_canonical(&snapshot.state)?)?;
        let mut hasher = Sha256::new();
        hasher.update(text.as_bytes());
        Ok(crate::sha256::hex(&hasher.finish()))
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 差分与结局映射
// ─────────────────────────────────────────────────────────────────────────────

fn effect_result(result: Result<(), ExecError>) -> (EngineOutcome, Option<ExecError>) {
    match result {
        Ok(()) => (EngineOutcome::Effect, None),
        Err(error) => (
            EngineOutcome::EffectFailed {
                reason: exec_error_tag(&error),
            },
            Some(error),
        ),
    }
}

fn effect_failed(error: &ExecError) -> EngineOutcome {
    EngineOutcome::EffectFailed {
        reason: exec_error_tag(error),
    }
}

fn run_outcome(outcome: RunOutcome) -> (EngineOutcome, Option<ExecError>) {
    match outcome {
        RunOutcome::Stepped => (EngineOutcome::Stepped, None),
        RunOutcome::Paused { on } => (EngineOutcome::Paused { on }, None),
        RunOutcome::Exited { code } => (EngineOutcome::Exited { code }, None),
        RunOutcome::Failed { error } => (
            EngineOutcome::Failed {
                reason: exec_error_tag(&error),
            },
            Some(error),
        ),
        RunOutcome::Halted => (EngineOutcome::Halted, None),
    }
}

/// 寄存器差分(两份寄存器文件名集相同、按键序遍历)。
fn diff_registers(before: &VmState, after: &VmState) -> Vec<crate::action_log::RegisterChange> {
    before
        .registers
        .iter()
        .zip(after.registers.iter())
        .filter(|((_, before_value), (_, after_value))| before_value != after_value)
        .map(
            |((name, from), (_, to))| crate::action_log::RegisterChange {
                name: String::from(name),
                from: from.get(),
                to: to.get(),
            },
        )
        .collect()
}

/// 内存差分:页存储身份相同 ⇒ 未变(共享即同内容,vm-core COW);身份不同
/// 逐字节比对,连续地址合并、按区域归属切分。
fn diff_memory(before: &VmState, after: &VmState) -> Vec<crate::action_log::MemoryChange> {
    let page_size = after.memory.page_size();
    let mut changed: Vec<(u64, u8)> = Vec::new();
    for page_no in after.memory.page_ids() {
        if before.memory.page_identity(page_no) == after.memory.page_identity(page_no) {
            continue;
        }
        let (Some(before_page), Some(after_page)) = (
            before.memory.page_bytes(page_no),
            after.memory.page_bytes(page_no),
        ) else {
            continue;
        };
        let page_base = page_no * page_size;
        for (offset, byte) in after_page.iter().enumerate() {
            if *byte != before_page[offset] {
                changed.push((page_base + offset as u64, *byte));
            }
        }
    }
    let mut changes: Vec<crate::action_log::MemoryChange> = Vec::new();
    let mut index = 0;
    while index < changed.len() {
        let (start, _) = changed[index];
        let region_id = after
            .memory
            .region_at(start)
            .map(|region| region.region_id.clone())
            .unwrap_or_default();
        let mut bytes = Vec::new();
        let mut expected = start;
        let mut cursor = index;
        while cursor < changed.len() {
            let (address, byte) = changed[cursor];
            let same_region = after
                .memory
                .region_at(address)
                .is_some_and(|region| region.region_id == region_id);
            if address != expected || !same_region {
                break;
            }
            bytes.push(byte);
            expected += 1;
            cursor += 1;
        }
        changes.push(crate::action_log::MemoryChange {
            region_id,
            start,
            bytes,
        });
        index = cursor;
    }
    changes
}

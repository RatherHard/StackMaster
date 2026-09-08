//! append-only 规范化动作日志(WP-6;计划书 6.3、版本策略 §三、会话动作协议
//! 语义 §4.1 / §5.1)。
//!
//! # 记录清单与 6.3 清单一一对应(完成标准)
//!
//! | 6.3 / 版本策略 §三 记录项 | 本模块字段 |
//! |---|---|
//! | 操作类型和参数 | [`ActionLogEntry::action`]([`RecordedAction`],12 动作判别式 + 参数) |
//! | 前后状态哈希(规范化序列化 + SHA-256) | [`ActionLogEntry::state_hash_before`] / [`_after`](ActionLogEntry::state_hash_after) |
//! | 内存 / 寄存器变化 | [`ActionLogEntry::memory_changes`] / [`register_changes`](ActionLogEntry::register_changes) |
//! | 事件序号 | [`ActionLogEntry::event_seq_before`] / [`_after`](ActionLogEntry::event_seq_after) |
//! | 题目版本 | [`ReplayContext::challenge_content_version`] |
//! | VM Profile(版本) | [`ReplayContext::vm_profile_version`](+ `vm_profile_hash`,§三 #2) |
//! | 引擎版本 | [`ReplayContext::vm_engine_version`](+ `engine_build_id`,§三 #3) |
//! | 题目包哈希(§三 #1) | [`ReplayContext::challenge_bundle_hash`] |
//! | 判题规则版本(§三 #4) | [`ReplayContext::verdict_rule_version`] |
//! | 随机种子策略(§三 #5;**不含 seed 值**) | [`ReplayContext::seed_policy`] |
//! | 规范化提交内容哈希(§三 #6) | [`ActionLog::hash_hex`] |
//!
//! # 语义
//!
//! - **append-only**:条目只追加;`undo` / `checkout_checkpoint` / `reset`
//!   本身也是条目(内容回退、版本前进,§4.1)——日志永远完整表达时间线;
//! - 拒绝动作**不**入日志(§4.1:进入执行前被拒绝,revision 不变);
//! - `submit` 引用本日志,verifier 以同一份回放实现重放(ADR-8);
//! - 序列化形态 [`ACTION_LOG_FORMAT_ID`] v1 = 规范化 JSON(§3.2 哈希输入)。

use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;

use vm_core::arch::ArchValue;
use vm_core::exec::ExecError;
use vm_core::judge::{FailureSource, SettleOutcome};
use vm_core::state::VmStatus;
use vm_core::{exec::PauseOn, judge::spec::SessionActionType};

use crate::canon::{CanonError, CanonValue, parse_canonical, write_canonical};
use crate::sha256::{hex, sha256};
use crate::state_form::{format_addr, format_bytes};

/// 动作日志序列化形态标识(v1)。
pub const ACTION_LOG_FORMAT_ID: &str = "stackmaster-action-log/1";

/// 回放上下文(每会话常量;版本策略 §三 #1–#5。**不含 seed 值**——
/// 只有策略与派生路径声明,6.3 / 9.2)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayContext {
    /// 题目标识。
    pub challenge_id: String,
    /// 题目内容版本(#4 类版本;记录项锚点)。
    pub challenge_content_version: String,
    /// VM Profile 版本。
    pub vm_profile_version: String,
    /// 引擎版本(锁定值;与自报一致,装载期复验)。
    pub vm_engine_version: String,
    /// 引擎构建 ID。
    pub engine_build_id: String,
    /// 判题规则版本(`judgingConfig.verdictRuleVersion`)。
    pub verdict_rule_version: String,
    /// 题目包哈希(§三 #1;编排器 / 装载层对原始字节计,此处承载登记值)。
    pub challenge_bundle_hash: String,
    /// VM Profile 哈希(§三 #2)。
    pub vm_profile_hash: String,
    /// 架构位宽(值层十六进制补齐宽度的来源)。
    pub arch_bits: u32,
    /// seed 策略元数据(§三 #5)。
    pub seed_policy: SeedReplayMeta,
}

/// seed 派生路径声明(**不含 seed 值**;judge::seed 的 `DerivationPathSummary`
/// 序列化形态)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivationMeta {
    /// 派生算法标识(如 `splitmix64-stream-v1`)。
    pub algorithm_id: String,
    /// 派生次数。
    pub draws: u64,
}

/// seed 策略回放元数据。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedReplayMeta {
    /// 策略:`fixed` / `server_random_per_session`。
    pub strategy: String,
    /// 派生路径(`fixed` 无派生 = `None`)。
    pub derivation: Option<DerivationMeta>,
}

/// 日志记录的引擎侧动作(12 动作判别式;参数为引擎形态——十六进制契约值
/// 已解析为数值 / 字节)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordedAction {
    /// `write_bytes`。
    WriteBytes {
        /// 目标地址。
        address: u64,
        /// 写入字节。
        data: Vec<u8>,
    },
    /// `push`。
    Push {
        /// 压栈值。
        value: u64,
    },
    /// `pop`。
    Pop,
    /// `call`。
    Call {
        /// 目标地址。
        target: u64,
    },
    /// `ret`。
    Ret,
    /// `step`。
    Step,
    /// `run_to_event`。
    RunToEvent {
        /// 暂停事件类别。
        pause_on: PauseOn,
    },
    /// `pause`。
    Pause,
    /// `undo`。
    Undo,
    /// `checkout_checkpoint`。
    CheckoutCheckpoint {
        /// 目标 checkpoint(worker 签发 ID)。
        checkpoint_id: String,
    },
    /// `reset`。
    Reset,
    /// `create_checkpoint`。
    CreateCheckpoint {
        /// 玩家自报标签(可选)。
        label: Option<String>,
    },
}

impl RecordedAction {
    /// 对应的会话动作枚举(gate 判定键)。
    pub fn action_type(&self) -> SessionActionType {
        match self {
            RecordedAction::WriteBytes { .. } => SessionActionType::WriteBytes,
            RecordedAction::Push { .. } => SessionActionType::Push,
            RecordedAction::Pop => SessionActionType::Pop,
            RecordedAction::Call { .. } => SessionActionType::Call,
            RecordedAction::Ret => SessionActionType::Ret,
            RecordedAction::Step => SessionActionType::Step,
            RecordedAction::RunToEvent { .. } => SessionActionType::RunToEvent,
            RecordedAction::Pause => SessionActionType::Pause,
            RecordedAction::Undo => SessionActionType::Undo,
            RecordedAction::CheckoutCheckpoint { .. } => SessionActionType::CheckoutCheckpoint,
            RecordedAction::Reset => SessionActionType::Reset,
            RecordedAction::CreateCheckpoint { .. } => SessionActionType::CreateCheckpoint,
        }
    }
}

/// 寄存器变化(值域内完整前后值;十六进制形态在序列化时按位宽补齐)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisterChange {
    /// 寄存器名。
    pub name: String,
    /// 前值。
    pub from: u64,
    /// 后值。
    pub to: u64,
}

/// 内存变化(连续字节区间合并;区域归属按写入地址解析)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryChange {
    /// 所在区域。
    pub region_id: String,
    /// 区间起始地址。
    pub start: u64,
    /// 写入后的区间字节。
    pub bytes: Vec<u8>,
}

/// 引擎结局(动作的执行层结果标签;reason 为 [`ExecError`] 码标签)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineOutcome {
    /// 单步完成。
    Stepped,
    /// 命中暂停事件。
    Paused {
        /// 暂停类别。
        on: PauseOn,
    },
    /// 程序 `exit`。
    Exited {
        /// 退出码。
        code: u64,
    },
    /// 执行异常(会话转终态 failed)。
    Failed {
        /// 异常码标签。
        reason: &'static str,
    },
    /// 无执行(已 halted / 终态)。
    Halted,
    /// 管理 / 数据动作效果完成。
    Effect,
    /// 数据动作被引擎拒绝(教学性失败;会话继续)。
    EffectFailed {
        /// 异常码标签。
        reason: &'static str,
    },
}

/// 判题结局(检查点产出标签;细节不入日志公开面——私有载荷由事件承载)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JudgeOutcome {
    /// 无终态、无迁移。
    Running,
    /// 成功条件达成(won)。
    Won,
    /// 失败条件触发(failed)。
    Failed {
        /// 失败来源标签。
        source: String,
    },
    /// 阶段迁移。
    StageEntered {
        /// 目标阶段索引。
        to_stage: usize,
    },
}

/// 动作结局记录(引擎 + 判题两轴;回放一致性比对字段之一)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutcomeRecord {
    /// 引擎结局。
    pub engine: EngineOutcome,
    /// 判题结局。
    pub judge: JudgeOutcome,
}

/// 单条日志条目(6.3 记录清单一一对应,见模块头表)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionLogEntry {
    /// 条目序(0 起,稠密;append-only)。
    pub index: u64,
    /// 操作类型与参数。
    pub action: RecordedAction,
    /// 前后 revision(单调;增量恒 +1)。
    pub revision_before: u64,
    /// 后置 revision。
    pub revision_after: u64,
    /// 前置状态哈希(规范化 + SHA-256,64 hex)。
    pub state_hash_before: String,
    /// 后置状态哈希。
    pub state_hash_after: String,
    /// 寄存器变化。
    pub register_changes: Vec<RegisterChange>,
    /// 内存变化。
    pub memory_changes: Vec<MemoryChange>,
    /// 前后私有事件序(事件序号记录项)。
    pub event_seq_before: u64,
    /// 后置事件序。
    pub event_seq_after: u64,
    /// 结局记录。
    pub outcome: OutcomeRecord,
}

/// 引擎异常码标签(日志与受控日志共用词表)。
pub fn exec_error_tag(error: &ExecError) -> &'static str {
    match error {
        ExecError::InvalidRip { .. } => "invalid_rip",
        ExecError::InvalidSyscallDispatch { .. } => "invalid_syscall_dispatch",
        ExecError::MemoryFault(_) => "memory_fault",
        ExecError::CanaryViolation { .. } => "canary_violation",
        ExecError::ResourceLimit(_) => "resource_limit",
        ExecError::InvariantBroken(_) => "invariant_broken",
    }
}

/// 判题失败来源标签。
pub fn failure_source_tag(source: &FailureSource) -> String {
    match source {
        FailureSource::ChallengeCondition(index) => alloc::format!("challenge_condition:{index}"),
        FailureSource::StageCondition { stage, condition } => {
            alloc::format!("stage_condition:{stage}:{condition}")
        }
        FailureSource::StageStepBudget { stage } => alloc::format!("stage_step_budget:{stage}"),
    }
}

/// 判题结局映射(settle 产出 → 日志标签)。
pub fn judge_outcome(outcome: &SettleOutcome) -> JudgeOutcome {
    match outcome {
        SettleOutcome::Running => JudgeOutcome::Running,
        SettleOutcome::Won => JudgeOutcome::Won,
        SettleOutcome::Failed { source } => JudgeOutcome::Failed {
            source: failure_source_tag(source),
        },
        SettleOutcome::StageEntered { to_stage } => JudgeOutcome::StageEntered {
            to_stage: *to_stage,
        },
    }
}

/// 会话状态 → 判题结局标签(状态兜底:终态会话管理动作的结局记录)。
pub fn status_outcome(status: VmStatus) -> JudgeOutcome {
    match status {
        VmStatus::Won => JudgeOutcome::Won,
        VmStatus::Failed => JudgeOutcome::Failed {
            source: String::from("session_status"),
        },
        _ => JudgeOutcome::Running,
    }
}

/// append-only 动作日志(上下文 + 稠密条目序列)。
#[derive(Debug, Clone)]
pub struct ActionLog {
    /// 回放上下文(会话常量)。
    pub context: ReplayContext,
    entries: Vec<ActionLogEntry>,
}

/// 日志形态错误(方向 = challenge_invalid:日志是不可信入站时)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogFormError {
    /// 规范化 JSON 语法失败。
    Canon(CanonError),
    /// 形态标识不符或字段形态非法。
    FormMismatch(&'static str),
}

impl From<CanonError> for LogFormError {
    fn from(value: CanonError) -> Self {
        LogFormError::Canon(value)
    }
}

/// 十六进制字节序列解析(`state_form` 值层规则的日志侧入口)。
fn parse_bytes_arg(text: &str) -> Result<Vec<u8>, LogFormError> {
    crate::state_form::parse_bytes_hex(text, "bytes_hex")
        .map_err(|_| LogFormError::FormMismatch("bytes_hex"))
}

/// 对象字段读取(形态错误统一 `FormMismatch`)。
fn canon_field<'a>(
    pairs: &'a [(String, CanonValue)],
    key: &str,
) -> Result<&'a CanonValue, LogFormError> {
    pairs
        .iter()
        .find(|(existing, _)| existing == key)
        .map(|(_, value)| value)
        .ok_or(LogFormError::FormMismatch("missing_field"))
}

/// 非负整数字段。
fn canon_u64(pairs: &[(String, CanonValue)], key: &'static str) -> Result<u64, LogFormError> {
    match canon_field(pairs, key)? {
        CanonValue::Int(number) if *number >= 0 => Ok(*number as u64),
        _ => Err(LogFormError::FormMismatch(key)),
    }
}

/// 字符串字段。
fn canon_text(pairs: &[(String, CanonValue)], key: &'static str) -> Result<String, LogFormError> {
    match canon_field(pairs, key)? {
        CanonValue::Str(text) => Ok(text.clone()),
        _ => Err(LogFormError::FormMismatch(key)),
    }
}

impl ActionLog {
    /// 以回放上下文开日志(空)。
    pub fn new(context: ReplayContext) -> Self {
        Self {
            context,
            entries: Vec::new(),
        }
    }

    /// 条目数。
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 是否为空。
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 条目(append-only 只读视图)。
    pub fn entries(&self) -> &[ActionLogEntry] {
        &self.entries
    }

    /// 条目可变视图(**读回日志的修复面**——测试与 verifier 工具在解析副本上
    /// 做篡改 / 标注;运行时会话内的日志只经 [`ActionLog::append`] 追加,
    /// append-only 语义不受影响)。
    pub fn entries_mut(&mut self) -> &mut Vec<ActionLogEntry> {
        &mut self.entries
    }

    /// 追加条目(index = 当前长度;序列化合法先验,失败则拒绝入账)。
    pub fn append(&mut self, mut entry: ActionLogEntry) -> Result<(), CanonError> {
        entry.index = self.entries.len() as u64;
        // 序列化先验:越界值(超安全整数域)在入账前拒绝,日志永远可序列化。
        self.entry_to_canonical(&entry)?;
        self.entries.push(entry);
        Ok(())
    }

    fn arch(&self) -> vm_core::arch::ArchBits {
        vm_core::arch::ArchBits::from_bits(self.context.arch_bits)
            .unwrap_or(vm_core::arch::ArchBits::B64)
    }

    // ── 序列化(stackmaster-action-log/1)─────────────────────────────────

    fn action_to_canonical(&self, action: &RecordedAction) -> Result<CanonValue, CanonError> {
        let arch = self.arch();
        let hex_of = |raw: u64| format_addr(ArchValue::new(raw, arch), arch);
        let (kind, args): (&str, CanonValue) = match action {
            RecordedAction::WriteBytes { address, data } => (
                "write_bytes",
                CanonValue::object(vec![
                    ("addressHex", CanonValue::Str(hex_of(*address))),
                    ("bytesHex", CanonValue::Str(format_bytes(data))),
                ])?,
            ),
            RecordedAction::Push { value } => (
                "push",
                CanonValue::object(vec![("valueHex", CanonValue::Str(hex_of(*value)))])?,
            ),
            RecordedAction::Pop => ("pop", CanonValue::object(alloc::vec![])?),
            RecordedAction::Call { target } => (
                "call",
                CanonValue::object(vec![("targetHex", CanonValue::Str(hex_of(*target)))])?,
            ),
            RecordedAction::Ret => ("ret", CanonValue::object(alloc::vec![])?),
            RecordedAction::Step => ("step", CanonValue::object(alloc::vec![])?),
            RecordedAction::RunToEvent { pause_on } => (
                "run_to_event",
                CanonValue::object(vec![("pauseOn", CanonValue::str(pause_on.as_str()))])?,
            ),
            RecordedAction::Pause => ("pause", CanonValue::object(alloc::vec![])?),
            RecordedAction::Undo => ("undo", CanonValue::object(alloc::vec![])?),
            RecordedAction::CheckoutCheckpoint { checkpoint_id } => (
                "checkout_checkpoint",
                CanonValue::object(vec![(
                    "checkpointId",
                    CanonValue::Str(checkpoint_id.clone()),
                )])?,
            ),
            RecordedAction::Reset => ("reset", CanonValue::object(alloc::vec![])?),
            RecordedAction::CreateCheckpoint { label } => (
                "create_checkpoint",
                CanonValue::object(vec![(
                    "label",
                    match label {
                        Some(text) => CanonValue::Str(text.clone()),
                        None => CanonValue::Null,
                    },
                )])?,
            ),
        };
        CanonValue::object(vec![("args", args), ("type", CanonValue::str(kind))])
    }

    fn action_from_canonical(&self, value: &CanonValue) -> Result<RecordedAction, LogFormError> {
        let arch = self.arch();
        let parse_hex = |text: &str| -> Result<u64, LogFormError> {
            ArchValue::parse_hex(text, arch)
                .map(ArchValue::get)
                .map_err(|_| LogFormError::FormMismatch("hex_value"))
        };
        let pairs = match value {
            CanonValue::Object(pairs) => pairs,
            _ => return Err(LogFormError::FormMismatch("action")),
        };
        let kind = match pairs.iter().find(|(key, _)| key == "type") {
            Some((_, CanonValue::Str(text))) => text.as_str(),
            _ => return Err(LogFormError::FormMismatch("action_type")),
        };
        let args = match pairs.iter().find(|(key, _)| key == "args") {
            Some((_, CanonValue::Object(pairs))) => pairs,
            _ => return Err(LogFormError::FormMismatch("action_args")),
        };
        let string_arg = |key: &'static str| -> Result<String, LogFormError> {
            match canon_field(args, key)? {
                CanonValue::Str(text) => Ok(text.clone()),
                _ => Err(LogFormError::FormMismatch(key)),
            }
        };
        Ok(match kind {
            "write_bytes" => RecordedAction::WriteBytes {
                address: parse_hex(&string_arg("addressHex")?)?,
                data: parse_bytes_arg(&string_arg("bytesHex")?)?,
            },
            "push" => RecordedAction::Push {
                value: parse_hex(&string_arg("valueHex")?)?,
            },
            "pop" => RecordedAction::Pop,
            "call" => RecordedAction::Call {
                target: parse_hex(&string_arg("targetHex")?)?,
            },
            "ret" => RecordedAction::Ret,
            "step" => RecordedAction::Step,
            "run_to_event" => RecordedAction::RunToEvent {
                pause_on: PauseOn::parse(&string_arg("pauseOn")?)
                    .ok_or(LogFormError::FormMismatch("pause_on"))?,
            },
            "pause" => RecordedAction::Pause,
            "undo" => RecordedAction::Undo,
            "checkout_checkpoint" => RecordedAction::CheckoutCheckpoint {
                checkpoint_id: string_arg("checkpointId")?,
            },
            "reset" => RecordedAction::Reset,
            "create_checkpoint" => {
                let label = match canon_field(args, "label")? {
                    CanonValue::Null => None,
                    CanonValue::Str(text) => Some(text.clone()),
                    _ => return Err(LogFormError::FormMismatch("action_args")),
                };
                RecordedAction::CreateCheckpoint { label }
            }
            _ => return Err(LogFormError::FormMismatch("action_type")),
        })
    }

    fn entry_to_canonical(&self, entry: &ActionLogEntry) -> Result<CanonValue, CanonError> {
        let arch = self.arch();
        let hex_of = |raw: u64| format_addr(ArchValue::new(raw, arch), arch);
        let mut register_changes = Vec::new();
        for change in &entry.register_changes {
            register_changes.push(CanonValue::object(vec![
                ("from", CanonValue::Str(hex_of(change.from))),
                ("name", CanonValue::Str(change.name.clone())),
                ("to", CanonValue::Str(hex_of(change.to))),
            ])?);
        }
        let mut memory_changes = Vec::new();
        for change in &entry.memory_changes {
            memory_changes.push(CanonValue::object(vec![
                ("bytesHex", CanonValue::Str(format_bytes(&change.bytes))),
                ("regionId", CanonValue::Str(change.region_id.clone())),
                ("startHex", CanonValue::Str(hex_of(change.start))),
            ])?);
        }
        let engine = match &entry.outcome.engine {
            EngineOutcome::Stepped => CanonValue::str("stepped"),
            EngineOutcome::Paused { on } => CanonValue::object(vec![
                ("on", CanonValue::str(on.as_str())),
                ("tag", CanonValue::str("paused")),
            ])?,
            EngineOutcome::Exited { code } => CanonValue::object(vec![
                ("code", CanonValue::from_u64(*code)?),
                ("tag", CanonValue::str("exited")),
            ])?,
            EngineOutcome::Failed { reason } => CanonValue::object(vec![
                ("reason", CanonValue::str(reason)),
                ("tag", CanonValue::str("failed")),
            ])?,
            EngineOutcome::Halted => CanonValue::str("halted"),
            EngineOutcome::Effect => CanonValue::str("effect"),
            EngineOutcome::EffectFailed { reason } => CanonValue::object(vec![
                ("reason", CanonValue::str(reason)),
                ("tag", CanonValue::str("effect_failed")),
            ])?,
        };
        let judge = match &entry.outcome.judge {
            JudgeOutcome::Running => CanonValue::str("running"),
            JudgeOutcome::Won => CanonValue::str("won"),
            JudgeOutcome::Failed { source } => CanonValue::object(vec![
                ("source", CanonValue::Str(source.clone())),
                ("tag", CanonValue::str("failed")),
            ])?,
            JudgeOutcome::StageEntered { to_stage } => CanonValue::object(vec![
                ("tag", CanonValue::str("stage_entered")),
                ("toStage", CanonValue::from_u64(*to_stage as u64)?),
            ])?,
        };
        CanonValue::object(vec![
            ("action", self.action_to_canonical(&entry.action)?),
            (
                "eventSeqAfter",
                CanonValue::from_u64(entry.event_seq_after)?,
            ),
            (
                "eventSeqBefore",
                CanonValue::from_u64(entry.event_seq_before)?,
            ),
            ("index", CanonValue::from_u64(entry.index)?),
            ("memoryChanges", CanonValue::Array(memory_changes)),
            (
                "outcome",
                CanonValue::object(vec![("engine", engine), ("judge", judge)])?,
            ),
            ("registerChanges", CanonValue::Array(register_changes)),
            ("revisionAfter", CanonValue::from_u64(entry.revision_after)?),
            (
                "revisionBefore",
                CanonValue::from_u64(entry.revision_before)?,
            ),
            (
                "stateHashAfter",
                CanonValue::Str(entry.state_hash_after.clone()),
            ),
            (
                "stateHashBefore",
                CanonValue::Str(entry.state_hash_before.clone()),
            ),
        ])
    }

    #[allow(clippy::too_many_lines)]
    fn entry_from_canonical(&self, value: &CanonValue) -> Result<ActionLogEntry, LogFormError> {
        let pairs = match value {
            CanonValue::Object(pairs) => pairs,
            _ => return Err(LogFormError::FormMismatch("entry")),
        };
        let action = self.action_from_canonical(canon_field(pairs, "action")?)?;
        let outcome_pairs = match canon_field(pairs, "outcome")? {
            CanonValue::Object(pairs) => pairs,
            _ => return Err(LogFormError::FormMismatch("outcome")),
        };
        let engine = match canon_field(outcome_pairs, "engine")? {
            CanonValue::Str(text) => match text.as_str() {
                "stepped" => EngineOutcome::Stepped,
                "halted" => EngineOutcome::Halted,
                "effect" => EngineOutcome::Effect,
                _ => return Err(LogFormError::FormMismatch("engine_outcome")),
            },
            CanonValue::Object(fields) => {
                let tag = match fields.iter().find(|(key, _)| key == "tag") {
                    Some((_, CanonValue::Str(text))) => text.as_str(),
                    _ => return Err(LogFormError::FormMismatch("engine_outcome")),
                };
                match tag {
                    "paused" => EngineOutcome::Paused {
                        on: PauseOn::parse(&{
                            match fields.iter().find(|(key, _)| key == "on") {
                                Some((_, CanonValue::Str(text))) => text.clone(),
                                _ => return Err(LogFormError::FormMismatch("engine_outcome")),
                            }
                        })
                        .ok_or(LogFormError::FormMismatch("engine_outcome"))?,
                    },
                    "exited" => EngineOutcome::Exited {
                        code: match fields.iter().find(|(key, _)| key == "code") {
                            Some((_, CanonValue::Int(number))) if *number >= 0 => *number as u64,
                            _ => return Err(LogFormError::FormMismatch("engine_outcome")),
                        },
                    },
                    "failed" | "effect_failed" => {
                        let reason: &'static str =
                            match fields.iter().find(|(key, _)| key == "reason") {
                                Some((_, CanonValue::Str(text))) => match text.as_str() {
                                    "invalid_rip" => "invalid_rip",
                                    "invalid_syscall_dispatch" => "invalid_syscall_dispatch",
                                    "memory_fault" => "memory_fault",
                                    "canary_violation" => "canary_violation",
                                    "resource_limit" => "resource_limit",
                                    "invariant_broken" => "invariant_broken",
                                    _ => return Err(LogFormError::FormMismatch("engine_outcome")),
                                },
                                _ => return Err(LogFormError::FormMismatch("engine_outcome")),
                            };
                        if tag == "failed" {
                            EngineOutcome::Failed { reason }
                        } else {
                            EngineOutcome::EffectFailed { reason }
                        }
                    }
                    _ => return Err(LogFormError::FormMismatch("engine_outcome")),
                }
            }
            _ => return Err(LogFormError::FormMismatch("engine_outcome")),
        };
        let judge = match canon_field(outcome_pairs, "judge")? {
            CanonValue::Str(text) => match text.as_str() {
                "running" => JudgeOutcome::Running,
                "won" => JudgeOutcome::Won,
                _ => return Err(LogFormError::FormMismatch("judge_outcome")),
            },
            CanonValue::Object(fields) => {
                let tag = match fields.iter().find(|(key, _)| key == "tag") {
                    Some((_, CanonValue::Str(text))) => text.as_str(),
                    _ => return Err(LogFormError::FormMismatch("judge_outcome")),
                };
                match tag {
                    "failed" => JudgeOutcome::Failed {
                        source: match fields.iter().find(|(key, _)| key == "source") {
                            Some((_, CanonValue::Str(text))) => text.clone(),
                            _ => return Err(LogFormError::FormMismatch("judge_outcome")),
                        },
                    },
                    "stage_entered" => JudgeOutcome::StageEntered {
                        to_stage: match fields.iter().find(|(key, _)| key == "toStage") {
                            Some((_, CanonValue::Int(number))) if *number >= 0 => *number as usize,
                            _ => return Err(LogFormError::FormMismatch("judge_outcome")),
                        },
                    },
                    _ => return Err(LogFormError::FormMismatch("judge_outcome")),
                }
            }
            _ => return Err(LogFormError::FormMismatch("judge_outcome")),
        };
        let mut register_changes = Vec::new();
        for item in match canon_field(pairs, "registerChanges")? {
            CanonValue::Array(items) => items,
            _ => return Err(LogFormError::FormMismatch("registerChanges")),
        } {
            let fields = match item {
                CanonValue::Object(pairs) => pairs,
                _ => return Err(LogFormError::FormMismatch("registerChanges")),
            };
            let hex_value = |key: &str| -> Result<u64, LogFormError> {
                match canon_field(fields, key)? {
                    CanonValue::Str(text) => ArchValue::parse_hex(text, self.arch())
                        .map(ArchValue::get)
                        .map_err(|_| LogFormError::FormMismatch("register_change")),
                    _ => Err(LogFormError::FormMismatch("register_change")),
                }
            };
            register_changes.push(RegisterChange {
                name: canon_text(fields, "name")?,
                from: hex_value("from")?,
                to: hex_value("to")?,
            });
        }
        let mut memory_changes = Vec::new();
        for item in match canon_field(pairs, "memoryChanges")? {
            CanonValue::Array(items) => items,
            _ => return Err(LogFormError::FormMismatch("memoryChanges")),
        } {
            let fields = match item {
                CanonValue::Object(pairs) => pairs,
                _ => return Err(LogFormError::FormMismatch("memoryChanges")),
            };
            memory_changes.push(MemoryChange {
                region_id: canon_text(fields, "regionId")?,
                start: match canon_field(fields, "startHex")? {
                    CanonValue::Str(text) => ArchValue::parse_hex(text, self.arch())
                        .map(ArchValue::get)
                        .map_err(|_| LogFormError::FormMismatch("memory_change"))?,
                    _ => return Err(LogFormError::FormMismatch("memory_change")),
                },
                bytes: parse_bytes_arg(&canon_text(fields, "bytesHex")?)?,
            });
        }
        Ok(ActionLogEntry {
            index: canon_u64(pairs, "index")?,
            action,
            revision_before: canon_u64(pairs, "revisionBefore")?,
            revision_after: canon_u64(pairs, "revisionAfter")?,
            state_hash_before: canon_text(pairs, "stateHashBefore")?,
            state_hash_after: canon_text(pairs, "stateHashAfter")?,
            register_changes,
            memory_changes,
            event_seq_before: canon_u64(pairs, "eventSeqBefore")?,
            event_seq_after: canon_u64(pairs, "eventSeqAfter")?,
            outcome: OutcomeRecord { engine, judge },
        })
    }

    fn context_to_canonical(&self) -> Result<CanonValue, CanonError> {
        let context = &self.context;
        let derivation = match &context.seed_policy.derivation {
            Some(meta) => CanonValue::object(vec![
                ("algorithmId", CanonValue::Str(meta.algorithm_id.clone())),
                ("draws", CanonValue::from_u64(meta.draws)?),
            ])?,
            None => CanonValue::Null,
        };
        CanonValue::object(vec![
            ("archBits", CanonValue::int(i64::from(context.arch_bits))?),
            (
                "challengeBundleHash",
                CanonValue::Str(context.challenge_bundle_hash.clone()),
            ),
            (
                "challengeContentVersion",
                CanonValue::Str(context.challenge_content_version.clone()),
            ),
            ("challengeId", CanonValue::Str(context.challenge_id.clone())),
            (
                "engineBuildId",
                CanonValue::Str(context.engine_build_id.clone()),
            ),
            (
                "seedPolicy",
                CanonValue::object(vec![
                    ("derivation", derivation),
                    (
                        "strategy",
                        CanonValue::Str(context.seed_policy.strategy.clone()),
                    ),
                ])?,
            ),
            (
                "vmEngineVersion",
                CanonValue::Str(context.vm_engine_version.clone()),
            ),
            (
                "vmProfileHash",
                CanonValue::Str(context.vm_profile_hash.clone()),
            ),
            (
                "vmProfileVersion",
                CanonValue::Str(context.vm_profile_version.clone()),
            ),
            (
                "verdictRuleVersion",
                CanonValue::Str(context.verdict_rule_version.clone()),
            ),
        ])
    }

    /// 完整日志 → 规范化文本(`ACTION_LOG_FORMAT_ID` v1)。
    pub fn canonical_text(&self) -> Result<String, CanonError> {
        let mut entries = Vec::with_capacity(self.entries.len());
        for entry in &self.entries {
            entries.push(self.entry_to_canonical(entry)?);
        }
        let value = CanonValue::object(vec![
            ("context", self.context_to_canonical()?),
            ("entries", CanonValue::Array(entries)),
            ("format", CanonValue::str(ACTION_LOG_FORMAT_ID)),
        ])?;
        write_canonical(&value)
    }

    /// 规范化提交内容哈希(版本策略 §三 #6:规范化序列化 + SHA-256,64 hex)。
    pub fn hash_hex(&self) -> Result<String, CanonError> {
        Ok(hex(&sha256(self.canonical_text()?.as_bytes())))
    }

    /// 从规范化值树重建(读回路径;verifier 持久化日志的进程内消费面)。
    pub fn from_canonical(value: &CanonValue) -> Result<Self, LogFormError> {
        let pairs = match value {
            CanonValue::Object(pairs) => pairs,
            _ => return Err(LogFormError::FormMismatch("log")),
        };
        match canon_field(pairs, "format")? {
            CanonValue::Str(text) if text == ACTION_LOG_FORMAT_ID => {}
            _ => return Err(LogFormError::FormMismatch("format")),
        }
        let context_pairs = match canon_field(pairs, "context")? {
            CanonValue::Object(pairs) => pairs,
            _ => return Err(LogFormError::FormMismatch("context")),
        };
        let text_field =
            |key: &'static str| -> Result<String, LogFormError> { canon_text(context_pairs, key) };
        let arch_bits = match canon_field(context_pairs, "archBits")? {
            CanonValue::Int(number) if *number == 32 || *number == 64 => *number as u32,
            _ => return Err(LogFormError::FormMismatch("archBits")),
        };
        let seed_pairs = match canon_field(context_pairs, "seedPolicy")? {
            CanonValue::Object(pairs) => pairs,
            _ => return Err(LogFormError::FormMismatch("seedPolicy")),
        };
        let strategy = match seed_pairs.iter().find(|(key, _)| key == "strategy") {
            Some((_, CanonValue::Str(text)))
                if text == "fixed" || text == "server_random_per_session" =>
            {
                text.clone()
            }
            _ => return Err(LogFormError::FormMismatch("seedPolicy")),
        };
        let derivation = match seed_pairs.iter().find(|(key, _)| key == "derivation") {
            Some((_, CanonValue::Null)) => None,
            Some((_, CanonValue::Object(fields))) => {
                let algorithm = match fields.iter().find(|(key, _)| key == "algorithmId") {
                    Some((_, CanonValue::Str(text))) => text.clone(),
                    _ => return Err(LogFormError::FormMismatch("seedPolicy")),
                };
                let draws = match fields.iter().find(|(key, _)| key == "draws") {
                    Some((_, CanonValue::Int(number))) if *number >= 0 => *number as u64,
                    _ => return Err(LogFormError::FormMismatch("seedPolicy")),
                };
                Some(DerivationMeta {
                    algorithm_id: algorithm,
                    draws,
                })
            }
            _ => return Err(LogFormError::FormMismatch("seedPolicy")),
        };
        let context = ReplayContext {
            challenge_id: text_field("challengeId")?,
            challenge_content_version: text_field("challengeContentVersion")?,
            vm_profile_version: text_field("vmProfileVersion")?,
            vm_engine_version: text_field("vmEngineVersion")?,
            engine_build_id: text_field("engineBuildId")?,
            verdict_rule_version: text_field("verdictRuleVersion")?,
            challenge_bundle_hash: text_field("challengeBundleHash")?,
            vm_profile_hash: text_field("vmProfileHash")?,
            arch_bits,
            seed_policy: SeedReplayMeta {
                strategy,
                derivation,
            },
        };
        let reader = Self::new(context.clone());
        let mut log = Self {
            context,
            entries: Vec::new(),
        };
        let items = match canon_field(pairs, "entries")? {
            CanonValue::Array(items) => items,
            _ => return Err(LogFormError::FormMismatch("entries")),
        };
        for item in items {
            let mut entry = reader.entry_from_canonical(item)?;
            entry.index = log.entries.len() as u64;
            log.entries.push(entry);
        }
        Ok(log)
    }

    /// 从规范化文本重建。
    pub fn from_canonical_text(text: &str) -> Result<Self, LogFormError> {
        Self::from_canonical(&parse_canonical(text)?)
    }
}

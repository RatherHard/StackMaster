//! 会话快照与 checkpoint(WP-6;计划书 6.3、引擎进程协议 §四 D-F5 / D-F8、
//! 判题语义规约 §一"快照须承载判题状态与 seed 派生元数据")。
//!
//! # 快照的 COW 承载
//!
//! [`SessionSnapshot`] 持有一份 `VmState` 克隆 + 判题阶段运行时状态 +
//! `halted` 标记 + revision。页存储经 vm-core 的 `Rc` COW:克隆与当前状态
//! 共享全部页,后续写入按页复制——快照创建 O(脏页),内存增长有界(有界性
//! 测试见集成测试;事件日志为深拷贝,已知 MVP 界,见模块尾注)。
//!
//! # checkpoint
//!
//! `create_checkpoint` 动作的服务端落点:快照入本进程 checkpoint 表,
//! `checkpointId` 由 worker 签发(引擎进程协议 D-F7)——**确定性签发**:
//! `cp-{签发序}-{内容指纹 16 hex}`,内容指纹 = SHA-256(快照规范化形态)。
//! 归属校验(6.3)= `checkout_checkpoint` 时在本进程表内解析;解析不到即
//! 确定性拒绝。
//!
//! # 导出 / 导入(阶段三持久化的对接面;引擎进程协议 §四)
//!
//! 载荷形态 [`SNAPSHOT_FORM_ID`] v1:规范化 JSON(`form` + 引擎双版本绑定 +
//! revision + halted + 判题阶段 + 状态段)。信封(`snapshotFormatVersion` /
//! 双版本 / `payload` 为对象)由 worker 协议层校验;本模块负责载荷形态、
//! 版本绑定复验与状态重建(以当前装载布局为锚)。
//!
//! # 快照替换恢复
//!
//! worker 崩溃后编排器按序 load → import_snapshot(引擎进程协议 D-F8);
//! [`import_snapshot`] 即恢复原语:重建内容状态(含判题阶段与 `halted`),
//! 旧进程的 history / checkpoint 随进程消失(协议 §4.7 如实记录的退化)。

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec;
use alloc::vec::Vec;

use vm_core::judge::StageState;
use vm_core::state::VmState;

use crate::canon::{CanonError, CanonValue, parse_canonical, write_canonical};
use crate::identity::{EngineIdentity, VersionLockError, verify_bundle_lock};
use crate::sha256::{hex, sha256};
use crate::state_form::{StateFormError, state_from_canonical, state_to_canonical};

/// 快照载荷形态标识(v1;形态变更 = 引擎语义变更,联动 `vmEngineVersion`)。
pub const SNAPSHOT_FORM_ID: &str = "stackmaster-session-snapshot/1";

/// 会话内容快照(COW 页共享;恢复目标)。
#[derive(Debug, Clone)]
pub struct SessionSnapshot {
    /// 内容状态(冻结 8 字段)。
    pub state: VmState,
    /// 判题阶段运行时状态(`None` = 单阶段题;随快照回退——规约 §4.6)。
    pub judge_stage: Option<StageState>,
    /// 程序已 `exit` 标记(随快照回退;undo 可撤销一次已发生的 exit)。
    pub halted: bool,
    /// 快照点的权威 revision(内容版本;恢复后新动作在其上继续 +1)。
    pub revision: u64,
}

/// checkpoint 引用(服务端签发;公开面字段:`checkpointId` / `label` /
/// `contentRevision` 与编排器 list-checkpoints 账本同源,引擎内持有内容)。
#[derive(Debug, Clone)]
pub struct Checkpoint {
    /// 服务端签发的确定性标识。
    pub checkpoint_id: String,
    /// 玩家自报标签(可选)。
    pub label: Option<String>,
    /// 内容 revision(创建时的权威 revision)。
    pub content_revision: u64,
    /// 创建时的日志条目序(时间线定位)。
    pub entry_index: u64,
    /// 内容快照。
    pub snapshot: SessionSnapshot,
}

/// checkpoint 表(单进程单会话;崩溃后随进程消失)。
#[derive(Debug, Default)]
pub struct CheckpointStore {
    items: Vec<Checkpoint>,
    issued: u64,
}

impl CheckpointStore {
    /// 签发:确定性 ID = `cp-{签发序}-{内容指纹 16 hex}`(服务端标识符字符集
    /// `^[A-Za-z0-9_-]{1,128}$`);同内容重复创建也因签发序而 ID 唯一。
    pub fn create(
        &mut self,
        label: Option<&str>,
        entry_index: u64,
        snapshot: SessionSnapshot,
    ) -> Result<Checkpoint, CanonError> {
        self.issued += 1;
        let fingerprint =
            hex(&sha256(canonical_fingerprint(&snapshot)?.as_bytes()))[..16].to_string();
        let checkpoint_id = format!("cp-{:04}-{}", self.issued, fingerprint);
        let checkpoint = Checkpoint {
            checkpoint_id,
            label: label.map(String::from),
            content_revision: snapshot.revision,
            entry_index,
            snapshot,
        };
        self.items.push(checkpoint.clone());
        Ok(checkpoint)
    }

    /// 归属解析(6.3:checkout 前的服务端校验):本进程表内按 ID 查找。
    pub fn resolve(&self, checkpoint_id: &str) -> Option<&Checkpoint> {
        self.items
            .iter()
            .find(|item| item.checkpoint_id == checkpoint_id)
    }

    /// 全部引用(创建顺序;编排器 list-checkpoints 账本的数据源)。
    pub fn items(&self) -> &[Checkpoint] {
        &self.items
    }

    /// 表内数量。
    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// 是否为空。
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// 清空(快照替换恢复:旧 checkpoint 引用随进程消失,协议 §4.7)。
    pub fn clear(&mut self) {
        self.items.clear();
        self.issued = 0;
    }
}

impl Clone for CheckpointStore {
    fn clone(&self) -> Self {
        Self {
            items: self.items.clone(),
            issued: self.issued,
        }
    }
}

/// 快照内容指纹输入(签发与导出共用同一规范化形态)。
fn canonical_fingerprint(snapshot: &SessionSnapshot) -> Result<String, CanonError> {
    write_canonical(&snapshot_to_canonical(snapshot)?)
}

/// 快照 → 规范化载荷值树(`SNAPSHOT_FORM_ID` v1)。
pub fn snapshot_to_canonical(snapshot: &SessionSnapshot) -> Result<CanonValue, CanonError> {
    CanonValue::object(vec![
        ("form", CanonValue::str(SNAPSHOT_FORM_ID)),
        ("halted", CanonValue::Bool(snapshot.halted)),
        (
            "judgeStage",
            match &snapshot.judge_stage {
                Some(stage) => CanonValue::object(vec![
                    ("actionsUsed", CanonValue::from_u64(stage.actions_used)?),
                    ("index", CanonValue::from_u64(stage.index as u64)?),
                    ("stepsUsed", CanonValue::from_u64(stage.steps_used)?),
                ])?,
                None => CanonValue::Null,
            },
        ),
        ("revision", CanonValue::from_u64(snapshot.revision)?),
        ("state", state_to_canonical(&snapshot.state)?),
    ])
}

/// 快照载荷错误(方向 = challenge_invalid;导入侧)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotError {
    /// 规范化 JSON 语法 / 形态失败。
    Canon(CanonError),
    /// 形态标识不符或字段形态非法。
    FormMismatch(&'static str),
    /// 状态段重建失败(布局锚定不符)。
    State(StateFormError),
    /// 引擎版本绑定不一致(版本策略 §四)。
    Version(VersionLockError),
}

impl From<CanonError> for SnapshotError {
    fn from(value: CanonError) -> Self {
        SnapshotError::Canon(value)
    }
}

impl From<StateFormError> for SnapshotError {
    fn from(value: StateFormError) -> Self {
        SnapshotError::State(value)
    }
}

/// 导出:快照 → 规范化载荷文本(阶段三持久化的落盘形态;sha256 摘要可另计)。
pub fn export_snapshot(
    snapshot: &SessionSnapshot,
    identity: &EngineIdentity,
) -> Result<String, CanonError> {
    let mut value = snapshot_to_canonical(snapshot)?;
    let CanonValue::Object(pairs) = &mut value else {
        return Err(CanonError::Malformed);
    };
    pairs.push((
        String::from("engineBuildId"),
        CanonValue::Str(identity.engine_build_id.clone()),
    ));
    pairs.push((
        String::from("vmEngineVersion"),
        CanonValue::Str(identity.vm_engine_version.clone()),
    ));
    write_canonical(&value)
}

/// 导入:规范化载荷文本 → 会话快照(以当前装载布局为锚;版本绑定复验,
/// 版本策略 §四"verifier 与交互执行同锁"的引擎侧落点)。
pub fn import_snapshot(
    text: &str,
    anchor: &VmState,
    identity: &EngineIdentity,
) -> Result<SessionSnapshot, SnapshotError> {
    let value = parse_canonical(text)?;
    let CanonValue::Object(pairs) = &value else {
        return Err(SnapshotError::FormMismatch("root"));
    };
    let read = |key: &str| -> Result<&CanonValue, SnapshotError> {
        pairs
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value)
            .ok_or(SnapshotError::FormMismatch("missing_field"))
    };
    let CanonValue::Str(form) = read("form")? else {
        return Err(SnapshotError::FormMismatch("form"));
    };
    if form != SNAPSHOT_FORM_ID {
        return Err(SnapshotError::FormMismatch("form"));
    }
    let declared_version = match read("vmEngineVersion")? {
        CanonValue::Str(text) => text.as_str(),
        _ => return Err(SnapshotError::FormMismatch("vmEngineVersion")),
    };
    let declared_build = match read("engineBuildId")? {
        CanonValue::Str(text) => Some(text.as_str()),
        CanonValue::Null => None,
        _ => return Err(SnapshotError::FormMismatch("engineBuildId")),
    };
    verify_bundle_lock(declared_version, declared_build, identity)
        .map_err(SnapshotError::Version)?;
    let revision = match read("revision")? {
        CanonValue::Int(number) if *number >= 0 => *number as u64,
        _ => return Err(SnapshotError::FormMismatch("revision")),
    };
    let halted = match read("halted")? {
        CanonValue::Bool(flag) => *flag,
        _ => return Err(SnapshotError::FormMismatch("halted")),
    };
    let judge_stage = match read("judgeStage")? {
        CanonValue::Null => None,
        stage_value @ CanonValue::Object(_) => {
            let stage_pairs = match stage_value {
                CanonValue::Object(pairs) => pairs,
                _ => return Err(SnapshotError::FormMismatch("judgeStage")),
            };
            let read_stage = |key: &str| -> Result<u64, SnapshotError> {
                match stage_pairs
                    .iter()
                    .find(|(existing, _)| existing == key)
                    .map(|(_, value)| value)
                {
                    Some(CanonValue::Int(number)) if *number >= 0 => Ok(*number as u64),
                    _ => Err(SnapshotError::FormMismatch("judgeStage")),
                }
            };
            Some(StageState {
                index: usize::try_from(read_stage("index")?)
                    .map_err(|_| SnapshotError::FormMismatch("judgeStage"))?,
                steps_used: read_stage("stepsUsed")?,
                actions_used: read_stage("actionsUsed")?,
            })
        }
        _ => return Err(SnapshotError::FormMismatch("judgeStage")),
    };
    let state = state_from_canonical(read("state")?, anchor)?;
    Ok(SessionSnapshot {
        state,
        judge_stage,
        halted,
        revision,
    })
}

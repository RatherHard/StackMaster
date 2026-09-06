//! 命令 / 响应信封的 serde 形态(引擎进程协议 §四命令面)。
//!
//! 信封是引擎进程协议本体(第 4 类契约的传输面):判别式 `type`、序号
//! `seq` 与快照信封在本文件冻结;动作、投影、错误与私有包的载荷面全部
//! 复用阶段一冻结 Schema,不另造私有格式(投影与错误契约语义 §5.3)。
//! 信封一律 `deny_unknown_fields`:未知命令 / 未知信封字段 = 协议层违规。

use serde::{Deserialize, Serialize};

/// 编排器 → worker 命令信封(一行一命令;stop-and-wait,无流水线)。
#[derive(Deserialize, Debug)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkerCommand {
    /// 装载私有判题包(§四 load;失败 = `challenge_invalid` 方向命令级错误)。
    Load {
        seq: u64,
        private_bundle: serde_json::Value,
        /// 仅 `server_random_per_session` 策略允许:编排器生成的会话种子
        /// (16–64 位十六进制字符);`fixed` 策略必须省略(seed 在包内)。
        session_seed_hex: Option<String>,
    },
    /// 应用一个动作(§四 apply_action):`actionRequest` 为完整冻结信封,
    /// `requestId` 由编排器签发并原样回传,worker 产出完整 `ActionResponse`。
    ApplyAction {
        seq: u64,
        request_id: String,
        action_request: serde_json::Value,
    },
    /// 查询当前完整公开投影(§四 query_projection;初始投影与快照导入后取数)。
    QueryProjection { seq: u64 },
    /// 导出当前 COW 快照(§四 export_snapshot;崩溃恢复点)。
    ExportSnapshot { seq: u64 },
    /// 导入快照替换当前状态(§四 import_snapshot;两步恢复 = load + 本命令)。
    ImportSnapshot {
        seq: u64,
        snapshot: serde_json::Value,
    },
    /// 优雅关闭:worker 回 `shutdown_ack` 后以退出码 0 结束,进程不复用。
    Shutdown { seq: u64 },
}

impl WorkerCommand {
    pub fn seq(&self) -> u64 {
        match self {
            WorkerCommand::Load { seq, .. }
            | WorkerCommand::ApplyAction { seq, .. }
            | WorkerCommand::QueryProjection { seq }
            | WorkerCommand::ExportSnapshot { seq }
            | WorkerCommand::ImportSnapshot { seq, .. }
            | WorkerCommand::Shutdown { seq } => *seq,
        }
    }
}

/// 快照信封(协议文档 §四 export_snapshot / import_snapshot;D-F5)。
/// `payload` 的内容形态归 WP-6(COW 快照序列化),本层只做信封与版本绑定校验。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SnapshotEnvelope {
    pub snapshot_format_version: u32,
    pub vm_engine_version: String,
    pub engine_build_id: String,
    pub revision: u64,
    pub payload: serde_json::Value,
}

/// 命令级错误码 = 冻结 `PublicError` 16 码(投影与错误契约语义 §4.2;
/// 错误类型也是契约)∪ `challenge_invalid`(装载 / 快照方向的拒绝,版本策略
/// §四"宁可拒绝装载"的结果类型方向;非 PublicError 码,故在此扩一格)。
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkerErrorCode {
    ChallengeInvalid,
    InvalidInputFormat,
    InvalidPayloadLength,
    OffsetOutOfRange,
    EndiannessMismatch,
    PermissionDenied,
    InvalidRip,
    CanaryViolation,
    InvalidCallArgument,
    ObjectiveNotMet,
    InaccessibleAddress,
    BudgetExhausted,
    StaleBaseRevision,
    StaleClientSeq,
    IdempotencyConflict,
    SessionTerminal,
    InternalError,
}

impl WorkerErrorCode {
    /// 确定性静态模板(不含校验器内部细节与任何隐藏状态分支,E-6 / I-4)。
    /// 执行面可解释错误由 WP-7 错误粗化生成器按能力矩阵产出,不使用本模板。
    pub fn message(self) -> &'static str {
        match self {
            WorkerErrorCode::ChallengeInvalid => "challenge bundle was rejected",
            WorkerErrorCode::InvalidInputFormat => "action payload failed contract validation",
            WorkerErrorCode::InvalidPayloadLength => "payload length is out of range",
            WorkerErrorCode::OffsetOutOfRange => "offset is out of range",
            WorkerErrorCode::EndiannessMismatch => "endianness interpretation mismatch",
            WorkerErrorCode::PermissionDenied => "memory permission denied",
            WorkerErrorCode::InvalidRip => "instruction pointer is not executable",
            WorkerErrorCode::CanaryViolation => "stack canary was violated",
            WorkerErrorCode::InvalidCallArgument => "call argument is invalid",
            WorkerErrorCode::ObjectiveNotMet => "objective condition is not met",
            WorkerErrorCode::InaccessibleAddress => "address is not accessible",
            WorkerErrorCode::BudgetExhausted => "resource budget is exhausted",
            WorkerErrorCode::StaleBaseRevision => "base revision is stale",
            WorkerErrorCode::StaleClientSeq => "client sequence is stale",
            WorkerErrorCode::IdempotencyConflict => "idempotency key conflict",
            WorkerErrorCode::SessionTerminal => "session is in a terminal state",
            WorkerErrorCode::InternalError => "engine could not process the command",
        }
    }
}

/// 命令级错误(引擎进程协议 §六):复用 PublicError 的 code 枚举与 message
/// 字段;不携带 addressHex / explanation(能力矩阵由执行面按需生成)。
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkerError {
    pub code: WorkerErrorCode,
    pub message: String,
}

impl WorkerError {
    pub fn new(code: WorkerErrorCode) -> Self {
        Self {
            code,
            message: code.message().to_owned(),
        }
    }
}

/// worker → 编排器响应帧(一行一帧;stdout 只允许本类型的实例)。
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WorkerOutbound {
    /// 启动自报(worker 写出第一帧后才读命令;版本比对语义见协议文档 §二)。
    Ready {
        protocol_version: u64,
        vm_engine_version: &'static str,
        engine_build_id: &'static str,
    },
    /// load 成功:回执锁定版本摘要(仅公开面字段,无 seed、无秘密)。
    Loaded { seq: u64, loaded: LoadedSummary },
    /// apply_action 产出:完整冻结 `ActionResponse`;`checkpointExport` 仅在
    /// 本动作为 create_checkpoint 且成功时出现(§四,D-F6)。
    ActionResponse {
        seq: u64,
        action_response: serde_json::Value,
        checkpoint_export: Option<serde_json::Value>,
    },
    /// query_projection:当前完整公开投影(冻结 Schema 出站自检后发出)。
    Projection {
        seq: u64,
        projection: serde_json::Value,
    },
    /// export_snapshot:快照信封。
    SnapshotExported {
        seq: u64,
        snapshot: SnapshotEnvelope,
    },
    /// import_snapshot 成功。
    SnapshotImported { seq: u64 },
    /// shutdown 确认:worker 随后以退出码 0 结束。
    ShutdownAck { seq: u64 },
    /// 命令级失败(§六):进程存活,会话可用性由编排器处置。
    CommandError { seq: u64, error: WorkerError },
    /// 协议层违规通报(尽力而为;worker 随后以非零码终止,进程不复用)。
    ProtocolError {
        code: &'static str,
        seq: Option<u64>,
    },
}

/// load 成功回执摘要:身份与版本字段落公开面(与公开描述包同源),不含
/// seed、secrets、judging、IR 等任何私有内容(秘密零驻留)。
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoadedSummary {
    pub challenge_id: String,
    pub challenge_content_version: String,
    pub vm_profile_version: String,
    pub dsl_schema_version: u32,
    pub vm_engine_version: String,
    pub engine_build_id: String,
    pub initial_revision: u64,
}

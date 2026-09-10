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
        /// 公开描述包(D-F10):引擎装配必需公开面的单点来源(位宽 / 页大小 /
        /// canary 规格 / 编码表 / 区域标签 / 题目预算);worker 按冻结 Schema
        /// 复验。整体 `PUBLIC`,传输于本协议不引入秘密面。
        public_descriptor: serde_json::Value,
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
    // ── 调试面命令(阶段四 WP-41;ADR-DC1 条款 1/3/4/8,additive 追加变体,
    //    ENGINE_PROCESS_PROTOCOL_VERSION 不变,双端同仓同发)──
    /// 装载调试变体镜像(WP-40 冻结契约;调试 worker 装载唯一入口):
    /// 变体 + 公开描述包(位宽 / 页大小 / 编码表单点来源,D-F10)。
    /// 真实私有判题包零装载、真实快照导入路径不可达(ADR-DC1 条款 3)。
    LoadVariant {
        seq: u64,
        variant: serde_json::Value,
        public_descriptor: serde_json::Value,
    },
    /// 调试实例状态查询(revision / status / RIP / halted)。
    DebugQueryState { seq: u64 },
    /// 任意地址窗口读取(零装载使隐藏区域公开,ADR-DC1 条款 2;原始存储读,
    /// 不走权限检查——调试器读自有进程内存)。
    DebugReadWindow {
        seq: u64,
        address_hex: String,
        byte_length: u64,
    },
    /// 重放一条已接受动作(确定性重放对齐,ADR-DC1 条款 3;无判题闸门评估
    /// ——调试实例未装载判题面,条款 4/5)。
    DebugApplyRecorded {
        seq: u64,
        action: serde_json::Value,
    },
    /// 调试实例单步(恰一条指令;等价真实实例 step 的引擎落点,不产判题评估)。
    DebugStep { seq: u64 },
    /// 运行至命中任一地址断点(步数上限防失控:超限确定性暂停 reason=budget)。
    DebugRunToBreakpoint {
        seq: u64,
        breakpoints: Vec<String>,
        max_steps: u64,
    },
    /// 全变体内存字节检索(原始存储扫描,命中按地址升序)。
    DebugSearch {
        seq: u64,
        pattern_hex: String,
        max_hits: u64,
    },
    /// 伪指令流展示数据(源 = 公开代码区字节;IR 不出进程,D5)。
    DebugInstructionStream {
        seq: u64,
        address_hex: String,
        max_items: u64,
    },
    /// 函数表展示数据(源 = 已装载程序结构,仅 label / 起址 / 长度)。
    DebugFunctionTable { seq: u64 },
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
            | WorkerCommand::LoadVariant { seq, .. }
            | WorkerCommand::DebugQueryState { seq }
            | WorkerCommand::DebugReadWindow { seq, .. }
            | WorkerCommand::DebugApplyRecorded { seq, .. }
            | WorkerCommand::DebugStep { seq }
            | WorkerCommand::DebugRunToBreakpoint { seq, .. }
            | WorkerCommand::DebugSearch { seq, .. }
            | WorkerCommand::DebugInstructionStream { seq, .. }
            | WorkerCommand::DebugFunctionTable { seq }
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

/// create_checkpoint 的回执信封(§4.7,D-F7):worker 签发的 `checkpointId`
/// 在快照信封之外——信封字段集合冻结,不私加字段。
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CheckpointExport {
    pub checkpoint_id: String,
    pub snapshot: SnapshotEnvelope,
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
    // ── 调试面响应帧(additive;与 WorkerCommand 调试命令一一对应)──
    /// load_variant 成功:变体镜像装载回执(零装载面,无任何秘密内容)。
    VariantLoaded { seq: u64, loaded: DebugLoadedSummary },
    /// debug_query_state:调试实例状态摘要。
    DebugState { seq: u64, state: DebugStateSummary },
    /// 任意地址窗口读取回执(truncated = 窗口跨区域边界截断)。
    DebugWindowData {
        seq: u64,
        address_hex: String,
        bytes_hex: String,
        truncated: bool,
    },
    /// 重放一条已接受动作完成(revision 推进后的对齐回执)。
    DebugApplied {
        seq: u64,
        revision: u64,
        status: String,
        rip_hex: String,
    },
    /// 执行暂停事件回执(step / run_to_breakpoint 共用)。
    DebugHalted {
        seq: u64,
        reason: DebugPauseReason,
        address_hex: String,
        steps_executed: u64,
    },
    /// 全内存检索回执(命中按地址升序;truncated = 命中数超出 maxHits)。
    DebugSearchResults {
        seq: u64,
        hits: Vec<DebugSearchHit>,
        truncated: bool,
    },
    /// 伪指令流展示数据回执(IR 不出进程,D5)。
    DebugInstructionStreamData {
        seq: u64,
        instructions: Vec<DebugInstructionEntryJson>,
        truncated: bool,
    },
    /// 函数表展示数据回执。
    DebugFunctionTableData {
        seq: u64,
        functions: Vec<DebugFunctionEntryJson>,
        truncated: bool,
    },
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

// ── 调试面载荷(阶段四 WP-41;wire 记法与调试通道协议语义 §三对偶)──────

/// 调试暂停原因(封闭四值;与 `DEBUG_PAUSE_REASONS` 同集):单步落点 /
/// 断点命中 / 程序自行停机 / 步数预算耗尽。
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DebugPauseReason {
    Step,
    Breakpoint,
    ProgramHalt,
    Budget,
}

/// load_variant 成功回执摘要:身份三元组来自变体镜像(公开面),不含
/// seed、judging、真实私有包任何内容(零装载,ADR-DC1 条款 2/5)。
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DebugLoadedSummary {
    pub challenge_id: String,
    pub challenge_content_version: String,
    pub vm_profile_version: String,
    pub aslr_enabled: bool,
    pub initial_revision: u64,
}

/// 调试实例状态摘要(revision / status / RIP / halted;Status 为冻结
/// PublicStatus 四值字符串形态)。
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DebugStateSummary {
    pub revision: u64,
    pub status: String,
    pub rip_hex: String,
    pub halted: bool,
}

/// 检索单命中:命中地址 + 命中处字节回显(与请求模式等长,生成端义务)。
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DebugSearchHit {
    pub address_hex: String,
    pub bytes_hex: String,
}

/// 伪指令流单条展示条目(text 为展示文本,非可执行 IR,D5)。
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DebugInstructionEntryJson {
    pub address_hex: String,
    pub bytes_hex: Option<String>,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jump_target_hex: Option<String>,
}

/// 函数表单条(label / 起址 / 字节长度三字段)。
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DebugFunctionEntryJson {
    pub label: String,
    pub start_address_hex: String,
    pub byte_length: u64,
}

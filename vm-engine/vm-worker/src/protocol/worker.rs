//! Worker 状态机骨架(引擎进程协议 §四命令面)。
//!
//! WP-1 交付的协议骨架完整实现传输与校验面:帧层(fail-closed)→ 信封
//! 反序列化(未知命令 / 未知信封字段拒绝)→ seq 单调门 → 装载与命令分发
//! → 载荷契约校验(Schema + 语义承接 + 镜像反序列化)。引擎面(VM 执行、
//! 投影生成、快照内容)按实施顺序归 WP-3 ~ WP-8 接线;骨架阶段对通过全部
//! 校验的合法命令返回确定性的 `internal_error` 命令级错误(不执行、不推进
//! revision),不构成对协议语义的偏离(协议文档 §四"骨架阶段行为")。

use crate::contract::mirrors::{ActionRequestMirror, PrivateBundleMirror};
use crate::contract::schema::{ContractValidators, SchemaCompileError};
use crate::contract::{self, semantic, strict_value::StrictValue};
use crate::protocol::message::{
    LoadedSummary, SnapshotEnvelope, WorkerCommand, WorkerError, WorkerErrorCode, WorkerOutbound,
};
use crate::protocol::version::{
    ENGINE_BUILD_ID, ENGINE_PROCESS_PROTOCOL_VERSION, VM_ENGINE_VERSION,
};
use serde_json::Value;

/// 协议层违规(引擎进程协议 §六违规表)——一律 fail-closed:尽力而为输出
/// `protocol_error` 帧后进程以非零码终止,进程不复用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolViolation {
    /// 帧层违规(超限 / 畸形 / 半包等)。
    Frame(FrameErrorKind),
    /// 未知命令判别式(版本错配或编排器缺陷)。
    UnknownCommand,
    /// 信封非法:未知字段、缺 `seq`、字段类型不符、`requestId` 越界字符集。
    EnvelopeInvalid,
    /// `seq` 非严格递增(stop-and-wait 序被破坏)。
    SequenceViolation { seq: Option<u64> },
    /// 命令状态机违规(未装载即命令、装载成功后重复装载)。
    StateViolation { seq: u64 },
    /// 契约面自相矛盾(Schema 通过但镜像 / 出站自检失败)——引擎侧缺陷,
    /// 按 fail-closed 处置。
    ContractInconsistency,
}

/// 帧层违规类别(自 [`crate::protocol::frame::FrameError`] 归一化,剔除 IO 详情)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameErrorKind {
    Io,
    FrameTooLarge,
    TruncatedFrame,
    InvalidUtf8,
    MalformedJson,
    DuplicateKey,
    LoneSurrogate,
    NotAnObject,
}

impl ProtocolViolation {
    /// 协议层违规码(`protocol_error` 帧 `code` 字段;与协议文档 §六同串)。
    pub fn code(&self) -> &'static str {
        match self {
            ProtocolViolation::Frame(kind) => match kind {
                FrameErrorKind::Io => "io_error",
                FrameErrorKind::FrameTooLarge => "frame_too_large",
                FrameErrorKind::TruncatedFrame => "truncated_frame",
                FrameErrorKind::InvalidUtf8 => "invalid_utf8",
                FrameErrorKind::MalformedJson => "malformed_json",
                FrameErrorKind::DuplicateKey => "duplicate_key",
                FrameErrorKind::LoneSurrogate => "lone_surrogate",
                FrameErrorKind::NotAnObject => "not_an_object",
            },
            ProtocolViolation::UnknownCommand => "unknown_command",
            ProtocolViolation::EnvelopeInvalid => "envelope_invalid",
            ProtocolViolation::SequenceViolation { .. } => "sequence_violation",
            ProtocolViolation::StateViolation { .. } => "state_violation",
            ProtocolViolation::ContractInconsistency => "contract_inconsistency",
        }
    }

    /// 违规关联的请求序号(尽力而为;帧层违规可能无法确定)。
    pub fn seq(&self) -> Option<u64> {
        match self {
            ProtocolViolation::SequenceViolation { seq } => *seq,
            ProtocolViolation::StateViolation { seq } => Some(*seq),
            _ => None,
        }
    }
}

/// 会话阶段:装载前 → 装载成功。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    AwaitingLoad,
    Ready,
}

/// 单会话 Worker:命令状态机 + 契约校验器集合(启动时编译一次)。
pub struct Worker {
    validators: ContractValidators,
    phase: Phase,
    last_seq: Option<u64>,
    /// 权威 revision(worker 侧执行账本;只有已执行动作推进;骨架阶段恒 0)。
    revision: u64,
}

impl Worker {
    pub fn new() -> Result<Self, SchemaCompileError> {
        Ok(Self {
            validators: ContractValidators::compile()?,
            phase: Phase::AwaitingLoad,
            last_seq: None,
            revision: 0,
        })
    }

    /// 启动自报帧(worker 写出第一帧后才读命令;协议文档 §二)。
    pub fn ready_frame() -> WorkerOutbound {
        WorkerOutbound::Ready {
            protocol_version: ENGINE_PROCESS_PROTOCOL_VERSION,
            vm_engine_version: VM_ENGINE_VERSION,
            engine_build_id: ENGINE_BUILD_ID,
        }
    }

    /// 处理一帧(已通过帧层严格解析的 JSON 对象)。
    pub fn handle_frame(
        &mut self,
        frame: &StrictValue,
    ) -> Result<WorkerOutbound, ProtocolViolation> {
        let json = contract::to_json_value(frame);
        let command: WorkerCommand = serde_json::from_value(json).map_err(|error| {
            if error.to_string().contains("unknown variant") {
                ProtocolViolation::UnknownCommand
            } else {
                ProtocolViolation::EnvelopeInvalid
            }
        })?;
        let seq = command.seq();
        let expected = self.last_seq.map_or(1, |last| last + 1);
        if seq != expected {
            return Err(ProtocolViolation::SequenceViolation { seq: Some(seq) });
        }
        self.last_seq = Some(seq);
        match command {
            WorkerCommand::Load {
                seq,
                private_bundle,
                session_seed_hex,
            } => self.handle_load(seq, private_bundle, session_seed_hex),
            WorkerCommand::ApplyAction {
                seq,
                request_id,
                action_request,
            } => self.handle_apply_action(seq, &request_id, action_request),
            WorkerCommand::QueryProjection { seq } => {
                self.require_ready(seq)?;
                Ok(self.placeholder_unwired(seq))
            }
            WorkerCommand::ExportSnapshot { seq } => {
                self.require_ready(seq)?;
                Ok(self.placeholder_unwired(seq))
            }
            WorkerCommand::ImportSnapshot { seq, snapshot } => {
                self.require_ready(seq)?;
                self.handle_import_snapshot(seq, snapshot)
            }
            WorkerCommand::Shutdown { seq } => Ok(WorkerOutbound::ShutdownAck { seq }),
        }
    }

    fn require_ready(&self, seq: u64) -> Result<(), ProtocolViolation> {
        if matches!(self.phase, Phase::Ready) {
            Ok(())
        } else {
            Err(ProtocolViolation::StateViolation { seq })
        }
    }

    /// 引擎面未接线的确定性占位(WP-3 ~ WP-8 接线后由真实执行面替换)。
    fn placeholder_unwired(&self, seq: u64) -> WorkerOutbound {
        WorkerOutbound::CommandError {
            seq,
            error: WorkerError::new(WorkerErrorCode::InternalError),
        }
    }

    /// load(§四):私有包 Schema + 语义 + 镜像校验,seed 策略互斥,版本锁定;
    /// 失败 = `challenge_invalid` 方向命令级错误(宁可拒绝装载,不近似执行),
    /// 进程存活、阶段不变(重装载行为确定:同一输入恒同结论)。
    fn handle_load(
        &mut self,
        seq: u64,
        private_bundle: Value,
        session_seed_hex: Option<String>,
    ) -> Result<WorkerOutbound, ProtocolViolation> {
        if matches!(self.phase, Phase::Ready) {
            return Err(ProtocolViolation::StateViolation { seq });
        }
        let reject = || {
            Ok(WorkerOutbound::CommandError {
                seq,
                error: WorkerError::new(WorkerErrorCode::ChallengeInvalid),
            })
        };
        if !self.validators.private_bundle.is_valid(&private_bundle) {
            return reject();
        }
        if semantic::check_document(&contract::strict_from_value(&private_bundle)).is_err() {
            return reject();
        }
        let mirror: PrivateBundleMirror = match serde_json::from_value(private_bundle) {
            Ok(mirror) => mirror,
            Err(_) => return reject(),
        };
        // seed 策略互斥(R5;协议文档 §四 load 规则):fixed ⇒ 包内 seedHex、
        // 禁止会话种子;server_random_per_session ⇒ 编排器必须传入会话种子。
        let seed_policy = &mirror.seed_policy;
        match (&seed_policy.strategy, &session_seed_hex) {
            (crate::contract::mirrors::SeedStrategy::Fixed, Some(_))
            | (crate::contract::mirrors::SeedStrategy::ServerRandomPerSession, None) => {
                return reject();
            }
            _ => {}
        }
        if let Some(seed) = &session_seed_hex
            && !is_seed_hex(seed)
        {
            return reject();
        }
        // 版本锁定(版本策略 §四):引擎自报与包声明一致,否则拒绝装载。
        if mirror.vm_engine_version != VM_ENGINE_VERSION {
            return reject();
        }
        if let Some(declared) = &mirror.engine_build_id
            && declared != ENGINE_BUILD_ID
        {
            return reject();
        }
        self.phase = Phase::Ready;
        Ok(WorkerOutbound::Loaded {
            seq,
            loaded: LoadedSummary {
                challenge_id: mirror.challenge_id,
                challenge_content_version: mirror.challenge_content_version,
                vm_profile_version: mirror.vm_profile_version,
                dsl_schema_version: mirror.dsl_schema_version,
                vm_engine_version: mirror.vm_engine_version,
                engine_build_id: mirror
                    .engine_build_id
                    .unwrap_or_else(|| ENGINE_BUILD_ID.to_owned()),
                initial_revision: 0,
            },
        })
    }

    /// apply_action(§四):载荷契约校验失败 → 确定性 `rejected` 响应
    /// (revision 不变、delta null、事件空,§4.5 协议级拒绝行);通过全部校验
    /// 的合法动作在骨架阶段返回 `internal_error` 命令级错误(引擎面未接线)。
    fn handle_apply_action(
        &mut self,
        seq: u64,
        request_id: &str,
        action_request: Value,
    ) -> Result<WorkerOutbound, ProtocolViolation> {
        self.require_ready(seq)?;
        if !is_server_identifier(request_id) {
            return Err(ProtocolViolation::EnvelopeInvalid);
        }
        let payload_rejected = !self.validators.action_request.is_valid(&action_request)
            || semantic::check_document(&contract::strict_from_value(&action_request)).is_err();
        if payload_rejected {
            return self.rejected_action_response(seq, request_id);
        }
        let mirror: ActionRequestMirror = match serde_json::from_value(action_request) {
            Ok(mirror) => mirror,
            Err(_) => return Err(ProtocolViolation::ContractInconsistency),
        };
        // WP-1 骨架:执行管线归 WP-4 / WP-7;此处仅证明契约消费面贯通。
        let _ = mirror;
        Ok(self.placeholder_unwired(seq))
    }

    /// 协议级拒绝响应(§4.5):status `rejected` + `invalid_input_format`,
    /// revision 不变、`projectionDelta: null`、`publicEvents: []`,出站先自检。
    fn rejected_action_response(
        &self,
        seq: u64,
        request_id: &str,
    ) -> Result<WorkerOutbound, ProtocolViolation> {
        let response = serde_json::json!({
            "requestId": request_id,
            "revision": self.revision,
            "status": "rejected",
            "projectionDelta": null,
            "publicEvents": [],
            "userVisibleError": {
                "code": WorkerErrorCode::InvalidInputFormat,
                "message": WorkerErrorCode::InvalidInputFormat.message(),
            }
        });
        if !self.validators.action_response.is_valid(&response) {
            return Err(ProtocolViolation::ContractInconsistency);
        }
        Ok(WorkerOutbound::ActionResponse {
            seq,
            action_response: response,
            checkpoint_export: None,
        })
    }

    /// import_snapshot(§四):快照信封与版本绑定校验;内容形态归 WP-6,
    /// 骨架阶段信封合法即返回引擎面未接线占位。
    fn handle_import_snapshot(
        &mut self,
        seq: u64,
        snapshot: Value,
    ) -> Result<WorkerOutbound, ProtocolViolation> {
        let envelope: SnapshotEnvelope = match serde_json::from_value(snapshot) {
            Ok(envelope) => envelope,
            Err(_) => {
                return Ok(WorkerOutbound::CommandError {
                    seq,
                    error: WorkerError::new(WorkerErrorCode::ChallengeInvalid),
                });
            }
        };
        let version_locked = envelope.snapshot_format_version == 1
            && envelope.vm_engine_version == VM_ENGINE_VERSION
            && envelope.engine_build_id == ENGINE_BUILD_ID
            && envelope.payload.is_object();
        if !version_locked {
            return Ok(WorkerOutbound::CommandError {
                seq,
                error: WorkerError::new(WorkerErrorCode::ChallengeInvalid),
            });
        }
        Ok(self.placeholder_unwired(seq))
    }
}

/// 服务端签发标识符字符集(`^[A-Za-z0-9_-]{1,128}$`,会话动作协议语义 §2.1)。
fn is_server_identifier(value: &str) -> bool {
    let length = value.chars().count();
    (1..=128).contains(&length)
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
}

/// 会话种子形态(`^([0-9a-fA-F]{2}){8,32}$`,与包内 seedHex 同锚)。
fn is_seed_hex(value: &str) -> bool {
    (16..=64).contains(&value.len())
        && value.len().is_multiple_of(2)
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

//! Worker 状态机(引擎进程协议 §四命令面;WP-8 引擎面接线)。
//!
//! 传输与校验面(WP-1 交付):帧层(fail-closed)→ 信封反序列化(未知命令 /
//! 未知信封字段拒绝)→ seq 单调门 → 装载与命令分发 → 载荷契约校验(Schema +
//! 语义承接 + 镜像反序列化)。引擎面(WP-8 接线):`load` 经 [`crate::session::
//! assemble`] 装配会话(引擎 + 判题 + 投影策略),`apply_action` /
//! `query_projection` / `export_snapshot` / `import_snapshot` 经
//! [`crate::session::host::SessionHost`] 执行;一切出站先经冻结 Schema 自检
//! 再上管道(§3.4,自检失败 = `contract_inconsistency`)。
//!
//! # 故障与终止语义(D-W8-5)
//!
//! - 载荷级拒绝:确定性 `rejected` 响应(§4.5),进程存活;
//! - 托管故障(安全终止方向):尽力而为命令级错误(`challenge_invalid` /
//!   `internal_error`)+ 受控日志 + **非零退出**,进程不复用——会话一致性
//!   在故障后不可信,恢复走编排器崩溃替换路径;
//! - 协议层违规:fail-closed(§3.5),引擎 panic(溢出安全终止)由二进制
//!   入口 `catch_unwind` 归入同一路径。

use crate::contract::mirrors::{
    ActionRequestMirror, DebugVariantBundleMirror, PrivateBundleMirror, PublicDescriptorExtract,
};
use crate::contract::outbound;
use crate::contract::schema::{ContractValidators, SchemaCompileError};
use crate::contract::{self, semantic, strict_value::StrictValue};
use crate::protocol::message::{
    DebugLoadedSummary, LoadedSummary, SnapshotEnvelope, WorkerCommand, WorkerError,
    WorkerErrorCode, WorkerOutbound,
};
use crate::protocol::version::{
    ENGINE_BUILD_ID, ENGINE_PROCESS_PROTOCOL_VERSION, VM_ENGINE_VERSION,
};
use crate::session::assemble::{self, AssembleError};
use crate::session::host::{ApplyResult, HostFault, SessionHost};
use crate::session::variant::{DebugApplyOutcome, DebugHost, parse_address_hex};
use crate::session::watchdog::Watchdog;
use serde_json::Value;
use vm_runtime::identity::EngineIdentity;
use vm_runtime::runtime::RuntimeError;

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

/// 会话阶段:装载前 → 装载成功(真实会话)/ 调试变体装载成功(调试实例;
/// 两态互斥——单进程一次服务一个实例,终止后不复用)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    AwaitingLoad,
    Ready,
    DebugReady,
}

/// 单会话 Worker:命令状态机 + 契约校验器集合(启动时编译一次)+ 会话托管。
pub struct Worker {
    validators: ContractValidators,
    phase: Phase,
    last_seq: Option<u64>,
    session: Option<SessionHost>,
    debug_session: Option<DebugHost>,
    watchdog: Option<Watchdog>,
    /// 安全终止标记(托管故障;进程在响应写出后以非零码退出,D-W8-5)。
    terminal: Option<&'static str>,
}

impl Worker {
    pub fn new() -> Result<Self, SchemaCompileError> {
        Ok(Self {
            validators: ContractValidators::compile()?,
            phase: Phase::AwaitingLoad,
            last_seq: None,
            session: None,
            debug_session: None,
            watchdog: None,
            terminal: None,
        })
    }

    /// 注入 wall-clock 看门狗(二进制入口;测试可省略)。
    pub fn set_watchdog(&mut self, watchdog: Watchdog) {
        self.watchdog = Some(watchdog);
    }

    /// 取走安全终止标记(主循环在响应写出后据此以非零码退出)。
    pub fn take_terminal(&mut self) -> Option<&'static str> {
        self.terminal.take()
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
                public_descriptor,
                session_seed_hex,
            } => self.handle_load(seq, private_bundle, public_descriptor, session_seed_hex),
            WorkerCommand::ApplyAction {
                seq,
                request_id,
                action_request,
            } => self.handle_apply_action(seq, &request_id, action_request),
            WorkerCommand::QueryProjection { seq } => {
                // 两态均受理(分派目标不同):真实会话 / 调试实例各按自身
                // 投影策略生成(调试 = 全可见,零装载)。
                if !matches!(self.phase, Phase::Ready | Phase::DebugReady) {
                    return Err(ProtocolViolation::StateViolation { seq });
                }
                match self.phase {
                    Phase::DebugReady => self.handle_debug_projection(seq),
                    _ => self.handle_query_projection(seq),
                }
            }
            WorkerCommand::ExportSnapshot { seq } => {
                self.require_ready(seq)?;
                self.handle_export_snapshot(seq)
            }
            WorkerCommand::ImportSnapshot { seq, snapshot } => {
                self.require_ready(seq)?;
                self.handle_import_snapshot(seq, snapshot)
            }
            // ── 调试面命令(additive;仅调试实例阶段受理,状态机互斥)──
            WorkerCommand::LoadVariant {
                seq,
                variant,
                public_descriptor,
            } => self.handle_load_variant(seq, variant, public_descriptor),
            WorkerCommand::DebugQueryState { seq } => {
                self.require_debug_ready(seq)?;
                self.handle_debug_query_state(seq)
            }
            WorkerCommand::DebugReadWindow {
                seq,
                address_hex,
                byte_length,
            } => self.handle_debug_read_window(seq, &address_hex, byte_length),
            WorkerCommand::DebugApplyRecorded { seq, action } => {
                self.handle_debug_apply_recorded(seq, action)
            }
            WorkerCommand::DebugStep { seq } => self.handle_debug_step(seq),
            WorkerCommand::DebugRunToBreakpoint {
                seq,
                breakpoints,
                max_steps,
            } => self.handle_debug_run_to_breakpoint(seq, breakpoints, max_steps),
            WorkerCommand::DebugSearch {
                seq,
                pattern_hex,
                max_hits,
            } => self.handle_debug_search(seq, &pattern_hex, max_hits),
            WorkerCommand::DebugInstructionStream {
                seq,
                address_hex,
                max_items,
            } => self.handle_debug_instruction_stream(seq, &address_hex, max_items),
            WorkerCommand::DebugFunctionTable { seq } => self.handle_debug_function_table(seq),
            // ── 裁决重放命令面(阶段六 WP-41→61:additive;状态机约束见 §四)──
            WorkerCommand::ExportActionLog { seq } => self.handle_export_action_log(seq),
            WorkerCommand::Verify {
                seq,
                private_bundle,
                public_descriptor,
                session_seed_hex,
                replay_context,
                action_log,
            } => self.handle_verify(
                seq,
                private_bundle,
                public_descriptor,
                session_seed_hex,
                replay_context,
                action_log,
            ),
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

    fn require_debug_ready(&self, seq: u64) -> Result<(), ProtocolViolation> {
        if matches!(self.phase, Phase::DebugReady) {
            Ok(())
        } else {
            Err(ProtocolViolation::StateViolation { seq })
        }
    }

    /// load(§四):私有包 Schema + 语义 + 镜像校验,seed 策略互斥,版本锁定,
    /// 公开描述包复验(D-F10)与会话装配;失败 = `challenge_invalid` 方向
    /// 命令级错误(宁可拒绝装载,不近似执行),进程存活、阶段不变(重装载
    /// 行为确定:同一输入恒同结论)。
    fn handle_load(
        &mut self,
        seq: u64,
        private_bundle: Value,
        public_descriptor: Value,
        session_seed_hex: Option<String>,
    ) -> Result<WorkerOutbound, ProtocolViolation> {
        // 装载仅允许在未装载阶段(真实装载与变体装载互斥,双态均占用进程)。
        if !matches!(self.phase, Phase::AwaitingLoad) {
            return Err(ProtocolViolation::StateViolation { seq });
        }
        let reject = || {
            Ok(WorkerOutbound::CommandError {
                seq,
                error: WorkerError::new(WorkerErrorCode::ChallengeInvalid),
            })
        };
        if !self.validators.private_bundle.is_valid(&private_bundle)
            || !self
                .validators
                .public_descriptor
                .is_valid(&public_descriptor)
        {
            return reject();
        }
        if semantic::check_document(&contract::strict_from_value(&private_bundle)).is_err()
            || semantic::check_document(&contract::strict_from_value(&public_descriptor)).is_err()
        {
            return reject();
        }
        let mirror: PrivateBundleMirror = match serde_json::from_value(private_bundle.clone()) {
            Ok(mirror) => mirror,
            Err(_) => return reject(),
        };
        let public: PublicDescriptorExtract =
            match serde_json::from_value(public_descriptor.clone()) {
                Ok(public) => public,
                Err(_) => return reject(),
            };
        // 双包身份一致(公开包与私有包声明同一题目 / 版本;跨包 XS-ID-CORR 镜像)。
        if mirror.challenge_id != public.challenge_id
            || mirror.challenge_content_version != public.challenge_content_version
            || mirror.vm_profile_version != public.vm_profile_version
        {
            return reject();
        }
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
        // 会话装配(WP-8):引擎 + 判题 + 投影策略 + 回放上下文;任一步拒绝
        // 即整体拒绝,进程存活、阶段保持未装载。
        let identity = EngineIdentity {
            vm_engine_version: String::from(VM_ENGINE_VERSION),
            engine_build_id: String::from(ENGINE_BUILD_ID),
        };
        let components = match assemble::assemble(
            &mirror,
            &private_bundle,
            &public,
            &public_descriptor,
            session_seed_hex.as_deref(),
            &identity,
        ) {
            Ok(components) => components,
            Err(AssembleError { reason }) => {
                log_assembly_reject(reason);
                return reject();
            }
        };
        let session = match SessionHost::new(components) {
            Ok(session) => session,
            Err(_) => return reject(),
        };
        let initial_revision = session.revision();
        self.phase = Phase::Ready;
        self.session = Some(session);
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
                initial_revision,
            },
        })
    }

    /// load_variant(WP-41;ADR-DC1 条款 2/5):调试变体镜像 Schema + 公开
    /// 描述包 Schema 复验、身份三元组互证、`assemble_variant` 零装载装配。
    /// 失败 = `challenge_invalid` 方向命令级错误(宁可拒绝装载,不近似执行),
    /// 进程存活、阶段不变。真实私有判题包与真实快照导入路径不可达——本命令
    /// 不接受 privateBundle,调试实例内不存在判题面。
    fn handle_load_variant(
        &mut self,
        seq: u64,
        variant: Value,
        public_descriptor: Value,
    ) -> Result<WorkerOutbound, ProtocolViolation> {
        if !matches!(self.phase, Phase::AwaitingLoad) {
            return Err(ProtocolViolation::StateViolation { seq });
        }
        let reject = || {
            Ok(WorkerOutbound::CommandError {
                seq,
                error: WorkerError::new(WorkerErrorCode::ChallengeInvalid),
            })
        };
        if !self.validators.debug_variant_bundle.is_valid(&variant)
            || !self
                .validators
                .public_descriptor
                .is_valid(&public_descriptor)
        {
            return reject();
        }
        let variant_mirror: DebugVariantBundleMirror = match serde_json::from_value(variant.clone())
        {
            Ok(mirror) => mirror,
            Err(_) => return reject(),
        };
        let public: PublicDescriptorExtract =
            match serde_json::from_value(public_descriptor.clone()) {
                Ok(public) => public,
                Err(_) => return reject(),
            };
        // 装配(零装载:变体 contentHex 即权威初始字节;无判题面、无 seed)。
        let components = match crate::session::variant::assemble_variant(&variant_mirror, &public) {
            Ok(components) => components,
            Err(AssembleError { reason }) => {
                log_assembly_reject(reason);
                return reject();
            }
        };
        let summary = DebugHost::summary_of(&components);
        let initial_revision = summary.initial_revision;
        self.phase = Phase::DebugReady;
        self.debug_session = Some(DebugHost::new(components));
        Ok(WorkerOutbound::VariantLoaded {
            seq,
            loaded: DebugLoadedSummary {
                initial_revision,
                ..summary
            },
        })
    }

    /// debug_query_state:调试实例状态摘要。
    fn handle_debug_query_state(&mut self, seq: u64) -> Result<WorkerOutbound, ProtocolViolation> {
        let state = self
            .debug_session
            .as_ref()
            .ok_or(ProtocolViolation::StateViolation { seq })?
            .state_summary();
        Ok(WorkerOutbound::DebugState { seq, state })
    }

    /// debug_query_state 的投影形态(全可见策略;QueryProjection 在调试阶段
    /// 的分派目标)。
    fn handle_debug_projection(&mut self, seq: u64) -> Result<WorkerOutbound, ProtocolViolation> {
        let host = self
            .debug_session
            .as_ref()
            .ok_or(ProtocolViolation::StateViolation { seq })?;
        let projection = match host.projection() {
            Ok(projection) => projection,
            Err(_) => return self.fault_termination(seq, &HostFault::ContractInconsistency),
        };
        let value = outbound::projection_to_json(&projection);
        if !self.validators.public_state_projection.is_valid(&value) {
            return Err(ProtocolViolation::ContractInconsistency);
        }
        Ok(WorkerOutbound::Projection {
            seq,
            projection: value,
        })
    }

    /// debug_read_window:任意地址原始窗口读取(零装载使隐藏区域公开;
    /// 越上限 / 地址非法 = 载荷级 `invalid_input_format`;未映射 =
    /// `inaccessible_address`,进程均存活)。
    fn handle_debug_read_window(
        &mut self,
        seq: u64,
        address_hex: &str,
        byte_length: u64,
    ) -> Result<WorkerOutbound, ProtocolViolation> {
        self.require_debug_ready(seq)?;
        let Some(address) = parse_address_hex(address_hex) else {
            return Ok(command_invalid_input(seq));
        };
        if byte_length < 1 || byte_length > crate::session::variant::DEBUG_WINDOW_MAX_BYTES as u64 {
            return Ok(command_invalid_input(seq));
        }
        let host = self
            .debug_session
            .as_ref()
            .ok_or(ProtocolViolation::StateViolation { seq })?;
        match host.read_window(address, byte_length as usize) {
            Some((bytes, truncated)) => Ok(WorkerOutbound::DebugWindowData {
                seq,
                address_hex: crate::session::variant::format_hex(address),
                bytes_hex: crate::session::variant::hex_lower(&bytes),
                truncated,
            }),
            None => Ok(WorkerOutbound::CommandError {
                seq,
                error: WorkerError::new(WorkerErrorCode::InaccessibleAddress),
            }),
        }
    }

    /// debug_apply_recorded:确定性重放一条已接受动作(ADR-DC1 条款 3)。
    /// 载荷非法或与权威日志错位 = 命令级 `internal_error`(编排器据此中止
    /// attach;进程存活,错位处置归编排器)。
    fn handle_debug_apply_recorded(
        &mut self,
        seq: u64,
        action: Value,
    ) -> Result<WorkerOutbound, ProtocolViolation> {
        self.require_debug_ready(seq)?;
        let mirror: crate::contract::mirrors::ActionCallMirror =
            match serde_json::from_value(action) {
                Ok(mirror) => mirror,
                Err(_) => return Ok(command_internal_error(seq)),
            };
        let arch = self
            .debug_session
            .as_ref()
            .ok_or(ProtocolViolation::StateViolation { seq })?
            .state()
            .memory
            .arch();
        let recorded = match assemble::recorded_action(&mirror, arch) {
            Ok(recorded) => recorded,
            Err(_) => return Ok(command_internal_error(seq)),
        };
        let host = self
            .debug_session
            .as_mut()
            .ok_or(ProtocolViolation::StateViolation { seq })?;
        match host.apply_recorded(&recorded) {
            DebugApplyOutcome::Applied => Ok(WorkerOutbound::DebugApplied {
                seq,
                revision: host.revision(),
                status: String::from(host.status()),
                rip_hex: host.rip_hex(),
            }),
            DebugApplyOutcome::Misaligned => Ok(command_internal_error(seq)),
        }
    }

    /// debug_step:单步(恰一条指令;无判题闸门评估)。
    fn handle_debug_step(&mut self, seq: u64) -> Result<WorkerOutbound, ProtocolViolation> {
        self.require_debug_ready(seq)?;
        let host = self
            .debug_session
            .as_mut()
            .ok_or(ProtocolViolation::StateViolation { seq })?;
        let (reason, address_hex) = host.debug_step();
        Ok(WorkerOutbound::DebugHalted {
            seq,
            reason,
            address_hex,
            steps_executed: 1,
        })
    }

    /// debug_run_to_breakpoint:循环步进至命中 / 程序止步 / 步数预算耗尽
    /// (确定性暂停;断点数量与地址形态的载荷级复验在此收口)。
    fn handle_debug_run_to_breakpoint(
        &mut self,
        seq: u64,
        breakpoints: Vec<String>,
        max_steps: u64,
    ) -> Result<WorkerOutbound, ProtocolViolation> {
        self.require_debug_ready(seq)?;
        if breakpoints.is_empty()
            || breakpoints.len() > crate::session::variant::DEBUG_SEARCH_MAX_HITS
        {
            return Ok(command_invalid_input(seq));
        }
        let mut parsed = Vec::with_capacity(breakpoints.len());
        for breakpoint in &breakpoints {
            match parse_address_hex(breakpoint) {
                Some(address) => parsed.push(address),
                None => return Ok(command_invalid_input(seq)),
            }
        }
        let host = self
            .debug_session
            .as_mut()
            .ok_or(ProtocolViolation::StateViolation { seq })?;
        let (reason, address_hex, steps_executed) = host.run_to_breakpoint(&parsed, max_steps);
        Ok(WorkerOutbound::DebugHalted {
            seq,
            reason,
            address_hex,
            steps_executed,
        })
    }

    /// debug_search:全变体内存检索(模式非空偶长 hex / 命中上限的载荷级
    /// 复验在此收口)。
    fn handle_debug_search(
        &mut self,
        seq: u64,
        pattern_hex: &str,
        max_hits: u64,
    ) -> Result<WorkerOutbound, ProtocolViolation> {
        self.require_debug_ready(seq)?;
        let Some(pattern) = assemble::decode_hex_bytes(pattern_hex) else {
            return Ok(command_invalid_input(seq));
        };
        if pattern.is_empty() || !(1..=256).contains(&max_hits) {
            return Ok(command_invalid_input(seq));
        }
        let host = self
            .debug_session
            .as_ref()
            .ok_or(ProtocolViolation::StateViolation { seq })?;
        let (hits, truncated) = host.search(&pattern, max_hits as usize);
        Ok(WorkerOutbound::DebugSearchResults {
            seq,
            hits,
            truncated,
        })
    }

    /// debug_instruction_stream:伪指令流展示数据(源 = 公开代码区字节;
    /// IR 不出进程,D5)。
    fn handle_debug_instruction_stream(
        &mut self,
        seq: u64,
        address_hex: &str,
        max_items: u64,
    ) -> Result<WorkerOutbound, ProtocolViolation> {
        self.require_debug_ready(seq)?;
        let Some(address) = parse_address_hex(address_hex) else {
            return Ok(command_invalid_input(seq));
        };
        if !(1..=256).contains(&max_items) {
            return Ok(command_invalid_input(seq));
        }
        let host = self
            .debug_session
            .as_ref()
            .ok_or(ProtocolViolation::StateViolation { seq })?;
        let (instructions, truncated) = host.instruction_stream(address, max_items as usize);
        Ok(WorkerOutbound::DebugInstructionStreamData {
            seq,
            instructions,
            truncated,
        })
    }

    /// debug_function_table:函数表展示数据(源 = 已装载程序结构)。
    fn handle_debug_function_table(
        &mut self,
        seq: u64,
    ) -> Result<WorkerOutbound, ProtocolViolation> {
        self.require_debug_ready(seq)?;
        let host = self
            .debug_session
            .as_ref()
            .ok_or(ProtocolViolation::StateViolation { seq })?;
        let (functions, truncated) = host.function_table(256);
        Ok(WorkerOutbound::DebugFunctionTableData {
            seq,
            functions,
            truncated,
        })
    }

    /// export_action_log(阶段六 WP-61):权威动作日志与六记录项上下文的
    /// 导出面(D-W8-9 submit 引用随行落库的引擎权威形态)。仅已装载阶段受理。
    fn handle_export_action_log(&mut self, seq: u64) -> Result<WorkerOutbound, ProtocolViolation> {
        let host = self
            .session
            .as_ref()
            .ok_or(ProtocolViolation::StateViolation { seq })?;
        let log = host.action_log();
        let text = log
            .canonical_text()
            .map_err(|_| ProtocolViolation::ContractInconsistency)?;
        Ok(crate::session::verify::export_outcome(
            seq,
            &log.context,
            text,
        ))
    }

    /// verify(阶段六 WP-61;协议 §四):独立裁决重放。仅未装载阶段受理
    /// (独立一次性裁决进程形态;已装载会话进程不可达)。载荷 / 镜像 / 身份 /
    /// seed / 版本锁定 / 上下文 / 日志形态任一拒绝 = `challenge_invalid` 方向
    /// 命令级错误,进程存活、阶段不变(与 load 同判;重放本身经
    /// `session::verify::verify` 委托 `vm_runtime::replay`,ADR-8 同一份实现)。
    fn handle_verify(
        &self,
        seq: u64,
        private_bundle: Value,
        public_descriptor: Value,
        session_seed_hex: Option<String>,
        replay_context: Value,
        action_log: String,
    ) -> Result<WorkerOutbound, ProtocolViolation> {
        if !matches!(self.phase, Phase::AwaitingLoad) {
            return Err(ProtocolViolation::StateViolation { seq });
        }
        let reject = || {
            Ok(WorkerOutbound::CommandError {
                seq,
                error: WorkerError::new(WorkerErrorCode::ChallengeInvalid),
            })
        };
        // 双包 Schema 复验(与 load 同闸;上下文与日志的形态校验在 verify 内)。
        if !self.validators.private_bundle.is_valid(&private_bundle)
            || !self
                .validators
                .public_descriptor
                .is_valid(&public_descriptor)
        {
            return reject();
        }
        let identity = EngineIdentity {
            vm_engine_version: String::from(VM_ENGINE_VERSION),
            engine_build_id: String::from(ENGINE_BUILD_ID),
        };
        match crate::session::verify::verify(
            private_bundle,
            public_descriptor,
            session_seed_hex.as_deref(),
            replay_context,
            &action_log,
            &identity,
        ) {
            Ok(report) => {
                log_verify_outcome(seq, report.verdict.as_str());
                Ok(WorkerOutbound::VerifyReport { seq, report })
            }
            Err(rejection) => {
                eprintln!("[vm-worker] verify_rejected reason={}", rejection.reason);
                reject()
            }
        }
    }

    /// apply_action(§四):载荷契约校验失败 → 确定性 `rejected` 响应
    /// (revision 不变、delta null、事件空,§4.5 协议级拒绝行);通过校验的
    /// 动作交会话托管执行(WP-8)。托管故障 = 尽力而为命令级错误 + 安全终止
    /// (D-W8-5)。
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
        let timeout = self
            .session
            .as_ref()
            .map(SessionHost::timeout_ms_per_action);
        if let (Some(watchdog), Some(timeout_ms)) = (&self.watchdog, timeout) {
            watchdog.arm(timeout_ms);
        }
        let result = self
            .session
            .as_mut()
            .ok_or(ProtocolViolation::StateViolation { seq })?
            .apply(&mirror.action);
        if let Some(watchdog) = &self.watchdog {
            watchdog.disarm();
        }
        match result {
            Ok(ApplyResult::Executed(executed)) => {
                let action_response =
                    outbound::action_response_to_json(request_id, &executed.response);
                let checkpoint_export = executed
                    .checkpoint_export
                    .as_ref()
                    .map(outbound::checkpoint_export_to_json);
                self.self_check_action_response(&action_response)?;
                Ok(WorkerOutbound::ActionResponse {
                    seq,
                    action_response,
                    checkpoint_export,
                })
            }
            Ok(ApplyResult::Rejected(response)) => {
                let action_response = outbound::action_response_to_json(request_id, &response);
                self.self_check_action_response(&action_response)?;
                Ok(WorkerOutbound::ActionResponse {
                    seq,
                    action_response,
                    checkpoint_export: None,
                })
            }
            Err(fault) => self.fault_termination(seq, &fault),
        }
    }

    /// query_projection(§四):当前完整公开投影(冻结 Schema 出站自检后发出)。
    fn handle_query_projection(&mut self, seq: u64) -> Result<WorkerOutbound, ProtocolViolation> {
        let projection = match self
            .session
            .as_mut()
            .ok_or(ProtocolViolation::StateViolation { seq })?
            .projection()
        {
            Ok(projection) => projection,
            Err(fault) => return self.fault_termination(seq, &fault),
        };
        let value = outbound::projection_to_json(projection);
        if !self.validators.public_state_projection.is_valid(&value) {
            return Err(ProtocolViolation::ContractInconsistency);
        }
        Ok(WorkerOutbound::Projection {
            seq,
            projection: value,
        })
    }

    /// export_snapshot(§四):快照信封(崩溃恢复点)。
    fn handle_export_snapshot(&mut self, seq: u64) -> Result<WorkerOutbound, ProtocolViolation> {
        let envelope = match self
            .session
            .as_ref()
            .ok_or(ProtocolViolation::StateViolation { seq })?
            .snapshot_envelope()
        {
            Ok(envelope) => envelope,
            Err(fault) => return self.fault_termination(seq, &fault),
        };
        Ok(WorkerOutbound::SnapshotExported {
            seq,
            snapshot: envelope,
        })
    }

    /// import_snapshot(§四):快照信封与版本绑定校验(D-F5)→ 内容形态交
    /// 运行时严格解析与替换恢复(WP-6);载荷形态失败 = 命令级
    /// `challenge_invalid`(进程存活;替换解析先于任何变更,会话未被触及)。
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
        let outcome = self
            .session
            .as_mut()
            .ok_or(ProtocolViolation::StateViolation { seq })?
            .replace_from_snapshot(&envelope.payload);
        match outcome {
            Ok(()) => Ok(WorkerOutbound::SnapshotImported { seq }),
            Err(HostFault::Snapshot(_)) => Ok(WorkerOutbound::CommandError {
                seq,
                error: WorkerError::new(WorkerErrorCode::ChallengeInvalid),
            }),
            Err(fault) => self.fault_termination(seq, &fault),
        }
    }

    /// 出站 `ActionResponse` 自检(§3.4):冻结 Schema 复验;失败 = 引擎缺陷。
    fn self_check_action_response(&self, response: &Value) -> Result<(), ProtocolViolation> {
        if !self.validators.action_response.is_valid(response) {
            return Err(ProtocolViolation::ContractInconsistency);
        }
        Ok(())
    }

    /// 托管故障处置(D-W8-5):尽力而为命令级错误 + 安全终止标记。
    /// `challenge_invalid` 方向(谓词预算耗尽 / 快照形态之外的题目侧故障)
    /// 与 `engine_error` 方向都终止进程——会话一致性在故障后不可信。
    fn fault_termination(
        &mut self,
        seq: u64,
        fault: &HostFault,
    ) -> Result<WorkerOutbound, ProtocolViolation> {
        let code = match fault {
            HostFault::Runtime(
                RuntimeError::PredicateBudgetExhausted { .. }
                | RuntimeError::MemoryBudgetExceeded { .. }
                | RuntimeError::VersionLock(_),
            )
            | HostFault::Snapshot(_) => WorkerErrorCode::ChallengeInvalid,
            HostFault::Runtime(_) | HostFault::Projection(_) | HostFault::ContractInconsistency => {
                WorkerErrorCode::InternalError
            }
        };
        self.terminal = Some("session_fault");
        Ok(WorkerOutbound::CommandError {
            seq,
            error: WorkerError::new(code),
        })
    }

    /// 协议级拒绝响应(§4.5):status `rejected` + `invalid_input_format`,
    /// revision 不变、`projectionDelta: null`、`publicEvents: []`,出站先自检。
    fn rejected_action_response(
        &self,
        seq: u64,
        request_id: &str,
    ) -> Result<WorkerOutbound, ProtocolViolation> {
        let revision = self
            .session
            .as_ref()
            .map(SessionHost::revision)
            .unwrap_or(0);
        let response = serde_json::json!({
            "requestId": request_id,
            "revision": revision,
            "status": "rejected",
            "projectionDelta": null,
            "publicEvents": [],
            "userVisibleError": {
                "code": WorkerErrorCode::InvalidInputFormat,
                "message": WorkerErrorCode::InvalidInputFormat.message(),
            }
        });
        self.self_check_action_response(&response)?;
        Ok(WorkerOutbound::ActionResponse {
            seq,
            action_response: response,
            checkpoint_export: None,
        })
    }
}

/// 装配拒绝的受控日志(仅事件 + 确定性原因标签;无载荷内容,§3.4)。
fn log_assembly_reject(reason: &'static str) {
    eprintln!("[vm-worker] load_rejected reason={reason}");
}

/// 调试面载荷级拒绝(冻结 `invalid_input_format` 静态模板;进程存活)。
fn command_invalid_input(seq: u64) -> WorkerOutbound {
    WorkerOutbound::CommandError {
        seq,
        error: WorkerError::new(WorkerErrorCode::InvalidInputFormat),
    }
}

/// 调试面重放错位 / 载荷镜像失败的命令级错误(冻结 `internal_error` 静态
/// 模板;进程存活——错位处置归编排器中止 attach 并回收实例)。
fn command_internal_error(seq: u64) -> WorkerOutbound {
    WorkerOutbound::CommandError {
        seq,
        error: WorkerError::new(WorkerErrorCode::InternalError),
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
pub(crate) fn is_seed_hex(value: &str) -> bool {
    (16..=64).contains(&value.len())
        && value.len().is_multiple_of(2)
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// verify 裁决完成受控日志(仅事件 + 裁决字面;无载荷内容,§3.4)。
fn log_verify_outcome(seq: u64, verdict: &str) {
    eprintln!("[vm-worker] verify_completed seq={seq} verdict={verdict}");
}

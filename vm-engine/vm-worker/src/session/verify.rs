//! 独立裁决重放(阶段六 WP-61;Q1 定案候选 (b):引擎进程协议 verify 命令面,
//! 契约面 (b) 正式启用)。
//!
//! # 语义锚点
//!
//! - **ADR-8 单一实现**:本模块零裁决逻辑——装配与交互执行共用
//!   [`assemble_replay_config`](crate::session::assemble::assemble_replay_config),
//!   重放逐项比对委托 [`vm_runtime::replay::replay`](vm_runtime::replay)(与
//!   黄金回放同一份代码),TS 侧(verifier 服务)零裁决语义、纯搬运与落库;
//! - **请求面**(协议 §四 verify;主控定案):会话上下文(六记录项)+
//!   私有包 + 公开描述包 + 规范化动作日志(`stackmaster-action-log/1` 文本,
//!   可选会话种子);帧体受 `MAX_FRAME_BYTES` 约束(调用方预检,协议文档 §四);
//! - **响应面**:裁决面(11 值结果类型,WP-61 交付重放裁决面;WP-62 隐藏测试
//!   汇总按协议变更纪律增补,不设预留字段)+ 重放逐项结论 + `log_digest`
//!   复算值。响应帧整体 SERVER_ONLY:仅受控日志与审计消费,零浏览器可达面;
//! - **裁决映射**(WP-61 重放面;登记于 ADR-9 / D-API-87):逐项一致时
//!   `won → success`;`failed` 按日志末条目引擎结局标签粗化
//!   (`program_crash` / `memory_fault` / `resource_limit` / `engine_error`,
//!   其余 → `wrong_answer`);非终态 → `wrong_answer`(fail-closed:未达成
//!   成功条件不判成功)。`ContextMismatch` → `challenge_invalid`(题目侧
//!   错配);逐项漂移 → `replay_mismatch`;运行时故障按 D-W8-5 方向表
//!   (谓词预算 / 内存护栏 / 版本锁定 → `challenge_invalid`,其余
//!   → `engine_error`)。

use serde::{Deserialize, Serialize};
use vm_core::state::VmStatus;
use vm_runtime::action_log::{ActionLog, EngineOutcome, ReplayContext};
use vm_runtime::identity::EngineIdentity;
use vm_runtime::replay::{ReplayError, replay};
use vm_runtime::sha256::{hex, sha256};

use crate::contract::mirrors::{PrivateBundleMirror, PublicDescriptorExtract, SeedStrategy};
use crate::protocol::message::WorkerOutbound;
use crate::protocol::version::{ENGINE_BUILD_ID, VM_ENGINE_VERSION};
use crate::protocol::worker::is_seed_hex;
use crate::session::assemble::{self, AssembleError};

/// 裁决拒绝(方向 = challenge_invalid;`reason` 为确定性定位标签,只进受控
/// 日志,不进公开响应)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyRejection {
    pub reason: &'static str,
}

fn reject(reason: &'static str) -> VerifyRejection {
    VerifyRejection { reason }
}

/// 裁决面(11 值结果类型;冻结枚举 `VerdictResultSchema` 的 Rust 镜像,
/// 零新增字面)。
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VerifyVerdict {
    Success,
    WrongAnswer,
    InvalidAction,
    ProgramCrash,
    MemoryFault,
    ResourceLimit,
    Timeout,
    EngineError,
    ChallengeInvalid,
    ReplayMismatch,
    Cancelled,
}

impl VerifyVerdict {
    pub fn as_str(&self) -> &'static str {
        match self {
            VerifyVerdict::Success => "success",
            VerifyVerdict::WrongAnswer => "wrong_answer",
            VerifyVerdict::InvalidAction => "invalid_action",
            VerifyVerdict::ProgramCrash => "program_crash",
            VerifyVerdict::MemoryFault => "memory_fault",
            VerifyVerdict::ResourceLimit => "resource_limit",
            VerifyVerdict::Timeout => "timeout",
            VerifyVerdict::EngineError => "engine_error",
            VerifyVerdict::ChallengeInvalid => "challenge_invalid",
            VerifyVerdict::ReplayMismatch => "replay_mismatch",
            VerifyVerdict::Cancelled => "cancelled",
        }
    }
}

/// 重放逐项结论(SERVER_ONLY 明细;受控日志与审计消费)。
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum VerifyReplayOutcome {
    /// 逐项一致(受理性 / revision / 状态哈希 / 结局标签全比对通过)。
    Matched {
        final_revision: u64,
        final_status: String,
        state_hash_sequence: Vec<String>,
        revision_sequence: Vec<u64>,
    },
    /// 条目级漂移(首个不一致条目)。
    Diverged {
        entry: u64,
        field: String,
        expected: String,
        actual: String,
    },
    /// 日志上下文与重放装配不一致(题目 / 引擎 / seed 策略错配)。
    ContextMismatch,
    /// 运行时故障(安全终止方向;reason 为调试标签,只进受控日志)。
    Fault { reason: String },
}

/// verify 响应载荷(协议 §四 verify_report;整体 SERVER_ONLY)。
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    /// 裁决面(11 值结果类型)。
    pub verdict: VerifyVerdict,
    /// 重放逐项结论。
    pub replay: VerifyReplayOutcome,
    /// 规范化动作日志 SHA-256 复算值(64 hex;与提交时登记的 `log_digest`
    /// 绑定锚同源,D-API-85)。
    pub log_digest: String,
}

/// 回放上下文镜像(六记录项 + 架构位宽 + seed 策略元数据;**不含 seed 值**)。
/// `export_action_log` 序列化面与 `verify` 请求面共用同一形态(单一实现)。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReplayContextMirror {
    pub challenge_id: String,
    pub challenge_content_version: String,
    pub vm_profile_version: String,
    pub vm_engine_version: String,
    pub engine_build_id: String,
    pub verdict_rule_version: String,
    pub challenge_bundle_hash: String,
    pub vm_profile_hash: String,
    pub arch_bits: u32,
    pub seed_policy: SeedPolicyMirror,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SeedPolicyMirror {
    pub strategy: String,
    pub derivation: Option<DerivationMirror>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DerivationMirror {
    pub algorithm_id: String,
    pub draws: u64,
}

/// `ReplayContext` → 镜像(export 与请求比对共用;单一转换点)。
pub fn context_mirror(context: &ReplayContext) -> ReplayContextMirror {
    ReplayContextMirror {
        challenge_id: context.challenge_id.clone(),
        challenge_content_version: context.challenge_content_version.clone(),
        vm_profile_version: context.vm_profile_version.clone(),
        vm_engine_version: context.vm_engine_version.clone(),
        engine_build_id: context.engine_build_id.clone(),
        verdict_rule_version: context.verdict_rule_version.clone(),
        challenge_bundle_hash: context.challenge_bundle_hash.clone(),
        vm_profile_hash: context.vm_profile_hash.clone(),
        arch_bits: context.arch_bits,
        seed_policy: SeedPolicyMirror {
            strategy: context.seed_policy.strategy.clone(),
            derivation: context
                .seed_policy
                .derivation
                .as_ref()
                .map(|meta| DerivationMirror {
                    algorithm_id: meta.algorithm_id.clone(),
                    draws: meta.draws,
                }),
        },
    }
}

/// verify 主体(装配 → 上下文三向一致性 → 日志解析 → 重放逐项比对 → 裁决)。
///
/// 拒绝序与 `load` 同构(fail-closed,任一步拒绝即整体拒绝):
/// 镜像解析 → 双包身份一致 → seed 互斥 → 版本锁定 → 装配 → 请求上下文比对
/// → 日志形态解析 → 重放。
pub fn verify(
    bundle_json: serde_json::Value,
    public_json: serde_json::Value,
    session_seed_hex: Option<&str>,
    context_json: serde_json::Value,
    action_log_text: &str,
    identity: &EngineIdentity,
) -> Result<VerifyReport, VerifyRejection> {
    let mirror: PrivateBundleMirror =
        serde_json::from_value(bundle_json.clone()).map_err(|_| reject("bundle_mirror"))?;
    let public: PublicDescriptorExtract =
        serde_json::from_value(public_json.clone()).map_err(|_| reject("public_mirror"))?;
    // 双包身份一致(XS-ID-CORR 镜像;与 load 同判)。
    if mirror.challenge_id != public.challenge_id
        || mirror.challenge_content_version != public.challenge_content_version
        || mirror.vm_profile_version != public.vm_profile_version
    {
        return Err(reject("identity_mismatch"));
    }
    // seed 策略互斥(与 load 同序:fixed 禁会话种子;server_random 必带)。
    match (&mirror.seed_policy.strategy, session_seed_hex) {
        (SeedStrategy::Fixed, Some(_)) | (SeedStrategy::ServerRandomPerSession, None) => {
            return Err(reject("seed_policy"));
        }
        _ => {}
    }
    if let Some(seed) = session_seed_hex
        && !is_seed_hex(seed)
    {
        return Err(reject("seed_hex"));
    }
    // 版本锁定(版本策略 §四.4:verifier 与交互执行同引擎构建;宁可拒绝)。
    if mirror.vm_engine_version != VM_ENGINE_VERSION {
        return Err(reject("version_lock"));
    }
    if let Some(declared) = &mirror.engine_build_id
        && declared != ENGINE_BUILD_ID
    {
        return Err(reject("build_lock"));
    }
    // 装配(与 load 共用同一实现;任一步拒绝 = challenge_invalid 方向)。
    let config = assemble::assemble_replay_config(
        &mirror,
        &bundle_json,
        &public,
        &public_json,
        session_seed_hex,
        identity,
    )
    .map_err(|AssembleError { reason }| reject(reason))?;
    // 请求上下文 == 装配产物(六记录项在装配层的复验;请求谎报包哈希在此拒绝)。
    let requested: ReplayContextMirror =
        serde_json::from_value(context_json).map_err(|_| reject("context_form"))?;
    if requested != context_mirror(&config.context) {
        return Err(reject("context_mismatch"));
    }
    // 日志形态解析(日志是不可信入站;方向 challenge_invalid,快照与回放
    // 语义规约 action_log_parse_rejects_drifted_payload 同锚)。
    let log = ActionLog::from_canonical_text(action_log_text).map_err(|_| reject("log_form"))?;
    let digest = hex(&sha256(action_log_text.as_bytes()));

    match replay(config, &log) {
        Ok(report) => {
            let final_status = status_label(report.final_status);
            let verdict = verdict_from_replay(report.final_status, &log);
            Ok(VerifyReport {
                verdict,
                replay: VerifyReplayOutcome::Matched {
                    final_revision: *report.revision_sequence.last().unwrap_or(&0),
                    final_status,
                    state_hash_sequence: report.state_hash_sequence,
                    revision_sequence: report.revision_sequence,
                },
                log_digest: digest,
            })
        }
        Err(ReplayError::ContextMismatch) => Ok(VerifyReport {
            verdict: VerifyVerdict::ChallengeInvalid,
            replay: VerifyReplayOutcome::ContextMismatch,
            log_digest: digest,
        }),
        Err(ReplayError::Mismatch {
            entry,
            field,
            expected,
            actual,
        }) => Ok(VerifyReport {
            verdict: VerifyVerdict::ReplayMismatch,
            replay: VerifyReplayOutcome::Diverged {
                entry,
                field: field.to_owned(),
                expected,
                actual,
            },
            log_digest: digest,
        }),
        Err(ReplayError::Fault(error)) => {
            let verdict = fault_verdict(&error);
            Ok(VerifyReport {
                verdict,
                replay: VerifyReplayOutcome::Fault {
                    reason: format!("{error:?}"),
                },
                log_digest: digest,
            })
        }
    }
}

/// 终态标签(小写;与公开投影 status 词汇同源)。
fn status_label(status: VmStatus) -> String {
    match status {
        VmStatus::Running => String::from("running"),
        VmStatus::Paused => String::from("paused"),
        VmStatus::Won => String::from("won"),
        VmStatus::Failed => String::from("failed"),
    }
}

/// 重放面裁决映射(见模块文档;WP-62 隐藏测试汇总在此之上合成,失败方向
/// 优先,沿判题语义规约 §1.1 fail-closed)。
fn verdict_from_replay(final_status: VmStatus, log: &ActionLog) -> VerifyVerdict {
    match final_status {
        VmStatus::Won => VerifyVerdict::Success,
        VmStatus::Failed => match log.entries().last().map(|entry| &entry.outcome.engine) {
            Some(EngineOutcome::Failed { reason }) => match *reason {
                "invalid_rip" | "invalid_syscall_dispatch" | "canary_violation" => {
                    VerifyVerdict::ProgramCrash
                }
                "memory_fault" => VerifyVerdict::MemoryFault,
                "resource_limit" => VerifyVerdict::ResourceLimit,
                "invariant_broken" => VerifyVerdict::EngineError,
                _ => VerifyVerdict::WrongAnswer,
            },
            _ => VerifyVerdict::WrongAnswer,
        },
        _ => VerifyVerdict::WrongAnswer,
    }
}

/// 运行时故障的裁决方向(D-W8-5 方向表同构)。
fn fault_verdict(error: &vm_runtime::runtime::RuntimeError) -> VerifyVerdict {
    use vm_runtime::runtime::RuntimeError;
    match error {
        RuntimeError::PredicateBudgetExhausted { .. }
        | RuntimeError::MemoryBudgetExceeded { .. }
        | RuntimeError::VersionLock(_) => VerifyVerdict::ChallengeInvalid,
        RuntimeError::IdentityMismatch | RuntimeError::JudgeInternal | RuntimeError::Form(_) => {
            VerifyVerdict::EngineError
        }
    }
}

/// export_action_log 响应装配(`WorkerOutbound::ActionLogExported`)。
pub fn export_outcome(seq: u64, context: &ReplayContext, log_text: String) -> WorkerOutbound {
    WorkerOutbound::ActionLogExported {
        seq,
        replay_context: serde_json::to_value(context_mirror(context))
            .unwrap_or(serde_json::Value::Null),
        action_log: log_text,
    }
}

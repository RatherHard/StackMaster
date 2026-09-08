//! 响应面装配:`ActionResponse` 投影面五字段的生成(WP-1 §6.2 / §4.4 耦合)。
//!
//! # 两形态(唯一入口,契约耦合的结构性保证)
//!
//! - [`executed_action`]:已执行动作(含教学性失败)——revision 已由调用方
//!   账本推进,`projectionDelta` 恒存在、`publicEvents` 承载本动作公开事件、
//!   `userVisibleError` 可携带(教学反馈);
//! - [`rejected_action`]:执行前拒绝——`status = rejected`、错误必有、
//!   增量恒 `null`、事件恒空(§4.4:拒绝必须可解释、不产生投影)。
//!
//! 构造器是两形态的唯一入口:rejected 形态的耦合由构造器结构性保证,
//! 不存在"拒绝却带增量"的可表达形态(ZR-P5 revision 增量 ∈ {0, +1} 的
//! 响应侧镜像)。

use vm_core::state::VmEvent;
use vm_core::state::VmState;

use crate::ProjectionError;
use crate::error::{self, RejectionReason};
use crate::events::public_events;
use crate::policy::ProjectionPolicy;
use crate::project::{GenerationView, delta_projection};
use crate::types::{ActionProjection, PublicError, PublicStateProjection};

/// 已执行动作的响应面(教学性失败:`error` 携带已粗化错误;revision 前进
/// 与否由调用方账本承载,信封 revision = 动作后权威值)。
pub fn executed_action(
    revision: u64,
    view: &GenerationView<'_>,
    before: &PublicStateProjection,
    state: &VmState,
    new_private_events: &[VmEvent],
    error: Option<PublicError>,
) -> Result<ActionProjection, ProjectionError> {
    let delta = delta_projection(revision, view, before, state, new_private_events)?;
    let events = public_events(view.policy, &state.memory, new_private_events);
    let status = crate::project::project_status(state.status);
    Ok(ActionProjection::executed(
        revision, status, delta, events, error,
    ))
}

/// 执行前拒绝的响应面(§4.4 耦合形态;revision = 当前值不动)。
pub fn rejected_action(revision: u64, error: PublicError) -> ActionProjection {
    ActionProjection::rejected(revision, error)
}

/// 拒绝原因 → 响应面(粗化单点在 [`crate::error::rejection_error`])。
pub fn rejected_from_reason(
    revision: u64,
    reason: &RejectionReason,
    policy: &ProjectionPolicy,
    state: &VmState,
) -> Result<ActionProjection, ProjectionError> {
    let error = error::rejection_error(reason, policy, &state.memory)?;
    Ok(rejected_action(revision, error))
}

/// 已执行但判定失败(检查点置 failed)的响应面错误:E-4 零解释形态
/// (`objective_not_met`);status = failed 由状态投影承载(D1 公开时点)。
pub fn judge_failed_error(
    policy: &ProjectionPolicy,
    state: &VmState,
) -> Result<PublicError, ProjectionError> {
    error::objective_not_met(policy, &state.memory)
}

#[cfg(test)]
mod tests {
    use alloc::string::String;

    use super::*;
    use crate::canon::compare_utf16;
    use crate::types::CanonicalText;

    /// §4.4 耦合的结构性:rejected 构造器产出恒满足
    /// "delta null + events 空 + error 必有"(写入键序测试的反向锚)。
    #[test]
    fn rejected_shape_is_structurally_coupled() {
        let error = PublicError {
            code: crate::types::PublicErrorCode::InaccessibleAddress,
            message: String::from("目标地址不可访问"),
            address: crate::types::ErrorAddress::Null,
            explanation: None,
        };
        let response = rejected_action(12, error);
        assert_eq!(response.status, crate::types::ResponseStatus::Rejected);
        assert!(response.delta.is_none());
        assert!(response.events.is_empty());
        assert!(response.error.is_some());
        // 规范化文本键序(projectionDelta < publicEvents < revision < status
        // < userVisibleError)已由 types 测试断言;此处复核键序函数可用。
        assert_eq!(
            compare_utf16("projectionDelta", "publicEvents"),
            core::cmp::Ordering::Less
        );
    }

    /// executed 装配的 revision 同源:delta.revision == 信封 revision
    /// (生成侧同值注入,superRefine 跨字段规则的引擎侧保证)。
    #[test]
    fn executed_delta_revision_matches_envelope() {
        use crate::testkit::{build_engine, policy_with_level, statics, view_for};

        let policy = policy_with_level(crate::policy::ErrorDetailLevel::Educational);
        let statics = statics();
        let engine = build_engine(&[], &[], true);
        let view = view_for(&policy, &statics, &engine, None);
        let before = crate::project::full_projection(0, &view, &engine.state).expect("初始投影");
        let response =
            executed_action(1, &view, &before, &engine.state, &[], None).expect("装配成功");
        assert_eq!(response.revision, 1);
        let delta = response.delta.as_ref().expect("已执行动作增量恒存在");
        assert_eq!(delta.revision, 1);
        assert_eq!(
            CanonicalText::to_canonical(&response),
            alloc::format!(
                "{{\"projectionDelta\":{},\"publicEvents\":[],\"revision\":1,\
                 \"status\":\"running\"}}",
                CanonicalText::to_canonical(delta)
            )
        );
    }
}

//! 判题语义(WP-5):谓词求值、权威成功 / 失败判定、多阶段状态机运行时、
//! seed 策略、隐藏测试执行。权威规约:`docs/develop/判题语义规约.md`。
//!
//! # 模块面
//!
//! - [`predicate`]:7 内置谓词 + 三级布尔条件求值器(白名单结构性不可越界,
//!   恒定成本:字节比较全量无提前退出、布尔组合不短路);
//! - [`spec`]:判题面装配输入与镜像复验(XS-PRED-REFS / XS-NESTING /
//!   XS-STAGE-* 的引擎侧镜像,fail-closed);
//! - `Judge`:判题驱动——动作闸门(gate)与动作后检查点(settle),
//!   `status` won / failed 的权威时点判定;
//! - [`seed`]:seed 策略解析(XS-SEED-POLICY 镜像)+ 注入式随机源与确定性派生器;
//! - [`hidden`]:隐藏测试执行驱动(7 值可达判定分类器,阶段六 verifier 复用)。
//!
//! # 求值时点(D-J1 / 计划书 6.2)
//!
//! 每个已执行动作的状态转换之后、投影生成之前:`gate(闸门)→ 引擎执行 →
//! settle(检查点:阶段步数预算 → 失败条件 → 成功条件 → 阶段迁移)`。
//! 管理类动作(undo / checkout / reset / create_checkpoint)不重新求值
//! (D1 约束 5);失败优先于成功(fail-closed)。
//!
//! # 预算(D-J6)
//!
//! 一步 = 一次内置谓词实例求值;预算 = `constraints.predicate_evals`
//! (CumulativeBudget,跨 undo / reset 不重置),上限单源于
//! `judgingConfig.maxPredicateEvalSteps`;检查点先静态计数后一次性预扣,
//! 耗尽 = `challenge_invalid` 方向安全终止(非玩家可及的 resource_limit)。

pub mod hidden;
pub mod predicate;
pub mod seed;
pub mod spec;

use alloc::vec::Vec;

use crate::exec::Engine;
use crate::judge::predicate::{evaluate_l1, predicate_count};
use crate::judge::spec::{
    JudgeAssembleError, JudgingContext, JudgingSpec, ResolvedStages, SessionActionType,
    StageSideEffect, assemble,
};
use crate::state::{VmEvent, VmEventKind, VmStatus};

// 判题事件载荷标签(规约 §1.5;引擎生成的定长标签,不携带谓词内容或秘密值)。
const TAG_WON: u8 = 0x01;
const TAG_FAILED: u8 = 0x02;
const TAG_STAGE_ENTERED: u8 = 0x03;
const TAG_STAGE_BUDGET: u8 = 0x04;

/// 阶段运行时状态(每次进入阶段即清零;快照承载归 WP-6)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageState {
    /// 当前阶段索引(装配 = 0)。
    pub index: usize,
    /// 本阶段(本次进入)已耗指令步数。
    pub steps_used: u64,
    /// 本阶段(本次进入)已受理动作数。
    pub actions_used: u64,
}

/// 动作类别(检查点语义的分型:D1 约束 5 的管理类动作不求值)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionClass {
    /// 执行类:write_bytes / push / pop / call / ret / step / run_to_event / pause。
    Execution,
    /// 管理类:undo / checkout_checkpoint / reset / create_checkpoint(不重新求值)。
    Management,
}

impl SessionActionType {
    /// 动作类别(管理类 = 状态管理四动作)。
    pub fn class(self) -> ActionClass {
        match self {
            SessionActionType::Undo
            | SessionActionType::CheckoutCheckpoint
            | SessionActionType::Reset
            | SessionActionType::CreateCheckpoint => ActionClass::Management,
            _ => ActionClass::Execution,
        }
    }
}

/// 动作闸门拒绝(方向注释为公开错误映射依据;粗化归 WP-7)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionRejection {
    /// 终态会话拒绝一切 12 动作(D1 约束 5;确定性错误)。
    Terminal,
    /// 当前阶段 `allowedActions` 不含该动作(方向 `invalid_action`)。
    StageDisallowsAction,
    /// 当前阶段 `maxActions` 已达上限(方向 `resource_limit`)。
    StageActionBudget,
}

/// 动作执行报告(settle 输入;由动作循环在执行前后对
/// `constraints.steps.used` 取增量得到)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActionReport {
    /// 动作类别。
    pub class: ActionClass,
    /// 本动作实际消耗的引擎步数(指令步;管理类为 0)。
    pub steps_executed: u64,
}

/// 检查点结局。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettleOutcome {
    /// 无终态、无迁移(状态保持)。
    Running,
    /// `successCondition` 达成(状态已置 `won`)。
    Won,
    /// 失败条件或阶段步数预算触发(状态已置 `failed`)。
    Failed {
        /// 失败来源。
        source: FailureSource,
    },
    /// 阶段迁移已发生(含新阶段副作用 `FileGranted` 事件)。
    StageEntered {
        /// 目标阶段索引。
        to_stage: usize,
    },
}

/// 失败来源(私有事件载荷与受控日志的定位信息;公开面只有 failed)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureSource {
    /// 题级失败条件(声明序)。
    ChallengeCondition(usize),
    /// 当前阶段级失败条件。
    StageCondition {
        /// 阶段索引。
        stage: usize,
        /// 条件声明序。
        condition: usize,
    },
    /// 阶段指令步数预算超限(方向 resource_limit)。
    StageStepBudget {
        /// 阶段索引。
        stage: usize,
    },
}

/// 判题运行时错误(方向注释:调用方映射)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JudgeError {
    /// 谓词求值次数预算耗尽(方向 `challenge_invalid` 安全终止,规约 §1.3)。
    PredicateBudgetExhausted {
        /// 本次请求量。
        requested: u64,
        /// 剩余额度。
        available: u64,
    },
    /// 求值器命中装配后不可达路径(方向 `engine_error`)。
    Internal(&'static str),
}

/// 判题驱动:装配产物 + 阶段运行时状态。与 [`Engine`] 分离持有
/// (`VmState` 冻结 8 字段不含判题面),快照 / 回放侧由 WP-6 承载本状态。
#[derive(Debug, Clone)]
pub struct Judge {
    spec: JudgingSpec,
    transition_targets: Vec<Vec<usize>>,
    stage: Option<StageState>,
}

impl Judge {
    /// 装配:判题面全量镜像复验(规约 §4.2,方向 `challenge_invalid`)+
    /// 初始阶段前置求值 + 阶段运行时初始化(进入事件与副作用触发)。
    pub fn assemble(
        spec: JudgingSpec,
        context: &JudgingContext,
        engine: &mut Engine,
    ) -> Result<Self, JudgeAssembleError> {
        let ResolvedStages { transition_targets } = assemble(&spec, context, engine)?;
        let mut judge = Self {
            spec,
            transition_targets,
            stage: None,
        };
        if !judge.spec.stages.is_empty() {
            judge.stage = Some(StageState {
                index: 0,
                steps_used: 0,
                actions_used: 0,
            });
            log_tagged(engine, TAG_STAGE_ENTERED, &0u64.to_le_bytes());
            judge.fire_side_effects(engine, 0);
        }
        Ok(judge)
    }

    /// 判题面引用。
    pub fn spec(&self) -> &JudgingSpec {
        &self.spec
    }

    /// 阶段运行时状态(None = 单阶段题)。
    pub fn stage(&self) -> Option<&StageState> {
        self.stage.as_ref()
    }

    /// 动作闸门(规约 §4.3):终态 → 阶段允许动作 → 阶段动作数预算;
    /// 通过返回步数窗口 = min(全局剩余, 阶段剩余)。
    pub fn gate(&self, engine: &Engine, action: SessionActionType) -> Result<u64, ActionRejection> {
        if engine.state.status.is_terminal() {
            return Err(ActionRejection::Terminal);
        }
        let global_window = engine.state.constraints.steps.remaining();
        let Some(stage_state) = &self.stage else {
            return Ok(global_window);
        };
        let spec = &self.spec.stages[stage_state.index];
        if !spec.allowed_actions.contains(&action) {
            return Err(ActionRejection::StageDisallowsAction);
        }
        if let Some(max_actions) = spec.max_actions
            && stage_state.actions_used >= max_actions
        {
            return Err(ActionRejection::StageActionBudget);
        }
        let stage_window = spec
            .max_instruction_steps
            .saturating_sub(stage_state.steps_used);
        Ok(global_window.min(stage_window))
    }

    /// 动作后检查点(规约 §4.4):阶段预算记账 → 失败条件 → 成功条件 → 阶段迁移。
    pub fn settle(
        &mut self,
        engine: &mut Engine,
        report: ActionReport,
    ) -> Result<SettleOutcome, JudgeError> {
        // ① 阶段动作数 +1(受理即计数;管理类动作的阶段状态随后由快照恢复)。
        if let Some(stage) = self.stage.as_mut() {
            stage.actions_used = stage.actions_used.saturating_add(1);
        }
        // ② 阶段步数记账;超限 ⇒ failed(resource_limit 方向;夹逼下恰达上限不触发)。
        if let Some(stage) = self.stage.as_mut() {
            stage.steps_used = stage.steps_used.saturating_add(report.steps_executed);
            let index = stage.index;
            if stage.steps_used > self.spec.stages[index].max_instruction_steps {
                engine.state.status = VmStatus::Failed;
                log_tagged(engine, TAG_STAGE_BUDGET, &(index as u64).to_le_bytes());
                return Ok(SettleOutcome::Failed {
                    source: FailureSource::StageStepBudget { stage: index },
                });
            }
        }
        // ③ 会话已终态(引擎异常 / 已判)⇒ 不再求值。
        if engine.state.status.is_terminal() {
            return Ok(SettleOutcome::Running);
        }
        // ④ 管理类动作 ⇒ 不重新求值(D1 约束 5)。
        if report.class == ActionClass::Management {
            return Ok(SettleOutcome::Running);
        }
        // ⑤ 预扣检查点步耗(静态计数;布尔不短路 ⇒ 与内容无关)。
        let stage_index = self.stage.as_ref().map(|s| s.index);
        let charge = self.checkpoint_charge(stage_index);
        engine
            .state
            .constraints
            .predicate_evals
            .charge(charge)
            .map_err(|e| JudgeError::PredicateBudgetExhausted {
                requested: e.requested,
                available: e.available,
            })?;
        // ⑥ 失败优先(fail-closed):题级 → 当前阶段级,全量求值,首个命中者上报。
        for (condition_index, condition) in self.spec.failure_conditions.iter().enumerate() {
            if eval(engine, condition)? {
                engine.state.status = VmStatus::Failed;
                log_tagged(engine, TAG_FAILED, &(condition_index as u64).to_le_bytes());
                return Ok(SettleOutcome::Failed {
                    source: FailureSource::ChallengeCondition(condition_index),
                });
            }
        }
        if let Some(index) = stage_index {
            for (condition_index, condition) in self.spec.stages[index]
                .failure_conditions
                .iter()
                .enumerate()
            {
                if eval(engine, condition)? {
                    engine.state.status = VmStatus::Failed;
                    log_tagged(
                        engine,
                        TAG_FAILED,
                        &(((index as u64) << 32) | (condition_index as u64)).to_le_bytes(),
                    );
                    return Ok(SettleOutcome::Failed {
                        source: FailureSource::StageCondition {
                            stage: index,
                            condition: condition_index,
                        },
                    });
                }
            }
        }
        // ⑦ 成功条件 ⇒ won(权威时点:检查点置位,公开时点归动作响应)。
        if eval(engine, &self.spec.success_condition)? {
            engine.state.status = VmStatus::Won;
            log_tagged(engine, TAG_WON, &[]);
            return Ok(SettleOutcome::Won);
        }
        // ⑧ 阶段迁移:全部迁移条件 + 全部目标前置全量求值,
        //    声明序首个(条件 ∧ 前置)者触发;一次检查点至多一次迁移。
        if let Some(index) = stage_index {
            let stage_spec = &self.spec.stages[index];
            let mut fired: Option<usize> = None;
            for (transition_index, transition) in stage_spec.transitions.iter().enumerate() {
                let on = eval(engine, &transition.on_condition)?;
                let target = self.transition_targets[index][transition_index];
                let pre = eval(engine, &self.spec.stages[target].preconditions)?;
                if on && pre && fired.is_none() {
                    fired = Some(target);
                }
            }
            if let Some(target) = fired {
                self.stage = Some(StageState {
                    index: target,
                    steps_used: 0,
                    actions_used: 0,
                });
                log_tagged(engine, TAG_STAGE_ENTERED, &(target as u64).to_le_bytes());
                self.fire_side_effects(engine, target);
                return Ok(SettleOutcome::StageEntered { to_stage: target });
            }
        }
        Ok(SettleOutcome::Running)
    }

    /// `reset` 的判题侧落点(规约 §4.6):阶段状态回初始、重新触发初始副作用;
    /// 谓词累计预算由 `Engine::reset` 保留(跨 reset 不重置)。
    pub fn reset(&mut self, engine: &mut Engine) {
        self.stage = self.spec.stages.first().map(|_| StageState {
            index: 0,
            steps_used: 0,
            actions_used: 0,
        });
        if let Some(index) = self.stage.as_ref().map(|s| s.index) {
            log_tagged(engine, TAG_STAGE_ENTERED, &(index as u64).to_le_bytes());
            self.fire_side_effects(engine, index);
        }
    }

    fn fire_side_effects(&self, engine: &mut Engine, stage_index: usize) {
        for effect in &self.spec.stages[stage_index].side_effects {
            let StageSideEffect::GrantVirtualFile { file_id } = effect;
            log_file_granted(engine, file_id.as_bytes());
        }
    }

    /// 检查点步耗(静态:失败 + 成功 + 迁移与目标前置的全部谓词实例数)。
    fn checkpoint_charge(&self, stage_index: Option<usize>) -> u64 {
        let mut total = predicate_count(&self.spec.success_condition);
        for condition in &self.spec.failure_conditions {
            total += predicate_count(condition);
        }
        if let Some(index) = stage_index {
            for condition in &self.spec.stages[index].failure_conditions {
                total += predicate_count(condition);
            }
            let targets = &self.transition_targets[index];
            for (transition_index, transition) in
                self.spec.stages[index].transitions.iter().enumerate()
            {
                total += predicate_count(&transition.on_condition);
                total +=
                    predicate_count(&self.spec.stages[targets[transition_index]].preconditions);
            }
        }
        total
    }
}

fn eval(engine: &Engine, condition: &predicate::ConditionL1) -> Result<bool, JudgeError> {
    evaluate_l1(engine, condition).map_err(|_| JudgeError::Internal("谓词引用已在装配复验封闭"))
}

fn log_tagged(engine: &mut Engine, tag: u8, detail: &[u8]) {
    let seq = engine.state.private_event_log.len() as u64;
    let mut payload = Vec::with_capacity(1 + detail.len());
    payload.push(tag);
    payload.extend_from_slice(detail);
    engine.state.private_event_log.push(VmEvent {
        seq,
        kind: VmEventKind::Internal,
        address: None,
        byte_length: None,
        payload: Some(payload),
    });
}

fn log_file_granted(engine: &mut Engine, file_id: &[u8]) {
    let seq = engine.state.private_event_log.len() as u64;
    engine.state.private_event_log.push(VmEvent {
        seq,
        kind: VmEventKind::FileGranted,
        address: None,
        byte_length: Some(file_id.len() as u64),
        payload: Some(file_id.to_vec()),
    });
}

#[cfg(test)]
mod tests {
    use super::spec::tests::{A32, STACK_BASE, engine_with_regions, file_context, vacuous_spec};
    use super::*;
    use crate::arch::ArchValue;
    use crate::judge::hidden::HiddenTestKind;
    use crate::judge::hidden::VerdictKind;
    use crate::judge::predicate::Predicate;
    use crate::judge::spec::{HiddenTestSpec, JudgingConfigLimits, StageSpec, StageTransitionSpec};
    use crate::state::VmStatus;
    use alloc::string::String;
    use alloc::string::ToString;

    fn v(raw: u64) -> ArchValue {
        ArchValue::new(raw, A32)
    }

    fn spec_with_success(condition: predicate::ConditionL1) -> JudgingSpec {
        let mut spec = vacuous_spec();
        spec.success_condition = condition;
        spec
    }

    fn success_on_rax(value: u64) -> predicate::ConditionL1 {
        predicate::ConditionL1::of(Predicate::RegisterEquals {
            register: String::from("RAX"),
            value: v(value),
        })
    }

    fn execution_report(steps: u64) -> ActionReport {
        ActionReport {
            class: ActionClass::Execution,
            steps_executed: steps,
        }
    }

    fn management_report() -> ActionReport {
        ActionReport {
            class: ActionClass::Management,
            steps_executed: 0,
        }
    }

    fn stage(id: &str, to: &str) -> StageSpec {
        StageSpec {
            stage_id: id.to_string(),
            allowed_actions: SessionActionType::ALL.to_vec(),
            preconditions: predicate::ConditionL1::vacuous_true(),
            transitions: if to.is_empty() {
                alloc::vec![]
            } else {
                alloc::vec![StageTransitionSpec {
                    to_stage: to.to_string(),
                    on_condition: predicate::ConditionL1::vacuous_true(),
                }]
            },
            side_effects: alloc::vec![],
            failure_conditions: alloc::vec![],
            max_instruction_steps: 1000,
            max_actions: None,
        }
    }

    /// 状态迁移时序:失败优先于成功(fail-closed);won 只在检查点置位一次。
    #[test]
    fn failure_precedes_success_and_won_sets_once() {
        // 失败与成功同帧为真 ⇒ failed。
        let mut engine = engine_with_regions();
        let mut spec = spec_with_success(success_on_rax(0));
        spec.failure_conditions = alloc::vec![success_on_rax(0)];
        let mut judge = Judge::assemble(spec, &file_context(), &mut engine).unwrap();
        let outcome = judge.settle(&mut engine, execution_report(0)).unwrap();
        assert!(matches!(
            outcome,
            SettleOutcome::Failed {
                source: FailureSource::ChallengeCondition(0)
            }
        ));
        assert_eq!(engine.state.status, VmStatus::Failed);
        // 终态后:一切 12 动作被闸门拒绝;再 settle 不重判。
        for action in SessionActionType::ALL {
            assert_eq!(judge.gate(&engine, action), Err(ActionRejection::Terminal));
        }
        assert_eq!(
            judge.settle(&mut engine, execution_report(0)).unwrap(),
            SettleOutcome::Running
        );
        assert_eq!(engine.state.status, VmStatus::Failed);

        // 成功条件独立为真 ⇒ won(恰一次置位)。
        let mut engine = engine_with_regions();
        let spec = spec_with_success(success_on_rax(0));
        let mut judge = Judge::assemble(spec, &file_context(), &mut engine).unwrap();
        assert_eq!(
            judge.settle(&mut engine, execution_report(0)).unwrap(),
            SettleOutcome::Won
        );
        assert_eq!(engine.state.status, VmStatus::Won);
        // won 的 Internal 事件载荷 = [0x01]。
        let last = engine.state.private_event_log.last().unwrap();
        assert_eq!(last.kind, VmEventKind::Internal);
        assert_eq!(last.payload.as_deref(), Some(&[0x01][..]));
    }

    /// 阶段级失败条件触发(与题级并存,题级声明序优先上报)。
    #[test]
    fn stage_level_failure_conditions() {
        let mut engine = engine_with_regions();
        let mut spec = vacuous_spec();
        let mut s0 = stage("s0", "");
        s0.failure_conditions = alloc::vec![success_on_rax(0)];
        spec.stages = alloc::vec![s0];
        spec.success_condition = predicate::ConditionL1::vacuous_true();
        let mut judge = Judge::assemble(spec, &file_context(), &mut engine).unwrap();
        assert_eq!(judge.stage().unwrap().index, 0);
        let outcome = judge.settle(&mut engine, execution_report(0)).unwrap();
        assert!(matches!(
            outcome,
            SettleOutcome::Failed {
                source: FailureSource::StageCondition {
                    stage: 0,
                    condition: 0
                }
            }
        ));
        assert_eq!(engine.state.status, VmStatus::Failed);
    }

    /// 阶段迁移时序:条件 ∧ 目标前置同真才迁移;前置不成立跳过;
    /// 一次检查点至多一次迁移;进入触发副作用与预算清零。
    #[test]
    fn stage_transition_gating_and_side_effects() {
        let mut engine = engine_with_regions();
        let mut spec = vacuous_spec();
        let mut s0 = stage("s0", "s1");
        s0.side_effects = alloc::vec![StageSideEffect::GrantVirtualFile {
            file_id: String::from("flag-file"),
        }];
        // s1 前置 = RAX == 1(初始 RAX=0 ⇒ 首检不迁);s1 亦带副作用,
        // 验证进入时再次触发。
        let mut s1 = stage("s1", "");
        s1.preconditions = success_on_rax(1);
        s1.side_effects = alloc::vec![StageSideEffect::GrantVirtualFile {
            file_id: String::from("flag-file"),
        }];
        spec.stages = alloc::vec![s0, s1];
        spec.success_condition = predicate::ConditionL1::vacuous_false();
        let mut judge = Judge::assemble(spec, &file_context(), &mut engine).unwrap();
        // 装配时初始阶段(s0)副作用已触发一次。
        assert!(has_file_grant(&engine, b"flag-file", 1));
        // 检查点 1:前置不成立 ⇒ 不迁。
        assert_eq!(
            judge.settle(&mut engine, execution_report(0)).unwrap(),
            SettleOutcome::Running
        );
        assert_eq!(judge.stage().unwrap().index, 0);
        // 检查点 2:RAX ← 1 后条件与前置同真 ⇒ 迁移;副作用再触发一次。
        engine.state.registers.set("RAX", v(1)).unwrap();
        let outcome = judge.settle(&mut engine, execution_report(0)).unwrap();
        assert_eq!(outcome, SettleOutcome::StageEntered { to_stage: 1 });
        assert_eq!(judge.stage().unwrap().index, 1);
        assert_eq!(judge.stage().unwrap().steps_used, 0);
        assert!(has_file_grant(&engine, b"flag-file", 2));
        // 迁移 Internal 事件载荷 = [0x03 ‖ 目标索引](其后是副作用 FileGranted)。
        let log = &engine.state.private_event_log;
        assert_eq!(
            log[log.len() - 2].payload.as_deref(),
            Some(&[0x03, 1, 0, 0, 0, 0, 0, 0, 0][..])
        );
        assert_eq!(log.last().unwrap().kind, VmEventKind::FileGranted);
        // 新阶段(s1)无迁移 ⇒ 后续检查点保持。
        assert_eq!(
            judge.settle(&mut engine, execution_report(0)).unwrap(),
            SettleOutcome::Running
        );
        assert_eq!(judge.stage().unwrap().index, 1);
    }

    fn has_file_grant(engine: &Engine, file_id: &[u8], expected: usize) -> bool {
        let count = engine
            .state
            .private_event_log
            .iter()
            .filter(|e| e.kind == VmEventKind::FileGranted && e.payload.as_deref() == Some(file_id))
            .count();
        count == expected
    }

    /// 声明序优先:多个可迁迁移中首个触发。
    #[test]
    fn transition_declaration_order_wins() {
        let mut engine = engine_with_regions();
        let mut spec = vacuous_spec();
        let mut s0 = stage("s0", "");
        s0.transitions = alloc::vec![
            StageTransitionSpec {
                to_stage: String::from("s1"),
                on_condition: predicate::ConditionL1::vacuous_true(),
            },
            StageTransitionSpec {
                to_stage: String::from("s2"),
                on_condition: predicate::ConditionL1::vacuous_true(),
            },
        ];
        spec.stages = alloc::vec![s0, stage("s1", ""), stage("s2", "")];
        spec.success_condition = predicate::ConditionL1::vacuous_false();
        let mut judge = Judge::assemble(spec, &file_context(), &mut engine).unwrap();
        assert_eq!(
            judge.settle(&mut engine, execution_report(0)).unwrap(),
            SettleOutcome::StageEntered { to_stage: 1 }
        );
    }

    /// 阶段闸门:allowedActions 之外拒绝;maxActions 恰达上限后拒绝。
    #[test]
    fn gate_enforces_allowed_actions_and_action_budget() {
        let mut engine = engine_with_regions();
        let mut spec = vacuous_spec();
        let mut s0 = stage("s0", "");
        s0.allowed_actions = alloc::vec![SessionActionType::Step, SessionActionType::Pause];
        s0.max_actions = Some(2);
        spec.stages = alloc::vec![s0];
        spec.success_condition = predicate::ConditionL1::vacuous_false();
        let mut judge = Judge::assemble(spec, &file_context(), &mut engine).unwrap();
        // 闸门:允许面外动作拒绝(invalid_action 方向)。
        assert_eq!(
            judge.gate(&engine, SessionActionType::WriteBytes),
            Err(ActionRejection::StageDisallowsAction)
        );
        // 两步窗口 = min(全局 1_000_000, 阶段 1000)。
        assert_eq!(judge.gate(&engine, SessionActionType::Step).unwrap(), 1000);
        // settle 两次(动作数 2 = maxActions)后,闸门按动作预算拒绝。
        judge.settle(&mut engine, execution_report(0)).unwrap();
        judge.settle(&mut engine, execution_report(0)).unwrap();
        assert_eq!(
            judge.gate(&engine, SessionActionType::Step),
            Err(ActionRejection::StageActionBudget)
        );
        // 允许面内的另一动作同样受动作预算约束。
        assert_eq!(
            judge.gate(&engine, SessionActionType::Pause),
            Err(ActionRejection::StageActionBudget)
        );
    }

    /// 阶段步数预算:窗口 = min(全局, 阶段);恰达上限成功、超 1 ⇒ failed。
    #[test]
    fn stage_budget_boundaries() {
        // 窗口取小:阶段剩余 3 < 全局 1_000_000。
        let mut engine = engine_with_regions();
        let mut spec = vacuous_spec();
        let mut s0 = stage("s0", "");
        s0.max_instruction_steps = 3;
        spec.stages = alloc::vec![s0];
        spec.success_condition = predicate::ConditionL1::vacuous_false();
        let mut judge = Judge::assemble(spec, &file_context(), &mut engine).unwrap();
        assert_eq!(judge.gate(&engine, SessionActionType::Step).unwrap(), 3);
        // 两个动作各 2 步:第二动作后累计 4 > 3 ⇒ failed(resource_limit 方向)。
        assert_eq!(
            judge.settle(&mut engine, execution_report(2)).unwrap(),
            SettleOutcome::Running
        );
        let outcome = judge.settle(&mut engine, execution_report(2)).unwrap();
        assert!(matches!(
            outcome,
            SettleOutcome::Failed {
                source: FailureSource::StageStepBudget { stage: 0 }
            }
        ));
        assert_eq!(engine.state.status, VmStatus::Failed);
        // 恰达上限:3 步分两动作(1 + 2)不触发。
        let mut engine = engine_with_regions();
        let mut spec2 = vacuous_spec();
        let mut s0 = stage("s0", "");
        s0.max_instruction_steps = 3;
        spec2.stages = alloc::vec![s0];
        spec2.success_condition = predicate::ConditionL1::vacuous_false();
        let mut judge = Judge::assemble(spec2, &file_context(), &mut engine).unwrap();
        judge.settle(&mut engine, execution_report(1)).unwrap();
        assert_eq!(
            judge.settle(&mut engine, execution_report(2)).unwrap(),
            SettleOutcome::Running
        );
        // 窗口随阶段剩余衰减为 0;此后闸门窗口为 0(执行层不得推进)。
        assert_eq!(judge.gate(&engine, SessionActionType::Step).unwrap(), 0);
    }

    /// 管理类动作不重新求值(D1 约束 5):成功条件为真,管理 settle 不置 won。
    #[test]
    fn management_actions_skip_reevaluation() {
        let mut engine = engine_with_regions();
        let spec = spec_with_success(success_on_rax(0));
        let mut judge = Judge::assemble(spec, &file_context(), &mut engine).unwrap();
        assert_eq!(
            judge.settle(&mut engine, management_report()).unwrap(),
            SettleOutcome::Running
        );
        assert_eq!(engine.state.status, VmStatus::Running);
        // 谓词预算未被管理类检查点消耗。
        assert_eq!(engine.state.constraints.predicate_evals.used, 0);
    }

    /// `maxPredicateEvalSteps` 边界:恰达上限成功、超 1 ⇒ challenge_invalid 方向;
    /// 计数与内容无关(恒定)。
    #[test]
    fn predicate_budget_boundary_and_exhaustion() {
        let mut engine = engine_with_regions();
        // 预算 = 2:success(1 谓词)+ failure(1 谓词)恰一检;第二次超限。
        engine.state.constraints.predicate_evals = crate::state::CumulativeBudget::new(0, 2);
        let mut spec = spec_with_success(success_on_rax(0xFFFF));
        spec.failure_conditions = alloc::vec![success_on_rax(0xFFFF)];
        spec.limits = JudgingConfigLimits {
            max_predicate_eval_steps: 2,
        };
        let mut judge = Judge::assemble(spec, &file_context(), &mut engine).unwrap();
        // 第一次检查点:charge = 1(success)+ 1(failure)= 2,恰达上限成功。
        assert_eq!(
            judge.settle(&mut engine, execution_report(0)).unwrap(),
            SettleOutcome::Running
        );
        assert_eq!(engine.state.constraints.predicate_evals.used, 2);
        // 第二次检查点:charge 2 > 剩余 0 ⇒ challenge_invalid 方向上抛。
        assert_eq!(
            judge.settle(&mut engine, execution_report(0)),
            Err(JudgeError::PredicateBudgetExhausted {
                requested: 2,
                available: 0
            })
        );
        // 状态未被该错误置终态(challenge_invalid 是进程级安全终止,非 VmStatus)。
        assert_eq!(engine.state.status, VmStatus::Running);
    }

    /// 累计预算跨 reset 不重置(D1 约束 5):Engine::reset 保留 predicate_evals;
    /// Judge::reset 恢复初始阶段并重新触发初始副作用。
    #[test]
    fn cumulative_budget_survives_reset_and_judge_reset_restores_stage() {
        let mut engine = engine_with_regions();
        let mut spec = vacuous_spec();
        let mut s0 = stage("s0", "s1");
        s0.side_effects = alloc::vec![StageSideEffect::GrantVirtualFile {
            file_id: String::from("flag-file"),
        }];
        spec.stages = alloc::vec![s0, stage("s1", "")];
        spec.success_condition = success_on_rax(0xFFFF);
        let mut judge = Judge::assemble(spec, &file_context(), &mut engine).unwrap();
        // 一检查点(1 谓词)后迁入 s1。
        assert!(matches!(
            judge.settle(&mut engine, execution_report(5)).unwrap(),
            SettleOutcome::StageEntered { to_stage: 1 }
        ));
        let used_before = engine.state.constraints.predicate_evals.used;
        assert_eq!(used_before, 1);
        // reset:引擎保留累计预算(事件日志随状态回退清空);判题侧回 s0
        // 并重新触发初始副作用(日志内恰 1 条)。
        engine.reset();
        judge.reset(&mut engine);
        assert_eq!(engine.state.constraints.predicate_evals.used, used_before);
        assert_eq!(judge.stage().unwrap().index, 0);
        assert_eq!(judge.stage().unwrap().steps_used, 0);
        assert!(has_file_grant(&engine, b"flag-file", 1));
    }

    /// 引擎异常置终态后,检查点不再求值(③ 的红灯)。
    #[test]
    fn settle_skips_evaluation_when_engine_already_terminal() {
        let mut engine = engine_with_regions();
        let spec = spec_with_success(success_on_rax(0));
        let mut judge = Judge::assemble(spec, &file_context(), &mut engine).unwrap();
        engine.state.status = VmStatus::Failed; // 引擎异常路径(WP-4 fail())
        let budget_before = engine.state.constraints.predicate_evals.used;
        assert_eq!(
            judge.settle(&mut engine, execution_report(0)).unwrap(),
            SettleOutcome::Running
        );
        assert_eq!(engine.state.constraints.predicate_evals.used, budget_before);
    }

    /// 闸门窗口 = min(全局剩余, 阶段剩余):两侧各验证一次。
    #[test]
    fn step_window_takes_min_of_global_and_stage() {
        let mut engine = engine_with_regions();
        // 全局侧:剩余 10_000 < 阶段 20_000 ⇒ 取 10_000。
        engine.state.constraints.steps = crate::state::Budget::new(990_000, 1_000_000);
        let mut spec = vacuous_spec();
        let mut s0 = stage("s0", "");
        s0.max_instruction_steps = 20_000;
        spec.stages = alloc::vec![s0];
        spec.success_condition = predicate::ConditionL1::vacuous_false();
        let judge = Judge::assemble(spec, &file_context(), &mut engine).unwrap();
        assert_eq!(
            judge.gate(&engine, SessionActionType::RunToEvent).unwrap(),
            10_000
        );
        // 阶段侧:剩余 10_000 < 阶段 4_000 ⇒ 取 4_000。
        let mut spec = vacuous_spec();
        let mut s0 = stage("s0", "");
        s0.max_instruction_steps = 4_000;
        spec.stages = alloc::vec![s0];
        spec.success_condition = predicate::ConditionL1::vacuous_false();
        let judge = Judge::assemble(spec, &file_context(), &mut engine).unwrap();
        assert_eq!(judge.gate(&engine, SessionActionType::Step).unwrap(), 4_000);
    }

    /// 端到端时序:write_bytes 动作 → 检查点 won → 隐藏测试(阶段六面)可续跑。
    #[test]
    fn end_to_end_action_then_won_then_hidden_tests() {
        let mut engine = engine_with_regions();
        // 成功条件 = 栈首 4 字节等于 flag 镜像。
        let mut spec = spec_with_success(predicate::ConditionL1::of(Predicate::MemoryEquals {
            region_id: String::from("stack"),
            offset_bytes: 0x200,
            bytes: alloc::vec![0xDE, 0xAD, 0xBE, 0xEF],
        }));
        spec.hidden_tests = alloc::vec![HiddenTestSpec {
            test_id: String::from("final"),
            kind: HiddenTestKind::PredicateProbe,
            payload: alloc::vec![],
            expected: VerdictKind::Success,
        }];
        let mut judge = Judge::assemble(spec, &file_context(), &mut engine).unwrap();
        // 动作前闸门 → 执行 → 检查点。
        assert!(judge.gate(&engine, SessionActionType::WriteBytes).unwrap() > 0);
        let before = engine.state.constraints.steps.used;
        engine
            .action_write_bytes(v(STACK_BASE + 0x200), &[0xDE, 0xAD, 0xBE, 0xEF])
            .unwrap();
        let report = ActionReport {
            class: ActionClass::Execution,
            steps_executed: engine.state.constraints.steps.used - before,
        };
        assert_eq!(
            judge.settle(&mut engine, report).unwrap(),
            SettleOutcome::Won
        );
        assert_eq!(engine.state.status, VmStatus::Won);
        // 终态后隐藏测试仍可执行(submit 之后判题面,规约 §七)。
        let outcomes =
            hidden::run_hidden_tests(judge.spec(), &file_context(), &mut engine).unwrap();
        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].passed);
    }
}

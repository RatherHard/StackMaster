//! 判题面装配输入与镜像复验(WP-5;上游检查器 XS-PRED-REFS / XS-NESTING /
//! XS-STAGE-REACH / XS-STAGE-BUDGET / XS-SEED-POLICY(种子归 `seed` 模块)的
//! 引擎侧镜像,fail-closed)。复验项逐条对照见 `docs/develop/判题语义规约.md` §4.2。
//!
//! 契约面(`private-bundle.schema.json`)经 vm-worker 镜像层转换为本文类型
//! (字节载荷已解码为 `Vec<u8>`、十六进制值已转换为 `ArchValue`);
//! 数值边界在装配复验中二次强制(运行时双层拒绝的引擎侧半边)。

use alloc::collections::BTreeSet;
use alloc::string::String;
use alloc::vec::Vec;

use crate::arch::ArchValue;
use crate::exec::Engine;
use crate::judge::hidden::{HiddenTestKind, VerdictKind};
use crate::judge::predicate::{
    ConditionL1, ConditionL2, MAX_MEMORY_CONTAINS_BYTES, MAX_MEMORY_EQUALS_BYTES, Predicate,
    evaluate_l1, predicate_count,
};
use crate::memory::PermKind;

/// 条件分支上限(每层 `all` / `any` 各 ≤ 4;XS-NESTING 镜像)。
pub const MAX_CONDITION_BRANCHES: usize = 4;
/// 题级失败条件上限。
pub const MAX_FAILURE_CONDITIONS: usize = 8;
/// 阶段数上限。
pub const MAX_STAGES: usize = 8;
/// 每阶段迁移 / 副作用 / 阶段级失败条件上限。
pub const MAX_STAGE_TRANSITIONS: usize = 8;
pub const MAX_STAGE_SIDE_EFFECTS: usize = 8;
/// 单阶段题省略 stages;声明即 ≤ 8。
pub const MAX_HIDDEN_TESTS: usize = 16;
/// 会话动作枚举基数(12 值)。
pub const SESSION_ACTION_COUNT: usize = 12;
/// 隐藏测试载荷上限(Schema maxLength 8192 hex 字符的镜像)。
pub const MAX_HIDDEN_TEST_PAYLOAD_BYTES: usize = 4096;
/// `judgingConfig.maxPredicateEvalSteps` 下界。
pub const MIN_PREDICATE_EVAL_STEPS: u64 = 1;
/// `judgingConfig.maxPredicateEvalSteps` 上界。
pub const MAX_PREDICATE_EVAL_STEPS: u64 = 10_000_000;
/// 阶段指令步数预算界。
pub const MIN_STAGE_INSTRUCTION_STEPS: u64 = 1;
pub const MAX_STAGE_INSTRUCTION_STEPS: u64 = 10_000_000;
/// 阶段动作数预算界。
pub const MIN_STAGE_ACTIONS: u64 = 1;
pub const MAX_STAGE_ACTIONS: u64 = 1_000_000;

/// 会话动作枚举(12 值;协议 `ActionRequest.action.type` 冻结词汇的引擎侧形态)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SessionActionType {
    /// `write_bytes`。
    WriteBytes,
    /// `push`。
    Push,
    /// `pop`。
    Pop,
    /// `call`。
    Call,
    /// `ret`。
    Ret,
    /// `step`。
    Step,
    /// `run_to_event`。
    RunToEvent,
    /// `pause`。
    Pause,
    /// `undo`。
    Undo,
    /// `checkout_checkpoint`。
    CheckoutCheckpoint,
    /// `reset`。
    Reset,
    /// `create_checkpoint`。
    CreateCheckpoint,
}

impl SessionActionType {
    /// 协议字符串形态(判别值与 Schema `sessionAction` 枚举逐词对齐)。
    pub fn as_str(self) -> &'static str {
        match self {
            SessionActionType::WriteBytes => "write_bytes",
            SessionActionType::Push => "push",
            SessionActionType::Pop => "pop",
            SessionActionType::Call => "call",
            SessionActionType::Ret => "ret",
            SessionActionType::Step => "step",
            SessionActionType::RunToEvent => "run_to_event",
            SessionActionType::Pause => "pause",
            SessionActionType::Undo => "undo",
            SessionActionType::CheckoutCheckpoint => "checkout_checkpoint",
            SessionActionType::Reset => "reset",
            SessionActionType::CreateCheckpoint => "create_checkpoint",
        }
    }

    /// 协议字符串 → 枚举。
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "write_bytes" => SessionActionType::WriteBytes,
            "push" => SessionActionType::Push,
            "pop" => SessionActionType::Pop,
            "call" => SessionActionType::Call,
            "ret" => SessionActionType::Ret,
            "step" => SessionActionType::Step,
            "run_to_event" => SessionActionType::RunToEvent,
            "pause" => SessionActionType::Pause,
            "undo" => SessionActionType::Undo,
            "checkout_checkpoint" => SessionActionType::CheckoutCheckpoint,
            "reset" => SessionActionType::Reset,
            "create_checkpoint" => SessionActionType::CreateCheckpoint,
            _ => return None,
        })
    }

    /// 全集(声明序)。
    pub const ALL: [SessionActionType; SESSION_ACTION_COUNT] = [
        SessionActionType::WriteBytes,
        SessionActionType::Push,
        SessionActionType::Pop,
        SessionActionType::Call,
        SessionActionType::Ret,
        SessionActionType::Step,
        SessionActionType::RunToEvent,
        SessionActionType::Pause,
        SessionActionType::Undo,
        SessionActionType::CheckoutCheckpoint,
        SessionActionType::Reset,
        SessionActionType::CreateCheckpoint,
    ];
}

/// 判题配置预算(`judgingConfig` 的引擎消费面;`verdictRuleVersion` 是
/// 版本记录项(7.4),由装载层比对,不进运行时)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JudgingConfigLimits {
    /// 单会话谓词求值步数预算(1–10 000 000;与引擎
    /// `constraints.predicate_evals.limit` 必须同值——装配复验)。
    pub max_predicate_eval_steps: u64,
}

/// 阶段副作用(v1 封闭集:仅 `grant_virtual_file`)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StageSideEffect {
    /// 授予虚拟文件 capability(记 `FileGranted` 私有事件,幂等)。
    GrantVirtualFile {
        /// 虚拟文件引用。
        file_id: String,
    },
}

/// 阶段迁移声明。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageTransitionSpec {
    /// 目标阶段(stageId;装配解析为索引并验证可达)。
    pub to_stage: String,
    /// 迁移条件(与目标阶段前置条件同时成立才迁移)。
    pub on_condition: ConditionL1,
}

/// 阶段六要素声明(7.2;`Stage` 镜像)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageSpec {
    /// 阶段标识。
    pub stage_id: String,
    /// 本阶段允许动作(⊆ 12 值,无重复)。
    pub allowed_actions: Vec<SessionActionType>,
    /// 入场前置条件(恒真写作 `{all: []}`)。
    pub preconditions: ConditionL1,
    /// 迁移声明(≤ 8,声明序即优先序)。
    pub transitions: Vec<StageTransitionSpec>,
    /// 副作用(≤ 8,进入阶段时触发)。
    pub side_effects: Vec<StageSideEffect>,
    /// 阶段级失败条件(≤ 8)。
    pub failure_conditions: Vec<ConditionL1>,
    /// 本阶段(每次进入)指令步数预算(1–10 000 000)。
    pub max_instruction_steps: u64,
    /// 本阶段(每次进入)动作数预算(1–1 000 000;缺省不限)。
    pub max_actions: Option<u64>,
}

/// 隐藏测试声明(`HiddenTest` 镜像;(输入, 预期判定)对)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HiddenTestSpec {
    /// 测试标识。
    pub test_id: String,
    /// 测试类别。
    pub kind: HiddenTestKind,
    /// 载荷(reference_payload 的输入字节;predicate_probe 必须为空)。
    pub payload: Vec<u8>,
    /// 预期判定(7 值可达判定)。
    pub expected: VerdictKind,
}

/// 判题面装配输入(`judging` + `stages` + `hiddenTests` + `judgingConfig` 的引擎形态)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JudgingSpec {
    /// 权威成功条件(必填)。
    pub success_condition: ConditionL1,
    /// 题级失败条件(≤ 8;任一触发即 failed)。
    pub failure_conditions: Vec<ConditionL1>,
    /// 多阶段状态机(空 = 单阶段题)。
    pub stages: Vec<StageSpec>,
    /// 隐藏测试(≤ 16)。
    pub hidden_tests: Vec<HiddenTestSpec>,
    /// 判题配置预算。
    pub limits: JudgingConfigLimits,
}

/// 装配上下文(装载层从私有包其余部分派生)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JudgingContext {
    /// `secrets.virtualFiles` 的 fileId 全集(谓词与阶段副作用的引用域)。
    pub virtual_file_ids: Vec<String>,
    /// 隐藏测试输入槽(`reference_payload` 载荷写入地址;None = 未声明,
    /// 非空载荷即装配拒绝;规约 §七 D-H2)。
    pub input_sink: Option<ArchValue>,
}

/// 装配拒绝(方向 = `challenge_invalid`;变体对应规约 §4.2 复验表)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JudgeAssembleError {
    /// 条件形态:L1/L2 至少一键;`all`/`any` 各 ≤ 4(XS-NESTING 镜像)。
    ConditionShape,
    /// 谓词引用与边界(XS-PRED-REFS 镜像 + 区域可读性扩展)。
    PredicateRef {
        /// 谓词所在条件的声明序(题级失败 / 阶段前置 / 迁移 / 阶段失败的计数键)。
        site: usize,
        /// 拒绝原因。
        reason: PredicateRefReason,
    },
    /// 面上限越界(failureConditions / stages / hiddenTests / 阶段内条目)。
    EntryLimit {
        /// 越界项类别名。
        kind: &'static str,
        /// 实际数量。
        count: usize,
    },
    /// 迁移目标不存在(XS-STAGE-REACH 前半)。
    StageTargetUnknown {
        /// 源阶段索引。
        stage_index: usize,
        /// 迁移声明序。
        transition_index: usize,
    },
    /// 自 `stages[0]` 不可达(XS-STAGE-REACH 后半)。
    StageUnreachable {
        /// 不可达阶段索引。
        stage_index: usize,
    },
    /// 阶段预算界(XS-STAGE-BUDGET 镜像)。
    StageBudget {
        /// 阶段索引。
        stage_index: usize,
    },
    /// 阶段引用:stageId 重复 / allowedActions 重复或超 12 / 副作用文件未知 / 副作用超限。
    StageRef {
        /// 阶段索引。
        stage_index: usize,
    },
    /// 谓词预算双真相源:引擎 `predicate_evals.limit` ≠ `maxPredicateEvalSteps`。
    PredicateBudgetMismatch {
        /// 引擎侧上限。
        engine_limit: u64,
        /// 判题面声明上限。
        declared: u64,
    },
    /// `maxPredicateEvalSteps` 声明值越界(1–10 000 000)。
    PredicateBudgetRange {
        /// 声明值。
        declared: u64,
    },
    /// 初始前置求值的预算预扣失败(预算 ≤ 前置谓词数;方向 challenge_invalid)。
    InitialPreconditionBudget {
        /// 本次请求量。
        requested: u64,
        /// 剩余额度。
        available: u64,
    },
    /// 初始阶段前置条件在初始状态不成立(作者错误)。
    InitialStagePrecondition,
    /// 隐藏测试形态:testId 重复 / probe 载荷非空 / 载荷无输入槽 / 载荷超长。
    HiddenTestShape {
        /// 测试声明序。
        test_index: usize,
    },
}

/// 谓词引用拒绝原因(XS-PRED-REFS 镜像 + 本文扩展)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PredicateRefReason {
    /// 寄存器不在引擎寄存器集。
    UnknownRegister,
    /// 区域不存在。
    UnknownRegion,
    /// 区域权限不含 `r`(本文可读性扩展:谓词查询走统一读路径)。
    RegionNotReadable,
    /// `memory_equals` 切片 `[offset, offset+len)` 越出区域(或算术溢出)。
    SliceOutOfBounds,
    /// `memory_equals` 载荷超长(> 256)。
    EqualsBytesTooLong,
    /// `memory_contains` 串超长(> 64)或为空。
    ContainsBytesInvalid,
    /// 串长 > 区域长度。
    NeedleLongerThanRegion,
    /// fileId 不在声明虚拟文件集。
    UnknownFile,
}

/// 判题面全量装配复验(规约 §4.2;通过即触发初始阶段副作用)。
///
/// 返回各阶段的**迁移目标索引解析表**(`transitions[i].to_stage` → 索引),
/// 供运行时检查点免字符串解析。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedStages {
    /// 与 `spec.stages` 同序;每阶段迁移的目标索引(同序)。
    pub transition_targets: Vec<Vec<usize>>,
}

pub(crate) fn assemble(
    spec: &JudgingSpec,
    context: &JudgingContext,
    engine: &mut Engine,
) -> Result<ResolvedStages, JudgeAssembleError> {
    validate_limits(spec)?;
    validate_conditions(spec)?;
    let files: BTreeSet<String> = context.virtual_file_ids.iter().cloned().collect();
    validate_predicates(spec, engine, &files)?;
    let transition_targets = validate_stages(spec, context)?;
    validate_hidden_tests(spec, context)?;
    validate_budget_single_source(spec, engine)?;
    // 初始阶段前置:求值前预扣(规约 §1.3 / §4.2);不成立 = 作者错误。
    if let Some(first) = spec.stages.first() {
        let charge = predicate_count(&first.preconditions);
        engine
            .state
            .constraints
            .predicate_evals
            .charge(charge)
            .map_err(|e| JudgeAssembleError::InitialPreconditionBudget {
                requested: e.requested,
                available: e.available,
            })?;
        if !evaluate_l1(engine, &first.preconditions).expect("谓词引用已在装配复验封闭")
        {
            return Err(JudgeAssembleError::InitialStagePrecondition);
        }
    }
    Ok(ResolvedStages { transition_targets })
}

fn validate_limits(spec: &JudgingSpec) -> Result<(), JudgeAssembleError> {
    if spec.failure_conditions.len() > MAX_FAILURE_CONDITIONS {
        return Err(JudgeAssembleError::EntryLimit {
            kind: "failureConditions",
            count: spec.failure_conditions.len(),
        });
    }
    if spec.stages.len() > MAX_STAGES {
        return Err(JudgeAssembleError::EntryLimit {
            kind: "stages",
            count: spec.stages.len(),
        });
    }
    if spec.hidden_tests.len() > MAX_HIDDEN_TESTS {
        return Err(JudgeAssembleError::EntryLimit {
            kind: "hiddenTests",
            count: spec.hidden_tests.len(),
        });
    }
    if !(MIN_PREDICATE_EVAL_STEPS..=MAX_PREDICATE_EVAL_STEPS)
        .contains(&spec.limits.max_predicate_eval_steps)
    {
        return Err(JudgeAssembleError::PredicateBudgetRange {
            declared: spec.limits.max_predicate_eval_steps,
        });
    }
    Ok(())
}

fn validate_conditions(spec: &JudgingSpec) -> Result<(), JudgeAssembleError> {
    validate_l1(&spec.success_condition)?;
    for condition in &spec.failure_conditions {
        validate_l1(condition)?;
    }
    for stage in &spec.stages {
        validate_l1(&stage.preconditions)?;
        for condition in &stage.failure_conditions {
            validate_l1(condition)?;
        }
        for transition in &stage.transitions {
            validate_l1(&transition.on_condition)?;
        }
    }
    Ok(())
}

/// 条件形态复验:每层至少一键、`all` / `any` 各 ≤ 4(XS-NESTING 镜像;
/// 深度由类型承载)。
fn validate_l1(condition: &ConditionL1) -> Result<(), JudgeAssembleError> {
    let key_count = condition.all.is_some() as usize
        + condition.any.is_some() as usize
        + condition.not.is_some() as usize;
    if key_count == 0 {
        return Err(JudgeAssembleError::ConditionShape);
    }
    for list in [&condition.all, &condition.any].into_iter().flatten() {
        if list.len() > MAX_CONDITION_BRANCHES {
            return Err(JudgeAssembleError::ConditionShape);
        }
        for node in list {
            validate_l2(node)?;
        }
    }
    if let Some(node) = &condition.not {
        validate_l2(node)?;
    }
    Ok(())
}

fn validate_l2(condition: &ConditionL2) -> Result<(), JudgeAssembleError> {
    let key_count = condition.all.is_some() as usize
        + condition.any.is_some() as usize
        + condition.not.is_some() as usize;
    if key_count == 0 {
        return Err(JudgeAssembleError::ConditionShape);
    }
    for list in [&condition.all, &condition.any].into_iter().flatten() {
        if list.len() > MAX_CONDITION_BRANCHES {
            return Err(JudgeAssembleError::ConditionShape);
        }
    }
    Ok(())
}

/// 遍历判题面全部谓词,逐条做引用 / 边界复验(XS-PRED-REFS 镜像)。
fn validate_predicates(
    spec: &JudgingSpec,
    engine: &Engine,
    files: &BTreeSet<String>,
) -> Result<(), JudgeAssembleError> {
    let mut site = 0usize;
    let mut check = |condition: &ConditionL1| -> Result<(), JudgeAssembleError> {
        let result = for_each_predicate(condition, |predicate| {
            validate_predicate(predicate, engine, files)
        });
        let current = site;
        site += 1;
        result.map_err(|reason| JudgeAssembleError::PredicateRef {
            site: current,
            reason,
        })
    };
    check(&spec.success_condition)?;
    for condition in &spec.failure_conditions {
        check(condition)?;
    }
    for stage in &spec.stages {
        check(&stage.preconditions)?;
        for condition in &stage.failure_conditions {
            check(condition)?;
        }
        for transition in &stage.transitions {
            check(&transition.on_condition)?;
        }
    }
    Ok(())
}

/// 深度优先走条件树(L3 叶 = 谓词);三层定深,无递归遍历需求。
fn for_each_predicate<F>(condition: &ConditionL1, mut visit: F) -> Result<(), PredicateRefReason>
where
    F: FnMut(&Predicate) -> Result<(), PredicateRefReason>,
{
    for list in [&condition.all, &condition.any].into_iter().flatten() {
        for node in list {
            for_each_l2(node, &mut visit)?;
        }
    }
    if let Some(node) = &condition.not {
        for_each_l2(node, &mut visit)?;
    }
    Ok(())
}

fn for_each_l2<F>(node: &ConditionL2, visit: &mut F) -> Result<(), PredicateRefReason>
where
    F: FnMut(&Predicate) -> Result<(), PredicateRefReason>,
{
    for list in [&node.all, &node.any].into_iter().flatten() {
        for leaf in list {
            visit(&leaf.predicate)?;
        }
    }
    if let Some(leaf) = &node.not {
        visit(&leaf.predicate)?;
    }
    Ok(())
}

fn validate_predicate(
    predicate: &Predicate,
    engine: &Engine,
    files: &BTreeSet<String>,
) -> Result<(), PredicateRefReason> {
    match predicate {
        Predicate::RegisterEquals { register, .. }
        | Predicate::RegisterBitsSet { register, .. } => {
            if engine.state.registers.get(register).is_none() {
                return Err(PredicateRefReason::UnknownRegister);
            }
        }
        Predicate::MemoryEquals {
            region_id,
            offset_bytes,
            bytes,
        } => {
            let region = engine
                .state
                .memory
                .region_by_id(region_id)
                .ok_or(PredicateRefReason::UnknownRegion)?;
            if !region.permissions.allows(PermKind::Read) {
                return Err(PredicateRefReason::RegionNotReadable);
            }
            if bytes.len() > MAX_MEMORY_EQUALS_BYTES {
                return Err(PredicateRefReason::EqualsBytesTooLong);
            }
            let start = region
                .start
                .checked_add(*offset_bytes)
                .ok_or(PredicateRefReason::SliceOutOfBounds)?;
            let end = start
                .checked_add(bytes.len() as u64)
                .ok_or(PredicateRefReason::SliceOutOfBounds)?;
            if end > region.start + region.byte_length {
                return Err(PredicateRefReason::SliceOutOfBounds);
            }
        }
        Predicate::MemoryContains { region_id, bytes } => {
            let region = engine
                .state
                .memory
                .region_by_id(region_id)
                .ok_or(PredicateRefReason::UnknownRegion)?;
            if !region.permissions.allows(PermKind::Read) {
                return Err(PredicateRefReason::RegionNotReadable);
            }
            if bytes.is_empty() || bytes.len() > MAX_MEMORY_CONTAINS_BYTES {
                return Err(PredicateRefReason::ContainsBytesInvalid);
            }
            if bytes.len() as u64 > region.byte_length {
                return Err(PredicateRefReason::NeedleLongerThanRegion);
            }
        }
        Predicate::RetTargetEquals { .. } | Predicate::StackCanaryIntact => {}
        Predicate::VirtualFileRead { file_id } => {
            if !files.contains(file_id) {
                return Err(PredicateRefReason::UnknownFile);
            }
        }
    }
    Ok(())
}

/// 阶段机复验:唯一性 / 上限 / 预算界 / 目标存在与可达 / 副作用引用。
fn validate_stages(
    spec: &JudgingSpec,
    context: &JudgingContext,
) -> Result<Vec<Vec<usize>>, JudgeAssembleError> {
    let files: BTreeSet<&String> = context.virtual_file_ids.iter().collect();
    let index_of = |id: &str| spec.stages.iter().position(|s| s.stage_id == id);
    let mut ids: BTreeSet<&str> = BTreeSet::new();
    for (stage_index, stage) in spec.stages.iter().enumerate() {
        if !ids.insert(stage.stage_id.as_str()) {
            return Err(JudgeAssembleError::StageRef { stage_index });
        }
        if stage.allowed_actions.len() > SESSION_ACTION_COUNT {
            return Err(JudgeAssembleError::StageRef { stage_index });
        }
        let mut seen: BTreeSet<SessionActionType> = BTreeSet::new();
        if !stage.allowed_actions.iter().all(|a| seen.insert(*a)) {
            return Err(JudgeAssembleError::StageRef { stage_index });
        }
        if stage.transitions.len() > MAX_STAGE_TRANSITIONS
            || stage.side_effects.len() > MAX_STAGE_SIDE_EFFECTS
            || stage.failure_conditions.len() > MAX_STAGE_TRANSITIONS
        {
            return Err(JudgeAssembleError::EntryLimit {
                kind: "stageEntries",
                count: stage.transitions.len() + stage.side_effects.len(),
            });
        }
        if !(MIN_STAGE_INSTRUCTION_STEPS..=MAX_STAGE_INSTRUCTION_STEPS)
            .contains(&stage.max_instruction_steps)
        {
            return Err(JudgeAssembleError::StageBudget { stage_index });
        }
        if let Some(max_actions) = stage.max_actions
            && !(MIN_STAGE_ACTIONS..=MAX_STAGE_ACTIONS).contains(&max_actions)
        {
            return Err(JudgeAssembleError::StageBudget { stage_index });
        }
        for effect in &stage.side_effects {
            let StageSideEffect::GrantVirtualFile { file_id } = effect;
            if !files.contains(file_id) {
                return Err(JudgeAssembleError::StageRef { stage_index });
            }
        }
    }
    // 迁移目标解析 + 自 stages[0] BFS 可达(XS-STAGE-REACH)。
    let mut targets = Vec::with_capacity(spec.stages.len());
    for (stage_index, stage) in spec.stages.iter().enumerate() {
        let mut resolved = Vec::with_capacity(stage.transitions.len());
        for (transition_index, transition) in stage.transitions.iter().enumerate() {
            match index_of(&transition.to_stage) {
                Some(target) => resolved.push(target),
                None => {
                    return Err(JudgeAssembleError::StageTargetUnknown {
                        stage_index,
                        transition_index,
                    });
                }
            }
        }
        targets.push(resolved);
    }
    if !spec.stages.is_empty() {
        let mut reachable = alloc::vec![false; spec.stages.len()];
        reachable[0] = true;
        let mut queue = alloc::vec![0usize];
        while let Some(current) = queue.pop() {
            for target in &targets[current] {
                if !reachable[*target] {
                    reachable[*target] = true;
                    queue.push(*target);
                }
            }
        }
        for (stage_index, ok) in reachable.iter().enumerate() {
            if !ok {
                return Err(JudgeAssembleError::StageUnreachable { stage_index });
            }
        }
    }
    Ok(targets)
}

fn validate_hidden_tests(
    spec: &JudgingSpec,
    context: &JudgingContext,
) -> Result<(), JudgeAssembleError> {
    let mut ids: BTreeSet<&str> = BTreeSet::new();
    for (test_index, test) in spec.hidden_tests.iter().enumerate() {
        if !ids.insert(test.test_id.as_str()) {
            return Err(JudgeAssembleError::HiddenTestShape { test_index });
        }
        match test.kind {
            HiddenTestKind::PredicateProbe if !test.payload.is_empty() => {
                return Err(JudgeAssembleError::HiddenTestShape { test_index });
            }
            HiddenTestKind::ReferencePayload
                if !test.payload.is_empty() && context.input_sink.is_none() =>
            {
                return Err(JudgeAssembleError::HiddenTestShape { test_index });
            }
            _ => {}
        }
        if test.payload.len() > MAX_HIDDEN_TEST_PAYLOAD_BYTES {
            return Err(JudgeAssembleError::HiddenTestShape { test_index });
        }
    }
    Ok(())
}

fn validate_budget_single_source(
    spec: &JudgingSpec,
    engine: &Engine,
) -> Result<(), JudgeAssembleError> {
    let engine_limit = engine.state.constraints.predicate_evals.limit;
    let declared = spec.limits.max_predicate_eval_steps;
    if engine_limit != declared {
        return Err(JudgeAssembleError::PredicateBudgetMismatch {
            engine_limit,
            declared,
        });
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::arch::ArchBits;
    use crate::exec::{CanarySlotSpec, Engine, EngineConfig};
    use crate::instr::{BaselineOp, Instruction, Op, Operand, Program};
    use crate::judge::hidden::HiddenTestKind;
    use crate::judge::predicate::ConditionL1;
    use crate::memory::{ExecutionMode, Permissions, RegionContents, RegionKind, RegionSpec};
    use crate::state::{
        Budget, CumulativeBudget, RuntimeConstraints, SeedState, SeedStrategy, VmStateConfig,
    };
    use alloc::format;
    use alloc::string::ToString;
    use alloc::vec;

    pub(crate) const A32: ArchBits = ArchBits::B32;
    pub(crate) const STACK_BASE: u64 = 0x7FFF_F000;
    pub(crate) const STACK_TOP: u64 = 0x7FFF_FFF8;
    pub(crate) const SCRATCH_BASE: u64 = 0x3000_0000;
    pub(crate) const CANARY_BASE: u64 = 0x7FFF_E000;
    /// 谓词预算测试基线(装载与检查点共用)。
    pub(crate) const PRED_BUDGET: u64 = 10_000;

    /// 测试引擎构造器:code(rx, `syscall exit(0)` 单指令)/ stack(rw, 栈顶
    /// 4 字节小端 0x44332211)/ scratch(仅 w,谓词可读性红灯用)/
    /// canary 区(rw,槽位 2 字节 @ 0x7FFFE000)。
    pub(crate) fn engine_with_regions() -> Engine {
        let arch = A32;
        let regions = vec![
            RegionSpec::new(
                "code",
                RegionKind::Code,
                None,
                0x40_0000,
                4096,
                Permissions::parse("rx").unwrap(),
                arch,
            )
            .unwrap(),
            RegionSpec::new(
                "stack",
                RegionKind::Stack,
                None,
                STACK_BASE,
                4096,
                Permissions::parse("rw").unwrap(),
                arch,
            )
            .unwrap(),
            RegionSpec::new(
                "scratch",
                RegionKind::Custom,
                Some("scratch"),
                SCRATCH_BASE,
                4096,
                Permissions::parse("w").unwrap(),
                arch,
            )
            .unwrap(),
            RegionSpec::new(
                "canary",
                RegionKind::Custom,
                Some("canary"),
                CANARY_BASE,
                4096,
                Permissions::parse("rw").unwrap(),
                arch,
            )
            .unwrap(),
        ];
        let mut stack_bytes = vec![0u8; 4096];
        stack_bytes[0x100..0x104].copy_from_slice(&[0x11, 0x22, 0x33, 0x44]);
        stack_bytes[0x104..0x108].copy_from_slice(&[0x11, 0x22, 0x33, 0x44]);
        let program = Program::Ir {
            instructions: alloc::vec![Instruction {
                op: Op::Baseline(BaselineOp::Syscall),
                operands: alloc::vec![Operand::Immediate(ArchValue::new(0, arch))],
            }],
            entrypoint_index: 0,
        };
        let mut engine = base_engine(regions, stack_bytes, program, 0);
        // 栈顶指向 0x44332211 所在槽(ret_target_equals 测试基准)。
        engine
            .state
            .registers
            .set("RSP", ArchValue::new(STACK_BASE + 0x100, arch))
            .unwrap();
        engine
    }

    /// 基础引擎装配(区域 + 内容 + 程序 + 寄存器 + Canary 槽)。
    pub(crate) fn base_engine(
        regions: Vec<RegionSpec>,
        stack_bytes: Vec<u8>,
        program: Program,
        initial_ip: u64,
    ) -> Engine {
        let arch = A32;
        let mut contents = Vec::new();
        let mut canary_bytes = vec![0u8; 4096];
        canary_bytes[..2].copy_from_slice(&[0xCA, 0xFE]);
        let regions_named_canary = regions.iter().any(|r| r.region_id == "canary");
        for region in &regions {
            let bytes = match region.region_id.as_str() {
                "stack" => stack_bytes.clone(),
                "canary" => canary_bytes.clone(),
                "code" => {
                    let mut code = vec![0u8; region.byte_length as usize];
                    code[..2].copy_from_slice(&[0x00, 0x00]);
                    code
                }
                _ => vec![0u8; region.byte_length as usize],
            };
            contents.push(RegionContents {
                region_id: region.region_id.clone(),
                bytes,
            });
        }
        let config = EngineConfig {
            state: VmStateConfig {
                arch,
                execution_mode: ExecutionMode::Ir,
                page_size: 4096,
                regions,
                region_contents: contents,
                registers: vec![
                    (String::from("RSP"), ArchValue::new(STACK_TOP, arch)),
                    (String::from("RBP"), ArchValue::new(STACK_TOP, arch)),
                    (String::from("RIP"), ArchValue::new(initial_ip, arch)),
                    (String::from("RAX"), ArchValue::new(0, arch)),
                    (String::from("FLAG_KEY"), ArchValue::new(0x5A, arch)),
                ],
                flag_register_names: alloc::vec![String::from("FLAG_KEY")],
                initial_instruction_pointer: ArchValue::new(initial_ip, arch),
                constraints: RuntimeConstraints {
                    steps: Budget::new(0, 1_000_000),
                    memory_bytes_limit: 64 * 1024 * 1024,
                    wall_clock_ms_limit: 5_000,
                    call_depth_limit: 64,
                    action_log: Budget::new(0, 10_000),
                    output_bytes: Budget::new(0, 4096),
                    timeout_ms_limit: 1_000,
                    predicate_evals: CumulativeBudget::new(0, PRED_BUDGET),
                    rollback_ops: Budget::new(0, 200),
                },
                seed_state: SeedState {
                    strategy: SeedStrategy::Fixed,
                    version: 1,
                    state_bytes: alloc::vec![0xAA, 0xBB],
                },
            },
            program,
            custom_instructions: alloc::vec![],
            interfaces: alloc::vec![],
            // Canary 槽仅在区域集声明 canary 区域时挂载(期望值自初始内存截取)。
            canary_slots: if regions_named_canary {
                alloc::vec![CanarySlotSpec {
                    address: CANARY_BASE,
                    byte_length: 2,
                }]
            } else {
                alloc::vec![]
            },
        };
        Engine::new(config).unwrap()
    }

    pub(crate) fn vacuous_spec() -> JudgingSpec {
        JudgingSpec {
            success_condition: ConditionL1::vacuous_false(),
            failure_conditions: alloc::vec![],
            stages: alloc::vec![],
            hidden_tests: alloc::vec![],
            limits: JudgingConfigLimits {
                max_predicate_eval_steps: PRED_BUDGET,
            },
        }
    }

    pub(crate) fn file_context() -> JudgingContext {
        JudgingContext {
            virtual_file_ids: alloc::vec![String::from("flag-file")],
            input_sink: Some(ArchValue::new(STACK_BASE + 0x200, A32)),
        }
    }

    fn spec_with_success(condition: ConditionL1) -> JudgingSpec {
        let mut spec = vacuous_spec();
        spec.success_condition = condition;
        spec
    }

    // ── 装配红灯矩阵(每条镜像规则一个必触发反例)──────────────────────────

    #[test]
    fn assemble_rejects_empty_condition_node() {
        let mut engine = engine_with_regions();
        let spec = spec_with_success(ConditionL1::default());
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::ConditionShape)
        );
    }

    #[test]
    fn assemble_rejects_branch_limit() {
        let mut engine = engine_with_regions();
        let leaf = crate::judge::predicate::ConditionL3 {
            predicate: Predicate::RegisterEquals {
                register: String::from("RAX"),
                value: ArchValue::new(0, A32),
            },
        };
        let five = (0..5).map(|_| ConditionL2 {
            all: Some(alloc::vec![leaf.clone()]),
            any: None,
            not: None,
        });
        let spec = spec_with_success(ConditionL1 {
            all: Some(five.collect()),
            any: None,
            not: None,
        });
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::ConditionShape)
        );
    }

    #[test]
    fn assemble_rejects_predicate_reference_matrix() {
        // 未知寄存器。
        let mut engine = engine_with_regions();
        let spec = spec_with_success(ConditionL1::of(Predicate::RegisterEquals {
            register: String::from("NOPE"),
            value: ArchValue::new(0, A32),
        }));
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::PredicateRef {
                site: 0,
                reason: PredicateRefReason::UnknownRegister
            })
        );
        // 未知区域。
        let spec = spec_with_success(ConditionL1::of(Predicate::MemoryEquals {
            region_id: String::from("nowhere"),
            offset_bytes: 0,
            bytes: alloc::vec![0],
        }));
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::PredicateRef {
                site: 0,
                reason: PredicateRefReason::UnknownRegion
            })
        );
        // 区域不可读(scratch 仅 w;本文可读性扩展)。
        let spec = spec_with_success(ConditionL1::of(Predicate::MemoryEquals {
            region_id: String::from("scratch"),
            offset_bytes: 0,
            bytes: alloc::vec![0],
        }));
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::PredicateRef {
                site: 0,
                reason: PredicateRefReason::RegionNotReadable
            })
        );
        // 切片越界(offset + len > byteLength)。
        let spec = spec_with_success(ConditionL1::of(Predicate::MemoryEquals {
            region_id: String::from("stack"),
            offset_bytes: 4094,
            bytes: alloc::vec![1, 2, 3, 4],
        }));
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::PredicateRef {
                site: 0,
                reason: PredicateRefReason::SliceOutOfBounds
            })
        );
        // 偏移算术溢出(offset = u64::MAX)。
        let spec = spec_with_success(ConditionL1::of(Predicate::MemoryEquals {
            region_id: String::from("stack"),
            offset_bytes: u64::MAX,
            bytes: alloc::vec![1],
        }));
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::PredicateRef {
                site: 0,
                reason: PredicateRefReason::SliceOutOfBounds
            })
        );
        // equals 载荷超长(> 256)。
        let spec = spec_with_success(ConditionL1::of(Predicate::MemoryEquals {
            region_id: String::from("stack"),
            offset_bytes: 0,
            bytes: alloc::vec![0u8; 257],
        }));
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::PredicateRef {
                site: 0,
                reason: PredicateRefReason::EqualsBytesTooLong
            })
        );
        // contains 串超长(> 64)。
        let spec = spec_with_success(ConditionL1::of(Predicate::MemoryContains {
            region_id: String::from("stack"),
            bytes: alloc::vec![0u8; 65],
        }));
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::PredicateRef {
                site: 0,
                reason: PredicateRefReason::ContainsBytesInvalid
            })
        );
        // contains 空串。
        let spec = spec_with_success(ConditionL1::of(Predicate::MemoryContains {
            region_id: String::from("stack"),
            bytes: alloc::vec![],
        }));
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::PredicateRef {
                site: 0,
                reason: PredicateRefReason::ContainsBytesInvalid
            })
        );
        // 未知文件。
        let spec = spec_with_success(ConditionL1::of(Predicate::VirtualFileRead {
            file_id: String::from("ghost-file"),
        }));
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::PredicateRef {
                site: 0,
                reason: PredicateRefReason::UnknownFile
            })
        );
    }

    #[test]
    fn assemble_rejects_entry_limits() {
        let mut engine = engine_with_regions();
        // failureConditions > 8。
        let mut spec = vacuous_spec();
        spec.failure_conditions = (0..9).map(|_| ConditionL1::vacuous_true()).collect();
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::EntryLimit {
                kind: "failureConditions",
                count: 9
            })
        );
        // hiddenTests > 16。
        let mut spec = vacuous_spec();
        spec.hidden_tests = (0..17)
            .map(|i| HiddenTestSpec {
                test_id: format!("t-{i}"),
                kind: HiddenTestKind::PredicateProbe,
                payload: alloc::vec![],
                expected: VerdictKind::Success,
            })
            .collect();
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::EntryLimit {
                kind: "hiddenTests",
                count: 17
            })
        );
        // maxPredicateEvalSteps 界外(0 / 10 000 001)。
        for bad in [0u64, 10_000_001] {
            let mut spec = vacuous_spec();
            spec.limits.max_predicate_eval_steps = bad;
            assert_eq!(
                assemble(&spec, &file_context(), &mut engine),
                Err(JudgeAssembleError::PredicateBudgetRange { declared: bad })
            );
        }
    }

    fn stage(id: &str, to: &str) -> StageSpec {
        StageSpec {
            stage_id: id.to_string(),
            allowed_actions: SessionActionType::ALL.to_vec(),
            preconditions: ConditionL1::vacuous_true(),
            transitions: if to.is_empty() {
                alloc::vec![]
            } else {
                alloc::vec![StageTransitionSpec {
                    to_stage: to.to_string(),
                    on_condition: ConditionL1::vacuous_true(),
                }]
            },
            side_effects: alloc::vec![],
            failure_conditions: alloc::vec![],
            max_instruction_steps: 1000,
            max_actions: None,
        }
    }

    #[test]
    fn assemble_rejects_stage_machine_matrix() {
        // 迁移目标未知。
        let mut engine = engine_with_regions();
        let mut spec = vacuous_spec();
        spec.stages = alloc::vec![stage("s0", "ghost")];
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::StageTargetUnknown {
                stage_index: 0,
                transition_index: 0
            })
        );
        // 不可达阶段(s2 无入边;s0→s1 可达)。
        let mut engine = engine_with_regions();
        let mut spec = vacuous_spec();
        spec.stages = alloc::vec![stage("s0", "s1"), stage("s1", ""), stage("s2", "")];
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::StageUnreachable { stage_index: 2 })
        );
        // 预算界外(步数 0 / 步数超上界 / 动作数 0)。
        for (steps, actions) in [(0u64, None), (10_000_001, None), (100u64, Some(0u64))] {
            let mut engine = engine_with_regions();
            let mut spec = vacuous_spec();
            let mut bad = stage("s0", "");
            bad.max_instruction_steps = steps;
            bad.max_actions = actions;
            spec.stages = alloc::vec![bad];
            assert_eq!(
                assemble(&spec, &file_context(), &mut engine),
                Err(JudgeAssembleError::StageBudget { stage_index: 0 })
            );
        }
        // stageId 重复。
        let mut engine = engine_with_regions();
        let mut spec = vacuous_spec();
        spec.stages = alloc::vec![stage("s0", ""), stage("s0", "")];
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::StageRef { stage_index: 1 })
        );
        // allowedActions 重复。
        let mut engine = engine_with_regions();
        let mut spec = vacuous_spec();
        let mut dup = stage("s0", "");
        dup.allowed_actions = alloc::vec![SessionActionType::Step, SessionActionType::Step];
        spec.stages = alloc::vec![dup];
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::StageRef { stage_index: 0 })
        );
        // 副作用文件未知。
        let mut engine = engine_with_regions();
        let mut spec = vacuous_spec();
        let mut bad = stage("s0", "");
        bad.side_effects = alloc::vec![StageSideEffect::GrantVirtualFile {
            file_id: String::from("ghost-file"),
        }];
        spec.stages = alloc::vec![bad];
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::StageRef { stage_index: 0 })
        );
        // 阶段条目超限(迁移 > 8)。
        let mut engine = engine_with_regions();
        let mut spec = vacuous_spec();
        let mut bad = stage("s0", "");
        bad.transitions = (0..9)
            .map(|_| StageTransitionSpec {
                to_stage: String::from("s0"),
                on_condition: ConditionL1::vacuous_true(),
            })
            .collect();
        spec.stages = alloc::vec![bad];
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::EntryLimit {
                kind: "stageEntries",
                count: 9
            })
        );
        // 初始前置不成立(作者错误)。
        let mut engine = engine_with_regions();
        let mut spec = vacuous_spec();
        let mut bad = stage("s0", "");
        bad.preconditions = ConditionL1::of(Predicate::RegisterEquals {
            register: String::from("RAX"),
            value: ArchValue::new(0xFFFF_FFFF, A32),
        });
        spec.stages = alloc::vec![bad];
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::InitialStagePrecondition)
        );
    }

    #[test]
    fn assemble_rejects_budget_single_source_and_hidden_tests() {
        // 预算双真相源:引擎 limit ≠ 声明。
        let mut engine = engine_with_regions();
        let mut spec = vacuous_spec();
        spec.limits.max_predicate_eval_steps = PRED_BUDGET + 1;
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::PredicateBudgetMismatch {
                engine_limit: PRED_BUDGET,
                declared: PRED_BUDGET + 1,
            })
        );
        // testId 重复。
        let mut engine = engine_with_regions();
        let mut spec = vacuous_spec();
        spec.hidden_tests = alloc::vec![
            HiddenTestSpec {
                test_id: String::from("t"),
                kind: HiddenTestKind::PredicateProbe,
                payload: alloc::vec![],
                expected: VerdictKind::Success,
            },
            HiddenTestSpec {
                test_id: String::from("t"),
                kind: HiddenTestKind::PredicateProbe,
                payload: alloc::vec![],
                expected: VerdictKind::Success,
            },
        ];
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::HiddenTestShape { test_index: 1 })
        );
        // probe 载荷非空。
        let mut engine = engine_with_regions();
        let mut spec = vacuous_spec();
        spec.hidden_tests = alloc::vec![HiddenTestSpec {
            test_id: String::from("t"),
            kind: HiddenTestKind::PredicateProbe,
            payload: alloc::vec![1],
            expected: VerdictKind::Success,
        }];
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::HiddenTestShape { test_index: 0 })
        );
        // reference_payload 非空载荷但无输入槽。
        let mut engine = engine_with_regions();
        let mut spec = vacuous_spec();
        spec.hidden_tests = alloc::vec![HiddenTestSpec {
            test_id: String::from("t"),
            kind: HiddenTestKind::ReferencePayload,
            payload: alloc::vec![1, 2],
            expected: VerdictKind::Success,
        }];
        let no_sink = JudgingContext {
            virtual_file_ids: file_context().virtual_file_ids,
            input_sink: None,
        };
        assert_eq!(
            assemble(&spec, &no_sink, &mut engine),
            Err(JudgeAssembleError::HiddenTestShape { test_index: 0 })
        );
        // 载荷超长(> 4096)。
        let mut engine = engine_with_regions();
        let mut spec = vacuous_spec();
        spec.hidden_tests = alloc::vec![HiddenTestSpec {
            test_id: String::from("t"),
            kind: HiddenTestKind::ReferencePayload,
            payload: alloc::vec![0u8; 4097],
            expected: VerdictKind::Success,
        }];
        assert_eq!(
            assemble(&spec, &file_context(), &mut engine),
            Err(JudgeAssembleError::HiddenTestShape { test_index: 0 })
        );
    }

    /// 绿灯:合法判题面装配通过,迁移目标解析为索引(副作用触发在 `Judge::assemble`)。
    #[test]
    fn assemble_green_path_resolves_transition_targets() {
        let mut engine = engine_with_regions();
        let mut spec = vacuous_spec();
        let mut s0 = stage("s0", "s1");
        s0.side_effects = alloc::vec![StageSideEffect::GrantVirtualFile {
            file_id: String::from("flag-file"),
        }];
        spec.stages = alloc::vec![s0, stage("s1", "")];
        spec.success_condition = ConditionL1::of(Predicate::RegisterEquals {
            register: String::from("RAX"),
            value: ArchValue::new(0, A32),
        });
        let resolved = assemble(&spec, &file_context(), &mut engine).unwrap();
        assert_eq!(
            resolved.transition_targets,
            alloc::vec![alloc::vec![1], alloc::vec![]]
        );
        // 初始前置的求值已记账(步耗 = 谓词数;此处前置恒真 0 谓词)。
        assert_eq!(engine.state.constraints.predicate_evals.used, 0);
    }

    /// 装配的初始前置求值计入预算(非零谓词前置)。
    #[test]
    fn assemble_charges_initial_precondition_evaluation() {
        let mut engine = engine_with_regions();
        let mut spec = vacuous_spec();
        let mut s0 = stage("s0", "");
        s0.preconditions = ConditionL1 {
            all: Some(alloc::vec![ConditionL2 {
                all: Some(alloc::vec![
                    crate::judge::predicate::ConditionL3 {
                        predicate: Predicate::RegisterEquals {
                            register: String::from("RAX"),
                            value: ArchValue::new(0, A32),
                        },
                    },
                    crate::judge::predicate::ConditionL3 {
                        predicate: Predicate::StackCanaryIntact,
                    },
                ]),
                any: None,
                not: None,
            }]),
            any: None,
            not: None,
        };
        spec.stages = alloc::vec![s0];
        assemble(&spec, &file_context(), &mut engine).unwrap();
        assert_eq!(engine.state.constraints.predicate_evals.used, 2);
    }

    #[test]
    fn session_action_roundtrip() {
        assert_eq!(SessionActionType::ALL.len(), 12);
        for action in SessionActionType::ALL {
            assert_eq!(SessionActionType::parse(action.as_str()), Some(action));
        }
        assert_eq!(SessionActionType::parse("nope"), None);
    }
}

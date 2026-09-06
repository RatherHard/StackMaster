//! 契约类型的 Rust 消费面镜像(WP-1;计划书 5.6 / ADR-5:serde + schemars 消费)。
//!
//! 覆盖引擎进程协议的两条入站契约面:
//! - [`ActionRequestMirror`]:会话动作协议 12 动作判别式(apply_action 载荷);
//! - [`PrivateBundleMirror`]:私有判题包全字段结构(load 载荷)。
//!
//! 纪律(沿 tooling/contract-smoke mirrors 模块):镜像只声明结构(字段集合
//! 与必需性,`deny_unknown_fields` 对应 Schema 的 `additionalProperties: false`),
//! 字面校验(pattern、长度、范围)归契约校验层([`super::schema`]),跨字段
//! 语义归 [`super::semantic`];schemars 派生供镜像漂移冒烟比对(顶层属性 /
//! 必需键集合与 Zod 产出的 JSON Schema 相等)。
//!
//! 出站契约面(ActionResponse / 投影 / 错误)的镜像类型随 WP-7 投影生成面
//! 落地;WP-1 骨架对出站按同一 JSON Schema 做值级自检
//! ([`super::schema::ContractValidators::action_response`])。

use schemars::JsonSchema;
use serde::Deserialize;
use std::collections::BTreeMap;

// ─────────────────────────────────────────────────────────────────────────────
// ActionRequest(会话动作协议 v1;schema/action-request.schema.json)
// ─────────────────────────────────────────────────────────────────────────────

/// 12 动作判别式的动作类型名(stages.allowedActions 与信封 `action.type` 共用)。
#[derive(Deserialize, JsonSchema, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionActionType {
    WriteBytes,
    Push,
    Pop,
    Call,
    Ret,
    Step,
    RunToEvent,
    Pause,
    Undo,
    CheckoutCheckpoint,
    Reset,
    CreateCheckpoint,
}

/// `run_to_event.pauseOn` 暂停事件枚举(与投影控制流 `pausedOn` 同源)。
#[derive(Deserialize, JsonSchema, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PauseEvent {
    Read,
    Write,
    Call,
    Ret,
    Exception,
}

/// `action: { type, args }` 判别对象:tag = `type`,content = `args`
/// (相邻标记恰好复现双字段判别形态;未知 type / 未知字段在此拒绝)。
#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq)]
#[serde(
    tag = "type",
    content = "args",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ActionCallMirror {
    WriteBytes {
        address_hex: String,
        bytes_hex: String,
    },
    Push {
        value_hex: String,
    },
    Pop {},
    Call {
        target_hex: String,
    },
    Ret {},
    Step {},
    RunToEvent {
        pause_on: PauseEvent,
    },
    Pause {},
    Undo {},
    CheckoutCheckpoint {
        checkpoint_id: String,
    },
    Reset {},
    /// `label` 为可选自报标签(Schema 仅约束出现时的形态)。
    CreateCheckpoint {
        label: Option<String>,
    },
}

/// `ActionRequest` 六字段信封(整体 BOUNDARY;worker 对编排器预校验后的
/// 载荷按同一契约重新校验,不信任调用方类型标注)。
#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActionRequestMirror {
    pub protocol_version: u32,
    pub session_id: String,
    pub client_seq: u64,
    pub base_revision: u64,
    pub idempotency_key: String,
    pub action: ActionCallMirror,
}

// ─────────────────────────────────────────────────────────────────────────────
// PrivateChallengeBundle(challenge-schema v1;schema/private-bundle.schema.json)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SeedStrategy {
    Fixed,
    ServerRandomPerSession,
}

/// 策略与 seed 互斥(R5):fixed ⇒ seedHex 必填、server_random_per_session ⇒
/// seedHex 禁止——Schema if/then/else 承载;镜像仅声明结构。
#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SeedPolicyMirror {
    pub strategy: SeedStrategy,
    pub seed_hex: Option<String>,
}

#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RegionKind {
    Code,
    Global,
    Stack,
    Heap,
    Key,
    Custom,
}

/// 内存区域种子(VMA 语义:byteLength 为 4096 倍数,XS-MEM-PAGE-ALIGN 复核)。
#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MemoryRegionSeedMirror {
    pub region_id: String,
    pub kind: RegionKind,
    pub start_address_hex: String,
    pub byte_length: u64,
    /// 规范序子集 `r?w?x?`(形态校验归 Schema)。
    pub permissions: String,
    pub content_hex: String,
    pub is_hidden: bool,
}

/// 初始寄存器:一般名与 FLAG 保留名双命名空间(G2/D3),键模式校验归 Schema。
pub type RegisterSeedMap = BTreeMap<String, String>;

#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InitialStateMirror {
    pub registers: RegisterSeedMap,
    pub memory_regions: Vec<MemoryRegionSeedMirror>,
}

#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VirtualFileMirror {
    pub file_id: String,
    pub content: String,
}

#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SecretsMirror {
    pub flag: String,
    pub virtual_files: Vec<VirtualFileMirror>,
}

#[derive(Deserialize, JsonSchema, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PrivateObjectKind {
    Buffer,
    Canary,
    SavedRbp,
    ReturnAddress,
    File,
    Other,
}

#[derive(Deserialize, JsonSchema, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ObjectVisibility {
    Public,
    Hidden,
}

#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PrivateObjectMirror {
    pub object_id: String,
    pub kind: PrivateObjectKind,
    pub address_hex: String,
    pub byte_length: u64,
    pub visibility: ObjectVisibility,
    pub contains_secret: bool,
}

#[derive(Deserialize, JsonSchema, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HiddenTestKind {
    ReferencePayload,
    PredicateProbe,
}

/// 隐藏测试期望结果:7 值可达判定枚举(D6:challenge_invalid / replay_mismatch /
/// cancelled / engine_error 非可授权期望)。
#[derive(Deserialize, JsonSchema, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HiddenTestExpectedResult {
    Success,
    WrongAnswer,
    InvalidAction,
    ProgramCrash,
    MemoryFault,
    ResourceLimit,
    Timeout,
}

#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HiddenTestMirror {
    pub test_id: String,
    pub kind: HiddenTestKind,
    pub payload_hex: Option<String>,
    pub expected_result: HiddenTestExpectedResult,
}

#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct JudgingMirror {
    pub success_condition: ConditionL1Mirror,
    pub failure_conditions: Option<Vec<ConditionL1Mirror>>,
    pub hidden_tests: Option<Vec<HiddenTestMirror>>,
}

// ── 谓词与条件(L1 → L2 → L3 → 谓词;深度静态封顶,XS-NESTING)──

/// 七项内置谓词封闭集(最小DSL范围 §四;oneOf 以 type 判别)。
#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PredicateMirror {
    RegisterEquals {
        register: String,
        value_hex: String,
    },
    RegisterBitsSet {
        register: String,
        mask_hex: String,
    },
    MemoryEquals {
        region_id: String,
        offset_bytes: u64,
        bytes_hex: String,
    },
    MemoryContains {
        region_id: String,
        bytes_hex: String,
    },
    RetTargetEquals {
        address_hex: String,
    },
    StackCanaryIntact {},
    VirtualFileRead {
        file_id: String,
    },
}

#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConditionL3Mirror {
    pub predicate: PredicateMirror,
}

/// 第二级布尔组合;all/any 允许空数组(恒真 / 恒假)。
#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConditionL2Mirror {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub all: Option<Vec<ConditionL3Mirror>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub any: Option<Vec<ConditionL3Mirror>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not: Option<Box<ConditionL3Mirror>>,
}

/// 判题条件根(L1)。
#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConditionL1Mirror {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub all: Option<Vec<ConditionL2Mirror>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub any: Option<Vec<ConditionL2Mirror>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not: Option<Box<ConditionL2Mirror>>,
}

// ── 多阶段状态机(7.2 六要素)──

#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StageTransitionMirror {
    pub to_stage_id: String,
    pub on_condition: ConditionL1Mirror,
}

/// v1 封闭副作用:仅 grant_virtual_file,结构化 fileId 引用(F-4/F-5)。
#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StageSideEffectMirror {
    GrantVirtualFile { file_id: String },
}

#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StageResourceBudgetMirror {
    pub max_instruction_steps: u64,
    pub max_actions: Option<u64>,
}

#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StageMirror {
    pub stage_id: String,
    pub allowed_actions: Vec<SessionActionType>,
    pub preconditions: ConditionL1Mirror,
    pub transitions: Vec<StageTransitionMirror>,
    pub side_effects: Vec<StageSideEffectMirror>,
    pub failure_conditions: Vec<ConditionL1Mirror>,
    pub resource_budget: StageResourceBudgetMirror,
}

// ── IR 模式编译产物(irFormatVersion = 2)──

#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OperandMirror {
    Register {
        name: String,
    },
    Immediate {
        value_hex: String,
    },
    Memory {
        base_register: Option<String>,
        displacement_hex: Option<String>,
    },
    /// 作者接口结构化引用(G4/D4;interfaceId ∈ [0x0100, 0xFFFF])。
    Interface {
        interface_id: u64,
    },
}

/// 指令:`op` 为 20 基线 opcode 枚举 ∪ 大写自定义助记符(两形态按大小写
/// 结构性不相交);逐 opcode 合法性归 challenge-compiler(WP-2),镜像不约束。
#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InstructionMirror {
    pub op: String,
    pub operands: Option<Vec<OperandMirror>>,
}

#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LabelMirror {
    pub label_id: String,
    pub instruction_index: u64,
}

#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CompiledIrMirror {
    pub ir_format_version: u32,
    pub entrypoint_index: Option<u64>,
    pub instructions: Vec<InstructionMirror>,
    pub labels: Vec<LabelMirror>,
}

// ── 自定义指令与作者接口(G4/D4 声明面)──

#[derive(Deserialize, JsonSchema, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LogicOp {
    And,
    Or,
    Xor,
}

/// 微算子封闭集 v1(定步数直线原语,无控制转移)。
#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(
    tag = "op",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MicroOpMirror {
    LoadImm {
        dst: String,
        value_hex: String,
    },
    MovReg {
        dst: String,
        src: String,
    },
    LoadMem {
        dst: String,
        base_register: String,
        displacement_hex: String,
    },
    StoreMem {
        base_register: String,
        displacement_hex: String,
        src: String,
    },
    SetFlag {
        flag_register: String,
        value_hex: String,
    },
    BitMask {
        dst: String,
        src: String,
        mask_hex: String,
        logic: LogicOp,
    },
}

#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CustomInstructionMirror {
    pub mnemonic: String,
    pub display_text: String,
    pub semantics: Vec<MicroOpMirror>,
}

/// 接口效果原语封闭集 v1(exit / grant_virtual_file / virtual_file_read /
/// set_flag / noop;无宿主 IO 原语,F-4 保持)。
#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(
    tag = "effect",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum InterfaceEffectMirror {
    Exit {},
    GrantVirtualFile {
        file_id: String,
    },
    VirtualFileRead {
        file_id: String,
    },
    SetFlag {
        flag_register: String,
        value_hex: String,
    },
    Noop {},
}

#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InterfaceMirror {
    pub interface_id: u64,
    pub display_text: String,
    pub effects: Vec<InterfaceEffectMirror>,
}

// ── 判题配置与根 ──

#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct JudgingConfigMirror {
    pub verdict_rule_version: String,
    pub max_predicate_eval_steps: u64,
    pub timeout_ms_per_action: Option<u64>,
    pub max_total_action_bytes: Option<u64>,
}

/// 私有判题包根(整体 SERVER_ONLY):`compiledIr` 与 `entrypointAddressHex`
/// 为条件字段(G5/P5/D6,双程序形态恰一由跨包 XS-PROG-MODE 强制),镜像以
/// Option 承载、互斥由 Schema if/then 与 XS 检查器把关。
#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PrivateBundleMirror {
    pub schema_version: u32,
    pub challenge_id: String,
    pub challenge_content_version: String,
    pub vm_profile_version: String,
    pub dsl_schema_version: u32,
    pub vm_engine_version: String,
    pub engine_build_id: Option<String>,
    pub declared_seed_public_paths: Vec<String>,
    pub seed_policy: SeedPolicyMirror,
    pub initial_state: InitialStateMirror,
    pub secret_sink_registers: Option<Vec<String>>,
    pub secrets: SecretsMirror,
    pub private_objects: Vec<PrivateObjectMirror>,
    pub judging: JudgingMirror,
    pub stages: Option<Vec<StageMirror>>,
    pub compiled_ir: Option<CompiledIrMirror>,
    pub entrypoint_address_hex: Option<String>,
    pub custom_instructions: Option<Vec<CustomInstructionMirror>>,
    pub interfaces: Option<Vec<InterfaceMirror>>,
    pub judging_config: JudgingConfigMirror,
}

//! 装配器(WP-8):契约镜像 → 引擎 / 判题 / 投影 / 回放上下文的唯一转换点。
//!
//! # 输入
//!
//! - 已过三重校验的私有判题包镜像(`PrivateBundleMirror`);
//! - 已过冻结 Schema 复验的公开描述包抽取(`PublicDescriptorExtract`,D-F10);
//! - 会话种子(仅 `server_random_per_session` 策略)。
//!
//! # 装配序(fail-closed,任一步拒绝即整体拒绝,方向 `challenge_invalid`)
//!
//! ```text
//! 双程序形态恰一(XS-PROG-MODE 镜像)
//!   → seed 策略解析(XS-SEED-POLICY 镜像,resolve_seed_state)
//!   → 内存区域 + 初始寄存器(公开布局一致性复核)
//!   → 约束预算(来源表见 D-W8-3;公开预算与判题预算双真相源复核)
//!   → 程序(IR 编译产物直读 / 字节模式公开编码表)
//!   → 自定义指令与作者接口声明面
//!   → canary 槽位(公开规格与私有对象互证,XS-CANARY-CORR 镜像)
//!   → Engine::new → 判题面 Judge::assemble(全量镜像复验)
//!   → 投影策略与静态声明面(D-W8-1)
//!   → 回放上下文(规范化哈希;不含 seed 值)
//! ```
//!
//! 上游(challenge-compiler)已把关的跨包语义在此做**镜像复验**:漏检在
//! 装载即拒绝,不进入执行(引擎进程协议 §5.2 基线 #6 的执行域内落点)。

use std::collections::BTreeMap;

use projection::policy::{ErrorDetailLevel, ProjectionPolicy, ProjectionPolicySpec, SecretSinkSet};
use projection::project::{HighlightDeclaration, ProjectionStatics};
use vm_core::arch::{ArchBits, ArchValue};
use vm_core::exec::{CanarySlotSpec, Engine, EngineConfig};
use vm_core::instr::{
    BaselineOp, BitLogic, CustomInstructionDef, EffectPrimitive, EncodingOperandShape,
    EncodingTableEntry, InterfaceDef, MicroOp, Op, Operand, Program,
};
use vm_core::judge::hidden::{HiddenTestKind, VerdictKind};
use vm_core::judge::predicate::{ConditionL1, ConditionL2, ConditionL3, Predicate};
use vm_core::judge::seed::resolve_seed_state;
use vm_core::judge::spec::{
    HiddenTestSpec, JudgingConfigLimits, JudgingContext, JudgingSpec, SessionActionType,
    StageSideEffect, StageSpec, StageTransitionSpec,
};
use vm_core::memory::{ExecutionMode, Permissions, RegionContents, RegionKind, RegionSpec};
use vm_core::registers::is_flag_name;
use vm_core::state::SeedStrategy;
use vm_core::state::{Budget, CumulativeBudget, RuntimeConstraints, VmStateConfig};
use vm_runtime::action_log::{ReplayContext, SeedReplayMeta};
use vm_runtime::identity::EngineIdentity;
use vm_runtime::runtime::{SessionConfig, SessionRuntime};

use crate::contract::mirrors::{
    self, ActionCallMirror, CanarySpecExtract, ConditionL1Mirror, ConditionL2Mirror,
    ConditionL3Mirror, EncodingEntryExtract, EncodingOperandExtract, InterfaceEffectMirror,
    InterfaceMirror, MemoryRegionSeedMirror, MicroOpMirror, PrivateBundleMirror,
    PublicDescriptorExtract, PublicRegionExtract,
};

/// 协议护栏:单动作写入字节上限(`MAX_WRITE_BYTES`,4096)。
pub const PROTOCOL_MAX_WRITE_BYTES: u64 = 4_096;
/// 协议护栏:调用栈摘要深度上限(`CALL_STACK_MAX_DEPTH`,64)。
pub const PROTOCOL_CALL_STACK_MAX_DEPTH: u64 = 64;

/// 装配默认:单动作 wall-clock 上限(`judgingConfig.timeoutMsPerAction`
/// 缺省时;worker 看门狗读取值,引擎不消费)。
pub const DEFAULT_TIMEOUT_MS_PER_ACTION: u64 = 5_000;
/// 装配默认:回退 / 重置累计预算(公开包未声明 `rollbackBudgetPerSession`
/// 时的协议护栏值;testkit 教学规模同值)。
pub const ROLLBACK_OPS_DEFAULT: u64 = 200;
/// 装配默认:全局步数预算(阶段级预算由判题面强制;本值为引擎全局护栏,
/// 与判题面 `MAX_STAGE_INSTRUCTION_STEPS` 上界同值)。
pub const GLOBAL_STEPS_LIMIT: u64 = 10_000_000;
/// 装配默认:动作日志长度护栏(教学规模;运行时结构上限)。
pub const ACTION_LOG_LIMIT: u64 = 10_000;
/// 装配默认:输出字节护栏(与协议 `MAX_WRITE_BYTES` 同量级)。
pub const OUTPUT_BYTES_LIMIT: u64 = 4_096;
/// 装配默认:会话级 wall-clock 登记(引擎无时钟;worker 看门狗按动作执行)。
pub const SESSION_WALL_CLOCK_MS_LIMIT: u64 = 3_600_000;

/// 初始寄存器表(名 → 掩蔽域值)+ FLAG 名集 + 初始 IP 的装配三元组。
type RegisterSeeds = (Vec<(String, ArchValue)>, Vec<String>, ArchValue);

/// 装配拒绝(challenge_invalid 方向;`reason` 为确定性定位标签,只进受控
/// 日志与测试断言,不进公开响应——基线 #8 静态模板由命令级错误承载)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssembleError {
    /// 拒绝原因标签(规约测试锚点引用)。
    pub reason: &'static str,
}

impl AssembleError {
    /// 拒绝构造(`pub(crate)`:调试变体装配路径复用同一拒绝形态)。
    pub(crate) fn reject(reason: &'static str) -> Self {
        Self { reason }
    }
}

/// 装配产物:会话运行时 + 投影策略 + 静态声明面 + worker 层资源参数。
pub struct SessionComponents {
    /// 会话运行时(引擎 + 判题 + 快照 / 日志 / revision 账本)。
    pub runtime: SessionRuntime,
    /// 投影白名单策略(SERVER_ONLY,只存在于本进程)。
    pub policy: ProjectionPolicy,
    /// 投影静态声明面(区域标签来自公开描述包,D-F10)。
    pub statics: ProjectionStatics,
    /// 单动作 wall-clock 上限(看门狗读取;`timeoutMsPerAction` 或默认)。
    pub timeout_ms_per_action: u64,
    /// 题目级单动作写入字节预算(公开包声明,缺省 = 协议上限)。
    pub max_write_bytes_per_action: u64,
}

/// 装配入口(见模块文档装配序)。
pub fn assemble(
    bundle: &PrivateBundleMirror,
    bundle_json: &serde_json::Value,
    public: &PublicDescriptorExtract,
    public_json: &serde_json::Value,
    session_seed_hex: Option<&str>,
    identity: &EngineIdentity,
) -> Result<SessionComponents, AssembleError> {
    let arch = ArchBits::from_bits(public.vm_profile.arch_bits)
        .ok_or_else(|| AssembleError::reject("arch_bits_invalid"))?;
    let page_size = public.vm_profile.page_size_bytes;

    // ── 双程序形态恰一(XS-PROG-MODE 镜像)+ 字节模式公开编码表单点 ──
    let program_mode = match (&bundle.compiled_ir, &bundle.entrypoint_address_hex) {
        (Some(_), None) => ProgramMode::Ir,
        (None, Some(_)) => ProgramMode::Byte,
        _ => return Err(AssembleError::reject("program_mode_ambiguous")),
    };
        let encoding_table = match (&public.vm_profile.encoding_table, program_mode) {
            (None, ProgramMode::Ir) => None,
            (Some(table), ProgramMode::Byte) => Some(encoding_table(table)?),
            (None, ProgramMode::Byte) => {
                return Err(AssembleError::reject(
                    "byte_mode_requires_public_encoding_table",
                ));
            }
            (Some(_), ProgramMode::Ir) => {
                return Err(AssembleError::reject("ir_mode_forbids_encoding_table"));
            }
        };

    // ── seed 策略解析(XS-SEED-POLICY 引擎镜像;worker 只消费编排器会话种子)
    let package_seed = match &bundle.seed_policy.seed_hex {
        Some(text) => {
            Some(decode_hex_bytes(text).ok_or_else(|| AssembleError::reject("seed_hex"))?)
        }
        None => None,
    };
    let session_seed = match session_seed_hex {
        Some(text) => {
            Some(decode_hex_bytes(text).ok_or_else(|| AssembleError::reject("seed_hex"))?)
        }
        None => None,
    };
    let strategy = match bundle.seed_policy.strategy {
        mirrors::SeedStrategy::Fixed => SeedStrategy::Fixed,
        mirrors::SeedStrategy::ServerRandomPerSession => SeedStrategy::ServerRandomPerSession,
    };
    let seed_state = resolve_seed_state(strategy, package_seed.as_deref(), session_seed.as_deref())
        .map_err(|_| AssembleError::reject("seed_policy"))?;

    // ── 内存区域与初始寄存器 ──
    let (regions, contents) = build_regions(&bundle.initial_state.memory_regions, public, arch)?;
    let (registers, flag_register_names, initial_ip) = build_registers(
        &bundle.initial_state.registers,
        &public.vm_profile.registers,
        &bundle.secret_sink_registers,
        arch,
    )?;

    // ── 约束预算(D-W8-3 来源表)──
    let constraints = build_constraints(bundle, public, &regions)?;
    // 判题预算双真相源:公开声明存在时必须与私有判题配置同值。
    if let Some(limits) = &public.resource_limits
        && let Some(declared) = limits.predicate_eval_budget_per_session
        && declared != bundle.judging_config.max_predicate_eval_steps
    {
        return Err(AssembleError::reject("predicate_budget_mismatch"));
    }

    let state_config = VmStateConfig {
        arch,
        execution_mode: match program_mode {
            ProgramMode::Ir => ExecutionMode::Ir,
            ProgramMode::Byte => ExecutionMode::ByteCode,
        },
        page_size,
        regions,
        region_contents: contents,
        registers,
        flag_register_names,
        initial_instruction_pointer: initial_ip,
        constraints,
        seed_state,
    };

    // ── 程序与声明面(IR 模式:初始 IP 是指令索引,越界 = 装配拒绝)──
    let program = build_program(bundle, program_mode, encoding_table, arch, initial_ip)?;
    let custom_instructions = match &bundle.custom_instructions {
        Some(list) => list
            .iter()
            .map(|definition| convert_custom_instruction(definition, arch))
            .collect::<Result<Vec<_>, AssembleError>>()?,
        None => Vec::new(),
    };
    let interfaces = match &bundle.interfaces {
        Some(list) => list
            .iter()
            .map(|definition| convert_interface(definition, arch))
            .collect::<Result<Vec<_>, AssembleError>>()?,
        None => Vec::new(),
    };
    let canary_slots = build_canary_slots(bundle, public, arch)?;

    let mut engine = Engine::new(EngineConfig {
        state: state_config,
        program,
        custom_instructions,
        interfaces,
        canary_slots,
    })
    .map_err(|_| AssembleError::reject("engine_init"))?;

    // ── 判题面 ──
    let spec = JudgingSpec {
        success_condition: convert_condition_l1(&bundle.judging.success_condition, arch)?,
        failure_conditions: match &bundle.judging.failure_conditions {
            Some(list) => list
                .iter()
                .map(|condition| convert_condition_l1(condition, arch))
                .collect::<Result<Vec<_>, AssembleError>>()?,
            None => Vec::new(),
        },
        stages: match &bundle.stages {
            Some(list) => list
                .iter()
                .map(|stage| convert_stage(stage, arch))
                .collect::<Result<Vec<_>, AssembleError>>()?,
            None => Vec::new(),
        },
        hidden_tests: match &bundle.judging.hidden_tests {
            Some(list) => list
                .iter()
                .map(|test| {
                    Ok(HiddenTestSpec {
                        test_id: test.test_id.clone(),
                        kind: match test.kind {
                            mirrors::HiddenTestKind::ReferencePayload => {
                                HiddenTestKind::ReferencePayload
                            }
                            mirrors::HiddenTestKind::PredicateProbe => {
                                HiddenTestKind::PredicateProbe
                            }
                        },
                        payload: match &test.payload_hex {
                            Some(text) => decode_hex_bytes(text)
                                .ok_or_else(|| AssembleError::reject("hidden_test_payload"))?,
                            None => Vec::new(),
                        },
                        expected: convert_verdict(test.expected_result),
                    })
                })
                .collect::<Result<Vec<_>, AssembleError>>()?,
            None => Vec::new(),
        },
        limits: JudgingConfigLimits {
            max_predicate_eval_steps: bundle.judging_config.max_predicate_eval_steps,
        },
    };
    let context = JudgingContext {
        // D-W8-6(判题语义规约 D-H2 承接):双包 Schema v1 无输入槽声明字段,
        // `input_sink` 保持未声明——`reference_payload` 非空载荷的题目在装配
        // 复验即拒绝;契约面增补走契约变更流程,不在本 WP 私扩。
        input_sink: None,
        virtual_file_ids: bundle
            .secrets
            .virtual_files
            .iter()
            .map(|file| file.file_id.clone())
            .collect(),
    };
    let judge = vm_core::judge::Judge::assemble(spec, &context, &mut engine)
        .map_err(|_| AssembleError::reject("judge_assemble"))?;

    // ── 回放上下文(版本策略 §三记录项;哈希对规范化形态计,不含 seed 值)──
    let identity_ref = identity.clone();
    let replay_context = ReplayContext {
        challenge_id: bundle.challenge_id.clone(),
        challenge_content_version: bundle.challenge_content_version.clone(),
        vm_profile_version: bundle.vm_profile_version.clone(),
        vm_engine_version: identity_ref.vm_engine_version.clone(),
        engine_build_id: identity_ref.engine_build_id.clone(),
        verdict_rule_version: bundle.judging_config.verdict_rule_version.clone(),
        challenge_bundle_hash: canonical_hash(bundle_json)?,
        vm_profile_hash: canonical_hash(&public_json["vmProfile"])?,
        arch_bits: public.vm_profile.arch_bits,
        seed_policy: SeedReplayMeta {
            strategy: match bundle.seed_policy.strategy {
                mirrors::SeedStrategy::Fixed => "fixed",
                mirrors::SeedStrategy::ServerRandomPerSession => "server_random_per_session",
            }
            .to_owned(),
            derivation: None,
        },
    };

    let runtime = SessionRuntime::new(SessionConfig {
        identity: identity_ref,
        context: replay_context,
        engine,
        judge,
    })
    .map_err(|_| AssembleError::reject("runtime_assemble"))?;

    // ── 投影策略与静态声明面(D-W8-1)──
    let (policy, statics) = build_projection_face(bundle, public)?;

    Ok(SessionComponents {
        runtime,
        policy,
        statics,
        timeout_ms_per_action: bundle
            .judging_config
            .timeout_ms_per_action
            .unwrap_or(DEFAULT_TIMEOUT_MS_PER_ACTION),
        max_write_bytes_per_action: public
            .resource_limits
            .and_then(|limits| limits.max_write_bytes_per_action)
            .unwrap_or(PROTOCOL_MAX_WRITE_BYTES),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// 程序形态
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProgramMode {
    Ir,
    Byte,
}

fn build_program(
    bundle: &PrivateBundleMirror,
    mode: ProgramMode,
    encoding_table: Option<Vec<EncodingTableEntry>>,
    arch: ArchBits,
    initial_ip: ArchValue,
) -> Result<Program, AssembleError> {
    match mode {
        ProgramMode::Ir => {
            let ir = bundle
                .compiled_ir
                .as_ref()
                .ok_or_else(|| AssembleError::reject("program_mode_ambiguous"))?;
            let entrypoint_index = ir
                .entrypoint_index
                .ok_or_else(|| AssembleError::reject("ir_entrypoint_missing"))?;
            let instructions = ir
                .instructions
                .iter()
                .map(|instruction| convert_instruction(instruction, arch))
                .collect::<Result<Vec<_>, AssembleError>>()?;
            if initial_ip.get() >= instructions.len() as u64 {
                return Err(AssembleError::reject("ir_entrypoint_out_of_range"));
            }
            Ok(Program::Ir {
                instructions,
                entrypoint_index,
            })
        }
        ProgramMode::Byte => {
            let entrypoint_hex = bundle
                .entrypoint_address_hex
                .as_ref()
                .ok_or_else(|| AssembleError::reject("program_mode_ambiguous"))?;
            let entrypoint_address = ArchValue::parse_hex(entrypoint_hex, arch)
                .map_err(|_| AssembleError::reject("entrypoint_hex"))?;
            Ok(Program::Byte {
                table: encoding_table.ok_or_else(|| {
                    AssembleError::reject("byte_mode_requires_public_encoding_table")
                })?,
                entrypoint_address,
            })
        }
    }
}

fn convert_instruction(
    instruction: &mirrors::InstructionMirror,
    arch: ArchBits,
) -> Result<vm_core::instr::Instruction, AssembleError> {
    let op = parse_op(&instruction.op)?;
    let operands = match &instruction.operands {
        Some(list) => list
            .iter()
            .map(|operand| convert_operand(operand, arch))
            .collect::<Result<Vec<_>, AssembleError>>()?,
        None => Vec::new(),
    };
    Ok(vm_core::instr::Instruction { op, operands })
}

/// 双形态 opcode(基线小写枚举 ∪ 大写自定义助记符,大小写结构性不相交)。
fn parse_op(op: &str) -> Result<Op, AssembleError> {
    if let Some(baseline) = BaselineOp::parse(op) {
        return Ok(Op::Baseline(baseline));
    }
    let first = op
        .chars()
        .next()
        .ok_or_else(|| AssembleError::reject("opcode_empty"))?;
    if first.is_ascii_uppercase() {
        return Ok(Op::Custom(op.to_owned()));
    }
    Err(AssembleError::reject("opcode_unknown"))
}

fn convert_operand(
    operand: &mirrors::OperandMirror,
    arch: ArchBits,
) -> Result<Operand, AssembleError> {
    Ok(match operand {
        mirrors::OperandMirror::Register { name } => Operand::Register(name.clone()),
        mirrors::OperandMirror::Immediate { value_hex } => Operand::Immediate(
            ArchValue::parse_hex(value_hex, arch)
                .map_err(|_| AssembleError::reject("operand_hex"))?,
        ),
        mirrors::OperandMirror::Memory {
            base_register,
            displacement_hex,
        } => Operand::Memory {
            base: base_register.clone(),
            displacement: match displacement_hex {
                Some(text) => ArchValue::parse_hex(text, arch)
                    .map_err(|_| AssembleError::reject("operand_hex"))?,
                None => ArchValue::new(0, arch),
            },
        },
        mirrors::OperandMirror::Interface { interface_id } => Operand::Interface(
            u32::try_from(*interface_id).map_err(|_| AssembleError::reject("interface_id"))?,
        ),
    })
}

/// 公开编码表转换(`pub`:调试变体装配复用同一转换——编码表是公开面
/// 单点来源,D-F10,调试实例与真实实例同表)。
pub fn encoding_table(
    table: &[EncodingEntryExtract],
) -> Result<Vec<EncodingTableEntry>, AssembleError> {
    table
        .iter()
        .map(|entry| {
            let token = parse_token_hex(&entry.token_hex)?;
            let op = parse_op(&entry.op)?;
            let operand_shapes = match &entry.operands {
                Some(list) => list
                    .iter()
                    .map(convert_encoding_operand)
                    .collect::<Result<Vec<_>, AssembleError>>()?,
                None => Vec::new(),
            };
            Ok(EncodingTableEntry {
                token,
                op,
                operand_shapes,
            })
        })
        .collect()
}

/// `tokenHex`(`^0x[0-9a-fA-F]{2}$`,Schema 已锚)→ 字节。
fn parse_token_hex(text: &str) -> Result<u8, AssembleError> {
    let body = text
        .strip_prefix("0x")
        .ok_or_else(|| AssembleError::reject("token_hex"))?;
    if body.len() != 2 {
        return Err(AssembleError::reject("token_hex"));
    }
    u8::from_str_radix(body, 16).map_err(|_| AssembleError::reject("token_hex"))
}

fn convert_encoding_operand(
    operand: &EncodingOperandExtract,
) -> Result<EncodingOperandShape, AssembleError> {
    match operand.kind.as_str() {
        "register" => Ok(EncodingOperandShape::Register(
            operand
                .name
                .clone()
                .ok_or_else(|| AssembleError::reject("encoding_operand"))?,
        )),
        "immediate" => Ok(EncodingOperandShape::ImmediateArch),
        "memory" => Ok(EncodingOperandShape::Memory {
            base: operand
                .base_register
                .clone()
                .ok_or_else(|| AssembleError::reject("encoding_operand"))?,
        }),
        "interface" => Ok(EncodingOperandShape::Interface(
            u32::try_from(
                operand
                    .interface_id
                    .ok_or_else(|| AssembleError::reject("encoding_operand"))?,
            )
            .map_err(|_| AssembleError::reject("encoding_operand"))?,
        )),
        _ => Err(AssembleError::reject("encoding_operand")),
    }
}

// 上面函数引用的公开表操作数抽取(与 EncodingOperandExtract 同形;别名以
// 保持签名可读)。
// ─────────────────────────────────────────────────────────────────────────────
// 内存 / 寄存器 / canary
// ─────────────────────────────────────────────────────────────────────────────

/// 内存区域:私有包种子(VMA + 装载内容)→ `RegionSpec` + `RegionContents`;
/// `custom` 类型的作者命名自公开描述包区域标签单点派生(隐藏 custom 区域
/// 无公开标签来源,拒绝装载)。
fn build_regions(
    seeds: &[MemoryRegionSeedMirror],
    public: &PublicDescriptorExtract,
    arch: ArchBits,
) -> Result<(Vec<RegionSpec>, Vec<RegionContents>), AssembleError> {
    let label_of = |region_id: &str| -> Option<&PublicRegionExtract> {
        public
            .memory_layout
            .regions
            .iter()
            .find(|region| region.region_id == region_id)
    };
    let mut specs = Vec::with_capacity(seeds.len());
    let mut contents = Vec::with_capacity(seeds.len());
    for seed in seeds {
        let kind = match seed.kind {
            mirrors::RegionKind::Code => RegionKind::Code,
            mirrors::RegionKind::Global => RegionKind::Global,
            mirrors::RegionKind::Stack => RegionKind::Stack,
            mirrors::RegionKind::Heap => RegionKind::Heap,
            mirrors::RegionKind::Key => RegionKind::Key,
            mirrors::RegionKind::Custom => RegionKind::Custom,
        };
        let custom_label = match kind {
            RegionKind::Custom => {
                if seed.is_hidden {
                    return Err(AssembleError::reject("hidden_custom_region_unlabeled"));
                }
                let label = label_of(&seed.region_id)
                    .map(|region| region.public_label.clone())
                    .ok_or_else(|| AssembleError::reject("custom_region_unlabeled"))?;
                Some(label)
            }
            _ => None,
        };
        let start = ArchValue::parse_hex(&seed.start_address_hex, arch)
            .map_err(|_| AssembleError::reject("region_address_hex"))?;
        let permissions = Permissions::parse(&seed.permissions)
            .map_err(|_| AssembleError::reject("permissions"))?;
        let bytes = decode_hex_bytes(&seed.content_hex)
            .ok_or_else(|| AssembleError::reject("region_content_hex"))?;
        if bytes.len() as u64 != seed.byte_length {
            return Err(AssembleError::reject("region_content_length"));
        }
        specs.push(
            RegionSpec::new(
                &seed.region_id,
                kind,
                custom_label.as_deref(),
                start.get(),
                seed.byte_length,
                permissions,
                arch,
            )
            .map_err(|_| AssembleError::reject("region_spec"))?,
        );
        contents.push(RegionContents {
            region_id: seed.region_id.clone(),
            bytes,
        });
    }
    Ok((specs, contents))
}

/// 初始寄存器:一般名 / FLAG 双命名空间拆分;`RIP` 抽出为
/// `initial_instruction_pointer`(引擎内 RIP 寄存器与指令指针同源同步)。
/// 返回 `(寄存器表, FLAG 名集, 初始 IP)`。
fn build_registers(
    seeds: &BTreeMap<String, String>,
    declared_visible: &[crate::contract::mirrors::RegisterDeclarationExtract],
    secret_sinks: &Option<Vec<String>>,
    arch: ArchBits,
) -> Result<RegisterSeeds, AssembleError> {
    let mut registers = Vec::with_capacity(seeds.len());
    let mut flags = Vec::new();
    let mut initial_ip = None;
    for (name, text) in seeds {
        let value =
            ArchValue::parse_hex(text, arch).map_err(|_| AssembleError::reject("register_hex"))?;
        if name == "RIP" {
            initial_ip = Some(value);
        }
        if is_flag_name(name) {
            flags.push(name.clone());
        }
        registers.push((name.clone(), value));
    }
    let initial_ip = initial_ip.ok_or_else(|| AssembleError::reject("rip_missing"))?;
    // 公开寄存器声明面(`vmProfile.registers`,visibleRegisters 组装来源):
    // 每一项都必须在初始寄存器集中且非秘密汇(I3 装配期复核;FLAG 名由
    // Schema 结构性禁止,此处防御性复核)。
    for declaration in declared_visible {
        let name = &declaration.name;
        if is_flag_name(name) {
            return Err(AssembleError::reject("public_register_flag"));
        }
        if !seeds.contains_key(name) {
            return Err(AssembleError::reject("public_register_undeclared"));
        }
        let sink = secret_sinks
            .as_ref()
            .is_some_and(|sinks| sinks.contains(name));
        if sink {
            return Err(AssembleError::reject("public_register_is_secret_sink"));
        }
    }
    Ok((registers, flags, initial_ip))
}

/// canary 槽位:私有对象 `kind = canary` + 公开规格互证(XS-CANARY-CORR
/// 镜像)。槽位长度 = 公开 `sizeBytes`;canary 槽必须可见(教学锚点,
/// `from_exec_error` 的 required-real 形态依赖)。
fn build_canary_slots(
    bundle: &PrivateBundleMirror,
    public: &PublicDescriptorExtract,
    arch: ArchBits,
) -> Result<Vec<CanarySlotSpec>, AssembleError> {
    let canary_objects: Vec<_> = bundle
        .private_objects
        .iter()
        .filter(|object| object.kind == mirrors::PrivateObjectKind::Canary)
        .collect();
    let spec = public.vm_profile.canary;
    match (spec, canary_objects.is_empty()) {
        (None, true) | (Some(CanarySpecExtract { enabled: false, .. }), true) => Ok(Vec::new()),
        (None, false) | (Some(CanarySpecExtract { enabled: false, .. }), false) => {
            Err(AssembleError::reject("canary_spec_mismatch"))
        }
        (
            Some(CanarySpecExtract {
                enabled: true,
                size_bytes,
            }),
            false,
        ) => {
            let size = size_bytes.ok_or_else(|| AssembleError::reject("canary_size_missing"))?;
            let mut slots = Vec::with_capacity(canary_objects.len());
            for object in canary_objects {
                if object.byte_length != size {
                    return Err(AssembleError::reject("canary_size_mismatch"));
                }
                if object.visibility != mirrors::ObjectVisibility::Public {
                    return Err(AssembleError::reject("canary_slot_not_visible"));
                }
                let address = ArchValue::parse_hex(&object.address_hex, arch)
                    .map_err(|_| AssembleError::reject("canary_address_hex"))?;
                slots.push(CanarySlotSpec {
                    address: address.get(),
                    byte_length: size as usize,
                });
            }
            Ok(slots)
        }
        (Some(CanarySpecExtract { enabled: true, .. }), true) => {
            Err(AssembleError::reject("canary_object_missing"))
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 约束预算(D-W8-3 来源表)
// ─────────────────────────────────────────────────────────────────────────────

fn build_constraints(
    bundle: &PrivateBundleMirror,
    public: &PublicDescriptorExtract,
    regions: &[RegionSpec],
) -> Result<RuntimeConstraints, AssembleError> {
    let limits = public.resource_limits.unwrap_or_default();
    if let Some(budget) = limits.max_write_bytes_per_action
        && budget > PROTOCOL_MAX_WRITE_BYTES
    {
        return Err(AssembleError::reject("write_budget_over_protocol_cap"));
    }
    Ok(RuntimeConstraints {
        steps: Budget::new(0, GLOBAL_STEPS_LIMIT),
        memory_bytes_limit: regions.iter().map(|region| region.byte_length).sum(),
        wall_clock_ms_limit: SESSION_WALL_CLOCK_MS_LIMIT,
        call_depth_limit: PROTOCOL_CALL_STACK_MAX_DEPTH as u32,
        action_log: Budget::new(0, ACTION_LOG_LIMIT),
        output_bytes: Budget::new(0, OUTPUT_BYTES_LIMIT),
        timeout_ms_limit: bundle
            .judging_config
            .timeout_ms_per_action
            .unwrap_or(DEFAULT_TIMEOUT_MS_PER_ACTION),
        predicate_evals: CumulativeBudget::new(0, bundle.judging_config.max_predicate_eval_steps),
        rollback_ops: Budget::new(
            0,
            limits
                .rollback_budget_per_session
                .unwrap_or(ROLLBACK_OPS_DEFAULT),
        ),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// 判题面转换
// ─────────────────────────────────────────────────────────────────────────────

fn convert_condition_l1(
    condition: &ConditionL1Mirror,
    arch: ArchBits,
) -> Result<ConditionL1, AssembleError> {
    Ok(ConditionL1 {
        all: match &condition.all {
            Some(list) => Some(
                list.iter()
                    .map(|level2| convert_condition_l2(level2, arch))
                    .collect::<Result<Vec<_>, AssembleError>>()?,
            ),
            None => None,
        },
        any: match &condition.any {
            Some(list) => Some(
                list.iter()
                    .map(|level2| convert_condition_l2(level2, arch))
                    .collect::<Result<Vec<_>, AssembleError>>()?,
            ),
            None => None,
        },
        not: match &condition.not {
            Some(level2) => Some(Box::new(convert_condition_l2(level2, arch)?)),
            None => None,
        },
    })
}

fn convert_condition_l2(
    condition: &ConditionL2Mirror,
    arch: ArchBits,
) -> Result<ConditionL2, AssembleError> {
    Ok(ConditionL2 {
        all: match &condition.all {
            Some(list) => Some(
                list.iter()
                    .map(|level3| convert_condition_l3(level3, arch))
                    .collect::<Result<Vec<_>, AssembleError>>()?,
            ),
            None => None,
        },
        any: match &condition.any {
            Some(list) => Some(
                list.iter()
                    .map(|level3| convert_condition_l3(level3, arch))
                    .collect::<Result<Vec<_>, AssembleError>>()?,
            ),
            None => None,
        },
        not: match &condition.not {
            Some(level3) => Some(Box::new(convert_condition_l3(level3, arch)?)),
            None => None,
        },
    })
}

fn convert_condition_l3(
    condition: &ConditionL3Mirror,
    arch: ArchBits,
) -> Result<ConditionL3, AssembleError> {
    let predicate = match &condition.predicate {
        mirrors::PredicateMirror::RegisterEquals {
            register,
            value_hex,
        } => Predicate::RegisterEquals {
            register: register.clone(),
            value: ArchValue::parse_hex(value_hex, arch)
                .map_err(|_| AssembleError::reject("predicate_hex"))?,
        },
        mirrors::PredicateMirror::RegisterBitsSet { register, mask_hex } => {
            Predicate::RegisterBitsSet {
                register: register.clone(),
                mask: ArchValue::parse_hex(mask_hex, arch)
                    .map_err(|_| AssembleError::reject("predicate_hex"))?,
            }
        }
        mirrors::PredicateMirror::MemoryEquals {
            region_id,
            offset_bytes,
            bytes_hex,
        } => Predicate::MemoryEquals {
            region_id: region_id.clone(),
            offset_bytes: *offset_bytes,
            bytes: decode_hex_bytes(bytes_hex)
                .ok_or_else(|| AssembleError::reject("predicate_hex"))?,
        },
        mirrors::PredicateMirror::MemoryContains {
            region_id,
            bytes_hex,
        } => Predicate::MemoryContains {
            region_id: region_id.clone(),
            bytes: decode_hex_bytes(bytes_hex)
                .ok_or_else(|| AssembleError::reject("predicate_hex"))?,
        },
        mirrors::PredicateMirror::RetTargetEquals { address_hex } => Predicate::RetTargetEquals {
            address: ArchValue::parse_hex(address_hex, arch)
                .map_err(|_| AssembleError::reject("predicate_hex"))?,
        },
        mirrors::PredicateMirror::StackCanaryIntact {} => Predicate::StackCanaryIntact,
        mirrors::PredicateMirror::VirtualFileRead { file_id } => Predicate::VirtualFileRead {
            file_id: file_id.clone(),
        },
    };
    Ok(ConditionL3 { predicate })
}

fn convert_stage(stage: &mirrors::StageMirror, arch: ArchBits) -> Result<StageSpec, AssembleError> {
    Ok(StageSpec {
        stage_id: stage.stage_id.clone(),
        allowed_actions: stage
            .allowed_actions
            .iter()
            .map(|action| convert_action_type(*action))
            .collect(),
        preconditions: convert_condition_l1(&stage.preconditions, arch)?,
        transitions: stage
            .transitions
            .iter()
            .map(|transition| {
                Ok(StageTransitionSpec {
                    to_stage: transition.to_stage_id.clone(),
                    on_condition: convert_condition_l1(&transition.on_condition, arch)?,
                })
            })
            .collect::<Result<Vec<_>, AssembleError>>()?,
        side_effects: stage
            .side_effects
            .iter()
            .map(|effect| match effect {
                mirrors::StageSideEffectMirror::GrantVirtualFile { file_id } => {
                    Ok(StageSideEffect::GrantVirtualFile {
                        file_id: file_id.clone(),
                    })
                }
            })
            .collect::<Result<Vec<_>, AssembleError>>()?,
        failure_conditions: stage
            .failure_conditions
            .iter()
            .map(|condition| convert_condition_l1(condition, arch))
            .collect::<Result<Vec<_>, AssembleError>>()?,
        max_instruction_steps: stage.resource_budget.max_instruction_steps,
        max_actions: stage.resource_budget.max_actions,
    })
}

/// 契约动作枚举 → 引擎判题动作枚举(12 值一一映射)。
fn convert_action_type(action: mirrors::SessionActionType) -> SessionActionType {
    match action {
        mirrors::SessionActionType::WriteBytes => SessionActionType::WriteBytes,
        mirrors::SessionActionType::Push => SessionActionType::Push,
        mirrors::SessionActionType::Pop => SessionActionType::Pop,
        mirrors::SessionActionType::Call => SessionActionType::Call,
        mirrors::SessionActionType::Ret => SessionActionType::Ret,
        mirrors::SessionActionType::Step => SessionActionType::Step,
        mirrors::SessionActionType::RunToEvent => SessionActionType::RunToEvent,
        mirrors::SessionActionType::Pause => SessionActionType::Pause,
        mirrors::SessionActionType::Undo => SessionActionType::Undo,
        mirrors::SessionActionType::CheckoutCheckpoint => SessionActionType::CheckoutCheckpoint,
        mirrors::SessionActionType::Reset => SessionActionType::Reset,
        mirrors::SessionActionType::CreateCheckpoint => SessionActionType::CreateCheckpoint,
    }
}

/// 7 值可达判定一一映射(D6:不可达方向非可授权期望)。
fn convert_verdict(expected: mirrors::HiddenTestExpectedResult) -> VerdictKind {
    match expected {
        mirrors::HiddenTestExpectedResult::Success => VerdictKind::Success,
        mirrors::HiddenTestExpectedResult::WrongAnswer => VerdictKind::WrongAnswer,
        mirrors::HiddenTestExpectedResult::InvalidAction => VerdictKind::InvalidAction,
        mirrors::HiddenTestExpectedResult::ProgramCrash => VerdictKind::ProgramCrash,
        mirrors::HiddenTestExpectedResult::MemoryFault => VerdictKind::MemoryFault,
        mirrors::HiddenTestExpectedResult::ResourceLimit => VerdictKind::ResourceLimit,
        mirrors::HiddenTestExpectedResult::Timeout => VerdictKind::Timeout,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 自定义指令 / 作者接口
// ─────────────────────────────────────────────────────────────────────────────

fn convert_custom_instruction(
    definition: &mirrors::CustomInstructionMirror,
    arch: ArchBits,
) -> Result<CustomInstructionDef, AssembleError> {
    let semantics = definition
        .semantics
        .iter()
        .map(|micro| convert_micro_op(micro, arch))
        .collect::<Result<Vec<_>, AssembleError>>()?;
    Ok(CustomInstructionDef {
        mnemonic: definition.mnemonic.clone(),
        display_text: definition.display_text.clone(),
        semantics,
    })
}

fn convert_micro_op(micro: &MicroOpMirror, arch: ArchBits) -> Result<MicroOp, AssembleError> {
    Ok(match micro {
        MicroOpMirror::LoadImm { dst, value_hex } => MicroOp::LoadImm {
            dst: dst.clone(),
            value: ArchValue::parse_hex(value_hex, arch)
                .map_err(|_| AssembleError::reject("micro_op_hex"))?,
        },
        MicroOpMirror::MovReg { dst, src } => MicroOp::MovReg {
            dst: dst.clone(),
            src: src.clone(),
        },
        MicroOpMirror::LoadMem {
            dst,
            base_register,
            displacement_hex,
        } => MicroOp::LoadMem {
            dst: dst.clone(),
            base: base_register.clone(),
            displacement: ArchValue::parse_hex(displacement_hex, arch)
                .map_err(|_| AssembleError::reject("micro_op_hex"))?,
        },
        MicroOpMirror::StoreMem {
            base_register,
            displacement_hex,
            src,
        } => MicroOp::StoreMem {
            base: base_register.clone(),
            displacement: ArchValue::parse_hex(displacement_hex, arch)
                .map_err(|_| AssembleError::reject("micro_op_hex"))?,
            src: src.clone(),
        },
        MicroOpMirror::SetFlag {
            flag_register,
            value_hex,
        } => MicroOp::SetFlag {
            flag_register: flag_register.clone(),
            value: ArchValue::parse_hex(value_hex, arch)
                .map_err(|_| AssembleError::reject("micro_op_hex"))?,
        },
        MicroOpMirror::BitMask {
            dst,
            src,
            mask_hex,
            logic,
        } => MicroOp::BitMask {
            dst: dst.clone(),
            src: src.clone(),
            mask: ArchValue::parse_hex(mask_hex, arch)
                .map_err(|_| AssembleError::reject("micro_op_hex"))?,
            logic: match logic {
                mirrors::LogicOp::And => BitLogic::And,
                mirrors::LogicOp::Or => BitLogic::Or,
                mirrors::LogicOp::Xor => BitLogic::Xor,
            },
        },
    })
}

fn convert_interface(
    definition: &InterfaceMirror,
    arch: ArchBits,
) -> Result<InterfaceDef, AssembleError> {
    let effects = definition
        .effects
        .iter()
        .map(|effect| convert_effect(effect, arch))
        .collect::<Result<Vec<_>, AssembleError>>()?;
    Ok(InterfaceDef {
        interface_id: u32::try_from(definition.interface_id)
            .map_err(|_| AssembleError::reject("interface_id"))?,
        display_text: definition.display_text.clone(),
        effects,
    })
}

fn convert_effect(
    effect: &InterfaceEffectMirror,
    arch: ArchBits,
) -> Result<EffectPrimitive, AssembleError> {
    Ok(match effect {
        InterfaceEffectMirror::Exit {} => EffectPrimitive::Exit,
        InterfaceEffectMirror::GrantVirtualFile { file_id } => EffectPrimitive::GrantVirtualFile {
            file_id: file_id.clone(),
        },
        InterfaceEffectMirror::VirtualFileRead { file_id } => EffectPrimitive::VirtualFileRead {
            file_id: file_id.clone(),
        },
        InterfaceEffectMirror::SetFlag {
            flag_register,
            value_hex,
        } => EffectPrimitive::SetFlag {
            flag_register: flag_register.clone(),
            value: ArchValue::parse_hex(value_hex, arch)
                .map_err(|_| AssembleError::reject("micro_op_hex"))?,
        },
        InterfaceEffectMirror::Noop {} => EffectPrimitive::Noop,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// 投影面(D-W8-1)
// ─────────────────────────────────────────────────────────────────────────────

/// 投影策略与静态声明面的 worker 侧装配(D-W8-1):
///
/// - `visibleRegions` = 私有包 `memoryRegions[]` 中 `isHidden = false` 者
///   (声明序),并与公开描述包 `memoryLayout.regions` 的 regionId 集合
///   **互证相等**(公开布局结构性无隐藏表达位,声明漂移即 challenge_invalid);
/// - `visibleRegisters` = 公开 `vmProfile.registers`(组装来源,声明序);
///   已在 `build_registers` 复验:每项 ∈ 初始寄存器集、非 FLAG、非秘密汇;
/// - `visibleObjects` = 私有对象 `visibility = public` 的 objectId(声明序);
/// - `maxBytesPerRange` = 协议默认 256、`errorDetailLevel` = educational
///   (协议未给题目授权面,装配常量;演进走契约变更流程);
/// - 静态标签 = 公开描述包 `publicLabel`(fail-closed:白名单区域缺标签
///   即拒绝);语义高亮 = 可见私有对象的槽位声明(buffer / canary /
///   saved_rbp / return_address 四类),隐藏对象不产生高亮(布局零外泄)。
fn build_projection_face(
    bundle: &PrivateBundleMirror,
    public: &PublicDescriptorExtract,
) -> Result<(ProjectionPolicy, ProjectionStatics), AssembleError> {
    let mut visible_regions = Vec::new();
    for seed in &bundle.initial_state.memory_regions {
        if !seed.is_hidden {
            visible_regions.push(seed.region_id.clone());
        }
    }
    let mut public_region_ids = Vec::with_capacity(public.memory_layout.regions.len());
    for region in &public.memory_layout.regions {
        public_region_ids.push(region.region_id.clone());
    }
    if public_region_ids != visible_regions {
        return Err(AssembleError::reject("public_layout_mismatch"));
    }

    let sinks = SecretSinkSet::new(bundle.secret_sink_registers.clone().unwrap_or_default());
    let policy = ProjectionPolicy::assemble(
        ProjectionPolicySpec {
            visible_regions,
            visible_objects: bundle
                .private_objects
                .iter()
                .filter(|object| object.visibility == mirrors::ObjectVisibility::Public)
                .map(|object| object.object_id.clone())
                .collect(),
            visible_registers: public
                .vm_profile
                .registers
                .iter()
                .map(|declaration| declaration.name.clone())
                .collect(),
            max_bytes_per_range: None,
            error_detail_level: ErrorDetailLevel::Educational,
        },
        &sinks,
    )
    .map_err(|_| AssembleError::reject("policy_assemble"))?;

    let labels = public
        .memory_layout
        .regions
        .iter()
        .map(|region| (region.region_id.clone(), region.public_label.clone()))
        .collect();
    let highlights = bundle
        .private_objects
        .iter()
        .filter(|object| object.visibility == mirrors::ObjectVisibility::Public)
        .filter_map(|object| {
            let kind = match object.kind {
                mirrors::PrivateObjectKind::Buffer => {
                    Some(projection::types::HighlightKind::BufferStart)
                }
                mirrors::PrivateObjectKind::Canary => {
                    Some(projection::types::HighlightKind::CanarySlot)
                }
                mirrors::PrivateObjectKind::SavedRbp => {
                    Some(projection::types::HighlightKind::SavedRbpSlot)
                }
                mirrors::PrivateObjectKind::ReturnAddress => {
                    Some(projection::types::HighlightKind::ReturnAddressSlot)
                }
                _ => None,
            }?;
            let address = ArchValue::parse_hex(&object.address_hex, ArchBits::B64).ok()?;
            let start = address.get();
            // 目标区域 = 地址所属区域(私有包声明序;几何与白名单归属由
            // statics / 生成期复验)。
            let target_region_id = bundle
                .initial_state
                .memory_regions
                .iter()
                .find(|seed| {
                    let seed_start = ArchValue::parse_hex(&seed.start_address_hex, ArchBits::B64)
                        .map(|value| value.get())
                        .unwrap_or(u64::MAX);
                    start >= seed_start && start < seed_start.saturating_add(seed.byte_length)
                })
                .map(|seed| seed.region_id.clone())?;
            Some(HighlightDeclaration {
                kind,
                target_region_id,
                start,
                byte_length: object.byte_length,
                label: object.object_id.clone(),
            })
        })
        .collect();
    let statics = ProjectionStatics::assemble(labels, highlights)
        .map_err(|_| AssembleError::reject("statics_assemble"))?;
    Ok((policy, statics))
}

// ─────────────────────────────────────────────────────────────────────────────
// 十六进制与哈希原语
// ─────────────────────────────────────────────────────────────────────────────

/// 偶长十六进制 → 字节(Schema `^([0-9a-fA-F]{2})+$` 形态域内的复验)。
pub fn decode_hex_bytes(text: &str) -> Option<Vec<u8>> {
    let body = text.strip_prefix("0x").unwrap_or(text);
    if !body.len().is_multiple_of(2) {
        return None;
    }
    let bytes = body
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    Some(bytes)
}

/// 文档规范化哈希(SHA-256,64 hex;对规范化文本计——与摘要清单同源)。
fn canonical_hash(value: &serde_json::Value) -> Result<String, AssembleError> {
    let text =
        serde_json::to_string(value).map_err(|_| AssembleError::reject("hash_serialization"))?;
    let canonical = crate::contract::canonical::canonicalize_json_text(&text)
        .map_err(|_| AssembleError::reject("hash_canonicalization"))?;
    let mut hasher = vm_runtime::sha256::Sha256::new();
    hasher.update(canonical.as_bytes());
    Ok(vm_runtime::sha256::hex(&hasher.finish()))
}

/// `ActionCallMirror` → 引擎记录形态(12 动作;十六进制契约值在此解析,
/// 失败 = 载荷级拒绝而非协议违规)。
pub fn recorded_action(
    action: &ActionCallMirror,
    arch: ArchBits,
) -> Result<vm_runtime::action_log::RecordedAction, AssembleError> {
    use vm_runtime::action_log::RecordedAction;
    let parse = |text: &str| {
        ArchValue::parse_hex(text, arch).map_err(|_| AssembleError::reject("action_hex"))
    };
    Ok(match action {
        ActionCallMirror::WriteBytes {
            address_hex,
            bytes_hex,
        } => RecordedAction::WriteBytes {
            address: parse(address_hex)?.get(),
            data: decode_hex_bytes(bytes_hex).ok_or_else(|| AssembleError::reject("action_hex"))?,
        },
        ActionCallMirror::Push { value_hex } => RecordedAction::Push {
            value: parse(value_hex)?.get(),
        },
        ActionCallMirror::Pop {} => RecordedAction::Pop,
        ActionCallMirror::Call { target_hex } => RecordedAction::Call {
            target: parse(target_hex)?.get(),
        },
        ActionCallMirror::Ret {} => RecordedAction::Ret,
        ActionCallMirror::Step {} => RecordedAction::Step,
        ActionCallMirror::RunToEvent { pause_on } => RecordedAction::RunToEvent {
            pause_on: match pause_on {
                mirrors::PauseEvent::Read => vm_core::exec::PauseOn::Read,
                mirrors::PauseEvent::Write => vm_core::exec::PauseOn::Write,
                mirrors::PauseEvent::Call => vm_core::exec::PauseOn::Call,
                mirrors::PauseEvent::Ret => vm_core::exec::PauseOn::Ret,
                mirrors::PauseEvent::Exception => vm_core::exec::PauseOn::Exception,
            },
        },
        ActionCallMirror::Pause {} => RecordedAction::Pause,
        ActionCallMirror::Undo {} => RecordedAction::Undo,
        ActionCallMirror::CheckoutCheckpoint { checkpoint_id } => {
            RecordedAction::CheckoutCheckpoint {
                checkpoint_id: checkpoint_id.clone(),
            }
        }
        ActionCallMirror::Reset {} => RecordedAction::Reset,
        ActionCallMirror::CreateCheckpoint { label } => RecordedAction::CreateCheckpoint {
            label: label.clone(),
        },
    })
}

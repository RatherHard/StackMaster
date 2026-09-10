//! 调试实例装配与托管(阶段四 WP-41;ADR-DC1 条款 2/3/4/5/8)。
//!
//! # 零装载(条款 2 / 5)
//!
//! [`assemble_variant`] 是调试 worker 的唯一装载入口:输入 = WP-40 冻结的
//! 调试变体镜像(秘密值已由编译器经调试种子派生、直接落区域 `contentHex`)
//! + 公开描述包(位宽 / 页大小 / 编码表 / 区域标签单点来源,D-F10)。
//!
//! **真实私有判题包零装载、判题面不存在(`Judge` 不构造)、seed 不解析**
//! ——调试实例"无可判之物";真实 checkpoint 快照导入路径在本阶段不接入。
//!
//! # 托管面(条款 3 / 4 / 8)
//!
//! [`DebugHost`] 承载调试通道命令:任意地址原始读(权限面不适用——调试器
//! 读自有进程内存,零装载使隐藏区域公开)、单步 / 断点运行(引擎 step 语义,
//! 无判题闸门评估,条款 4)、全内存检索、确定性动作重放(权威动作日志逐条
//! apply,状态对齐不携带秘密)、伪指令流 / 函数表展示数据(源 = 公开代码区
//! 字节,IR 不出进程,D5)。调试侧一切交互只改本实例,不进权威日志。
//!
//! # 程序形态边界
//!
//! 变体镜像契约(WP-40 冻结)不携带程序声明面(IR / 入口),调试实例以
//! **字节模式**装配:程序 = 变体代码区字节 + 公开编码表,入口 = 变体初始
//! RIP(字节模式语义下两者同一)。携带 IR 私有面的变体不在本阶段契约内
//! (WP-42 编译器产出面演进时再议),装载即确定性拒绝。

use projection::display::{derive_function_table, render_instruction_stream};
use projection::policy::{ErrorDetailLevel, ProjectionPolicy, ProjectionPolicySpec, SecretSinkSet};
use projection::project::{GenerationView, ProjectionStatics, full_projection};
use projection::types::PublicStateProjection;
use vm_core::arch::{ArchBits, ArchValue};
use vm_core::exec::{CanarySlotSpec, Engine, EngineConfig, RunOutcome};
use vm_core::instr::Program;
use vm_core::memory::{Permissions, RegionContents, RegionKind, RegionSpec};
use vm_core::state::{
    Budget, CumulativeBudget, RuntimeConstraints, SeedState, SeedStrategy, VmState,
    VmStateConfig, VmStatus,
};
use vm_core::registers::is_flag_name;
use vm_runtime::action_log::RecordedAction;

use crate::contract::mirrors::{DebugVariantBundleMirror, PublicDescriptorExtract};
use crate::protocol::message::{
    DebugFunctionEntryJson, DebugInstructionEntryJson, DebugLoadedSummary, DebugPauseReason,
    DebugSearchHit, DebugStateSummary,
};
use crate::session::assemble::{
    AssembleError, DEFAULT_TIMEOUT_MS_PER_ACTION, GLOBAL_STEPS_LIMIT, OUTPUT_BYTES_LIMIT,
    ROLLBACK_OPS_DEFAULT, decode_hex_bytes, encoding_table as convert_encoding_table,
};

/// mirrors 的区域类型枚举(vm_core 的 `RegionKind` 以别名区分)。
use crate::contract::mirrors::RegionKind as VariantRegionKind;

/// 调试面护栏:run_to_breakpoint 单命令步数硬上限(编排器传入值在此钳制,
/// 防失控长占;引擎自身步数预算是第二道闸)。
pub const DEBUG_RUN_MAX_STEPS_CAP: u64 = 100_000;
/// 调试面护栏:单命令检索命中上限(与协议 `DEBUG_SEARCH_MAX_HITS` 同值)。
pub const DEBUG_SEARCH_MAX_HITS: usize = 256;
/// 调试面护栏:单命令指令流条数上限(与协议 `DEBUG_INSTRUCTION_STREAM_MAX_ITEMS` 同值)。
pub const DEBUG_INSTRUCTION_STREAM_MAX_ITEMS: usize = 256;
/// 调试面护栏:单命令函数表条数上限(与协议 `DEBUG_FUNCTION_TABLE_MAX_ENTRIES` 同值)。
pub const DEBUG_FUNCTION_TABLE_MAX_ENTRIES: usize = 256;
/// 调试面护栏:窗口读取字节上限(与协议 `DEBUG_WINDOW_MAX_BYTES` 同值)。
pub const DEBUG_WINDOW_MAX_BYTES: usize = 4_096;

/// 调试装配产物:引擎 + 全可见投影面(零装载 ⇒ 一切区域 / 寄存器可公开)。
pub struct DebugComponents {
    pub engine: Engine,
    pub policy: ProjectionPolicy,
    pub statics: ProjectionStatics,
    pub summary: DebugLoadedSummary,
}

/// 变体路径拒绝标签(与真实装载同一 `AssembleError` 承载;只进受控日志)。
type VariantResult<T> = Result<T, AssembleError>;

/// 初始寄存器表(名 → 掩蔽域值)+ FLAG 名集 + 初始 IP 的装配三元组。
type VariantRegisters = (Vec<(String, ArchValue)>, Vec<String>, ArchValue);

/// 调试实例装配入口(零装载;见模块文档)。
pub fn assemble_variant(
    variant: &DebugVariantBundleMirror,
    public: &PublicDescriptorExtract,
) -> VariantResult<DebugComponents> {
    // 信封版本锁定(fail-closed;Schema const 已锚,镜像层防御性复验)。
    if variant.schema_version != 1
        || variant.engine_process_protocol_version != crate::protocol::version::ENGINE_PROCESS_PROTOCOL_VERSION
        || variant.derivation.algorithm_id != crate::contract::mirrors::DEBUG_VARIANT_SEED_ALGORITHM_ID
    {
        return Err(AssembleError::reject("variant_envelope"));
    }
    // 身份三元组与公开描述包互证(编排器侧另与会话锁定身份比对)。
    if variant.challenge_id != public.challenge_id
        || variant.challenge_content_version != public.challenge_content_version
        || variant.vm_profile_version != public.vm_profile_version
    {
        return Err(AssembleError::reject("variant_identity_mismatch"));
    }
    let arch = ArchBits::from_bits(public.vm_profile.arch_bits)
        .ok_or_else(|| AssembleError::reject("arch_bits_invalid"))?;
    let page_size = public.vm_profile.page_size_bytes;

    // ── 内存区域(变体 contentHex 即权威初始字节;无种子解析)──
    let (regions, contents) = build_variant_regions(&variant.memory_regions, arch)?;
    let (registers, flag_register_names, initial_ip) = build_variant_registers(
        &variant.registers,
        &public.vm_profile.registers,
        arch,
    )?;

    // ── 约束预算(装配默认;无判题预算来源,predicate_evals 恒 0)──
    let constraints = RuntimeConstraints {
        steps: Budget::new(0, GLOBAL_STEPS_LIMIT),
        memory_bytes_limit: regions.iter().map(|region| region.byte_length).sum(),
        wall_clock_ms_limit: crate::session::assemble::SESSION_WALL_CLOCK_MS_LIMIT,
        call_depth_limit: crate::session::assemble::PROTOCOL_CALL_STACK_MAX_DEPTH as u32,
        action_log: Budget::new(0, crate::session::assemble::ACTION_LOG_LIMIT),
        output_bytes: Budget::new(0, OUTPUT_BYTES_LIMIT),
        timeout_ms_limit: DEFAULT_TIMEOUT_MS_PER_ACTION,
        predicate_evals: CumulativeBudget::new(0, 0),
        rollback_ops: Budget::new(0, ROLLBACK_OPS_DEFAULT),
    };

    // ── seed 状态(变体路径零种子:v1 无应用面,零值占位并登记;真实种子
    //    永不进入调试实例——ADR-DC1 条款 2 / §六 R2)──
    let seed_state = SeedState {
        strategy: SeedStrategy::Fixed,
        version: 0,
        state_bytes: Vec::new(),
    };

    let state_config = VmStateConfig {
        arch,
        // 调试实例恒字节模式(见模块文档"程序形态边界")。
        execution_mode: vm_core::memory::ExecutionMode::ByteCode,
        page_size,
        regions,
        region_contents: contents,
        registers,
        flag_register_names,
        initial_instruction_pointer: initial_ip,
        constraints,
        seed_state,
    };

    // ── 程序(字节模式:公开编码表 + 入口 = 初始 RIP)──
    // 作者扩展面(自定义指令语义 / 作者接口效果)的声明在私有包内,不属
    // 变体契约(零装载 ⇒ 声明面不进调试实例):编码表中引用自定义助记符或
    // 接口操作数的条目在此剔除——这些 token 在调试实例内不可执行 / 不可译码
    // (展示层统一占位文本),命中即确定性停机,与"无可判之物"同一边界
    // (条款 5)。
    let table: Vec<vm_core::instr::EncodingTableEntry> = match &public.vm_profile.encoding_table {
        Some(table) => convert_encoding_table(table)?
            .into_iter()
            .filter(|entry| {
                !matches!(entry.op, vm_core::instr::Op::Custom(_))
                    && !entry
                        .operand_shapes
                        .iter()
                        .any(|shape| matches!(shape, vm_core::instr::EncodingOperandShape::Interface(_)))
            })
            .collect(),
        None => return Err(AssembleError::reject("variant_requires_encoding_table")),
    };
    if table.is_empty() {
        return Err(AssembleError::reject("variant_requires_encoding_table"));
    }
    let program = Program::Byte {
        table,
        entrypoint_address: initial_ip,
    };

    // ── canary 槽位(值已派生落区域 contentHex;引擎装载期从初始内存截取
    //    期望值,与真实 canary 语义同构)──
    let canary_slots = build_variant_canary_slots(&variant.canary_slots, arch)?;

    let engine = Engine::new(EngineConfig {
        state: state_config,
        program,
        custom_instructions: Vec::new(),
        interfaces: Vec::new(),
        canary_slots,
    })
    .map_err(|_| AssembleError::reject("engine_init"))?;

    // ── 全可见投影面(零装载使隐藏区域公开;隐藏区域无公开标签,以
    //    regionId 合成,静态面 fail-closed 由 assemble 复核)──
    let (policy, statics) = build_debug_projection_face(variant, public)?;

    Ok(DebugComponents {
        summary: DebugLoadedSummary {
            challenge_id: variant.challenge_id.clone(),
            challenge_content_version: variant.challenge_content_version.clone(),
            vm_profile_version: variant.vm_profile_version.clone(),
            aslr_enabled: variant.aslr_enabled,
            initial_revision: 0,
        },
        engine,
        policy,
        statics,
    })
}

/// 变体内存区域:几何 / 权限 / 内容(hex → 字节,长度逐字节复核)。
fn build_variant_regions(
    seeds: &[crate::contract::mirrors::DebugVariantRegionMirror],
    arch: ArchBits,
) -> VariantResult<(Vec<RegionSpec>, Vec<RegionContents>)> {
    let mut specs = Vec::with_capacity(seeds.len());
    let mut contents = Vec::with_capacity(seeds.len());
    for seed in seeds {
        let kind = match seed.kind {
            VariantRegionKind::Code => RegionKind::Code,
            VariantRegionKind::Global => RegionKind::Global,
            VariantRegionKind::Stack => RegionKind::Stack,
            VariantRegionKind::Heap => RegionKind::Heap,
            VariantRegionKind::Key => RegionKind::Key,
            VariantRegionKind::Custom => RegionKind::Custom,
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
                // 调试实例无 custom 区域标签义务(公开标签面缺省以 regionId
                // 合成,见投影面装配);引擎侧 custom_label 仅承载展示名。
                None,
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

/// 变体初始寄存器:RIP 抽出为初始 IP,FLAG 名分桶(与真实装载同构);
/// 公开寄存器声明面必须在变体寄存器集内(投影生成面完整性)。
fn build_variant_registers(
    seeds: &[crate::contract::mirrors::DebugVariantRegisterMirror],
    declared_visible: &[crate::contract::mirrors::RegisterDeclarationExtract],
    arch: ArchBits,
) -> VariantResult<VariantRegisters> {
    let mut registers = Vec::with_capacity(seeds.len());
    let mut flags = Vec::new();
    let mut initial_ip = None;
    for seed in seeds {
        let value = ArchValue::parse_hex(&seed.value_hex, arch)
            .map_err(|_| AssembleError::reject("register_hex"))?;
        if seed.name == "RIP" && initial_ip.is_none() {
            initial_ip = Some(value);
        }
        if is_flag_name(&seed.name) {
            flags.push(seed.name.clone());
        }
        registers.push((seed.name.clone(), value));
    }
    let initial_ip = initial_ip.ok_or_else(|| AssembleError::reject("rip_missing"))?;
    for declaration in declared_visible {
        if !seeds.iter().any(|seed| seed.name == declaration.name) {
            return Err(AssembleError::reject("public_register_undeclared"));
        }
    }
    Ok((registers, flags, initial_ip))
}

/// canary 槽位:变体槽对象 → 引擎槽规约(期望值装载期从初始内存截取;
/// 可见性不设真实实例的"必须可见"约束——调试实例全可见由零装载保证)。
fn build_variant_canary_slots(
    slots: &Option<Vec<crate::contract::mirrors::DebugVariantCanarySlotMirror>>,
    arch: ArchBits,
) -> VariantResult<Vec<CanarySlotSpec>> {
    let mut specs = Vec::new();
    for slot in slots.iter().flatten() {
        if slot.byte_length < 1 || slot.byte_length > 8 {
            return Err(AssembleError::reject("canary_size"));
        }
        let address = ArchValue::parse_hex(&slot.address_hex, arch)
            .map_err(|_| AssembleError::reject("canary_address_hex"))?;
        specs.push(CanarySlotSpec {
            address: address.get(),
            byte_length: slot.byte_length as usize,
        });
    }
    Ok(specs)
}

/// 调试实例投影面:全区域白名单(含隐藏)+ 全非 FLAG 寄存器 + 公开标签
/// (隐藏区域无公开标签,以 regionId 合成——零装载下 regionId 本身公开)。
fn build_debug_projection_face(
    variant: &DebugVariantBundleMirror,
    public: &PublicDescriptorExtract,
) -> VariantResult<(ProjectionPolicy, ProjectionStatics)> {
    let label_of = |region_id: &str| -> Option<String> {
        public
            .memory_layout
            .regions
            .iter()
            .find(|region| region.region_id == region_id)
            .map(|region| region.public_label.clone())
    };
    let visible_regions: Vec<String> = variant
        .memory_regions
        .iter()
        .map(|seed| seed.region_id.clone())
        .collect();
    let sinks = SecretSinkSet::new(Vec::new());
    let policy = ProjectionPolicy::assemble(
        ProjectionPolicySpec {
            visible_regions: visible_regions.clone(),
            // 对象面在变体契约中不存在(无可见性过滤义务);空集 = 全公开。
            visible_objects: Vec::new(),
            visible_registers: variant
                .registers
                .iter()
                .filter(|seed| !is_flag_name(&seed.name))
                .map(|seed| seed.name.clone())
                .collect(),
            max_bytes_per_range: None,
            error_detail_level: ErrorDetailLevel::Educational,
        },
        &sinks,
    )
    .map_err(|_| AssembleError::reject("policy_assemble"))?;

    let mut labels = Vec::new();
    for region_id in &visible_regions {
        let label = label_of(region_id).unwrap_or_else(|| region_id.clone());
        labels.push((region_id.clone(), label));
    }
    // 静态声明面:语义高亮在变体契约中不存在(对象面缺席),空集。
    let statics = ProjectionStatics::assemble(labels, Vec::new())
        .map_err(|_| AssembleError::reject("statics_assemble"))?;
    Ok((policy, statics))
}

// ─────────────────────────────────────────────────────────────────────────────
// 调试实例托管
// ─────────────────────────────────────────────────────────────────────────────

/// 重放一条已接受动作的结果(调试实例只区分"已执行"与"未执行"两态;
/// 未执行 = 与权威日志错位,方向 `internal_error`,编排器据此中止 attach)。
pub enum DebugApplyOutcome {
    Applied,
    Misaligned,
}

/// 调试实例托管:引擎 + 全可见投影面 + 自有 revision 账本 + undo 历史栈。
///
/// revision 语义与真实实例平行:每条已接受动作 +1(重放对齐锚);
/// undo 历史栈以 `VmState` 克隆承载(调试面自账本,与真实实例 COW 快照
/// 账本互不相通)。
pub struct DebugHost {
    engine: Engine,
    policy: ProjectionPolicy,
    statics: ProjectionStatics,
    revision: u64,
    history: Vec<(VmState, bool)>,
}

impl DebugHost {
    /// 自装配产物构建。
    pub fn new(components: DebugComponents) -> Self {
        Self {
            engine: components.engine,
            policy: components.policy,
            statics: components.statics,
            revision: components.summary.initial_revision,
            history: Vec::new(),
        }
    }

    /// 装载回执摘要(装配期快照)。
    pub fn summary_of(components: &DebugComponents) -> DebugLoadedSummary {
        DebugLoadedSummary {
            challenge_id: components.summary.challenge_id.clone(),
            challenge_content_version: components.summary.challenge_content_version.clone(),
            vm_profile_version: components.summary.vm_profile_version.clone(),
            aslr_enabled: components.summary.aslr_enabled,
            initial_revision: components.summary.initial_revision,
        }
    }

    /// 当前 revision(重放进度锚点)。
    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// 当前状态(冻结 PublicStatus 四值字符串;won 不可达——判题面未装载)。
    pub fn status(&self) -> &'static str {
        match self.engine.state.status {
            VmStatus::Running => "running",
            VmStatus::Paused => "paused",
            VmStatus::Won => "won",
            VmStatus::Failed => "failed",
        }
    }

    /// 当前指令地址(hex;字节模式 = 代码区字节地址)。
    pub fn rip_hex(&self) -> String {
        format_hex(self.engine.state.instruction_pointer.get())
    }

    /// 程序是否已停机(exit)。
    pub fn halted(&self) -> bool {
        self.engine.is_halted()
    }

    /// 状态摘要(debug_query_state / 重放回执共用)。
    pub fn state_summary(&self) -> DebugStateSummary {
        DebugStateSummary {
            revision: self.revision,
            status: String::from(self.status()),
            rip_hex: self.rip_hex(),
            halted: self.halted(),
        }
    }

    /// 完整公开投影(全可见策略;与真实实例同一投影生成管线,ADR-7 同域)。
    pub fn projection(&self) -> Result<PublicStateProjection, projection::ProjectionError> {
        let view = GenerationView {
            policy: &self.policy,
            statics: &self.statics,
            program: self.engine.program(),
            customs: self.engine.custom_instructions(),
            pause_reason: None,
        };
        full_projection(self.revision, &view, &self.engine.state)
    }

    /// 任意地址原始窗口读取(零装载使隐藏区域公开;不走权限检查——调试器
    /// 读自有进程内存)。窗口跨区域边界时按边界截断并返回 `truncated = true`;
    /// 起点未映射返回 `None`(方向 `inaccessible_address`)。
    pub fn read_window(&self, address: u64, byte_length: usize) -> Option<(Vec<u8>, bool)> {
        if byte_length == 0 {
            return Some((Vec::new(), false));
        }
        let region = self.engine.state.memory.region_at(address)?;
        let region_end = region.start.saturating_add(region.byte_length);
        let last = address.checked_add(byte_length as u64 - 1)?;
        let truncated = last >= region_end;
        let take_end = last.min(region_end - 1);
        let take = (take_end - address + 1) as usize;
        let mut bytes = Vec::with_capacity(take);
        for offset in 0..take {
            bytes.push(self.raw_byte(address + offset as u64)?);
        }
        Some((bytes, truncated))
    }

    /// 原始单字节读(页存储直读;不走权限检查)。
    fn raw_byte(&self, address: u64) -> Option<u8> {
        let page_size = self.engine.state.memory.page_size();
        self.engine
            .state
            .memory
            .page_bytes(address / page_size)
            .map(|page| page[(address % page_size) as usize])
    }

    /// 重放一条已接受动作(确定性重放对齐;无判题闸门评估——动作日志中的
    /// 已接受动作在真实实例已过闸,重放侧不重复评估,条款 4)。
    pub fn apply_recorded(
        &mut self,
        action: &RecordedAction,
    ) -> DebugApplyOutcome {
        // 执行类动作先压历史栈(undo 支撑;管理类不压——与真实实例
        // "管理动作不入回退链"的历史语义同形)。栈深以动作日志护栏为上限。
        if is_execution_action(action) {
            if self.history.len() >= crate::session::assemble::ACTION_LOG_LIMIT as usize {
                self.history.remove(0);
            }
            self.history
                .push((self.engine.state.clone(), self.engine.is_halted()));
        }
        let outcome = match action {
            RecordedAction::WriteBytes { address, data } => self
                .engine
                .action_write_bytes(ArchValue::new(*address, self.engine.arch()), data)
                .is_ok(),
            RecordedAction::Push { value } => {
                self.engine.action_push(ArchValue::new(*value, self.engine.arch())).is_ok()
            }
            RecordedAction::Pop => self.engine.action_pop().is_ok(),
            RecordedAction::Call { target } => self
                .engine
                .action_call(ArchValue::new(*target, self.engine.arch()))
                .is_ok(),
            RecordedAction::Ret => self.engine.action_ret().is_ok(),
            RecordedAction::Step => matches!(self.engine.step(), RunOutcome::Stepped),
            RecordedAction::RunToEvent { pause_on } => {
                // run_to_event 的暂停落点即事件类别;教学性失败(异常)在真实
                // 实例为"已执行"(入日志),此处同样视为已执行。
                matches!(
                    self.engine.run_to_event(*pause_on),
                    RunOutcome::Paused { .. } | RunOutcome::Stepped | RunOutcome::Exited { .. }
                )
            }
            RecordedAction::Pause => {
                self.engine.pause();
                true
            }
            RecordedAction::Undo => match self.history.pop() {
                Some((state, halted)) => {
                    self.engine.restore_session(state, halted);
                    true
                }
                None => false,
            },
            // checkpoint 检出在调试实例无账本(未装载),重放视为错位。
            RecordedAction::CheckoutCheckpoint { .. } => false,
            RecordedAction::Reset => {
                self.engine.reset();
                self.history.clear();
                true
            }
            // create_checkpoint 不改 VM 状态(真实实例语义:仅登记恢复点),
            // 重放侧无操作 + revision 推进,与真实实例对齐。
            RecordedAction::CreateCheckpoint { .. } => true,
        };
        if outcome {
            self.revision += 1;
            DebugApplyOutcome::Applied
        } else {
            DebugApplyOutcome::Misaligned
        }
    }

    /// 单步(恰一条指令;返回暂停原因与落点地址)。
    pub fn debug_step(&mut self) -> (DebugPauseReason, String) {
        let reason = match self.engine.step() {
            RunOutcome::Stepped => DebugPauseReason::Step,
            RunOutcome::Exited { .. } | RunOutcome::Failed { .. } | RunOutcome::Halted => {
                DebugPauseReason::ProgramHalt
            }
            RunOutcome::Paused { .. } => DebugPauseReason::Step,
        };
        (reason, self.rip_hex())
    }

    /// 运行至命中任一断点(带步数上限,超限 = 预算暂停;返回暂停原因 /
    /// 落点地址 / 实际步数)。起点即断点视为命中(0 步)。
    pub fn run_to_breakpoint(
        &mut self,
        breakpoints: &[u64],
        max_steps: u64,
    ) -> (DebugPauseReason, String, u64) {
        let max_steps = max_steps.clamp(1, DEBUG_RUN_MAX_STEPS_CAP);
        let mut steps: u64 = 0;
        loop {
            let rip = self.engine.state.instruction_pointer.get();
            if breakpoints.contains(&rip) {
                return (DebugPauseReason::Breakpoint, self.rip_hex(), steps);
            }
            if self.halted() || self.engine.state.status.is_terminal() {
                return (DebugPauseReason::ProgramHalt, self.rip_hex(), steps);
            }
            if steps >= max_steps {
                return (DebugPauseReason::Budget, self.rip_hex(), steps);
            }
            let outcome = self.engine.step();
            steps += 1;
            match outcome {
                RunOutcome::Stepped => continue,
                RunOutcome::Exited { .. } | RunOutcome::Failed { .. } | RunOutcome::Halted => {
                    return (DebugPauseReason::ProgramHalt, self.rip_hex(), steps);
                }
                RunOutcome::Paused { .. } => continue,
            }
        }
    }

    /// 全变体内存检索(原始存储扫描;命中按地址升序,字节回显 = 模式等长,
    /// 生成端义务)。返回 `(命中, truncated)`。
    pub fn search(&self, pattern: &[u8], max_hits: usize) -> (Vec<DebugSearchHit>, bool) {
        let max_hits = max_hits.clamp(1, DEBUG_SEARCH_MAX_HITS);
        let mut hits = Vec::new();
        for region in self.engine.state.memory.regions() {
            let region_start = region.start;
            let mut offset = 0u64;
            while offset + pattern.len() as u64 <= region.byte_length {
                let address = region_start + offset;
                let matched = pattern.iter().enumerate().all(|(index, expected)| {
                    self.raw_byte(address + index as u64).is_some_and(|byte| byte == *expected)
                });
                if matched {
                    if hits.len() >= max_hits {
                        return (hits, true);
                    }
                    hits.push(DebugSearchHit {
                        address_hex: format_hex(address),
                        bytes_hex: hex_lower(pattern),
                    });
                }
                offset += 1;
            }
        }
        (hits, false)
    }

    /// 伪指令流展示数据(源 = 公开代码区字节;IR 不出进程,D5)。
    pub fn instruction_stream(
        &self,
        start: u64,
        max_items: usize,
    ) -> (Vec<DebugInstructionEntryJson>, bool) {
        let max_items = max_items.clamp(1, DEBUG_INSTRUCTION_STREAM_MAX_ITEMS);
        let (entries, truncated) = render_instruction_stream(
            self.engine.program(),
            self.engine.custom_instructions(),
            &self.engine.state.memory,
            start,
            max_items,
        );
        (
            entries
                .into_iter()
                .map(|entry| DebugInstructionEntryJson {
                    address_hex: format_hex(entry.address),
                    bytes_hex: (!entry.bytes.is_empty()).then(|| hex_lower(&entry.bytes)),
                    text: entry.text,
                    jump_target_hex: entry.jump_target.map(format_hex),
                })
                .collect(),
            truncated,
        )
    }

    /// 函数表展示数据(源 = 已装载程序结构,label / 起址 / 长度三字段)。
    pub fn function_table(&self, max_entries: usize) -> (Vec<DebugFunctionEntryJson>, bool) {
        let max_entries = max_entries.clamp(1, DEBUG_FUNCTION_TABLE_MAX_ENTRIES);
        let (functions, truncated) =
            derive_function_table(self.engine.program(), &self.engine.state.memory, max_entries);
        (
            functions
                .into_iter()
                .map(|entry| DebugFunctionEntryJson {
                    label: entry.label,
                    start_address_hex: format_hex(entry.start_address),
                    byte_length: entry.byte_length,
                })
                .collect(),
            truncated,
        )
    }

    /// 投影策略引用(测试锚点)。
    pub fn policy(&self) -> &ProjectionPolicy {
        &self.policy
    }

    /// 权威状态只读引用(测试锚点)。
    pub fn state(&self) -> &VmState {
        &self.engine.state
    }
}

/// 执行类动作判定(历史栈压栈判据;管理四动作不入栈)。
fn is_execution_action(action: &RecordedAction) -> bool {
    matches!(
        action,
        RecordedAction::WriteBytes { .. }
            | RecordedAction::Push { .. }
            | RecordedAction::Pop
            | RecordedAction::Call { .. }
            | RecordedAction::Ret
            | RecordedAction::Step
            | RecordedAction::RunToEvent { .. }
            | RecordedAction::Pause
    )
}

/// 地址 hex(`0x` 前缀 + 小写;AddressHex 契约形态,1–16 位数字)。
pub fn format_hex(value: u64) -> String {
    format!("0x{value:x}")
}

/// 字节 → 小写 hex(偶长,无前缀)。
pub fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit(u32::from(byte >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(byte & 0xF), 16).unwrap_or('0'));
    }
    out
}

/// 解析地址 hex(`0x` 前缀可选;越界 / 非法 = 载荷级拒绝)。
pub fn parse_address_hex(text: &str) -> Option<u64> {
    let body = text.strip_prefix("0x").unwrap_or(text);
    if body.is_empty() || body.len() > 16 || !body.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    u64::from_str_radix(body, 16).ok()
}

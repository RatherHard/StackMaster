//! 投影生成:完整投影、增量与控制流展示(WP-1 §4.1 / §4.3、D2 / D3 / D5)。
//!
//! # 生成面三入口(全部是确定性纯函数,I-4)
//!
//! | 入口 | 语义 |
//! |---|---|
//! | [`full_projection`] | `PublicStateProjection` 全量形态(会话创建 / `sync-projection` 重同步取数) |
//! | [`delta_projection`] | `ProjectionDelta` 增量(可选字段存在性 = 可观察变化,I-4) |
//! | [`render_control_flow`] | `currentInstruction` 展示文本(D5:服务端从展示数据生成,非可执行 IR) |
//!
//! # 字节面纪律(D3)
//!
//! - 区域窗口锚定区域起点,生效上限 = `min(byteLength, maxBytesPerRange)`,
//!   截断以常态布尔 `truncated` 表达(完整展示也是显式教学事实);
//! - 脏范围 = 本动作可见写入列表经合并规则(同区域相邻 / 重叠归并为极大
//!   连续区间)的确定性函数;越出可见覆盖的写入段被**裁剪**(相邻隐藏区域
//!   与未映射空洞同形态,I-9),永不产生跨界 range;
//! - 单增量字节总预算 8192:按地址升序承载至预算耗尽,任何不完整承载
//!   (预算 / 单 range 上限 / 条数上限)以 presence-only `truncated` 打在
//!   最后一个已承载 range 上(D-P6;不含省略字节数,客户端以
//!   `sync-projection` 重新对齐);
//! - 脏范围与写事件载荷的字节来源 = **动作后权威内存读回**(存储面,D-P2):
//!   同源保证 `payloadHex` 与 `bytesHex` 描述同一权威内容。

use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

use vm_core::arch::{ArchBits, ArchValue};
use vm_core::decode::{EncodingIndex, decode_slice};
use vm_core::instr::{CustomInstructionDef, Op, Operand, Program};
use vm_core::memory::VirtualMemory;
use vm_core::state::{VmEvent, VmEventKind, VmState, VmStatus};

use crate::error::RejectionReason;
use crate::events::read_storage_bytes;
use crate::policy::ProjectionPolicy;
use crate::types::{
    ControlFlow, CurrentInstruction, DirtyRange, HighlightKind, ProjectionDelta, PublicCallFrame,
    PublicRegister, PublicStateProjection, PublicStatus, SemanticHighlight, VisibleMemoryRegion,
};
use crate::{ProjectionError, policy::WriteTargetClass};

/// 单 revision 投影字节总预算(D3 冻结:8192)。
pub const MAX_PROJECTION_BYTES_PER_REVISION: u64 = 8192;
/// 单增量 dirtyRanges 数组上限(协议护栏)。
pub const MAX_DIRTY_RANGES_PER_DELTA: usize = 256;
/// 调用栈摘要深度上限(D1 / D2 冻结:64;截断以 presence-only 标记表达)。
pub const CALL_STACK_MAX_DEPTH: usize = 64;
/// 语义高亮数护栏(契约 `MAX_SEMANTIC_HIGHLIGHTS`)。
pub const MAX_SEMANTIC_HIGHLIGHTS: usize = 32;
/// 不可译码指令的统一占位文本(D5:地址照显——玩家自供 / 公开布局;
/// 文本为静态模板,不携带译码细节)。
pub const UNDECODABLE_TEXT: &str = "<undecodable>";

// ─────────────────────────────────────────────────────────────────────────────
// 静态声明面(公开描述包符号表 + 初始投影高亮;装载侧组装)
// ─────────────────────────────────────────────────────────────────────────────

/// 语义高亮声明(公开描述包 `initialProjection.semanticHighlights` 形态)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HighlightDeclaration {
    /// 类别。
    pub kind: HighlightKind,
    /// 目标区域标识(必须可见,I-2:生成期 fail-closed)。
    pub target_region_id: String,
    /// 起始地址。
    pub start: u64,
    /// 跨度字节数。
    pub byte_length: u64,
    /// 展示标签(公开布局常量 / 静态模板,I-10)。
    pub label: String,
}

/// 投影静态声明面:区域公开标签与语义高亮(会话内恒定——策略随题目版本
/// 锁定,投影形态可复现;投影与错误契约语义 §5.1)。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProjectionStatics {
    region_labels: BTreeMap<String, String>,
    highlights: Vec<HighlightDeclaration>,
}

impl ProjectionStatics {
    /// 装配并校验(标签形态 / 唯一性 / 高亮护栏;fail-closed)。
    pub fn assemble(
        region_labels: Vec<(String, String)>,
        highlights: Vec<HighlightDeclaration>,
    ) -> Result<Self, ProjectionError> {
        if region_labels.len() > crate::policy::MAX_VISIBLE_REGIONS {
            return Err(ProjectionError::ChallengeInvalid(
                "statics_region_labels_too_many",
            ));
        }
        if highlights.len() > MAX_SEMANTIC_HIGHLIGHTS {
            return Err(ProjectionError::ChallengeInvalid(
                "statics_highlights_too_many",
            ));
        }
        let mut map = BTreeMap::new();
        for (region_id, label) in region_labels {
            if !valid_identifier(&region_id) {
                return Err(ProjectionError::ChallengeInvalid(
                    "statics_region_id_malformed",
                ));
            }
            if !valid_public_text(&label) {
                return Err(ProjectionError::ChallengeInvalid("statics_label_malformed"));
            }
            if map.insert(region_id.clone(), label).is_some() {
                return Err(ProjectionError::ChallengeInvalid(
                    "statics_region_label_duplicate",
                ));
            }
        }
        for highlight in &highlights {
            if !valid_identifier(&highlight.target_region_id)
                || !valid_public_text(&highlight.label)
                || highlight.byte_length == 0
            {
                return Err(ProjectionError::ChallengeInvalid(
                    "statics_highlight_malformed",
                ));
            }
        }
        Ok(Self {
            region_labels: map,
            highlights,
        })
    }

    /// 区域公开标签(缺失 = 声明面不完整,生成期拒绝)。
    pub fn label(&self, region_id: &str) -> Option<&str> {
        self.region_labels.get(region_id).map(String::as_str)
    }

    /// 语义高亮声明(生成期逐条复核可见性与几何)。
    pub fn highlights(&self) -> &[HighlightDeclaration] {
        &self.highlights
    }
}

fn valid_identifier(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 128
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// 公开展示文本形态(非空、≤ 128、无 C0/C1 控制字符;public-text 同则)。
fn valid_public_text(text: &str) -> bool {
    !text.is_empty()
        && text.chars().count() <= 128
        && !text
            .chars()
            .any(|c| matches!(c, '\u{0000}'..='\u{001F}' | '\u{007F}'..='\u{009F}'))
}

// ─────────────────────────────────────────────────────────────────────────────
// 生成视图
// ─────────────────────────────────────────────────────────────────────────────

/// 生成视图:策略 + 静态声明面 + 程序展示数据 + 暂停原因(会话内逐动作复用)。
pub struct GenerationView<'a> {
    /// 投影白名单策略。
    pub policy: &'a ProjectionPolicy,
    /// 静态声明面。
    pub statics: &'a ProjectionStatics,
    /// 程序(控制流展示的译码来源;与执行共用同一层 1 表示,D5)。
    pub program: &'a Program,
    /// 自定义指令声明面(displayText 展示来源;编译期已过 E-4/E-6 扫描)。
    pub customs: &'a BTreeMap<String, CustomInstructionDef>,
    /// 当前暂停原因(仅 `status = paused` 时进入投影;其余状态恒 null,D5)。
    pub pause_reason: Option<crate::types::PauseKind>,
}

/// 权威状态公开形态(D1:running / paused / won / failed 一一映射;
/// won / failed 是 WP-5 检查点判定的公开时点,本映射零增益——
/// 不泄露任何隐藏条件信息)。
pub fn project_status(status: VmStatus) -> PublicStatus {
    match status {
        VmStatus::Running => PublicStatus::Running,
        VmStatus::Paused => PublicStatus::Paused,
        VmStatus::Won => PublicStatus::Won,
        VmStatus::Failed => PublicStatus::Failed,
    }
}

/// 完整投影生成(§4.1 七字段;会话创建与 `sync-projection` 的取数形态)。
pub fn full_projection(
    revision: u64,
    view: &GenerationView<'_>,
    state: &VmState,
) -> Result<PublicStateProjection, ProjectionError> {
    let memory = &state.memory;
    let policy = view.policy;

    // visibleRegions:白名单序 = 输出序(公开布局序);引用 / 标签完整性
    // fail-closed(白名单引用不存在的区域 = 装配矛盾,challenge_invalid)。
    let mut visible_regions = Vec::new();
    for region_id in policy.visible_regions() {
        let region = memory
            .region_by_id(region_id)
            .ok_or(ProjectionError::ChallengeInvalid("visible_region_unknown"))?;
        let label = view
            .statics
            .label(region_id)
            .ok_or(ProjectionError::ChallengeInvalid(
                "visible_region_unlabeled",
            ))?;
        let window = policy.window_bytes(region.byte_length);
        let bytes = read_storage_bytes(memory, region.start, window)
            .ok_or(ProjectionError::ChallengeInvalid("visible_region_unbacked"))?;
        visible_regions.push(VisibleMemoryRegion {
            region_id: String::from(region_id),
            label: String::from(label),
            start: region.start,
            byte_length: region.byte_length,
            permissions: String::from(region.permissions.as_str()),
            bytes,
            truncated: window < region.byte_length,
        });
    }

    // visibleRegisters:白名单寄存器当前值;白名单引用未声明寄存器即拒绝。
    let mut visible_registers = Vec::new();
    for name in policy.visible_registers() {
        let value = state
            .registers
            .get(name)
            .ok_or(ProjectionError::ChallengeInvalid(
                "visible_register_unknown",
            ))?;
        visible_registers.push(PublicRegister {
            name: String::from(name),
            value,
        });
    }

    let call_stack_summary = call_stack_summary(state);
    let control_flow = render_control_flow(view, state);
    let semantic_highlights = semantic_highlights(view, memory)?;
    let status = project_status(state.status);

    Ok(PublicStateProjection {
        revision,
        visible_regions,
        visible_registers,
        call_stack_summary,
        control_flow,
        semantic_highlights,
        status,
    })
}

/// 增量投影生成(§4.3;可选字段存在性 = 前后可见面比较,I-4)。
///
/// `before` 是上一份完整投影(同策略、同静态声明面生成);`new_private_events`
/// 是本动作新增的私有事件段(脏范围与公开事件的来源)。
pub fn delta_projection(
    revision: u64,
    view: &GenerationView<'_>,
    before: &PublicStateProjection,
    state: &VmState,
    new_private_events: &[VmEvent],
) -> Result<ProjectionDelta, ProjectionError> {
    let dirty_ranges = merge_dirty_ranges(view.policy, &state.memory, new_private_events)?;

    // changedRegisters:白名单序比对(前后同策略 ⇒ 同序 zip 安全;
    // 长度不齐 = 生成缺陷,防御性拒绝)。
    let mut changed_registers = Vec::new();
    for name in view.policy.visible_registers() {
        let value = state
            .registers
            .get(name)
            .ok_or(ProjectionError::ChallengeInvalid(
                "visible_register_unknown",
            ))?;
        let unchanged = before
            .visible_registers
            .iter()
            .find(|register| register.name == *name)
            .is_some_and(|register| register.value == value);
        if !unchanged {
            changed_registers.push(PublicRegister {
                name: String::from(name),
                value,
            });
        }
    }

    let control_flow_now = render_control_flow(view, state);
    let control_flow = (control_flow_now != before.control_flow).then_some(control_flow_now);

    let status_now = project_status(state.status);
    let status = crate::types::PublicStatus::delta_field(before.status, status_now);

    let call_stack_now = call_stack_summary(state);
    let call_stack_summary =
        (call_stack_now != before.call_stack_summary).then_some(call_stack_now);

    // semanticHighlights:静态声明面,运行期恒不变化(存在性规则退化:
    // 增量永不携带)。
    Ok(ProjectionDelta {
        revision,
        dirty_ranges,
        changed_registers,
        control_flow,
        status,
        call_stack_summary,
        semantic_highlights: None,
    })
}

/// 执行前拒绝的增量面:契约恒 null(§4.4 耦合)——本函数是其语义注记,
/// 拒绝响应由 [`crate::response`] 装配,不产生 delta。
pub fn rejected_has_no_delta(reason: &RejectionReason) -> bool {
    let _ = reason;
    true
}

// ─────────────────────────────────────────────────────────────────────────────
// 调用栈摘要(D2)
// ─────────────────────────────────────────────────────────────────────────────

/// 调用栈摘要:内容裁剪为 `{index, functionLabel, returnAddressHex}`;
/// index 0 = 最内帧;保留**最内** 64 帧,深度超限时在展示的最后一帧
/// (index 63)打 presence-only `truncated` 标记(D-P3:不含省略帧数)。
pub fn call_stack_summary(state: &VmState) -> Vec<PublicCallFrame> {
    let frames = &state.call_frames;
    let total = frames.len();
    // 引擎 call_frames 栈顶(push)= 最内帧;公开 index 0 = 最内帧 ⇒ 逆序。
    let start = total.saturating_sub(CALL_STACK_MAX_DEPTH);
    let mut out = Vec::with_capacity(total - start);
    for (public_index, frame) in frames[start..].iter().rev().enumerate() {
        let truncated = total > CALL_STACK_MAX_DEPTH && public_index == CALL_STACK_MAX_DEPTH - 1;
        out.push(PublicCallFrame {
            index: public_index as u32,
            function_label: frame.function_label.clone(),
            return_address: frame.return_address.get(),
            truncated,
        });
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// 控制流展示(D5)
// ─────────────────────────────────────────────────────────────────────────────

/// 控制流公开形态:当前指令展示(与执行共用层 1 表示的译码路径)+
/// 暂停原因(仅 paused 状态携带)。
pub fn render_control_flow(view: &GenerationView<'_>, state: &VmState) -> ControlFlow {
    let address = state.instruction_pointer.get();
    let text = render_instruction_text(view, &state.memory, address);
    ControlFlow {
        current_instruction: CurrentInstruction { address, text },
        paused_on: (state.status == VmStatus::Paused)
            .then_some(view.pause_reason)
            .flatten(),
    }
}

/// 伪指令展示文本:IR 模式按指令索引直取,字节模式按 RIP 取指译码
/// (与执行同一译码语义,D5"从展示数据单独生成"——文本不是可执行 IR)。
/// 译码不可达(索引出界 / 截断 / 未知 token)→ 统一占位文本。
fn render_instruction_text(
    view: &GenerationView<'_>,
    memory: &VirtualMemory,
    address: u64,
) -> String {
    match view.program {
        Program::Ir { instructions, .. } => {
            let index = usize::try_from(address).ok();
            match index.and_then(|index| instructions.get(index)) {
                Some(instruction) => render_instruction(instruction, view.customs, memory.arch()),
                None => String::from(UNDECODABLE_TEXT),
            }
        }
        Program::Byte { table, .. } => {
            // 取指窗口:单指令 ≤ 1 token + 4×(archBits/8) 内联字节;取 65 字节
            // 余量并按区域尾截断(存储面读回,代码区只读展示)。
            let window = read_storage_bytes(memory, address, 65)
                .ok_or(())
                .and_then(|bytes| {
                    let index = EncodingIndex::new(table);
                    decode_slice(&index, memory.arch(), &bytes, 0)
                        .map(|(instruction, _)| instruction)
                        .map_err(|_| ())
                });
            match window {
                Ok(instruction) => render_instruction(&instruction, view.customs, memory.arch()),
                Err(()) => String::from(UNDECODABLE_TEXT),
            }
        }
    }
}

/// 层 1 指令 → 展示文本:`助记符 操作数, 操作数`;自定义指令使用
/// displayText(静态模板类)。`pub(crate)`:调试通道展示数据生成
/// ([`crate::display`])复用同一译码语义(D5 单点)。
pub(crate) fn render_instruction(
    instruction: &vm_core::instr::Instruction,
    customs: &alloc::collections::BTreeMap<String, vm_core::instr::CustomInstructionDef>,
    arch: ArchBits,
) -> String {
    let mut text = String::new();
    match &instruction.op {
        Op::Baseline(op) => text.push_str(op.mnemonic()),
        Op::Custom(name) => {
            // displayText 优先(层 3 展示面);未声明(理论不可达,装载镜像
            // 已拒)退回助记符本身。
            match customs.get(name) {
                Some(def) => text.push_str(&def.display_text),
                None => text.push_str(name),
            }
        }
    }
    for operand in &instruction.operands {
        text.push(' ');
        render_operand(operand, arch, &mut text);
        text.push(',');
    }
    if text.ends_with(',') {
        text.pop();
    }
    text
}

fn render_operand(operand: &Operand, arch: ArchBits, out: &mut String) {
    match operand {
        Operand::Register(name) => out.push_str(name),
        Operand::Immediate(value) => out.push_str(&value.format_hex()),
        Operand::Memory { base, displacement } => {
            out.push('[');
            if let Some(base) = base {
                out.push_str(base);
            }
            let signed = signed_displacement(displacement.get(), arch);
            if signed != 0 {
                if signed > 0 {
                    out.push_str("+0x");
                    push_hex_upper(signed as u64, out);
                } else {
                    out.push_str("-0x");
                    push_hex_upper(signed.unsigned_abs() as u64, out);
                }
            }
            out.push(']');
        }
        Operand::Interface(interface_id) => {
            out.push_str(&crate::types::format_address(u64::from(*interface_id)));
        }
    }
}

/// 位移的补码解释(按位宽;展示面数值化)。
fn signed_displacement(raw: u64, arch: ArchBits) -> i128 {
    let bits = arch.bits();
    let half = 1u128 << (bits - 1);
    let full = 1u128 << bits;
    let raw = raw as u128;
    if raw >= half {
        raw as i128 - full as i128
    } else {
        raw as i128
    }
}

/// 大写十六进制数字写出(无前缀;`format_hex` 数字域同源)。
fn push_hex_upper(mut value: u64, out: &mut String) {
    if value == 0 {
        out.push('0');
        return;
    }
    let mut digits = [0u8; 16];
    let mut len = 0;
    while value > 0 {
        digits[len] = b"0123456789ABCDEF"[(value & 0xF) as usize];
        len += 1;
        value >>= 4;
    }
    while len > 0 {
        len -= 1;
        out.push(digits[len] as char);
    }
}

/// 语义高亮生成(逐条复核:目标可见 + 几何落域;fail-closed,I-2)。
fn semantic_highlights(
    view: &GenerationView<'_>,
    memory: &VirtualMemory,
) -> Result<Vec<SemanticHighlight>, ProjectionError> {
    let mut out = Vec::new();
    for declaration in view.statics.highlights() {
        let region = memory.region_by_id(&declaration.target_region_id).ok_or(
            ProjectionError::ChallengeInvalid("highlight_target_unknown"),
        )?;
        if !view.policy.is_region_visible(&region.region_id) {
            return Err(ProjectionError::ChallengeInvalid(
                "highlight_target_invisible",
            ));
        }
        let end = declaration
            .start
            .checked_add(declaration.byte_length)
            .ok_or(ProjectionError::ChallengeInvalid(
                "highlight_geometry_overflow",
            ))?;
        if declaration.start < region.start || end > region.last_address + 1 {
            return Err(ProjectionError::ChallengeInvalid(
                "highlight_geometry_out_of_region",
            ));
        }
        out.push(SemanticHighlight {
            kind: declaration.kind,
            target_region_id: declaration.target_region_id.clone(),
            start: declaration.start,
            byte_length: declaration.byte_length,
            label: declaration.label.clone(),
        });
    }
    Ok(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// 脏范围合并(D3 / §4.3)
// ─────────────────────────────────────────────────────────────────────────────

/// 脏范围合并:写事件切片 → 可见写入裁剪 → 地址升序 → 同区域相邻 / 重叠
/// 归并 → 单 range 窗口上限 → 字节总预算承载 → 不完整承载标记(D-P6)。
pub fn merge_dirty_ranges(
    policy: &ProjectionPolicy,
    memory: &VirtualMemory,
    new_private_events: &[VmEvent],
) -> Result<Vec<DirtyRange>, ProjectionError> {
    // 1. 裁剪:每次写保留其可见覆盖前缀(部分可见写以覆盖段进入;完全
    //    不可见写丢弃——相邻隐藏区域与未映射同形态,I-9)。
    let mut writes: Vec<(u64, u64)> = Vec::new();
    for event in new_private_events {
        if event.kind != VmEventKind::Write {
            continue;
        }
        let (Some(address), Some(length)) = (event.address.map(ArchValue::get), event.byte_length)
        else {
            continue;
        };
        match policy.classify_write_range(memory, address, length) {
            WriteTargetClass::Covered { .. } => writes.push((address, length)),
            WriteTargetClass::CrossesBoundary { covered, .. } => writes.push((address, covered)),
            WriteTargetClass::Invisible => {}
        }
    }
    if writes.is_empty() {
        return Ok(Vec::new());
    }

    // 2. 地址升序(承裁顺序 = 契约规则;排序是纯函数)。
    writes.sort_by_key(|(address, _)| *address);

    // 3. 同区域相邻 / 重叠归并为极大连续区间。
    let mut merged: Vec<(u64, u64)> = Vec::new();
    for (address, length) in writes {
        let end = address + length;
        match merged.last_mut() {
            Some(last) if last.1 >= address && same_region(memory, last.0, address) => {
                last.1 = last.1.max(end);
            }
            _ => merged.push((address, end)),
        }
    }

    // 4. 单 range 窗口上限(maxBytesPerRange;窗口锚定 range 起点)。
    let cap = u64::from(policy.max_bytes_per_range());
    let mut truncated_somewhere = false;
    let mut ranges: Vec<(u64, u64)> = merged
        .into_iter()
        .map(|(start, end)| {
            let end_capped = end.min(start.saturating_add(cap));
            if end_capped < end {
                truncated_somewhere = true;
            }
            (start, end_capped)
        })
        .collect();

    // 5. 条数上限(地址升序保留前 256)。
    if ranges.len() > MAX_DIRTY_RANGES_PER_DELTA {
        ranges.truncate(MAX_DIRTY_RANGES_PER_DELTA);
        truncated_somewhere = true;
    }

    // 6. 字节总预算:按地址升序承载至预算耗尽(预算内整段承载;最后一段
    //    可部分承载)。
    let mut budget = MAX_PROJECTION_BYTES_PER_REVISION;
    let mut carried: Vec<(u64, u64)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges {
        if budget == 0 {
            truncated_somewhere = true;
            break;
        }
        let length = end - start;
        let take = length.min(budget);
        if take < length {
            truncated_somewhere = true;
        }
        carried.push((start, start + take));
        budget -= take;
    }

    // 7. 内容读回(动作后权威内存,存储面)与标记落位:任何不完整承载
    //    打在最后一个已承载 range 上(presence-only,不含省略字节数)。
    let last_index = carried.len().checked_sub(1);
    let mut out = Vec::with_capacity(carried.len());
    for (index, (start, end)) in carried.into_iter().enumerate() {
        let length = end - start;
        let bytes = read_storage_bytes(memory, start, length)
            .ok_or(ProjectionError::EngineDefect("dirty_range_unbacked"))?;
        out.push(DirtyRange {
            region_id: containing_region_id(memory, start),
            start,
            bytes,
            truncated: Some(index) == last_index && truncated_somewhere,
        });
    }
    Ok(out)
}

/// 两个地址是否属于同一可见区域(归并的region约束:range 永不跨区域)。
fn same_region(memory: &VirtualMemory, left: u64, right: u64) -> bool {
    containing_region_id(memory, left) == containing_region_id(memory, right)
}

/// 地址所属区域标识(未映射返回空串——归并侧已保证可见,不可达形态)。
fn containing_region_id(memory: &VirtualMemory, address: u64) -> String {
    memory
        .region_at(address)
        .map(|region| region.region_id.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    extern crate std;

    use alloc::string::String;
    use alloc::vec;

    use super::*;
    use crate::policy::{ErrorDetailLevel, ProjectionPolicy, ProjectionPolicySpec, SecretSinkSet};
    use vm_core::arch::ArchValue;
    use vm_core::memory::{ExecutionMode, Permissions, RegionContents, RegionKind, RegionSpec};

    const A32: ArchBits = ArchBits::B32;

    struct Fixture {
        policy: ProjectionPolicy,
        memory: VirtualMemory,
    }

    fn policy_memory() -> Fixture {
        let regions = vec![
            RegionSpec::new(
                "buffer",
                RegionKind::Heap,
                None,
                0x2000_0000,
                16 * 4096,
                Permissions::parse("rw").unwrap(),
                A32,
            )
            .unwrap(),
            RegionSpec::new(
                "stack",
                RegionKind::Stack,
                None,
                0x7FFF_F000,
                4096,
                Permissions::parse("rw").unwrap(),
                A32,
            )
            .unwrap(),
            RegionSpec::new(
                "secret",
                RegionKind::Key,
                None,
                0x5000_0000,
                4096,
                Permissions::parse("rw").unwrap(),
                A32,
            )
            .unwrap(),
        ];
        let memory = VirtualMemory::new(
            A32,
            4096,
            ExecutionMode::Ir,
            regions,
            vec![
                RegionContents {
                    region_id: String::from("buffer"),
                    bytes: vec![0u8; 16 * 4096],
                },
                RegionContents {
                    region_id: String::from("stack"),
                    bytes: vec![0u8; 4096],
                },
                RegionContents {
                    region_id: String::from("secret"),
                    bytes: vec![0u8; 4096],
                },
            ],
        )
        .unwrap();
        let policy = ProjectionPolicy::assemble(
            ProjectionPolicySpec {
                visible_regions: vec![String::from("buffer"), String::from("stack")],
                visible_objects: Vec::new(),
                visible_registers: vec![String::from("RAX")],
                max_bytes_per_range: None,
                error_detail_level: ErrorDetailLevel::Educational,
            },
            &SecretSinkSet::default(),
        )
        .unwrap();
        Fixture { policy, memory }
    }

    fn write(addr: u64, len: u64) -> VmEvent {
        VmEvent {
            seq: 0,
            kind: VmEventKind::Write,
            address: Some(ArchValue::new(addr, A32)),
            byte_length: Some(len),
            payload: None,
        }
    }

    #[test]
    fn adjacent_and_overlapping_writes_merge_within_region() {
        let Fixture { policy, memory } = policy_memory();
        let events = vec![
            write(0x2000_0010, 4),
            write(0x2000_0014, 4), // 相邻
            write(0x2000_0000, 8), // 更早地址,乱序输入
            write(0x2000_0004, 8), // 重叠
            write(0x2000_000C, 4), // 与前段相邻(0x0C 接上 [0,0xC))
            write(0x7FFF_F000, 4), // 另一区域,不归并
            write(0x5000_0000, 4), // 不可见写:丢弃
        ];
        let ranges = merge_dirty_ranges(&policy, &memory, &events).unwrap();
        assert_eq!(ranges.len(), 2);
        // 地址升序:buffer [0x00, 0x18) 先于 stack(乱序输入 + 相邻归并)。
        assert_eq!(ranges[0].region_id, "buffer");
        assert_eq!(ranges[0].start, 0x2000_0000);
        assert_eq!(ranges[0].bytes.len(), 0x18);
        assert!(!ranges[0].truncated);
        assert_eq!(ranges[1].region_id, "stack");
        assert_eq!(ranges[1].start, 0x7FFF_F000);
        assert_eq!(ranges[1].bytes.len(), 4);
    }

    #[test]
    fn dirty_range_bytes_come_from_authoritative_memory() {
        let Fixture { policy, mut memory } = policy_memory();
        memory
            .write_slice(ArchValue::new(0x2000_0000, A32), &[0x11, 0x22, 0x33, 0x44])
            .unwrap();
        let ranges = merge_dirty_ranges(&policy, &memory, &[write(0x2000_0000, 4)]).unwrap();
        assert_eq!(ranges[0].bytes, vec![0x11, 0x22, 0x33, 0x44]);
    }

    #[test]
    fn per_range_window_cap_marks_last_range() {
        let Fixture { policy, mut memory } = policy_memory();
        // 单段连续写 300 字节 > 默认窗口 256:range 裁剪到 256,truncated 落标记。
        memory
            .write_slice(ArchValue::new(0x2000_0000, A32), &[0xAA; 300])
            .unwrap();
        let ranges = merge_dirty_ranges(&policy, &memory, &[write(0x2000_0000, 300)]).unwrap();
        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0].bytes.len(), 256);
        assert!(ranges[0].truncated, "不完整承载打在最后 range 上(D-P6)");
    }

    #[test]
    fn revision_budget_carries_in_address_order_with_marker() {
        let Fixture { policy, mut memory } = policy_memory();
        // 40 × 300 字节写(地址不连续,40 个独立 range):总 12000 > 8192。
        for i in 0..40u64 {
            memory
                .write_slice(ArchValue::new(0x2000_0000 + i * 512, A32), &[0xBB; 300])
                .unwrap();
        }
        let events: Vec<VmEvent> = (0..40u64)
            .map(|i| write(0x2000_0000 + i * 512, 300))
            .collect();
        let ranges = merge_dirty_ranges(&policy, &memory, &events).unwrap();
        let total: u64 = ranges.iter().map(|range| range.bytes.len() as u64).sum();
        assert!(total <= MAX_PROJECTION_BYTES_PER_REVISION);
        assert!(ranges.last().unwrap().truncated);
        assert!(
            ranges[..ranges.len() - 1]
                .iter()
                .all(|range| !range.truncated)
        );
        // 恰到预算:27 × 300 = 8100 ≤ 8192,第 28 段部分承载 92 字节。
        assert_eq!(total, 8192);
    }

    #[test]
    fn exactly_at_budget_has_no_marker() {
        let Fixture { policy, mut memory } = policy_memory();
        // 32 × 256 = 8192:恰好等于预算,无截断标记。
        for i in 0..32u64 {
            memory
                .write_slice(ArchValue::new(0x2000_0000 + i * 512, A32), &[0xCC; 256])
                .unwrap();
        }
        let events: Vec<VmEvent> = (0..32u64)
            .map(|i| write(0x2000_0000 + i * 512, 256))
            .collect();
        let ranges = merge_dirty_ranges(&policy, &memory, &events).unwrap();
        assert_eq!(ranges.len(), 32);
        assert!(ranges.iter().all(|range| !range.truncated));
    }

    #[test]
    fn crossing_write_is_clipped_to_visible_prefix() {
        let Fixture { policy, mut memory } = policy_memory();
        // 起点可见、跨出区域尾(stack 末 8 字节只有 4 字节在区域内):
        // 覆盖段进入 dirty range,越界段丢弃(邻接未映射与隐藏同形态)。
        memory
            .write_slice(ArchValue::new(0x7FFF_FFF8, A32), &[0xDD; 8])
            .unwrap();
        let events = vec![write(0x7FFF_FFF8, 8)];
        let ranges = merge_dirty_ranges(&policy, &memory, &events).unwrap();
        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0].start, 0x7FFF_FFF8);
        assert_eq!(ranges[0].bytes.len(), 8, "区域内 8 字节全可见,窗口不裁剪");
        // 区域尾只余 8 字节(0x7FFFF000..0x7FFFFFFF):写 8 字节从 FFF8 起
        // 恰好覆盖到末字节——全覆盖。改用 12 字节写验证裁剪:
        memory
            .write_slice(ArchValue::new(0x7FFF_FFF8, A32), &[0xEE; 8])
            .unwrap();
        let events = vec![write(0x7FFF_FFF8, 12)];
        let ranges = merge_dirty_ranges(&policy, &memory, &events).unwrap();
        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0].bytes.len(), 8, "越界 4 字节被裁剪");
    }

    #[test]
    fn call_stack_summary_innermost_first_with_depth_marker() {
        let mut state = test_state();
        for i in 0..70u64 {
            state.call_frames.push(vm_core::state::CallFrame {
                function_label: alloc::format!("0x{i}"),
                return_address: ArchValue::new(i, A32),
                saved_rbp: ArchValue::ZERO,
                args: Vec::new(),
            });
        }
        let summary = call_stack_summary(&state);
        assert_eq!(summary.len(), 64);
        // index 0 = 最内帧(引擎栈顶,最后 push 的第 70 帧,label "0x69")。
        assert_eq!(summary[0].function_label, "0x69");
        assert_eq!(summary[0].index, 0);
        assert!(!summary[0].truncated);
        // 最老展示帧(index 63)带 presence-only 标记,不含计数。
        assert_eq!(summary[63].index, 63);
        assert!(summary[63].truncated);
        // 深度不超限:无标记。
        let mut state = test_state();
        state.call_frames.push(vm_core::state::CallFrame {
            function_label: String::from("0x0"),
            return_address: ArchValue::ZERO,
            saved_rbp: ArchValue::ZERO,
            args: Vec::new(),
        });
        assert!(!call_stack_summary(&state)[0].truncated);
    }

    fn test_state() -> VmState {
        let regions = vec![
            RegionSpec::new(
                "buffer",
                RegionKind::Heap,
                None,
                0x2000_0000,
                4096,
                Permissions::parse("rw").unwrap(),
                A32,
            )
            .unwrap(),
        ];
        VmState::new(vm_core::state::VmStateConfig {
            arch: A32,
            execution_mode: ExecutionMode::Ir,
            page_size: 4096,
            regions,
            region_contents: vec![RegionContents {
                region_id: String::from("buffer"),
                bytes: vec![0u8; 4096],
            }],
            registers: vec![
                (String::from("RSP"), ArchValue::new(0x7FFF_FFF8, A32)),
                (String::from("RBP"), ArchValue::new(0x7FFF_FFF8, A32)),
                (String::from("RIP"), ArchValue::new(0x40_0000, A32)),
            ],
            flag_register_names: Vec::new(),
            initial_instruction_pointer: ArchValue::new(0x40_0000, A32),
            constraints: test_constraints(),
            seed_state: vm_core::state::SeedState {
                strategy: vm_core::state::SeedStrategy::Fixed,
                version: 1,
                state_bytes: Vec::new(),
            },
        })
        .unwrap()
    }

    fn test_constraints() -> vm_core::state::RuntimeConstraints {
        vm_core::state::RuntimeConstraints {
            steps: vm_core::state::Budget::new(0, 1_000_000),
            memory_bytes_limit: 64 * 1024 * 1024,
            wall_clock_ms_limit: 5_000,
            call_depth_limit: 64,
            action_log: vm_core::state::Budget::new(0, 10_000),
            output_bytes: vm_core::state::Budget::new(0, 4096),
            timeout_ms_limit: 1_000,
            predicate_evals: vm_core::state::CumulativeBudget::new(0, 100),
            rollback_ops: vm_core::state::Budget::new(0, 200),
        }
    }

    #[test]
    fn status_projection_and_delta_field() {
        assert_eq!(project_status(VmStatus::Running), PublicStatus::Running);
        assert_eq!(project_status(VmStatus::Paused), PublicStatus::Paused);
        assert_eq!(project_status(VmStatus::Won), PublicStatus::Won);
        assert_eq!(project_status(VmStatus::Failed), PublicStatus::Failed);
        // 增量字段存在性:变化才携带(I-4)。
        assert_eq!(
            PublicStatus::delta_field(PublicStatus::Running, PublicStatus::Running),
            None
        );
        assert_eq!(
            PublicStatus::delta_field(PublicStatus::Running, PublicStatus::Won),
            Some(PublicStatus::Won)
        );
        // rejected 不在投影枚举中(结构性:PublicStatus 无该变体)。
    }

    #[test]
    fn statics_assembly_rejects_malformed_declarations() {
        // 标签缺失 / 重复 / 非法文本 / 高亮超限逐条红灯。
        assert!(
            ProjectionStatics::assemble(
                vec![(String::from("buffer"), String::from("缓冲区"))],
                Vec::new()
            )
            .is_ok()
        );
        assert!(
            ProjectionStatics::assemble(
                vec![(String::from("bad id"), String::from("x"))],
                Vec::new()
            )
            .is_err()
        );
        assert!(
            ProjectionStatics::assemble(
                vec![
                    (String::from("buffer"), String::from("a")),
                    (String::from("buffer"), String::from("b"))
                ],
                Vec::new()
            )
            .is_err()
        );
        assert!(
            ProjectionStatics::assemble(
                vec![(String::from("buffer"), String::from("bad\u{7f}"))],
                Vec::new()
            )
            .is_err()
        );
        let highlights: Vec<HighlightDeclaration> = (0..33)
            .map(|_| HighlightDeclaration {
                kind: HighlightKind::Custom,
                target_region_id: String::from("buffer"),
                start: 0,
                byte_length: 1,
                label: String::from("x"),
            })
            .collect();
        assert!(ProjectionStatics::assemble(Vec::new(), highlights).is_err());
    }
}

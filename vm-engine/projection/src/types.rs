//! 投影契约输出类型(冻结字段集合的生成面形态;WP-7)。
//!
//! # 与契约的关系
//!
//! 本模块类型与 `@stackmaster/protocol` 冻结 Schema 的字段集合**一一对应,
//! 不增不删**(`PublicStateProjection` / `ProjectionDelta` / `PublicEvent` /
//! `PublicError` 及全部子类型);字段语义与可见性论证见
//! `docs/contracts/数据分类与秘密零驻留清单.md` §四 / §六与投影与错误契约语义。
//! 本 crate 无 serde、无 JSON 解析路径(ENG-4 允许清单为零依赖)——跨进程
//! 序列化由 vm-worker 的出站契约镜像承担(WP-8 接线),本模块只承载
//! **生成面数据**与规范化输出文本([`CanonicalText`]。
//!
//! # 规范化输出文本
//!
//! 每个类型实现 [`CanonicalText::to_canonical`]:按冻结文法
//! (`stackmaster-canonical-json/1`)产出紧凑 JSON 文本。对象键序固化为
//! 该键集的 UTF-16 码元序(每类型键序由专测断言);字段缺席 = 键整体缺席
//! (I-8:存在性是生成输入的确定性函数);presence-only 截断标记建模为
//! `bool`,**false 时键整体缺席**(契约只接受 `true` 出现,显式 false 拒绝)。
//!
//! 数值:revision / byteLength / seq / index 以十进制写出;地址与架构值
//! 为 `0x` 前缀大写变长十六进制(`ArchValue::format_hex` 同形态,协议 §2.3);
//! 字节串为小写十六进制无前缀(`bytesHex` / `payloadHex` 契约形态)。

use alloc::string::String;
use alloc::vec::Vec;

use core::fmt::Write as _;

use vm_core::arch::ArchValue;

use crate::canon::{escape_json_string, hex_encode_lower};

/// 规范化输出文本(生成面;差分测试与出站镜像哈希的锚点)。
pub trait CanonicalText {
    /// 规范化 JSON 文本(零空白、键 UTF-16 码元序;不可失败——全部字段
    /// 在构造期已受契约形态约束)。
    fn to_canonical(&self) -> String;
}

impl CanonicalText for String {
    fn to_canonical(&self) -> String {
        let mut out = String::new();
        escape_json_string(self, &mut out);
        out
    }
}

/// 冻结错误码枚举(WP-1 §6.3 E-1,16 值;覆盖计划书 4.4 九类教学错误 +
/// I-9 统一访问拒绝 + 资源预算 + 协议级拒绝 + 内部错误兜底)。枚举值本身
/// 是公开契约;扩展走协议版本演进,不靠预留值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PublicErrorCode {
    /// 输入格式错误。
    InvalidInputFormat,
    /// payload 长度错误。
    InvalidPayloadLength,
    /// 偏移不足或过长(写出可见区域边界)。
    OffsetOutOfRange,
    /// 端序错误(值被按错误端序解释的教学反馈)。
    EndiannessMismatch,
    /// 权限错误(对可见但不可写 / 不可执行地址操作)。
    PermissionDenied,
    /// 非法 RIP(ret / leave 弹出值不可作为执行位置)。
    InvalidRip,
    /// Canary 破坏(触发会话 failed 的教学结果)。
    CanaryViolation,
    /// 参数寄存器错误(调用约定)/ 未声明接口派发。
    InvalidCallArgument,
    /// 目标条件未满足(零谓词信息,E-4 / I-7)。
    ObjectiveNotMet,
    /// I-9:不可见地址(隐藏映射与未映射统一形态)。
    InaccessibleAddress,
    /// 资源预算耗尽(步数 / 内存 / 输出上限等)。
    BudgetExhausted,
    /// baseRevision 过期。
    StaleBaseRevision,
    /// clientSeq 乱序。
    StaleClientSeq,
    /// 幂等键冲突。
    IdempotencyConflict,
    /// 会话已终态(won / failed 后禁止该动作,D1 约束 5)。
    SessionTerminal,
    /// 引擎内部错误(engine_error / challenge_invalid 的公开兜底,E-6 零细节)。
    InternalError,
}

impl PublicErrorCode {
    /// 契约枚举串(snake_case;与 `@stackmaster/protocol` 同串语义)。
    pub fn as_str(self) -> &'static str {
        match self {
            PublicErrorCode::InvalidInputFormat => "invalid_input_format",
            PublicErrorCode::InvalidPayloadLength => "invalid_payload_length",
            PublicErrorCode::OffsetOutOfRange => "offset_out_of_range",
            PublicErrorCode::EndiannessMismatch => "endianness_mismatch",
            PublicErrorCode::PermissionDenied => "permission_denied",
            PublicErrorCode::InvalidRip => "invalid_rip",
            PublicErrorCode::CanaryViolation => "canary_violation",
            PublicErrorCode::InvalidCallArgument => "invalid_call_argument",
            PublicErrorCode::ObjectiveNotMet => "objective_not_met",
            PublicErrorCode::InaccessibleAddress => "inaccessible_address",
            PublicErrorCode::BudgetExhausted => "budget_exhausted",
            PublicErrorCode::StaleBaseRevision => "stale_base_revision",
            PublicErrorCode::StaleClientSeq => "stale_client_seq",
            PublicErrorCode::IdempotencyConflict => "idempotency_conflict",
            PublicErrorCode::SessionTerminal => "session_terminal",
            PublicErrorCode::InternalError => "internal_error",
        }
    }
}

/// 地址的大写变长十六进制(`0x` 前缀、无前导零、零 → `0x0`;
/// 与 `ArchValue::format_hex` 同一形态,事件 / 区域 / 高亮的地址字段共用)。
pub fn format_address(raw: u64) -> String {
    if raw == 0 {
        return String::from("0x0");
    }
    let mut buf = [0u8; 16];
    let mut len = 0;
    let mut v = raw;
    while v > 0 {
        buf[len] = b"0123456789ABCDEF"[(v & 0xF) as usize];
        len += 1;
        v >>= 4;
    }
    let mut out = String::with_capacity(2 + len);
    out.push_str("0x");
    while len > 0 {
        len -= 1;
        out.push(buf[len] as char);
    }
    out
}

/// 权威 VM 状态的公开形态(WP-1 §4.2 / D1;`rejected` 不属于投影)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicStatus {
    /// 运行中。
    Running,
    /// 已暂停。
    Paused,
    /// 已达成目标条件(会话终态)。
    Won,
    /// 已触发失败条件(会话终态)。
    Failed,
}

impl PublicStatus {
    fn as_str(self) -> &'static str {
        match self {
            PublicStatus::Running => "running",
            PublicStatus::Paused => "paused",
            PublicStatus::Won => "won",
            PublicStatus::Failed => "failed",
        }
    }

    /// 完整投影 → 可选增量字段:存在性 = 前后可见状态比较(D1 粗化;
    /// 增量携带 = 本次动作发生可观察变化,I-4)。
    pub(crate) fn delta_field(before: Self, after: Self) -> Option<Self> {
        (before != after).then_some(after)
    }
}

/// 动作响应信封状态(§6.2;`rejected` 只属于响应,不进入投影)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseStatus {
    /// 已执行,会话运行中。
    Running,
    /// 已执行,会话暂停中。
    Paused,
    /// 已执行,达成目标条件。
    Won,
    /// 已执行,触发失败条件。
    Failed,
    /// 执行前被拒绝(revision 不动;错误必有、增量恒空、事件恒空)。
    Rejected,
}

impl ResponseStatus {
    fn as_str(self) -> &'static str {
        match self {
            ResponseStatus::Running => "running",
            ResponseStatus::Paused => "paused",
            ResponseStatus::Won => "won",
            ResponseStatus::Failed => "failed",
            ResponseStatus::Rejected => "rejected",
        }
    }
}

/// 公开事件类别(WP-1 §4.2 冻结六枚举;与私有事件类别的映射归 [`crate::events`])。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicEventKind {
    /// 读内存。
    Read,
    /// 写内存。
    Write,
    /// 调用。
    Call,
    /// 返回。
    Ret,
    /// 系统调用。
    Syscall,
    /// 异常边界。
    Exception,
}

impl PublicEventKind {
    fn as_str(self) -> &'static str {
        match self {
            PublicEventKind::Read => "read",
            PublicEventKind::Write => "write",
            PublicEventKind::Call => "call",
            PublicEventKind::Ret => "ret",
            PublicEventKind::Syscall => "syscall",
            PublicEventKind::Exception => "exception",
        }
    }
}

/// 暂停事件类别(`pausedOn`,与 `run_to_event.pauseOn` 同源,D5)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PauseKind {
    /// 读内存。
    Read,
    /// 写内存。
    Write,
    /// 调用。
    Call,
    /// 返回。
    Ret,
    /// 异常边界。
    Exception,
}

impl PauseKind {
    fn as_str(self) -> &'static str {
        match self {
            PauseKind::Read => "read",
            PauseKind::Write => "write",
            PauseKind::Call => "call",
            PauseKind::Ret => "ret",
            PauseKind::Exception => "exception",
        }
    }
}

/// 白名单寄存器的公开形态(§4.2;值 = archBits 位宽架构值,大写变长十六进制)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicRegister {
    /// 寄存器名(∈ 策略白名单;FLAG 名在策略装配期结构性排除)。
    pub name: String,
    /// 当前值(掩蔽域容器;写出时格式化为大写变长十六进制)。
    pub value: ArchValue,
}

impl CanonicalText for PublicRegister {
    fn to_canonical(&self) -> String {
        // 键序(UTF-16):name < valueHex
        let mut out = String::new();
        out.push_str("{\"name\":");
        escape_json_string(&self.name, &mut out);
        out.push_str(",\"valueHex\":\"");
        out.push_str(&self.value.format_hex());
        out.push_str("\"}");
        out
    }
}

/// 可见内存区域(§4.2 / D3;字节窗口锚定区域起点)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisibleMemoryRegion {
    /// 区域标识(公开布局;∈ 策略白名单)。
    pub region_id: String,
    /// 公开标签(公开描述包声明;I-10 值来源)。
    pub label: String,
    /// 起始地址(公开布局)。
    pub start: u64,
    /// 区域总长度(公开布局常量)。
    pub byte_length: u64,
    /// 权限事实(`r`/`w`/`x` 规范序子集,非空)。
    pub permissions: String,
    /// 窗口字节(≤ min(byteLength, maxBytesPerRange))。
    pub bytes: Vec<u8>,
    /// 窗口是否被 maxBytesPerRange 截断(常态布尔字段:完整展示也是显式教学事实)。
    pub truncated: bool,
}

impl CanonicalText for VisibleMemoryRegion {
    fn to_canonical(&self) -> String {
        // 键序:byteLength < bytesHex < label < permissions < regionId
        //       < startAddressHex < truncated
        let mut out = String::new();
        out.push_str("{\"byteLength\":");
        let _ = core::write!(out, "{}", self.byte_length);
        out.push_str(",\"bytesHex\":\"");
        out.push_str(&hex_encode_lower(&self.bytes));
        out.push_str("\",\"label\":");
        escape_json_string(&self.label, &mut out);
        out.push_str(",\"permissions\":");
        escape_json_string(&self.permissions, &mut out);
        out.push_str(",\"regionId\":");
        escape_json_string(&self.region_id, &mut out);
        out.push_str(",\"startAddressHex\":\"");
        out.push_str(&format_address(self.start));
        // truncated 是常态布尔字段(契约 z.boolean() 必填):完整展示也是
        // 显式教学事实(投影与错误契约语义 §2.2)。
        out.push_str("\",\"truncated\":");
        out.push_str(if self.truncated { "true" } else { "false" });
        out.push('}');
        out
    }
}

/// 调用栈摘要帧(D2 裁剪形态:帧基址不下发,由玩家从可见 RSP/RBP 推导)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicCallFrame {
    /// 栈内序号(0 = 最内帧;上限 `CALL_STACK_MAX_DEPTH − 1`)。
    pub index: u32,
    /// 函数标签(公开符号表 / 服务端静态模板;引擎侧为静态模板 `{:#X}`)。
    pub function_label: String,
    /// 返回地址。
    pub return_address: u64,
    /// presence-only 截断标记:仅出现在深度超 64 后展示的最后一帧上
    /// (D2:不含省略帧数);false = 键整体缺席。
    pub truncated: bool,
}

impl CanonicalText for PublicCallFrame {
    fn to_canonical(&self) -> String {
        // 键序:functionLabel < index < returnAddressHex < truncated
        let mut out = String::new();
        out.push_str("{\"functionLabel\":");
        escape_json_string(&self.function_label, &mut out);
        out.push_str(",\"index\":");
        let _ = core::write!(out, "{}", self.index);
        out.push_str(",\"returnAddressHex\":\"");
        out.push_str(&format_address(self.return_address));
        out.push('"');
        if self.truncated {
            out.push_str(",\"truncated\":true");
        }
        out.push('}');
        out
    }
}

/// 当前指令展示(D5:服务端从展示数据生成,非可执行 IR 形态)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentInstruction {
    /// 指令地址(公开代码布局或玩家自供值)。
    pub address: u64,
    /// 伪指令展示文本(冻结模板渲染;不可译码 → 统一占位文本)。
    pub text: String,
}

/// 控制流公开形态(§4.2 / D5;`pausedOn` 可空表达"未因事件暂停")。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlFlow {
    /// 当前指令展示(必填非空)。
    pub current_instruction: CurrentInstruction,
    /// 触发当前暂停的事件类别;`None` = null(运行中或无特定暂停事件)。
    pub paused_on: Option<PauseKind>,
}

impl CanonicalText for ControlFlow {
    fn to_canonical(&self) -> String {
        // 键序:currentInstruction < pausedOn;内层:addressHex < text
        let mut out = String::new();
        out.push_str("{\"currentInstruction\":{\"addressHex\":\"");
        out.push_str(&format_address(self.current_instruction.address));
        out.push_str("\",\"text\":");
        escape_json_string(&self.current_instruction.text, &mut out);
        out.push_str("},\"pausedOn\":");
        match self.paused_on {
            Some(kind) => {
                escape_json_string(kind.as_str(), &mut out);
            }
            None => out.push_str("null"),
        }
        out.push('}');
        out
    }
}

/// 语义高亮类别(§4.2 冻结五枚举;扩展走协议版本演进)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HighlightKind {
    /// 缓冲区起点。
    BufferStart,
    /// 返回地址槽。
    ReturnAddressSlot,
    /// saved RBP 槽。
    SavedRbpSlot,
    /// canary 槽。
    CanarySlot,
    /// 题目自定义。
    Custom,
}

impl HighlightKind {
    fn as_str(self) -> &'static str {
        match self {
            HighlightKind::BufferStart => "buffer_start",
            HighlightKind::ReturnAddressSlot => "return_address_slot",
            HighlightKind::SavedRbpSlot => "saved_rbp_slot",
            HighlightKind::CanarySlot => "canary_slot",
            HighlightKind::Custom => "custom",
        }
    }
}

/// 语义高亮(§4.2;目标区域必须可见,I-2——生成期 fail-closed)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticHighlight {
    /// 类别。
    pub kind: HighlightKind,
    /// 目标区域标识(∈ 策略白名单)。
    pub target_region_id: String,
    /// 起始地址。
    pub start: u64,
    /// 跨度字节数。
    pub byte_length: u64,
    /// 展示标签(公开描述包 / 静态模板)。
    pub label: String,
}

impl CanonicalText for SemanticHighlight {
    fn to_canonical(&self) -> String {
        // 键序:byteLength < kind < label < startAddressHex < targetRegionId
        let mut out = String::new();
        out.push_str("{\"byteLength\":");
        let _ = core::write!(out, "{}", self.byte_length);
        out.push_str(",\"kind\":");
        escape_json_string(self.kind.as_str(), &mut out);
        out.push_str(",\"label\":");
        escape_json_string(&self.label, &mut out);
        out.push_str(",\"startAddressHex\":\"");
        out.push_str(&format_address(self.start));
        out.push_str("\",\"targetRegionId\":");
        escape_json_string(&self.target_region_id, &mut out);
        out.push('}');
        out
    }
}

/// 公开投影(PublicStateProjection;WP-1 §4.1 冻结 7 字段,不增不删)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicStateProjection {
    /// 服务端权威 revision(已执行非拒绝动作数,I-5)。
    pub revision: u64,
    /// 仅白名单区域;隐藏区域无占位、无条目、无计数(D3 / I-9)。
    pub visible_regions: Vec<VisibleMemoryRegion>,
    /// 仅白名单寄存器(I-3;FLAG 值结构性不在内)。
    pub visible_registers: Vec<PublicRegister>,
    /// 调用栈摘要(D2)。
    pub call_stack_summary: Vec<PublicCallFrame>,
    /// 控制流(D5)。
    pub control_flow: ControlFlow,
    /// 语义高亮(I-2)。
    pub semantic_highlights: Vec<SemanticHighlight>,
    /// 权威状态公开形态(D1)。
    pub status: PublicStatus,
}

impl CanonicalText for PublicStateProjection {
    fn to_canonical(&self) -> String {
        // 键序:callStackSummary < controlFlow < revision < semanticHighlights
        //       < status < visibleRegions < visibleRegisters
        let mut out = String::new();
        out.push_str("{\"callStackSummary\":");
        write_array(&self.call_stack_summary, &mut out);
        out.push_str(",\"controlFlow\":");
        out.push_str(&self.control_flow.to_canonical());
        out.push_str(",\"revision\":");
        let _ = core::write!(out, "{}", self.revision);
        out.push_str(",\"semanticHighlights\":");
        write_array(&self.semantic_highlights, &mut out);
        out.push_str(",\"status\":");
        escape_json_string(self.status.as_str(), &mut out);
        out.push_str(",\"visibleRegions\":");
        write_array(&self.visible_regions, &mut out);
        out.push_str(",\"visibleRegisters\":");
        write_array(&self.visible_registers, &mut out);
        out.push('}');
        out
    }
}

/// 脏范围(§4.3:单个可见区域内的连续写入;合并规则归 [`crate::project`])。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirtyRange {
    /// 所属可见区域(∈ 策略白名单)。
    pub region_id: String,
    /// 合并后写入的起始地址。
    pub start: u64,
    /// 合并后的连续新字节(来源 = 动作后权威内存读回,D-P2)。
    pub bytes: Vec<u8>,
    /// presence-only 截断标记:本增量存在任何不完整承载(预算耗尽 / 单 range
    /// 上限 / 条数上限)时打在最后一个 range 上(D-P6;不含省略字节数)。
    pub truncated: bool,
}

impl CanonicalText for DirtyRange {
    fn to_canonical(&self) -> String {
        // 键序:bytesHex < regionId < startAddressHex < truncated
        let mut out = String::new();
        out.push_str("{\"bytesHex\":\"");
        out.push_str(&hex_encode_lower(&self.bytes));
        out.push_str("\",\"regionId\":");
        escape_json_string(&self.region_id, &mut out);
        out.push_str(",\"startAddressHex\":\"");
        out.push_str(&format_address(self.start));
        out.push('"');
        if self.truncated {
            out.push_str(",\"truncated\":true");
        }
        out.push('}');
        out
    }
}

/// 公开投影增量(§4.3;可选字段整体替换语义,存在性 = 可观察变化,I-4)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionDelta {
    /// 增量目标 revision(= 信封 revision,生成侧同源保证)。
    pub revision: u64,
    /// 可见写入合并范围(无写入携带空数组,字段恒在,I-8)。
    pub dirty_ranges: Vec<DirtyRange>,
    /// 值发生变化的白名单寄存器新值子集(无变化携带空数组,I-8)。
    pub changed_registers: Vec<PublicRegister>,
    /// 控制流(存在 = 本次动作控制流可见面发生变化)。
    pub control_flow: Option<ControlFlow>,
    /// 状态(存在 = 本次动作状态发生变化)。
    pub status: Option<PublicStatus>,
    /// 调用栈摘要(存在 = 本次动作调用栈可见面发生变化)。
    pub call_stack_summary: Option<Vec<PublicCallFrame>>,
    /// 语义高亮(静态声明面,运行期恒不变化——存在性规则的退化情形)。
    pub semantic_highlights: Option<Vec<SemanticHighlight>>,
}

impl CanonicalText for ProjectionDelta {
    fn to_canonical(&self) -> String {
        // 键序:callStackSummary < changedRegisters < controlFlow < dirtyRanges
        //       < revision < semanticHighlights < status。
        // 可选字段(I-4 存在性确定性的载体)缺席 = 键整体缺席——契约的
        // `.optional()` 形态拒绝 null,"无变化"的唯一确定性形态是不出现。
        let mut out = String::new();
        out.push('{');
        if let Some(frames) = &self.call_stack_summary {
            out.push_str("\"callStackSummary\":");
            write_array(frames, &mut out);
            out.push(',');
        }
        out.push_str("\"changedRegisters\":");
        write_array(&self.changed_registers, &mut out);
        if let Some(flow) = &self.control_flow {
            out.push_str(",\"controlFlow\":");
            out.push_str(&flow.to_canonical());
        }
        out.push_str(",\"dirtyRanges\":");
        write_array(&self.dirty_ranges, &mut out);
        out.push_str(",\"revision\":");
        let _ = core::write!(out, "{}", self.revision);
        if let Some(items) = &self.semantic_highlights {
            out.push_str(",\"semanticHighlights\":");
            write_array(items, &mut out);
        }
        if let Some(status) = self.status {
            out.push_str(",\"status\":");
            escape_json_string(status.as_str(), &mut out);
        }
        out.push('}');
        out
    }
}

/// 公开事件(§4.2 / D4;白名单过滤后的私有事件子集,seq 动作内独立稠密)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicEvent {
    /// 本动作 publicEvents 数组内稠密序号(0 起;上限 255)。
    pub seq: u32,
    /// 事件类别。
    pub kind: PublicEventKind,
    /// 事件地址(可见性规则:I-8 确定性;不可见访问不产生事件或地址缺席,I-9)。
    pub address: Option<u64>,
    /// 访问宽度(字节)。
    pub byte_length: Option<u64>,
    /// 载荷字节(写事件;来源 = 可见区域动作后读回,I-10;
    /// 生成保证:payloadHex 字节长度 == byteLength——superRefine 的引擎侧镜像)。
    pub payload: Option<Vec<u8>>,
    /// presence-only 聚合标记(仅出现在超限聚合事件上,D-P4;不含计数)。
    pub truncated: bool,
}

impl CanonicalText for PublicEvent {
    fn to_canonical(&self) -> String {
        // 键序:addressHex < byteLength < kind < payloadHex < seq < truncated。
        // 可选字段缺席 = 键整体缺席(契约 `.optional()` 形态;I-8 的"省略"
        // 只有一种字节形态,不存在 null 占位)。
        let mut out = String::new();
        out.push('{');
        if let Some(addr) = self.address {
            out.push_str("\"addressHex\":\"");
            out.push_str(&format_address(addr));
            out.push_str("\",");
        }
        if let Some(len) = self.byte_length {
            out.push_str("\"byteLength\":");
            let _ = core::write!(out, "{}", len);
            out.push(',');
        }
        out.push_str("\"kind\":");
        escape_json_string(self.kind.as_str(), &mut out);
        if let Some(bytes) = &self.payload {
            out.push_str(",\"payloadHex\":\"");
            out.push_str(&hex_encode_lower(bytes));
            out.push('"');
        }
        out.push_str(",\"seq\":");
        let _ = core::write!(out, "{}", self.seq);
        if self.truncated {
            out.push_str(",\"truncated\":true");
        }
        out.push('}');
        out
    }
}

/// 值解释方式(位宽 × 端序;由题目 VM Profile 公开元数据决定)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InterpretedAs {
    /// 小端四字。
    LittleEndianQword,
    /// 小端双字。
    LittleEndianDword,
    /// 大端四字。
    BigEndianQword,
    /// 大端双字。
    BigEndianDword,
}

impl InterpretedAs {
    fn as_str(self) -> &'static str {
        match self {
            InterpretedAs::LittleEndianQword => "little_endian_qword",
            InterpretedAs::LittleEndianDword => "little_endian_dword",
            InterpretedAs::BigEndianQword => "big_endian_qword",
            InterpretedAs::BigEndianDword => "big_endian_dword",
        }
    }
}

/// `PublicError.addressHex` 的三态形态(§4.3 能力矩阵逐 code 冻结):
/// 缺席(forbidden)/ `null`(null-only 统一占位,I-9)/ 真实可见地址。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorAddress {
    /// 字段整体缺席(协议级拒绝类;显式 null 也不允许)。
    Absent,
    /// 恒为 null 统一占位(`inaccessible_address`,I-9:M-3 抉择)。
    Null,
    /// 真实地址(必须落在可见区域,E-2)。
    Real(u64),
}

/// 教学解释字段(§4.4;逐 code 允许面由能力矩阵在生成期强制——
/// 矩阵外字段的构造在 [`crate::error`] 是 fail-closed 错误,不是静默剥离)。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ErrorExplanation {
    /// 涉及的可见区域标识(必须 ∈ 白名单,I-2)。
    pub region_id: Option<String>,
    /// 该可见区域的权限事实(r/w/x)。
    pub permissions: Option<String>,
    /// 被解释的值(玩家输入或可见内容回显,E-3 / I-10)。
    pub value_hex: Option<ArchValue>,
    /// 该值被如何解释(位宽 × 端序)。
    pub interpreted_as: Option<InterpretedAs>,
    /// 对齐要求(只接受 1 | 2 | 4 | 8 字面量)。
    pub alignment_bytes: Option<u8>,
    /// 期望长度(来源 ⊆ 公开上限 / 公开预算 / 可见区域边界 / 对齐常量,E-3)。
    pub expected_bytes_length: Option<u64>,
    /// 玩家输入的实际长度(玩家自供内容)。
    pub actual_bytes_length: Option<u64>,
    /// 服务端静态模板教学提示(≤ 4 条、单条 ≤ 256;禁谓词信息 E-4 / I-7)。
    pub hints: Option<Vec<String>>,
}

/// 脱敏后的用户可见错误(§4.4 / E-1–E-6;能力矩阵生成侧强制归 [`crate::error`])。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicError {
    /// 冻结 16 值枚举。
    pub code: PublicErrorCode,
    /// 静态最小文案(E-5;生成面按 `f(code)` 常量模板,ZR-P6 字节稳定)。
    pub message: String,
    /// 地址三态(能力矩阵 `addressHex` 形态)。
    pub address: ErrorAddress,
    /// 解释(educational 级才可能存在;coarse 级结构性缺席,ZR-P6)。
    pub explanation: Option<ErrorExplanation>,
}

impl CanonicalText for PublicError {
    fn to_canonical(&self) -> String {
        // 键序:addressHex < code < explanation < message。
        // addressHex 三态:Absent = 键缺席(forbidden)/ Null = 键带 null
        // (null-only 统一占位,I-9)/ Real = 键带真实地址(E-2)。
        let mut out = String::new();
        out.push('{');
        match self.address {
            ErrorAddress::Absent => {}
            ErrorAddress::Null => out.push_str("\"addressHex\":null,"),
            ErrorAddress::Real(addr) => {
                out.push_str("\"addressHex\":\"");
                out.push_str(&format_address(addr));
                out.push_str("\",");
            }
        }
        out.push_str("\"code\":");
        escape_json_string(self.code.as_str(), &mut out);
        if let Some(explanation) = &self.explanation {
            out.push_str(",\"explanation\":");
            write_explanation(explanation, &mut out);
        }
        out.push_str(",\"message\":");
        escape_json_string(&self.message, &mut out);
        out.push('}');
        out
    }
}

/// 解释字段写出(仅出现的字段带键;契约 `.optional()` 形态拒绝 null——
/// "字段不存在"是能力矩阵允许面之外的唯一其他形态)。
fn write_explanation(explanation: &ErrorExplanation, out: &mut String) {
    // 键序:actualBytesLength < alignmentBytes < expectedBytesLength
    //       < hints < interpretedAs < permissions < regionId < valueHex
    out.push('{');
    let mut wrote = false;
    let sep = |out: &mut String, wrote: &mut bool| {
        if *wrote {
            out.push(',');
        }
        *wrote = true;
    };
    if let Some(len) = explanation.actual_bytes_length {
        sep(out, &mut wrote);
        out.push_str("\"actualBytesLength\":");
        let _ = core::write!(out, "{}", len);
    }
    if let Some(alignment) = explanation.alignment_bytes {
        sep(out, &mut wrote);
        out.push_str("\"alignmentBytes\":");
        let _ = core::write!(out, "{}", alignment);
    }
    if let Some(len) = explanation.expected_bytes_length {
        sep(out, &mut wrote);
        out.push_str("\"expectedBytesLength\":");
        let _ = core::write!(out, "{}", len);
    }
    if let Some(hints) = &explanation.hints {
        sep(out, &mut wrote);
        out.push_str("\"hints\":");
        write_array(hints, out);
    }
    if let Some(interpreted) = explanation.interpreted_as {
        sep(out, &mut wrote);
        out.push_str("\"interpretedAs\":");
        escape_json_string(interpreted.as_str(), out);
    }
    if let Some(permissions) = &explanation.permissions {
        sep(out, &mut wrote);
        out.push_str("\"permissions\":");
        escape_json_string(permissions, out);
    }
    if let Some(region_id) = &explanation.region_id {
        sep(out, &mut wrote);
        out.push_str("\"regionId\":");
        escape_json_string(region_id, out);
    }
    if let Some(value) = explanation.value_hex {
        sep(out, &mut wrote);
        out.push_str("\"valueHex\":\"");
        out.push_str(&value.format_hex());
        out.push('"');
    }
    out.push('}');
}

/// 动作响应的投影面(§6.2 `ActionResponse` 除 `requestId` 外的五字段;
/// 信封组装与 `requestId` 回传归 WP-8 worker)。
///
/// 契约耦合(§4.4 冻结,生成侧结构性保证):`status = rejected` 时
/// `userVisibleError` 必有、`projectionDelta` 恒缺席、`publicEvents` 恒空
/// ([`ActionProjection::rejected`] 构造器是唯一拒绝形态入口)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionProjection {
    /// 后置 revision(拒绝 = 当前值不动,I-5 / ZR-P5)。
    pub revision: u64,
    /// 信封状态(含 rejected)。
    pub status: ResponseStatus,
    /// 投影增量(拒绝 = None;已执行 = Some)。
    pub delta: Option<ProjectionDelta>,
    /// 公开事件(拒绝 = 空数组)。
    pub events: Vec<PublicEvent>,
    /// 用户可见错误(拒绝必有;教学性失败可携带)。
    pub error: Option<PublicError>,
}

impl ActionProjection {
    /// 已执行动作的响应面(含教学性失败:`error` 可携带,revision 恒 +1 由
    /// 调用方账本保证)。
    pub fn executed(
        revision: u64,
        status: PublicStatus,
        delta: ProjectionDelta,
        events: Vec<PublicEvent>,
        error: Option<PublicError>,
    ) -> Self {
        Self {
            revision,
            status: match status {
                PublicStatus::Running => ResponseStatus::Running,
                PublicStatus::Paused => ResponseStatus::Paused,
                PublicStatus::Won => ResponseStatus::Won,
                PublicStatus::Failed => ResponseStatus::Failed,
            },
            delta: Some(delta),
            events,
            error,
        }
    }

    /// 执行前拒绝的响应面(§4.4 耦合形态:错误必有、增量恒缺、事件恒空)。
    pub fn rejected(revision: u64, error: PublicError) -> Self {
        Self {
            revision,
            status: ResponseStatus::Rejected,
            delta: None,
            events: Vec::new(),
            error: Some(error),
        }
    }
}

impl CanonicalText for ActionProjection {
    fn to_canonical(&self) -> String {
        // 键序:projectionDelta < publicEvents < revision < status < userVisibleError。
        // projectionDelta 契约形态是 nullable(恒在,null 表"无增量");
        // userVisibleError 是 optional(缺席 = 键整体缺席)。
        let mut out = String::new();
        out.push_str("{\"projectionDelta\":");
        match &self.delta {
            Some(delta) => out.push_str(&delta.to_canonical()),
            None => out.push_str("null"),
        }
        out.push_str(",\"publicEvents\":");
        write_array(&self.events, &mut out);
        out.push_str(",\"revision\":");
        let _ = core::write!(out, "{}", self.revision);
        out.push_str(",\"status\":");
        escape_json_string(self.status.as_str(), &mut out);
        if let Some(error) = &self.error {
            out.push_str(",\"userVisibleError\":");
            out.push_str(&error.to_canonical());
        }
        out.push('}');
        out
    }
}

/// 数组写出(保序;空数组 `[]`)。
fn write_array<T: CanonicalText>(items: &[T], out: &mut String) {
    out.push('[');
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&item.to_canonical());
    }
    out.push(']');
}

#[cfg(test)]
mod tests {
    extern crate std;

    use alloc::vec;

    use super::*;
    use crate::canon::compare_utf16;

    /// 每个输出类型的键字面量序列按 UTF-16 码元序排列(手写键序防漂移;
    /// 与 `to_canonical` 中出现的键一一对应)。
    #[test]
    fn frozen_key_orders_are_utf16_sorted() {
        let key_sets: [&[&str]; 12] = [
            // PublicStateProjection
            &[
                "callStackSummary",
                "controlFlow",
                "revision",
                "semanticHighlights",
                "status",
                "visibleRegions",
                "visibleRegisters",
            ],
            // VisibleMemoryRegion
            &[
                "byteLength",
                "bytesHex",
                "label",
                "permissions",
                "regionId",
                "startAddressHex",
                "truncated",
            ],
            // PublicRegister
            &["name", "valueHex"],
            // PublicCallFrame
            &["functionLabel", "index", "returnAddressHex", "truncated"],
            // ControlFlow + currentInstruction
            &["currentInstruction", "pausedOn"],
            &["addressHex", "text"],
            // SemanticHighlight
            &[
                "byteLength",
                "kind",
                "label",
                "startAddressHex",
                "targetRegionId",
            ],
            // ProjectionDelta
            &[
                "callStackSummary",
                "changedRegisters",
                "controlFlow",
                "dirtyRanges",
                "revision",
                "semanticHighlights",
                "status",
            ],
            // DirtyRange
            &["bytesHex", "regionId", "startAddressHex", "truncated"],
            // PublicEvent
            &[
                "addressHex",
                "byteLength",
                "kind",
                "payloadHex",
                "seq",
                "truncated",
            ],
            // PublicError + explanation
            &["addressHex", "code", "explanation", "message"],
            // ActionProjection
            &[
                "projectionDelta",
                "publicEvents",
                "revision",
                "status",
                "userVisibleError",
            ],
        ];
        for keys in key_sets {
            for pair in keys.windows(2) {
                assert_eq!(
                    compare_utf16(pair[0], pair[1]),
                    core::cmp::Ordering::Less,
                    "键序 {} 应先于 {}",
                    pair[0],
                    pair[1]
                );
            }
        }
        // explanation 子对象键序单独断言(八字段)。
        let explanation = [
            "actualBytesLength",
            "alignmentBytes",
            "expectedBytesLength",
            "hints",
            "interpretedAs",
            "permissions",
            "regionId",
            "valueHex",
        ];
        for pair in explanation.windows(2) {
            assert_eq!(
                compare_utf16(pair[0], pair[1]),
                core::cmp::Ordering::Less,
                "解释字段键序 {} 应先于 {}",
                pair[0],
                pair[1]
            );
        }
    }

    fn register(name: &str, value: u64) -> PublicRegister {
        PublicRegister {
            name: String::from(name),
            value: ArchValue::new(value, vm_core::arch::ArchBits::B64),
        }
    }

    #[test]
    fn register_canonical_uppercase_value_hex() {
        assert_eq!(
            register("RAX", 0x0000_ff10).to_canonical(),
            "{\"name\":\"RAX\",\"valueHex\":\"0xFF10\"}"
        );
        assert_eq!(
            register("RSP", 0).to_canonical(),
            "{\"name\":\"RSP\",\"valueHex\":\"0x0\"}"
        );
    }

    #[test]
    fn region_canonical_with_and_without_truncation() {
        let region = VisibleMemoryRegion {
            region_id: String::from("stack"),
            label: String::from("栈"),
            start: 0x7FFF_F000,
            byte_length: 4096,
            permissions: String::from("rw"),
            bytes: vec![0xde, 0xad],
            truncated: false,
        };
        assert_eq!(
            region.to_canonical(),
            "{\"byteLength\":4096,\"bytesHex\":\"dead\",\"label\":\"栈\",\
             \"permissions\":\"rw\",\"regionId\":\"stack\",\
             \"startAddressHex\":\"0x7FFFF000\",\"truncated\":false}"
        );
        // presence-only:truncated=false 不产生键;true 产生字面 true。
        let mut truncated = region.clone();
        truncated.truncated = true;
        assert!(truncated.to_canonical().contains(",\"truncated\":true}"));
        assert!(!region.to_canonical().contains("\"truncated\":true"));
    }

    #[test]
    fn control_flow_null_and_pause_forms() {
        let running = ControlFlow {
            current_instruction: CurrentInstruction {
                address: 0x40_0000,
                text: String::from("mov RAX, 0x1"),
            },
            paused_on: None,
        };
        assert_eq!(
            running.to_canonical(),
            "{\"currentInstruction\":{\"addressHex\":\"0x400000\",\"text\":\"mov RAX, 0x1\"},\
             \"pausedOn\":null}"
        );
        let paused = ControlFlow {
            paused_on: Some(PauseKind::Write),
            ..running
        };
        assert!(paused.to_canonical().ends_with(",\"pausedOn\":\"write\"}"));
    }

    #[test]
    fn event_canonical_payload_length_and_absent_fields() {
        let full = PublicEvent {
            seq: 3,
            kind: PublicEventKind::Write,
            address: Some(0x1000),
            byte_length: Some(2),
            payload: Some(vec![0xab, 0xcd]),
            truncated: false,
        };
        assert_eq!(
            full.to_canonical(),
            "{\"addressHex\":\"0x1000\",\"byteLength\":2,\"kind\":\"write\",\
             \"payloadHex\":\"abcd\",\"seq\":3}"
        );
        // 无地址 / 无载荷形态(syscall / exception):可选键整体缺席,无 null。
        let bare = PublicEvent {
            seq: 0,
            kind: PublicEventKind::Syscall,
            address: None,
            byte_length: None,
            payload: None,
            truncated: false,
        };
        assert_eq!(bare.to_canonical(), "{\"kind\":\"syscall\",\"seq\":0}");
        // 聚合标记 presence-only。
        let mut aggregate = bare.clone();
        aggregate.truncated = true;
        assert_eq!(
            aggregate.to_canonical(),
            "{\"kind\":\"syscall\",\"seq\":0,\"truncated\":true}"
        );
    }

    #[test]
    fn error_canonical_three_address_forms() {
        let base = |address| PublicError {
            code: PublicErrorCode::InaccessibleAddress,
            message: String::from("m"),
            address,
            explanation: None,
        };
        // forbidden = 键缺席;null-only = 键带 null;required-real = 真实地址。
        // explanation 缺席 = 键整体缺席。
        assert_eq!(
            base(ErrorAddress::Absent).to_canonical(),
            "{\"code\":\"inaccessible_address\",\"message\":\"m\"}"
        );
        assert_eq!(
            base(ErrorAddress::Null).to_canonical(),
            "{\"addressHex\":null,\"code\":\"inaccessible_address\",\"message\":\"m\"}"
        );
        assert_eq!(
            base(ErrorAddress::Real(0x40)).to_canonical(),
            "{\"addressHex\":\"0x40\",\"code\":\"inaccessible_address\",\"message\":\"m\"}"
        );
    }

    #[test]
    fn error_explanation_canonical_field_subset() {
        let error = PublicError {
            code: PublicErrorCode::PermissionDenied,
            message: String::from("m"),
            address: ErrorAddress::Real(0x7FFF_F010),
            explanation: Some(ErrorExplanation {
                region_id: Some(String::from("stack")),
                permissions: Some(String::from("rw")),
                hints: Some(vec![String::from("检查段寄存器")]),
                ..ErrorExplanation::default()
            }),
        };
        // 未设置的解释字段键整体缺席(optional 形态拒绝 null)。
        assert_eq!(
            error.to_canonical(),
            "{\"addressHex\":\"0x7FFFF010\",\"code\":\"permission_denied\",\
             \"explanation\":{\"hints\":[\"检查段寄存器\"],\"permissions\":\"rw\",\
             \"regionId\":\"stack\"},\"message\":\"m\"}"
        );
    }

    #[test]
    fn delta_canonical_omits_absent_optional_fields() {
        let delta = ProjectionDelta {
            revision: 9,
            dirty_ranges: Vec::new(),
            changed_registers: vec![register("RAX", 1)],
            control_flow: None,
            status: Some(PublicStatus::Paused),
            call_stack_summary: None,
            semantic_highlights: None,
        };
        assert_eq!(
            delta.to_canonical(),
            "{\"changedRegisters\":[{\"name\":\"RAX\",\"valueHex\":\"0x1\"}],\
             \"dirtyRanges\":[],\"revision\":9,\"status\":\"paused\"}"
        );
    }

    #[test]
    fn action_projection_rejected_couples_null_delta_empty_events() {
        let response = ActionProjection::rejected(
            7,
            PublicError {
                code: PublicErrorCode::SessionTerminal,
                message: String::from("会话已终态"),
                address: ErrorAddress::Absent,
                explanation: None,
            },
        );
        // rejected 形态:session_terminal 地址面 forbidden → 键整体缺席。
        assert_eq!(
            response.to_canonical(),
            "{\"projectionDelta\":null,\"publicEvents\":[],\"revision\":7,\
             \"status\":\"rejected\",\"userVisibleError\":{\"code\":\"session_terminal\",\
             \"message\":\"会话已终态\"}}"
        );
        // userVisibleError 缺席 = 键整体缺席(optional)。
        let clean = ActionProjection {
            revision: 1,
            status: ResponseStatus::Running,
            delta: None,
            events: Vec::new(),
            error: None,
        };
        assert_eq!(
            clean.to_canonical(),
            "{\"projectionDelta\":null,\"publicEvents\":[],\"revision\":1,\
             \"status\":\"running\"}"
        );
    }

    #[test]
    fn address_format_matches_arch_value_format_hex() {
        for raw in [0u64, 0x1, 0xdead_beef, 0x7fff_ffff_ffff_ffff] {
            assert_eq!(
                format_address(raw),
                ArchValue::new(raw, vm_core::arch::ArchBits::B64).format_hex()
            );
        }
    }
}

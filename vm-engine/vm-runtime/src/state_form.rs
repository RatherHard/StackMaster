//! `VmState` 的确定性规范化形态 v1(`stackmaster-vmstate/1`):状态哈希、
//! 快照载荷的状态段与状态重建(导入侧)。
//!
//! # 形态定位(为什么 `VmState` 有序列化形态)
//!
//! `VmState` 是 SERVER_ONLY 类型:**没有契约**,只有禁令(数据分类清单 §3.1
//! 规则 1——无 serde 派生、无契约 JSON 形态)。本模块的规范化形态**不是契约**:
//! 它是引擎内部的确定性编码,只服务于两个引擎侧目的——
//!
//! 1. **状态哈希**(6.3"前后状态哈希"):规范化序列化(§三文法)+ SHA-256,
//!    输入与本模块 [`STATE_FORM_ID`] 绑定,形态漂移 = 引擎语义变更 = 引擎
//!    版本演进(版本策略:确定性由 `vmEngineVersion` 锁定);
//! 2. **快照载荷**(引擎进程协议 §四 D-F5:`payload` 形态归 WP-6)与回放
//!    日志的哈希比对——只在信任域 3 / 4(执行域与 verifier)内流转,**永不
//!    跨越进程边界下发给浏览器或编排器**。
//!
//! 哈希输入包含完整冻结 8 字段(含 `seedState` 状态字节):单逐 SHA-256 且
//! 只在服务端流转,不构成 seed 泄露面(9.2;版本策略 §三记录项 #5 的
//! "不含 seed 值"约束作用于回放**元数据**,不是单逐哈希的输入面)。
//!
//! # 值层规则(规范化序列化 §四,发射面)
//!
//! 地址 / 架构值:小写 `0x` 前缀、按架构位宽左补零(32 位 → 8 位数字);
//! 字节序列:小写、偶数长度。整数全部经安全整数域守卫(§二)。

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec;
use alloc::vec::Vec;

use vm_core::arch::{ArchBits, ArchValue};
use vm_core::memory::{
    ExecutionMode, MemoryConfigError, RegionContents, RegionKind, RegionSpec, RestorePageError,
    VirtualMemory,
};
use vm_core::registers::{RegisterError, RegisterFile, is_flag_name};
use vm_core::state::{
    Budget, CallFrame, CumulativeBudget, RuntimeConstraints, SeedState, SeedStrategy, VmEvent,
    VmEventKind, VmState, VmStatus,
};

use crate::canon::{CanonError, CanonValue, parse_canonical, write_canonical};
use crate::sha256::{hex, sha256};

/// 状态规范化形态标识(v1;形态变更 = 引擎语义变更,联动 `vmEngineVersion`)。
pub const STATE_FORM_ID: &str = "stackmaster-vmstate/1";

/// 状态形态错误(方向注释:调用方映射——导入路径 = challenge_invalid,
/// 导出 / 哈希路径 = engine_error)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateFormError {
    /// 规范化序列化失败(整数越界 / 深度越界 / 键重复)。
    Canon(CanonError),
    /// 顶层不是对象或形态标识不符。
    FormMismatch,
    /// 字段形态非法(类型 / 枚举值 / 十六进制)。
    FieldShape(&'static str),
    /// 与锚定布局不一致(架构 / 页大小 / 区域 / 寄存器集 / 预算上限 / seed 策略)。
    LayoutMismatch(&'static str),
    /// 状态重建被 vm-core 拒绝(镜像复验;导入侧 challenge_invalid)。
    Rebuild(&'static str),
}

impl From<CanonError> for StateFormError {
    fn from(value: CanonError) -> Self {
        StateFormError::Canon(value)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 值层规则:十六进制发射与解析(§四)
// ─────────────────────────────────────────────────────────────────────────────

/// 地址 / 架构值规范形态:小写 `0x` 前缀 + 按位宽左补零。
pub fn format_addr(value: ArchValue, arch: ArchBits) -> String {
    format!(
        "0x{:0width$x}",
        value.get(),
        width = (arch.bits() / 4) as usize
    )
}

/// 字节序列规范形态:小写、偶数长度。
pub fn format_bytes(bytes: &[u8]) -> String {
    hex(bytes)
}

/// 解析位宽补齐的 `0x` 形态(先按不定宽解析,再复验值域)。
fn parse_addr(text: &str, arch: ArchBits) -> Result<ArchValue, StateFormError> {
    ArchValue::parse_hex(text, arch).map_err(|_| StateFormError::FieldShape("hex_value"))
}

// ─────────────────────────────────────────────────────────────────────────────
// 枚举 ↔ 协议字符串(引擎内部形态,与冻结词汇对齐)
// ─────────────────────────────────────────────────────────────────────────────

fn status_str(status: VmStatus) -> &'static str {
    match status {
        VmStatus::Running => "running",
        VmStatus::Paused => "paused",
        VmStatus::Won => "won",
        VmStatus::Failed => "failed",
    }
}

fn status_from(text: &str) -> Option<VmStatus> {
    Some(match text {
        "running" => VmStatus::Running,
        "paused" => VmStatus::Paused,
        "won" => VmStatus::Won,
        "failed" => VmStatus::Failed,
        _ => return None,
    })
}

fn region_kind_str(kind: RegionKind) -> &'static str {
    match kind {
        RegionKind::Code => "code",
        RegionKind::Global => "global",
        RegionKind::Heap => "heap",
        RegionKind::Stack => "stack",
        RegionKind::Key => "key",
        RegionKind::Custom => "custom",
    }
}

fn event_kind_str(kind: VmEventKind) -> &'static str {
    match kind {
        VmEventKind::Read => "read",
        VmEventKind::Write => "write",
        VmEventKind::Call => "call",
        VmEventKind::Ret => "ret",
        VmEventKind::Syscall => "syscall",
        VmEventKind::Exception => "exception",
        VmEventKind::Internal => "internal",
        VmEventKind::FileGranted => "file_granted",
        VmEventKind::FileRead => "file_read",
    }
}

fn event_kind_from(text: &str) -> Option<VmEventKind> {
    Some(match text {
        "read" => VmEventKind::Read,
        "write" => VmEventKind::Write,
        "call" => VmEventKind::Call,
        "ret" => VmEventKind::Ret,
        "syscall" => VmEventKind::Syscall,
        "exception" => VmEventKind::Exception,
        "internal" => VmEventKind::Internal,
        "file_granted" => VmEventKind::FileGranted,
        "file_read" => VmEventKind::FileRead,
        _ => return None,
    })
}

fn seed_strategy_str(strategy: SeedStrategy) -> &'static str {
    match strategy {
        SeedStrategy::Fixed => "fixed",
        SeedStrategy::ServerRandomPerSession => "server_random_per_session",
    }
}

fn seed_strategy_from(text: &str) -> Option<SeedStrategy> {
    Some(match text {
        "fixed" => SeedStrategy::Fixed,
        "server_random_per_session" => SeedStrategy::ServerRandomPerSession,
        _ => return None,
    })
}

fn mode_str(mode: ExecutionMode) -> &'static str {
    match mode {
        ExecutionMode::Ir => "ir",
        ExecutionMode::ByteCode => "bytecode",
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 发射:VmState → CanonValue
// ─────────────────────────────────────────────────────────────────────────────

/// `VmState` → 规范化形态 v1(冻结 8 字段全覆盖;确定性由容器有序性保证)。
pub fn state_to_canonical(state: &VmState) -> Result<CanonValue, CanonError> {
    let arch = state.memory.arch();
    let mut registers: Vec<(String, CanonValue)> = Vec::new();
    for (name, value) in state.registers.iter() {
        registers.push((
            String::from(name),
            CanonValue::Str(format_addr(value, arch)),
        ));
    }
    let flags = CanonValue::object(vec![
        ("cf", CanonValue::Bool(state.registers.flags.cf)),
        ("sf", CanonValue::Bool(state.registers.flags.sf)),
        ("zf", CanonValue::Bool(state.registers.flags.zf)),
    ])?;
    let mut call_frames = Vec::new();
    for frame in &state.call_frames {
        let args: Result<Vec<CanonValue>, CanonError> = frame
            .args
            .iter()
            .map(|value| Ok(CanonValue::Str(format_addr(*value, arch))))
            .collect();
        call_frames.push(CanonValue::object(vec![
            ("args", CanonValue::Array(args?)),
            (
                "functionLabel",
                CanonValue::Str(frame.function_label.clone()),
            ),
            (
                "returnAddress",
                CanonValue::Str(format_addr(frame.return_address, arch)),
            ),
            (
                "savedRbp",
                CanonValue::Str(format_addr(frame.saved_rbp, arch)),
            ),
        ])?);
    }
    let mut regions = Vec::new();
    for region in state.memory.regions() {
        regions.push(CanonValue::object(vec![
            (
                "customLabel",
                match &region.custom_label {
                    Some(label) => CanonValue::Str(label.clone()),
                    None => CanonValue::Null,
                },
            ),
            ("id", CanonValue::Str(region.region_id.clone())),
            ("kind", CanonValue::str(region_kind_str(region.kind))),
            (
                "lastAddress",
                CanonValue::Str(format_addr(ArchValue::new(region.last_address, arch), arch)),
            ),
            ("lengthBytes", CanonValue::from_u64(region.byte_length)?),
            ("perms", CanonValue::str(region.permissions.as_str())),
            (
                "start",
                CanonValue::Str(format_addr(ArchValue::new(region.start, arch), arch)),
            ),
        ])?);
    }
    let mut pages = Vec::new();
    for page_no in state.memory.page_ids() {
        let bytes = state
            .memory
            .page_bytes(page_no)
            .ok_or(CanonError::Malformed)?;
        pages.push((page_no.to_string(), CanonValue::Str(format_bytes(bytes))));
    }
    let memory = CanonValue::object(vec![
        ("mode", CanonValue::str(mode_str(state.memory.mode()))),
        ("pages", CanonValue::Object(pages)),
        ("regions", CanonValue::Array(regions)),
    ])?;
    let mut events = Vec::new();
    for event in &state.private_event_log {
        events.push(CanonValue::object(vec![
            (
                "address",
                match event.address {
                    Some(address) => CanonValue::Str(format_addr(address, arch)),
                    None => CanonValue::Null,
                },
            ),
            (
                "byteLength",
                match event.byte_length {
                    Some(length) => CanonValue::from_u64(length)?,
                    None => CanonValue::Null,
                },
            ),
            ("kind", CanonValue::str(event_kind_str(event.kind))),
            (
                "payload",
                match &event.payload {
                    Some(payload) => CanonValue::Str(format_bytes(payload)),
                    None => CanonValue::Null,
                },
            ),
            ("seq", CanonValue::from_u64(event.seq)?),
        ])?);
    }
    let budget = |name: &'static str, budget: &Budget| -> Result<(&str, CanonValue), CanonError> {
        Ok((
            name,
            CanonValue::object(vec![
                ("limit", CanonValue::from_u64(budget.limit)?),
                ("used", CanonValue::from_u64(budget.used)?),
            ])?,
        ))
    };
    let constraints = CanonValue::object(vec![
        budget("actionLog", &state.constraints.action_log)?,
        (
            "callDepthLimit",
            CanonValue::from_u64(u64::from(state.constraints.call_depth_limit))?,
        ),
        (
            "memoryBytesLimit",
            CanonValue::from_u64(state.constraints.memory_bytes_limit)?,
        ),
        budget("outputBytes", &state.constraints.output_bytes)?,
        (
            "predicateEvals",
            CanonValue::object(vec![
                (
                    "limit",
                    CanonValue::from_u64(state.constraints.predicate_evals.limit)?,
                ),
                (
                    "used",
                    CanonValue::from_u64(state.constraints.predicate_evals.used)?,
                ),
            ])?,
        ),
        budget("rollbackOps", &state.constraints.rollback_ops)?,
        budget("steps", &state.constraints.steps)?,
        (
            "timeoutMsLimit",
            CanonValue::from_u64(state.constraints.timeout_ms_limit)?,
        ),
        (
            "wallClockMsLimit",
            CanonValue::from_u64(state.constraints.wall_clock_ms_limit)?,
        ),
    ])?;
    let seed_state = CanonValue::object(vec![
        (
            "stateBytes",
            CanonValue::Str(format_bytes(&state.seed_state.state_bytes)),
        ),
        (
            "strategy",
            CanonValue::str(seed_strategy_str(state.seed_state.strategy)),
        ),
        (
            "version",
            CanonValue::from_u64(u64::from(state.seed_state.version))?,
        ),
    ])?;
    CanonValue::object(vec![
        ("archBits", CanonValue::int(i64::from(arch.bits()))?),
        ("callFrames", CanonValue::Array(call_frames)),
        ("constraints", constraints),
        ("flags", flags),
        ("form", CanonValue::str(STATE_FORM_ID)),
        (
            "instructionPointer",
            CanonValue::Str(format_addr(state.instruction_pointer, arch)),
        ),
        ("memory", memory),
        ("privateEventLog", CanonValue::Array(events)),
        ("registers", CanonValue::Object(registers)),
        ("seedState", seed_state),
        ("status", CanonValue::str(status_str(state.status))),
    ])
}

/// 状态 → 规范化文本(形态观察与导入往返的文本入口)。
pub fn write_state_canonical(state: &VmState) -> Result<String, CanonError> {
    write_canonical(&state_to_canonical(state)?)
}

/// 状态哈希:规范化序列化的 UTF-8 字节序列的 SHA-256(§3.2)。
pub fn state_hash(state: &VmState) -> Result<[u8; 32], CanonError> {
    let text = write_canonical(&state_to_canonical(state)?)?;
    Ok(sha256(text.as_bytes()))
}

/// 状态哈希(小写十六进制 64 字符)。
pub fn state_hash_hex(state: &VmState) -> Result<String, CanonError> {
    Ok(hex(&state_hash(state)?))
}

// ─────────────────────────────────────────────────────────────────────────────
// 读回:CanonValue → VmState(以当前装载布局为锚;导入侧)
// ─────────────────────────────────────────────────────────────────────────────

fn as_object<'a>(
    value: &'a CanonValue,
    field: &'static str,
) -> Result<&'a Vec<(String, CanonValue)>, StateFormError> {
    match value {
        CanonValue::Object(pairs) => Ok(pairs),
        _ => Err(StateFormError::FieldShape(field)),
    }
}

fn as_array<'a>(
    value: &'a CanonValue,
    field: &'static str,
) -> Result<&'a Vec<CanonValue>, StateFormError> {
    match value {
        CanonValue::Array(items) => Ok(items),
        _ => Err(StateFormError::FieldShape(field)),
    }
}

fn get<'a>(pairs: &'a [(String, CanonValue)], key: &str) -> Result<&'a CanonValue, StateFormError> {
    pairs
        .iter()
        .find(|(existing, _)| existing == key)
        .map(|(_, value)| value)
        .ok_or(StateFormError::FieldShape("missing_field"))
}

fn as_u64(value: &CanonValue, field: &'static str) -> Result<u64, StateFormError> {
    match value {
        CanonValue::Int(number) if *number >= 0 => Ok(*number as u64),
        _ => Err(StateFormError::FieldShape(field)),
    }
}

fn as_str<'a>(value: &'a CanonValue, field: &'static str) -> Result<&'a str, StateFormError> {
    match value {
        CanonValue::Str(text) => Ok(text),
        _ => Err(StateFormError::FieldShape(field)),
    }
}

/// 解析小写偶长十六进制字节序列(值层规则;格式非法即拒绝)。
pub fn parse_bytes_hex(text: &str, field: &'static str) -> Result<Vec<u8>, StateFormError> {
    if !text.len().is_multiple_of(2) {
        return Err(StateFormError::FieldShape(field));
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    let bytes = text.as_bytes();
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char)
            .to_digit(16)
            .ok_or(StateFormError::FieldShape(field))?;
        let lo = (pair[1] as char)
            .to_digit(16)
            .ok_or(StateFormError::FieldShape(field))?;
        out.push(((hi << 4) | lo) as u8);
    }
    Ok(out)
}

/// 重建 `VmState`:以**当前装载布局**(锚)复验形态声明(架构 / 页大小 /
/// 执行模式 / 区域 / 寄存器与 FLAG 集 / 预算上限 / seed 策略),任一不符即
/// 整体拒绝(方向 challenge_invalid)——快照只承载内容状态,不携带布局。
pub fn state_from_canonical(
    value: &CanonValue,
    anchor: &VmState,
) -> Result<VmState, StateFormError> {
    let pairs = as_object(value, "root")?;
    if as_str(get(pairs, "form")?, "form")? != STATE_FORM_ID {
        return Err(StateFormError::FormMismatch);
    }
    let arch = anchor.memory.arch();
    if as_u64(get(pairs, "archBits")?, "archBits")? != u64::from(arch.bits()) {
        return Err(StateFormError::LayoutMismatch("archBits"));
    }
    if as_str(get(pairs, "status")?, "status")? != status_str(anchor.status) {
        // 状态锚定到锚的当前态之外是允许的(内容状态);此处只校验词汇合法,
        // 真正的 status 取自表单——先读出再装配。
    }
    let status = status_from(as_str(get(pairs, "status")?, "status")?)
        .ok_or(StateFormError::FieldShape("status"))?;
    let instruction_pointer = parse_addr(
        as_str(get(pairs, "instructionPointer")?, "instructionPointer")?,
        arch,
    )?;

    // 寄存器:名集必须与锚一致(装载布局承载声明面)。
    let register_pairs = as_object(get(pairs, "registers")?, "registers")?;
    let anchor_names: Vec<String> = anchor.registers.names().map(String::from).collect();
    let mut entries: Vec<(String, ArchValue)> = Vec::with_capacity(register_pairs.len());
    for (name, raw) in register_pairs {
        entries.push((
            name.clone(),
            parse_addr(as_str(raw, "register_value")?, arch)?,
        ));
    }
    let mut sorted_names: Vec<String> = entries.iter().map(|(name, _)| name.clone()).collect();
    sorted_names.sort();
    if sorted_names != anchor_names {
        return Err(StateFormError::LayoutMismatch("registers"));
    }
    let flag_names: Vec<String> = anchor_names
        .iter()
        .filter(|name| is_flag_name(name))
        .cloned()
        .collect();
    let mut registers = RegisterFile::new(entries, &flag_names)
        .map_err(|_| StateFormError::Rebuild("registers"))?;
    let flag_pairs = as_object(get(pairs, "flags")?, "flags")?;
    registers.flags.zf = match get(flag_pairs, "zf")? {
        CanonValue::Bool(flag) => *flag,
        _ => return Err(StateFormError::FieldShape("flags")),
    };
    registers.flags.cf = match get(flag_pairs, "cf")? {
        CanonValue::Bool(flag) => *flag,
        _ => return Err(StateFormError::FieldShape("flags")),
    };
    registers.flags.sf = match get(flag_pairs, "sf")? {
        CanonValue::Bool(flag) => *flag,
        _ => return Err(StateFormError::FieldShape("flags")),
    };

    // 内存:布局(区域 / 页大小 / 模式)自锚重建,页内容自形态恢复。
    let memory_pairs = as_object(get(pairs, "memory")?, "memory")?;
    if as_str(get(memory_pairs, "mode")?, "mode")? != mode_str(anchor.memory.mode()) {
        return Err(StateFormError::LayoutMismatch("execution_mode"));
    }
    let region_items = as_array(get(memory_pairs, "regions")?, "regions")?;
    let anchor_regions: Vec<RegionSpec> = anchor.memory.regions().cloned().collect();
    if region_items.len() != anchor_regions.len() {
        return Err(StateFormError::LayoutMismatch("regions"));
    }
    for (item, spec) in region_items.iter().zip(&anchor_regions) {
        let fields = as_object(item, "region")?;
        if as_str(get(fields, "id")?, "region_id")? != spec.region_id
            || as_str(get(fields, "kind")?, "region_kind")? != region_kind_str(spec.kind)
            || as_str(get(fields, "perms")?, "region_perms")? != spec.permissions.as_str()
            || as_str(get(fields, "start")?, "region_start")?
                != format_addr(ArchValue::new(spec.start, arch), arch)
            || as_str(get(fields, "lastAddress")?, "region_last")?
                != format_addr(ArchValue::new(spec.last_address, arch), arch)
            || as_u64(get(fields, "lengthBytes")?, "region_length")? != spec.byte_length
        {
            return Err(StateFormError::LayoutMismatch("regions"));
        }
        let custom = get(fields, "customLabel")?;
        match (&spec.custom_label, custom) {
            (None, CanonValue::Null) => {}
            (Some(label), CanonValue::Str(text)) if text == label => {}
            _ => return Err(StateFormError::LayoutMismatch("regions")),
        }
    }
    let contents = anchor_regions
        .iter()
        .map(|spec| RegionContents {
            region_id: spec.region_id.clone(),
            bytes: Vec::new(),
        })
        .collect();
    let mut memory = VirtualMemory::new(
        arch,
        anchor.memory.page_size(),
        anchor.memory.mode(),
        anchor_regions.clone(),
        contents,
    )
    .map_err(|error: MemoryConfigError| {
        StateFormError::Rebuild(match error {
            MemoryConfigError::PageSizeInvalid { .. } => "page_size",
            _ => "regions",
        })
    })?;
    let page_pairs = as_object(get(memory_pairs, "pages")?, "pages")?;
    let anchor_pages: Vec<u64> = anchor.memory.page_ids().collect();
    let mut form_pages: Vec<u64> = Vec::with_capacity(page_pairs.len());
    for (page_no_text, raw) in page_pairs {
        let page_no: u64 = page_no_text
            .parse()
            .map_err(|_| StateFormError::FieldShape("page_no"))?;
        form_pages.push(page_no);
        let bytes = parse_bytes_hex(as_str(raw, "page_bytes")?, "page_bytes")?;
        memory
            .restore_page(page_no, &bytes)
            .map_err(|error: RestorePageError| match error {
                RestorePageError::PageUnknown { .. } => StateFormError::LayoutMismatch("pages"),
                RestorePageError::LengthMismatch { .. } => StateFormError::FieldShape("page_bytes"),
            })?;
    }
    form_pages.sort();
    if form_pages != anchor_pages {
        return Err(StateFormError::LayoutMismatch("pages"));
    }

    // 调用帧。
    let mut call_frames = Vec::new();
    for item in as_array(get(pairs, "callFrames")?, "callFrames")? {
        let fields = as_object(item, "call_frame")?;
        let args = as_array(get(fields, "args")?, "call_frame_args")?
            .iter()
            .map(|value| parse_addr(as_str(value, "call_frame_arg")?, arch))
            .collect::<Result<Vec<_>, _>>()?;
        call_frames.push(CallFrame {
            function_label: String::from(as_str(get(fields, "functionLabel")?, "function_label")?),
            return_address: parse_addr(
                as_str(get(fields, "returnAddress")?, "return_address")?,
                arch,
            )?,
            saved_rbp: parse_addr(as_str(get(fields, "savedRbp")?, "saved_rbp")?, arch)?,
            args,
        });
    }

    // 私有事件日志(append-only 全量承载)。
    let mut private_event_log = Vec::new();
    for item in as_array(get(pairs, "privateEventLog")?, "privateEventLog")? {
        let fields = as_object(item, "event")?;
        let address = match get(fields, "address")? {
            CanonValue::Null => None,
            raw => Some(parse_addr(as_str(raw, "event_address")?, arch)?),
        };
        let byte_length = match get(fields, "byteLength")? {
            CanonValue::Null => None,
            raw => Some(as_u64(raw, "event_length")?),
        };
        let payload = match get(fields, "payload")? {
            CanonValue::Null => None,
            raw => Some(parse_bytes_hex(
                as_str(raw, "event_payload")?,
                "event_payload",
            )?),
        };
        private_event_log.push(VmEvent {
            seq: as_u64(get(fields, "seq")?, "event_seq")?,
            kind: event_kind_from(as_str(get(fields, "kind")?, "event_kind")?)
                .ok_or(StateFormError::FieldShape("event_kind"))?,
            address,
            byte_length,
            payload,
        });
    }

    // 约束:上限必须与锚一致;used 取形态值。
    let constraint_pairs = as_object(get(pairs, "constraints")?, "constraints")?;
    let anchor_constraints = &anchor.constraints;
    let budget_from = |key: &str, anchor_budget: &Budget| -> Result<Budget, StateFormError> {
        let fields = as_object(get(constraint_pairs, key)?, "budget")?;
        let limit = as_u64(get(fields, "limit")?, "budget_limit")?;
        let used = as_u64(get(fields, "used")?, "budget_used")?;
        if limit != anchor_budget.limit {
            return Err(StateFormError::LayoutMismatch("budget_limit"));
        }
        Ok(Budget::new(used, limit))
    };
    let constraints = RuntimeConstraints {
        steps: budget_from("steps", &anchor_constraints.steps)?,
        memory_bytes_limit: {
            let value = as_u64(get(constraint_pairs, "memoryBytesLimit")?, "memory_limit")?;
            if value != anchor_constraints.memory_bytes_limit {
                return Err(StateFormError::LayoutMismatch("memory_bytes_limit"));
            }
            value
        },
        wall_clock_ms_limit: {
            let value = as_u64(
                get(constraint_pairs, "wallClockMsLimit")?,
                "wall_clock_limit",
            )?;
            if value != anchor_constraints.wall_clock_ms_limit {
                return Err(StateFormError::LayoutMismatch("wall_clock_ms_limit"));
            }
            value
        },
        call_depth_limit: {
            let value = as_u64(get(constraint_pairs, "callDepthLimit")?, "call_depth_limit")?;
            if value != u64::from(anchor_constraints.call_depth_limit) {
                return Err(StateFormError::LayoutMismatch("call_depth_limit"));
            }
            u32::try_from(value).map_err(|_| StateFormError::FieldShape("call_depth_limit"))?
        },
        action_log: budget_from("actionLog", &anchor_constraints.action_log)?,
        output_bytes: budget_from("outputBytes", &anchor_constraints.output_bytes)?,
        timeout_ms_limit: {
            let value = as_u64(get(constraint_pairs, "timeoutMsLimit")?, "timeout_limit")?;
            if value != anchor_constraints.timeout_ms_limit {
                return Err(StateFormError::LayoutMismatch("timeout_ms_limit"));
            }
            value
        },
        predicate_evals: {
            let fields = as_object(get(constraint_pairs, "predicateEvals")?, "budget")?;
            let limit = as_u64(get(fields, "limit")?, "budget_limit")?;
            let used = as_u64(get(fields, "used")?, "budget_used")?;
            if limit != anchor_constraints.predicate_evals.limit {
                return Err(StateFormError::LayoutMismatch("budget_limit"));
            }
            CumulativeBudget::new(used, limit)
        },
        rollback_ops: budget_from("rollbackOps", &anchor_constraints.rollback_ops)?,
    };

    // seed 状态:策略与版本必须与锚一致;状态字节承载内容(秘密,只入哈希)。
    let seed_pairs = as_object(get(pairs, "seedState")?, "seedState")?;
    let strategy = seed_strategy_from(as_str(get(seed_pairs, "strategy")?, "seed_strategy")?)
        .ok_or(StateFormError::FieldShape("seed_strategy"))?;
    if strategy != anchor.seed_state.strategy
        || as_u64(get(seed_pairs, "version")?, "seed_version")?
            != u64::from(anchor.seed_state.version)
    {
        return Err(StateFormError::LayoutMismatch("seed_state"));
    }
    let seed_state = SeedState {
        strategy,
        version: anchor.seed_state.version,
        state_bytes: parse_bytes_hex(
            as_str(get(seed_pairs, "stateBytes")?, "seed_bytes")?,
            "seed_bytes",
        )?,
    };

    Ok(VmState {
        registers,
        memory,
        call_frames,
        instruction_pointer,
        private_event_log,
        constraints,
        seed_state,
        status,
    })
}

/// 解析规范化文本并重建状态(导入路径入口)。
pub fn state_from_canonical_text(text: &str, anchor: &VmState) -> Result<VmState, StateFormError> {
    state_from_canonical(&parse_canonical(text)?, anchor)
}

/// 寄存器装配错误透传(锚寄存器集重建的防御分支;方向 challenge_invalid)。
impl From<RegisterError> for StateFormError {
    fn from(_: RegisterError) -> Self {
        StateFormError::Rebuild("registers")
    }
}

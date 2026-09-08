//! 错误粗化:16 错误码 + 能力矩阵的生成侧强制(WP-1 §4.4 / §6.3 E-1–E-6 /
//! 10.1 粗化矩阵;ZR-P6 机检承接)。
//!
//! # 生成侧纪律(矩阵是构造期结构,不是约定)
//!
//! - **能力矩阵逐 code 冻结**(`addressHex` 四形态 + explanation 允许面):
//!   矩阵之外的组合在构造期即 [`CoarsenError::CapabilityViolated`]——引擎侧
//!   缺陷以 fail-closed 暴露,不静默剥离、不近似下发(沿装配镜像复验纪律);
//! - **coarse 级载荷零解释字段**(10.1:正式判题与 verifier 语境):
//!   [`ErrorDraft::finish`] 在 coarse 级整体剥离 explanation,ZR-P6 的
//!   "coarse 载荷只含 code + message" 由生成侧结构性保证;
//! - **I-9 统一形态**:一切不可见地址上的故障(隐藏映射 / 未映射 / 回绕,
//!   含隐藏区域上的权限故障)统一粗化为 `inaccessible_address`(`addressHex`
//!   恒 null)——错误码与地址形态不携带隐藏区域存在性信息;
//! - **E-2 / E-3 值来源**:`required-real` / `free` 的真实地址必须落在可见
//!   区域(`finish` 期对照内存布局复核);`expectedBytesLength` 等解释数值
//!   由调用方从公开上限 / 可见区域边界取值,`valueHex` 只承载玩家输入或
//!   可见内容回显;
//! - **E-5 静态模板**:`message` 按 `f(code)` 常量模板生成(参数化是允许面
//!   而非义务;常量模板使 ZR-P6 的"相同 (code, 级别) 载荷字节一致"平凡成立);
//!   `hints` 为逐 code 静态教学提示(≤ 4 条,静态模板类,I-10)。

use alloc::string::String;
use alloc::vec::Vec;

use vm_core::arch::{ArchBits, ArchValue};
use vm_core::exec::ExecError;
use vm_core::memory::{MemoryFault, MemoryFaultKind, VirtualMemory};

use crate::policy::{ErrorDetailLevel, ProjectionPolicy};
use crate::types::{ErrorAddress, ErrorExplanation, InterpretedAs, PublicError, PublicErrorCode};

/// 地址形态(能力矩阵第一轴;WP-1 §4.4 冻结四种)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressHexMode {
    /// 字段必须整体缺席(显式 null 也不允许)。
    Forbidden,
    /// 恒为 null 统一占位(I-9)。
    NullOnly,
    /// 真实地址 | null | 缺席,由 (code, 级别) 确定性选择;真实地址须可见。
    Free,
    /// 必须携带真实可见地址(教学解释锚点)。
    RequiredReal,
}

/// 解释字段白名单(能力矩阵第二轴;`&[]` = explanation 整体缺席)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExplanationCapability {
    /// 是否允许携带 explanation。
    pub allowed: bool,
    /// 允许出现的字段(allowed = false 时为空,静态保证)。
    pub fields: &'static [ExplanationField],
}

/// 解释字段白名单键(契约 `explanation` 八字段)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExplanationField {
    /// 可见区域标识。
    RegionId,
    /// 权限事实。
    Permissions,
    /// 被解释的值。
    ValueHex,
    /// 位宽 × 端序。
    InterpretedAs,
    /// 对齐要求。
    AlignmentBytes,
    /// 期望长度。
    ExpectedBytesLength,
    /// 实际长度。
    ActualBytesLength,
    /// 教学提示。
    Hints,
}

impl ExplanationField {
    fn allows(self, explanation: &ErrorExplanation) -> bool {
        match self {
            ExplanationField::RegionId => explanation.region_id.is_some(),
            ExplanationField::Permissions => explanation.permissions.is_some(),
            ExplanationField::ValueHex => explanation.value_hex.is_some(),
            ExplanationField::InterpretedAs => explanation.interpreted_as.is_some(),
            ExplanationField::AlignmentBytes => explanation.alignment_bytes.is_some(),
            ExplanationField::ExpectedBytesLength => explanation.expected_bytes_length.is_some(),
            ExplanationField::ActualBytesLength => explanation.actual_bytes_length.is_some(),
            ExplanationField::Hints => explanation.hints.is_some(),
        }
    }
}

use ExplanationField as EF;

/// 逐 code 能力矩阵(冻结;与 `@stackmaster/protocol` 的
/// `ERROR_CODE_CAPABILITIES` 一一对应——漂移由 vm-worker Schema 闭环测试锁定)。
pub fn capabilities(code: PublicErrorCode) -> (AddressHexMode, ExplanationCapability) {
    use PublicErrorCode as C;
    const NONE: &[EF] = &[];
    const HINTS: &[EF] = &[EF::Hints];
    match code {
        C::InvalidInputFormat => (
            AddressHexMode::Forbidden,
            ExplanationCapability {
                allowed: true,
                fields: HINTS,
            },
        ),
        C::InvalidPayloadLength => (
            AddressHexMode::Free,
            ExplanationCapability {
                allowed: true,
                fields: &[
                    EF::RegionId,
                    EF::ExpectedBytesLength,
                    EF::ActualBytesLength,
                    EF::Hints,
                ],
            },
        ),
        C::OffsetOutOfRange => (
            AddressHexMode::Free,
            ExplanationCapability {
                allowed: true,
                fields: &[
                    EF::RegionId,
                    EF::ExpectedBytesLength,
                    EF::ActualBytesLength,
                    EF::Hints,
                ],
            },
        ),
        C::EndiannessMismatch => (
            AddressHexMode::Forbidden,
            ExplanationCapability {
                allowed: true,
                fields: &[EF::ValueHex, EF::InterpretedAs, EF::Hints],
            },
        ),
        C::PermissionDenied => (
            AddressHexMode::RequiredReal,
            ExplanationCapability {
                allowed: true,
                fields: &[EF::RegionId, EF::Permissions, EF::Hints],
            },
        ),
        C::InvalidRip => (
            AddressHexMode::Free,
            ExplanationCapability {
                allowed: true,
                fields: &[
                    EF::RegionId,
                    EF::Permissions,
                    EF::ValueHex,
                    EF::InterpretedAs,
                    EF::AlignmentBytes,
                    EF::Hints,
                ],
            },
        ),
        C::CanaryViolation => (
            AddressHexMode::RequiredReal,
            ExplanationCapability {
                allowed: true,
                fields: &[EF::RegionId, EF::ValueHex, EF::Hints],
            },
        ),
        C::InvalidCallArgument => (
            AddressHexMode::Forbidden,
            ExplanationCapability {
                allowed: true,
                fields: &[EF::ValueHex, EF::Hints],
            },
        ),
        C::ObjectiveNotMet => (
            AddressHexMode::Forbidden,
            ExplanationCapability {
                allowed: false,
                fields: NONE,
            },
        ),
        C::InaccessibleAddress => (
            AddressHexMode::NullOnly,
            ExplanationCapability {
                allowed: true,
                fields: &[EF::ValueHex, EF::Hints],
            },
        ),
        C::BudgetExhausted
        | C::StaleBaseRevision
        | C::StaleClientSeq
        | C::IdempotencyConflict
        | C::SessionTerminal
        | C::InternalError => (
            AddressHexMode::Forbidden,
            ExplanationCapability {
                allowed: false,
                fields: NONE,
            },
        ),
    }
}

/// 静态最小文案(E-5;`f(code)` 常量模板,1–512 字符,静态模板类 I-10)。
pub fn static_message(code: PublicErrorCode) -> &'static str {
    use PublicErrorCode as C;
    match code {
        C::InvalidInputFormat => "输入格式不合法",
        C::InvalidPayloadLength => "payload 长度不符合要求",
        C::OffsetOutOfRange => "写入越出可见区域边界",
        C::EndiannessMismatch => "值的端序解释与题目不符",
        C::PermissionDenied => "目标地址权限不足",
        C::InvalidRip => "该值不能作为执行位置",
        C::CanaryViolation => "栈保护值(canary)被破坏",
        C::InvalidCallArgument => "调用参数不满足调用约定",
        C::ObjectiveNotMet => "目标条件未满足",
        C::InaccessibleAddress => "目标地址不可访问",
        C::BudgetExhausted => "资源预算已耗尽",
        C::StaleBaseRevision => "基线版本过期,请先同步投影",
        C::StaleClientSeq => "动作序号乱序",
        C::IdempotencyConflict => "幂等键冲突",
        C::SessionTerminal => "会话已结束",
        C::InternalError => "内部错误",
    }
}

/// 静态教学提示(E-5 / 10.1 educational 列;静态模板类,每 code 至多一组)。
fn static_hints(code: PublicErrorCode) -> &'static [&'static str] {
    use PublicErrorCode as C;
    match code {
        C::InvalidInputFormat => &["检查十六进制与字段形态"],
        C::InvalidPayloadLength => &["对照区域长度检查 payload 字节数"],
        C::OffsetOutOfRange => &["从区域起始地址重新计算偏移"],
        C::EndiannessMismatch => &["注意 little-endian 字节序"],
        C::PermissionDenied => &["检查区域权限:写入需要 w,执行需要 x"],
        C::InvalidRip => &["返回地址必须是代码区内的指令地址"],
        C::CanaryViolation => &["写入前检查 canary 槽位,保留栈保护值"],
        C::InvalidCallArgument => &["按调用约定把参数放入约定寄存器"],
        C::ObjectiveNotMet => &[],
        C::InaccessibleAddress => &["确认目标地址位于可见区域"],
        C::BudgetExhausted | C::InternalError => &[],
        C::StaleBaseRevision => &["以 sync-projection 重新对齐后重试"],
        C::StaleClientSeq => &["按服务端确认序号顺延"],
        C::IdempotencyConflict => &["同键重放需携带相同内容"],
        C::SessionTerminal => &["会话终态后不可继续执行动作"],
    }
}

/// 粗化面拒绝(方向 = `engine_error`:能力矩阵违规只可能是引擎缺陷;
/// 装配面静态模板超限属装载缺陷,同为安全终止)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoarsenError {
    /// 构造载荷违反能力矩阵(字段 / 地址形态与 code 不匹配)。
    CapabilityViolated,
    /// 静态模板形态非法(空 / 超 512,或提示超 4 条 / 单条超 256 / 含控制字符)。
    StaticTextMalformed,
}

/// 错误草稿:逐字段构造 + 矩阵强制 + 级别粗化([`ErrorDraft::finish`] 是唯一出口)。
#[derive(Debug, Clone)]
pub struct ErrorDraft {
    code: PublicErrorCode,
    address: ErrorAddress,
    explanation: ErrorExplanation,
}

impl ErrorDraft {
    /// 起草(地址缺省 Absent,解释缺省空)。
    pub fn new(code: PublicErrorCode) -> Self {
        Self {
            code,
            address: ErrorAddress::Absent,
            explanation: ErrorExplanation::default(),
        }
    }

    /// 携带真实地址(E-2:必须落在可见区域;`finish` 期复核)。
    pub fn real_address(mut self, address: u64) -> Self {
        self.address = ErrorAddress::Real(address);
        self
    }

    /// 不可见地址统一占位(I-9;null-only 码的规范形态)。
    pub fn null_address(mut self) -> Self {
        self.address = ErrorAddress::Null;
        self
    }

    /// 设置解释字段(矩阵允许面之外的取值在 `finish` 期 fail-closed)。
    pub fn explanation(mut self, configure: impl FnOnce(&mut ErrorExplanation)) -> Self {
        configure(&mut self.explanation);
        self
    }

    /// 完成:矩阵强制 + 级别粗化 + 静态模板展开(唯一出口)。
    pub fn finish(
        self,
        policy: &ProjectionPolicy,
        memory: &VirtualMemory,
    ) -> Result<PublicError, CoarsenError> {
        let (address_mode, explanation_cap) = capabilities(self.code);
        let coarse = policy.error_detail_level() == ErrorDetailLevel::Coarse;

        // ── 地址形态裁决 ──
        let address = match (address_mode, self.address, coarse) {
            // forbidden:任何携带(含 null)即违规。
            (AddressHexMode::Forbidden, ErrorAddress::Absent, _) => ErrorAddress::Absent,
            (AddressHexMode::Forbidden, _, _) => return Err(CoarsenError::CapabilityViolated),
            // null-only:恒为 null(educational 下显式真实地址即违规;
            // coarse 同形态——矩阵是结构性约束,不受级别影响)。
            (AddressHexMode::NullOnly, ErrorAddress::Real(_), _) => {
                return Err(CoarsenError::CapabilityViolated);
            }
            (AddressHexMode::NullOnly, _, _) => ErrorAddress::Null,
            // required-real:必须真实可见(coarse 亦然——地址是错误锚点,
            // 10.1 coarse 列的"✗"指自由地址形态,不豁免结构性必填)。
            (AddressHexMode::RequiredReal, ErrorAddress::Real(addr), _) => {
                if !policy.is_address_visible(memory, addr) {
                    return Err(CoarsenError::CapabilityViolated);
                }
                ErrorAddress::Real(addr)
            }
            (AddressHexMode::RequiredReal, _, _) => {
                return Err(CoarsenError::CapabilityViolated);
            }
            // free:educational 携带真实可见地址;coarse 按地址行"✗"整体缺席
            // (不可见地址在任何级别都是 Null,不进入 free 分支——统一占位)。
            (AddressHexMode::Free, ErrorAddress::Real(addr), false) => {
                if !policy.is_address_visible(memory, addr) {
                    return Err(CoarsenError::CapabilityViolated);
                }
                ErrorAddress::Real(addr)
            }
            (AddressHexMode::Free, ErrorAddress::Real(_), true) => ErrorAddress::Absent,
            (AddressHexMode::Free, ErrorAddress::Null, _) => ErrorAddress::Null,
            (AddressHexMode::Free, ErrorAddress::Absent, _) => ErrorAddress::Absent,
        };

        // ── explanation 裁决 ──
        let explanation = if coarse || !explanation_cap.allowed {
            // coarse 零解释(ZR-P6)+ forbidden 码恒零解释(E-4 / I-7):
            // 整体剥离;forbidden 码若被构造了任何解释字段即违规。
            if !explanation_cap.allowed && self.explanation != ErrorExplanation::default() {
                return Err(CoarsenError::CapabilityViolated);
            }
            None
        } else {
            // 字段白名单:矩阵外字段构造即违规(fail-closed,不静默剥离)。
            for field in [
                EF::RegionId,
                EF::Permissions,
                EF::ValueHex,
                EF::InterpretedAs,
                EF::AlignmentBytes,
                EF::ExpectedBytesLength,
                EF::ActualBytesLength,
                EF::Hints,
            ] {
                if !explanation_cap.fields.contains(&field) && field.allows(&self.explanation) {
                    return Err(CoarsenError::CapabilityViolated);
                }
            }
            // 对齐字面量域(1 | 2 | 4 | 8)。
            if let Some(alignment) = self.explanation.alignment_bytes
                && !matches!(alignment, 1 | 2 | 4 | 8)
            {
                return Err(CoarsenError::CapabilityViolated);
            }
            // hints 静态模板形态(≤ 4 条、单条 ≤ 256、无控制字符)。
            if let Some(hints) = &self.explanation.hints {
                if hints.len() > 4 {
                    return Err(CoarsenError::StaticTextMalformed);
                }
                for hint in hints {
                    if hint.is_empty() || hint.len() > 256 || has_control_char(hint) {
                        return Err(CoarsenError::StaticTextMalformed);
                    }
                }
            }
            Some(self.explanation)
        };

        // ── 静态文案 ──
        let message = static_message(self.code);
        if message.is_empty() || message.len() > 512 || has_control_char(message) {
            return Err(CoarsenError::StaticTextMalformed);
        }

        Ok(PublicError {
            code: self.code,
            message: String::from(message),
            address,
            explanation,
        })
    }
}

/// 是否含 C0 / C1 控制字符(公开展示文本封禁;public-text 同则)。
fn has_control_char(text: &str) -> bool {
    text.chars()
        .any(|c| matches!(c, '\u{0000}'..='\u{001F}' | '\u{007F}'..='\u{009F}'))
}

/// 架构值的端序解释枚举(解释字段 `interpretedAs` 的生成来源)。
fn interpreted_as(arch: ArchBits) -> InterpretedAs {
    match arch {
        ArchBits::B32 => InterpretedAs::LittleEndianDword,
        ArchBits::B64 => InterpretedAs::LittleEndianQword,
    }
}

/// 位宽整型读回:小端 u64(不足位宽高位补零;E-3 玩家输入回显的数值化)。
fn le_value(bytes: &[u8]) -> u64 {
    let mut buf = [0u8; 8];
    let take = bytes.len().min(8);
    buf[..take].copy_from_slice(&bytes[..take]);
    u64::from_le_bytes(buf)
}

/// 引擎执行错误 → 粗化错误(教学性失败面;已执行动作,revision 前进)。
///
/// 可见性裁决(I-9):故障地址不可见(隐藏映射 / 未映射 / 回绕)⇒ 一律
/// `inaccessible_address`,故障类别(尤其隐藏区域的权限事实)零外泄。
pub fn from_exec_error(
    error: &ExecError,
    policy: &ProjectionPolicy,
    memory: &VirtualMemory,
) -> Result<PublicError, crate::ProjectionError> {
    let arch = memory.arch();
    match error {
        ExecError::InvalidRip { address } => {
            // free:可见地址携带真实地址,不可见统一 null(I-9 同形态)。
            let draft = if policy.is_address_visible(memory, *address) {
                ErrorDraft::new(PublicErrorCode::InvalidRip).real_address(*address)
            } else {
                ErrorDraft::new(PublicErrorCode::InvalidRip).null_address()
            };
            let region = memory
                .region_at(*address)
                .filter(|region| policy.is_region_visible(&region.region_id));
            let region_id = region.map(|region| region.region_id.clone());
            let permissions = region.map(|region| String::from(region.permissions.as_str()));
            let value = ArchValue::new(*address, arch);
            let interpreted = interpreted_as(arch);
            let hints: Vec<String> = static_hints(PublicErrorCode::InvalidRip)
                .iter()
                .map(|hint| String::from(*hint))
                .collect();
            draft
                .explanation(move |explanation| {
                    explanation.region_id = region_id;
                    explanation.permissions = permissions;
                    explanation.value_hex = Some(value);
                    explanation.interpreted_as = Some(interpreted);
                    explanation.hints = Some(hints);
                })
                .finish(policy, memory)
                .map_err(|_| crate::ProjectionError::EngineDefect("error_coarsen_defect"))
        }
        ExecError::InvalidSyscallDispatch { value } => {
            // 未声明派发号(玩家自供值,回显无害;地址面 forbidden)。
            let value = ArchValue::new(*value, arch);
            let hints: Vec<String> = static_hints(PublicErrorCode::InvalidCallArgument)
                .iter()
                .map(|hint| String::from(*hint))
                .collect();
            ErrorDraft::new(PublicErrorCode::InvalidCallArgument)
                .explanation(move |explanation| {
                    explanation.value_hex = Some(value);
                    explanation.hints = Some(hints);
                })
                .finish(policy, memory)
                .map_err(|_| crate::ProjectionError::EngineDefect("error_coarsen_defect"))
        }
        ExecError::MemoryFault(fault) => from_memory_fault(fault, policy, memory),
        ExecError::CanaryViolation {
            address,
            byte_length,
        } => {
            // required-real:canary 槽必须在可见区域(教学锚点);不可见槽位
            // 无法满足矩阵形态 → challenge_invalid(装载面漏检的纵深防御)。
            if !policy.is_address_visible(memory, *address) {
                return Err(crate::ProjectionError::ChallengeInvalid(
                    "canary_slot_not_visible",
                ));
            }
            // 回显槽位当前内容(玩家写入值;canary 期望值零外泄)。
            let current = read_slot_bytes(memory, *address, *byte_length);
            let region_id = memory
                .region_at(*address)
                .map(|region| region.region_id.clone());
            let hints: Vec<String> = static_hints(PublicErrorCode::CanaryViolation)
                .iter()
                .map(|hint| String::from(*hint))
                .collect();
            ErrorDraft::new(PublicErrorCode::CanaryViolation)
                .real_address(*address)
                .explanation(move |explanation| {
                    explanation.region_id = region_id;
                    explanation.value_hex =
                        current.map(|bytes| ArchValue::new(le_value(&bytes), arch));
                    explanation.hints = Some(hints);
                })
                .finish(policy, memory)
                .map_err(|_| crate::ProjectionError::EngineDefect("error_coarsen_defect"))
        }
        ExecError::ResourceLimit(_) => budget_exhausted(policy, memory),
        ExecError::InvariantBroken(_) => internal_error(policy, memory),
    }
}

/// 内存故障 → 粗化错误(I-9 统一裁决;模块文档)。
pub fn from_memory_fault(
    fault: &MemoryFault,
    policy: &ProjectionPolicy,
    memory: &VirtualMemory,
) -> Result<PublicError, crate::ProjectionError> {
    // 不可见地址:类别与隐藏区域的权限事实零外泄(I-9)。
    if !policy.is_address_visible(memory, fault.addr) {
        let value = ArchValue::new(fault.addr, memory.arch());
        let hints: Vec<String> = static_hints(PublicErrorCode::InaccessibleAddress)
            .iter()
            .map(|hint| String::from(*hint))
            .collect();
        return ErrorDraft::new(PublicErrorCode::InaccessibleAddress)
            .null_address()
            .explanation(move |explanation| {
                explanation.value_hex = Some(value);
                explanation.hints = Some(hints);
            })
            .finish(policy, memory)
            .map_err(|_| crate::ProjectionError::EngineDefect("error_coarsen_defect"));
    }
    match &fault.kind {
        MemoryFaultKind::PermissionDenied {
            actual, region_id, ..
        } => {
            let region_id = region_id.clone();
            let permissions = String::from(actual.as_str());
            let hints: Vec<String> = static_hints(PublicErrorCode::PermissionDenied)
                .iter()
                .map(|hint| String::from(*hint))
                .collect();
            ErrorDraft::new(PublicErrorCode::PermissionDenied)
                .real_address(fault.addr)
                .explanation(move |explanation| {
                    explanation.region_id = Some(region_id);
                    explanation.permissions = Some(permissions);
                    explanation.hints = Some(hints);
                })
                .finish(policy, memory)
                .map_err(|_| crate::ProjectionError::EngineDefect("error_coarsen_defect"))
        }
        // 可见区域内的未映射 / 回绕:构造性不可达(可见 = 已映射且单区域内;
        // 跨界段首地址不可见已被上一分支统一)。防御性安全终止。
        MemoryFaultKind::Unmapped | MemoryFaultKind::AddressOverflow => Err(
            crate::ProjectionError::EngineDefect("visible_address_fault_kind_unreachable"),
        ),
    }
}

/// 执行前拒绝原因(协议级与运行时闸门的中性枚举;vm-runtime / worker 侧
/// 映射到本枚举,粗化形态归本模块——ZR-P6 单点)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RejectionReason {
    /// 终态会话拒绝一切 12 动作(D1 约束 5)。
    TerminalSession,
    /// 当前阶段允许动作集不含该动作。
    StageDisallowsAction,
    /// 阶段动作数预算已达上限。
    StageActionBudget,
    /// 无可撤销动作(空历史 undo)。
    NothingToUndo,
    /// checkpoint 归属解析失败。
    UnknownCheckpoint,
    /// checkpoint 标签非法。
    InvalidCheckpointLabel,
    /// 动作日志长度达结构上限。
    ActionLogFull,
    /// 回退 / 重置累计次数达预算上限。
    RollbackBudgetExhausted,
    /// `baseRevision` 过期。
    StaleBaseRevision,
    /// `clientSeq` 乱序。
    StaleClientSeq,
    /// 幂等键冲突(同键不同内容)。
    IdempotencyConflict,
    /// 写入起点可见但越出可见覆盖边界(E-3:`covered` = 起点起可见覆盖字节)。
    WriteCrossesVisibleBoundary {
        /// 起点所在可见区域。
        region_id: String,
        /// 可见覆盖字节数(expectedBytesLength 来源 = 可见区域边界)。
        covered: u64,
        /// 请求写入字节(actualBytesLength 来源 = 玩家输入)。
        requested: u64,
        /// 写入起点(educational 级 free 地址)。
        address: u64,
    },
    /// 写入起点不可见(I-9 统一形态,隐藏映射与未映射不可区分)。
    InvisibleWriteTarget {
        /// 玩家自供目标地址(valueHex 回显)。
        address: u64,
    },
    /// 装配 / 版本锁定类拒绝(challenge_invalid 方向的公开兜底;零细节)。
    ChallengeRejected,
    /// 判题累计谓词预算耗尽(challenge_invalid 方向安全终止;零细节)。
    PredicateBudgetExhausted,
}

/// 执行前拒绝 → 粗化错误(`status = rejected` 响应面的 `userVisibleError`;
/// 拒绝不推进 revision、无投影、无事件——§4.4 耦合由响应装配承担)。
pub fn rejection_error(
    reason: &RejectionReason,
    policy: &ProjectionPolicy,
    memory: &VirtualMemory,
) -> Result<PublicError, crate::ProjectionError> {
    match reason {
        RejectionReason::TerminalSession => {
            simple(PublicErrorCode::SessionTerminal, policy, memory)
        }
        RejectionReason::StageDisallowsAction
        | RejectionReason::NothingToUndo
        | RejectionReason::UnknownCheckpoint
        | RejectionReason::InvalidCheckpointLabel => {
            simple(PublicErrorCode::InvalidInputFormat, policy, memory)
        }
        RejectionReason::StageActionBudget
        | RejectionReason::ActionLogFull
        | RejectionReason::RollbackBudgetExhausted => {
            simple(PublicErrorCode::BudgetExhausted, policy, memory)
        }
        RejectionReason::StaleBaseRevision => {
            simple(PublicErrorCode::StaleBaseRevision, policy, memory)
        }
        RejectionReason::StaleClientSeq => simple(PublicErrorCode::StaleClientSeq, policy, memory),
        RejectionReason::IdempotencyConflict => {
            simple(PublicErrorCode::IdempotencyConflict, policy, memory)
        }
        RejectionReason::WriteCrossesVisibleBoundary {
            region_id,
            covered,
            requested,
            address,
        } => {
            let region_id = region_id.clone();
            let (covered, requested, address) = (*covered, *requested, *address);
            let hints: Vec<String> = static_hints(PublicErrorCode::OffsetOutOfRange)
                .iter()
                .map(|hint| String::from(*hint))
                .collect();
            ErrorDraft::new(PublicErrorCode::OffsetOutOfRange)
                .real_address(address)
                .explanation(move |explanation| {
                    explanation.region_id = Some(region_id.clone());
                    explanation.expected_bytes_length = Some(covered);
                    explanation.actual_bytes_length = Some(requested);
                    explanation.hints = Some(hints.clone());
                })
                .finish(policy, memory)
                .map_err(|_| crate::ProjectionError::EngineDefect("error_coarsen_defect"))
        }
        RejectionReason::InvisibleWriteTarget { address } => {
            let value = ArchValue::new(*address, memory.arch());
            let hints: Vec<String> = static_hints(PublicErrorCode::InaccessibleAddress)
                .iter()
                .map(|hint| String::from(*hint))
                .collect();
            ErrorDraft::new(PublicErrorCode::InaccessibleAddress)
                .null_address()
                .explanation(move |explanation| {
                    explanation.value_hex = Some(value);
                    explanation.hints = Some(hints);
                })
                .finish(policy, memory)
                .map_err(|_| crate::ProjectionError::EngineDefect("error_coarsen_defect"))
        }
        RejectionReason::ChallengeRejected => {
            // challenge_invalid 方向的公开兜底:internal_error 零细节(E-6;
            // 题目缺陷细节只进受控日志)。
            simple(PublicErrorCode::InternalError, policy, memory)
        }
        RejectionReason::PredicateBudgetExhausted => {
            simple(PublicErrorCode::InternalError, policy, memory)
        }
    }
}

/// 零解释、无地址的简单拒绝形态(协议级 / 资源类)。
fn simple(
    code: PublicErrorCode,
    policy: &ProjectionPolicy,
    memory: &VirtualMemory,
) -> Result<PublicError, crate::ProjectionError> {
    ErrorDraft::new(code)
        .finish(policy, memory)
        .map_err(|_| crate::ProjectionError::EngineDefect("error_coarsen_defect"))
}

/// 判定失败(检查点置 failed)的响应面错误:E-4 恒零解释——不泄露
/// 已匹配 / 未匹配计数、谓词标识或部分匹配结果(I-7;目标条件信息差
/// 由 status = failed 的公开时点承载,D1)。
pub fn objective_not_met(
    policy: &ProjectionPolicy,
    memory: &VirtualMemory,
) -> Result<PublicError, crate::ProjectionError> {
    simple(PublicErrorCode::ObjectiveNotMet, policy, memory)
}

/// 预算耗尽形态(引擎资源上限;forbidden / forbidden)。
pub fn budget_exhausted(
    policy: &ProjectionPolicy,
    memory: &VirtualMemory,
) -> Result<PublicError, crate::ProjectionError> {
    simple(PublicErrorCode::BudgetExhausted, policy, memory)
}

/// 引擎内部错误公开兜底(engine_error 的外露形态,零细节,E-6)。
pub fn internal_error(
    policy: &ProjectionPolicy,
    memory: &VirtualMemory,
) -> Result<PublicError, crate::ProjectionError> {
    simple(PublicErrorCode::InternalError, policy, memory)
}

/// 槽位字节读回(存储面;canary 回显来源)。
fn read_slot_bytes(memory: &VirtualMemory, address: u64, byte_length: u64) -> Option<Vec<u8>> {
    let len = byte_length.clamp(1, 8);
    crate::events::read_storage_bytes(memory, address, len)
}
#[cfg(test)]
mod tests {
    extern crate std;

    use alloc::string::String;
    use alloc::vec;

    use super::*;
    use crate::testkit::{A32, BUFFER_BASE, SECRET_BASE, STACK_BASE, policy_with_level};
    use crate::types::CanonicalText;
    use vm_core::arch::ArchValue;
    use vm_core::exec::ExecError;
    use vm_core::memory::{MemoryFault, MemoryFaultKind, PermKind};

    fn educational() -> (ProjectionPolicy, VirtualMemory) {
        (
            policy_with_level(ErrorDetailLevel::Educational),
            testkit_memory(),
        )
    }

    fn testkit_memory() -> VirtualMemory {
        crate::testkit::build_engine(&[], &[], true).state.memory
    }

    fn coarse() -> ProjectionPolicy {
        policy_with_level(ErrorDetailLevel::Coarse)
    }

    #[test]
    fn capability_matrix_covers_all_sixteen_codes() {
        use AddressHexMode as M;
        use PublicErrorCode as C;
        let expected: [(PublicErrorCode, M, bool); 16] = [
            (C::InvalidInputFormat, M::Forbidden, true),
            (C::InvalidPayloadLength, M::Free, true),
            (C::OffsetOutOfRange, M::Free, true),
            (C::EndiannessMismatch, M::Forbidden, true),
            (C::PermissionDenied, M::RequiredReal, true),
            (C::InvalidRip, M::Free, true),
            (C::CanaryViolation, M::RequiredReal, true),
            (C::InvalidCallArgument, M::Forbidden, true),
            (C::ObjectiveNotMet, M::Forbidden, false),
            (C::InaccessibleAddress, M::NullOnly, true),
            (C::BudgetExhausted, M::Forbidden, false),
            (C::StaleBaseRevision, M::Forbidden, false),
            (C::StaleClientSeq, M::Forbidden, false),
            (C::IdempotencyConflict, M::Forbidden, false),
            (C::SessionTerminal, M::Forbidden, false),
            (C::InternalError, M::Forbidden, false),
        ];
        for (code, mode, explanation_allowed) in expected {
            let (address_mode, explanation_cap) = capabilities(code);
            assert_eq!(address_mode, mode, "{code:?} 地址形态");
            assert_eq!(
                explanation_cap.allowed, explanation_allowed,
                "{code:?} 解释面"
            );
        }
    }

    #[test]
    fn forbidden_codes_reject_any_address_and_explanation() {
        let (policy, memory) = educational();
        // forbidden + 真实地址:违规。
        let error = ErrorDraft::new(PublicErrorCode::SessionTerminal)
            .real_address(STACK_BASE)
            .finish(&policy, &memory);
        assert_eq!(error, Err(CoarsenError::CapabilityViolated));
        // forbidden + 显式 null:违规(缺席是唯一形态)。
        let error = ErrorDraft::new(PublicErrorCode::SessionTerminal)
            .null_address()
            .finish(&policy, &memory);
        assert_eq!(error, Err(CoarsenError::CapabilityViolated));
        // forbidden + 解释字段:违规(E-4 / I-7)。
        let error = ErrorDraft::new(PublicErrorCode::BudgetExhausted)
            .explanation(|explanation| {
                explanation.hints = Some(vec![String::from("x")]);
            })
            .finish(&policy, &memory);
        assert_eq!(error, Err(CoarsenError::CapabilityViolated));
        // 合规形态:纯 code + message。
        let error = ErrorDraft::new(PublicErrorCode::SessionTerminal)
            .finish(&policy, &memory)
            .unwrap();
        assert_eq!(error.address, ErrorAddress::Absent);
        assert!(error.explanation.is_none());
    }

    #[test]
    fn required_real_requires_visible_real_address() {
        let (policy, memory) = educational();
        // 缺地址:违规。
        let error = ErrorDraft::new(PublicErrorCode::PermissionDenied).finish(&policy, &memory);
        assert_eq!(error, Err(CoarsenError::CapabilityViolated));
        // 不可见真实地址:违规(E-2)。
        let error = ErrorDraft::new(PublicErrorCode::PermissionDenied)
            .real_address(SECRET_BASE)
            .finish(&policy, &memory);
        assert_eq!(error, Err(CoarsenError::CapabilityViolated));
        // 可见真实地址:通过;coarse 级同样保留(required-real 不受级别影响)。
        for policy in [&policy, &coarse()] {
            let error = ErrorDraft::new(PublicErrorCode::PermissionDenied)
                .real_address(STACK_BASE)
                .finish(policy, &memory)
                .unwrap();
            assert_eq!(error.address, ErrorAddress::Real(STACK_BASE));
        }
    }

    #[test]
    fn null_only_enforces_null_and_free_follows_level() {
        let (policy, memory) = educational();
        // null-only + 真实地址:违规;缺席归一为 null。
        let error = ErrorDraft::new(PublicErrorCode::InaccessibleAddress)
            .real_address(STACK_BASE)
            .finish(&policy, &memory);
        assert_eq!(error, Err(CoarsenError::CapabilityViolated));
        let error = ErrorDraft::new(PublicErrorCode::InaccessibleAddress)
            .finish(&policy, &memory)
            .unwrap();
        assert_eq!(error.address, ErrorAddress::Null);
        // free:educational 携带可见真实地址。
        let error = ErrorDraft::new(PublicErrorCode::InvalidPayloadLength)
            .real_address(STACK_BASE)
            .finish(&policy, &memory)
            .unwrap();
        assert_eq!(error.address, ErrorAddress::Real(STACK_BASE));
        // free:coarse 整体缺席(D-P7;10.1 coarse 列)。
        let error = ErrorDraft::new(PublicErrorCode::InvalidPayloadLength)
            .real_address(STACK_BASE)
            .finish(&coarse(), &memory)
            .unwrap();
        assert_eq!(error.address, ErrorAddress::Absent);
        // free:不可见地址任何级别都是 null(统一占位)。
        for policy in [&policy, &coarse()] {
            let error = ErrorDraft::new(PublicErrorCode::InvalidPayloadLength)
                .null_address()
                .finish(policy, &memory)
                .unwrap();
            assert_eq!(error.address, ErrorAddress::Null);
        }
    }

    #[test]
    fn explanation_field_whitelist_is_fail_closed() {
        let (policy, memory) = educational();
        // invalid_input_format 只允许 hints:regionId 即违规。
        let error = ErrorDraft::new(PublicErrorCode::InvalidInputFormat)
            .explanation(|explanation| {
                explanation.region_id = Some(String::from("stack"));
            })
            .finish(&policy, &memory);
        assert_eq!(error, Err(CoarsenError::CapabilityViolated));
        // hints 合规。
        let error = ErrorDraft::new(PublicErrorCode::InvalidInputFormat)
            .explanation(|explanation| {
                explanation.hints = Some(vec![String::from("检查十六进制与字段形态")]);
            })
            .finish(&policy, &memory)
            .unwrap();
        assert!(error.explanation.is_some());
        // 对齐字面量域(1|2|4|8):3 违规。
        let error = ErrorDraft::new(PublicErrorCode::InvalidRip)
            .explanation(|explanation| {
                explanation.alignment_bytes = Some(3);
            })
            .finish(&policy, &memory);
        assert_eq!(error, Err(CoarsenError::CapabilityViolated));
        // hints 超 4 条:违规。
        let error = ErrorDraft::new(PublicErrorCode::InvalidRip)
            .explanation(|explanation| {
                explanation.hints = Some(vec![
                    String::from("a"),
                    String::from("b"),
                    String::from("c"),
                    String::from("d"),
                    String::from("e"),
                ]);
            })
            .finish(&policy, &memory);
        assert_eq!(error, Err(CoarsenError::StaticTextMalformed));
    }

    #[test]
    fn coarse_strips_explanation_and_is_byte_stable() {
        let memory = testkit_memory();
        let build = |policy: &ProjectionPolicy| {
            ErrorDraft::new(PublicErrorCode::InvalidRip)
                .real_address(STACK_BASE)
                .explanation(|explanation| {
                    explanation.region_id = Some(String::from("stack"));
                    explanation.value_hex = Some(ArchValue::new(2, A32));
                })
                .finish(policy, &memory)
                .unwrap()
        };
        // educational:解释在允许面内,保留。
        let rich = build(&policy_with_level(ErrorDetailLevel::Educational));
        assert!(rich.to_canonical().contains("\"explanation\""));
        // coarse:整体剥离(ZR-P6);同 (code, 级别) 两次构建字节一致。
        let bare = build(&coarse());
        assert!(bare.explanation.is_none());
        assert_eq!(bare.to_canonical(), build(&coarse()).to_canonical());
    }

    #[test]
    fn memory_fault_unifies_invisible_addresses() {
        let (policy, memory) = educational();
        // 隐藏映射与未映射地址上的故障:同码同形态(类别零外泄,I-9)。
        let hidden = MemoryFault {
            addr: SECRET_BASE,
            length: 4,
            kind: MemoryFaultKind::PermissionDenied {
                required: PermKind::Write,
                actual: vm_core::memory::Permissions::parse("rw").unwrap(),
                region_id: String::from("secret"),
            },
        };
        let unmapped = MemoryFault {
            addr: 0x3000_0000,
            length: 4,
            kind: MemoryFaultKind::Unmapped,
        };
        let hidden_error = from_memory_fault(&hidden, &policy, &memory).unwrap();
        let unmapped_error = from_memory_fault(&unmapped, &policy, &memory).unwrap();
        assert_eq!(hidden_error.code, PublicErrorCode::InaccessibleAddress);
        assert_eq!(unmapped_error.code, PublicErrorCode::InaccessibleAddress);
        assert_eq!(hidden_error.address, ErrorAddress::Null);
        assert_eq!(unmapped_error.address, ErrorAddress::Null);
        assert!(
            hidden_error
                .explanation
                .as_ref()
                .unwrap()
                .region_id
                .is_none()
        );
        assert!(
            !hidden_error.to_canonical().contains("secret"),
            "隐藏区域名零外泄(E-6)"
        );
    }

    #[test]
    fn memory_fault_visible_permission_denied_carries_region_facts() {
        let (policy, memory) = educational();
        let fault = MemoryFault {
            addr: STACK_BASE + 0x10,
            length: 4,
            kind: MemoryFaultKind::PermissionDenied {
                required: PermKind::Write,
                actual: vm_core::memory::Permissions::parse("rx").unwrap(),
                region_id: String::from("code"),
            },
        };
        let error = from_memory_fault(&fault, &policy, &memory).unwrap();
        assert_eq!(error.code, PublicErrorCode::PermissionDenied);
        assert_eq!(error.address, ErrorAddress::Real(STACK_BASE + 0x10));
        let explanation = error.explanation.unwrap();
        assert_eq!(explanation.region_id.as_deref(), Some("code"));
        assert_eq!(explanation.permissions.as_deref(), Some("rx"));
    }

    #[test]
    fn exec_error_mapping_matrix() {
        let (policy, memory) = educational();
        // InvalidRip 可见地址:free 真实地址 + 值回显。
        let error = from_exec_error(
            &ExecError::InvalidRip {
                address: STACK_BASE + 8,
            },
            &policy,
            &memory,
        )
        .unwrap();
        assert_eq!(error.code, PublicErrorCode::InvalidRip);
        assert_eq!(error.address, ErrorAddress::Real(STACK_BASE + 8));
        // InvalidRip 不可见地址:统一 null。
        let error = from_exec_error(
            &ExecError::InvalidRip {
                address: SECRET_BASE,
            },
            &policy,
            &memory,
        )
        .unwrap();
        assert_eq!(error.address, ErrorAddress::Null);
        // 未声明派发号:invalid_call_argument + 派发号回显(forbidden 地址)。
        let error = from_exec_error(
            &ExecError::InvalidSyscallDispatch { value: 0x123 },
            &policy,
            &memory,
        )
        .unwrap();
        assert_eq!(error.code, PublicErrorCode::InvalidCallArgument);
        assert_eq!(error.address, ErrorAddress::Absent);
        // 资源与内部错误。
        assert_eq!(
            from_exec_error(
                &ExecError::ResourceLimit(vm_core::state::ResourceLimitError {
                    requested: 1,
                    available: 0
                }),
                &policy,
                &memory
            )
            .unwrap()
            .code,
            PublicErrorCode::BudgetExhausted
        );
        assert_eq!(
            from_exec_error(&ExecError::InvariantBroken("x"), &policy, &memory)
                .unwrap()
                .code,
            PublicErrorCode::InternalError
        );
    }

    #[test]
    fn canary_violation_echoes_player_written_value_not_canary() {
        let mut engine = crate::testkit::build_engine(&[], &[], true);
        let policy = policy_with_level(ErrorDetailLevel::Educational);
        // 以 buffer 区 8 字节为回显面(玩家写入值;fixture 无 canary 槽,
        // 引擎面 CanaryViolation 归 WP-8 装载,此处以合成错误驱动粗化)。
        engine
            .state
            .memory
            .write_slice(ArchValue::new(BUFFER_BASE, A32), &[0x66; 8])
            .unwrap();
        let error = from_exec_error(
            &ExecError::CanaryViolation {
                address: BUFFER_BASE,
                byte_length: 8,
            },
            &policy,
            &engine.state.memory,
        )
        .unwrap();
        assert_eq!(error.code, PublicErrorCode::CanaryViolation);
        assert_eq!(error.address, ErrorAddress::Real(BUFFER_BASE));
        assert_eq!(
            error.explanation.as_ref().unwrap().value_hex,
            Some(ArchValue::new(0x6666_6666_6666_6666, A32))
        );
        // 不可见槽位:challenge_invalid(装载面漏检的纵深防御)。
        assert_eq!(
            from_exec_error(
                &ExecError::CanaryViolation {
                    address: SECRET_BASE,
                    byte_length: 8
                },
                &policy,
                &engine.state.memory
            ),
            Err(crate::ProjectionError::ChallengeInvalid(
                "canary_slot_not_visible"
            ))
        );
    }

    #[test]
    fn rejection_reason_mapping_covers_protocol_surface() {
        let (policy, memory) = educational();
        let cases: [(RejectionReason, PublicErrorCode); 11] = [
            (
                RejectionReason::TerminalSession,
                PublicErrorCode::SessionTerminal,
            ),
            (
                RejectionReason::StageDisallowsAction,
                PublicErrorCode::InvalidInputFormat,
            ),
            (
                RejectionReason::NothingToUndo,
                PublicErrorCode::InvalidInputFormat,
            ),
            (
                RejectionReason::UnknownCheckpoint,
                PublicErrorCode::InvalidInputFormat,
            ),
            (
                RejectionReason::InvalidCheckpointLabel,
                PublicErrorCode::InvalidInputFormat,
            ),
            (
                RejectionReason::StageActionBudget,
                PublicErrorCode::BudgetExhausted,
            ),
            (
                RejectionReason::ActionLogFull,
                PublicErrorCode::BudgetExhausted,
            ),
            (
                RejectionReason::RollbackBudgetExhausted,
                PublicErrorCode::BudgetExhausted,
            ),
            (
                RejectionReason::StaleBaseRevision,
                PublicErrorCode::StaleBaseRevision,
            ),
            (
                RejectionReason::StaleClientSeq,
                PublicErrorCode::StaleClientSeq,
            ),
            (
                RejectionReason::IdempotencyConflict,
                PublicErrorCode::IdempotencyConflict,
            ),
        ];
        for (reason, code) in cases {
            assert_eq!(
                rejection_error(&reason, &policy, &memory).unwrap().code,
                code,
                "{reason:?}"
            );
        }
        // challenge_invalid 方向的公开兜底:internal_error 零细节。
        for reason in [
            RejectionReason::ChallengeRejected,
            RejectionReason::PredicateBudgetExhausted,
        ] {
            assert_eq!(
                rejection_error(&reason, &policy, &memory).unwrap().code,
                PublicErrorCode::InternalError
            );
        }
    }

    #[test]
    fn boundary_rejection_carries_visible_boundary_facts() {
        let (policy, memory) = educational();
        let reason = RejectionReason::WriteCrossesVisibleBoundary {
            region_id: String::from("stack"),
            covered: 8,
            requested: 16,
            address: STACK_BASE + 0xFF8,
        };
        let error = rejection_error(&reason, &policy, &memory).unwrap();
        assert_eq!(error.code, PublicErrorCode::OffsetOutOfRange);
        let explanation = error.explanation.as_ref().unwrap();
        assert_eq!(explanation.expected_bytes_length, Some(8));
        assert_eq!(explanation.actual_bytes_length, Some(16));
        // invisible 探针:null-only + 目标值回显。
        let error = rejection_error(
            &RejectionReason::InvisibleWriteTarget {
                address: SECRET_BASE,
            },
            &policy,
            &memory,
        )
        .unwrap();
        assert_eq!(error.code, PublicErrorCode::InaccessibleAddress);
        assert_eq!(error.address, ErrorAddress::Null);
        assert_eq!(
            error.explanation.as_ref().unwrap().value_hex,
            Some(ArchValue::new(SECRET_BASE, A32))
        );
    }

    #[test]
    fn judge_failure_is_zero_explanation_objective_not_met() {
        let (policy, memory) = educational();
        let error = crate::error::objective_not_met(&policy, &memory).unwrap();
        assert_eq!(error.code, PublicErrorCode::ObjectiveNotMet);
        assert_eq!(error.address, ErrorAddress::Absent);
        assert!(error.explanation.is_none(), "E-4 / I-7:零谓词信息");
        assert!(!error.to_canonical().contains("explanation"));
    }

    #[test]
    fn policy_error_converts_to_challenge_invalid() {
        let error: crate::ProjectionError = crate::policy::PolicyError::DuplicateEntry.into();
        assert_eq!(
            error,
            crate::ProjectionError::ChallengeInvalid("projection_policy_rejected")
        );
    }
}

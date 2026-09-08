//! `ProjectionPolicy` 求值器(WP-1 §五 / D3;WP-7 实现语义)。
//!
//! # SERVER_ONLY 配置类型(§五)
//!
//! 策略整体 `SERVER_ONLY`:驻留域 3,由公开描述包的可见布局与私有判题包的
//! 隐藏对象排除集组装而成;浏览器只接收它产生的脱敏效果,永不接收策略本身
//! ("Schema 存在不等于可下发")。本模块是策略在执行域内的求值面:
//! 白名单成员资格查询、字节窗口(`maxBytesPerRange`)、错误精度级别
//! (`errorDetailLevel`)与**地址可见性分类**(I-9 统一拒绝的判定依据)。
//!
//! # 装配期 fail-closed(引擎侧镜像)
//!
//! - 白名单成员形态与护栏(≤ 64 / ≤ 64 / ≤ 64;标识符字符集)在装配期拒绝,
//!   方向 = `challenge_invalid`(沿 WP-5 `judge/spec.rs` 的装配镜像复验纪律);
//! - **FLAG 值永不进入公开面**(WP-3 裁决):`visibleRegisters` 中 FLAG 保留区
//!   命名在装配期结构性拒绝(一般命名空间校验 + FLAG 前缀排除双闸);
//! - **I3-VISIBLE-REG 引擎镜像**:秘密汇寄存器(`flagRegisterNames` ∪
//!   `secretSinkRegisters` ∪ FLAG 命名初始寄存器的并集,由装载侧组装传入)
//!   与可见寄存器白名单交集非空即在装配期拒绝——编译期污点推导(I-3)漏检
//!   的纵深防御,宁可拒绝不近似执行;
//! - `maxBytesPerRange` ∈ [1, 4096],缺省取 `MAX_BYTES_PER_RANGE_DEFAULT`(D3
//!   数值冻结:默认 256 / 单策略上限 4096 / 单 revision 总预算 8192)。

use alloc::string::String;
use alloc::vec::Vec;

use vm_core::memory::VirtualMemory;
use vm_core::registers::{is_flag_name, is_general_name};

/// 白名单标识符是否合法(契约 `OpaqueIdSchema` 同则:非空、≤ 128、
/// `A-Z a-z 0-9 _ -`;语义文档 §2.1 冻结字符集)。
fn is_identifier(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 128
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// 策略装配拒绝(方向 = `challenge_invalid`;不近似执行)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyError {
    /// 区域 / 对象白名单成员不是合法不透明标识符。
    IdentifierMalformed,
    /// 可见寄存器不是一般命名空间形态(含 FLAG 保留区命名的结构性拒绝)。
    RegisterNameMalformed,
    /// 白名单内重复成员(存在即歧义,拒绝)。
    DuplicateEntry,
    /// 白名单超协议护栏(64 / 64 / 64)。
    WhitelistTooLarge,
    /// 秘密汇寄存器进入可见白名单(I3-VISIBLE-REG 引擎镜像,I-3)。
    SecretSinkInWhitelist {
        /// 命中的秘密汇寄存器名。
        name: String,
    },
    /// `maxBytesPerRange` 越出 [1, 4096](D3 冻结域)。
    RangeLimitOutOfRange {
        /// 携带的非法值。
        value: u32,
    },
}

/// 错误精度级别(WP-1 10.1):`coarse` = 正式判题与 verifier 语境;
/// `educational` = 交互会话默认(教学解释展开,10.1 矩阵)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ErrorDetailLevel {
    /// 正式判题与 verifier 语境:载荷只含 code + message(ZR-P6 机检)。
    Coarse,
    /// 交互会话默认:解释字段按能力矩阵允许面展开。
    #[default]
    Educational,
}

/// 秘密汇寄存器集合(I-3 的静态可枚举集,§12.5):
/// `flagRegisterNames ∪ secretSinkRegisters ∪ 私有包 FLAG 命名初始寄存器`。
/// 由装载侧组装传入;策略装配期与可见白名单求交,交集非空即拒绝。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SecretSinkSet {
    /// 秘密汇寄存器名(一般与 FLAG 命名空间均可能)。
    pub names: Vec<String>,
}

impl SecretSinkSet {
    /// 构造。
    pub fn new(names: Vec<String>) -> Self {
        Self { names }
    }

    fn contains(&self, name: &str) -> bool {
        self.names.iter().any(|sink| sink == name)
    }
}

/// 装配输入(策略原始声明面;缺省窗口由装配期补默认值)。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProjectionPolicySpec {
    /// 可见区域标识白名单。
    pub visible_regions: Vec<String>,
    /// 可见对象标识白名单(补集即隐藏对象清单;运行期投影不直接消费,
    /// 随策略整体驻留域 3)。
    pub visible_objects: Vec<String>,
    /// 可见寄存器白名单。
    pub visible_registers: Vec<String>,
    /// 单区域字节窗口上限;`None` = 默认 256(D3)。
    pub max_bytes_per_range: Option<u32>,
    /// 错误精度级别。
    pub error_detail_level: ErrorDetailLevel,
}

/// 投影白名单策略(冻结字段集合:WP-1 §五五字段,不增不删)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionPolicy {
    visible_regions: Vec<String>,
    visible_objects: Vec<String>,
    visible_registers: Vec<String>,
    max_bytes_per_range: u32,
    error_detail_level: ErrorDetailLevel,
}

/// `maxBytesPerRange` 默认值(D3 冻结:256;协议上限 4096)。
pub const MAX_BYTES_PER_RANGE_DEFAULT: u32 = 256;
/// `maxBytesPerRange` 单策略上限(D3 冻结:4096,与 `MAX_WRITE_BYTES` 同值)。
pub const MAX_BYTES_PER_RANGE_MAX: u32 = 4096;
/// 可见区域白名单护栏(契约 `MAX_VISIBLE_REGIONS`)。
pub const MAX_VISIBLE_REGIONS: usize = 64;
/// 可见对象白名单护栏(契约 `MAX_VISIBLE_OBJECTS`)。
pub const MAX_VISIBLE_OBJECTS: usize = 64;
/// 可见寄存器白名单护栏(契约 `MAX_VISIBLE_REGISTERS`;D3.1:32 → 64)。
pub const MAX_VISIBLE_REGISTERS: usize = 64;

impl ProjectionPolicy {
    /// 装配并全量校验(任一约束不满足即拒绝,方向 `challenge_invalid`)。
    pub fn assemble(
        spec: ProjectionPolicySpec,
        sinks: &SecretSinkSet,
    ) -> Result<Self, PolicyError> {
        check_identifiers(&spec.visible_regions, MAX_VISIBLE_REGIONS)?;
        check_identifiers(&spec.visible_objects, MAX_VISIBLE_OBJECTS)?;
        // 寄存器:一般命名空间形态 + FLAG 保留区结构性排除(WP-3 裁决:
        // FLAG 值永不进入公开面——本闸是"白名单执行"的落点)。
        if spec.visible_registers.len() > MAX_VISIBLE_REGISTERS {
            return Err(PolicyError::WhitelistTooLarge);
        }
        for (index, name) in spec.visible_registers.iter().enumerate() {
            if !is_general_name(name) || is_flag_name(name) {
                return Err(PolicyError::RegisterNameMalformed);
            }
            if spec.visible_registers[..index].contains(name) {
                return Err(PolicyError::DuplicateEntry);
            }
            // I3-VISIBLE-REG 引擎镜像:秘密汇不可见(I-3)。
            if sinks.contains(name) {
                return Err(PolicyError::SecretSinkInWhitelist { name: name.clone() });
            }
        }
        let max_bytes_per_range = spec
            .max_bytes_per_range
            .unwrap_or(MAX_BYTES_PER_RANGE_DEFAULT);
        if max_bytes_per_range == 0 || max_bytes_per_range > MAX_BYTES_PER_RANGE_MAX {
            return Err(PolicyError::RangeLimitOutOfRange {
                value: max_bytes_per_range,
            });
        }
        Ok(Self {
            visible_regions: spec.visible_regions,
            visible_objects: spec.visible_objects,
            visible_registers: spec.visible_registers,
            max_bytes_per_range,
            error_detail_level: spec.error_detail_level,
        })
    }

    /// 区域是否可见(白名单成员资格)。
    pub fn is_region_visible(&self, region_id: &str) -> bool {
        self.visible_regions.iter().any(|id| id == region_id)
    }

    /// 寄存器是否可见(白名单成员资格;FLAG 名结构性不可见)。
    pub fn is_register_visible(&self, name: &str) -> bool {
        self.visible_registers.iter().any(|id| id == name)
    }

    /// 可见寄存器白名单(投影生成按白名单序输出,白名单序即公开布局序)。
    pub fn visible_registers(&self) -> &[String] {
        &self.visible_registers
    }

    /// 可见区域白名单。
    pub fn visible_regions(&self) -> &[String] {
        &self.visible_regions
    }

    /// 单区域字节窗口生效上限(D3:窗口锚定区域起点,不支持玩家任选偏移)。
    pub fn max_bytes_per_range(&self) -> u32 {
        self.max_bytes_per_range
    }

    /// 错误精度级别(错误粗化的粒度选择依据,10.1)。
    pub fn error_detail_level(&self) -> ErrorDetailLevel {
        self.error_detail_level
    }

    /// 地址是否落在可见区域内(含精确地址的事件可见性判定,I-8 / I-9)。
    pub fn is_address_visible(&self, memory: &VirtualMemory, address: u64) -> bool {
        memory
            .region_at(address)
            .is_some_and(|region| self.is_region_visible(&region.region_id))
    }

    /// 单字节窗口对区域长度的生效值(min(区域长, maxBytesPerRange))。
    pub fn window_bytes(&self, region_byte_length: u64) -> u64 {
        region_byte_length.min(u64::from(self.max_bytes_per_range))
    }

    /// 写入目标范围分类(玩家写动作的执行前判定,I-9 / E-2 / E-3):
    ///
    /// - 全覆盖([`WriteTargetClass::Covered`]):全程落在可见区域覆盖内——
    ///   放行到引擎执行,权限不足由引擎教学性失败(`permission_denied`,
    ///   required-real 地址形态可满足);
    /// - 越界([`WriteTargetClass::CrossesBoundary`]):起点可见但越出可见
    ///   覆盖边界(邻接隐藏区域或未映射空洞同形态)——执行前拒绝
    ///   `offset_out_of_range`,`expectedBytesLength` = 起点起可见覆盖字节数
    ///   (来源 = 可见区域边界,E-3),杜绝把跨边界写入漏进隐藏区域;
    /// - 不可见([`WriteTargetClass::Invisible`]):起点不可见——执行前拒绝
    ///   `inaccessible_address`(I-9 统一形态:隐藏映射与未映射不可区分)。
    ///   `inaccessible_address`(I-9 统一形态:隐藏映射与未映射不可区分)。
    pub fn classify_write_range(
        &self,
        memory: &VirtualMemory,
        address: u64,
        length: u64,
    ) -> WriteTargetClass {
        if length == 0 {
            // 空写入无目标面:按起点可见性统一(起点可见 = 全覆盖)。
            return if self.is_address_visible(memory, address) {
                WriteTargetClass::Covered {
                    region_id: memory
                        .region_at(address)
                        .map(|region: &vm_core::memory::RegionSpec| region.region_id.clone())
                        .unwrap_or_default(),
                }
            } else {
                WriteTargetClass::Invisible
            };
        }
        let end = address.saturating_add(length);
        let mut covered: u64 = 0;
        let mut cursor = address;
        let mut first_region_id: Option<String> = None;
        while cursor < end {
            let Some(region) = memory.region_at(cursor) else {
                break;
            };
            if !self.is_region_visible(&region.region_id) {
                break;
            }
            if first_region_id.is_none() {
                first_region_id = Some(region.region_id.clone());
            }
            let region_end = region.start.saturating_add(region.byte_length);
            let step_end = region_end.min(end);
            covered += step_end - cursor;
            cursor = step_end;
        }
        match (covered, first_region_id) {
            (len, Some(region_id)) if len == length => WriteTargetClass::Covered { region_id },
            (0, _) | (_, None) => WriteTargetClass::Invisible,
            (len, Some(region_id)) => WriteTargetClass::CrossesBoundary {
                region_id,
                covered: len,
            },
        }
    }
}

/// 写入目标范围分类(见 [`ProjectionPolicy::classify_write_range`])。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteTargetClass {
    /// 全程可见覆盖;`region_id` = 起点所在可见区域。
    Covered {
        /// 起点所在可见区域标识。
        region_id: String,
    },
    /// 起点可见但越出可见覆盖边界;`covered` = 起点起可见覆盖字节数。
    CrossesBoundary {
        /// 起点所在可见区域标识。
        region_id: String,
        /// 可见覆盖字节数(E-3:`expectedBytesLength` 来源 = 可见区域边界)。
        covered: u64,
    },
    /// 起点不可见(I-9 统一形态)。
    Invisible,
}

/// 标识符白名单通用校验(护栏 + 形态 + 唯一性)。
fn check_identifiers(list: &[String], cap: usize) -> Result<(), PolicyError> {
    if list.len() > cap {
        return Err(PolicyError::WhitelistTooLarge);
    }
    for (index, id) in list.iter().enumerate() {
        if !is_identifier(id) {
            return Err(PolicyError::IdentifierMalformed);
        }
        if list[..index].contains(id) {
            return Err(PolicyError::DuplicateEntry);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    extern crate std;

    use alloc::vec;
    use alloc::vec::Vec;

    use vm_core::arch::ArchBits;
    use vm_core::memory::{ExecutionMode, Permissions, RegionContents, RegionKind, RegionSpec};

    use super::*;

    const A32: ArchBits = ArchBits::B32;

    /// 两区域布局:stack(0x7FFF_F000,可见)+ secret(0x5000_0000,隐藏)。
    fn memory() -> VirtualMemory {
        let regions = vec![
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
        VirtualMemory::new(
            A32,
            4096,
            ExecutionMode::Ir,
            regions,
            vec![
                RegionContents {
                    region_id: String::from("stack"),
                    bytes: Vec::new(),
                },
                RegionContents {
                    region_id: String::from("secret"),
                    bytes: Vec::new(),
                },
            ],
        )
        .unwrap()
    }

    fn spec() -> ProjectionPolicySpec {
        ProjectionPolicySpec {
            visible_regions: vec![String::from("stack")],
            visible_objects: Vec::new(),
            visible_registers: vec![String::from("RAX"), String::from("RSP")],
            max_bytes_per_range: None,
            error_detail_level: ErrorDetailLevel::Educational,
        }
    }

    #[test]
    fn assemble_defaults_and_queries() {
        let policy = ProjectionPolicy::assemble(spec(), &SecretSinkSet::default()).unwrap();
        assert_eq!(policy.max_bytes_per_range(), 256);
        assert_eq!(policy.error_detail_level(), ErrorDetailLevel::Educational);
        assert!(policy.is_region_visible("stack"));
        assert!(!policy.is_region_visible("secret"));
        assert!(policy.is_register_visible("RAX"));
        assert!(!policy.is_register_visible("RBP"));
        assert_eq!(policy.window_bytes(4096), 256);
        assert_eq!(policy.window_bytes(64), 64);
    }

    #[test]
    fn flag_registers_are_structurally_rejected() {
        // FLAG 命名空间形态:一般命名空间校验 + FLAG 前缀排除双闸。
        let mut bad = spec();
        bad.visible_registers.push(String::from("FLAG_KEY"));
        assert_eq!(
            ProjectionPolicy::assemble(bad, &SecretSinkSet::default()),
            Err(PolicyError::RegisterNameMalformed)
        );
        // 小写名不符合一般命名空间形态。
        let mut bad = spec();
        bad.visible_registers.push(String::from("rax"));
        assert_eq!(
            ProjectionPolicy::assemble(bad, &SecretSinkSet::default()),
            Err(PolicyError::RegisterNameMalformed)
        );
    }

    #[test]
    fn secret_sink_in_whitelist_rejected_i3_mirror() {
        // 一般命名空间的显式秘密汇(secretSinkRegisters)与白名单相交即拒绝
        // (I3-VISIBLE-REG 引擎镜像;编译期污点推导漏检的纵深防御)。
        let mut bad = spec();
        bad.visible_registers.push(String::from("RKEY"));
        let sinks = SecretSinkSet::new(vec![String::from("RKEY")]);
        assert_eq!(
            ProjectionPolicy::assemble(bad, &sinks),
            Err(PolicyError::SecretSinkInWhitelist {
                name: String::from("RKEY")
            })
        );
        // 不相交则通过。
        let good = spec();
        let sinks = SecretSinkSet::new(vec![String::from("RKEY"), String::from("FLAG_K")]);
        assert!(ProjectionPolicy::assemble(good, &sinks).is_ok());
    }

    #[test]
    fn duplicate_entries_and_caps_rejected() {
        let mut bad = spec();
        bad.visible_regions.push(String::from("stack"));
        assert_eq!(
            ProjectionPolicy::assemble(bad, &SecretSinkSet::default()),
            Err(PolicyError::DuplicateEntry)
        );
        let mut bad = spec();
        bad.visible_regions = (0..65).map(|i| alloc::format!("r{i}")).collect();
        assert_eq!(
            ProjectionPolicy::assemble(bad, &SecretSinkSet::default()),
            Err(PolicyError::WhitelistTooLarge)
        );
        let mut bad = spec();
        bad.visible_regions.push(String::from("bad id!"));
        assert_eq!(
            ProjectionPolicy::assemble(bad, &SecretSinkSet::default()),
            Err(PolicyError::IdentifierMalformed)
        );
    }

    #[test]
    fn range_limit_bounds() {
        let mut bad = spec();
        bad.max_bytes_per_range = Some(0);
        assert_eq!(
            ProjectionPolicy::assemble(bad, &SecretSinkSet::default()),
            Err(PolicyError::RangeLimitOutOfRange { value: 0 })
        );
        let mut bad = spec();
        bad.max_bytes_per_range = Some(4097);
        assert_eq!(
            ProjectionPolicy::assemble(bad, &SecretSinkSet::default()),
            Err(PolicyError::RangeLimitOutOfRange { value: 4097 })
        );
        let mut ok = spec();
        ok.max_bytes_per_range = Some(4096);
        assert_eq!(
            ProjectionPolicy::assemble(ok, &SecretSinkSet::default())
                .unwrap()
                .max_bytes_per_range(),
            4096
        );
    }

    #[test]
    fn address_visibility_by_whitelist() {
        let policy = ProjectionPolicy::assemble(spec(), &SecretSinkSet::default()).unwrap();
        let memory = memory();
        assert!(policy.is_address_visible(&memory, 0x7FFF_F000));
        assert!(policy.is_address_visible(&memory, 0x7FFF_FFFF));
        // 隐藏映射区:可见性 = false(与未映射同判,I-9)。
        assert!(!policy.is_address_visible(&memory, 0x5000_0000));
        assert!(!policy.is_address_visible(&memory, 0x0));
        assert!(!policy.is_address_visible(&memory, 0x7FFF_0000));
    }

    #[test]
    fn write_range_classification_matrix() {
        let policy = ProjectionPolicy::assemble(spec(), &SecretSinkSet::default()).unwrap();
        let memory = memory();
        // 全覆盖。
        assert_eq!(
            policy.classify_write_range(&memory, 0x7FFF_F010, 8),
            WriteTargetClass::Covered {
                region_id: String::from("stack")
            }
        );
        // 恰到区域末字节。
        assert_eq!(
            policy.classify_write_range(&memory, 0x7FFF_FFF8, 8),
            WriteTargetClass::Covered {
                region_id: String::from("stack")
            }
        );
        // 越出可见边界(未映射侧):covered = 至区域末尾的字节数。
        assert_eq!(
            policy.classify_write_range(&memory, 0x7FFF_FFF0, 0x20),
            WriteTargetClass::CrossesBoundary {
                region_id: String::from("stack"),
                covered: 0x10
            }
        );
        // 越入隐藏区域(邻接隐藏映射不可构造于本布局;直接落在隐藏区):
        // 起点不可见 → 统一 Invisible。
        assert_eq!(
            policy.classify_write_range(&memory, 0x5000_0100, 4),
            WriteTargetClass::Invisible
        );
        // 未映射地址。
        assert_eq!(
            policy.classify_write_range(&memory, 0x1234_5678, 4),
            WriteTargetClass::Invisible
        );
        // 零长度:按起点可见性。
        assert_eq!(
            policy.classify_write_range(&memory, 0x7FFF_F000, 0),
            WriteTargetClass::Covered {
                region_id: String::from("stack")
            }
        );
        assert_eq!(
            policy.classify_write_range(&memory, 0x5000_0000, 0),
            WriteTargetClass::Invisible
        );
    }
}

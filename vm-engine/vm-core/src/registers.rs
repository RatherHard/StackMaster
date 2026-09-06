//! 寄存器文件:双命名空间保留模型(WP-3;WP-1 §12.5 v1.5、整改方案 §3.2 G2/D3、
//! 计划书 6.1)。
//!
//! # 双命名空间保留模型(G2/D3 裁决)
//!
//! - **一般命名空间**:出题人自由命名,模式 `^[A-Z][A-Z0-9_]{0,15}$`,
//!   且**禁止落入 `FLAG` 前缀保留区**(XS-REG-NAMESPACE);
//! - **FLAG 保留区**:`^FLAG[A-Z0-9_]*$`,承载题目秘密,**值永不进入公开面**
//!   (I-3;名称本身可公开,值只可在引擎内部流转);
//! - 两个命名空间**结构性不相交**(一般名被禁止 FLAG 前缀)→ 秘密汇集合
//!   (FLAG 寄存器 ∪ secretSinkRegisters ∪ 污点推导)仍可静态枚举,
//!   WP-1 §12.5 的安全论证原样成立;
//! - **必选核心寄存器** `RSP` / `RBP` / `RIP`(XS-REG-CORE):会话动作
//!   (push/pop/call/ret)、栈语义 opcode(含 `leave`)与 MVP 栈帧闭环的公共底座;
//! - 数量护栏 `MAX_REGISTERS = 256`(D3.1;资源护栏,非自由度限制,
//!   含 FLAG 寄存器在内)。
//!
//! 值均为 [`ArchValue`](掩蔽域容器);初始值超位宽域在构造 `ArchValue` 时即被
//! 掩蔽 / 拒绝(XS-ARCH-WIDTH 引擎侧镜像由边界 hex 解析承担)。

use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

use crate::arch::ArchValue;

/// 寄存器总数上限(D3.1:64 → 256;资源护栏,含 FLAG 寄存器)。
pub const MAX_REGISTERS: usize = 256;
/// FLAG 声明面上限(契约 `vmProfile.flagRegisterNames` maxItems)。
pub const MAX_FLAG_REGISTERS: usize = 32;
/// FLAG 前缀保留区标记。
pub const FLAG_PREFIX: &str = "FLAG";
/// 必选核心寄存器(XS-REG-CORE)。
pub const CORE_REGISTERS: [&str; 3] = ["RSP", "RBP", "RIP"];

/// 名称是否为 FLAG 保留区形态(`^FLAG[A-Z0-9_]*$`)。
pub fn is_flag_name(name: &str) -> bool {
    match name.strip_prefix(FLAG_PREFIX) {
        None => false,
        Some(rest) => rest
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'),
    }
}

/// 名称是否为合法一般命名空间形态(`^[A-Z][A-Z0-9_]{0,15}$` 且不落 FLAG 保留区)。
pub fn is_general_name(name: &str) -> bool {
    if is_flag_name(name) {
        return false;
    }
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > 16 {
        return false;
    }
    if !bytes[0].is_ascii_uppercase() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'_')
}

/// 寄存器模型错误(装载期;公开面粗化归 WP-7)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegisterError {
    /// 数量超护栏(D3.1:256)。
    TooManyRegisters {
        /// 实际数量。
        count: usize,
    },
    /// 一般命名空间形态非法(含落入 FLAG 保留区;XS-REG-NAMESPACE)。
    InvalidGeneralName(String),
    /// FLAG 形态非法(`^FLAG[A-Z0-9_]*$` 之外)。
    InvalidFlagName(String),
    /// FLAG 保留区条目未在声明集中(保留区只允许声明面定义的名称)。
    UndeclaredFlagRegister(String),
    /// 声明的 FLAG 寄存器缺初始值(私有包 initialState.registers 含 FLAG 值)。
    MissingFlagValue(String),
    /// FLAG 声明集超上限(32)。
    TooManyFlagRegisters {
        /// 实际数量。
        count: usize,
    },
    /// 缺必选核心寄存器(XS-REG-CORE)。
    MissingCoreRegister(String),
    /// 初始条目重复。
    DuplicateRegister(String),
    /// 运行期引用未知寄存器。
    UnknownRegister(String),
}

/// 寄存器文件:名称 → 架构值(BTreeMap 按名称序,确定性遍历;
/// 这是冻结表 `registers` 字段——"寄存器全集到架构值的映射 + FLAG 位"的承载)。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RegisterFile {
    values: BTreeMap<String, ArchValue>,
    flag_count: usize,
}

impl RegisterFile {
    /// 装载:一般寄存器 + FLAG 寄存器初始值 + FLAG 声明集,全量校验。
    ///
    /// 校验规则(任一不满足即整体拒绝):
    /// 总数 ≤ 256;一般名过 [`is_general_name`];FLAG 条目必须被声明
    /// ([`is_flag_name`] 形态 + 声明集覆盖);声明集每个 FLAG 名必须有初始值;
    /// 核心寄存器 `RSP` / `RBP` / `RIP` 必须存在。
    pub fn new(
        entries: Vec<(String, ArchValue)>,
        flag_names: &[String],
    ) -> Result<Self, RegisterError> {
        if entries.len() > MAX_REGISTERS {
            return Err(RegisterError::TooManyRegisters {
                count: entries.len(),
            });
        }
        if flag_names.len() > MAX_FLAG_REGISTERS {
            return Err(RegisterError::TooManyFlagRegisters {
                count: flag_names.len(),
            });
        }
        for name in flag_names {
            if !is_flag_name(name) {
                return Err(RegisterError::InvalidFlagName(name.clone()));
            }
        }
        let declared_flags: BTreeMap<&str, ()> =
            flag_names.iter().map(|n| (n.as_str(), ())).collect();
        let mut values: BTreeMap<String, ArchValue> = BTreeMap::new();
        let mut flag_count = 0usize;
        for (name, value) in entries {
            if is_flag_name(&name) {
                if !declared_flags.contains_key(name.as_str()) {
                    return Err(RegisterError::UndeclaredFlagRegister(name));
                }
                flag_count += 1;
            } else if !is_general_name(&name) {
                return Err(RegisterError::InvalidGeneralName(name));
            }
            if values.insert(name.clone(), value).is_some() {
                return Err(RegisterError::DuplicateRegister(name));
            }
        }
        for name in flag_names {
            if !values.contains_key(name) {
                return Err(RegisterError::MissingFlagValue(name.clone()));
            }
        }
        for core in CORE_REGISTERS {
            if !values.contains_key(core) {
                return Err(RegisterError::MissingCoreRegister(String::from(core)));
            }
        }
        Ok(Self { values, flag_count })
    }

    /// 读寄存器(FLAG 寄存器同接口;公开面投影由 WP-7 白名单决定)。
    pub fn get(&self, name: &str) -> Option<ArchValue> {
        self.values.get(name).copied()
    }

    /// 写寄存器(未知寄存器拒绝;运行期操作数引用可解析性由此保证)。
    pub fn set(&mut self, name: &str, value: ArchValue) -> Result<(), RegisterError> {
        if !self.values.contains_key(name) {
            return Err(RegisterError::UnknownRegister(String::from(name)));
        }
        self.values.insert(String::from(name), value);
        Ok(())
    }

    /// 条目数(含 FLAG 寄存器;恒 ≤ 256)。
    pub fn len(&self) -> usize {
        self.values.len()
    }

    /// 是否为空(装载后不可能为空——核心寄存器必选;仅供完备性)。
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// FLAG 寄存器数量(结构性:一般名不落 FLAG 保留区,故恒等于声明集大小)。
    pub fn flag_count(&self) -> usize {
        self.flag_count
    }

    /// 名称是否属于 FLAG 保留区且已装载(运行期判别;投影白名单组装的排除依据)。
    pub fn is_flag(&self, name: &str) -> bool {
        is_flag_name(name) && self.values.contains_key(name)
    }

    /// 按名称升序遍历(确定性;状态哈希的规范顺序来源)。
    pub fn iter(&self) -> impl Iterator<Item = (&str, ArchValue)> {
        self.values.iter().map(|(k, v)| (k.as_str(), *v))
    }

    /// 名称集合(升序)。
    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.values.keys().map(String::as_str)
    }

    /// 核心寄存器直读(装载后必存在;返回 `Option` 以避免断言路径)。
    pub fn rsp(&self) -> Option<ArchValue> {
        self.get("RSP")
    }

    /// 核心寄存器直读。
    pub fn rbp(&self) -> Option<ArchValue> {
        self.get("RBP")
    }

    /// 核心寄存器直读。
    pub fn rip(&self) -> Option<ArchValue> {
        self.get("RIP")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arch::ArchBits;
    use alloc::format;
    use alloc::vec;

    const A32: ArchBits = ArchBits::B32;

    fn entry(name: &str, value: u64) -> (String, ArchValue) {
        (String::from(name), ArchValue::new(value, A32))
    }

    fn flags(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| String::from(*n)).collect()
    }

    fn minimal_entries() -> Vec<(String, ArchValue)> {
        vec![
            entry("RSP", 0x7FFF_FFF8),
            entry("RBP", 0x7FFF_FFF8),
            entry("RIP", 0x0040_1000),
        ]
    }

    // ─────────────────────────────────────────────────────────────────────
    // 命名空间判别(模式红线)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn general_namespace_accepts_free_names() {
        for ok in ["A", "RAX", "R_MYDATA", "CTRL", "X1", "LONG_NAME_16_OK"] {
            assert!(is_general_name(ok), "{ok} 应为合法一般名");
        }
        // 非 FLAG 开头但含 FLAG 字样的一般名合法(前缀语义,非子串)。
        assert!(is_general_name("AFLAG"));
    }

    #[test]
    fn general_namespace_rejects_flag_prefix_and_malformed() {
        // FLAG 保留区(一般名禁止;以 FLAG 开头即落区,含 FLAGS_MAP 这类)。
        for bad in ["FLAG", "FLAGX", "FLAG_A", "FLAG1", "FLAGS_MAP"] {
            assert!(!is_general_name(bad), "{bad} 落 FLAG 保留区,一般名必须拒绝");
            assert!(is_flag_name(bad), "{bad} 应判为 FLAG 形态");
        }
        // 形态非法。
        for bad in ["", "a", "rax", "1A", "_A", "A-", "A B", "TOOLONG_NAME_17XX"] {
            assert!(!is_general_name(bad), "{bad} 必须拒绝");
        }
        // FLAG 形态边界。
        assert!(!is_flag_name(""));
        assert!(!is_flag_name("FLA"));
        assert!(!is_flag_name("FLAG!"));
        assert!(!is_flag_name("flagx"));
    }

    // ─────────────────────────────────────────────────────────────────────
    // 装载校验(每条规则一个红灯)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn load_accepts_core_plus_free_names_and_flags() {
        let mut entries = minimal_entries();
        entries.push(entry("R_MYDATA", 1));
        entries.push(entry("CTRL", 2));
        entries.push(entry("FLAG_SECRET", 0xDEAD_BEEF));
        let rf = RegisterFile::new(entries, &flags(&["FLAG_SECRET"])).unwrap();
        assert_eq!(rf.len(), 6);
        assert_eq!(rf.flag_count(), 1);
        assert_eq!(rf.get("FLAG_SECRET").unwrap().get(), 0xDEAD_BEEF);
        assert_eq!(rf.rsp().unwrap().get(), 0x7FFF_FFF8);
        assert_eq!(rf.rbp().unwrap().get(), 0x7FFF_FFF8);
        assert_eq!(rf.rip().unwrap().get(), 0x0040_1000);
        assert!(rf.is_flag("FLAG_SECRET"));
        assert!(!rf.is_flag("RSP"));
        assert!(!rf.is_flag("NOPE"));
    }

    #[test]
    fn load_rejects_missing_core_registers() {
        let entries = vec![entry("RSP", 1), entry("RBP", 2)];
        assert_eq!(
            RegisterFile::new(entries, &[]),
            Err(RegisterError::MissingCoreRegister(String::from("RIP")))
        );
    }

    #[test]
    fn load_rejects_flag_namespace_violations() {
        // 声明的 FLAG 名给值 → 合法,且计入 FLAG 数(结构性:FLAG 前缀条目
        // 只能以 FLAG 寄存器身份存在,一般命名空间不可能占用)。
        let mut entries = minimal_entries();
        entries.push(entry("FLAGX", 1));
        let rf = RegisterFile::new(entries, &flags(&["FLAGX"])).unwrap();
        assert_eq!(rf.flag_count(), 1);
        // FLAG 条目未声明。
        let mut entries = minimal_entries();
        entries.push(entry("FLAG_SECRET", 1));
        assert_eq!(
            RegisterFile::new(entries, &[]),
            Err(RegisterError::UndeclaredFlagRegister(String::from(
                "FLAG_SECRET"
            )))
        );
        // 声明集形态非法。
        assert_eq!(
            RegisterFile::new(minimal_entries(), &flags(&["SECRET_FLAG"])),
            Err(RegisterError::InvalidFlagName(String::from("SECRET_FLAG")))
        );
        // 声明了 FLAG 但缺初始值。
        assert_eq!(
            RegisterFile::new(minimal_entries(), &flags(&["FLAG_SECRET"])),
            Err(RegisterError::MissingFlagValue(String::from("FLAG_SECRET")))
        );
        // 初始条目重复。
        let mut entries = minimal_entries();
        entries.push(entry("CTRL", 1));
        entries.push(entry("CTRL", 2));
        assert_eq!(
            RegisterFile::new(entries, &[]),
            Err(RegisterError::DuplicateRegister(String::from("CTRL")))
        );
    }

    #[test]
    fn load_rejects_over_limits() {
        // 总数超 256(核心 3 + 254 一般 = 257)。
        let mut entries = minimal_entries();
        for i in 0..254 {
            entries.push(entry(&format!("R{i:03}"), i as u64));
        }
        assert_eq!(entries.len(), 257);
        assert_eq!(
            RegisterFile::new(entries, &[]),
            Err(RegisterError::TooManyRegisters { count: 257 })
        );
        // 恰好 256 合法(核心 3 + 253 一般)。
        let mut entries = minimal_entries();
        for i in 0..253 {
            entries.push(entry(&format!("R{i:03}"), i as u64));
        }
        assert_eq!(entries.len(), 256);
        assert!(RegisterFile::new(entries, &[]).is_ok());
        // FLAG 声明集超 32。
        let flag_names: Vec<String> = (0..33).map(|i| format!("FLAG{i:02}")).collect();
        assert_eq!(
            RegisterFile::new(minimal_entries(), &flag_names),
            Err(RegisterError::TooManyFlagRegisters { count: 33 })
        );
    }

    #[test]
    fn set_rejects_unknown_register() {
        let mut rf = RegisterFile::new(minimal_entries(), &[]).unwrap();
        assert_eq!(
            rf.set("R_GHOST", ArchValue::new(1, A32)),
            Err(RegisterError::UnknownRegister(String::from("R_GHOST")))
        );
        // 未声明的一般名同样不可写(集合封闭于装载面)。
        assert!(rf.set("RAX", ArchValue::new(1, A32)).is_err());
        assert!(rf.set("RSP", ArchValue::new(0x100, A32)).is_ok());
        assert_eq!(rf.get("RSP").unwrap().get(), 0x100);
        // FLAG 寄存器引擎内部可写(set_flag 效果原语的底座;公开面由 WP-7 拦截)。
        let mut rf2 = RegisterFile::new(
            {
                let mut e = minimal_entries();
                e.push(entry("FLAG_SECRET", 0));
                e
            },
            &flags(&["FLAG_SECRET"]),
        )
        .unwrap();
        assert!(rf2.set("FLAG_SECRET", ArchValue::new(7, A32)).is_ok());
        assert_eq!(rf2.get("FLAG_SECRET").unwrap().get(), 7);
    }

    // ─────────────────────────────────────────────────────────────────────
    // 确定性遍历与不变量
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn iteration_is_deterministic_name_order() {
        let mut entries = minimal_entries();
        entries.push(entry("ZZ", 1));
        entries.push(entry("AA", 2));
        entries.push(entry("FLAG_Z", 3));
        let rf = RegisterFile::new(entries, &flags(&["FLAG_Z"])).unwrap();
        let names: Vec<&str> = rf.names().collect();
        // BTreeMap 名称序;FLAG 与一般名同处一个序(承载同一映射)。
        assert_eq!(names, vec!["AA", "FLAG_Z", "RBP", "RIP", "RSP", "ZZ"]);
        let pairs: Vec<(&str, u64)> = rf.iter().map(|(k, v)| (k, v.get())).collect();
        assert_eq!(pairs[0], ("AA", 2));
        assert_eq!(pairs[1], ("FLAG_Z", 3));
    }

    #[test]
    fn values_are_masked_arch_values() {
        // 值域由 ArchValue 构造保证:传入超宽原值时已在构造时掩蔽。
        let entries = vec![
            entry("RSP", 0x1_0000_0000 | 0x40),
            entry("RBP", 0),
            entry("RIP", 0x4000),
        ];
        let rf = RegisterFile::new(entries, &[]).unwrap();
        assert_eq!(rf.get("RSP").unwrap().get(), 0x40, "32 位域高位被掩蔽");
    }
}

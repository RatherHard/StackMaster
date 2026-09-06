//! 架构值域与掩蔽域算术(WP-3;计划书 6.2、整改方案 §3.1 G1/D1)。
//!
//! - `archBits` 取值域冻结为 `{32, 64}`(D1;扩展走 VM Profile Version);
//! - 架构值是 **archBits 宽的值,以 64 位容器承载,高位按位宽掩蔽**;
//!   全部算术 / 移位 / 比较在掩蔽域内进行;出界(模减)与进位 / 借位行为
//!   由本模块的原始运算定义,逐指令语义(如何消费进位 / 借位)归 WP-4 指令规约;
//! - VM Core 内部一律使用 [`ArchValue`](掩蔽不变量);十六进制字符串只在边界
//!   (契约形态 ↔ 引擎容器)出现:[`ArchValue::parse_hex`] / [`ArchValue::format_hex`]。
//!   解析按 `^0x[0-9a-fA-F]{1,16}$` 词法 + 值 ≤ 2^archBits−1(XS-ARCH-WIDTH 的
//!   引擎侧镜像;契约层漏检在此 fail-closed)。
//!
//! # 确定性
//!
//! 掩蔽域运算是纯函数,与宿主字长、编译模式无关;模 2^n 语义由显式
//! `wrapping_*` 表达(有意的域内回绕,非静默溢出——ENG-3 约束的是
//! *未定义域内* 的意外溢出,掩蔽域本身以模运算为定义)。

use alloc::string::String;

/// 架构位宽声明(G1/D1:v1 冻结二元;来源:公开描述包 `vmProfile.archBits`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ArchBits {
    /// 32 位架构。
    B32,
    /// 64 位架构。
    B64,
}

impl ArchBits {
    /// 位宽数值(32 / 64)。
    pub fn bits(self) -> u32 {
        match self {
            ArchBits::B32 => 32,
            ArchBits::B64 => 64,
        }
    }

    /// 掩蔽域掩码:2^bits − 1(64 位即全 1 容器)。
    pub fn mask(self) -> u64 {
        match self {
            ArchBits::B32 => 0xFFFF_FFFF,
            ArchBits::B64 => u64::MAX,
        }
    }

    /// 位宽数值 → 声明(取值域外返回 `None`)。
    pub fn from_bits(bits: u32) -> Option<Self> {
        match bits {
            32 => Some(ArchBits::B32),
            64 => Some(ArchBits::B64),
            _ => None,
        }
    }
}

/// 架构值:archBits 宽、64 位容器承载、高位按位宽掩蔽(不变量:`raw` 恒在掩蔽域内)。
///
/// 构造即掩蔽([`ArchValue::new`]);全部运算接收 [`ArchBits`] 并在掩蔽域内完成,
/// 结果仍满足不变量。比较按无符号域序(`jb` / `jae` 语义底座;有符号解释 v1 无需求)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct ArchValue {
    raw: u64,
}

impl ArchValue {
    /// 构造:高位按 `arch` 掩蔽。这是唯一入口,不变量由此成立。
    pub fn new(raw: u64, arch: ArchBits) -> Self {
        Self {
            raw: raw & arch.mask(),
        }
    }

    /// 容器原值(恒 ≤ `arch.mask()`)。
    pub fn get(self) -> u64 {
        self.raw
    }

    /// 掩蔽域内加法(模 2^arch)。
    pub fn add(self, rhs: Self, arch: ArchBits) -> Self {
        Self::new(self.raw.wrapping_add(rhs.raw), arch)
    }

    /// 掩蔽域内加法 + 进位输出:模 2^arch 和超出域时进位为 `true`
    /// (指令规约按位宽消费,如 `add` 的教学反馈;WP-4)。
    pub fn add_with_carry(self, rhs: Self, arch: ArchBits) -> (Self, bool) {
        let mask = arch.mask();
        match arch {
            // 32 位域内两数之和 ≤ 2^33 − 2,u64 直接加不溢出。
            ArchBits::B32 => {
                let sum = self.raw + rhs.raw;
                (Self::new(sum, arch), sum > mask)
            }
            ArchBits::B64 => {
                let sum = self.raw.wrapping_add(rhs.raw);
                (Self::new(sum, arch), sum < self.raw)
            }
        }
    }

    /// 掩蔽域内减法(模 2^arch;借位即模减回绕)。
    pub fn sub(self, rhs: Self, arch: ArchBits) -> Self {
        Self::new(self.raw.wrapping_sub(rhs.raw), arch)
    }

    /// 掩蔽域内减法 + 借位输出:`rhs > self`(无符号域)时借位为 `true`。
    pub fn sub_with_borrow(self, rhs: Self, arch: ArchBits) -> (Self, bool) {
        (
            Self::new(self.raw.wrapping_sub(rhs.raw), arch),
            rhs.raw > self.raw,
        )
    }

    pub fn and(self, rhs: Self, arch: ArchBits) -> Self {
        Self::new(self.raw & rhs.raw, arch)
    }

    pub fn or(self, rhs: Self, arch: ArchBits) -> Self {
        Self::new(self.raw | rhs.raw, arch)
    }

    pub fn xor(self, rhs: Self, arch: ArchBits) -> Self {
        Self::new(self.raw ^ rhs.raw, arch)
    }

    /// 按位取反(掩蔽域内)。
    pub fn not(self, arch: ArchBits) -> Self {
        Self::new(!self.raw, arch)
    }

    /// 逻辑左移。移位量 ≥ 位宽时结果为 0(数学语义;逐指令对移位量的
    /// 掩蔽 / 截断规则归 WP-4 指令规约)。
    pub fn shl(self, shift: u64, arch: ArchBits) -> Self {
        if shift >= u64::from(arch.bits()) {
            Self::ZERO
        } else {
            Self::new(self.raw << shift, arch)
        }
    }

    /// 逻辑右移(高位补 0)。移位量 ≥ 位宽时结果为 0。
    pub fn shr(self, shift: u64, arch: ArchBits) -> Self {
        if shift >= u64::from(arch.bits()) {
            Self::ZERO
        } else {
            Self::new(self.raw >> shift, arch)
        }
    }

    /// 有符号立即数 → 掩蔽域容器(二进制补码;IR 立即数 / 位移在 archBits
    /// 有符号范围内由编译期校验保证,XS-ARCH-WIDTH;此处只做形态转换)。
    pub fn from_signed(value: i64, arch: ArchBits) -> Self {
        Self::new(value as u64, arch)
    }

    /// 零值。
    pub const ZERO: Self = Self { raw: 0 };

    /// 掩蔽域最大值(2^archBits − 1)。
    pub fn max_value(arch: ArchBits) -> Self {
        Self { raw: arch.mask() }
    }

    /// 边界转换:十六进制字符串 → 架构值。
    ///
    /// 词法:`^0x[0-9a-fA-F]{1,16}$`(协议 `AddressHexSchema` / `ValueHex64Schema`
    /// 同形态);值域:≤ 2^archBits − 1(XS-ARCH-WIDTH 引擎侧镜像)。
    pub fn parse_hex(s: &str, arch: ArchBits) -> Result<Self, HexValueError> {
        let digits = s.strip_prefix("0x").ok_or(HexValueError::Malformed)?;
        if digits.is_empty() || digits.len() > 16 {
            return Err(HexValueError::Malformed);
        }
        let mut raw: u64 = 0;
        for ch in digits.chars() {
            let d = ch.to_digit(16).ok_or(HexValueError::Malformed)?;
            raw = raw * 16 + u64::from(d);
        }
        if raw > arch.mask() {
            return Err(HexValueError::OutOfRange { bits: arch.bits() });
        }
        Ok(Self { raw })
    }

    /// 边界转换:架构值 → 十六进制字符串(`0x` + 大写、变长、无前导零;零 → `0x0`)。
    ///
    /// 与公开投影 `PublicRegister.valueHex` 形态一致(变长大写十六进制,WP-1 §4.2);
    /// 投影下发的最终格式化归 WP-7,本方法是其引擎侧来源。
    pub fn format_hex(self) -> String {
        const DIGITS: &[u8; 16] = b"0123456789ABCDEF";
        let mut buf = [0u8; 16];
        let mut len = 0;
        let mut v = self.raw;
        if v == 0 {
            return String::from("0x0");
        }
        while v > 0 {
            buf[len] = DIGITS[(v & 0xF) as usize];
            len += 1;
            v >>= 4;
        }
        let mut s = String::with_capacity(2 + len);
        s.push_str("0x");
        while len > 0 {
            len -= 1;
            s.push(buf[len] as char);
        }
        s
    }
}

/// 十六进制边界转换错误(引擎侧 fail-closed;公开面粗化归 WP-7 / 协议错误码)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HexValueError {
    /// 词法形态非法(缺 `0x` 前缀、空串、超 16 位、非十六进制字符)。
    Malformed,
    /// 词法合法但超出题目 archBits 值域(XS-ARCH-WIDTH)。
    OutOfRange {
        /// 声明位宽。
        bits: u32,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Xorshift64Star;

    const A32: ArchBits = ArchBits::B32;
    const A64: ArchBits = ArchBits::B64;

    fn v(raw: u64, arch: ArchBits) -> ArchValue {
        ArchValue::new(raw, arch)
    }

    // ─────────────────────────────────────────────────────────────────────
    // 掩蔽不变量(属性:任意输入 → 结果恒在掩蔽域内)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn construction_masks_high_bits_both_widths() {
        assert_eq!(v(0x1_0000_0005, A32).get(), 5);
        assert_eq!(v(u64::MAX, A32).get(), 0xFFFF_FFFF);
        assert_eq!(v(u64::MAX, A64).get(), u64::MAX);
        assert_eq!(
            v(0x1234_5678_9ABC_DEF0, A32).get(),
            0x5678_9ABC_DEF0 & 0xFFFF_FFFF
        );
    }

    #[test]
    fn property_all_ops_stay_in_masked_domain() {
        let mut rng = Xorshift64Star::new(0xC0FFEE);
        for arch in [A32, A64] {
            let mask = arch.mask();
            for _ in 0..4096 {
                let a = ArchValue::new(rng.next_u64(), arch);
                let b = ArchValue::new(rng.next_u64(), arch);
                let shift = rng.next_below(200);
                let results = [
                    a.add(b, arch).get(),
                    a.sub(b, arch).get(),
                    a.and(b, arch).get(),
                    a.or(b, arch).get(),
                    a.xor(b, arch).get(),
                    a.not(arch).get(),
                    a.shl(shift, arch).get(),
                    a.shr(shift, arch).get(),
                    ArchValue::from_signed(rng.next_u64() as i64, arch).get(),
                    a.add_with_carry(b, arch).0.get(),
                    a.sub_with_borrow(b, arch).0.get(),
                ];
                for r in results {
                    assert!(
                        r <= mask,
                        "掩蔽域不变量被破坏: {r:#x} > {mask:#x} (arch={arch:?})"
                    );
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // 算术语义:模 2^n、进位 / 借位(32 / 64 双位宽行为矩阵)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn add_is_modular_and_carry_is_exact() {
        // 32 位:0xFFFFFFFF + 1 → 0,进位。
        let (s, c) = v(0xFFFF_FFFF, A32).add_with_carry(v(1, A32), A32);
        assert_eq!((s.get(), c), (0, true));
        // 32 位:域内加法无进位。
        let (s, c) = v(0x4000_0000, A32).add_with_carry(v(0x4000_0000, A32), A32);
        assert_eq!((s.get(), c), (0x8000_0000, false));
        // 64 位:u64::MAX + 1 → 0,进位。
        let (s, c) = v(u64::MAX, A64).add_with_carry(v(1, A64), A64);
        assert_eq!((s.get(), c), (0, true));
    }

    #[test]
    fn add_is_commutative_and_modular_property() {
        let mut rng = Xorshift64Star::new(0xA110);
        for arch in [A32, A64] {
            let mask = arch.mask();
            for _ in 0..4096 {
                let a = rng.next_u64();
                let b = rng.next_u64();
                let lhs = v(a, arch).add(v(b, arch), arch).get();
                let rhs = v(b, arch).add(v(a, arch), arch).get();
                assert_eq!(lhs, rhs);
                assert_eq!(lhs, a.wrapping_add(b) & mask, "加法必须等于模 2^n 语义");
            }
        }
    }

    #[test]
    fn sub_is_modular_and_borrow_is_exact() {
        // 32 位:0 − 1 → 0xFFFFFFFF(模减回绕),借位。
        let (d, br) = v(0, A32).sub_with_borrow(v(1, A32), A32);
        assert_eq!((d.get(), br), (0xFFFF_FFFF, true));
        // 64 位:0 − 1 → u64::MAX,借位。
        let (d, br) = v(0, A64).sub_with_borrow(v(1, A64), A64);
        assert_eq!((d.get(), br), (u64::MAX, true));
        // 相等不借位;大于不借位。
        assert_eq!(
            v(5, A32).sub_with_borrow(v(5, A32), A32),
            (v(0, A32), false)
        );
        assert_eq!(
            v(6, A32).sub_with_borrow(v(5, A32), A32),
            (v(1, A32), false)
        );
    }

    #[test]
    fn bitwise_and_negation_semantics() {
        assert_eq!(
            v(0xF0F0_F0F0, A32).and(v(0xFFFF_0000, A32), A32).get(),
            0xF0F0_0000
        );
        assert_eq!(
            v(0xF0F0_0000, A32).or(v(0x0000_0F0F, A32), A32).get(),
            0xF0F0_0F0F
        );
        assert_eq!(
            v(0xFF00_FF00, A32).xor(v(0xFFFF_0000, A32), A32).get(),
            0x00FF_FF00
        );
        // 32 位取反只翻转低 32 位:0 → 0xFFFFFFFF,不是 u64::MAX。
        assert_eq!(v(0, A32).not(A32).get(), 0xFFFF_FFFF);
        assert_eq!(v(0, A64).not(A64).get(), u64::MAX);
    }

    #[test]
    fn shift_semantics_both_widths() {
        // 32 位:1 << 31 = 0x80000000;<< 32 → 0(移位量 ≥ 位宽)。
        assert_eq!(v(1, A32).shl(31, A32).get(), 0x8000_0000);
        assert_eq!(v(1, A32).shl(32, A32).get(), 0);
        assert_eq!(v(1, A32).shl(63, A32).get(), 0);
        assert_eq!(v(1, A32).shl(u64::MAX, A32).get(), 0);
        // 64 位:1 << 63 合法;<< 64 → 0。
        assert_eq!(v(1, A64).shl(63, A64).get(), 0x8000_0000_0000_0000);
        assert_eq!(v(1, A64).shl(64, A64).get(), 0);
        // 逻辑右移高位补 0;移出即丢。
        assert_eq!(v(0x8000_0000, A32).shr(31, A32).get(), 1);
        assert_eq!(v(0xFFFF_FFFF, A32).shr(4, A32).get(), 0x0FFF_FFFF);
        assert_eq!(v(u64::MAX, A64).shr(64, A64).get(), 0);
        // 32 位掩蔽值左移后高位不出 32 位域。
        assert_eq!(v(0xFFFF_FFFF, A32).shl(4, A32).get(), 0xFFFF_FFF0);
    }

    #[test]
    fn ordering_is_unsigned_domain_order() {
        // 32 位域内:0xFFFF_FFFF > 0(无符号序;jb/jae 底座)。
        assert!(v(0xFFFF_FFFF, A32) > v(0, A32));
        assert!(v(5, A32) >= v(5, A32));
        assert!(v(1, A32) < v(2, A32));
    }

    #[test]
    fn from_signed_is_twos_complement_masked() {
        assert_eq!(ArchValue::from_signed(-1, A32).get(), 0xFFFF_FFFF);
        assert_eq!(ArchValue::from_signed(-1, A64).get(), u64::MAX);
        assert_eq!(ArchValue::from_signed(-2, A32).get(), 0xFFFF_FFFE);
        assert_eq!(ArchValue::from_signed(0x7FFF_FFFF, A32).get(), 0x7FFF_FFFF);
        assert_eq!(ArchValue::from_signed(-0x8000_0000, A32).get(), 0x8000_0000);
        // -1 加 1 回绕到 0:补码加法在掩蔽域内自洽。
        assert_eq!(ArchValue::from_signed(-1, A32).add(v(1, A32), A32).get(), 0);
    }

    #[test]
    fn max_and_zero_helpers() {
        assert_eq!(ArchValue::max_value(A32).get(), 0xFFFF_FFFF);
        assert_eq!(ArchValue::max_value(A64).get(), u64::MAX);
        assert_eq!(ArchValue::ZERO.get(), 0);
    }

    // ─────────────────────────────────────────────────────────────────────
    // 十六进制边界(地址域):词法、值域、格式化
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn parse_hex_accepts_contract_lexical_form() {
        // fixture 形态:0x400000(地址)、0x7FFFFFF8(值,大小写均可入)。
        assert_eq!(
            ArchValue::parse_hex("0x400000", A32).unwrap().get(),
            0x40_0000
        );
        assert_eq!(
            ArchValue::parse_hex("0x7FFFFFF8", A32).unwrap().get(),
            0x7FFF_FFF8
        );
        assert_eq!(
            ArchValue::parse_hex("0x7ffff000", A32).unwrap().get(),
            0x7FFF_F000
        );
        assert_eq!(ArchValue::parse_hex("0x0", A64).unwrap().get(), 0);
        assert_eq!(
            ArchValue::parse_hex("0xFFFFFFFF", A32).unwrap().get(),
            0xFFFF_FFFF
        );
        assert_eq!(
            ArchValue::parse_hex("0xFFFFFFFFFFFFFFFF", A64)
                .unwrap()
                .get(),
            u64::MAX
        );
    }

    #[test]
    fn parse_hex_rejects_malformed_forms() {
        for bad in [
            "",
            "0x",
            "400000",
            "0X400000", // 契约词法只允许小写 0x 前缀
            "0xGG",
            "0x400000 ",
            " 0x400000",
            "0x-1",
            "0x00000000000000000", // 17 位:超出 {1,16} 词法
        ] {
            assert_eq!(
                ArchValue::parse_hex(bad, A64),
                Err(HexValueError::Malformed),
                "形态 {bad:?} 必须被判 Malformed"
            );
        }
    }

    #[test]
    fn parse_hex_rejects_out_of_arch_width_values() {
        // XS-ARCH-WIDTH 引擎侧镜像:32 位题目收 33 位值 → fail-closed。
        assert_eq!(
            ArchValue::parse_hex("0x100000000", A32),
            Err(HexValueError::OutOfRange { bits: 32 })
        );
        assert_eq!(
            ArchValue::parse_hex("0xFFFFFFFFFFFFFFFF", A32),
            Err(HexValueError::OutOfRange { bits: 32 })
        );
        // 64 位容器即 64 位域上界,不存在 OutOfRange(16 位词法已封顶)。
        assert!(ArchValue::parse_hex("0xFFFFFFFFFFFFFFFF", A64).is_ok());
    }

    #[test]
    fn format_hex_is_variable_length_uppercase() {
        assert_eq!(v(0, A32).format_hex(), "0x0");
        assert_eq!(v(0x40_0000, A32).format_hex(), "0x400000");
        assert_eq!(v(0x7FFF_FFF8, A32).format_hex(), "0x7FFFFFF8");
        assert_eq!(v(0xFFFF_FFFF, A32).format_hex(), "0xFFFFFFFF");
        assert_eq!(v(u64::MAX, A64).format_hex(), "0xFFFFFFFFFFFFFFFF");
    }

    #[test]
    fn hex_roundtrip_property() {
        let mut rng = Xorshift64Star::new(0xBEEF);
        for arch in [A32, A64] {
            for _ in 0..2048 {
                let a = ArchValue::new(rng.next_u64(), arch);
                let text = a.format_hex();
                let back = ArchValue::parse_hex(&text, arch).expect("自产 hex 必须可解析");
                assert_eq!(back, a, "roundtrip 失败:{text}");
            }
        }
    }

    #[test]
    fn arch_bits_helpers() {
        assert_eq!(ArchBits::from_bits(32), Some(A32));
        assert_eq!(ArchBits::from_bits(64), Some(A64));
        assert_eq!(ArchBits::from_bits(16), None);
        assert_eq!(ArchBits::from_bits(128), None);
        assert_eq!(A32.bits(), 32);
        assert_eq!(A32.mask(), 0xFFFF_FFFF);
        assert_eq!(A64.mask(), u64::MAX);
        // 位宽排序仅用于确定性遍历(32 < 64)。
        assert!(A32 < A64);
    }
}

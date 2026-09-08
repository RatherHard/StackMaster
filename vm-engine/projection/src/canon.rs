//! 生成面规范化 JSON 文本写入器(`stackmaster-canonical-json/1`,规范化 §三)。
//!
//! # 三面分工(同一冻结文法,角色不同)
//!
//! 仓库内规范化序列化有三处落点,全部遵守 `docs/contracts/规范化JSON序列化.md`
//! 的同一文法(键按 UTF-16 码元序、最短转义、零空白、整数十进制):
//!
//! | 落点 | 输入域 | 角色 |
//! |---|---|---|
//! | `vm-runtime::canon` | 引擎内部值树(状态形态 / 日志 / 快照) | 值树写入器 + 严格解析器 |
//! | `vm_worker::contract::canonical` | 入站契约文本 | 文本消费侧规范化 |
//! | 本模块 | **本 crate 的投影输出类型** | 生成面输出文本(差分测试 / 哈希锚定) |
//!
//! 本模块不提供通用值树:投影输出的对象键集合全部是契约冻结的字面量集合,
//! 每个类型的 `to_canonical`(见 [`crate::types`])是直线写入函数,键序在
//! 编译期固化为该键集的 UTF-16 码元序(每类型键序由专测断言,防手写漂移)。
//! 文法风险收敛到字符串转义与十六进制编码两处原语,由金面向量锁定。
//!
//! 差分测试(T-SC1 / T-SC4,ZR-P3)以本模块产出的文本逐字节比较——
//! 投影是服务端单方生成的输出面,单一规范形态使"秘密变体下字节相等"
//! 有稳定锚点(投影与错误契约语义 §2.3)。

use alloc::string::String;
use core::fmt::Write as _;

/// 字符串最短转义(规范化 §3.1):`"` `\` 与 C0;非 ASCII 原样 UTF-8。
/// 与 `vm-runtime::canon` 同规则;金面向量见测试(两处测试断言同一输出)。
pub fn escape_json_string(text: &str, out: &mut String) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{09}' => out.push_str("\\t"),
            '\u{0a}' => out.push_str("\\n"),
            '\u{0c}' => out.push_str("\\f"),
            '\u{0d}' => out.push_str("\\r"),
            character if (character as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", character as u32);
            }
            // 其余字符(含非 ASCII 与增补平面)按 UTF-8 原样输出(§3.1)。
            character => out.push(character),
        }
    }
    out.push('"');
}

/// UTF-16 码元序比较(JCS / ECMAScript 字符串 `<` 的语义;规范化 §3.2)。
///
/// 生成面不动态构造对象键,本函数用于**键序自检测试**:每个输出类型的
/// 键字面量序列必须已按本序排列(防手写键序漂移)。
pub fn compare_utf16(a: &str, b: &str) -> core::cmp::Ordering {
    let mut left = a.encode_utf16();
    let mut right = b.encode_utf16();
    loop {
        match (left.next(), right.next()) {
            (None, None) => return core::cmp::Ordering::Equal,
            (None, Some(_)) => return core::cmp::Ordering::Less,
            (Some(_), None) => return core::cmp::Ordering::Greater,
            (Some(l), Some(r)) => {
                if l != r {
                    return l.cmp(&r);
                }
            }
        }
    }
}

/// 字节序列 → 小写十六进制(无分隔;`bytesHex` / `payloadHex` 契约形态)。
///
/// 生成面统一小写(golden fixture 同约定);与地址 / 寄存器值的**大写**变长
/// 形态(`ArchValue::format_hex`,协议 §2.3 冻结)是两类不同的公开字节面。
pub fn hex_encode_lower(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0xF) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    extern crate std;

    use alloc::vec::Vec;
    use alloc::{string::String, vec};

    use super::*;

    /// 转义金面向量:与 `vm-runtime::canon` 测试的同一组输入输出
    /// (两处实现以相同向量锁定同一文法)。
    #[test]
    fn escape_golden_vectors_match_frozen_grammar() {
        let cases: Vec<(&str, &str)> = vec![
            ("a\"b\\c\nd", "\"a\\\"b\\\\c\\nd\""),
            ("中文\u{1F600}", "\"中文\u{1F600}\""),
            ("", "\"\""),
            ("\u{00}\u{1f}\u{7f}", "\"\\u0000\\u001f\u{7f}\""),
            ("\u{08}\u{09}\u{0c}\u{0d}", "\"\\b\\t\\f\\r\""),
        ];
        for (input, expected) in cases {
            let mut out = String::new();
            escape_json_string(input, &mut out);
            assert_eq!(out, expected, "输入 {input:?} 的转义应与冻结文法一致");
        }
    }

    /// 键序比较的增补平面语义:U+10000(码元 D800 DC00)按**码元**排在
    /// U+FFFF 之前——与 vm-runtime 测试同一向量。
    #[test]
    fn utf16_order_supplementary_plane() {
        assert_eq!(
            compare_utf16("\u{10000}", "\u{FFFF}"),
            core::cmp::Ordering::Less
        );
        assert_eq!(compare_utf16("a", "b"), core::cmp::Ordering::Less);
        assert_eq!(compare_utf16("b", "a"), core::cmp::Ordering::Greater);
        assert_eq!(compare_utf16("同", "同"), core::cmp::Ordering::Equal);
    }

    #[test]
    fn hex_lower_encoding() {
        assert_eq!(hex_encode_lower(&[]), "");
        assert_eq!(hex_encode_lower(&[0x00, 0x0f, 0xff]), "000fff");
        assert_eq!(hex_encode_lower(&[0xde, 0xad, 0xbe, 0xef]), "deadbeef");
    }
}

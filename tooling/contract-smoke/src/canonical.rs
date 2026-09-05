//! 规范化 JSON 序列化的 Rust 消费侧镜像(docs/contracts/规范化JSON序列化.md)。
//!
//! 标识 `stackmaster-canonical-json/1`:JCS 整数域子集。TS 参考实现在
//! `packages/protocol/src/common/canonical-json.ts`;两侧由 golden fixture
//! 摘要清单(tooling/contract-smoke/canonical-digests.json)锁定,任何一侧
//! 单方修改规则即冒烟失败。
//!
//! 数值规则的双语言对齐要点:
//! - serde_json 把整数字面量解析为 i64/u64(精确),指数写法解析为 f64;
//!   TS JSON.parse 统一为 f64。安全性判定:整数字面量按 `|n| ≤ 2^53 − 1`,
//!   f64 按 `fract() == 0 && |f| < 2^53`,与 TS `Number.isSafeInteger` 结论一致;
//! - `-0`(i64/f64)输出 `0`,承 JCS 与 TS `String(-0) === "0"`;
//! - 对象键按 **UTF-16 码元序**排序(TS 默认字符串比较的语义),
//!   不是 UTF-8 字节序——两者在 U+E000..U+FFFF 与增补平面之间有差异。

use crate::strict_value::StrictValue;
use serde_json::Number;
use std::fmt;
use std::fmt::Write as _;

/// 嵌套深度护栏(规范 §3.3;与 TS `MAX_CANONICAL_JSON_DEPTH` 同值)。
pub const MAX_CANONICAL_JSON_DEPTH: usize = 512;

const MAX_SAFE_INTEGER: i128 = 9_007_199_254_740_991;

/// 规范化失败原因;`code()` 与 TS `CanonicalJsonErrorCode` 同串(清单比对依据)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanonicalError {
    InvalidJson,
    DuplicateKey,
    NonIntegerNumber,
    UnsafeInteger,
    LoneSurrogate,
    MaxDepthExceeded,
}

impl CanonicalError {
    pub fn code(&self) -> &'static str {
        match self {
            CanonicalError::InvalidJson => "invalid_json",
            CanonicalError::DuplicateKey => "duplicate_key",
            CanonicalError::NonIntegerNumber => "non_integer_number",
            CanonicalError::UnsafeInteger => "unsafe_integer",
            CanonicalError::LoneSurrogate => "lone_surrogate",
            CanonicalError::MaxDepthExceeded => "max_depth_exceeded",
        }
    }
}

impl fmt::Display for CanonicalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            CanonicalError::InvalidJson => "JSON 语法错误或非法结构",
            CanonicalError::DuplicateKey => "JSON 对象出现重复键",
            CanonicalError::NonIntegerNumber => "数值域仅允许整数",
            CanonicalError::UnsafeInteger => "整数超出 ±(2^53 − 1) 安全域",
            CanonicalError::LoneSurrogate => "字符串含孤立代理项",
            CanonicalError::MaxDepthExceeded => "嵌套深度超过护栏",
        };
        write!(formatter, "规范化失败({}):{message}", self.code())
    }
}

/// 文本入口:严格解析(拒绝重复键)后规范化。
pub fn canonicalize_json_text(text: &str) -> Result<String, CanonicalError> {
    let value = StrictValue::parse(text)?;
    canonicalize(&value)
}

/// 内存态入口:对严格解析后的 JSON 值做规范化。
pub fn canonicalize(value: &StrictValue) -> Result<String, CanonicalError> {
    let mut out = String::new();
    write_value(value, &mut out, 0)?;
    Ok(out)
}

fn write_value(value: &StrictValue, out: &mut String, depth: usize) -> Result<(), CanonicalError> {
    if depth > MAX_CANONICAL_JSON_DEPTH {
        return Err(CanonicalError::MaxDepthExceeded);
    }
    match value {
        StrictValue::Null => out.push_str("null"),
        StrictValue::Bool(true) => out.push_str("true"),
        StrictValue::Bool(false) => out.push_str("false"),
        StrictValue::Number(number) => out.push_str(&write_number(number)?),
        StrictValue::String(text) => write_json_string(text, out),
        StrictValue::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(item, out, depth + 1)?;
            }
            out.push(']');
        }
        StrictValue::Object(entries) => {
            let mut sorted: Vec<&(String, StrictValue)> = entries.iter().collect();
            sorted.sort_by(|(a, _), (b, _)| compare_utf16(a, b));
            out.push('{');
            for (index, (key, item)) in sorted.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json_string(key, out);
                out.push(':');
                write_value(item, out, depth + 1)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// 按 UTF-16 码元序列比较(与 TS 默认字符串排序一致,规范 §三)。
fn compare_utf16(a: &str, b: &str) -> std::cmp::Ordering {
    let mut left = a.encode_utf16();
    let mut right = b.encode_utf16();
    loop {
        match (left.next(), right.next()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(l), Some(r)) => {
                if l != r {
                    return l.cmp(&r);
                }
            }
        }
    }
}

fn write_number(number: &Number) -> Result<String, CanonicalError> {
    if let Some(int) = number.as_i64() {
        let magnitude = (int as i128).abs();
        if magnitude > MAX_SAFE_INTEGER {
            return Err(CanonicalError::UnsafeInteger);
        }
        return Ok(int.to_string());
    }
    if let Some(uint) = number.as_u64() {
        if (uint as i128) > MAX_SAFE_INTEGER {
            return Err(CanonicalError::UnsafeInteger);
        }
        return Ok(uint.to_string());
    }
    let float = number.as_f64().ok_or(CanonicalError::NonIntegerNumber)?;
    if !float.is_finite() || float.fract() != 0.0 {
        return Err(CanonicalError::NonIntegerNumber);
    }
    // 2^53 及以上:TS isSafeInteger 拒绝,f64 侧以开区间对齐(边界论证见模块注释)。
    if float.abs() >= 9_007_199_254_740_992.0 {
        return Err(CanonicalError::UnsafeInteger);
    }
    if float == 0.0 {
        return Ok("0".to_owned());
    }
    // |f| < 2^53 的整数值在 Rust Display 与 TS String(n) 下均为无指数十进制。
    let mut rendered = String::new();
    let _ = write!(rendered, "{}", float);
    Ok(rendered)
}

fn write_json_string(text: &str, out: &mut String) {
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
            // 其余字符(含非 ASCII 与增补平面)按 UTF-8 原样输出;
            // Rust String 不可能含孤立代理项,TS 侧已在输入检查中拒绝。
            character => out.push(character),
        }
    }
    out.push('"');
}

//! 规范化 JSON(`stackmaster-canonical-json/1`)的引擎侧实现:值树、规范化
//! 写入器与严格解析器([docs/contracts/规范化JSON序列化.md])。
//!
//! 动作日志条目、快照载荷与状态哈希的序列化形态都经本模块(6.3"规范化序列化
//! + SHA-256";§一适用场景表)。
//!
//! 与 `vm_worker::contract::canonical`(契约文本消费侧)的分工:本模块服务
//! 引擎内部形态——值树由构造方(状态形态 / 日志 / 快照)直接搭建,数值域
//! 天然整数,故只需**写入器**(键序 / 转义 / 整数十进制)与**严格解析器**
//! (快照导入 / 日志重建的读回路径)。两者与 TS 参考实现遵守同一文法规则(§三):
//!

//! 1. 数值域 = 安全整数(±(2^53 − 1)),超界拒绝(fail-closed);
//! 2. 对象键按 UTF-16 码元序升序(与 JCS / ECMAScript `<` 一致——增补平面
//!    与 U+E000..U+FFFF 之间不同于 UTF-8 字节序,不取巧);
//! 3. 字符串最短转义(`"` `\` 与 C0;非 ASCII 原样 UTF-8);
//! 4. 数组保序、对象零空白;嵌套深度护栏 512(§3.3)。
//!
//! 解析器按同一规范收严:拒绝重复键(转义解码后同键)、非整数数值、非法
//! UTF-16 转义(含孤立代理项)、深度越界。

use alloc::string::String;
use alloc::vec::Vec;
use core::fmt::Write as _;

/// 嵌套深度护栏(规范 §3.3;与 TS `MAX_CANONICAL_JSON_DEPTH` 同值)。
pub const MAX_DEPTH: usize = 512;

/// 安全整数上界(2^53 − 1;规范化 §二)。
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// 规范化 JSON 值树(整数域;对象为键值对序列,写入时按键序排列)。
#[derive(Debug, Clone, PartialEq)]
pub enum CanonValue {
    /// `null`。
    Null,
    /// 布尔。
    Bool(bool),
    /// 整数(构造侧经 [`CanonValue::int`] 守卫安全整数域)。
    Int(i64),
    /// 字符串。
    Str(String),
    /// 数组(保序)。
    Array(Vec<CanonValue>),
    /// 对象(写入时按键的 UTF-16 码元序排序;构造键不得重复)。
    Object(Vec<(String, CanonValue)>),
}

/// 构造 / 序列化错误(方向 = engine_error:形态由引擎构造,越界即缺陷)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanonError {
    /// 整数超出安全整数域。
    UnsafeInteger,
    /// 对象键重复(构造侧)。
    DuplicateKey,
    /// 嵌套深度越界。
    MaxDepth,
    /// 文本解析失败(读回路径)。
    Malformed,
}

impl CanonError {
    /// 机器可读码(与 TS `CanonicalJsonErrorCode` 同串语义)。
    pub fn code(self) -> &'static str {
        match self {
            CanonError::UnsafeInteger => "unsafe_integer",
            CanonError::DuplicateKey => "duplicate_key",
            CanonError::MaxDepth => "max_depth_exceeded",
            CanonError::Malformed => "invalid_json",
        }
    }
}

impl CanonValue {
    /// 整数构造:安全整数域守卫(fail-closed;§二数值域)。
    pub fn int(value: i64) -> Result<Self, CanonError> {
        if value.abs() > MAX_SAFE_INTEGER {
            return Err(CanonError::UnsafeInteger);
        }
        Ok(CanonValue::Int(value))
    }

    /// `u64` 整数构造(超出安全整数域即拒绝——上游资源预算使正常值远不可达)。
    pub fn from_u64(value: u64) -> Result<Self, CanonError> {
        if value > MAX_SAFE_INTEGER as u64 {
            return Err(CanonError::UnsafeInteger);
        }
        Ok(CanonValue::Int(value as i64))
    }

    /// 字符串构造。
    pub fn str(value: &str) -> Self {
        CanonValue::Str(String::from(value))
    }

    /// 对象构造:键重复即拒绝(fail-closed;§二重复键禁令的构造侧镜像)。
    pub fn object(pairs: Vec<(&str, CanonValue)>) -> Result<Self, CanonError> {
        let mut seen: Vec<&str> = Vec::with_capacity(pairs.len());
        for (key, _) in &pairs {
            if seen.contains(key) {
                return Err(CanonError::DuplicateKey);
            }
            seen.push(key);
        }
        Ok(CanonValue::Object(
            pairs
                .into_iter()
                .map(|(key, value)| (String::from(key), value))
                .collect(),
        ))
    }
}

/// 规范化序列化:返回紧凑 JSON 文本(零空白;§三)。
pub fn write_canonical(value: &CanonValue) -> Result<String, CanonError> {
    let mut out = String::new();
    write_value(value, &mut out, 0)?;
    Ok(out)
}

fn write_value(value: &CanonValue, out: &mut String, depth: usize) -> Result<(), CanonError> {
    if depth > MAX_DEPTH {
        return Err(CanonError::MaxDepth);
    }
    match value {
        CanonValue::Null => out.push_str("null"),
        CanonValue::Bool(true) => out.push_str("true"),
        CanonValue::Bool(false) => out.push_str("false"),
        CanonValue::Int(number) => {
            let _ = write!(out, "{number}");
        }
        CanonValue::Str(text) => write_json_string(text, out),
        CanonValue::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(item, out, depth + 1)?;
            }
            out.push(']');
        }
        CanonValue::Object(entries) => {
            let mut sorted: Vec<&(String, CanonValue)> = entries.iter().collect();
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

/// UTF-16 码元序比较(JCS / ECMAScript 字符串 `<` 的语义)。
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
            // 其余字符(含非 ASCII 与增补平面)按 UTF-8 原样输出(§3.1)。
            character => out.push(character),
        }
    }
    out.push('"');
}

// ─────────────────────────────────────────────────────────────────────────────
// 严格解析器(读回路径:快照导入 / 日志重建;同一规范收严)
// ─────────────────────────────────────────────────────────────────────────────

/// 严格解析规范化 JSON 文本:拒绝重复键、非整数数值、孤立代理项、深度越界。
pub fn parse_canonical(text: &str) -> Result<CanonValue, CanonError> {
    let mut parser = Parser {
        bytes: text.as_bytes(),
        pos: 0,
        depth: 0,
    };
    parser.skip_ws();
    let value = parser.parse_value()?;
    parser.skip_ws();
    if parser.pos != parser.bytes.len() {
        return Err(CanonError::Malformed);
    }
    Ok(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
    depth: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> Result<(), CanonError> {
        if self.peek() == Some(byte) {
            self.pos += 1;
            Ok(())
        } else {
            Err(CanonError::Malformed)
        }
    }

    fn parse_value(&mut self) -> Result<CanonValue, CanonError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(CanonError::MaxDepth);
        }
        let value = match self.peek() {
            Some(b'n') => {
                self.literal(b"null")?;
                Ok(CanonValue::Null)
            }
            Some(b't') => {
                self.literal(b"true")?;
                Ok(CanonValue::Bool(true))
            }
            Some(b'f') => {
                self.literal(b"false")?;
                Ok(CanonValue::Bool(false))
            }
            Some(b'"') => Ok(CanonValue::Str(self.parse_string()?)),
            Some(b'[') => self.parse_array(),
            Some(b'{') => self.parse_object(),
            Some(b'-' | b'0'..=b'9') => self.parse_int(),
            _ => Err(CanonError::Malformed),
        };
        self.depth -= 1;
        value
    }

    fn literal(&mut self, word: &[u8]) -> Result<(), CanonError> {
        if self.bytes.len() - self.pos >= word.len()
            && &self.bytes[self.pos..self.pos + word.len()] == word
        {
            self.pos += word.len();
            Ok(())
        } else {
            Err(CanonError::Malformed)
        }
    }

    fn parse_int(&mut self) -> Result<CanonValue, CanonError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        let digits_start = self.pos;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
        if self.pos == digits_start {
            return Err(CanonError::Malformed);
        }
        // 非整数数值一律拒绝(§二):小数点 / 指数不消费,落回剩余检查。
        if matches!(self.peek(), Some(b'.' | b'e' | b'E')) {
            return Err(CanonError::Malformed);
        }
        // 前导零拒绝(规范化数值形态;文本形态由解析器收严为最短十进制)。
        let digits = &self.bytes[digits_start..self.pos];
        if digits.len() > 1 && digits[0] == b'0' {
            return Err(CanonError::Malformed);
        }
        let text = core::str::from_utf8(&self.bytes[start..self.pos])
            .map_err(|_| CanonError::Malformed)?;
        let magnitude_text = text.strip_prefix('-').unwrap_or(text);
        if magnitude_text.len() > 19 {
            return Err(CanonError::UnsafeInteger);
        }
        let mut magnitude: u64 = 0;
        for digit in magnitude_text.bytes() {
            magnitude = magnitude
                .checked_mul(10)
                .and_then(|acc| acc.checked_add(u64::from(digit - b'0')))
                .ok_or(CanonError::UnsafeInteger)?;
        }
        if magnitude > MAX_SAFE_INTEGER as u64 {
            return Err(CanonError::UnsafeInteger);
        }
        let value = if text.starts_with('-') {
            -(magnitude as i64)
        } else {
            magnitude as i64
        };
        Ok(CanonValue::Int(value))
    }

    fn parse_string(&mut self) -> Result<String, CanonError> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let Some(byte) = self.peek() else {
                return Err(CanonError::Malformed);
            };
            match byte {
                b'"' => {
                    self.pos += 1;
                    return Ok(out);
                }
                0x00..=0x1f => return Err(CanonError::Malformed),
                b'\\' => {
                    self.pos += 1;
                    let escape = self.peek().ok_or(CanonError::Malformed)?;
                    self.pos += 1;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{08}'),
                        b'f' => out.push('\u{0c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let code = self.parse_hex4()?;
                            // 代理对:高代理必须紧跟 \uDC00..\uDFFF;孤立代理拒绝。
                            if (0xD800..0xDC00).contains(&code) {
                                if self.peek() != Some(b'\\') {
                                    return Err(CanonError::Malformed);
                                }
                                self.pos += 1;
                                if self.peek() != Some(b'u') {
                                    return Err(CanonError::Malformed);
                                }
                                self.pos += 1;
                                let low = self.parse_hex4()?;
                                if !(0xDC00..0xE000).contains(&low) {
                                    return Err(CanonError::Malformed);
                                }
                                let combined = 0x1_0000
                                    + ((u32::from(code) - 0xD800) << 10)
                                    + (u32::from(low) - 0xDC00);
                                let character =
                                    char::from_u32(combined).ok_or(CanonError::Malformed)?;
                                out.push(character);
                            } else if (0xDC00..0xE000).contains(&code) {
                                return Err(CanonError::Malformed);
                            } else {
                                let character =
                                    char::from_u32(u32::from(code)).ok_or(CanonError::Malformed)?;
                                out.push(character);
                            }
                        }
                        _ => return Err(CanonError::Malformed),
                    }
                }
                _ => {
                    // UTF-8 原样字节:按字符边界消费(Rust &str 输入保证合法 UTF-8)。
                    let rest = core::str::from_utf8(&self.bytes[self.pos..])
                        .map_err(|_| CanonError::Malformed)?;
                    let character = rest.chars().next().ok_or(CanonError::Malformed)?;
                    out.push(character);
                    self.pos += character.len_utf8();
                }
            }
        }
    }

    fn parse_hex4(&mut self) -> Result<u16, CanonError> {
        if self.pos + 4 > self.bytes.len() {
            return Err(CanonError::Malformed);
        }
        let text = core::str::from_utf8(&self.bytes[self.pos..self.pos + 4])
            .map_err(|_| CanonError::Malformed)?;
        let mut value: u16 = 0;
        for character in text.chars() {
            let digit = character.to_digit(16).ok_or(CanonError::Malformed)?;
            value = value * 16 + u16::try_from(digit).map_err(|_| CanonError::Malformed)?;
        }
        self.pos += 4;
        Ok(value)
    }

    fn parse_array(&mut self) -> Result<CanonValue, CanonError> {
        self.expect(b'[')?;
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(CanonValue::Array(items));
        }
        loop {
            self.skip_ws();
            items.push(self.parse_value()?);
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b']') => {
                    self.pos += 1;
                    return Ok(CanonValue::Array(items));
                }
                _ => return Err(CanonError::Malformed),
            }
        }
    }

    fn parse_object(&mut self) -> Result<CanonValue, CanonError> {
        self.expect(b'{')?;
        let mut pairs: Vec<(String, CanonValue)> = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(CanonValue::Object(pairs));
        }
        loop {
            self.skip_ws();
            let key = self.parse_string()?;
            self.skip_ws();
            self.expect(b':')?;
            self.skip_ws();
            let value = self.parse_value()?;
            // 重复键拒绝(按转义解码后的精确拼写;§二)。
            if pairs.iter().any(|(existing, _)| *existing == key) {
                return Err(CanonError::DuplicateKey);
            }
            pairs.push((key, value));
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(CanonValue::Object(pairs));
                }
                _ => return Err(CanonError::Malformed),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use alloc::format;
    use alloc::vec;

    fn roundtrip(value: CanonValue, expected: &str) {
        let text = write_canonical(&value).unwrap();
        assert_eq!(text, expected);
        // 写出文本必被严格解析器接受,读回再写出为同一文本(幂等)。
        let reparsed = parse_canonical(&text).unwrap();
        assert_eq!(write_canonical(&reparsed).unwrap(), expected);
    }

    #[test]
    fn scalars_arrays_and_object_key_order() {
        roundtrip(CanonValue::Null, "null");
        roundtrip(CanonValue::Bool(true), "true");
        roundtrip(CanonValue::Bool(false), "false");
        roundtrip(CanonValue::Int(0), "0");
        roundtrip(CanonValue::Int(-7), "-7");
        roundtrip(CanonValue::str("a\"b\\c\nd"), "\"a\\\"b\\\\c\\nd\"");
        roundtrip(CanonValue::str("中文\u{1F600}"), "\"中文\u{1F600}\"");
        roundtrip(
            CanonValue::Array(vec![CanonValue::Int(1), CanonValue::str("x")]),
            "[1,\"x\"]",
        );
        // 键按 UTF-16 码元序(b < a~ 因为 'b'(0x62) < 'a'(0x61)? 不——
        // 'a' < 'b';此处验证排序与空白零容忍)。
        roundtrip(
            CanonValue::object(vec![("b", CanonValue::Int(2)), ("a", CanonValue::Int(1))]).unwrap(),
            "{\"a\":1,\"b\":2}",
        );
    }

    /// UTF-16 码元序与码点序在增补平面上的差异:U+10000(代理对 D800..)按
    /// **码元**排在 U+FFFF 之前——键序必须按码元,不按码点(也不按 UTF-8 字节序)。
    #[test]
    fn key_order_is_utf16_code_unit_order() {
        let value = CanonValue::object(vec![
            ("\u{FFFF}", CanonValue::Int(2)),
            ("\u{10000}", CanonValue::Int(1)),
        ])
        .unwrap();
        let text = write_canonical(&value).unwrap();
        // UTF-16:U+FFFF = [0xFFFF];U+10000 = [0xD800, 0xDC00]。0xD800 < 0xFFFF
        // ⇒ U+10000 的键排在前面。
        assert_eq!(text, "{\"\u{10000}\":1,\"\u{FFFF}\":2}");
    }

    #[test]
    fn unsafe_integer_and_duplicate_key_rejected_on_construction() {
        assert_eq!(
            CanonValue::int(MAX_SAFE_INTEGER),
            Ok(CanonValue::Int(MAX_SAFE_INTEGER))
        );
        assert_eq!(
            CanonValue::int(MAX_SAFE_INTEGER + 1),
            Err(CanonError::UnsafeInteger)
        );
        assert_eq!(
            CanonValue::from_u64(9_223_372_036_854_775_807),
            Err(CanonError::UnsafeInteger)
        );
        assert_eq!(
            CanonValue::object(vec![("k", CanonValue::Int(1)), ("k", CanonValue::Int(2)),]),
            Err(CanonError::DuplicateKey)
        );
    }

    #[test]
    fn parser_rejects_malformed_inputs() {
        // 语法失败。
        for bad in [
            "",
            "  ",
            "{",
            "{\"a\":}",
            "{\"a\" 1}",
            "[1,]",
            "1x",
            "01",
            "nul",
            "tru",
            "\"\\u12\"",
            "\"\\uD800\"",
            "\"\\uD800x\"",
            "\"\\uDC00\"",
            "\"\\uD800\\u0041\"",
        ] {
            assert_eq!(
                parse_canonical(bad).err(),
                Some(CanonError::Malformed),
                "输入 {bad} 应拒绝"
            );
        }
        // 非整数数值拒绝(语法层);超界整数拒绝(安全整数域)。
        for bad in ["1.5", "1e3"] {
            assert_eq!(
                parse_canonical(bad).err(),
                Some(CanonError::Malformed),
                "输入 {bad} 应拒绝"
            );
        }
        for bad in ["-9223372036854775809", "9007199254740992"] {
            assert_eq!(
                parse_canonical(bad).err(),
                Some(CanonError::UnsafeInteger),
                "输入 {bad} 应拒绝"
            );
        }
        // 重复键拒绝(含转义同拼写形态)。
        assert_eq!(
            parse_canonical("{\"a\":1,\"a\":2}").err(),
            Some(CanonError::DuplicateKey)
        );
        assert_eq!(
            parse_canonical("{\"\\u0061\":1,\"a\":2}").err(),
            Some(CanonError::DuplicateKey)
        );
        // 深度护栏:513 层嵌套数组拒绝。
        let deep = format!("{}{}", "[".repeat(513), "]".repeat(513));
        assert_eq!(parse_canonical(&deep).err(), Some(CanonError::MaxDepth));
        // 代理对合法形态接受并还原增补平面字符。
        let parsed = parse_canonical("\"\\uD83D\\uDE00\"").unwrap();
        assert_eq!(parsed, CanonValue::str("\u{1F600}"));
        // `/` 转义接受(合法 JSON),还原为字面斜杠。
        assert_eq!(
            parse_canonical("\"a\\/b\"").unwrap(),
            CanonValue::str("a/b")
        );
    }

    /// 规范化文本(含空白宽容读侧)读回后再次写出 = 紧凑规范形态(幂等)。
    #[test]
    fn canonicalize_is_idempotent() {
        let value = CanonValue::object(vec![
            (
                "k",
                CanonValue::Array(vec![CanonValue::Int(-1), CanonValue::Null]),
            ),
            ("0", CanonValue::str("v")),
        ])
        .unwrap();
        let once = write_canonical(&value).unwrap();
        let reparsed = parse_canonical(&once).unwrap();
        let twice = write_canonical(&reparsed).unwrap();
        assert_eq!(once, twice);
        assert_eq!(once, "{\"0\":\"v\",\"k\":[-1,null]}");
        // 读侧对空白宽容(§3.1 读侧宽容细则)。
        let lenient = parse_canonical(" { \"0\" : \"v\" , \"k\" : [ -1 , null ] } ").unwrap();
        assert_eq!(write_canonical(&lenient).unwrap(), once);
        // 数值域外的键序:数字键按字符串码元序(“0” < “k”)。
        assert_eq!(compare_utf16("0", "k"), core::cmp::Ordering::Less);
    }
}

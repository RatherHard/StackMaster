//! 语义层不变式(契约 superRefine 的 Rust 承接,计划书 5.6)。
//!
//! WP-1 起自 `tooling/contract-smoke` 提升为引擎可复用模块,冒烟 crate
//! 经路径依赖消费同一实现。四条跨字段规则超出 JSON Schema 结构表达能力,
//! TS 侧由 Zod superRefine 机检,JSON Schema 落盘产物不携带(各 Schema 源码
//! 与语义文档 §六明文);Rust 侧一致性由本模块承接 + golden fixture 反例锁定。
//! 规则识别按结构签名(与 TS 侧 Schema 组合语义一致:规则作用于该形状出现
//! 的任何位置):
//!
//! 1. **PublicError 能力矩阵**(public-error.ts):按 code 冻结 addressHex
//!    形态与 explanation 字段白名单;
//! 2. **ActionResponse 增量对齐**(action-response.ts 规则 2):非 null
//!    projectionDelta 的 revision 必须等于信封 revision(规则 1 已由生成
//!    管线注入 JSON Schema if/then,不在此重复);
//! 3. **PublicEvent 载荷对齐**(public-event.ts):payloadHex 字节长度必须
//!    与 byteLength 一致(两者都出现时);
//! 4. **ProjectionDelta 字节预算**(projection-delta.ts):dirtyRanges 携带
//!    字节总数 ≤ 8192(MAX_PROJECTION_BYTES_PER_REVISION,WP-1 D3)。

use super::strict_value::StrictValue;

const MAX_PROJECTION_BYTES_PER_REVISION: i64 = 8192;

const PUBLIC_ERROR_CODES: &[&str] = &[
    "invalid_input_format",
    "invalid_payload_length",
    "offset_out_of_range",
    "endianness_mismatch",
    "permission_denied",
    "invalid_rip",
    "canary_violation",
    "invalid_call_argument",
    "objective_not_met",
    "inaccessible_address",
    "budget_exhausted",
    "stale_base_revision",
    "stale_client_seq",
    "idempotency_conflict",
    "session_terminal",
    "internal_error",
];

const EXPLANATION_FIELDS: &[&str] = &[
    "regionId",
    "permissions",
    "valueHex",
    "interpretedAs",
    "alignmentBytes",
    "expectedBytesLength",
    "actualBytesLength",
    "hints",
];

#[derive(Clone, Copy, PartialEq)]
enum AddressHexMode {
    /// 禁止出现(含 null)。
    Forbidden,
    /// 恒为 null(I-9:不可见地址统一占位形态)。
    NullOnly,
    /// 必须携带真实可见地址(E-2 教学解释锚点)。
    RequiredReal,
    /// 不约束。
    Free,
}

/// 能力矩阵: public-error.ts ERROR_CODE_CAPABILITIES 的镜像。
/// 返回 (addressHex 形态, explanation 白名单;None = explanation 整体禁止)。
fn capability(code: &str) -> (AddressHexMode, Option<&'static [&'static str]>) {
    match code {
        "invalid_input_format" => (AddressHexMode::Forbidden, Some(&["hints"])),
        "invalid_payload_length" => (
            AddressHexMode::Free,
            Some(&[
                "regionId",
                "expectedBytesLength",
                "actualBytesLength",
                "hints",
            ]),
        ),
        "offset_out_of_range" => (
            AddressHexMode::Free,
            Some(&[
                "regionId",
                "expectedBytesLength",
                "actualBytesLength",
                "hints",
            ]),
        ),
        "endianness_mismatch" => (
            AddressHexMode::Forbidden,
            Some(&["valueHex", "interpretedAs", "hints"]),
        ),
        "permission_denied" => (
            AddressHexMode::RequiredReal,
            Some(&["regionId", "permissions", "hints"]),
        ),
        "invalid_rip" => (
            AddressHexMode::Free,
            Some(&[
                "regionId",
                "permissions",
                "valueHex",
                "interpretedAs",
                "alignmentBytes",
                "hints",
            ]),
        ),
        "canary_violation" => (
            AddressHexMode::RequiredReal,
            Some(&["regionId", "valueHex", "hints"]),
        ),
        "invalid_call_argument" => (AddressHexMode::Forbidden, Some(&["valueHex", "hints"])),
        "objective_not_met" => (AddressHexMode::Forbidden, None),
        "inaccessible_address" => (AddressHexMode::NullOnly, Some(&["valueHex", "hints"])),
        "budget_exhausted" => (AddressHexMode::Forbidden, None),
        "stale_base_revision" => (AddressHexMode::Forbidden, None),
        "stale_client_seq" => (AddressHexMode::Forbidden, None),
        "idempotency_conflict" => (AddressHexMode::Forbidden, None),
        "session_terminal" => (AddressHexMode::Forbidden, None),
        "internal_error" => (AddressHexMode::Forbidden, None),
        _ => (AddressHexMode::Free, None),
    }
}

fn field<'a>(object: &'a [(String, StrictValue)], name: &str) -> Option<&'a StrictValue> {
    object
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
}

/// 递归检查整棵文档树;违规返回人类可读说明(含违规路径)。
pub fn check_document(value: &StrictValue) -> Result<(), String> {
    check_node(value, "$")
}

fn check_node(value: &StrictValue, path: &str) -> Result<(), String> {
    match value {
        StrictValue::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                check_node(item, &format!("{path}[{index}]"))?;
            }
            Ok(())
        }
        StrictValue::Object(entries) => {
            check_rules(entries, path)?;
            for (key, item) in entries {
                check_node(item, &format!("{path}.{key}"))?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn check_rules(entries: &[(String, StrictValue)], path: &str) -> Result<(), String> {
    check_error_capability(entries, path)?;
    check_delta_alignment(entries, path)?;
    check_event_payload_alignment(entries, path)?;
    check_delta_budget(entries, path)?;
    Ok(())
}

/// 规则 1:PublicError 能力矩阵。识别签名:对象含 `"code"` 且值为冻结错误码。
fn check_error_capability(entries: &[(String, StrictValue)], path: &str) -> Result<(), String> {
    let Some(StrictValue::String(code)) = field(entries, "code") else {
        return Ok(());
    };
    if !PUBLIC_ERROR_CODES.contains(&code.as_str()) {
        return Ok(());
    }
    let (address_mode, allowed_explanation) = capability(code);

    match address_mode {
        AddressHexMode::Forbidden => {
            if field(entries, "addressHex").is_some() {
                return Err(format!(
                    "{path}:code {code} 不允许携带 addressHex(含 null,WP-1 §4.4)"
                ));
            }
        }
        AddressHexMode::NullOnly => {
            if field(entries, "addressHex").map(StrictValue::as_null) != Some(true) {
                return Err(format!("{path}:code {code} 的 addressHex 恒为 null(I-9)"));
            }
        }
        AddressHexMode::RequiredReal => {
            let present_real = matches!(
                field(entries, "addressHex"),
                Some(StrictValue::String(value)) if !value.is_empty()
            );
            if !present_real {
                return Err(format!(
                    "{path}:code {code} 必须携带真实可见地址(教学解释锚点,E-2)"
                ));
            }
        }
        AddressHexMode::Free => {}
    }

    match (field(entries, "explanation"), allowed_explanation) {
        (Some(_), None) => {
            return Err(format!(
                "{path}:code {code} 不允许携带 explanation(E-4 / I-7:零解释字段)"
            ));
        }
        (Some(StrictValue::Object(explanation)), Some(allowed)) => {
            for name in EXPLANATION_FIELDS {
                let present = field(explanation, name).is_some();
                if present && !allowed.contains(name) {
                    return Err(format!(
                        "{path}:解释字段 {name} 不在 code {code} 的允许面内(WP-1 §4.4 能力矩阵)"
                    ));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// 规则 2:ActionResponse 增量对齐。识别签名:对象含 status + revision + projectionDelta。
fn check_delta_alignment(entries: &[(String, StrictValue)], path: &str) -> Result<(), String> {
    let has_envelope_shape =
        field(entries, "status").is_some() && field(entries, "revision").is_some();
    if !has_envelope_shape {
        return Ok(());
    }
    let Some(delta) = field(entries, "projectionDelta") else {
        return Ok(());
    };
    if delta.as_null() {
        return Ok(());
    }
    let StrictValue::Object(delta_entries) = delta else {
        return Ok(());
    };
    let envelope_revision = field(entries, "revision");
    let delta_revision = field(delta_entries, "revision");
    if envelope_revision != delta_revision {
        return Err(format!(
            "{path}:非 null 增量的 revision 必须等于信封 revision(WP-1 §4.3)"
        ));
    }
    Ok(())
}

/// 规则 3:PublicEvent 载荷对齐。识别签名:对象同时含 payloadHex 与 byteLength。
fn check_event_payload_alignment(
    entries: &[(String, StrictValue)],
    path: &str,
) -> Result<(), String> {
    let (Some(StrictValue::String(payload_hex)), Some(StrictValue::Number(byte_length))) =
        (field(entries, "payloadHex"), field(entries, "byteLength"))
    else {
        return Ok(());
    };
    let payload_bytes = payload_hex.len() as i64 / 2;
    let declared = byte_length.as_i64().unwrap_or(i64::MIN);
    if payload_bytes != declared {
        return Err(format!(
            "{path}:payloadHex 字节长度({payload_bytes})必须与 byteLength({declared})一致"
        ));
    }
    Ok(())
}

/// 规则 4:ProjectionDelta 字节预算。识别签名:对象含 dirtyRanges 数组。
fn check_delta_budget(entries: &[(String, StrictValue)], path: &str) -> Result<(), String> {
    let Some(StrictValue::Array(ranges)) = field(entries, "dirtyRanges") else {
        return Ok(());
    };
    let mut total_bytes = 0i64;
    for range in ranges {
        let Some(StrictValue::Object(range_entries)) = Some(range) else {
            continue;
        };
        if let Some(StrictValue::String(bytes_hex)) = field(range_entries, "bytesHex") {
            total_bytes += bytes_hex.len() as i64 / 2;
        }
    }
    if total_bytes > MAX_PROJECTION_BYTES_PER_REVISION {
        return Err(format!(
            "{path}:单 revision 投影字节总预算超限({total_bytes} > {MAX_PROJECTION_BYTES_PER_REVISION} 字节,WP-1 D3)"
        ));
    }
    Ok(())
}

impl StrictValue {
    fn as_null(&self) -> bool {
        matches!(self, StrictValue::Null)
    }
}

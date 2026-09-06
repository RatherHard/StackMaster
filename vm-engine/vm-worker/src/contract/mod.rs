//! 契约消费面(WP-1):阶段一冻结契约在 Rust 引擎侧的类型化消费与校验。
//!
//! 组成:
//! - [`canonical`]:规范化 JSON 序列化(`stackmaster-canonical-json/1`)——自
//!   `tooling/contract-smoke` 提升为引擎可复用模块,冒烟 crate 经路径依赖消费
//!   同一实现(计划书 5.6:禁止第二套实现);
//! - [`strict_value`]:严格 JSON 解析(重复键、孤立代理项拒绝,与 TS 判定对齐);
//! - [`semantic`]:superRefine 语义承接(四条跨字段规则的 Rust 侧等价拒绝);
//! - [`schema`]:冻结 JSON Schema 的内嵌与校验器(拒绝未知字段由 Schema 的
//!   `additionalProperties: false` 承担);
//! - [`mirrors`]:serde 类型镜像(ActionRequest / PrivateChallengeBundle;
//!   schemars 派生供镜像漂移冒烟比对)。

pub mod canonical;
pub mod mirrors;
pub mod schema;
pub mod semantic;
pub mod strict_value;

use serde_json::Value;
use std::fmt;

/// 契约校验失败(结构或语义);错误说明不携带校验器原始路径与载荷内容,
/// 调用方对公开面只允许输出冻结错误码(会话动作协议语义 §七第 8 条)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContractError {
    /// 严格 JSON 解析失败(语法 / 重复键 / 孤立代理项)。
    Strict(canonical::CanonicalError),
    /// JSON Schema 结构校验拒绝(含未知字段)。
    Schema,
    /// superRefine 语义承接拒绝(能力矩阵 / 增量对齐 / 载荷对齐 / 字节预算)。
    Semantic(String),
    /// 严格解析通过但镜像反序列化失败(结构漂移或类型不符)。
    Mirror(String),
}

impl fmt::Display for ContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ContractError::Strict(error) => write!(formatter, "严格解析失败:{error}"),
            ContractError::Schema => write!(formatter, "JSON Schema 校验拒绝"),
            ContractError::Semantic(reason) => write!(formatter, "语义校验拒绝:{reason}"),
            ContractError::Mirror(reason) => write!(formatter, "镜像反序列化失败:{reason}"),
        }
    }
}

/// 将严格解析后的 JSON 值转换为 `serde_json::Value`。
///
/// 重复键与孤立代理项已在 [`strict_value::StrictValue::parse`] 阶段拒绝,
/// 转换是保形的 1:1 映射;后续 serde 反序列化(`from_value`)消费的值
/// 因此具备与文本入口一致的严格性。
pub fn to_json_value(value: &strict_value::StrictValue) -> Value {
    match value {
        strict_value::StrictValue::Null => Value::Null,
        strict_value::StrictValue::Bool(flag) => Value::Bool(*flag),
        strict_value::StrictValue::Number(number) => Value::Number(number.clone()),
        strict_value::StrictValue::String(text) => Value::String(text.clone()),
        strict_value::StrictValue::Array(items) => {
            Value::Array(items.iter().map(to_json_value).collect())
        }
        strict_value::StrictValue::Object(entries) => Value::Object(
            entries
                .iter()
                .map(|(key, item)| (key.clone(), to_json_value(item)))
                .collect(),
        ),
    }
}

/// 将 `serde_json::Value` 转回严格值(语义承接对子树复检用)。
///
/// 调用前提:该值来自已通过 [`strict_value::StrictValue::parse`] 的文档
/// (重复键与孤立代理项已在解析层拒绝),转换因此保形。
pub fn strict_from_value(value: &Value) -> strict_value::StrictValue {
    match value {
        Value::Null => strict_value::StrictValue::Null,
        Value::Bool(flag) => strict_value::StrictValue::Bool(*flag),
        Value::Number(number) => strict_value::StrictValue::Number(number.clone()),
        Value::String(text) => strict_value::StrictValue::String(text.clone()),
        Value::Array(items) => {
            strict_value::StrictValue::Array(items.iter().map(strict_from_value).collect())
        }
        Value::Object(entries) => strict_value::StrictValue::Object(
            entries
                .iter()
                .map(|(key, item)| (key.clone(), strict_from_value(item)))
                .collect(),
        ),
    }
}

/// 全量契约校验管线(严格解析 → 语义承接 → Schema 校验),返回值供
/// `serde_json::from_value` 反序列化为镜像类型。
///
/// 输入为原始 JSON 文本(帧载荷、fixture 原文);判定与 TS 侧一致:
/// 结构(JSON Schema,`additionalProperties: false` 拒绝未知字段)
/// 且语义(superRefine 承接)全部通过才接受(计划书 5.6)。
pub fn validate_document(
    validator: &schema::SchemaValidator,
    text: &str,
) -> Result<Value, ContractError> {
    let strict = strict_value::StrictValue::parse(text).map_err(ContractError::Strict)?;
    validate_strict_value(validator, &strict)
}

/// 同 [`validate_document`],输入为已严格解析的 JSON 值(帧层已解析场景)。
pub fn validate_strict_value(
    validator: &schema::SchemaValidator,
    value: &strict_value::StrictValue,
) -> Result<Value, ContractError> {
    if let Err(reason) = semantic::check_document(value) {
        return Err(ContractError::Semantic(reason));
    }
    let json = to_json_value(value);
    if !validator.is_valid(&json) {
        return Err(ContractError::Schema);
    }
    Ok(json)
}

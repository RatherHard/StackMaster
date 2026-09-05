//! 契约类型的 Rust 消费面镜像(计划书 5.6 / ADR-5:serde + schemars 消费)。
//!
//! 镜像只声明结构(字段集合与必需性),证明 JSON Schema 可被 Rust 侧
//! 类型化消费;schemars 生成的结构与 Zod 产出的 JSON Schema 做属性 /
//! 必需键比对(冒烟 §四)。字面校验(pattern、长度、范围)仍归契约
//! 校验层(Ajv / jsonschema),不属于 serde 的职责。

use schemars::JsonSchema;
use serde::Deserialize;
use std::collections::BTreeSet;

/// `schema/embed-token-claims.schema.json` 的镜像。
/// `deny_unknown_fields` 对应 Schema 的 `additionalProperties: false`。
#[derive(Deserialize, JsonSchema, Debug)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EmbedTokenClaimsMirror {
    pub tenant_id: String,
    pub user_id: String,
    pub challenge_id: String,
    pub challenge_version: String,
    pub embed_session_id: String,
    pub jti: String,
    pub expires_at: u64,
}

/// `schema/verdict-result.schema.json`(11 值结果枚举,9.1)的镜像。
#[derive(Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VerdictResultMirror {
    Success,
    WrongAnswer,
    InvalidAction,
    ProgramCrash,
    MemoryFault,
    ResourceLimit,
    Timeout,
    EngineError,
    ChallengeInvalid,
    ReplayMismatch,
    Cancelled,
}

/// 从 Zod 产出的 JSON Schema 提取顶层属性名集合。
pub fn schema_property_names(schema: &serde_json::Value) -> BTreeSet<String> {
    schema
        .get("properties")
        .and_then(serde_json::Value::as_object)
        .map(|properties| properties.keys().cloned().collect())
        .unwrap_or_default()
}

/// 从 Zod 产出的 JSON Schema 提取顶层 required 集合。
pub fn schema_required_names(schema: &serde_json::Value) -> BTreeSet<String> {
    schema
        .get("required")
        .and_then(serde_json::Value::as_array)
        .map(|required| {
            required
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

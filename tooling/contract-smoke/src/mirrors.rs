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

// ── DebugVariantBundle(阶段四 WP-40;schema/debug-variant-bundle.schema.json)──
//
// 调试变体镜像(编排器 ↔ 调试 worker 进程间契约,ADR-DC1 条款 2/5)的 Rust
// 消费面最小镜像:跨字段规则(ASLR ⇄ baseAddresses / draws 下限 / canary
// 可见性)由生成管线注入的 JSON Schema if/then 承接(冒烟 §2),字面校验
// (pattern / const / multipleOf)归 jsonschema 契约层,镜像只声明结构。

/// seed 派生元数据(无种子值字段——只登记算法标识与派生次数,WP-1 清单 §6.9)。
#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DebugVariantDerivationMirror {
    pub algorithm_id: String,
    pub draws: u64,
    pub base_addresses: Option<Vec<DebugVariantBaseAddressMirror>>,
}

#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DebugVariantBaseAddressMirror {
    pub region_id: String,
    pub address_hex: String,
}

/// 内存区域(与真实镜像逐字段同构;区域粒度 multipleOf 由 Schema 承载)。
#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DebugVariantMemoryRegionMirror {
    pub region_id: String,
    pub kind: String,
    pub start_address_hex: String,
    pub byte_length: u64,
    pub permissions: String,
    pub content_hex: String,
    pub is_hidden: bool,
}

#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DebugVariantRegisterMirror {
    pub name: String,
    pub value_hex: String,
}

/// canary 槽(照真实私有包 canary 对象结构,值已派生写入区域 contentHex)。
#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DebugVariantCanarySlotMirror {
    pub object_id: String,
    pub kind: String,
    pub address_hex: String,
    pub byte_length: u64,
    pub visibility: String,
    pub contains_secret: bool,
}

/// 调试变体镜像根(整体 SERVER_ONLY):无 judgingConfig / 隐藏测试 / seed 值
/// 字段(strictObject 结构性排除,冒烟 §2 红灯样例锁定)。
#[derive(Deserialize, JsonSchema, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DebugVariantBundleMirror {
    pub schema_version: u32,
    pub engine_process_protocol_version: u32,
    pub challenge_id: String,
    pub challenge_content_version: String,
    pub vm_profile_version: String,
    pub aslr_enabled: bool,
    pub derivation: DebugVariantDerivationMirror,
    pub memory_regions: Vec<DebugVariantMemoryRegionMirror>,
    pub registers: Vec<DebugVariantRegisterMirror>,
    pub canary_slots: Option<Vec<DebugVariantCanarySlotMirror>>,
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

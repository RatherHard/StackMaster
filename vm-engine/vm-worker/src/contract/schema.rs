//! 冻结 JSON Schema 的内嵌与校验器(WP-1 契约消费面)。
//!
//! Schema 单一来源仍是 `packages/protocol/schema` 与
//! `packages/challenge-schema/schema`(计划书 5.6 / ADR-5);本模块在编译期
//! 以 `include_str!` 内嵌仓库内同一批落盘文件——worker 二进制自包含、无运行期
//! 文件读取,Schema 漂移由协议包的 schema-drift 测试与 `fixtures:manifest
//! --check` 门禁拦截。校验器为 2020-12(jsonschema crate);未知字段拒绝由
//! 各 Schema 的 `additionalProperties: false` 承担,重复键与孤立代理项由
//! [`super::strict_value`] 在解析层拒绝——三层合成与 TS 判定一致。

use serde_json::Value;
use std::fmt;

/// `ActionRequest`(会话动作协议 v1,12 动作判别式)。
pub const ACTION_REQUEST_SCHEMA: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/protocol/schema/action-request.schema.json"
));
/// `ActionResponse`(worker 出站自检;编排器下发前按同一契约重新校验)。
pub const ACTION_RESPONSE_SCHEMA: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/protocol/schema/action-response.schema.json"
));
/// `PublicStateProjection`(query_projection 出站)。
pub const PUBLIC_STATE_PROJECTION_SCHEMA: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/protocol/schema/public-state-projection.schema.json"
));
/// 私有判题包(challenge-schema;整体 SERVER_ONLY,只在 worker 进程内消费)。
pub const PRIVATE_BUNDLE_SCHEMA: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/challenge-schema/schema/private-bundle.schema.json"
));

/// 校验器编译失败(仅可能来自内嵌 Schema 损坏,属构建期错误)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaCompileError(pub String);

impl fmt::Display for SchemaCompileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Schema 编译失败:{}", self.0)
    }
}

impl std::error::Error for SchemaCompileError {}

/// 单一契约的已编译校验器。编译在进程启动时一次性完成,此后复用
/// (确定性:校验结论只取决于输入,不取决于校验器状态)。
#[derive(Debug, Clone)]
pub struct SchemaValidator {
    inner: jsonschema::Validator,
}

impl SchemaValidator {
    /// 从内嵌 Schema 文本编译校验器。
    pub fn compile(schema_text: &str) -> Result<Self, SchemaCompileError> {
        let schema: Value = serde_json::from_str(schema_text)
            .map_err(|error| SchemaCompileError(error.to_string()))?;
        let inner = jsonschema::validator_for(&schema)
            .map_err(|error| SchemaCompileError(error.to_string()))?;
        Ok(Self { inner })
    }

    /// 结构校验(2020-12);不携带错误明细——调用方对公开面只输出冻结错误码。
    pub fn is_valid(&self, instance: &Value) -> bool {
        self.inner.is_valid(instance)
    }
}

/// worker 协议面使用的契约校验器集合(进程启动时编译一次)。
#[derive(Debug, Clone)]
pub struct ContractValidators {
    pub action_request: SchemaValidator,
    pub action_response: SchemaValidator,
    pub public_state_projection: SchemaValidator,
    pub private_bundle: SchemaValidator,
}

impl ContractValidators {
    pub fn compile() -> Result<Self, SchemaCompileError> {
        Ok(Self {
            action_request: SchemaValidator::compile(ACTION_REQUEST_SCHEMA)?,
            action_response: SchemaValidator::compile(ACTION_RESPONSE_SCHEMA)?,
            public_state_projection: SchemaValidator::compile(PUBLIC_STATE_PROJECTION_SCHEMA)?,
            private_bundle: SchemaValidator::compile(PRIVATE_BUNDLE_SCHEMA)?,
        })
    }
}

//! 跨语言契约冒烟(计划书 5.6:golden fixture 往返,TS 与 Rust 校验器对同一组
//! 样例结论一致,规范化序列化一致)。
//!
//! 四段检查:
//! 1. **Schema 编译**:两包全部 `*.schema.json` 可被 Rust jsonschema(2020-12)编译;
//! 2. **实例校验**:有效 fixture 一律接受、非法 fixture 一律拒绝(结论与 TS 一致);
//! 3. **规范化摘要比对**:对 `canonical-digests.json` 全量逐条复算——摘要一致或
//!    拒绝码一致(拒绝码与 TS `CanonicalJsonErrorCode` 同串);
//! 4. **serde + schemars 消费**:镜像类型反序列化有效样例,schemars 生成的
//!    属性 / 必需键集合与 Zod 产出的 JSON Schema 相等。

use crate::bundle_builder;
use crate::canonical::{self};
use crate::mirrors::{
    EmbedTokenClaimsMirror, VerdictResultMirror, schema_property_names, schema_required_names,
};
use crate::semantic;
use crate::strict_value::StrictValue;
use sha2::Digest;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use vm_worker::contract::mirrors::PrivateBundleMirror;

/// 契约目录 → Schema 文件的映射(fixture 目录名即契约名)。
const PROTOCOL_CONTRACTS: &[(&str, &str)] = &[
    ("action-request", "action-request.schema.json"),
    ("action-response", "action-response.schema.json"),
    ("embed-message", "embed-message.schema.json"),
    ("embed-token-claims", "embed-token-claims.schema.json"),
    ("projection-delta", "projection-delta.schema.json"),
    ("projection-policy", "projection-policy.schema.json"),
    ("public-error", "public-error.schema.json"),
    (
        "public-state-projection",
        "public-state-projection.schema.json",
    ),
    ("verdict-result", "verdict-result.schema.json"),
];
const CHALLENGE_CONTRACTS: &[(&str, &str)] =
    &[("public-descriptor", "public-descriptor.schema.json")];

/// 契约冒烟结果汇总(全部通过时返回)。
#[derive(Debug)]
pub struct SmokeReport {
    pub schemas_compiled: usize,
    pub valid_instances_checked: usize,
    pub invalid_instances_rejected: usize,
    pub manifest_entries_compared: usize,
    pub serde_mirrors_checked: usize,
    /// private-bundle 消费检查(构造样例 + 反例 + 镜像比对;WP-1 §四冒烟扩展)。
    pub private_bundle_checks: usize,
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn read_json(path: &Path) -> Result<serde_json::Value, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("读取失败 {}: {error}", path.display()))?;
    serde_json::from_str(&text)
        .map_err(|error| format!("JSON 解析失败 {}: {error}", path.display()))
}

fn walk_json_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_json_files(&path, out);
        } else if path
            .extension()
            .is_some_and(|extension| extension == "json")
        {
            out.push(path);
        }
    }
}

/// `run_all` 的一次失败即短路返回(`Err(带路径的说明)`),由调用方决定退出码。
pub fn run_all() -> Result<SmokeReport, String> {
    let root = repo_root();
    let protocol_schema_dir = root.join("packages/protocol/schema");
    let challenge_schema_dir = root.join("packages/challenge-schema/schema");

    // ── §1 Schema 编译 ────────────────────────────────────────────────
    let mut schema_files: Vec<PathBuf> = Vec::new();
    walk_json_files(&protocol_schema_dir, &mut schema_files);
    walk_json_files(&challenge_schema_dir, &mut schema_files);
    schema_files.sort();
    for path in &schema_files {
        let schema = read_json(path)?;
        jsonschema::validator_for(&schema)
            .map_err(|error| format!("Schema 编译失败 {}: {error}", path.display()))?;
    }
    let schemas_compiled = schema_files.len();

    // ── §2 实例校验(有效接受 / 非法拒绝) ────────────────────────────
    let mut validators: BTreeMap<String, jsonschema::Validator> = BTreeMap::new();
    let mut contract_fixture_dirs: Vec<(PathBuf, &str)> = Vec::new();
    for (contract, schema_file) in PROTOCOL_CONTRACTS {
        let schema_path = protocol_schema_dir.join(schema_file);
        let schema = read_json(&schema_path)?;
        let validator = jsonschema::validator_for(&schema)
            .map_err(|error| format!("Schema 编译失败 {}: {error}", schema_path.display()))?;
        validators.insert((*schema_file).to_owned(), validator);
        contract_fixture_dirs.push((
            root.join("packages/protocol/test/fixtures").join(contract),
            schema_file,
        ));
    }
    for (contract, schema_file) in CHALLENGE_CONTRACTS {
        let schema_path = challenge_schema_dir.join(schema_file);
        let schema = read_json(&schema_path)?;
        let validator = jsonschema::validator_for(&schema)
            .map_err(|error| format!("Schema 编译失败 {}: {error}", schema_path.display()))?;
        validators.insert((*schema_file).to_owned(), validator);
        contract_fixture_dirs.push((
            root.join("packages/challenge-schema/test/fixtures")
                .join(contract),
            schema_file,
        ));
    }

    let mut valid_instances_checked = 0usize;
    let mut invalid_instances_rejected = 0usize;
    for (fixture_dir, schema_file) in &contract_fixture_dirs {
        let validator = validators
            .get(*schema_file)
            .ok_or_else(|| format!("缺少 Schema 校验器:{schema_file}"))?;
        let accept = |instance: &serde_json::Value| -> Result<(), String> {
            // 与 TS 侧判定一致:结构(JSON Schema)∧ 语义(superRefine 承接)
            // 全部通过才接受(计划书 5.6:同一组样例同时接受或拒绝)。
            if !validator.is_valid(instance) {
                return Err("JSON Schema 校验拒绝".to_owned());
            }
            let text = serde_json::to_string(instance).map_err(|error| error.to_string())?;
            let strict_value =
                StrictValue::parse(&text).map_err(|error| error.code().to_owned())?;
            semantic::check_document(&strict_value)
        };
        let valid_dir = fixture_dir.join("valid");
        if valid_dir.is_dir() {
            for path in sorted_json_files(&valid_dir) {
                let instance = read_json(&path)?;
                if let Err(reason) = accept(&instance) {
                    return Err(format!("有效样例被拒绝:{}({reason})", path.display()));
                }
                valid_instances_checked += 1;
            }
        }
        let invalid_dir = fixture_dir.join("invalid");
        if invalid_dir.is_dir() {
            for path in sorted_json_files(&invalid_dir) {
                let instance = read_json(&path)?;
                if accept(&instance).is_ok() {
                    return Err(format!("非法样例被接受:{}", path.display()));
                }
                invalid_instances_rejected += 1;
            }
        }
        // 扁平形态(如 challenge-schema 的 public-descriptor):目录内全部视为有效样例。
        if !valid_dir.is_dir() && !invalid_dir.is_dir() {
            for path in sorted_json_files(fixture_dir) {
                let instance = read_json(&path)?;
                if let Err(reason) = accept(&instance) {
                    return Err(format!("有效样例被拒绝:{}({reason})", path.display()));
                }
                valid_instances_checked += 1;
            }
        }
    }

    // ── §3 规范化摘要清单全量比对 ─────────────────────────────────────
    let manifest_path = root.join("tooling/contract-smoke/canonical-digests.json");
    let manifest_text = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("摘要清单读取失败 {}: {error}", manifest_path.display()))?;
    let manifest = StrictValue::parse(&manifest_text)
        .map_err(|error| format!("摘要清单解析失败:{:?}", error))?;
    let manifest_entries = manifest
        .as_object()
        .and_then(|entries| {
            entries
                .iter()
                .find(|(key, _)| key == "fixtures")
                .map(|(_, value)| value)
        })
        .and_then(StrictValue::as_object)
        .ok_or("摘要清单缺少 fixtures 对象")?;

    let mut fixture_files: Vec<PathBuf> = Vec::new();
    walk_json_files(
        &root.join("packages/protocol/test/fixtures"),
        &mut fixture_files,
    );
    walk_json_files(
        &root.join("packages/challenge-schema/test/fixtures"),
        &mut fixture_files,
    );
    let mut expected_keys: BTreeMap<String, PathBuf> = BTreeMap::new();
    for path in &fixture_files {
        let key = path
            .strip_prefix(&root)
            .map_err(|_| format!("fixture 不在仓库根下:{}", path.display()))?
            .to_string_lossy()
            .replace('\\', "/");
        expected_keys.insert(key, path.clone());
    }
    let manifest_keys: BTreeMap<&str, &[(String, StrictValue)]> = manifest_entries
        .iter()
        .map(|(key, value)| {
            let fields = value
                .as_object()
                .ok_or_else(|| format!("清单条目不是对象:{key}"))?;
            Ok((key.as_str(), fields))
        })
        .collect::<Result<BTreeMap<&str, &[(String, StrictValue)]>, String>>()?;
    for key in expected_keys.keys() {
        if !manifest_keys.contains_key(key.as_str()) {
            return Err(format!("清单缺少 fixture 条目:{key}(重新生成清单)"));
        }
    }
    for key in manifest_keys.keys() {
        if !expected_keys.contains_key(*key) {
            return Err(format!("清单含不存在的 fixture 条目:{key}(重新生成清单)"));
        }
    }

    let mut manifest_entries_compared = 0usize;
    for (key, path) in &expected_keys {
        let fields = manifest_keys
            .get(key.as_str())
            .ok_or_else(|| format!("清单缺少条目:{key}"))?;
        let expected_digest = field_str(fields, "sha256");
        let expected_rejection = field_str(fields, "rejected");
        let text = fs::read_to_string(path)
            .map_err(|error| format!("fixture 读取失败 {}: {error}", path.display()))?;
        if let Err(error) = StrictValue::parse(&text) {
            return Err(format!("fixture 解析失败(Rust 侧):{key}:{error:?}"));
        }
        let outcome = canonicalize_or_reject(&text);
        let matches = match (
            &outcome,
            expected_digest.as_deref(),
            expected_rejection.as_deref(),
        ) {
            (Outcome::Digest(digest), Some(expected), None) => digest == expected,
            (Outcome::Rejected(code), None, Some(expected)) => *code == expected,
            _ => false,
        };
        if !matches {
            return Err(format!(
                "规范化摘要不一致:{key}(Rust {outcome:?} / 清单 digest={expected_digest:?} rejected={expected_rejection:?})"
            ));
        }
        manifest_entries_compared += 1;
    }

    // ── §4 serde + schemars 消费 ──────────────────────────────────────
    let mut serde_mirrors_checked = 0usize;
    let claims_dir = root.join("packages/protocol/test/fixtures/embed-token-claims/valid");
    for path in sorted_json_files(&claims_dir) {
        let text = fs::read_to_string(&path)
            .map_err(|error| format!("fixture 读取失败 {}: {error}", path.display()))?;
        serde_json::from_str::<EmbedTokenClaimsMirror>(&text).map_err(|error| {
            format!(
                "EmbedTokenClaims serde 反序列化失败 {}: {error}",
                path.display()
            )
        })?;
        serde_mirrors_checked += 1;
    }
    let verdict_valid_dir = root.join("packages/protocol/test/fixtures/verdict-result/valid");
    for path in sorted_json_files(&verdict_valid_dir) {
        let text = fs::read_to_string(&path)
            .map_err(|error| format!("fixture 读取失败 {}: {error}", path.display()))?;
        serde_json::from_str::<VerdictResultMirror>(&text).map_err(|error| {
            format!(
                "VerdictResult serde 反序列化失败 {}: {error}",
                path.display()
            )
        })?;
        serde_mirrors_checked += 1;
    }
    let verdict_invalid_dir = root.join("packages/protocol/test/fixtures/verdict-result/invalid");
    for path in sorted_json_files(&verdict_invalid_dir) {
        let text = fs::read_to_string(&path)
            .map_err(|error| format!("fixture 读取失败 {}: {error}", path.display()))?;
        if serde_json::from_str::<VerdictResultMirror>(&text).is_ok() {
            return Err(format!("非法结果类型被 serde 接受:{}", path.display()));
        }
        serde_mirrors_checked += 1;
    }

    let claims_schema = read_json(&protocol_schema_dir.join("embed-token-claims.schema.json"))?;
    let generated = serde_json::to_value(schemars::schema_for!(EmbedTokenClaimsMirror))
        .map_err(|error| format!("schemars 生成失败:{error}"))?;
    if schema_property_names(&claims_schema) != schema_property_names(&generated) {
        return Err("schemars 属性集合与 protocol Schema 不一致(embed-token-claims)".to_owned());
    }
    if schema_required_names(&claims_schema) != schema_required_names(&generated) {
        return Err("schemars 必需键集合与 protocol Schema 不一致(embed-token-claims)".to_owned());
    }

    // ── §5 private-bundle 消费冒烟(WP-1;阶段一验收评审 §三移交项 5)─────
    // 私有样例由测试期 builder 现场生成,永不入 git;覆盖两种程序形态
    // (IR / 字节)与定向破坏反例,证明引擎契约消费面贯通私有包 Schema。
    let mut private_bundle_checks = 0usize;
    let private_bundle_validator = jsonschema::validator_for(&read_json(
        &challenge_schema_dir.join("private-bundle.schema.json"),
    )?)
    .map_err(|error| format!("Schema 编译失败 private-bundle: {error}"))?;
    for (mode, bundle) in [
        ("ir", bundle_builder::build_ir_mode_bundle()),
        ("byte", bundle_builder::build_byte_mode_bundle()),
    ] {
        if !private_bundle_validator.is_valid(&bundle) {
            return Err(format!("私有包 builder 样例被 Schema 拒绝(mode={mode})"));
        }
        serde_json::from_value::<PrivateBundleMirror>(bundle).map_err(|error| {
            format!("PrivateBundle serde 镜像反序列化失败(mode={mode}):{error}")
        })?;
        private_bundle_checks += 1;
    }
    for (reason, bundle) in bundle_builder::schema_rejected_mutations() {
        if private_bundle_validator.is_valid(&bundle) {
            return Err(format!("私有包反例被 Schema 接受:{reason}"));
        }
        private_bundle_checks += 1;
    }
    let private_bundle_schema =
        read_json(&challenge_schema_dir.join("private-bundle.schema.json"))?;
    let generated = serde_json::to_value(schemars::schema_for!(PrivateBundleMirror))
        .map_err(|error| format!("schemars 生成失败:{error}"))?;
    if schema_property_names(&private_bundle_schema) != schema_property_names(&generated) {
        return Err(
            "schemars 属性集合与 challenge-schema 不一致(private-bundle)".to_owned(),
        );
    }
    if schema_required_names(&private_bundle_schema) != schema_required_names(&generated) {
        return Err(
            "schemars 必需键集合与 challenge-schema 不一致(private-bundle)".to_owned(),
        );
    }
    private_bundle_checks += 2;

    Ok(SmokeReport {
        schemas_compiled,
        valid_instances_checked,
        invalid_instances_rejected,
        manifest_entries_compared,
        serde_mirrors_checked,
        private_bundle_checks,
    })
}

#[derive(Debug)]
enum Outcome {
    Digest(String),
    Rejected(&'static str),
}

fn canonicalize_or_reject(text: &str) -> Outcome {
    match canonical::canonicalize_json_text(text) {
        Ok(canonical) => {
            let digest = sha2::Sha256::digest(canonical.as_bytes());
            let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
            Outcome::Digest(hex)
        }
        Err(error) => Outcome::Rejected(error.code()),
    }
}

fn field_str(fields: &[(String, StrictValue)], name: &str) -> Option<String> {
    fields
        .iter()
        .find(|(key, _)| key == name)
        .and_then(|(_, value)| value.as_str())
        .map(str::to_owned)
}

fn sorted_json_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    walk_json_files(dir, &mut files);
    files.sort();
    files
}

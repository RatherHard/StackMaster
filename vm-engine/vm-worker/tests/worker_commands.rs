//! 命令面与状态机测试(引擎进程协议 §四 / §八机检):信封违规、seq 单调、
//! 状态机违规、装载校验(版本锁定 / seed 互斥)、协议级拒绝响应,以及
//! ActionRequest fixture 的 TS / Rust 两侧结论一致与摘要清单复算。

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use vm_worker::contract::mirrors::ActionRequestMirror;
use vm_worker::contract::schema::ContractValidators;
use vm_worker::contract::{self, strict_value::StrictValue};
use vm_worker::protocol::message::{WorkerErrorCode, WorkerOutbound};
use vm_worker::protocol::worker::{ProtocolViolation, Worker};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .to_path_buf()
}

fn new_worker() -> Worker {
    Worker::new().expect("内嵌 Schema 必须可编译")
}

fn frame(value: &Value) -> StrictValue {
    let text = serde_json::to_string(value).unwrap();
    StrictValue::parse(&text).unwrap()
}

/// 最小合法私有判题包(IR 模式;字段形态满足 private-bundle.schema.json)。
fn valid_bundle() -> Value {
    let mut content_hex = "55".repeat(8);
    content_hex.push_str(&"00".repeat(4096 - 8));
    json!({
        "schemaVersion": 1,
        "challengeId": "stack-bof-101",
        "challengeContentVersion": "1.0.0",
        "vmProfileVersion": "1.0.0",
        "dslSchemaVersion": 2,
        "vmEngineVersion": env!("CARGO_PKG_VERSION"),
        "declaredSeedPublicPaths": [],
        "seedPolicy": { "strategy": "fixed", "seedHex": "00112233445566778899aabbccddeeff" },
        "initialState": {
            "registers": { "RSP": "0x7ffc00", "RBP": "0x7ffc00", "RIP": "0x401000" },
            "memoryRegions": [
                {
                    "regionId": "code",
                    "kind": "code",
                    "startAddressHex": "0x401000",
                    "byteLength": 4096,
                    "permissions": "rx",
                    "contentHex": content_hex,
                    "isHidden": false
                }
            ]
        },
        "secrets": { "flag": "FLAG{placeholder}", "virtualFiles": [] },
        "privateObjects": [],
        "judging": { "successCondition": { "all": [] } },
        "compiledIr": {
            "irFormatVersion": 2,
            "entrypointIndex": 0,
            "instructions": [ { "op": "ret", "operands": [] } ],
            "labels": []
        },
        "judgingConfig": { "verdictRuleVersion": "1.0.0", "maxPredicateEvalSteps": 10000 }
    })
}

fn load_command(seq: u64, bundle: Value, session_seed_hex: Option<&str>) -> Value {
    let mut command = json!({ "type": "load", "seq": seq, "privateBundle": bundle });
    if let Some(seed) = session_seed_hex {
        command["sessionSeedHex"] = json!(seed);
    }
    command
}

fn action_request(action: Value) -> Value {
    json!({
        "protocolVersion": 1,
        "sessionId": "session-1",
        "clientSeq": 1,
        "baseRevision": 0,
        "idempotencyKey": "key-1",
        "action": action
    })
}

fn apply_action_frame(seq: u64, request_id: &str, action_request: Value) -> Value {
    json!({
        "type": "apply_action",
        "seq": seq,
        "requestId": request_id,
        "actionRequest": action_request
    })
}

fn load_first(worker: &mut Worker) {
    let outbound = worker
        .handle_frame(&frame(&load_command(1, valid_bundle(), None)))
        .unwrap();
    assert!(
        matches!(outbound, WorkerOutbound::Loaded { .. }),
        "前置:合法装载必须成功"
    );
}

fn expect_command_error(outbound: WorkerOutbound, code: WorkerErrorCode) {
    match outbound {
        WorkerOutbound::CommandError { error, .. } => assert_eq!(error.code, code),
        other => panic!("预期命令级错误 {code:?},实得 {other:?}"),
    }
}

// ── 信封与状态机 ──────────────────────────────────────────────────────────────

#[test]
fn unknown_command_type_is_protocol_violation() {
    let error = new_worker()
        .handle_frame(&frame(&json!({ "type": "reboot", "seq": 1 })))
        .unwrap_err();
    assert_eq!(error, ProtocolViolation::UnknownCommand);
}

#[test]
fn envelope_unknown_field_is_protocol_violation() {
    let error = new_worker()
        .handle_frame(&frame(
            &json!({ "type": "shutdown", "seq": 1, "extra": true }),
        ))
        .unwrap_err();
    assert_eq!(error, ProtocolViolation::EnvelopeInvalid);
}

#[test]
fn envelope_missing_seq_is_protocol_violation() {
    let error = new_worker()
        .handle_frame(&frame(&json!({ "type": "shutdown" })))
        .unwrap_err();
    assert_eq!(error, ProtocolViolation::EnvelopeInvalid);
}

#[test]
fn seq_must_start_at_one_and_increase_strictly() {
    let error = new_worker()
        .handle_frame(&frame(&json!({ "type": "shutdown", "seq": 2 })))
        .unwrap_err();
    assert_eq!(
        error,
        ProtocolViolation::SequenceViolation { seq: Some(2) },
        "首命令 seq 必须 = 1(stop-and-wait)"
    );

    let mut worker = new_worker();
    assert!(
        worker
            .handle_frame(&frame(&json!({ "type": "shutdown", "seq": 1 })))
            .is_ok()
    );
    let error = worker
        .handle_frame(&frame(&json!({ "type": "shutdown", "seq": 1 })))
        .unwrap_err();
    assert_eq!(
        error,
        ProtocolViolation::SequenceViolation { seq: Some(1) },
        "重复 seq = 协议层违规"
    );
}

#[test]
fn commands_before_load_are_state_violations() {
    let commands = [
        json!({ "type": "apply_action", "seq": 1, "requestId": "req-1", "actionRequest": action_request(json!({ "type": "pop", "args": {} })) }),
        json!({ "type": "query_projection", "seq": 1 }),
        json!({ "type": "export_snapshot", "seq": 1 }),
        json!({ "type": "import_snapshot", "seq": 1, "snapshot": {} }),
    ];
    for command in commands {
        let error = new_worker().handle_frame(&frame(&command)).unwrap_err();
        assert_eq!(
            error,
            ProtocolViolation::StateViolation { seq: 1 },
            "未装载先命令必须 fail-closed:{command}"
        );
    }
}

#[test]
fn apply_action_request_id_charset_is_enforced() {
    let mut worker = new_worker();
    load_first(&mut worker);
    let error = worker
        .handle_frame(&frame(&apply_action_frame(
            2,
            "bad id!",
            action_request(json!({ "type": "pop", "args": {} })),
        )))
        .unwrap_err();
    assert_eq!(error, ProtocolViolation::EnvelopeInvalid);
}

// ── load:契约校验、seed 互斥、版本锁定 ──────────────────────────────────────

#[test]
fn valid_bundle_loads_with_public_summary() {
    let mut worker = new_worker();
    match worker
        .handle_frame(&frame(&load_command(1, valid_bundle(), None)))
        .unwrap()
    {
        WorkerOutbound::Loaded { seq, loaded } => {
            assert_eq!(seq, 1);
            assert_eq!(loaded.challenge_id, "stack-bof-101");
            assert_eq!(loaded.initial_revision, 0);
            assert_eq!(loaded.vm_engine_version, env!("CARGO_PKG_VERSION"));
        }
        other => panic!("合法装载必须回执 Loaded:{other:?}"),
    }
}

#[test]
fn schema_invalid_bundle_is_rejected_deterministically() {
    let mut worker = new_worker();
    let mut bundle = valid_bundle();
    bundle["unknownField"] = json!(true);
    for seq in [1u64, 2u64] {
        // 装载失败后重装载行为确定:同一输入恒同结论(challenge_invalid 方向)。
        expect_command_error(
            worker
                .handle_frame(&frame(&load_command(seq, bundle.clone(), None)))
                .unwrap(),
            WorkerErrorCode::ChallengeInvalid,
        );
    }
}

#[test]
fn engine_version_mismatch_is_rejected_challenge_invalid() {
    let mut worker = new_worker();
    let mut bundle = valid_bundle();
    bundle["vmEngineVersion"] = json!("9.9.9");
    expect_command_error(
        worker
            .handle_frame(&frame(&load_command(1, bundle, None)))
            .unwrap(),
        WorkerErrorCode::ChallengeInvalid,
    );
}

#[test]
fn declared_engine_build_id_must_match_self_report() {
    let mut worker = new_worker();
    let mut bundle = valid_bundle();
    bundle["engineBuildId"] = json!("other-build");
    expect_command_error(
        worker
            .handle_frame(&frame(&load_command(1, bundle, None)))
            .unwrap(),
        WorkerErrorCode::ChallengeInvalid,
    );
}

#[test]
fn seed_policy_and_session_seed_are_mutually_exclusive() {
    // fixed ⇒ 禁止会话种子。
    let mut worker = new_worker();
    expect_command_error(
        worker
            .handle_frame(&frame(&load_command(1, valid_bundle(), Some("aabbccdd"))))
            .unwrap(),
        WorkerErrorCode::ChallengeInvalid,
    );

    // server_random_per_session ⇒ 必须携带会话种子。
    let mut bundle = valid_bundle();
    bundle["seedPolicy"] = json!({ "strategy": "server_random_per_session" });
    let mut worker = new_worker();
    expect_command_error(
        worker
            .handle_frame(&frame(&load_command(1, bundle.clone(), None)))
            .unwrap(),
        WorkerErrorCode::ChallengeInvalid,
    );
    let mut worker = new_worker();
    assert!(matches!(
        worker
            .handle_frame(&frame(&load_command(1, bundle, Some("0011223344556677"))))
            .unwrap(),
        WorkerOutbound::Loaded { .. }
    ));
}

#[test]
fn session_seed_must_be_even_hex_bytes() {
    let mut bundle = valid_bundle();
    bundle["seedPolicy"] = json!({ "strategy": "server_random_per_session" });
    let mut worker = new_worker();
    expect_command_error(
        worker
            .handle_frame(&frame(&load_command(1, bundle, Some("abc"))))
            .unwrap(),
        WorkerErrorCode::ChallengeInvalid,
    );
}

#[test]
fn reload_after_successful_load_is_state_violation() {
    let mut worker = new_worker();
    load_first(&mut worker);
    let error = worker
        .handle_frame(&frame(&load_command(2, valid_bundle(), None)))
        .unwrap_err();
    assert_eq!(error, ProtocolViolation::StateViolation { seq: 2 });
}

// ── apply_action:协议级拒绝与骨架占位 ────────────────────────────────────────

#[test]
fn schema_invalid_action_yields_deterministic_rejected_response() {
    let mut worker = new_worker();
    load_first(&mut worker);
    let outbound = worker
        .handle_frame(&frame(&apply_action_frame(
            2,
            "req-1",
            action_request(json!({ "type": "teleport", "args": {} })),
        )))
        .unwrap();
    match outbound {
        WorkerOutbound::ActionResponse {
            seq,
            action_response,
            checkpoint_export,
        } => {
            assert_eq!(seq, 2);
            assert!(checkpoint_export.is_none());
            assert_eq!(action_response["status"], "rejected");
            assert_eq!(action_response["revision"], 0, "拒绝不推进 revision");
            assert_eq!(action_response["projectionDelta"], Value::Null);
            assert_eq!(action_response["publicEvents"], json!([]));
            assert_eq!(
                action_response["userVisibleError"]["code"],
                "invalid_input_format"
            );
            assert_eq!(action_response["requestId"], "req-1");
        }
        other => panic!("载荷级拒绝必须是 ActionResponse:{other:?}"),
    }
}

#[test]
fn unknown_envelope_field_inside_action_request_is_rejected() {
    let mut worker = new_worker();
    load_first(&mut worker);
    let mut request = action_request(json!({ "type": "pop", "args": {} }));
    request["vmState"] = json!("tamper");
    let outbound = worker
        .handle_frame(&frame(&apply_action_frame(2, "req-1", request)))
        .unwrap();
    match outbound {
        WorkerOutbound::ActionResponse {
            action_response, ..
        } => {
            assert_eq!(action_response["status"], "rejected");
        }
        other => panic!("自制状态字段必须拒绝(ZR-T2):{other:?}"),
    }
}

#[test]
fn valid_action_reaches_placeholder_in_skeleton() {
    let mut worker = new_worker();
    load_first(&mut worker);
    match worker
        .handle_frame(&frame(&apply_action_frame(
            2,
            "req-1",
            action_request(json!({ "type": "pop", "args": {} })),
        )))
        .unwrap()
    {
        WorkerOutbound::CommandError { error, .. } => {
            // WP-1 骨架占位:引擎面未接线;合法载荷通过全部契约校验后到达此处。
            assert_eq!(error.code, WorkerErrorCode::InternalError);
        }
        other => panic!("骨架阶段合法动作应返回引擎未接线占位:{other:?}"),
    }
}

// ── ActionRequest fixture:TS / Rust 两侧结论一致(完成标准)─────────────────

#[test]
fn action_request_fixtures_match_ts_side_verdicts() {
    let validators = ContractValidators::compile().unwrap();
    let fixtures = repo_root().join("packages/protocol/test/fixtures/action-request");
    let mut checked = 0usize;
    for (verdict, dir_name) in [("valid", "valid"), ("invalid", "invalid")] {
        let dir = fixtures.join(dir_name);
        let mut files: Vec<PathBuf> = fs::read_dir(&dir)
            .unwrap_or_else(|error| panic!("fixture 目录缺失 {}: {error}", dir.display()))
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect();
        files.sort();
        for path in files {
            let text = fs::read_to_string(&path).unwrap();
            let outcome = contract::validate_document(&validators.action_request, &text);
            if verdict == "valid" {
                // 结论一致(结构 ∧ 语义)∧ 类型镜像可消费(对应 TS Zod 类型解析)。
                let value = outcome.unwrap_or_else(|error| {
                    panic!("TS 侧接受的样例被 Rust 侧拒绝:{}({error})", path.display())
                });
                let mirror: Result<ActionRequestMirror, _> = serde_json::from_value(value);
                assert!(
                    mirror.is_ok(),
                    "TS 侧接受的样例无法反序列化为镜像:{}({:?})",
                    path.display(),
                    mirror.err()
                );
            } else {
                assert!(
                    outcome.is_err(),
                    "TS 侧拒绝的样例被 Rust 侧接受:{}",
                    path.display()
                );
            }
            checked += 1;
        }
    }
    assert!(checked >= 35, "fixture 覆盖不足:{checked}");
}

// ── 摘要清单复算(规范化序列化纳入引擎测试依赖)────────────────────────────

#[test]
fn canonical_digest_manifest_is_reproduced_by_engine_module() {
    use sha2::Digest;
    let manifest_path = repo_root().join("tooling/contract-smoke/canonical-digests.json");
    let manifest_text = fs::read_to_string(&manifest_path).unwrap();
    let manifest: Value = serde_json::from_str(&manifest_text).unwrap();
    let entries = manifest["fixtures"].as_object().expect("清单缺 fixtures");
    assert!(!entries.is_empty(), "摘要清单为空");
    let mut compared = 0usize;
    for (key, fields) in entries {
        let path = repo_root().join(key);
        let text = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("清单条目文件缺失 {key}: {error}"));
        let expected_digest = fields["sha256"].as_str();
        let expected_rejection = fields["rejected"].as_str();
        match (
            contract::canonical::canonicalize_json_text(&text),
            expected_digest,
            expected_rejection,
        ) {
            (Ok(canonical), Some(expected), None) => {
                let digest = sha2::Sha256::digest(canonical.as_bytes());
                let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
                assert_eq!(hex, expected, "摘要不一致:{key}");
            }
            (Err(error), None, Some(expected)) => {
                assert_eq!(error.code(), expected, "拒绝码不一致:{key}");
            }
            _ => panic!("清单条目形态错误:{key}"),
        }
        compared += 1;
    }
    assert!(compared >= 100, "清单复算覆盖不足:{compared}");
}

#[test]
fn protocol_version_constants_match_ts_side() {
    // 双语言版本常量防漂移(协议文档 §二;TS 侧为唯一登记处的镜像)。
    let version_ts =
        fs::read_to_string(repo_root().join("packages/protocol/src/version.ts")).unwrap();
    let expected = format!(
        "ENGINE_PROCESS_PROTOCOL_VERSION = {};",
        vm_worker::protocol::version::ENGINE_PROCESS_PROTOCOL_VERSION
    );
    assert!(
        version_ts.contains(&expected),
        "TS 侧 ENGINE_PROCESS_PROTOCOL_VERSION 与 Rust 常量漂移(应为 {expected})"
    );
}

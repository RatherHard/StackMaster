//! verify 裁决重放命令面(阶段六 WP-61;Q1 定案候选 (b):vm-worker 新增
//! 裁决重放命令面,ADR-8 同一份 `vm_runtime::replay` 实现)。
//!
//! 完成标准承接(阶段六任务分解 WP-61):
//! - 重放逐项比对在服务面复锚:篡改动作日志任一字段 → `replay_mismatch`
//!   (`replay_detects_tampered_log` 语义经 verify 命令面复锚);
//! - `export_action_log` 交付提交链路的重放材料(六记录项上下文 + 规范化
//!   动作日志文本;会话编排 D-W8-9 submit 引用的引擎权威面);
//! - 上下文一致性 / 受理性 / revision 序列 / 状态哈希序列 / 结局标签的
//!   漂移全部落裁决面(challenge_invalid / replay_mismatch 方向),同一
//!   输入恒同结论(I-4)。

use serde_json::{Value, json};
use vm_worker::contract::strict_value::StrictValue;
use vm_worker::protocol::message::{WorkerErrorCode, WorkerOutbound};
use vm_worker::protocol::worker::{ProtocolViolation, Worker};
use vm_worker::session::verify::{VerifyReplayOutcome, VerifyReport};

const A32_REGION: u64 = 4096;
const CODE_BASE: &str = "0x401000";
const BUFFER_BASE: &str = "0x20000000";
const STACK_BASE: &str = "0x7ffff000";

/// 验证题目:成功条件 = 栈区 0x200 偏移处恰为字节 0x42(write_bytes 即 won),
/// 使 verify 面能覆盖 success / wrong_answer 双向。
fn verify_bundle(challenge_id: &str) -> Value {
    let code_content = {
        let mut hex = String::from("c3");
        hex.push_str(&"00".repeat(A32_REGION as usize - 1));
        hex
    };
    json!({
        "schemaVersion": 1,
        "challengeId": challenge_id,
        "challengeContentVersion": "1.0.0",
        "vmProfileVersion": "1.0.0",
        "dslSchemaVersion": 2,
        "vmEngineVersion": env!("CARGO_PKG_VERSION"),
        "declaredSeedPublicPaths": [],
        "seedPolicy": { "strategy": "fixed", "seedHex": "00112233445566778899aabbccddeeff" },
        "initialState": {
            "registers": { "RSP": "0x7ffff008", "RBP": "0x7ffff008", "RIP": "0x0", "RAX": "0x0", "FLAG_SYS": "0x0" },
            "memoryRegions": [
                { "regionId": "code", "kind": "code", "startAddressHex": CODE_BASE,
                  "byteLength": 4096, "permissions": "rx", "contentHex": code_content, "isHidden": false },
                { "regionId": "buffer", "kind": "heap", "startAddressHex": BUFFER_BASE,
                  "byteLength": 4096, "permissions": "rw", "contentHex": "00".repeat(4096), "isHidden": false },
                { "regionId": "stack", "kind": "stack", "startAddressHex": STACK_BASE,
                  "byteLength": 4096, "permissions": "rw", "contentHex": "00".repeat(4096), "isHidden": false }
            ]
        },
        "secrets": { "flag": "FLAG{verify}", "virtualFiles": [] },
        "privateObjects": [],
        "judging": {
            "successCondition": {
                "all": [ { "all": [ { "predicate": { "type": "memory_equals",
                    "regionId": "stack", "offsetBytes": 512, "bytesHex": "42" } } ] } ]
            }
        },
        "compiledIr": {
            "irFormatVersion": 2,
            "entrypointIndex": 0,
            "instructions": [ { "op": "ret", "operands": [] } ],
            "labels": []
        },
        "judgingConfig": { "verdictRuleVersion": "1.0.0", "maxPredicateEvalSteps": 10000 }
    })
}

fn verify_descriptor(challenge_id: &str) -> Value {
    let code_window = {
        let mut hex = String::from("c3");
        hex.push_str(&"00".repeat(255));
        hex
    };
    json!({
        "schemaVersion": 1,
        "challengeId": challenge_id,
        "challengeContentVersion": "1.0.0",
        "vmProfileVersion": "1.0.0",
        "locale": "zh-CN",
        "briefing": {
            "title": "验证教学题",
            "summary": "写栈触发成功条件的 verify 承载题。",
            "learningObjectives": ["理解独立重放裁决"]
        },
        "vmProfile": {
            "registers": [ { "name": "RSP" }, { "name": "RBP" }, { "name": "RIP" }, { "name": "RAX" } ],
            "flagRegisterNames": ["FLAG_SYS"],
            "endianness": "little",
            "archBits": 32,
            "pageSizeBytes": 4096,
            "canary": { "enabled": false }
        },
        "memoryLayout": {
            "regions": [
                { "regionId": "code", "kind": "code", "startAddressHex": CODE_BASE,
                  "byteLength": 4096, "permissions": "rx", "publicLabel": "代码区" },
                { "regionId": "buffer", "kind": "heap", "startAddressHex": BUFFER_BASE,
                  "byteLength": 4096, "permissions": "rw", "publicLabel": "缓冲区" },
                { "regionId": "stack", "kind": "stack", "startAddressHex": STACK_BASE,
                  "byteLength": 4096, "permissions": "rw", "publicLabel": "栈" }
            ]
        },
        "allowedActions": ["write_bytes", "push", "pop", "call", "ret", "step", "run_to_event",
            "pause", "undo", "checkout_checkpoint", "reset", "create_checkpoint"],
        "resourceLimits": {},
        "hintLadder": [],
        "publicErrorMapping": [],
        "initialProjection": {
            "visibleRegions": [
                { "regionId": "code", "label": "代码区", "startAddressHex": CODE_BASE, "byteLength": 4096, "permissions": "rx", "bytesHex": code_window, "truncated": true },
                { "regionId": "buffer", "label": "缓冲区", "startAddressHex": BUFFER_BASE, "byteLength": 4096, "permissions": "rw", "bytesHex": "00".repeat(256), "truncated": true },
                { "regionId": "stack", "label": "栈", "startAddressHex": STACK_BASE, "byteLength": 4096, "permissions": "rw", "bytesHex": "00".repeat(256), "truncated": true }
            ],
            "visibleRegisters": [
                { "name": "RSP", "valueHex": "0x7FFFF008" },
                { "name": "RBP", "valueHex": "0x7FFFF008" },
                { "name": "RIP", "valueHex": "0x0" },
                { "name": "RAX", "valueHex": "0x0" }
            ]
        }
    })
}

fn strict(frame: &Value) -> StrictValue {
    let text = serde_json::to_string(frame).unwrap();
    StrictValue::parse(&text).unwrap()
}

/// 活体会话动作:写 0x42 到栈区 0x200 偏移(成功条件达成 → won 终态)。
fn winning_action() -> Value {
    json!({ "type": "write_bytes", "args": { "addressHex": "0x7ffff200", "bytesHex": "42" } })
}

/// 活体会话:load → 动作 → export_action_log;返回 (上下文, 规范化日志文本)。
fn live_material(challenge_id: &str, actions: &[Value]) -> (Value, String) {
    live_material_with(
        &verify_bundle(challenge_id),
        &verify_descriptor(challenge_id),
        actions,
    )
}

/// 同上,语料可注入(WP-62:隐藏测试 / 程序变体的装配哈希须与活体装载一致)。
fn live_material_with(bundle: &Value, descriptor: &Value, actions: &[Value]) -> (Value, String) {
    let mut worker = Worker::new().expect("worker 构造");
    let loaded = worker
        .handle_frame(&strict(&json!({
            "type": "load", "seq": 1,
            "privateBundle": bundle,
            "publicDescriptor": descriptor
        })))
        .expect("load 受理");
    assert!(
        matches!(loaded, WorkerOutbound::Loaded { .. }),
        "{loaded:?}"
    );
    let mut seq = 2;
    for (index, action) in actions.iter().enumerate() {
        let response = worker
            .handle_frame(&strict(&json!({
                "type": "apply_action", "seq": seq, "requestId": format!("req-live-{index}"),
                "actionRequest": {
                    "protocolVersion": 1, "sessionId": "sess-verify", "clientSeq": index + 1,
                    "idempotencyKey": format!("idem-verify-{index}"), "baseRevision": index, "action": action
                }
            })))
            .expect("apply_action 受理");
        assert!(
            matches!(response, WorkerOutbound::ActionResponse { .. }),
            "{response:?}"
        );
        seq += 1;
    }
    match worker.handle_frame(&strict(&json!({ "type": "export_action_log", "seq": seq }))) {
        Ok(WorkerOutbound::ActionLogExported {
            replay_context,
            action_log,
            ..
        }) => (replay_context, action_log),
        other => panic!("export_action_log 应回 action_log_exported,实际 {other:?}"),
    }
}

/// verify 一次性进程(独立裁决形态):fresh worker → verify(未装载阶段)。
fn run_verify(
    bundle: &Value,
    descriptor: &Value,
    context: &Value,
    log: &str,
) -> Result<WorkerOutbound, ProtocolViolation> {
    run_verify_with_seed(bundle, descriptor, context, log, None)
}

fn run_verify_with_seed(
    bundle: &Value,
    descriptor: &Value,
    context: &Value,
    log: &str,
    session_seed_hex: Option<&str>,
) -> Result<WorkerOutbound, ProtocolViolation> {
    let mut worker = Worker::new().expect("worker 构造");
    worker.handle_frame(&strict(&json!({
        "type": "verify", "seq": 1,
        "privateBundle": bundle,
        "publicDescriptor": descriptor,
        "replayContext": context,
        "actionLog": log,
        "sessionSeedHex": session_seed_hex
    })))
}

fn report_of(frame: WorkerOutbound) -> vm_worker::session::verify::VerifyReport {
    match frame {
        WorkerOutbound::VerifyReport { report, .. } => report,
        other => panic!("应回 verify_report 帧,实际 {other:?}"),
    }
}

/// 成功路径:活体 won 会话的重放材料 → verify 裁决 success(重放逐项一致,
/// log_digest = 规范化日志 SHA-256,与 ActionLog::hash_hex 独立复算同值)。
#[test]
fn verify_reports_success_for_won_session_log() {
    let bundle = verify_bundle("wp61-verify-success");
    let descriptor = verify_descriptor("wp61-verify-success");
    let (context, log) = live_material("wp61-verify-success", &[winning_action()]);
    let report = report_of(run_verify(&bundle, &descriptor, &context, &log).expect("verify 受理"));
    assert_eq!(report.verdict.as_str(), "success");
    assert_eq!(
        report.log_digest,
        vm_runtime::action_log::ActionLog::from_canonical_text(&log)
            .unwrap()
            .hash_hex()
            .unwrap()
    );
    match &report.replay {
        VerifyReplayOutcome::Matched {
            final_status,
            state_hash_sequence,
            revision_sequence,
            ..
        } => {
            assert_eq!(final_status, "won");
            assert_eq!(revision_sequence, &vec![1u64]);
            assert_eq!(state_hash_sequence.len(), 1);
        }
        other => panic!("重放应逐项一致,实际 {other:?}"),
    }
}

/// 未达成成功条件(wrong_answer 方向):running 会话日志 → wrong_answer。
#[test]
fn verify_reports_wrong_answer_for_unwon_session_log() {
    let bundle = verify_bundle("wp61-verify-unwon");
    let descriptor = verify_descriptor("wp61-verify-unwon");
    let (context, log) = live_material("wp61-verify-unwon", &[]);
    let report = report_of(run_verify(&bundle, &descriptor, &context, &log).expect("verify 受理"));
    assert_eq!(report.verdict.as_str(), "wrong_answer");
}

/// 篡改矩阵:日志任一字段漂移 → replay_mismatch(replay_detects_tampered_log
/// 在服务面复锚;detail 携带条目序与漂移字段,不静默通过)。
#[test]
fn verify_detects_tampered_log_field_as_replay_mismatch() {
    let bundle = verify_bundle("wp61-verify-tamper");
    let descriptor = verify_descriptor("wp61-verify-tamper");
    let (context, log) = live_material("wp61-verify-tamper", &[winning_action()]);

    // 篡改 1:条目 0 的后置状态哈希首字符(canonical JSON 语法不变)。
    let marker = "\"stateHashAfter\":\"";
    let position = log.find(marker).expect("日志含 stateHashAfter") + marker.len();
    let mut tampered = log.clone();
    let flipped = if log.as_bytes()[position] == b'0' {
        '1'
    } else {
        '0'
    };
    tampered.replace_range(position..position + 1, &flipped.to_string());
    let report =
        report_of(run_verify(&bundle, &descriptor, &context, &tampered).expect("verify 受理"));
    assert_eq!(report.verdict.as_str(), "replay_mismatch");
    match &report.replay {
        VerifyReplayOutcome::Diverged { entry, field, .. } => {
            assert_eq!(*entry, 0);
            assert_eq!(field, "state_hash");
        }
        other => panic!("应为 Diverged,实际 {other:?}"),
    }

    // 篡改 2:动作参数与内存差分(write 字节 42 → 43;重放哈希漂移)。
    let tampered = log.replace("\"bytesHex\":\"42\"", "\"bytesHex\":\"43\"");
    assert_ne!(tampered, log, "语料应含被篡改字节");
    let report =
        report_of(run_verify(&bundle, &descriptor, &context, &tampered).expect("verify 受理"));
    assert_eq!(report.verdict.as_str(), "replay_mismatch");

    // 篡改 3:revision 序列漂移(revisionAfter 1 → 9)。
    let mut tampered = log.clone();
    let marker = "\"revisionAfter\":";
    let position = tampered.find(marker).expect("日志含 revisionAfter") + marker.len();
    tampered.replace_range(position..position + 1, "9");
    let report =
        report_of(run_verify(&bundle, &descriptor, &context, &tampered).expect("verify 受理"));
    assert_eq!(report.verdict.as_str(), "replay_mismatch");
}

/// 上下文一致性:①请求上下文与装配产物不符(包哈希谎报)→ challenge_invalid
/// 方向命令级错误(宁可拒绝,不近似裁决;进程存活);②日志内嵌上下文与装配
/// 产物错配 → replay ContextMismatch → 裁决 challenge_invalid。
#[test]
fn verify_rejects_context_mismatch_as_challenge_invalid() {
    let bundle = verify_bundle("wp61-verify-ctx");
    let descriptor = verify_descriptor("wp61-verify-ctx");
    let (mut context, log) = live_material("wp61-verify-ctx", &[winning_action()]);
    context["challengeBundleHash"] = json!("0".repeat(64));
    let frame = run_verify(&bundle, &descriptor, &context, &log).expect("verify 受理");
    match frame {
        WorkerOutbound::CommandError { error, .. } => {
            assert!(matches!(error.code, WorkerErrorCode::ChallengeInvalid));
        }
        other => panic!("请求上下文错配应拒绝裁决,实际 {other:?}"),
    }

    let (context, log) = live_material("wp61-verify-ctx", &[winning_action()]);
    let drifted = log.replacen(
        "\"challengeId\":\"wp61-verify-ctx\"",
        "\"challengeId\":\"wp61-other\"",
        1,
    );
    assert_ne!(drifted, log, "语料应含日志上下文 challengeId");
    let report =
        report_of(run_verify(&bundle, &descriptor, &context, &drifted).expect("verify 受理"));
    assert_eq!(report.verdict.as_str(), "challenge_invalid");
}

/// 形态漂移:动作日志不是合法 `stackmaster-action-log/1` → challenge_invalid
/// 方向命令级错误(日志是不可信入站;进程存活、阶段不变)。
#[test]
fn verify_rejects_malformed_action_log_as_challenge_invalid() {
    let bundle = verify_bundle("wp61-verify-form");
    let descriptor = verify_descriptor("wp61-verify-form");
    let (context, log) = live_material("wp61-verify-form", &[]);
    let drifted = log.replace("stackmaster-action-log/1", "stackmaster-action-log/2");
    let frame = run_verify(&bundle, &descriptor, &context, &drifted).expect("verify 受理");
    assert!(
        matches!(frame, WorkerOutbound::CommandError { .. }),
        "{frame:?}"
    );
    let frame = run_verify(&bundle, &descriptor, &context, "{not canonical").expect("verify 受理");
    assert!(matches!(frame, WorkerOutbound::CommandError { .. }));
}

/// 版本锁定(版本策略 §四.4):包声明引擎版本与 worker 自报不一致 →
/// challenge_invalid 方向拒绝裁决(宁可拒绝,不近似执行)。
#[test]
fn verify_enforces_bundle_version_lock() {
    let mut bundle = verify_bundle("wp61-verify-lock");
    bundle["vmEngineVersion"] = json!("9.9.9");
    let descriptor = verify_descriptor("wp61-verify-lock");
    let (context, log) = live_material("wp61-verify-lock", &[]);
    let frame = run_verify(&bundle, &descriptor, &context, &log).expect("verify 受理");
    assert!(matches!(frame, WorkerOutbound::CommandError { .. }));
}

/// seed 策略互斥(XS-SEED-POLICY):fixed 题目携带会话种子 → challenge_invalid
/// (verify 与 load 同一装配序,fail-closed)。
#[test]
fn verify_enforces_seed_policy_mutual_exclusion() {
    let bundle = verify_bundle("wp61-verify-seed");
    let descriptor = verify_descriptor("wp61-verify-seed");
    let (context, log) = live_material("wp61-verify-seed", &[]);
    let frame = run_verify_with_seed(
        &bundle,
        &descriptor,
        &context,
        &log,
        Some("00112233445566778899aabbccddeeff"),
    )
    .expect("verify 受理");
    assert!(matches!(frame, WorkerOutbound::CommandError { .. }));
}

/// 状态机:verify 仅未装载阶段受理(独立一次性裁决进程形态;已装载会话
/// 进程不可达 → 协议层 state_violation)。
#[test]
fn verify_is_state_violation_in_loaded_phase() {
    let mut worker = Worker::new().expect("worker 构造");
    worker
        .handle_frame(&strict(&json!({
            "type": "load", "seq": 1,
            "privateBundle": verify_bundle("wp61-verify-phase"),
            "publicDescriptor": verify_descriptor("wp61-verify-phase")
        })))
        .expect("load 受理");
    let (context, log) = live_material("wp61-verify-phase", &[]);
    let violation = worker.handle_frame(&strict(&json!({
        "type": "verify", "seq": 2,
        "privateBundle": verify_bundle("wp61-verify-phase"),
        "publicDescriptor": verify_descriptor("wp61-verify-phase"),
        "replayContext": context,
        "actionLog": log
    })));
    assert!(matches!(
        violation,
        Err(ProtocolViolation::StateViolation { .. })
    ));
}

/// export_action_log:未装载阶段 = state_violation;装载后回执上下文六记录项
/// 与包身份一致,日志可被 ActionLog 解析面读回(往返一致)。
#[test]
fn export_action_log_roundtrips_context_and_log() {
    // 未装载 → state_violation(独立 worker:协议违规消费 seq 水位,真实进程
    // 随违规终止,故不复用实例)。
    let mut worker = Worker::new().expect("worker 构造");
    let violation = worker.handle_frame(&strict(&json!({ "type": "export_action_log", "seq": 1 })));
    assert!(matches!(
        violation,
        Err(ProtocolViolation::StateViolation { .. })
    ));

    let mut worker = Worker::new().expect("worker 构造");
    worker
        .handle_frame(&strict(&json!({
            "type": "load", "seq": 1,
            "privateBundle": verify_bundle("wp61-export"),
            "publicDescriptor": verify_descriptor("wp61-export")
        })))
        .expect("load 受理");
    let exported = worker.handle_frame(&strict(&json!({ "type": "export_action_log", "seq": 2 })));
    match exported {
        Ok(WorkerOutbound::ActionLogExported {
            replay_context,
            action_log,
            ..
        }) => {
            assert_eq!(replay_context["challengeId"], "wp61-export");
            assert_eq!(replay_context["challengeContentVersion"], "1.0.0");
            assert_eq!(replay_context["vmProfileVersion"], "1.0.0");
            assert_eq!(replay_context["vmEngineVersion"], env!("CARGO_PKG_VERSION"));
            assert_eq!(replay_context["verdictRuleVersion"], "1.0.0");
            assert_eq!(
                replay_context["challengeBundleHash"].as_str().map(str::len),
                Some(64)
            );
            assert_eq!(
                replay_context["vmProfileHash"].as_str().map(str::len),
                Some(64)
            );
            assert_eq!(replay_context["archBits"], 32);
            assert_eq!(replay_context["seedPolicy"]["strategy"], "fixed");
            assert_eq!(replay_context["engineBuildId"], "dev");
            let parsed = vm_runtime::action_log::ActionLog::from_canonical_text(&action_log)
                .expect("导出日志可读回");
            assert_eq!(parsed.len(), 0, "空会话日志零条目");
        }
        other => panic!("应回 action_log_exported,实际 {other:?}"),
    }
}

// ── WP-62:隐藏测试裁决与 11 值汇总(判题语义规约 §八·一 / ADR-9 §四·一)──

/// 题目语料变体:在 verify_bundle 上追加隐藏测试声明(predicate_probe 形态,
/// 载荷空,D-H2 边界)。
fn bundle_with_hidden_tests(challenge_id: &str, tests: Value) -> Value {
    let mut bundle = verify_bundle(challenge_id);
    bundle["judging"]["hiddenTests"] = tests;
    bundle
}

/// 程序变体注入(IR 指令序列;隐藏测试克隆从基线运行)。
fn with_program(bundle: &mut Value, instructions: Value) {
    bundle["compiledIr"]["instructions"] = instructions;
}

fn probe_tests(expected: &str) -> Value {
    json!([{ "testId": "probe-0", "kind": "predicate_probe", "expectedResult": expected }])
}

fn reference_payload_tests(expected: &str) -> Value {
    json!([{ "testId": "ref-0", "kind": "reference_payload", "expectedResult": expected }])
}

/// 非制胜动作:写 0x42 到 buffer(成功条件锚定 stack 0x200,会话保持 running)。
fn neutral_action() -> Value {
    json!({ "type": "write_bytes", "args": { "addressHex": "0x20000000", "bytesHex": "42" } })
}

fn summary_tests(report: &VerifyReport) -> Vec<(u32, String, String, bool)> {
    match &report.hidden_tests {
        vm_worker::session::verify::HiddenTestSummary::Executed { tests, .. } => tests
            .iter()
            .map(|t| (t.index, t.verdict.clone(), t.expected.clone(), t.passed))
            .collect(),
        other => panic!("汇总面应为 executed,实际 {other:?}"),
    }
}

/// 参考解语料(predicate_probe 全过 + 终态 won)⇒ success:汇总面 executed /
/// allPassed / 逐测试(索引,classify,expected,passed)逐格断言。
#[test]
fn verify_runs_hidden_probe_on_won_terminal_as_success_summary() {
    let bundle = bundle_with_hidden_tests("wp62-probe-pass", probe_tests("success"));
    let descriptor = verify_descriptor("wp62-probe-pass");
    let (context, log) = live_material_with(&bundle, &descriptor, &[winning_action()]);
    let report = report_of(run_verify(&bundle, &descriptor, &context, &log).expect("verify 受理"));
    assert_eq!(report.verdict.as_str(), "success");
    match &report.hidden_tests {
        vm_worker::session::verify::HiddenTestSummary::Executed { all_passed, tests } => {
            assert!(*all_passed);
            assert_eq!(tests.len(), 1);
            assert_eq!(tests[0].index, 0);
            assert_eq!(tests[0].verdict, "success");
            assert_eq!(tests[0].expected, "success");
            assert!(tests[0].passed);
        }
        other => panic!("汇总面应为 executed,实际 {other:?}"),
    }
}

/// 独立性锚:交互 won ≠ 强制 success——probe 期望 wrong_answer 而基线达成
/// 成功条件 ⇒ 测试失败(classify success),汇总 wrong_answer(失败方向优先)。
#[test]
fn interaction_won_does_not_force_success_when_hidden_probe_expects_failure() {
    let bundle = bundle_with_hidden_tests("wp62-probe-invert", probe_tests("wrong_answer"));
    let descriptor = verify_descriptor("wp62-probe-invert");
    let (context, log) = live_material_with(&bundle, &descriptor, &[winning_action()]);
    let report = report_of(run_verify(&bundle, &descriptor, &context, &log).expect("verify 受理"));
    assert_eq!(report.verdict.as_str(), "wrong_answer");
    let tests = summary_tests(&report);
    assert_eq!(tests[0].1, "success", "基线达成成功条件 ⇒ classify success");
    assert!(!tests[0].3, "与期望 wrong_answer 不一致 ⇒ 测试失败");
}

/// 未达成成功条件的 probe(期望 success,classify wrong_answer)⇒ wrong_answer
/// (失败方向映射矩阵 wrong_answer 格;终态 running + 全过路径同 wrong_answer)。
#[test]
fn failing_probe_on_unwon_session_maps_to_wrong_answer() {
    let bundle = bundle_with_hidden_tests("wp62-probe-fail", probe_tests("success"));
    let descriptor = verify_descriptor("wp62-probe-fail");
    let (context, log) = live_material_with(&bundle, &descriptor, &[neutral_action()]);
    let report = report_of(run_verify(&bundle, &descriptor, &context, &log).expect("verify 受理"));
    assert_eq!(report.verdict.as_str(), "wrong_answer");
    let tests = summary_tests(&report);
    assert_eq!(tests[0].1, "wrong_answer");
    assert!(!tests[0].3);
}

/// reference_payload(空载荷)克隆自 running 基线运行至崩溃 ⇒ classify
/// program_crash ⇒ 汇总 program_crash(失败方向同字面承载)。
#[test]
fn hidden_reference_payload_crash_maps_to_program_crash() {
    let mut bundle = bundle_with_hidden_tests("wp62-ref-crash", reference_payload_tests("success"));
    with_program(
        &mut bundle,
        json!([{ "op": "mov", "operands": [
            { "kind": "register", "name": "RAX" },
            { "kind": "immediate", "valueHex": "0x1" }
        ] }]),
    );
    let descriptor = verify_descriptor("wp62-ref-crash");
    let (context, log) = live_material_with(&bundle, &descriptor, &[neutral_action()]);
    let report = report_of(run_verify(&bundle, &descriptor, &context, &log).expect("verify 受理"));
    assert_eq!(report.verdict.as_str(), "program_crash");
    let tests = summary_tests(&report);
    assert_eq!(tests[0].1, "program_crash");
    assert!(!tests[0].3);
}

/// reference_payload 克隆运行至数据访问越权 ⇒ classify memory_fault ⇒
/// 汇总 memory_fault。
#[test]
fn hidden_reference_payload_memory_fault_maps_to_memory_fault() {
    let mut bundle =
        bundle_with_hidden_tests("wp62-ref-memfault", reference_payload_tests("success"));
    with_program(
        &mut bundle,
        json!([{ "op": "mov", "operands": [
            { "kind": "register", "name": "RAX" },
            { "kind": "memory", "baseRegister": "RSP", "displacementHex": "0x40000000" }
        ] }]),
    );
    let descriptor = verify_descriptor("wp62-ref-memfault");
    let (context, log) = live_material_with(&bundle, &descriptor, &[neutral_action()]);
    let report = report_of(run_verify(&bundle, &descriptor, &context, &log).expect("verify 受理"));
    assert_eq!(report.verdict.as_str(), "memory_fault");
    let tests = summary_tests(&report);
    assert_eq!(tests[0].1, "memory_fault");
    assert!(!tests[0].3);
}

/// reference_payload 克隆运行至全局步数预算耗尽 ⇒ classify resource_limit ⇒
/// 汇总 resource_limit。
#[test]
fn hidden_reference_payload_budget_exhaustion_maps_to_resource_limit() {
    let mut bundle = bundle_with_hidden_tests("wp62-ref-limit", reference_payload_tests("success"));
    with_program(
        &mut bundle,
        json!([{ "op": "jmp", "operands": [{ "kind": "immediate", "valueHex": "0x0" }] }]),
    );
    let descriptor = verify_descriptor("wp62-ref-limit");
    let (context, log) = live_material_with(&bundle, &descriptor, &[]);
    let report = report_of(run_verify(&bundle, &descriptor, &context, &log).expect("verify 受理"));
    assert_eq!(report.verdict.as_str(), "resource_limit");
    let tests = summary_tests(&report);
    assert_eq!(tests[0].1, "resource_limit");
    assert!(!tests[0].3);
}

/// 终态 failed 的引擎结局粗化优先于隐藏测试结论(fail-closed:交互失败方向
/// 不被隐藏测试"救回";probe 在失败基线上另报 wrong_answer,汇总仍
/// program_crash)。
#[test]
fn failed_terminal_coarsening_takes_priority_over_hidden_probe_direction() {
    // 程序 = 单条 mov:两次 step,第二次取指越界 ⇒ invalid_rip 终态
    //(终态只能由指令执行 / 判题条件置位;动作级教学失败不置终态)。
    let mut bundle = bundle_with_hidden_tests("wp62-failed-priority", probe_tests("success"));
    with_program(
        &mut bundle,
        json!([{ "op": "mov", "operands": [
            { "kind": "register", "name": "RAX" },
            { "kind": "immediate", "valueHex": "0x1" }
        ] }]),
    );
    let descriptor = verify_descriptor("wp62-failed-priority");
    let (context, log) = live_material_with(
        &bundle,
        &descriptor,
        &[
            json!({ "type": "step", "args": {} }),
            json!({ "type": "step", "args": {} }),
        ],
    );
    let report = report_of(run_verify(&bundle, &descriptor, &context, &log).expect("verify 受理"));
    assert_eq!(report.verdict.as_str(), "program_crash");
    let tests = summary_tests(&report);
    assert_eq!(
        tests[0].1, "wrong_answer",
        "probe 在失败基线上另报 wrong_answer"
    );
}

/// 隐藏测试驱动错误(基线谓词预算耗尽)⇒ 汇总 fault 面 + engine_error 方向
/// (主控定案 ④;与重放面谓词预算耗尽的 challenge_invalid 有意区分)。
#[test]
fn predicate_budget_exhaustion_in_hidden_summary_maps_to_engine_error() {
    let mut bundle = bundle_with_hidden_tests("wp62-probe-budget", probe_tests("success"));
    bundle["judgingConfig"]["maxPredicateEvalSteps"] = json!(1);
    let descriptor = verify_descriptor("wp62-probe-budget");
    let (context, log) = live_material_with(&bundle, &descriptor, &[winning_action()]);
    let report = report_of(run_verify(&bundle, &descriptor, &context, &log).expect("verify 受理"));
    assert_eq!(report.verdict.as_str(), "engine_error");
    match &report.hidden_tests {
        vm_worker::session::verify::HiddenTestSummary::Fault { reason } => {
            assert_eq!(*reason, "predicate_budget_exhausted");
        }
        other => panic!("汇总面应为 fault,实际 {other:?}"),
    }
}

/// 重放逐项漂移 ⇒ 隐藏测试不执行(汇总面 skipped),裁决走既有映射。
#[test]
fn verify_skips_hidden_summary_when_replay_diverges() {
    let bundle = bundle_with_hidden_tests("wp62-skip-tamper", probe_tests("success"));
    let descriptor = verify_descriptor("wp62-skip-tamper");
    let (context, log) = live_material_with(&bundle, &descriptor, &[winning_action()]);
    let marker = "\"stateHashAfter\":\"";
    let position = log.find(marker).expect("日志含 stateHashAfter") + marker.len();
    let mut tampered = log.clone();
    tampered.replace_range(position..position + 1, "f");
    let report =
        report_of(run_verify(&bundle, &descriptor, &context, &tampered).expect("verify 受理"));
    assert_eq!(report.verdict.as_str(), "replay_mismatch");
    assert_eq!(
        report.hidden_tests,
        vm_worker::session::verify::HiddenTestSummary::Skipped
    );
}

/// 零公开面机检:verify 响应 JSON 对 testId / 谓词形态 / 载荷字段零命中
/// (汇总面只有索引与判定值,判题语义 §1.5 载荷纪律的响应面延伸)。
#[test]
fn verify_report_hidden_summary_carries_zero_public_face_material() {
    let bundle = bundle_with_hidden_tests("wp62-zero-public", probe_tests("success"));
    let descriptor = verify_descriptor("wp62-zero-public");
    let (context, log) = live_material_with(&bundle, &descriptor, &[winning_action()]);
    let report = report_of(run_verify(&bundle, &descriptor, &context, &log).expect("verify 受理"));
    let text = serde_json::to_string(&report).expect("报告可序列化");
    for forbidden in [
        "probe-0",
        "testId",
        "memory_equals",
        "regionId",
        "bytesHex",
        "offsetBytes",
        "payload",
    ] {
        assert!(
            !text.contains(forbidden),
            "报告面不得携带 {forbidden}:{text}"
        );
    }
}

/// 同日志同汇总(I-4 在汇总面的延伸):同材料两次 verify 结论与汇总面逐字节一致。
#[test]
fn verify_hidden_summary_deterministic_for_same_log() {
    let bundle = bundle_with_hidden_tests("wp62-determinism", probe_tests("success"));
    let descriptor = verify_descriptor("wp62-determinism");
    let (context, log) = live_material_with(&bundle, &descriptor, &[winning_action()]);
    let first = report_of(run_verify(&bundle, &descriptor, &context, &log).expect("verify 受理"));
    let second = report_of(run_verify(&bundle, &descriptor, &context, &log).expect("verify 受理"));
    assert_eq!(first, second);
}

/// 7 值 × 汇总映射矩阵逐格单测(失败测试 classify 值 → 11 值承载;
/// invalid_action / timeout 两格 v1 端到端结构性不可达,由本单测承载)。
#[test]
fn hidden_failure_direction_matrix_covers_seven_classify_values() {
    use vm_worker::session::verify::hidden_test_failure_direction;
    let cases = [
        ("success", "wrong_answer"),
        ("wrong_answer", "wrong_answer"),
        ("invalid_action", "invalid_action"),
        ("program_crash", "program_crash"),
        ("memory_fault", "memory_fault"),
        ("resource_limit", "resource_limit"),
        ("timeout", "timeout"),
    ];
    for (classify, expected) in cases {
        assert_eq!(
            hidden_test_failure_direction(classify).as_str(),
            expected,
            "矩阵格 {classify} ⇒ {expected}"
        );
    }
}

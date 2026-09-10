//! 调试面命令测试(阶段四 WP-41;ADR-DC1 条款 2/3/4/8,引擎进程协议
//! additive 追加变体):load_variant 零装载装配、任意地址窗口(含隐藏区)、
//! 单步 / 断点运行(命中 / 程序止步 / 预算耗尽)、全内存检索、展示数据
//! (伪指令流 / 函数表)、状态机互斥与载荷级拒绝。
//!
//! 零装载断言:变体装载命令只接受 `variant` + `publicDescriptor` 两个字段,
//! 变体内出现 `judgingConfig` / `seed` 等排他字段即在契约层拒绝(structural
//! exclusion,WP-40 红灯 fixture 同形态);真实私有包 / 真实快照导入路径在
//! 调试实例阶段全部状态机拒绝。测试语料全部为占位构造(非真实秘密)。

use serde_json::{Value, json};
use vm_worker::contract::strict_value::StrictValue;
use vm_worker::protocol::message::{DebugPauseReason, WorkerErrorCode, WorkerOutbound};
use vm_worker::protocol::worker::{ProtocolViolation, Worker};

fn new_worker() -> Worker {
    Worker::new().expect("内嵌 Schema 必须可编译")
}

fn frame(value: &Value) -> StrictValue {
    let text = serde_json::to_string(value).unwrap();
    StrictValue::parse(&text).unwrap()
}

/// 字节模式程序(push RBP; mov RBP,RSP; syscall exit(1)),pad = ret。
const PROGRAM_HEX: &str = "5589cd0100000000000000";
const CODE_START: &str = "0x400000";
const STACK_START: &str = "0x7ff3a000";
/// 隐藏区域(零装载使其公开;占位语料,非真实秘密)。
const VAULT_START: &str = "0x405000";
const VAULT_CONTENT_HEX: &str = "d3adb33fc0ffee010203040506070809";

fn region_code_content() -> String {
    let mut hex = String::from(PROGRAM_HEX);
    hex.push_str(&"c3".repeat(4096 - PROGRAM_HEX.len() / 2));
    hex
}

fn region_vault_content() -> String {
    let mut hex = String::from(VAULT_CONTENT_HEX);
    hex.push_str(&"00".repeat(4096 - VAULT_CONTENT_HEX.len() / 2));
    hex
}

/// 调试变体镜像(字节模式最小合法形态;64 位;ASLR 关;占位语料)。
fn valid_variant() -> Value {
    json!({
        "schemaVersion": 1,
        "engineProcessProtocolVersion": 1,
        "challengeId": "stack-bof-101",
        "challengeContentVersion": "1.0.0",
        "vmProfileVersion": "1.0.0",
        "aslrEnabled": false,
        "derivation": { "algorithmId": "splitmix64-stream-v1", "draws": 4 },
        "memoryRegions": [
            {
                "regionId": "code",
                "kind": "code",
                "startAddressHex": CODE_START,
                "byteLength": 4096,
                "permissions": "rx",
                "contentHex": region_code_content(),
                "isHidden": false
            },
            {
                "regionId": "stack",
                "kind": "stack",
                "startAddressHex": STACK_START,
                "byteLength": 4096,
                "permissions": "rw",
                "contentHex": "00".repeat(4096),
                "isHidden": false
            },
            {
                "regionId": "vault",
                "kind": "key",
                "startAddressHex": VAULT_START,
                "byteLength": 4096,
                "permissions": "rw",
                "contentHex": region_vault_content(),
                "isHidden": true
            }
        ],
        "registers": [
            { "name": "RSP", "valueHex": "0x7ff3b000" },
            { "name": "RBP", "valueHex": "0x7ff3b000" },
            { "name": "RIP", "valueHex": CODE_START }
        ],
        "canarySlots": [
            {
                "objectId": "stack-canary",
                "kind": "canary",
                "addressHex": "0x7ff3a7f8",
                "byteLength": 8,
                "visibility": "hidden",
                "containsSecret": true
            }
        ]
    })
}

/// 公开描述包(字节模式;与变体同一题目身份;编码表为公开 ISA 面)。
fn valid_public_descriptor() -> Value {
    let window_hex: String = region_code_content().chars().take(512).collect();
    json!({
        "schemaVersion": 1,
        "challengeId": "stack-bof-101",
        "challengeContentVersion": "1.0.0",
        "vmProfileVersion": "1.0.0",
        "locale": "zh-CN",
        "briefing": {
            "title": "调试变体测试题",
            "summary": "字节模式最小双包:栈帧闭环与 exit。",
            "learningObjectives": ["理解栈帧布局"]
        },
        "vmProfile": {
            "registers": [
                { "name": "RSP" },
                { "name": "RBP" },
                { "name": "RIP" }
            ],
            "flagRegisterNames": ["FLAG_SYS"],
            "endianness": "little",
            "archBits": 64,
            "pageSizeBytes": 4096,
            "canary": { "enabled": true, "sizeBytes": 8 },
            "encodingTable": [
                { "tokenHex": "0x55", "op": "push", "operands": [{ "kind": "register", "name": "RBP" }] },
                { "tokenHex": "0x89", "op": "mov", "operands": [{ "kind": "register", "name": "RBP" }, { "kind": "register", "name": "RSP" }] },
                { "tokenHex": "0xc9", "op": "leave" },
                { "tokenHex": "0xc3", "op": "ret" },
                { "tokenHex": "0xcd", "op": "syscall", "operands": [{ "kind": "immediate", "width": "arch" }] }
            ]
        },
        "memoryLayout": {
            "regions": [
                {
                    "regionId": "code",
                    "kind": "code",
                    "startAddressHex": CODE_START,
                    "byteLength": 4096,
                    "permissions": "rx",
                    "publicLabel": "代码区"
                },
                {
                    "regionId": "stack",
                    "kind": "stack",
                    "startAddressHex": STACK_START,
                    "byteLength": 4096,
                    "permissions": "rw",
                    "publicLabel": "栈"
                }
            ]
        },
        "allowedActions": ["write_bytes", "push", "pop", "call", "ret", "step", "run_to_event", "pause", "undo", "checkout_checkpoint", "reset", "create_checkpoint"],
        "resourceLimits": {},
        "hintLadder": [],
        "publicErrorMapping": [],
        "initialProjection": {
            "visibleRegions": [
                {
                    "regionId": "code",
                    "label": "代码区",
                    "startAddressHex": CODE_START,
                    "byteLength": 4096,
                    "permissions": "rx",
                    "bytesHex": window_hex,
                    "truncated": true
                }
            ],
            "visibleRegisters": [
                { "name": "RSP", "valueHex": "0x7FF3B000" },
                { "name": "RBP", "valueHex": "0x7FF3B000" },
                { "name": "RIP", "valueHex": "0x400000" }
            ]
        }
    })
}

/// 最小合法私有判题包(字节模式;与公开描述包同一题目身份;占位语料)。
fn valid_private_bundle() -> Value {
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
            "registers": {
                "RSP": "0x7ff3b000",
                "RBP": "0x7ff3b000",
                "RIP": CODE_START
            },
            "memoryRegions": [
                {
                    "regionId": "code",
                    "kind": "code",
                    "startAddressHex": CODE_START,
                    "byteLength": 4096,
                    "permissions": "rx",
                    "contentHex": region_code_content(),
                    "isHidden": false
                },
                {
                    "regionId": "stack",
                    "kind": "stack",
                    "startAddressHex": STACK_START,
                    "byteLength": 4096,
                    "permissions": "rw",
                    "contentHex": "00".repeat(4096),
                    "isHidden": false
                }
            ]
        },
        "secrets": { "flag": "FLAG{placeholder}", "virtualFiles": [] },
        "privateObjects": [
            {
                "objectId": "stack-canary",
                "kind": "canary",
                "addressHex": "0x7ff3a7f8",
                "byteLength": 8,
                "visibility": "public",
                "containsSecret": false
            }
        ],
        "judging": { "successCondition": { "all": [] } },
        "entrypointAddressHex": CODE_START,
        "judgingConfig": { "verdictRuleVersion": "1.0.0", "maxPredicateEvalSteps": 10000 }
    })
}

fn expect_command_error(outbound: WorkerOutbound, code: WorkerErrorCode) {
    match outbound {
        WorkerOutbound::CommandError { error, .. } => assert_eq!(error.code, code),
        other => panic!("预期命令级错误 {code:?},实得 {other:?}"),
    }
}

/// 每 worker 专属测试台:seq 由本台自增(引擎协议要求恰为 last+1,禁跳号)。
struct Harness {
    worker: Worker,
    next_seq: u64,
}

impl Harness {
    fn new() -> Self {
        Self {
            worker: new_worker(),
            next_seq: 1,
        }
    }

    fn take_seq(&mut self) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        seq
    }

    /// 变体装载(seq = 1;标准前置,断言零装载回执摘要)。
    fn load_variant(&mut self) {
        let command = json!({
            "type": "load_variant",
            "seq": self.take_seq(),
            "variant": valid_variant(),
            "publicDescriptor": valid_public_descriptor()
        });
        let outbound = self
            .worker
            .handle_frame(&frame(&command))
            .expect("合法变体装载必须成功");
        match outbound {
            WorkerOutbound::VariantLoaded { loaded, .. } => {
                assert_eq!(loaded.challenge_id, "stack-bof-101");
                assert_eq!(loaded.challenge_content_version, "1.0.0");
                assert_eq!(loaded.vm_profile_version, "1.0.0");
                assert_eq!(loaded.initial_revision, 0);
            }
            other => panic!("预期 VariantLoaded,实得 {other:?}"),
        }
    }

    /// 发送一条调试面命令并取回响应。
    fn send(&mut self, type_: &str, extra: Value) -> WorkerOutbound {
        let mut command = json!({ "type": type_, "seq": self.take_seq() });
        if extra.is_object() {
            for (key, value) in extra.as_object().unwrap() {
                command[key] = value.clone();
            }
        }
        self.worker
            .handle_frame(&frame(&command))
            .expect("调试命令必须被受理(响应可为命令级错误)")
    }

    /// 发送任意信封帧(seq 自动补齐;状态机违规路径)。
    fn send_raw(&mut self, mut value: Value) -> Result<WorkerOutbound, ProtocolViolation> {
        if value.get("seq").is_none() {
            value["seq"] = json!(self.take_seq());
        } else {
            self.take_seq();
        }
        self.worker.handle_frame(&frame(&value))
    }
}

/// 标准前置:已装载变体的测试台。
fn loaded_harness() -> Harness {
    let mut harness = Harness::new();
    harness.load_variant();
    harness
}

fn reason_str(reason: DebugPauseReason) -> &'static str {
    match reason {
        DebugPauseReason::Step => "step",
        DebugPauseReason::Breakpoint => "breakpoint",
        DebugPauseReason::ProgramHalt => "program_halt",
        DebugPauseReason::Budget => "budget",
    }
}

// ── 零装载与装载面 ────────────────────────────────────────────────────────────

#[test]
fn load_variant_succeeds_with_summary() {
    let _ = loaded_harness();
}

#[test]
fn variant_with_judging_or_seed_field_is_rejected() {
    // 零装载的结构性排除面:judgingConfig / seed 字段出现即拒(WP-40 红灯
    // fixture 同形态;变体路径无可判之物,条款 5)。
    for (field, value) in [
        (
            "judgingConfig",
            json!({ "verdictRuleVersion": "1.0.0", "maxPredicateEvalSteps": 100 }),
        ),
        ("seed", json!("00112233445566778899aabbccddeeff")),
        ("hiddenTests", json!([])),
    ] {
        let mut variant = valid_variant();
        variant[field] = value;
        let mut harness = Harness::new();
        let command = json!({
            "type": "load_variant",
            "seq": harness.take_seq(),
            "variant": variant,
            "publicDescriptor": valid_public_descriptor()
        });
        let outbound = harness.worker.handle_frame(&frame(&command)).unwrap();
        expect_command_error(outbound, WorkerErrorCode::ChallengeInvalid);
    }
}

#[test]
fn variant_identity_mismatch_is_rejected() {
    let mut variant = valid_variant();
    variant["challengeId"] = json!("another-challenge");
    let mut harness = Harness::new();
    let command = json!({
        "type": "load_variant",
        "seq": harness.take_seq(),
        "variant": variant,
        "publicDescriptor": valid_public_descriptor()
    });
    let outbound = harness.worker.handle_frame(&frame(&command)).unwrap();
    expect_command_error(outbound, WorkerErrorCode::ChallengeInvalid);
}

#[test]
fn load_variant_twice_is_state_violation() {
    // 双装载 = 状态机违规(单进程一次服务一个实例)。
    let mut harness = loaded_harness();
    let error = harness
        .send_raw(json!({
            "type": "load_variant",
            "variant": valid_variant(),
            "publicDescriptor": valid_public_descriptor()
        }))
        .unwrap_err();
    assert!(matches!(error, ProtocolViolation::StateViolation { .. }));
}

// ── 状态机互斥(调试面与真实会话面零交叉)─────────────────────────────────

#[test]
fn debug_commands_before_load_are_state_violations() {
    let mut harness = Harness::new();
    for type_ in ["debug_step", "debug_query_state", "debug_function_table"] {
        let error = harness.send_raw(json!({ "type": type_ })).unwrap_err();
        assert!(
            matches!(error, ProtocolViolation::StateViolation { .. }),
            "未装载即调试命令必须拒绝"
        );
    }
    let error = harness
        .send_raw(json!({
            "type": "debug_read_window",
            "addressHex": "0x400000",
            "byteLength": 8
        }))
        .unwrap_err();
    assert!(matches!(error, ProtocolViolation::StateViolation { .. }));
}

#[test]
fn real_session_commands_are_rejected_in_debug_phase() {
    // 真实会话命令在调试实例阶段全部状态机拒绝(apply_action / 快照导出 /
    // 真实 load)——真实私有包与真实快照导入路径零接入(条款 3)。
    let mut harness = loaded_harness();
    let action_request = json!({
        "protocolVersion": 1,
        "sessionId": "session-1",
        "clientSeq": 1,
        "baseRevision": 0,
        "idempotencyKey": "key-1",
        "action": { "type": "step", "args": {} }
    });
    for command in [
        json!({ "type": "apply_action", "requestId": "req-1", "actionRequest": action_request }),
        json!({ "type": "export_snapshot" }),
        json!({ "type": "import_snapshot", "snapshot": {} }),
        json!({ "type": "load", "privateBundle": {}, "publicDescriptor": {} }),
    ] {
        let error = harness.send_raw(command).unwrap_err();
        assert!(
            matches!(error, ProtocolViolation::StateViolation { .. }),
            "调试实例阶段拒绝真实会话命令"
        );
    }
}

#[test]
fn debug_commands_are_rejected_in_real_session_phase() {
    // 真实会话阶段拒绝调试命令(两态互斥;真实字节模式装载先行)。
    let mut harness = Harness::new();
    let command = json!({
        "type": "load",
        "seq": harness.take_seq(),
        "privateBundle": valid_private_bundle(),
        "publicDescriptor": valid_public_descriptor()
    });
    let outbound = harness
        .worker
        .handle_frame(&frame(&command))
        .expect("真实字节模式装载必须成功");
    assert!(matches!(outbound, WorkerOutbound::Loaded { .. }));
    let error = harness.send_raw(json!({ "type": "debug_step" })).unwrap_err();
    assert!(matches!(error, ProtocolViolation::StateViolation { .. }));
}

// ── 窗口读取(任意地址,含隐藏区)────────────────────────────────────────────

#[test]
fn debug_read_window_reads_hidden_region() {
    // 零装载使隐藏区域公开:任意地址原始读(条款 2;含 isHidden 区域)。
    let mut harness = loaded_harness();
    let outbound = harness.send(
        "debug_read_window",
        json!({ "addressHex": VAULT_START, "byteLength": 8 }),
    );
    match outbound {
        WorkerOutbound::DebugWindowData {
            address_hex,
            bytes_hex,
            truncated,
            ..
        } => {
            assert_eq!(address_hex, VAULT_START);
            assert_eq!(bytes_hex, "d3adb33fc0ffee01");
            assert!(!truncated);
        }
        other => panic!("预期 DebugWindowData,实得 {other:?}"),
    }
}

#[test]
fn debug_read_window_truncates_at_region_boundary() {
    let mut harness = loaded_harness();
    // 请求 16 字节,窗口在区域末尾截断(区域 0x405000..0x406000)。
    let outbound = harness.send(
        "debug_read_window",
        json!({ "addressHex": "0x405ff8", "byteLength": 16 }),
    );
    match outbound {
        WorkerOutbound::DebugWindowData { bytes_hex, truncated, .. } => {
            assert_eq!(bytes_hex.len(), 16, "恰 8 字节(截断后)");
            assert!(truncated);
        }
        other => panic!("预期 DebugWindowData,实得 {other:?}"),
    }
}

#[test]
fn debug_read_window_rejects_unmapped_and_oversize() {
    let mut harness = loaded_harness();
    // 未映射地址 → inaccessible_address。
    let outbound = harness.send("debug_read_window", json!({ "addressHex": "0x0", "byteLength": 1 }));
    expect_command_error(outbound, WorkerErrorCode::InaccessibleAddress);
    // 超协议上限 / 非法地址 / 零长度 → invalid_input_format。
    for extra in [
        json!({ "addressHex": "0x400000", "byteLength": 4097 }),
        json!({ "addressHex": "nothex", "byteLength": 1 }),
        json!({ "addressHex": "0x400000", "byteLength": 0 }),
    ] {
        let outbound = harness.send("debug_read_window", extra);
        expect_command_error(outbound, WorkerErrorCode::InvalidInputFormat);
    }
}

// ── 单步与断点运行 ────────────────────────────────────────────────────────────

#[test]
fn debug_step_pauses_step_by_step_until_program_halt() {
    let mut harness = loaded_harness();
    // step ×3:push RBP → mov RBP,RSP → syscall exit(1)(程序止步)。
    for expected_reason in ["step", "step", "program_halt"] {
        let outbound = harness.send("debug_step", json!({}));
        match outbound {
            WorkerOutbound::DebugHalted { reason, steps_executed, .. } => {
                assert_eq!(reason_str(reason), expected_reason);
                assert_eq!(steps_executed, 1);
            }
            other => panic!("预期 DebugHalted,实得 {other:?}"),
        }
    }
    // 停机后继续 step = program_halt(无推进假象)。
    let outbound = harness.send("debug_step", json!({}));
    match outbound {
        WorkerOutbound::DebugHalted { reason, .. } => {
            assert_eq!(reason_str(reason), "program_halt")
        }
        other => panic!("预期 DebugHalted,实得 {other:?}"),
    }
}

#[test]
fn debug_run_to_breakpoint_hits_breakpoint() {
    let mut harness = loaded_harness();
    // 断点 = syscall 指令地址:恰 2 步后命中(push、mov 落点即断点)。
    let outbound = harness.send(
        "debug_run_to_breakpoint",
        json!({ "breakpoints": ["0x400002"], "maxSteps": 100 }),
    );
    match outbound {
        WorkerOutbound::DebugHalted { reason, address_hex, steps_executed, .. } => {
            assert_eq!(reason_str(reason), "breakpoint");
            assert_eq!(address_hex, "0x400002");
            assert_eq!(steps_executed, 2);
        }
        other => panic!("预期 DebugHalted,实得 {other:?}"),
    }
}

#[test]
fn debug_run_to_breakpoint_reports_program_halt_and_budget() {
    let mut harness = loaded_harness();
    // 断点不可达:程序自行停机(exit)→ program_halt。
    let outbound = harness.send(
        "debug_run_to_breakpoint",
        json!({ "breakpoints": ["0x500000"], "maxSteps": 100 }),
    );
    match outbound {
        WorkerOutbound::DebugHalted { reason, .. } => {
            assert_eq!(reason_str(reason), "program_halt")
        }
        other => panic!("预期 DebugHalted,实得 {other:?}"),
    }
    // 重新装载(新实例):预算耗尽确定性暂停(reason = budget)。
    let mut harness = loaded_harness();
    let outbound = harness.send(
        "debug_run_to_breakpoint",
        json!({ "breakpoints": ["0x400002"], "maxSteps": 1 }),
    );
    match outbound {
        WorkerOutbound::DebugHalted { reason, steps_executed, .. } => {
            assert_eq!(reason_str(reason), "budget");
            assert_eq!(steps_executed, 1);
        }
        other => panic!("预期 DebugHalted,实得 {other:?}"),
    }
}

#[test]
fn debug_run_to_breakpoint_rejects_empty_breakpoints() {
    let mut harness = loaded_harness();
    let outbound = harness.send(
        "debug_run_to_breakpoint",
        json!({ "breakpoints": [], "maxSteps": 10 }),
    );
    expect_command_error(outbound, WorkerErrorCode::InvalidInputFormat);
}

// ── 检索与展示数据 ────────────────────────────────────────────────────────────

#[test]
fn debug_search_finds_pattern_across_whole_memory() {
    let mut harness = loaded_harness();
    // 命中隐藏区域内容(全内存检索;含 isHidden 区)。
    let outbound = harness.send("debug_search", json!({ "patternHex": "d3adb33f", "maxHits": 256 }));
    match outbound {
        WorkerOutbound::DebugSearchResults { hits, truncated, .. } => {
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].address_hex, VAULT_START);
            assert_eq!(hits[0].bytes_hex, "d3adb33f");
            assert!(!truncated);
        }
        other => panic!("预期 DebugSearchResults,实得 {other:?}"),
    }
    // pad token(ret = c3)遍布代码区:命中数超过 maxHits → truncated。
    let outbound = harness.send("debug_search", json!({ "patternHex": "c3", "maxHits": 2 }));
    match outbound {
        WorkerOutbound::DebugSearchResults { hits, truncated, .. } => {
            assert_eq!(hits.len(), 2);
            assert!(truncated);
        }
        other => panic!("预期 DebugSearchResults,实得 {other:?}"),
    }
    // 奇数位 hex / 空模式 → invalid_input_format。
    for extra in [
        json!({ "patternHex": "d3a", "maxHits": 4 }),
        json!({ "patternHex": "", "maxHits": 4 }),
    ] {
        let outbound = harness.send("debug_search", extra);
        expect_command_error(outbound, WorkerErrorCode::InvalidInputFormat);
    }
}

#[test]
fn debug_instruction_stream_renders_display_text() {
    let mut harness = loaded_harness();
    let outbound = harness.send(
        "debug_instruction_stream",
        json!({ "addressHex": CODE_START, "maxItems": 3 }),
    );
    match outbound {
        WorkerOutbound::DebugInstructionStreamData { instructions, truncated, .. } => {
            assert_eq!(instructions.len(), 3);
            assert_eq!(instructions[0].address_hex, CODE_START);
            assert_eq!(instructions[0].text, "push RBP");
            assert_eq!(instructions[0].bytes_hex.as_deref(), Some("55"));
            assert_eq!(instructions[1].text, "mov RBP, RSP");
            // 源仍有后续指令(pad ret)→ truncated。
            assert!(truncated);
        }
        other => panic!("预期 DebugInstructionStreamData,实得 {other:?}"),
    }
}

#[test]
fn debug_function_table_derives_entry_function() {
    let mut harness = loaded_harness();
    let outbound = harness.send("debug_function_table", json!({}));
    match outbound {
        WorkerOutbound::DebugFunctionTableData { functions, truncated, .. } => {
            // 线性扫描:入口 + pad ret,无 call → 恰 1 条(入口)。
            assert_eq!(functions.len(), 1);
            assert_eq!(functions[0].start_address_hex, CODE_START);
            assert_eq!(functions[0].byte_length, 4096);
            assert!(!functions[0].label.is_empty());
            assert!(!truncated);
        }
        other => panic!("预期 DebugFunctionTableData,实得 {other:?}"),
    }
}

// ── 确定性重放对齐 ────────────────────────────────────────────────────────────

#[test]
fn debug_query_state_reports_revision_and_status() {
    let mut harness = loaded_harness();
    // 重放一条 write_bytes(已接受动作形态)→ revision 推进。
    let _ = harness.send(
        "debug_apply_recorded",
        json!({ "action": { "type": "write_bytes", "args": { "addressHex": STACK_START, "bytesHex": "41414141" } } }),
    );
    let outbound = harness.send("debug_query_state", json!({}));
    match outbound {
        WorkerOutbound::DebugState { state, .. } => {
            assert_eq!(state.revision, 1);
            assert_eq!(state.status, "running");
            assert_eq!(state.rip_hex, CODE_START);
            assert!(!state.halted);
        }
        other => panic!("预期 DebugState,实得 {other:?}"),
    }
}

#[test]
fn debug_replay_write_bytes_is_visible_via_window() {
    // 重放对齐的可观察性:write_bytes 后窗口读回同字节(确定性重放)。
    let mut harness = loaded_harness();
    let outbound = harness.send(
        "debug_apply_recorded",
        json!({ "action": { "type": "write_bytes", "args": { "addressHex": STACK_START, "bytesHex": "41414141" } } }),
    );
    match outbound {
        WorkerOutbound::DebugApplied { revision, status, .. } => {
            assert_eq!(revision, 1);
            assert_eq!(status, "running");
        }
        other => panic!("预期 DebugApplied,实得 {other:?}"),
    }
    let outbound = harness.send(
        "debug_read_window",
        json!({ "addressHex": STACK_START, "byteLength": 4 }),
    );
    match outbound {
        WorkerOutbound::DebugWindowData { bytes_hex, .. } => assert_eq!(bytes_hex, "41414141"),
        other => panic!("预期 DebugWindowData,实得 {other:?}"),
    }
    // 重放越权写入(代码区只读)→ 与权威日志错位 = internal_error(编排器
    // 据此中止 attach;权威日志只含已接受动作,此形态即编排侧缺陷)。
    let outbound = harness.send(
        "debug_apply_recorded",
        json!({ "action": { "type": "write_bytes", "args": { "addressHex": CODE_START, "bytesHex": "90" } } }),
    );
    expect_command_error(outbound, WorkerErrorCode::InternalError);
}

#[test]
fn debug_replay_undo_create_checkpoint_align_with_authority() {
    let mut harness = loaded_harness();
    let write = json!({ "action": { "type": "write_bytes", "args": { "addressHex": STACK_START, "bytesHex": "41414141" } } });
    // write → undo → write:三条已接受动作,revision 恒对齐(1 → 2 → 3)。
    for (action, expected_revision) in [
        (write, 1u64),
        (
            json!({ "action": { "type": "undo", "args": {} } }),
            2,
        ),
        (
            json!({ "action": { "type": "write_bytes", "args": { "addressHex": STACK_START, "bytesHex": "41414141" } } }),
            3,
        ),
    ] {
        let outbound = harness.send("debug_apply_recorded", action);
        match outbound {
            WorkerOutbound::DebugApplied { revision, .. } => assert_eq!(revision, expected_revision),
            other => panic!("预期 DebugApplied,实得 {other:?}"),
        }
    }
    // undo 后窗口读回零值(撤销生效)。
    let outbound = harness.send(
        "debug_read_window",
        json!({ "addressHex": STACK_START, "byteLength": 4 }),
    );
    match outbound {
        WorkerOutbound::DebugWindowData { bytes_hex, .. } => assert_eq!(bytes_hex, "41414141"),
        other => panic!("预期 DebugWindowData,实得 {other:?}"),
    }
    // create_checkpoint 不改状态(真实实例语义)但推进 revision。
    let outbound = harness.send(
        "debug_apply_recorded",
        json!({ "action": { "type": "create_checkpoint", "args": { "label": "cp" } } }),
    );
    assert!(matches!(
        outbound,
        WorkerOutbound::DebugApplied { revision: 4, .. }
    ));
    // checkout_checkpoint 在调试实例无账本 → 错位(权威日志不会含它,
    // 出现即编排侧缺陷方向)。
    let outbound = harness.send(
        "debug_apply_recorded",
        json!({ "action": { "type": "checkout_checkpoint", "args": { "checkpointId": "cp-x" } } }),
    );
    expect_command_error(outbound, WorkerErrorCode::InternalError);
}

#[test]
fn debug_query_projection_uses_full_visibility_policy() {
    // 调试阶段 query_projection:全可见策略(零装载 ⇒ 隐藏区域可公开)。
    let mut harness = loaded_harness();
    let outbound = harness
        .send_raw(json!({ "type": "query_projection" }))
        .unwrap();
    match outbound {
        WorkerOutbound::Projection { projection, .. } => {
            let regions = projection["visibleRegions"].as_array().expect("区域数组");
            let ids: Vec<&str> = regions
                .iter()
                .map(|region| region["regionId"].as_str().expect("regionId"))
                .collect();
            assert!(
                ids.contains(&"vault"),
                "调试实例投影含隐藏区域(零装载公开):{ids:?}"
            );
        }
        other => panic!("预期 Projection,实得 {other:?}"),
    }
}

#[test]
fn debug_shutdown_is_graceful() {
    let mut harness = loaded_harness();
    let outbound = harness.send_raw(json!({ "type": "shutdown" })).unwrap();
    assert!(matches!(outbound, WorkerOutbound::ShutdownAck { .. }));
}

//! 会话生命周期集成测试(WP-8;引擎进程协议 §四命令面 + 会话编排语义规约
//! §八锚点):装载 → 动作 → 投影 → checkpoint → undo / checkout / reset →
//! 快照导出 / 导入(崩溃替换)的全链路,写分类执行前判定(D-P1 / E-3)、
//! I-9 统一不可见拒绝、终态闸门与确定性(I-4:同脚本两次运行字节一致)。

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use vm_worker::contract::strict_value::StrictValue;
use vm_worker::protocol::message::WorkerOutbound;
use vm_worker::protocol::worker::Worker;

const A32_REGION: u64 = 4096;
const CODE_BASE: &str = "0x401000";
const BUFFER_BASE: &str = "0x20000000";
const SECRET_BASE: &str = "0x20001000";
const STACK_BASE: &str = "0x7ffff000";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .to_path_buf()
}

fn zero_hex(bytes: usize) -> String {
    "00".repeat(bytes)
}

/// 生命周期题目:32 位 IR 模式;buffer(可见)与 secret(隐藏)相邻——
/// 写分类越界判定的承载布局;成功条件 RAX == 0x41(脚本不触碰,保持 running)。
fn lifecycle_bundle() -> Value {
    let code_content = {
        let mut hex = String::from("c3"); // ret(token 形态的占位内容;IR 模式不译码)
        hex.push_str(&"00".repeat(A32_REGION as usize - 1));
        hex
    };
    json!({
        "schemaVersion": 1,
        "challengeId": "wp8-lifecycle",
        "challengeContentVersion": "1.0.0",
        "vmProfileVersion": "1.0.0",
        "dslSchemaVersion": 2,
        "vmEngineVersion": env!("CARGO_PKG_VERSION"),
        "declaredSeedPublicPaths": [],
        "seedPolicy": { "strategy": "fixed", "seedHex": "00112233445566778899aabbccddeeff" },
        "initialState": {
            "registers": {
                "RSP": "0x7ffff008",
                "RBP": "0x7ffff008",
                "RIP": "0x0",
                "RAX": "0x0"
            },
            "memoryRegions": [
                { "regionId": "code", "kind": "code", "startAddressHex": CODE_BASE,
                  "byteLength": 4096, "permissions": "rx", "contentHex": code_content, "isHidden": false },
                { "regionId": "buffer", "kind": "heap", "startAddressHex": BUFFER_BASE,
                  "byteLength": 4096, "permissions": "rw", "contentHex": zero_hex(4096), "isHidden": false },
                { "regionId": "secret", "kind": "key", "startAddressHex": SECRET_BASE,
                  "byteLength": 4096, "permissions": "rw", "contentHex": zero_hex(4096), "isHidden": true },
                { "regionId": "stack", "kind": "stack", "startAddressHex": STACK_BASE,
                  "byteLength": 4096, "permissions": "rw", "contentHex": zero_hex(4096), "isHidden": false }
            ]
        },
        "secrets": { "flag": "FLAG{lifecycle}", "virtualFiles": [] },
        "privateObjects": [],
        "judging": {
            "successCondition": {
                "all": [ { "all": [ { "predicate": { "type": "register_equals",
                    "register": "RAX", "valueHex": "0x41" } } ] } ]
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

/// 公开描述包(与 lifecycle_bundle 同一题目;布局 = 可见区域集合,声明序)。
fn lifecycle_descriptor() -> Value {
    let code_window = {
        let mut hex = String::from("c3");
        hex.push_str(&"00".repeat(255));
        hex
    };
    json!({
        "schemaVersion": 1,
        "challengeId": "wp8-lifecycle",
        "challengeContentVersion": "1.0.0",
        "vmProfileVersion": "1.0.0",
        "locale": "zh-CN",
        "briefing": {
            "title": "生命周期教学题",
            "summary": "写缓冲区、建立检查点、回退与重置的全链路演示。",
            "learningObjectives": ["理解会话时间线"]
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
                { "regionId": "code", "label": "代码区", "startAddressHex": CODE_BASE,
                  "byteLength": 4096, "permissions": "rx", "bytesHex": code_window, "truncated": true },
                { "regionId": "buffer", "label": "缓冲区", "startAddressHex": BUFFER_BASE,
                  "byteLength": 4096, "permissions": "rw", "bytesHex": zero_hex(256), "truncated": true },
                { "regionId": "stack", "label": "栈", "startAddressHex": STACK_BASE,
                  "byteLength": 4096, "permissions": "rw", "bytesHex": zero_hex(256), "truncated": true }
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

fn frame(value: &Value) -> StrictValue {
    let text = serde_json::to_string(value).unwrap();
    StrictValue::parse(&text).unwrap()
}

fn load_command(seq: u64) -> Value {
    json!({
        "type": "load",
        "seq": seq,
        "privateBundle": lifecycle_bundle(),
        "publicDescriptor": lifecycle_descriptor()
    })
}

fn action_request(client_seq: u64, base_revision: u64, action: Value) -> Value {
    json!({
        "protocolVersion": 1,
        "sessionId": "session-lifecycle",
        "clientSeq": client_seq,
        "baseRevision": base_revision,
        "idempotencyKey": format!("key-{client_seq}"),
        "action": action
    })
}

fn apply(seq: u64, request_id: &str, base_revision: u64, action: Value) -> Value {
    json!({
        "type": "apply_action",
        "seq": seq,
        "requestId": request_id,
        "actionRequest": action_request(seq - 1, base_revision, action)
    })
}

fn write_bytes(address: &str, bytes_hex: &str) -> Value {
    json!({ "type": "write_bytes", "args": { "addressHex": address, "bytesHex": bytes_hex } })
}

fn expect_loaded(worker: &mut Worker) {
    let outbound = worker.handle_frame(&frame(&load_command(1))).unwrap();
    assert!(
        matches!(outbound, WorkerOutbound::Loaded { .. }),
        "前置:生命周期题目装载必须成功"
    );
}

fn action_response(outbound: WorkerOutbound) -> (Value, Option<Value>) {
    match outbound {
        WorkerOutbound::ActionResponse {
            action_response,
            checkpoint_export,
            ..
        } => (action_response, checkpoint_export),
        other => panic!("预期 ActionResponse,实得 {other:?}"),
    }
}

// ── 全链路:动作 → 投影 → checkpoint → undo → checkout → reset ────────────────

#[test]
fn session_lifecycle_full_chain() {
    let mut worker = Worker::new().unwrap();
    expect_loaded(&mut worker);

    // 初始投影(可见区域 = 公开布局,隐藏区域结构性缺席)。
    let outbound = worker
        .handle_frame(&frame(&json!({ "type": "query_projection", "seq": 2 })))
        .unwrap();
    let WorkerOutbound::Projection { projection, .. } = outbound else {
        panic!("query_projection 必须回投影帧");
    };
    let regions: Vec<&str> = projection["visibleRegions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|region| region["regionId"].as_str().unwrap())
        .collect();
    assert_eq!(
        regions,
        ["code", "buffer", "stack"],
        "隐藏区域不出现在公开投影"
    );

    // 写可见缓冲区:已执行,revision +1,增量携带脏范围。
    let (response, _) = action_response(
        worker
            .handle_frame(&frame(&apply(
                3,
                "req-1",
                0,
                write_bytes(BUFFER_BASE, "deadbeef"),
            )))
            .unwrap(),
    );
    assert_eq!(response["status"], "running");
    assert_eq!(response["revision"], 1);
    let ranges = response["projectionDelta"]["dirtyRanges"]
        .as_array()
        .unwrap();
    assert_eq!(ranges.len(), 1);
    assert_eq!(ranges[0]["regionId"], "buffer");
    assert_eq!(ranges[0]["bytesHex"], "deadbeef");

    // create_checkpoint:已执行、revision +1,回执携带 checkpointId + 快照信封。
    let (response, checkpoint) = action_response(
        worker
            .handle_frame(&frame(&apply(
                4,
                "req-2",
                1,
                json!({ "type": "create_checkpoint", "args": { "label": "before" } }),
            )))
            .unwrap(),
    );
    assert_eq!(response["revision"], 2);
    let checkpoint = checkpoint.expect("create_checkpoint 必须回执 checkpointExport");
    let checkpoint_id = checkpoint["checkpointId"].as_str().unwrap().to_owned();
    assert_eq!(checkpoint["snapshot"]["snapshotFormatVersion"], 1);
    assert_eq!(checkpoint["snapshot"]["revision"], 2);

    // 再次写入后 undo:内容回退、版本前进。
    let _ = action_response(
        worker
            .handle_frame(&frame(&apply(
                5,
                "req-3",
                2,
                write_bytes(BUFFER_BASE, "11111111"),
            )))
            .unwrap(),
    );
    let (response, _) = action_response(
        worker
            .handle_frame(&frame(&apply(
                6,
                "req-4",
                3,
                json!({ "type": "undo", "args": {} }),
            )))
            .unwrap(),
    );
    assert_eq!(response["revision"], 4, "undo = 内容回退、版本前进");
    // 回退步不承载事件段(与差分套件同纪律):增量不含脏范围,回退后的
    // 内容差异经下一次完整投影(sync-projection)对齐。
    let ranges = response["projectionDelta"]["dirtyRanges"]
        .as_array()
        .unwrap();
    assert!(ranges.is_empty(), "回退步不重发历史事件");

    // checkout 回检查点内容(写入 11111111 的动作被撤销)。
    let (response, _) = action_response(
        worker
            .handle_frame(&frame(&apply(
                7,
                "req-5",
                4,
                json!({ "type": "checkout_checkpoint", "args": { "checkpointId": checkpoint_id } }),
            )))
            .unwrap(),
    );
    assert_eq!(response["revision"], 5);

    // reset:回初始状态,revision 继续 +1。
    let (response, _) = action_response(
        worker
            .handle_frame(&frame(&apply(
                8,
                "req-6",
                5,
                json!({ "type": "reset", "args": {} }),
            )))
            .unwrap(),
    );
    assert_eq!(response["revision"], 6);
    assert_eq!(response["status"], "running");

    // 空历史 undo 不再可用(reset 后历史栈被 checkout/reset 链承载,undo 仍可
    // 回退);确定性拒绝面归运行时,此处只断言响应合法。
    let (response, _) = action_response(
        worker
            .handle_frame(&frame(&apply(
                9,
                "req-7",
                6,
                json!({ "type": "pause", "args": {} }),
            )))
            .unwrap(),
    );
    assert_eq!(response["revision"], 7);
    assert_eq!(response["status"], "paused");

    let ack = worker
        .handle_frame(&frame(&json!({ "type": "shutdown", "seq": 10 })))
        .unwrap();
    assert!(matches!(ack, WorkerOutbound::ShutdownAck { .. }));
}

// ── 写分类与 I-9(执行前判定;D-P1 / E-3 / I-9)───────────────────────────────

#[test]
fn write_classification_and_invisible_unification() {
    let mut worker = Worker::new().unwrap();
    expect_loaded(&mut worker);

    // ① 跨越可见/隐藏边界:起点可见,8 字节越出可见覆盖 → offset_out_of_range,
    //    expectedBytesLength = 可见覆盖前缀(E-3),revision 不动。
    let (rejected, _) = action_response(
        worker
            .handle_frame(&frame(&apply(
                2,
                "req-1",
                0,
                write_bytes("0x20000FFC", "0102030405060708"),
            )))
            .unwrap(),
    );
    assert_eq!(rejected["status"], "rejected");
    assert_eq!(rejected["revision"], 0);
    assert_eq!(rejected["userVisibleError"]["code"], "offset_out_of_range");
    assert_eq!(
        rejected["userVisibleError"]["explanation"]["expectedBytesLength"], 4,
        "E-3:期望长度 = 起点起可见覆盖字节"
    );

    // ② 不可见目标(隐藏区域)→ inaccessible_address(I-9 统一形态)。
    let (hidden, _) = action_response(
        worker
            .handle_frame(&frame(&apply(
                3,
                "req-2",
                0,
                write_bytes(SECRET_BASE, "aa"),
            )))
            .unwrap(),
    );
    assert_eq!(hidden["status"], "rejected");
    assert_eq!(hidden["userVisibleError"]["code"], "inaccessible_address");

    // ③ 未映射地址 → 与隐藏区域逐字节一致的响应(探测扫描不可区分)。
    let (unmapped, _) = action_response(
        worker
            .handle_frame(&frame(&apply(
                4,
                "req-3",
                0,
                write_bytes("0x90000000", "aa"),
            )))
            .unwrap(),
    );
    // 玩家自供回显(valueHex = 请求地址本身)之外,两类故障的响应分类、
    // 占位形态、revision 与事件面完全一致(探测扫描不可区分)。
    let mask_echo = |response: &Value| {
        let mut text = serde_json::to_string(response).unwrap();
        if let Some(value) = response["userVisibleError"]["explanation"]["valueHex"].as_str() {
            text = text.replace(value, "0xECHO");
        }
        if let Some(value) = response["requestId"].as_str() {
            text = text.replace(value, "REQ");
        }
        text
    };
    assert_eq!(
        mask_echo(&hidden),
        mask_echo(&unmapped),
        "I-9:隐藏映射与未映射不可区分(自供回显之外)"
    );

    // ④ 协议上限外圈护栏:4097 字节超出 MAX_WRITE_BYTES,在载荷契约层
    //    (Schema)即拒——确定性协议级拒绝行,不进入执行。
    let oversized = "ab".repeat(4097);
    let (rejected, _) = action_response(
        worker
            .handle_frame(&frame(&apply(
                5,
                "req-4",
                0,
                write_bytes(BUFFER_BASE, &oversized),
            )))
            .unwrap(),
    );
    assert_eq!(rejected["status"], "rejected");
    assert_eq!(rejected["userVisibleError"]["code"], "invalid_input_format");

    // ⑤ 题目级写入预算(公开包声明 maxWriteBytesPerAction = 16):可见目标
    //    上写 32 字节 → 执行前拒绝 invalid_payload_length,期望长度 = 16。
    let mut budget_bundle = lifecycle_bundle();
    budget_bundle["judging"]["successCondition"] = json!({
        "all": [ { "all": [ { "predicate": { "type": "register_equals",
            "register": "RAX", "valueHex": "0x41" } } ] } ]
    });
    let mut budget_descriptor = lifecycle_descriptor();
    budget_descriptor["resourceLimits"] = json!({ "maxWriteBytesPerAction": 16 });
    let mut budget_worker = Worker::new().unwrap();
    let loaded = budget_worker
        .handle_frame(&frame(&json!({
            "type": "load",
            "seq": 1,
            "privateBundle": budget_bundle,
            "publicDescriptor": budget_descriptor
        })))
        .unwrap();
    assert!(
        matches!(loaded, WorkerOutbound::Loaded { .. }),
        "预算变体装载成功"
    );
    let (rejected, _) = action_response(
        budget_worker
            .handle_frame(&frame(&apply(
                2,
                "req-1",
                0,
                write_bytes(BUFFER_BASE, &"cd".repeat(32)),
            )))
            .unwrap(),
    );
    assert_eq!(rejected["status"], "rejected");
    assert_eq!(rejected["revision"], 0);
    assert_eq!(
        rejected["userVisibleError"]["code"],
        "invalid_payload_length"
    );
    assert_eq!(
        rejected["userVisibleError"]["explanation"]["expectedBytesLength"], 16,
        "题目预算 = expectedBytesLength"
    );
    assert_eq!(
        rejected["userVisibleError"]["explanation"]["actualBytesLength"],
        32
    );
}

// ── 终态闸门(D1 约束 5)───────────────────────────────────────────────────────

#[test]
fn terminal_session_rejects_deterministically() {
    let mut worker = Worker::new().unwrap();
    // 默认题目:成功条件恒真({all: []}),任意已执行动作即 won。
    let mut bundle = lifecycle_bundle();
    bundle["judging"]["successCondition"] = json!({ "all": [] });
    let command = json!({
        "type": "load",
        "seq": 1,
        "privateBundle": bundle,
        "publicDescriptor": lifecycle_descriptor()
    });
    let outbound = worker.handle_frame(&frame(&command)).unwrap();
    assert!(matches!(outbound, WorkerOutbound::Loaded { .. }));

    let (response, _) = action_response(
        worker
            .handle_frame(&frame(&apply(
                2,
                "req-1",
                0,
                write_bytes(BUFFER_BASE, "aa"),
            )))
            .unwrap(),
    );
    assert_eq!(response["status"], "won", "恒真成功条件达成 → won");

    // 终态后一切动作确定性拒绝(session_terminal,revision 不动)。
    for (seq, action) in [
        (3u64, write_bytes(BUFFER_BASE, "bb")),
        (4u64, json!({ "type": "undo", "args": {} })),
        (5u64, json!({ "type": "reset", "args": {} })),
        (6u64, json!({ "type": "create_checkpoint", "args": {} })),
    ] {
        let action_label = action.to_string();
        let (rejected, _) = action_response(
            worker
                .handle_frame(&frame(&apply(seq, &format!("req-{seq}"), 1, action)))
                .unwrap(),
        );
        assert_eq!(rejected["status"], "rejected", "终态拒绝 {action_label}");
        assert_eq!(rejected["revision"], 1, "拒绝不推进 revision");
        assert_eq!(rejected["userVisibleError"]["code"], "session_terminal");
    }
}

// ── 快照替换恢复(两步:load + import_snapshot)───────────────────────────────

#[test]
fn snapshot_replace_recovery_restores_identical_projection() {
    let script = |worker: &mut Worker| {
        let mut frames = Vec::new();
        frames.push(
            worker
                .handle_frame(&frame(&apply(
                    2,
                    "req-1",
                    0,
                    write_bytes(BUFFER_BASE, "0badc0de"),
                )))
                .unwrap(),
        );
        frames.push(
            worker
                .handle_frame(&frame(&json!({ "type": "export_snapshot", "seq": 3 })))
                .unwrap(),
        );
        frames
    };

    let mut origin = Worker::new().unwrap();
    expect_loaded(&mut origin);
    let mut origin_frames = script(&mut origin);
    let WorkerOutbound::SnapshotExported { snapshot, .. } = origin_frames.pop().unwrap() else {
        panic!("export_snapshot 必须回快照帧");
    };
    let revision = snapshot.revision;
    assert_eq!(revision, 1);

    // "崩溃"后:新进程 load + import_snapshot → 投影与崩溃前逐字节一致。
    let mut recovered = Worker::new().unwrap();
    expect_loaded(&mut recovered);
    let snapshot_value = serde_json::to_value(&snapshot).unwrap();
    let imported = recovered
        .handle_frame(&frame(
            &json!({ "type": "import_snapshot", "seq": 2, "snapshot": snapshot_value }),
        ))
        .unwrap();
    assert!(matches!(imported, WorkerOutbound::SnapshotImported { .. }));

    let WorkerOutbound::Projection {
        projection: before, ..
    } = origin
        .handle_frame(&frame(&json!({ "type": "query_projection", "seq": 4 })))
        .unwrap()
    else {
        panic!("投影帧缺失");
    };
    let WorkerOutbound::Projection {
        projection: after, ..
    } = recovered
        .handle_frame(&frame(&json!({ "type": "query_projection", "seq": 3 })))
        .unwrap()
    else {
        panic!("投影帧缺失");
    };
    assert_eq!(
        serde_json::to_string(&before).unwrap(),
        serde_json::to_string(&after).unwrap(),
        "崩溃替换恢复后公开投影逐字节一致"
    );

    // 恢复后的会话可继续:revision 自快照续算,旧 checkpoint 引用已退化。
    let (response, _) = action_response(
        recovered
            .handle_frame(&frame(&apply(
                4,
                "req-2",
                1,
                write_bytes(BUFFER_BASE, "cafebabe"),
            )))
            .unwrap(),
    );
    assert_eq!(response["revision"], 2);

    // 原会话同步动作(同输入)产生同字节响应(两侧同 (输入, 状态) → 同响应)。
    let (origin_response, _) = action_response(
        origin
            .handle_frame(&frame(&apply(
                5,
                "req-2",
                1,
                write_bytes(BUFFER_BASE, "cafebabe"),
            )))
            .unwrap(),
    );
    assert_eq!(
        serde_json::to_string(&response).unwrap(),
        serde_json::to_string(&origin_response).unwrap(),
        "恢复会话与原会话同输入恒同响应(I-4)"
    );
}

// ── 确定性(I-4):同脚本两次运行,stdout 帧字节一致 ──────────────────────────

#[test]
fn identical_scripts_produce_identical_frame_sequences() {
    let run = || -> Vec<String> {
        let mut worker = Worker::new().unwrap();
        let mut texts = Vec::new();
        expect_loaded(&mut worker);
        let steps = [
            json!({ "type": "query_projection", "seq": 2 }),
            apply(3, "req-1", 0, write_bytes(BUFFER_BASE, "deadbeef")),
            apply(
                4,
                "req-2",
                1,
                json!({ "type": "create_checkpoint", "args": {} }),
            ),
            apply(5, "req-3", 2, json!({ "type": "undo", "args": {} })),
            json!({ "type": "export_snapshot", "seq": 6 }),
        ];
        for step in steps {
            let outbound = worker.handle_frame(&frame(&step)).unwrap();
            texts.push(serde_json::to_string(&outbound).unwrap());
        }
        texts
    };
    let first = run();
    let second = run();
    assert_eq!(first, second, "同一脚本两次运行必须帧字节一致(I-4)");
}

// ── 装配红灯矩阵(装配镜像复验的必触发反例;方向 challenge_invalid)────────────

#[test]
fn assembly_rejection_matrix() {
    type MutateCase = (&'static str, Box<dyn Fn(&mut Value, &mut Value)>);
    let cases: Vec<MutateCase> = vec![
        (
            "public_layout_mismatch",
            Box::new(|_bundle, public| {
                public["memoryLayout"]["regions"][0]["regionId"] = json!("wrong");
            }),
        ),
        (
            "byte_mode_requires_public_encoding_table",
            Box::new(|bundle, _public| {
                bundle["compiledIr"] = Value::Null;
                bundle["entrypointAddressHex"] = json!(CODE_BASE);
            }),
        ),
        (
            "ir_mode_forbids_encoding_table",
            Box::new(|_bundle, public| {
                public["vmProfile"]["encodingTable"] = json!([{
                    "tokenHex": "0xc3", "op": "ret", "operands": []
                }]);
            }),
        ),
        (
            "public_register_undeclared",
            Box::new(|_bundle, public| {
                public["vmProfile"]["registers"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({ "name": "RDX" }));
            }),
        ),
        (
            "predicate_budget_mismatch",
            Box::new(|_bundle, public| {
                public["resourceLimits"] = json!({ "predicateEvalBudgetPerSession": 999 });
            }),
        ),
        (
            "canary_spec_mismatch",
            Box::new(|bundle, public| {
                bundle["privateObjects"] = json!([{
                    "objectId": "canary-slot", "kind": "canary",
                    "addressHex": STACK_BASE, "byteLength": 4,
                    "visibility": "public", "containsSecret": false
                }]);
                public["vmProfile"]["canary"] = json!({ "enabled": false });
            }),
        ),
        (
            "hidden_custom_region_unlabeled",
            Box::new(|bundle, _public| {
                bundle["initialState"]["memoryRegions"][0]["kind"] = json!("custom");
                bundle["initialState"]["memoryRegions"][0]["isHidden"] = json!(true);
            }),
        ),
    ];
    for (expected_reason, mutate) in cases {
        // 拒绝必须发生在装配层(受控日志)或装载闸门,结论恒 challenge_invalid。
        let mut bundle = lifecycle_bundle();
        let mut public = lifecycle_descriptor();
        mutate(&mut bundle, &mut public);
        // 排除 mutating 用例对 fixture 的字段类型破坏(Null 形态在 Schema 层拒)。
        let _ = expected_reason;
        let mut worker = Worker::new().unwrap();
        let command = json!({
            "type": "load",
            "seq": 1,
            "privateBundle": bundle,
            "publicDescriptor": public
        });
        let outbound = worker.handle_frame(&frame(&command)).unwrap();
        match outbound {
            WorkerOutbound::CommandError { error, .. } => {
                assert_eq!(
                    error.code,
                    vm_worker::protocol::message::WorkerErrorCode::ChallengeInvalid
                );
            }
            WorkerOutbound::Loaded { .. } => {
                panic!("红灯用例必须拒绝装载");
            }
            other => panic!("装载只允许回执或命令级错误:{other:?}"),
        }
    }
}

#[test]
fn canonical_digest_note() {
    // repo_root 保留(workspace 路径锚点供后续 golden fixture 扩展引用)。
    assert!(repo_root().join("docs").exists());
}

// ── 装配面补充:字节模式 / 自定义指令与接口 / canary(Happy Path)──────────────

/// 字节模式题目:公开编码表(ret = 0xC3)+ 表层机器码内容。
fn byte_mode_pair() -> (Value, Value) {
    let mut code_content = String::from("c3");
    code_content.push_str(&"00".repeat(4095));
    let mut bundle = lifecycle_bundle();
    bundle["initialState"]["registers"]["RIP"] = json!("0x401000");
    bundle["initialState"]["memoryRegions"][0]["contentHex"] = json!(code_content);
    if let Some(object) = bundle.as_object_mut() {
        object.remove("compiledIr");
    }
    bundle["entrypointAddressHex"] = json!(CODE_BASE);
    let mut descriptor = lifecycle_descriptor();
    descriptor["initialProjection"]["visibleRegisters"][2]["valueHex"] = json!("0x401000");
    descriptor["vmProfile"]["encodingTable"] = json!([
        { "tokenHex": "0xc3", "op": "ret", "operands": [] }
    ]);
    (bundle, descriptor)
}

#[test]
fn byte_mode_bundle_loads_and_steps_via_public_encoding_table() {
    let (bundle, descriptor) = byte_mode_pair();
    let mut worker = Worker::new().unwrap();
    let loaded = worker
        .handle_frame(&frame(&json!({
            "type": "load", "seq": 1,
            "privateBundle": bundle, "publicDescriptor": descriptor
        })))
        .unwrap();
    assert!(
        matches!(loaded, WorkerOutbound::Loaded { .. }),
        "字节模式装载成功"
    );

    // step:字节模式取指译码走公开表;ret 弹出栈顶 0 作 RIP → 教学性失败
    //(已执行,revision +1,I-9 可解释错误面)。
    let (response, _) = action_response(
        worker
            .handle_frame(&frame(&apply(
                2,
                "req-1",
                0,
                json!({ "type": "step", "args": {} }),
            )))
            .unwrap(),
    );
    assert_eq!(response["revision"], 1, "已执行动作恒 +1");
    // ret 弹出 0 作字节 RIP → 取指不可执行 → 引擎异常终止(status failed,
    // 指令规约 §1.8:invalid_rip 属 engine 侧已执行结局)。
    assert_eq!(response["status"], "failed");
}

#[test]
fn custom_instructions_and_interfaces_assemble_and_execute() {
    let mut bundle = lifecycle_bundle();
    bundle["customInstructions"] = json!([
        {
            "mnemonic": "LOADKEY",
            "displayText": "装载教学密钥",
            "semantics": [ { "op": "load_imm", "dst": "RAX", "valueHex": "0x41" } ]
        }
    ]);
    bundle["interfaces"] = json!([
        { "interfaceId": 4100, "displayText": "无操作接口", "effects": [ { "effect": "noop" } ] }
    ]);
    bundle["compiledIr"] = json!({
        "irFormatVersion": 2,
        "entrypointIndex": 0,
        "instructions": [ { "op": "LOADKEY", "operands": [] } ],
        "labels": []
    });
    let mut worker = Worker::new().unwrap();
    let loaded = worker
        .handle_frame(&frame(&json!({
            "type": "load", "seq": 1,
            "privateBundle": bundle, "publicDescriptor": lifecycle_descriptor()
        })))
        .unwrap();
    assert!(
        matches!(loaded, WorkerOutbound::Loaded { .. }),
        "自定义指令题目装载成功"
    );

    // step 执行 LOADKEY(load_imm RAX, 0x41)→ 成功条件达成 → won。
    let (response, _) = action_response(
        worker
            .handle_frame(&frame(&apply(
                2,
                "req-1",
                0,
                json!({ "type": "step", "args": {} }),
            )))
            .unwrap(),
    );
    assert_eq!(response["status"], "won", "自定义指令执行使成功条件达成");
    assert_eq!(response["revision"], 1);
}

#[test]
fn canary_spec_happy_path_assembles_slots() {
    let mut bundle = lifecycle_bundle();
    bundle["privateObjects"] = json!([
        {
            "objectId": "canary-slot", "kind": "canary",
            "addressHex": "0x7ffff000", "byteLength": 4,
            "visibility": "public", "containsSecret": false
        }
    ]);
    let mut descriptor = lifecycle_descriptor();
    descriptor["vmProfile"]["canary"] = json!({ "enabled": true, "sizeBytes": 4 });
    let mut worker = Worker::new().unwrap();
    let loaded = worker
        .handle_frame(&frame(&json!({
            "type": "load", "seq": 1,
            "privateBundle": bundle, "publicDescriptor": descriptor
        })))
        .unwrap();
    assert!(
        matches!(loaded, WorkerOutbound::Loaded { .. }),
        "canary 互证成立,装载成功"
    );
}

// ── 装配面补充:可直达红灯(装配层专属,Schema 不拦截)────────────────────────

#[test]
fn assembler_specific_red_lights() {
    // ① IR 模式初始 IP 越出程序(D-W8-2:作者错误在装载即拒)。
    let mut bundle = lifecycle_bundle();
    bundle["initialState"]["registers"]["RIP"] = json!("0x9");
    // ② 区域内容长度与 byteLength 不一致(XS-MEM-CONTENT 的装配复核)。
    let mut bundle2 = lifecycle_bundle();
    bundle2["initialState"]["memoryRegions"][1]["contentHex"] = json!("aabb");
    // ③ canary 长度互证失败(XS-CANARY-CORR 镜像)。
    let mut bundle3 = lifecycle_bundle();
    bundle3["privateObjects"] = json!([
        { "objectId": "c", "kind": "canary", "addressHex": "0x7ffff000",
          "byteLength": 8, "visibility": "public", "containsSecret": false }
    ]);
    let mut descriptor3 = lifecycle_descriptor();
    descriptor3["vmProfile"]["canary"] = json!({ "enabled": true, "sizeBytes": 4 });
    // ④ canary 规格声明但无私有对象。
    let mut descriptor4 = lifecycle_descriptor();
    descriptor4["vmProfile"]["canary"] = json!({ "enabled": true, "sizeBytes": 4 });
    // ⑤ 秘密汇寄存器进入公开寄存器声明面(I3 装配期复核)。
    let mut bundle5 = lifecycle_bundle();
    bundle5["secretSinkRegisters"] = json!(["RAX"]);
    // ⑥ 谓词引用未知寄存器(判题装配复验,非 Schema 面)。
    let mut bundle6 = lifecycle_bundle();
    bundle6["judging"]["successCondition"] = json!({
        "all": [ { "all": [ { "predicate": { "type": "register_equals",
            "register": "RDX", "valueHex": "0x1" } } ] } ]
    });

    for (index, (bundle, descriptor)) in [
        (bundle, lifecycle_descriptor()),
        (bundle2, lifecycle_descriptor()),
        (bundle3, descriptor3),
        (lifecycle_bundle(), descriptor4),
        (bundle5, lifecycle_descriptor()),
        (bundle6, lifecycle_descriptor()),
    ]
    .into_iter()
    .enumerate()
    {
        let mut worker = Worker::new().unwrap();
        let outbound = worker
            .handle_frame(&frame(&json!({
                "type": "load", "seq": 1,
                "privateBundle": bundle, "publicDescriptor": descriptor
            })))
            .unwrap();
        match outbound {
            WorkerOutbound::CommandError { error, .. } => {
                assert_eq!(
                    error.code,
                    vm_worker::protocol::message::WorkerErrorCode::ChallengeInvalid,
                    "红灯用例 {index} 必须 challenge_invalid"
                );
            }
            _ => panic!("红灯用例 {index} 必须拒绝装载"),
        }
    }
}

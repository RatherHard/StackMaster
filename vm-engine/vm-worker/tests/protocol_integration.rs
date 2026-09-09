//! 进程级集成测试:spawn 真实 vm-worker 二进制,验证 ready 自报、shutdown
//! 优雅退出、stdout 纯净性(每行皆协议帧)与协议层违规 fail-closed(§八)。

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

struct WorkerProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Arc<Mutex<BufReader<ChildStdout>>>,
}

impl WorkerProcess {
    fn spawn() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_vm-worker"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("vm-worker 二进制必须可 spawn");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        Self {
            child,
            stdin: Some(stdin),
            stdout: Arc::new(Mutex::new(BufReader::new(stdout))),
        }
    }

    /// 读一帧(stdout 纯净性由"逐行读取且可解析"直接断言)。
    fn read_frame(&self) -> Value {
        let mut reader = self.stdout.lock().unwrap();
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .expect("worker stdout 必须可读且非空");
        serde_json::from_str(&line).expect("stdout 每一行都必须是协议帧(stdout 纯净性)")
    }

    fn send_line(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().expect("stdin 尚未关闭");
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .expect("写命令帧失败");
    }

    fn close_stdin(mut self) -> std::process::ExitStatus {
        drop(self.stdin.take());
        self.child.wait().expect("worker 进程必须可回收")
    }
}

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn worker_self_reports_version_then_shuts_down_cleanly() {
    let mut worker = WorkerProcess::spawn();
    let ready = worker.read_frame();
    assert_eq!(ready["type"], "ready", "worker 启动必须先自报版本");
    assert_eq!(ready["protocolVersion"], 1);
    assert_eq!(ready["vmEngineVersion"], env!("CARGO_PKG_VERSION"));
    assert!(ready["engineBuildId"].is_string());

    worker.send_line(r#"{"type":"shutdown","seq":1}"#);
    let ack = worker.read_frame();
    assert_eq!(ack["type"], "shutdown_ack");
    assert_eq!(ack["seq"], 1);

    let status = worker.close_stdin();
    assert!(status.success(), "优雅关闭必须以退出码 0 结束");
}

#[test]
fn clean_eof_without_shutdown_is_also_graceful() {
    let worker = WorkerProcess::spawn();
    let _ready = worker.read_frame();
    let status = worker.close_stdin();
    assert!(status.success(), "EOF 且无半包 = 干净关闭(退出码 0)");
}

#[test]
fn malformed_frame_fails_closed_with_protocol_error_frame() {
    let mut worker = WorkerProcess::spawn();
    let _ready = worker.read_frame();
    worker.send_line("not a json frame at all");
    let protocol_error = worker.read_frame();
    assert_eq!(protocol_error["type"], "protocol_error");
    assert_eq!(protocol_error["code"], "malformed_json");
    let status = worker.close_stdin();
    assert!(!status.success(), "协议层违规必须以非零码终止(进程不复用)");
}

#[test]
fn half_frame_at_eof_fails_closed() {
    let mut worker = WorkerProcess::spawn();
    let _ready = worker.read_frame();
    // 半包:写入无行界的残缺帧后关闭 stdin——worker 只能在 EOF 时判定半包,
    // 因此必须先关写侧再读协议错误帧。
    {
        let stdin = worker.stdin.as_mut().expect("stdin 尚未关闭");
        stdin.write_all(br#"{"type":"shutdown","seq":1""#).unwrap();
        stdin.flush().unwrap();
    }
    drop(worker.stdin.take());
    let protocol_error = worker.read_frame();
    assert_eq!(protocol_error["type"], "protocol_error");
    assert_eq!(protocol_error["code"], "truncated_frame");
    let status = worker.child.wait().expect("worker 进程必须可回收");
    assert!(!status.success(), "半包帧必须 fail-closed(非零退出)");
}

#[test]
fn duplicate_key_frame_fails_closed_with_protocol_error_frame() {
    let mut worker = WorkerProcess::spawn();
    let _ready = worker.read_frame();
    worker.send_line(r#"{"type":"shutdown","type":"shutdown","seq":1}"#);
    let protocol_error = worker.read_frame();
    assert_eq!(protocol_error["type"], "protocol_error");
    assert_eq!(protocol_error["code"], "duplicate_key");
    assert!(!worker.close_stdin().success());
}

#[test]
fn oversized_frame_fails_closed() {
    // 超限帧(上限 + 1 字节,无行界):worker 到达上限即拒绝;写侧随后可能
    // 遇到对端退出导致的管道断裂,写失败属预期(忽略)。
    let mut worker = WorkerProcess::spawn();
    let _ready = worker.read_frame();
    let payload = vec![b'1'; 16 * 1024 * 1024 + 1];
    {
        let stdin = worker.stdin.as_mut().expect("stdin 尚未关闭");
        let _ = stdin.write_all(&payload);
        let _ = stdin.flush();
    }
    let protocol_error = worker.read_frame();
    assert_eq!(protocol_error["type"], "protocol_error");
    assert_eq!(protocol_error["code"], "frame_too_large");
    assert!(!worker.close_stdin().success());
}

#[test]
fn load_then_apply_action_round_trip_through_process_boundary() {
    // 进程级最小闭环:ready → load(合法包)→ apply_action(非法载荷 →
    // rejected)→ shutdown。装载面与拒绝面走真实进程边界。
    let mut worker = WorkerProcess::spawn();
    let _ready = worker.read_frame();
    worker.send_line(
        r#"{"type":"load","seq":1,"privateBundle":{"schemaVersion":1},"publicDescriptor":{"schemaVersion":1}}"#,
    );
    let load_error = worker.read_frame();
    assert_eq!(load_error["type"], "command_error");
    assert_eq!(load_error["error"]["code"], "challenge_invalid");
    worker.send_line(r#"{"type":"shutdown","seq":2}"#);
    assert_eq!(worker.read_frame()["type"], "shutdown_ack");
    assert!(worker.close_stdin().success());
}

#[test]
fn watchdog_kills_worker_on_action_deadline() {
    // 进程层超时资源面(D-W8-4):timeoutMsPerAction = 50ms,动作是
    // 永不命中的 run_to_event(死循环程序)→ 看门狗夺回控制权,进程以
    // 专用退出码 3 终止、不产出响应帧;恢复由编排器走崩溃替换路径。
    let code_content = "00".repeat(4096);
    let bundle = json!({
        "schemaVersion": 1,
        "challengeId": "wp8-watchdog",
        "challengeContentVersion": "1.0.0",
        "vmProfileVersion": "1.0.0",
        "dslSchemaVersion": 2,
        "vmEngineVersion": env!("CARGO_PKG_VERSION"),
        "declaredSeedPublicPaths": [],
        "seedPolicy": { "strategy": "fixed", "seedHex": "00112233445566778899aabbccddeeff" },
        "initialState": {
            "registers": { "RSP": "0x7ffff008", "RBP": "0x7ffff008", "RIP": "0x0", "RAX": "0x0" },
            "memoryRegions": [
                { "regionId": "code", "kind": "code", "startAddressHex": "0x401000",
                  "byteLength": 4096, "permissions": "rx", "contentHex": code_content, "isHidden": false }
            ]
        },
        "secrets": { "flag": "FLAG{watchdog}", "virtualFiles": [] },
        "privateObjects": [],
        "judging": { "successCondition": { "all": [] } },
        "compiledIr": {
            "irFormatVersion": 2,
            "entrypointIndex": 0,
            "instructions": [
                { "op": "mov", "operands": [ { "kind": "register", "name": "RAX" }, { "kind": "register", "name": "RAX" } ] },
                { "op": "jmp", "operands": [ { "kind": "immediate", "valueHex": "0x0" } ] }
            ],
            "labels": []
        },
        "judgingConfig": { "verdictRuleVersion": "1.0.0", "maxPredicateEvalSteps": 10000, "timeoutMsPerAction": 50 }
    });
    let descriptor = json!({
        "schemaVersion": 1,
        "challengeId": "wp8-watchdog",
        "challengeContentVersion": "1.0.0",
        "vmProfileVersion": "1.0.0",
        "locale": "zh-CN",
        "briefing": { "title": "看门狗", "summary": "超时资源面验证。", "learningObjectives": ["超时"] },
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
                { "regionId": "code", "kind": "code", "startAddressHex": "0x401000",
                  "byteLength": 4096, "permissions": "rx", "publicLabel": "代码区" }
            ]
        },
        "allowedActions": ["step", "run_to_event"],
        "resourceLimits": {},
        "hintLadder": [],
        "publicErrorMapping": [],
        "initialProjection": {
            "visibleRegions": [
                { "regionId": "code", "label": "代码区", "startAddressHex": "0x401000",
                  "byteLength": 4096, "permissions": "rx", "bytesHex": "00".repeat(256), "truncated": true }
            ],
            "visibleRegisters": [
                { "name": "RSP", "valueHex": "0x7FFFF008" },
                { "name": "RBP", "valueHex": "0x7FFFF008" },
                { "name": "RIP", "valueHex": "0x0" },
                { "name": "RAX", "valueHex": "0x0" }
            ]
        }
    });
    let action_request = json!({
        "protocolVersion": 1,
        "sessionId": "s",
        "clientSeq": 1,
        "baseRevision": 0,
        "idempotencyKey": "k1",
        "action": { "type": "run_to_event", "args": { "pauseOn": "write" } }
    });
    let load = json!({
        "type": "load",
        "seq": 1,
        "privateBundle": bundle,
        "publicDescriptor": descriptor
    });

    let mut worker = WorkerProcess::spawn();
    let _ready = worker.read_frame();
    worker.send_line(&serde_json::to_string(&load).unwrap());
    let loaded = worker.read_frame();
    assert_eq!(loaded["type"], "loaded", "看门狗题目装载必须成功:{loaded}");

    worker.send_line(
        &serde_json::to_string(&json!({
            "type": "apply_action",
            "seq": 2,
            "requestId": "req-1",
            "actionRequest": action_request
        }))
        .unwrap(),
    );
    // 看门狗触发后进程退出且不再产出任何帧(EOF;不等待响应)。
    use std::io::Read as _;
    let mut stdout = Vec::new();
    let mut guard = worker.stdout.lock().unwrap();
    let _ = guard.read_to_end(&mut stdout);
    drop(guard);
    assert!(
        stdout.is_empty(),
        "超时路径不得写出响应帧:{:?}",
        String::from_utf8_lossy(&stdout)
    );
    let status = worker.child.wait().expect("worker 进程必须可回收");
    assert_eq!(status.code(), Some(3), "看门狗超时必须以专用退出码 3 终止");
    let _ = worker.close_stdin();
}

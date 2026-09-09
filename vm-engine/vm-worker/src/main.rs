//! `vm-worker` 二进制:单会话进程入口(信任域 3,ADR-7)。
//!
//! 进程边界形态:TS 编排器 spawn 本进程,经 stdio NDJSON 帧协议通信(ADR-3;
//! 禁止 FFI / N-API 内嵌)。协议语义、帧格式与 `ENGINE_PROCESS_PROTOCOL_VERSION`
//! 在 WP-1 冻结:docs/develop/引擎进程协议.md;会话装配与托管语义见
//! docs/develop/会话编排语义规约.md(WP-8)。实现见 `vm_worker::{protocol,
//! contract, session}`。
//!
//! 职责边界:本 crate 是引擎四 crate 中唯一允许 std 的 crate——时钟、随机源
//! 与 stdio 由本进程层实现并注入引擎 crate(引擎三 crate 无 std::time / rand /
//! std::io);`VmState`、私有题目包、隐藏测试与 seed 只存在于本进程内(秘密零驻留)。
//! stdout 只写协议帧,stderr 只写受控日志(无载荷内容,§三错误通道纪律)。
//!
//! # 进程层资源面(WP-8;9.1 Worker 资源清单)
//!
//! - wall-clock 看门狗:`apply_action` 前武装(`timeoutMsPerAction` / 装配
//!   默认),预算耗尽 = 受控日志 + 退出码 3(引擎 crate 无时钟,超时由本层
//!   执行,D-W8-4);
//! - 引擎 panic(溢出安全终止,ENG-3)经 `catch_unwind` 归入引擎故障路径:
//!   受控日志 + 退出码 1——引擎 crate 的 panic 只可能是缺陷,绝不静默回绕;
//! - 协议层违规:fail-closed(§3.5),退出码 1;进程一律不复用,恢复由编排器
//!   走快照替换路径。
#![forbid(unsafe_code)]

use std::io::{self, BufReader};
use std::panic::AssertUnwindSafe;
use std::process::ExitCode;

use vm_worker::protocol::frame::{FrameError, FrameReader, FrameWriter};
use vm_worker::protocol::message::WorkerOutbound;
use vm_worker::protocol::worker::{FrameErrorKind, ProtocolViolation, Worker};
use vm_worker::session::watchdog::Watchdog;

/// 看门狗超时的专用退出码(§六退出码表;编排器据此与协议违规区分处置)。
const WATCHDOG_EXIT_CODE: u8 = 3;

fn main() -> ExitCode {
    run()
}

fn run() -> ExitCode {
    let mut writer = FrameWriter::new(io::stdout().lock());
    let mut reader = FrameReader::new(BufReader::new(io::stdin().lock()));
    let mut worker = match Worker::new() {
        Ok(worker) => worker,
        // Schema 编译失败属构建期缺陷:受控日志 + 非零退出,不进入命令循环。
        Err(_) => {
            log("startup_failed schema_compile");
            return ExitCode::from(1);
        }
    };
    worker.set_watchdog(Watchdog::spawn(|| {
        // 看门狗线程回调:引擎执行超限,进程状态不再可信——直接终止(不写
        // stdout,避免与主线程帧写出交错);恢复由编排器走崩溃替换路径。
        log("watchdog timeout action_deadline_exceeded");
        std::process::exit(WATCHDOG_EXIT_CODE as i32);
    }));

    if writer.write_frame(&Worker::ready_frame()).is_err() {
        log("startup_failed ready_frame_write");
        return ExitCode::from(1);
    }
    log("ready");

    loop {
        match reader.read_frame() {
            Ok(Some(frame)) => {
                // 引擎 panic(溢出等,ENG-3)= 引擎缺陷:安全终止,不静默回绕。
                let handled =
                    std::panic::catch_unwind(AssertUnwindSafe(|| worker.handle_frame(&frame)));
                let outcome = match handled {
                    Ok(outcome) => outcome,
                    Err(_) => {
                        log("engine_panic engine_error");
                        return ExitCode::from(1);
                    }
                };
                match outcome {
                    Ok(outbound) => {
                        let shutdown = matches!(outbound, WorkerOutbound::ShutdownAck { .. });
                        if writer.write_frame(&outbound).is_err() {
                            log("io_error response_write");
                            return ExitCode::from(1);
                        }
                        // 托管故障(D-W8-5):响应已尽力写出,进程安全终止。
                        if let Some(reason) = worker.take_terminal() {
                            log(&format!("session_fault reason={reason}"));
                            return ExitCode::from(1);
                        }
                        if shutdown {
                            log("shutdown");
                            return ExitCode::SUCCESS;
                        }
                    }
                    Err(violation) => return terminate(&mut writer, &violation),
                }
            }
            // EOF 且无半包:对端干净关闭,等价优雅退出。
            Ok(None) => {
                log("eof");
                return ExitCode::SUCCESS;
            }
            Err(error) => match &error {
                FrameError::Io(_) => return terminate_io(),
                _ => {
                    return terminate(
                        &mut writer,
                        &ProtocolViolation::Frame(FrameErrorKind::from(error)),
                    );
                }
            },
        }
    }
}

/// 读侧 IO 错误(管道断裂等):帧同步不可信,直接终止(协议错误帧通常
/// 也写不出,不尝试)。
fn terminate_io() -> ExitCode {
    log("io_error frame_read");
    ExitCode::from(1)
}

/// 协议层违规处置(§六,fail-closed):尽力而为输出 `protocol_error` 帧 →
/// 受控日志 → 非零退出;进程不复用,恢复归编排器(崩溃替换路径,WP-8)。
fn terminate(
    writer: &mut FrameWriter<io::StdoutLock<'_>>,
    violation: &ProtocolViolation,
) -> ExitCode {
    let _ = writer.write_frame(&WorkerOutbound::ProtocolError {
        code: violation.code(),
        seq: violation.seq(),
    });
    log(&format!("protocol_violation code={}", violation.code()));
    ExitCode::from(1)
}

/// 受控日志(stderr):仅事件与错误码,禁止载荷内容、VmState、私有包、
/// seed 与隐藏判题信息(§三错误通道纪律;秘密零驻留)。
fn log(event: &str) {
    eprintln!("[vm-worker] {event}");
}

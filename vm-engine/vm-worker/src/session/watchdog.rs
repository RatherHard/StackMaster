//! wall-clock 看门狗(9.1 Worker 资源清单;超时的实现层 = worker 进程层,
//! 引擎 crate 无时钟,ADR-8 / 阶段二风险表裁决)。
//!
//! # 形态(D-W8-4)
//!
//! 常驻线程 + 命令通道:`apply_action` 处理前 [`Watchdog::arm`] 注入本动作
//! 的 wall-clock 预算(`timeoutMsPerAction` / 装配默认),响应写出后
//! [`Watchdog::disarm`]。预算耗尽即触发注入的 fire 回调(进程层处置:
//! 受控日志 + 非零退出,恢复走编排器崩溃替换路径)——引擎执行是同步直线
//! 代码,只有本线程能在超限后夺回控制权。
//!
//! 确定性纪律:看门狗只影响**超时故障**这一故障方向;不改变任何确定性
//! 响应的生成(预算内完成与否不影响响应字节,I-4)。`fire` 回调注入使
//! 单元测试可以在不终止进程的前提下验证 armed / fired / disarmed 状态机。

use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

/// 看门狗命令。
enum Command {
    /// 以 `deadline_ms` 预算武装(覆盖既有武装)。
    Arm { deadline_ms: u64 },
    /// 解除武装(本动作已完成)。
    Disarm,
}

/// wall-clock 看门狗句柄(克隆廉价;arm / disarm 为非阻塞发送)。
pub struct Watchdog {
    tx: Sender<Command>,
}

/// 看门狗线程的接收端(进程内常驻)。
struct WatchdogLoop {
    rx: Receiver<Command>,
    deadline: Option<Instant>,
    fire: Box<dyn Fn() + Send + 'static>,
}

impl WatchdogLoop {
    fn run(mut self) {
        loop {
            let wait = self.deadline.map_or(Duration::from_secs(3600), |at| {
                at.saturating_duration_since(Instant::now())
            });
            match self.rx.recv_timeout(wait) {
                Ok(Command::Arm { deadline_ms }) => {
                    self.deadline = Some(Instant::now() + Duration::from_millis(deadline_ms));
                }
                Ok(Command::Disarm) => self.deadline = None,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // 预算耗尽:注入回调(进程层处置),线程随后随进程退出。
                    (self.fire)();
                    self.deadline = None;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    }
}

impl Watchdog {
    /// 启动看门狗线程;`fire` 在预算耗尽时执行一次(进程层处置)。
    pub fn spawn(fire: impl Fn() + Send + 'static) -> Self {
        let (tx, rx) = mpsc::channel();
        let loop_ = WatchdogLoop {
            rx,
            deadline: None,
            fire: Box::new(fire),
        };
        std::thread::Builder::new()
            .name(String::from("vm-worker-watchdog"))
            .spawn(move || loop_.run())
            .expect("看门狗线程启动失败属进程级缺陷");
        Self { tx }
    }

    /// 武装本动作的 wall-clock 预算。
    pub fn arm(&self, deadline_ms: u64) {
        let _ = self.tx.send(Command::Arm { deadline_ms });
    }

    /// 解除武装(动作完成;非阻塞,通道断开视为进程正在退出)。
    pub fn disarm(&self) {
        let _ = self.tx.send(Command::Disarm);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// armed → 超时触发 fire;disarm 后不再触发(状态机;不终止进程)。
    #[test]
    fn watchdog_fires_once_after_deadline_and_disarm_suppresses() {
        let fired = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&fired);
        let watchdog = Watchdog::spawn(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        watchdog.arm(20);
        std::thread::sleep(Duration::from_millis(120));
        assert_eq!(fired.load(Ordering::SeqCst), 1, "超时必须恰触发一次");

        watchdog.disarm();
        watchdog.arm(20);
        watchdog.disarm();
        std::thread::sleep(Duration::from_millis(120));
        assert_eq!(
            fired.load(Ordering::SeqCst),
            1,
            "解除武装后不得触发(disarm 与 arm 竞态以乱序保守兜底)"
        );
    }
}

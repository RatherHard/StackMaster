/**
 * 优雅停机协调器(WP-1 工程载体;阶段三任务分解 WP-1:
 * SIGTERM → 停止接单 → 在途会话状态落盘 → 退出)。
 *
 * 停机序列(步骤按注册顺序执行,index.ts 装配):
 *   1. 触发:SIGTERM / SIGINT;Windows 无 POSIX 信号投递(process.kill 在
 *      Windows 上等价 TerminateProcess,处理器不会运行),故并行接受 IPC
 *      通道的 `shutdown` 消息触发同一序列——供 Windows 本地与 CI 的集成测试
 *      使用,生产面(容器 SIGTERM)不受影响(权威 API 语义规约 D-API-9);
 *   2. stop-accepting-requests:fastify close,在途请求完成后停止接单;
 *   3. 在途会话状态落盘:WP-3 持久化面在此注册真实步骤(骨架期无步骤);
 *   4. flush-logs:日志冲刷后退出。
 *
 * 退出码:全部步骤成功 = 0;任一步骤失败或超过宽限超时(config
 * GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS)= 1(强制退出,防进程悬挂)。
 * 幂等:重复信号不重入,单次序列只执行一遍。
 */
import type { Logger } from "pino";

/** 单个停机步骤(name 进日志,是停机序列的可解释性锚点)。 */
export interface ShutdownStep {
  readonly name: string;
  run(): Promise<void>;
}

export interface ShutdownCoordinator {
  /** 注册停机步骤(按调用顺序执行;须在触发前注册完毕)。 */
  registerStep(step: ShutdownStep): void;
  /** 触发停机序列(幂等;并发调用共享同一次执行)。 */
  shutdown(reason: string): Promise<void>;
  /** 安装默认触发器:SIGTERM / SIGINT + IPC `shutdown` 消息。 */
  installDefaultTriggers(): void;
}

export function createShutdownCoordinator(options: {
  logger: Logger;
  /** 宽限超时(毫秒);超过即记录并强制退出码 1。 */
  timeoutMs: number;
  /** 进程退出注入点(默认 process.exit;测试注入以观察退出码)。 */
  exit?: (code: number) => void;
}): ShutdownCoordinator {
  const exitOnce = (() => {
    let exited = false;
    return (code: number): void => {
      if (exited) {
        return;
      }
      exited = true;
      (options.exit ?? ((exitCode: number) => process.exit(exitCode)))(code);
    };
  })();

  const steps: ShutdownStep[] = [];
  let running: Promise<void> | null = null;

  async function run(reason: string): Promise<void> {
    const watchdog = setTimeout(() => {
      options.logger.error(
        { reason, timeoutMs: options.timeoutMs },
        "graceful shutdown timed out; forcing exit",
      );
      exitOnce(1);
    }, options.timeoutMs);
    // 不阻止进程自然退出(注入 exit 的测试进程不被 watchdog 悬挂)。
    watchdog.unref();

    options.logger.info({ reason }, "graceful shutdown started");
    for (const step of steps) {
      options.logger.info({ step: step.name }, "shutdown step started");
      try {
        await step.run();
      } catch (err) {
        options.logger.error({ err, step: step.name }, "shutdown step failed");
        exitOnce(1);
        return;
      }
      options.logger.info({ step: step.name }, "shutdown step completed");
    }

    options.logger.info({ reason }, "graceful shutdown completed");
    exitOnce(0);
  }

  const coordinator: ShutdownCoordinator = {
    registerStep(step: ShutdownStep): void {
      steps.push(step);
    },
    shutdown(reason: string): Promise<void> {
      if (running === null) {
        running = run(reason);
      }
      return running;
    },
    installDefaultTriggers(): void {
      process.on("SIGTERM", () => {
        void coordinator.shutdown("SIGTERM");
      });
      process.on("SIGINT", () => {
        void coordinator.shutdown("SIGINT");
      });
      // Windows 触发通道:IPC `shutdown` 消息与信号走同一停机序列(D-API-9)。
      process.on("message", (message: unknown) => {
        if (message === "shutdown") {
          void coordinator.shutdown("ipc:shutdown");
        }
      });
    },
  };
  return coordinator;
}

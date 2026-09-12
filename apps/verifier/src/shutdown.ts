/**
 * 优雅停机协调器(WP-61;D-API-9 载体纪律的 verifier 延伸)。
 *
 * 停机序列(步骤按注册顺序执行,index.ts 装配):
 *   stop-verifier-loop(完成当前批,不再发起新认领)→ close-postgres →
 *   flush-logs;超时强制退出码 1;重复信号不重入。
 *
 * Windows 触发通道:无 POSIX 信号投递(process.kill 等价 TerminateProcess),
 * 并行接受 IPC 通道的 `shutdown` 消息触发同一序列(session-api 同款)。
 */
import type { Logger } from "pino";

/** 单个停机步骤(name 进日志,是停机序列的可解释性锚点)。 */
export interface ShutdownStep {
  readonly name: string;
  run(): Promise<void>;
}

export interface ShutdownCoordinator {
  registerStep(step: ShutdownStep): void;
  shutdown(reason: string): Promise<void>;
  installDefaultTriggers(): void;
}

export function createShutdownCoordinator(options: {
  logger: Logger;
  timeoutMs: number;
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
    watchdog.unref();

    options.logger.info({ reason }, "graceful shutdown started");
    for (const step of steps) {
      try {
        await step.run();
      } catch (err) {
        options.logger.error({ err, step: step.name }, "shutdown step failed");
        exitOnce(1);
        return;
      }
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
      // Windows 触发通道:IPC `shutdown` 消息与信号走同一停机序列。
      process.on("message", (message: unknown) => {
        if (message === "shutdown") {
          void coordinator.shutdown("ipc:shutdown");
        }
      });
    },
  };
  return coordinator;
}

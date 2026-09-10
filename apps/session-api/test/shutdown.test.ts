import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { createShutdownCoordinator, type ShutdownStep } from "../src/shutdown.js";

function fakeLogger(): Logger {
  return { info: () => undefined, error: () => undefined } as unknown as Logger;
}

function step(name: string, effects: string[], impl?: () => Promise<void>): ShutdownStep {
  return {
    name,
    run: async () => {
      effects.push(`start:${name}`);
      if (impl) {
        await impl();
      }
      effects.push(`done:${name}`);
    },
  };
}

describe("优雅停机协调器(WP-1:SIGTERM → 停止接单 → 在途状态落盘 → 退出)", () => {
  it("步骤按注册顺序执行,全部成功以退出码 0 结束", async () => {
    const effects: string[] = [];
    let exitCode: number | undefined;
    const coordinator = createShutdownCoordinator({
      logger: fakeLogger(),
      timeoutMs: 1000,
      exit: (code) => {
        exitCode = code;
      },
    });
    coordinator.registerStep(step("stop-accepting-requests", effects));
    coordinator.registerStep(step("persist-in-flight-sessions", effects));
    coordinator.registerStep(step("flush-logs", effects));

    await coordinator.shutdown("SIGTERM");

    expect(effects).toEqual([
      "start:stop-accepting-requests",
      "done:stop-accepting-requests",
      "start:persist-in-flight-sessions",
      "done:persist-in-flight-sessions",
      "start:flush-logs",
      "done:flush-logs",
    ]);
    expect(exitCode).toBe(0);
  });

  it("任一步骤失败立即以退出码 1 终止,后续步骤不再执行", async () => {
    const effects: string[] = [];
    let exitCode: number | undefined;
    const coordinator = createShutdownCoordinator({
      logger: fakeLogger(),
      timeoutMs: 1000,
      exit: (code) => {
        exitCode = code;
      },
    });
    coordinator.registerStep(step("stop-accepting-requests", effects));
    coordinator.registerStep(
      step("persist-in-flight-sessions", effects, async () => {
        throw new Error("persistence unavailable");
      }),
    );
    coordinator.registerStep(step("flush-logs", effects));

    await coordinator.shutdown("SIGTERM");

    expect(effects).toEqual([
      "start:stop-accepting-requests",
      "done:stop-accepting-requests",
      "start:persist-in-flight-sessions",
    ]);
    expect(exitCode).toBe(1);
  });

  it("超过宽限超时强制退出码 1(防进程悬挂)", async () => {
    let exitCode: number | undefined;
    const coordinator = createShutdownCoordinator({
      logger: fakeLogger(),
      timeoutMs: 20,
      exit: (code) => {
        exitCode = code;
      },
    });
    coordinator.registerStep({
      name: "hangs-forever",
      run: () => new Promise<void>(() => undefined),
    });

    void coordinator.shutdown("SIGTERM");
    await vi.waitFor(() => expect(exitCode).toBe(1), { timeout: 2000, interval: 10 });
  });

  it("重复触发不重入:停机序列只执行一遍", async () => {
    const effects: string[] = [];
    const exits: number[] = [];
    const coordinator = createShutdownCoordinator({
      logger: fakeLogger(),
      timeoutMs: 1000,
      exit: (code) => {
        exits.push(code);
      },
    });
    coordinator.registerStep(step("flush-logs", effects));

    const first = coordinator.shutdown("SIGTERM");
    const second = coordinator.shutdown("SIGINT");
    await Promise.all([first, second]);

    expect(effects.filter((entry) => entry === "start:flush-logs")).toHaveLength(1);
    expect(exits).toEqual([0]);
  });
});

/**
 * 优雅停机协调器单测(WP-61;D-API-9 载体纪律的 verifier 延伸)。
 *
 * 停机序列语义:步骤按注册顺序执行 → 退出码 0;步骤失败 → 退出码 1;
 * 超时看门狗 → 强制退出码 1;重复触发不重入(running Promise 复用);
 * 默认触发通道(SIGTERM / SIGINT / IPC shutdown)与手动触发同一序列。
 * exit 可注入(测试不经 process.exit)。
 */
import { describe, expect, it, vi } from "vitest";

import { createShutdownCoordinator } from "../src/shutdown.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Parameters<typeof createShutdownCoordinator>[0]["logger"];

describe("优雅停机协调器", () => {
  it("步骤按注册顺序执行;正常序列退出码 0;重复触发不重入", async () => {
    const exit = vi.fn();
    const order: string[] = [];
    const coordinator = createShutdownCoordinator({
      logger,
      timeoutMs: 1_000,
      exit,
    });
    coordinator.registerStep({
      name: "step-a",
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("a");
      },
    });
    coordinator.registerStep({ name: "step-b", run: async () => void order.push("b") });

    const first = coordinator.shutdown("test");
    const second = coordinator.shutdown("test");
    expect(second).toBe(first);
    await first;
    await second;
    expect(order).toEqual(["a", "b"]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("步骤失败:中止后续步骤并以退出码 1 收口(不静默)", async () => {
    const exit = vi.fn();
    const coordinator = createShutdownCoordinator({ logger, timeoutMs: 1_000, exit });
    coordinator.registerStep({
      name: "boom",
      run: async () => {
        throw new Error("close failed");
      },
    });
    let reached = false;
    coordinator.registerStep({
      name: "never",
      run: async () => {
        reached = true;
      },
    });
    await coordinator.shutdown("test");
    expect(reached).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("超时看门狗:宽限内未完成 → 强制退出码 1(shutdown 不 resolve,只轮询注入 exit)", async () => {
    const exit = vi.fn();
    const coordinator = createShutdownCoordinator({ logger, timeoutMs: 5, exit });
    coordinator.registerStep({
      name: "stalled",
      run: () => new Promise<void>(() => undefined),
    });
    // 看门狗语义:超时后强制 exit(1),但 shutdown 承诺随卡死步骤挂起
    // (生产形态由 process.exit 兜底,注入 exit 下测试只轮询调用)。
    void coordinator.shutdown("test");
    for (let i = 0; i < 100 && exit.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("默认触发通道:SIGTERM / SIGINT / IPC shutdown 消息走同一停机序列;其他消息忽略", async () => {
    const exit = vi.fn();
    const coordinator = createShutdownCoordinator({ logger, timeoutMs: 1_000, exit });
    coordinator.registerStep({ name: "step", run: async () => undefined });
    coordinator.installDefaultTriggers();

    // Windows 无 POSIX 信号投递:process.emit 同步派发已注册的监听器
    // (IPC 'shutdown' 与信号同一序列;'other' 消息不触发)。
    process.emit("message", "other");
    expect(exit).not.toHaveBeenCalled();
    process.emit("message", "shutdown");
    await coordinator.shutdown("already-running");
    expect(exit).toHaveBeenCalledWith(0);

    // 完成后的重复 exit 不重入(early-return 分支)。
    process.emit("SIGTERM");
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

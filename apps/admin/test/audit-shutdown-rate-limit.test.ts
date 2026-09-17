/**
 * 审计出口 / 停机协调器 / 频率闸单元测试(WP-79;零容器)。
 *
 * 三块都是"只在一个方向上有出口"的窄模块,本文件把它们的**可观测面**
 * 与**边界**钉住:
 *  - 受控日志审计:字段表恰为有界枚举 + 时刻 + 绑定租户;凭证材料、
 *    Authorization 头、请求原文结构性缺席(D-API-136 零秘密面);
 *  - 停机协调器:顺序执行 + 步骤失败即退出码 1 + 幂等(不重入)+
 *    超时看门狗强制退出;
 *  - 频率闸:窗口滚动 / 触顶 / 桶表上限驱逐(来源数攻击不得让内存无界增长)。
 */
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  ADMIN_AUDIT_ACTOR,
  ADMIN_QUERY_AUDIT_EVENT,
  ControlledLogAdminQueryAudit,
  MemoryAdminQueryAudit,
} from "../src/audit/admin-audit.js";
import { MAX_RATE_BUCKETS, RATE_WINDOW_MS, AdminRateLimiter } from "../src/rate-limit.js";
import { createShutdownCoordinator } from "../src/shutdown.js";

interface LogCall {
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

function recordingLogger(): { logger: Logger; calls: LogCall[]; errors: LogCall[] } {
  const calls: LogCall[] = [];
  const errors: LogCall[] = [];
  const logger = {
    info: (fields: Record<string, unknown>, message: string) => calls.push({ fields, message }),
    error: (fields: Record<string, unknown>, message: string) => errors.push({ fields, message }),
    warn: () => undefined,
  } as unknown as Logger;
  return { logger, calls, errors };
}

describe("ControlledLogAdminQueryAudit(受控日志出口)", () => {
  it("字段表恰为有界枚举 + 主体 + 时刻 + 绑定租户", async () => {
    const { logger, calls } = recordingLogger();
    await new ControlledLogAdminQueryAudit(logger).record({
      surface: "scores",
      outcome: "ok",
      tenantId: "tenant-a",
      actor: ADMIN_AUDIT_ACTOR,
      at: 1_700_000_000_000,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toBe("admin read-only query audited");
    expect(calls[0]?.fields).toEqual({
      event: ADMIN_QUERY_AUDIT_EVENT,
      surface: "scores",
      outcome: "ok",
      actor: "admin",
      at: 1_700_000_000_000,
      tenantId: "tenant-a",
    });
  });

  it("拒绝态记录不带租户(没有租户上下文就不凭空造一个)", async () => {
    const { logger, calls } = recordingLogger();
    await new ControlledLogAdminQueryAudit(logger).record({
      surface: "challenges",
      outcome: "denied",
      actor: ADMIN_AUDIT_ACTOR,
      at: 1,
    });
    expect(calls[0]?.fields).not.toHaveProperty("tenantId");
  });

  it("零秘密面:日志字段与文案里不出现凭证材料 / 请求头 / 查询串", async () => {
    const { logger, calls } = recordingLogger();
    const audit = new ControlledLogAdminQueryAudit(logger);
    await audit.record({
      surface: "verdicts",
      outcome: "not_found",
      actor: ADMIN_AUDIT_ACTOR,
      at: 2,
    });
    const rendered = JSON.stringify(calls);
    for (const forbidden of ["authorization", "Authorization", "Bearer", "sha256", "credential"]) {
      expect(rendered).not.toContain(forbidden);
    }
    expect(Object.keys(calls[0]?.fields ?? {}).sort()).toEqual([
      "actor",
      "at",
      "event",
      "outcome",
      "surface",
    ]);
  });

  it("内存实现:失败注入 ⇒ record 恒拒(供 fail-closed 红灯使用)", async () => {
    const audit = new MemoryAdminQueryAudit();
    await audit.record({ surface: "scores", outcome: "ok", actor: ADMIN_AUDIT_ACTOR, at: 1 });
    expect(audit.entries).toHaveLength(1);
    audit.failWith = new Error("sink down");
    await expect(
      audit.record({ surface: "scores", outcome: "ok", actor: ADMIN_AUDIT_ACTOR, at: 2 }),
    ).rejects.toThrow("sink down");
    expect(audit.entries).toHaveLength(1);
  });
});

describe("createShutdownCoordinator(优雅停机)", () => {
  it("步骤按注册顺序执行,完成后以退出码 0 收口", async () => {
    const { logger } = recordingLogger();
    const order: string[] = [];
    const exit = vi.fn();
    const coordinator = createShutdownCoordinator({ logger, timeoutMs: 1_000, exit });
    coordinator.registerStep({ name: "close-admin-server", run: async () => void order.push("server") });
    coordinator.registerStep({ name: "close-postgres", run: async () => void order.push("postgres") });
    await coordinator.shutdown("test");
    expect(order).toEqual(["server", "postgres"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("步骤失败 ⇒ 记录失败步名 + 退出码 1,且后续步骤不再执行", async () => {
    const { logger, errors } = recordingLogger();
    const order: string[] = [];
    const exit = vi.fn();
    const coordinator = createShutdownCoordinator({ logger, timeoutMs: 1_000, exit });
    coordinator.registerStep({
      name: "close-admin-server",
      run: async () => {
        throw new Error("close failed");
      },
    });
    coordinator.registerStep({ name: "close-postgres", run: async () => void order.push("postgres") });
    await coordinator.shutdown("SIGTERM");
    expect(order).toEqual([]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.some((call) => call.fields["step"] === "close-admin-server")).toBe(true);
  });

  it("重复触发不重入(第二次返回同一 Promise,步骤只跑一次)", async () => {
    const { logger } = recordingLogger();
    let runs = 0;
    const exit = vi.fn();
    const coordinator = createShutdownCoordinator({ logger, timeoutMs: 1_000, exit });
    coordinator.registerStep({
      name: "close-admin-server",
      run: async () => {
        runs += 1;
      },
    });
    const first = coordinator.shutdown("SIGTERM");
    const second = coordinator.shutdown("ipc:shutdown");
    expect(second).toBe(first);
    await first;
    expect(runs).toBe(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("超时看门狗 ⇒ 强制退出码 1 且只退一次", async () => {
    vi.useFakeTimers();
    try {
      const { logger, errors } = recordingLogger();
      const exit = vi.fn();
      const coordinator = createShutdownCoordinator({ logger, timeoutMs: 50, exit });
      coordinator.registerStep({
        name: "close-admin-server",
        run: () => new Promise<void>(() => undefined),
      });
      void coordinator.shutdown("SIGTERM");
      await vi.advanceTimersByTimeAsync(60);
      expect(exit).toHaveBeenCalledWith(1);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(errors.some((call) => call.message.includes("timed out"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("默认触发通道:SIGTERM / SIGINT / IPC message 三路(IPC = Windows 形态)", async () => {
    const { logger } = recordingLogger();
    const exit = vi.fn();
    const beforeTerm = process.listeners("SIGTERM");
    const beforeInt = process.listeners("SIGINT");
    const beforeMessage = process.listeners("message");
    const coordinator = createShutdownCoordinator({ logger, timeoutMs: 1_000, exit });
    coordinator.registerStep({ name: "noop", run: async () => undefined });
    coordinator.installDefaultTriggers();
    const added = {
      term: process.listeners("SIGTERM").filter((listener) => !beforeTerm.includes(listener)),
      int: process.listeners("SIGINT").filter((listener) => !beforeInt.includes(listener)),
      message: process.listeners("message").filter((listener) => !beforeMessage.includes(listener)),
    };
    try {
      expect(added.term).toHaveLength(1);
      expect(added.int).toHaveLength(1);
      expect(added.message).toHaveLength(1);
      // 只触发 IPC 通道(不 emit 真信号:测试进程不得被停机序列带走)。
      (process as unknown as { emit(event: string, ...args: unknown[]): boolean }).emit(
        "message",
        "shutdown",
      );
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      // 非 "shutdown" 的 IPC 消息不触发停机。
      (process as unknown as { emit(event: string, ...args: unknown[]): boolean }).emit(
        "message",
        "keep-alive",
      );
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      for (const listener of [...added.term, ...added.int, ...added.message]) {
        process.off("SIGTERM", listener);
        process.off("SIGINT", listener);
        process.off("message", listener);
      }
    }
  });
});

describe("AdminRateLimiter(固定窗口 + 有界桶表)", () => {
  it("窗口内计数到上限后触顶;窗口滚动后重新放行", () => {
    let now = 0;
    const limiter = new AdminRateLimiter(2, () => now, 8);
    expect(limiter.allow("10.0.0.1")).toBe(true);
    expect(limiter.allow("10.0.0.1")).toBe(true);
    expect(limiter.allow("10.0.0.1")).toBe(false);
    now += RATE_WINDOW_MS;
    expect(limiter.allow("10.0.0.1")).toBe(true);
  });

  it("不同键各自独立(键 = 客户端 IP;换错凭证不会得到新桶)", () => {
    const limiter = new AdminRateLimiter(1, () => 0, 8);
    expect(limiter.allow("10.0.0.1")).toBe(true);
    expect(limiter.allow("10.0.0.2")).toBe(true);
    expect(limiter.allow("10.0.0.1")).toBe(false);
    // 同一 IP 的第二次尝试(无论凭证对错)共享同一预算。
    expect(limiter.allow("10.0.0.1")).toBe(false);
  });

  it("桶表达上限:先清过期桶;仍满则驱逐最早写入的桶(内存有界)", () => {
    let now = 0;
    const limiter = new AdminRateLimiter(1, () => now, 2);
    expect(limiter.allow("a")).toBe(true);
    now += 1;
    expect(limiter.allow("b")).toBe(true);
    // 第三个来源 ⇒ 两者都未过期 ⇒ 驱逐最早写入的 "a"。
    expect(limiter.allow("c")).toBe(true);
    // "b" 仍在窗口内且已用满 ⇒ 触顶;"a" 被驱逐后重新拥有全新预算。
    expect(limiter.allow("b")).toBe(false);
    expect(limiter.allow("a")).toBe(true);
  });

  it("过期清扫路径:全部桶过期后新键直接入表(不清空有效桶)", () => {
    let now = 0;
    const limiter = new AdminRateLimiter(1, () => now, 2);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("b")).toBe(true);
    now += RATE_WINDOW_MS;
    // 全过期 ⇒ 清扫后仍有余量,不做驱逐;所有旧键次进入新窗口。
    expect(limiter.allow("c")).toBe(true);
    expect(limiter.allow("a")).toBe(true);
  });

  it("默认上限常量是 10_000(有界性声明锚点)", () => {
    expect(MAX_RATE_BUCKETS).toBe(10_000);
  });
});

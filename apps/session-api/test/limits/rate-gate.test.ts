/**
 * 固定窗口频率闸单元测试(WP-6;D-API-50):
 *  - 窗口内计数 ≤ 限额放行、超限确定性拒绝(拒绝不回退计数);
 *  - 窗口锚定于窗口内首次计数,过期后重置(注入时钟驱动,TTL 语义);
 *  - acquireOrThrow 抛 RateLimitExceeded(呈现面 = 429 冻结形态,error-mapping);
 *  - 计数器故障按原样上抛(rate 键域 fail-closed,D-API-24),不静默放行。
 */
import { describe, expect, it } from "vitest";

import { MemoryRateLimitCounter } from "../../src/persistence/index.js";
import { FixedWindowRateGate } from "../../src/limits/index.js";
import { RateLimitExceeded } from "../../src/limits/index.js";

describe("FixedWindowRateGate(固定窗口,D-API-50)", () => {
  it("窗口内第 N 次放行、第 N+1 次确定性拒绝;拒绝不回退计数", async () => {
    const nowMs = 1_000;
    const gate = new FixedWindowRateGate({
      counter: new MemoryRateLimitCounter(() => nowMs),
      limitPerWindow: 3,
    });
    expect(await gate.tryAcquire("rate:t:u")).toBe(true);
    expect(await gate.tryAcquire("rate:t:u")).toBe(true);
    expect(await gate.tryAcquire("rate:t:u")).toBe(true);
    expect(await gate.tryAcquire("rate:t:u")).toBe(false);
    // 确定性:同窗口内继续触顶恒拒绝(I-4)。
    expect(await gate.tryAcquire("rate:t:u")).toBe(false);
    expect(await gate.tryAcquire("rate:t:u")).toBe(false);
  });

  it("窗口锚定于首增,过期后重置(注入时钟)", async () => {
    let nowMs = 1_000;
    const gate = new FixedWindowRateGate({
      counter: new MemoryRateLimitCounter(() => nowMs),
      limitPerWindow: 1,
      windowSeconds: 60,
    });
    expect(await gate.tryAcquire("rate:t:u")).toBe(true);
    expect(await gate.tryAcquire("rate:t:u")).toBe(false);
    // 60 s 窗口内:仍拒绝。
    nowMs += 59_000;
    expect(await gate.tryAcquire("rate:t:u")).toBe(false);
    // 窗口过期(TTL 自首增起算):重置为 fresh。
    nowMs += 2_000;
    expect(await gate.tryAcquire("rate:t:u")).toBe(true);
  });

  it("不同键(不同租户 / 用户)计量隔离", async () => {
    const gate = new FixedWindowRateGate({
      counter: new MemoryRateLimitCounter(),
      limitPerWindow: 1,
    });
    expect(await gate.tryAcquire("rate:t1:u1")).toBe(true);
    expect(await gate.tryAcquire("rate:t1:u1")).toBe(false);
    expect(await gate.tryAcquire("rate:t1:u2")).toBe(true);
    expect(await gate.tryAcquire("rate:t2:u1")).toBe(true);
  });

  it("acquireOrThrow:触顶抛 RateLimitExceeded(429 冻结形态的呈现源);名额内不抛", async () => {
    const gate = new FixedWindowRateGate({
      counter: new MemoryRateLimitCounter(),
      limitPerWindow: 1,
    });
    await expect(gate.acquireOrThrow("rate:t:u", "request_rate")).resolves.toBeUndefined();
    await expect(gate.acquireOrThrow("rate:t:u", "request_rate")).rejects.toBeInstanceOf(
      RateLimitExceeded,
    );
    await expect(gate.acquireOrThrow("rate:t:u", "submission_rate")).rejects.toThrow(/rate:t:u/);
  });

  it("计数器故障按原样上抛(rate 键域 fail-closed,D-API-24),不静默放行", async () => {
    const failing = {
      increment: async () => {
        throw new Error("store unavailable");
      },
    };
    const gate = new FixedWindowRateGate({ counter: failing, limitPerWindow: 10 });
    await expect(gate.tryAcquire("rate:t:u")).rejects.toThrow("store unavailable");
  });
});

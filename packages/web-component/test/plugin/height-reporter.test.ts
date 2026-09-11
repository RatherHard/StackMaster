/**
 * height_changed 上报管道单测(D-API-77:rAF 合流 + 每秒上限 30 +
 * MAX_EMBED_HEIGHT_PX 护栏;TypeRateLimiter 复用的行为锚)。
 */
import { describe, expect, it } from "vitest";

import { HeightReporter } from "../../src/plugin/height-reporter.js";
import { FakeClock, FakeFrames } from "../helpers.js";

/** 手工驱动的 rAF 假体见 helpers.FakeFrames(合流语义由上游保证)。 */

function makeReporter(overrides: {
  measure?: () => number;
  maxPerSecond?: number;
  maxHeightPx?: number;
  clock?: FakeClock;
  frames?: FakeFrames;
  sent?: number[];
  oversize?: number[];
  rateLimited?: number[];
} = {}) {
  const clock = overrides.clock ?? new FakeClock();
  const frames = overrides.frames ?? new FakeFrames();
  const sent = overrides.sent ?? [];
  const oversize = overrides.oversize ?? [];
  const rateLimited = overrides.rateLimited ?? [];
  const reporter = new HeightReporter({
    measure: overrides.measure ?? (() => 480),
    send: (h) => sent.push(h),
    ...(overrides.maxHeightPx !== undefined ? { maxHeightPx: overrides.maxHeightPx } : {}),
    ...(overrides.maxPerSecond !== undefined ? { maxPerSecond: overrides.maxPerSecond } : {}),
    clock: () => clock.now(),
    frameScheduler: frames,
    onOversizeDrop: () => oversize.push(1),
    onRateLimitDrop: () => rateLimited.push(1),
  });
  return { reporter, clock, frames, sent, oversize, rateLimited };
}

describe("HeightReporter(D-API-77 height_changed 管道)", () => {
  it("rAF 合流:一帧多次通知只发一次,尾沿携带最新测量值", () => {
    let height = 100;
    const { reporter, frames, sent } = makeReporter({ measure: () => height });
    reporter.notifyContentHeightChange();
    height = 250;
    reporter.notifyContentHeightChange();
    height = 300;
    reporter.notifyContentHeightChange();
    expect(frames.pendingCount).toBe(1);
    expect(sent).toEqual([]);
    frames.flush();
    expect(sent).toEqual([300]);
  });

  it("每秒硬上限(默认 30):超限丢弃 + 计数钩子,零发送", () => {
    const { reporter, frames, sent, rateLimited } = makeReporter({ maxPerSecond: 3 });
    for (let i = 0; i < 5; i += 1) {
      reporter.notifyContentHeightChange();
      frames.flush();
    }
    expect(sent).toEqual([480, 480, 480]);
    expect(rateLimited.length).toBe(2);
  });

  it("1 秒滑动窗口滑动后恢复发送(时钟注入,零真实等待)", () => {
    const clock = new FakeClock();
    const { reporter, frames, sent, rateLimited } = makeReporter({ maxPerSecond: 1, clock });
    reporter.notifyContentHeightChange();
    frames.flush();
    reporter.notifyContentHeightChange();
    frames.flush();
    expect(sent.length).toBe(1);
    expect(rateLimited.length).toBe(1);
    clock.advance(1001);
    reporter.notifyContentHeightChange();
    frames.flush();
    expect(sent.length).toBe(2);
    expect(rateLimited.length).toBe(1);
  });

  it("超大即不发 + 计数(MAX_EMBED_HEIGHT_PX 护栏;clamp 不适用于超上限原始值)", () => {
    const { reporter, frames, sent, oversize } = makeReporter({ measure: () => 100001 });
    reporter.notifyContentHeightChange();
    frames.flush();
    expect(sent).toEqual([]);
    expect(oversize.length).toBe(1);
  });

  it("maxHeightPx 收紧:clamp 载荷(只可收紧;超上限装配拒绝)", () => {
    const { reporter, frames, sent } = makeReporter({ measure: () => 800, maxHeightPx: 600 });
    reporter.notifyContentHeightChange();
    frames.flush();
    expect(sent).toEqual([600]);
    expect(() =>
      new HeightReporter({
        measure: () => 1,
        send: () => undefined,
        maxHeightPx: 100001,
        clock: () => 0,
        frameScheduler: new FakeFrames(),
      }),
    ).toThrow(/只可收紧/);
  });

  it("测量值 < 1 / 非有限:静默跳过(非违规,无计数)", () => {
    const { reporter, frames, sent, oversize, rateLimited } = makeReporter({ measure: () => 0 });
    reporter.notifyContentHeightChange();
    frames.flush();
    expect(sent).toEqual([]);
    expect(oversize.length).toBe(0);
    expect(rateLimited.length).toBe(0);
  });

  it("dispose 后通知为 no-op;未测量高度不发送", () => {
    const { reporter, frames, sent } = makeReporter();
    reporter.dispose();
    reporter.notifyContentHeightChange();
    expect(frames.pendingCount).toBe(0);
    expect(sent).toEqual([]);
  });
});

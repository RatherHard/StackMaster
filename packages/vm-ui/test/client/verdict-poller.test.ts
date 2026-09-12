/**
 * VerdictPoller 状态机测试(阶段六 WP-63;D-API-84 重询节奏定案):
 *  - follow(submissionId) → pending 呈现 + 立即首询,此后确定性间隔轮询;
 *  - 查询返回 verdicted → 终态呈现并停询(verdicted 即停,单向不可逆);
 *  - 429 / 查询失败 → 指数退避(零重试风暴),连续失败触顶 → unavailable
 *    (裁决暂不可用,停询;不中断会话、不判负);
 *  - 断线 → 暂停轮询(失败不计入预算);重连 → 恢复(预算重置);
 *  - 再次 follow → 替换跟随对象(显式重新提交入口;旧 submission 不动)。
 * 全部时钟与定时器注入,判定确定性(I-4)。
 */
import { describe, expect, it } from "vitest";
import type { VerdictQueryResponse } from "@stackmaster/protocol";

import { VerdictPoller, type VerdictPresentation, type VerdictQuerySink } from "../../src/client/verdict-poller.js";
import type { ConnectionStatusEvent } from "../../src/client/session-client.js";
import { FakeTimers } from "../helpers/fixtures.js";

/** 可编程查询替身:按 submissionId → 响应序列逐次出队。 */
class FakeSink implements VerdictQuerySink {
  readonly calls: string[] = [];
  readonly queue = new Map<string, VerdictQueryResponse[]>();
  readonly failures = new Map<string, number>();
  readonly statusListeners = new Set<(event: ConnectionStatusEvent) => void>();
  status: ConnectionStatusEvent["status"] = "connected";

  push(submissionId: string, ...responses: VerdictQueryResponse[]): void {
    this.queue.set(submissionId, [...(this.queue.get(submissionId) ?? []), ...responses]);
  }

  failNext(submissionId: string, times = 1): void {
    this.failures.set(submissionId, (this.failures.get(submissionId) ?? 0) + times);
  }

  async queryVerdict(submissionId: string): Promise<VerdictQueryResponse> {
    this.calls.push(submissionId);
    const remainingFailures = this.failures.get(submissionId) ?? 0;
    if (remainingFailures > 0) {
      this.failures.set(submissionId, remainingFailures - 1);
      throw new Error("query failed (fake)");
    }
    const queue = this.queue.get(submissionId) ?? [];
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`查询队列空:${submissionId}`);
    }
    return next;
  }

  onConnectionStatus(listener: (event: ConnectionStatusEvent) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  emit(status: ConnectionStatusEvent["status"]): void {
    this.status = status;
    for (const listener of [...this.statusListeners]) {
      listener({ at: 0, status, closeCode: null, reason: null, attempt: 0, retryDelayMs: null });
    }
  }
}

function pending(submissionId: string): VerdictQueryResponse {
  return { submissionId, revision: 7, status: "pending" };
}

function verdicted(submissionId: string, verdict: VerdictQueryResponse["verdict"] = "success"): VerdictQueryResponse {
  return { submissionId, revision: 7, status: "verdicted", verdict, decidedAt: 1_789_200_000 };
}

interface Harness {
  readonly sink: FakeSink;
  readonly timers: FakeTimers;
  readonly poller: VerdictPoller;
  readonly seen: VerdictPresentation[];
}

function createHarness(options?: { maxConsecutiveFailures?: number }): Harness {
  const sink = new FakeSink();
  const timers = new FakeTimers();
  const seen: VerdictPresentation[] = [];
  const poller = new VerdictPoller({
    sink,
    baseIntervalMs: 2500,
    maxIntervalMs: 30000,
    ...(options?.maxConsecutiveFailures === undefined ? {} : { maxConsecutiveFailures: options.maxConsecutiveFailures }),
    scheduleTimer: timers.schedule,
    cancelTimer: timers.cancel,
  });
  poller.onChange((presentation) => seen.push(presentation));
  return { sink, timers, poller, seen };
}

const SUB = "submission-0001";

describe("VerdictPoller 跟随与 pending 轮询(D-API-84 重询节奏)", () => {
  it("follow → pending 呈现并立即首询;其后按确定性间隔继续轮询", async () => {
    const { sink, timers, poller } = createHarness();
    sink.push(SUB, pending(SUB), pending(SUB), verdicted(SUB));

    poller.follow(SUB);
    expect(poller.presentation).toEqual({ kind: "pending", submissionId: SUB });
    await timers.runNext(); // 首询(delay 0)
    expect(sink.calls).toEqual([SUB]);
    expect(poller.presentation).toEqual({ kind: "pending", submissionId: SUB });

    await timers.runNext(); // 间隔 2500ms 后第二次
    expect(sink.calls).toEqual([SUB, SUB]);
    expect(timers.currentTime).toBe(2500);

    await timers.runNext(); // 第三次:verdicted
    expect(sink.calls).toEqual([SUB, SUB, SUB]);
    expect(poller.presentation).toEqual({ kind: "verdicted", submissionId: SUB, verdict: "success" });
  });

  it("verdicted 即停:终态后不再排程任何查询(单向状态机)", async () => {
    const { sink, timers, poller } = createHarness();
    sink.push(SUB, verdicted(SUB, "wrong_answer"));

    poller.follow(SUB);
    await timers.runNext();
    expect(poller.presentation).toEqual({ kind: "verdicted", submissionId: SUB, verdict: "wrong_answer" });
    expect(await timers.runNext()).toBe(false);
    expect(sink.calls).toEqual([SUB]);
  });
});

describe("VerdictPoller 失败退避与降级(零重试风暴;裁决不可用 ≠ 判负)", () => {
  it("查询失败 → 指数退避(2.5s → 5s → 10s …),失败不计为裁决", async () => {
    const { sink, timers, poller } = createHarness({ maxConsecutiveFailures: 4 });
    sink.push(SUB, verdicted(SUB));
    sink.failNext(SUB, 2);

    poller.follow(SUB);
    await timers.runNext(); // 首询失败
    expect(poller.presentation).toEqual({ kind: "pending", submissionId: SUB });
    await timers.runNext(); // 退避 2.5s
    expect(timers.currentTime).toBe(2500);
    await timers.runNext(); // 退避 5s
    expect(timers.currentTime).toBe(7500);
    // 成功后恢复确定间隔:verdicted 到达。
    expect(poller.presentation).toEqual({ kind: "verdicted", submissionId: SUB, verdict: "success" });
  });

  it("连续失败触顶 → unavailable 呈现并停询(会话不受影响)", async () => {
    const { sink, timers, poller } = createHarness({ maxConsecutiveFailures: 3 });
    sink.failNext(SUB, 10);

    poller.follow(SUB);
    await timers.runNext(); // 失败 1
    await timers.runNext(); // 失败 2(退避)
    await timers.runNext(); // 失败 3 → unavailable
    expect(poller.presentation).toEqual({ kind: "unavailable", submissionId: SUB });
    expect(await timers.runNext()).toBe(false);
    expect(sink.calls.length).toBe(3);
  });

  it("429 冻结形态与网络失败同走退避路径(呈现面零形态差异)", async () => {
    const { sink, timers, poller } = createHarness({ maxConsecutiveFailures: 2 });
    // FakeSink 的失败是网络型异常;429 在 SessionCommandError 中同型
    // (本用例锁定退避路径对失败类别不敏感)。
    sink.failNext(SUB, 5);
    poller.follow(SUB);
    await timers.runNext();
    await timers.runNext();
    expect(poller.presentation).toEqual({ kind: "unavailable", submissionId: SUB });
  });
});

describe("VerdictPoller 断线暂停与重连恢复(D-API-84 停止条件定案)", () => {
  it("断线 → 暂停轮询(定时器清空);重连 → 恢复并重置失败预算", async () => {
    const { sink, timers, poller } = createHarness({ maxConsecutiveFailures: 2 });
    sink.push(SUB, pending(SUB), pending(SUB), verdicted(SUB));

    poller.follow(SUB);
    await timers.runNext(); // 首询 pending
    sink.emit("reconnecting");
    expect(await timers.runNext()).toBe(false); // 暂停:无排程
    expect(sink.calls).toEqual([SUB]);

    sink.emit("connected");
    await timers.runNext(); // 恢复后立即重询
    expect(sink.calls).toEqual([SUB, SUB]);
    expect(poller.presentation).toEqual({ kind: "pending", submissionId: SUB });
    await timers.runNext();
    expect(poller.presentation).toEqual({ kind: "verdicted", submissionId: SUB, verdict: "success" });
  });

  it("断线期间在途查询失败不计入失败预算(重连后满预算可用)", async () => {
    const { sink, timers, poller } = createHarness({ maxConsecutiveFailures: 2 });
    sink.push(SUB, pending(SUB), verdicted(SUB));
    sink.failNext(SUB, 1);

    poller.follow(SUB);
    await timers.runNext(); // 首询失败(1 次失败)
    sink.emit("disconnected");
    sink.emit("connected");
    await timers.runNext(); // 重连恢复:预算已重置,本轮 pending
    expect(poller.presentation).toEqual({ kind: "pending", submissionId: SUB });
  });
});

describe("VerdictPoller 重新提交入口语义(显式新 submit → 新 pending)", () => {
  it("再次 follow 替换跟随对象:旧 submission 停询,新 submission 从 pending 起步", async () => {
    const { sink, timers, poller } = createHarness();
    sink.push("sub-old", pending("sub-old"), verdicted("sub-old"));
    sink.push("sub-new", pending("sub-new"), verdicted("sub-new", "wrong_answer"));

    poller.follow("sub-old");
    await timers.runNext();
    expect(sink.calls).toEqual(["sub-old"]);

    poller.follow("sub-new");
    expect(poller.presentation).toEqual({ kind: "pending", submissionId: "sub-new" });
    await timers.runNext();
    expect(sink.calls).toEqual(["sub-old", "sub-new"]);
    await timers.runNext(); // +2500ms 第二询:verdicted
    expect(sink.calls).toEqual(["sub-old", "sub-new", "sub-new"]);
    expect(poller.presentation).toEqual({ kind: "verdicted", submissionId: "sub-new", verdict: "wrong_answer" });
  });

  it("stop() → 回到 idle 并停询;dispose 后不产生新查询", async () => {
    const { sink, timers, poller } = createHarness();
    sink.push(SUB, pending(SUB), verdicted(SUB));
    poller.follow(SUB);
    await timers.runNext();
    poller.stop();
    expect(poller.presentation).toEqual({ kind: "idle" });
    expect(await timers.runNext()).toBe(false);
  });
});

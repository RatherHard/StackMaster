/**
 * Payload 步进执行器行为测试(WP-F6 / FE-WS-04b / Q3 定案):
 * fake action sink 记录调用序——逐步提交时序(等响应再提交下一步)、
 * 断点暂停与恢复、用户暂停停在原子边界、rejected(budget_exhausted)
 * 暂停 + 可解释错误 + 手动重试、done、间隔等待注入、load 复位。
 */
import { describe, expect, it } from "vitest";

import type { ActionObject, ActionResponse, PublicError } from "@stackmaster/protocol";

import { compilePayload } from "../../src/payload/compiler/compile.js";
import type { PayloadProgram, PayloadStep } from "../../src/payload/compiler/types.js";
import {
  PayloadStepExecutor,
  type PayloadActionSink,
  type PayloadExecutorErrorEvent,
  type PayloadExecutorStateEvent,
  type PayloadPausedEvent,
} from "../../src/payload/executor.js";

// ── Fake sink(记录调用序;测试手动回放响应)────────────────────────────────

type ResponseListener = (response: ActionResponse) => void;
type RejectListener = (error: PublicError, response: ActionResponse) => void;

class FakeSink implements PayloadActionSink {
  readonly sent: ActionObject[] = [];
  readonly #responseListeners = new Set<ResponseListener>();
  readonly #rejectListeners = new Set<RejectListener>();

  sendAction(action: ActionObject): void {
    this.sent.push(action);
  }

  onActionResponse(listener: ResponseListener): () => void {
    this.#responseListeners.add(listener);
    return () => this.#responseListeners.delete(listener);
  }

  onActionRejected(listener: RejectListener): () => void {
    this.#rejectListeners.add(listener);
    return () => this.#rejectListeners.delete(listener);
  }

  /** 模拟服务端接受(最近一次提交的响应)。 */
  accept(revision = 1): void {
    const response: ActionResponse = {
      requestId: `req-${this.sent.length}`,
      revision,
      status: "paused",
      projectionDelta: null,
      publicEvents: [],
    };
    for (const listener of [...this.#responseListeners]) {
      listener(response);
    }
  }

  /** 模拟服务端拒绝(如 D-API-50~53 限流 budget_exhausted)。 */
  reject(error: Partial<PublicError>): void {
    const publicError = { code: "budget_exhausted", message: "预算耗尽", ...error } as PublicError;
    const response: ActionResponse = {
      requestId: `req-${this.sent.length}`,
      revision: 0,
      status: "rejected",
      projectionDelta: null,
      publicEvents: [],
      userVisibleError: publicError,
    };
    for (const listener of [...this.#rejectListeners]) {
      listener(publicError, response);
    }
  }
}

/** 微任务收敛(执行器内部 async 泵推进完成)。 */
async function settle(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

// ── 程序构造(直接以步骤对象表达;编译器行为另测)──────────────────────────

function writeAction(addressHex: string): PayloadStep {
  return { kind: "action", action: { type: "write_bytes", args: { addressHex, bytesHex: "41" } }, label: `写字节 ${addressHex}`, blockId: null };
}

function stepAction(): PayloadStep {
  return { kind: "action", action: { type: "step", args: {} }, label: "单步", blockId: null };
}

function breakpoint(): PayloadStep {
  return { kind: "breakpoint", label: "断点(暂停观察)", blockId: null };
}

function programOf(...steps: PayloadStep[]): PayloadProgram {
  return { steps };
}

function createExecutor(sink: PayloadActionSink) {
  const states: PayloadExecutorStateEvent[] = [];
  const paused: PayloadPausedEvent[] = [];
  const errors: PayloadExecutorErrorEvent[] = [];
  const accepted: number[] = [];
  const executor = new PayloadStepExecutor(sink);
  executor.onStateChange((event) => states.push(event));
  executor.onPaused((event) => paused.push(event));
  executor.onError((event) => errors.push(event));
  executor.onStepAccepted((event) => accepted.push(event.index));
  return { executor, states, paused, errors, accepted };
}

// ── 逐步提交时序(Q3:每个原子动作 = 一步;等响应再提交下一步)────────────

describe("逐步提交时序", () => {
  it("run 连续推进:每步等 onActionResponse 后才提交下一动作,完成后 done", async () => {
    const sink = new FakeSink();
    const { executor, states } = createExecutor(sink);
    executor.load(programOf(writeAction("0x1000"), writeAction("0x1008"), stepAction()));
    executor.run();
    await settle();
    // 第一步已提交,等待响应:后续动作不得提前提交(时序纪律)。
    expect(sink.sent).toHaveLength(1);
    expect(executor.status).toBe("running");

    sink.accept(1);
    await settle();
    expect(sink.sent).toHaveLength(2);

    sink.accept(2);
    await settle();
    expect(sink.sent).toHaveLength(3);

    sink.accept(3);
    await settle();
    expect(executor.status).toBe("done");
    expect(executor.cursor).toBe(3);
    // load 的 idle 与初始态同值去重(状态机语义),不发重复事件。
    expect(states.map((event) => event.status)).toEqual(["running", "done"]);
  });

  it("stepOnce 推进恰好一个原子动作后暂停;最后一步后 done", async () => {
    const sink = new FakeSink();
    const { executor, paused } = createExecutor(sink);
    executor.load(programOf(writeAction("0x1000"), writeAction("0x1008")));
    executor.stepOnce();
    await settle();
    sink.accept(1);
    await settle();
    expect(sink.sent).toHaveLength(1);
    expect(executor.status).toBe("paused");
    expect(executor.cursor).toBe(1);
    expect(paused.at(-1)).toEqual({ index: 1, reason: "step" });

    executor.stepOnce();
    await settle();
    sink.accept(2);
    await settle();
    expect(executor.status).toBe("done");
  });

  it("空程序 run 直接 done;running 中重复 run/step 为 no-op", async () => {
    const sink = new FakeSink();
    const { executor, states } = createExecutor(sink);
    executor.load(programOf());
    executor.run();
    await settle();
    expect(executor.status).toBe("done");
    expect(sink.sent).toHaveLength(0);

    executor.load(programOf(writeAction("0x1000")));
    executor.run();
    executor.run();
    executor.stepOnce();
    await settle();
    expect(sink.sent).toHaveLength(1);
    expect(states.at(-1)?.status).toBe("running");
  });
});

// ── 断点(M7 变通:断点积木 = 步进暂停点)────────────────────────────────

describe("断点暂停与恢复", () => {
  it("到达断点停在标记处;恢复后消费标记继续", async () => {
    const sink = new FakeSink();
    const { executor, paused } = createExecutor(sink);
    executor.load(programOf(writeAction("0x1000"), breakpoint(), writeAction("0x1008")));
    executor.run();
    await settle();
    sink.accept(1);
    await settle();
    // 第一个动作已执行,到达断点:暂停于标记(标记未消费)。
    expect(executor.status).toBe("paused");
    expect(executor.cursor).toBe(1);
    expect(paused.at(-1)).toEqual({ index: 1, reason: "breakpoint" });
    expect(sink.sent).toHaveLength(1);

    // 恢复:标记被消费,第二个动作执行,done。
    executor.run();
    await settle();
    expect(sink.sent).toHaveLength(2);
    sink.accept(2);
    await settle();
    expect(executor.status).toBe("done");
    expect(executor.cursor).toBe(3);
  });

  it("从 idle 单步遇首步断点:暂停于断点(不提交动作)", async () => {
    const sink = new FakeSink();
    const { executor } = createExecutor(sink);
    executor.load(programOf(breakpoint(), writeAction("0x1000")));
    executor.stepOnce();
    await settle();
    expect(executor.status).toBe("paused");
    expect(executor.cursor).toBe(0);
    expect(sink.sent).toHaveLength(0);

    // 再单步:消费断点标记并执行一个动作。
    executor.stepOnce();
    await settle();
    expect(sink.sent).toHaveLength(1);
    sink.accept(1);
    await settle();
    expect(executor.status).toBe("done");
  });
});

// ── 用户暂停(停在原子边界)────────────────────────────────────────────────

describe("用户暂停", () => {
  it("pause 请求后停在下一个原子边界,不产生半步", async () => {
    const sink = new FakeSink();
    const { executor, paused } = createExecutor(sink);
    executor.load(programOf(writeAction("0x1000"), writeAction("0x1008"), writeAction("0x1010")));
    executor.run();
    await settle();
    expect(sink.sent).toHaveLength(1);
    executor.pause();
    sink.accept(1);
    await settle();
    expect(executor.status).toBe("paused");
    expect(executor.cursor).toBe(1);
    expect(paused.at(-1)).toEqual({ index: 1, reason: "user" });
    // 暂停后不再提交下一步。
    await settle(16);
    expect(sink.sent).toHaveLength(1);
  });
});

// ── rejected(budget_exhausted 限流路径;重试由用户手动步进)────────────────

describe("rejected 暂停与手动重试", () => {
  it("budget_exhausted → error 状态 + 可解释错误回调;光标不动可重试", async () => {
    const sink = new FakeSink();
    const { executor, errors } = createExecutor(sink);
    executor.load(programOf(writeAction("0x1000"), writeAction("0x1008")));
    executor.run();
    await settle();
    sink.accept(1);
    await settle();
    // 第二步被限流拒绝。
    executor.run();
    await settle();
    expect(sink.sent).toHaveLength(2);
    sink.reject({ code: "budget_exhausted", message: "动作频率超限" });
    await settle();
    expect(executor.status).toBe("error");
    expect(executor.cursor).toBe(1); // 光标不动(动作未执行)。
    expect(errors).toHaveLength(1);
    expect(errors[0]?.index).toBe(1);
    expect(errors[0]?.error?.code).toBe("budget_exhausted");
    expect(errors[0]?.error?.message).toBe("动作频率超限");

    // 重试由用户手动步进:同一动作重新提交。
    executor.stepOnce();
    await settle();
    expect(sink.sent).toHaveLength(3);
    expect(sink.sent[2]).toEqual({ type: "write_bytes", args: { addressHex: "0x1008", bytesHex: "41" } });
    sink.accept(2);
    await settle();
    expect(executor.status).toBe("done");
  });

  it("sendAction 抛错(断线)→ error 状态 + 客户端错误文案", async () => {
    const sink = new FakeSink();
    let throwing = false;
    const failingSink: PayloadActionSink = {
      sendAction(action) {
        if (throwing) {
          throw new Error("动作通道未连接");
        }
        sink.sendAction(action);
      },
      onActionResponse: (listener) => sink.onActionResponse(listener),
      onActionRejected: (listener) => sink.onActionRejected(listener),
    };
    const { executor, errors } = createExecutor(failingSink);
    executor.load(programOf(writeAction("0x1000")));
    throwing = true;
    executor.run();
    await settle();
    expect(executor.status).toBe("error");
    expect(errors[0]?.error).toBeNull();
    expect(errors[0]?.message).toBe("动作通道未连接");
    // 恢复通道后手动重试可继续。
    throwing = false;
    executor.stepOnce();
    await settle();
    sink.accept(1);
    await settle();
    expect(executor.status).toBe("done");
  });
});

// ── 间隔等待注入(限流实测反馈面)与 load 复位 ─────────────────────────────

describe("间隔等待注入与 load 复位", () => {
  it("stepIntervalMs > 0 时相邻步间注入等待", async () => {
    const sink = new FakeSink();
    const delays: number[] = [];
    const executor = new PayloadStepExecutor(sink, {
      stepIntervalMs: 25,
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    executor.load(programOf(writeAction("0x1000"), writeAction("0x1008")));
    executor.run();
    await settle();
    sink.accept(1);
    await settle();
    // 步间等待后提交第二步。
    expect(delays).toEqual([25]);
    sink.accept(2);
    await settle();
    expect(executor.status).toBe("done");
  });

  it("load 换程序复位游标与状态;事件按序分发", async () => {
    const sink = new FakeSink();
    const { executor, states } = createExecutor(sink);
    executor.load(programOf(writeAction("0x1000")));
    executor.run();
    await settle();
    sink.accept(1);
    await settle();
    executor.load(programOf(stepAction(), stepAction()));
    expect(executor.status).toBe("idle");
    expect(executor.cursor).toBe(0);
    executor.run();
    await settle();
    expect(sink.sent.at(-1)).toEqual({ type: "step", args: {} });
    expect(states.map((event) => event.status)).toContain("idle");
  });

  it("编译产物可直接驱动(编译器 → 执行器集成形态)", async () => {
    const sink = new FakeSink();
    const { executor } = createExecutor(sink);
    const compileState = {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: "payload_start",
            id: "start",
            next: {
              block: {
                type: "payload_breakpoint",
                id: "bp",
              },
            },
          },
        ],
      },
    };
    const result = compilePayload(compileState);
    expect(result.ok).toBe(true);
    if (result.ok) {
      executor.load(result.program);
      executor.run();
      await settle();
      // 只有断点:run 立即暂停于断点,零动作提交。
      expect(executor.status).toBe("paused");
      expect(sink.sent).toHaveLength(0);
    }
  });
});

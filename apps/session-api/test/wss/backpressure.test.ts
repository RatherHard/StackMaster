/**
 * 背压与通道构件单元测试(任务分解 WP-5 第 6 条;D-API-43 / D-API-44):
 *  - MessageRateLimiter:令牌桶确定性(注入时钟,I-4);
 *  - BoundedSendBuffer:FIFO 帧序、单飞写、有界溢出;
 *  - ActionChannelConnection × 替身 socket:慢消费者超限 → 错误帧 + close 1013
 *    (背压断开走断线恢复路径;不做服务端无界队列)。
 */
import { describe, expect, it } from "vitest";
import type { SessionCredentialClaims } from "@stackmaster/protocol/server-only";
import type { ActionResponse, WssFrame } from "@stackmaster/protocol";
import { WssFrameSchema } from "@stackmaster/protocol";

import { BoundedSendBuffer } from "../../src/wss/bounded-send-buffer.js";
import { MessageRateLimiter } from "../../src/wss/message-rate-limiter.js";
import { ActionChannelConnection } from "../../src/wss/wss-channel.js";
import { StubChannelSocket } from "./helpers/stub-socket.js";
import { SessionConnectionRegistry } from "../../src/wss/connection-registry.js";
import { createLogger } from "../../src/logger.js";
import type { LiveSessionManager } from "../../src/sessions/session-manager.js";

const TEST_LOGGER = createLogger({
  logLevel: "warn",
  nodeEnv: "test",
  logErrorStacks: false,
} as Parameters<typeof createLogger>[0]);

// ── MessageRateLimiter ──────────────────────────────────────────────────────

describe("通道消息频率限制(令牌桶,D-API-43)", () => {
  it("容量内放行、触顶确定性拒绝、按时间线性补充", () => {
    let nowMs = 0;
    const limiter = new MessageRateLimiter({ capacityPerSecond: 3, now: () => nowMs });

    expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(true);
    // 桶空:瞬时第 4 次 = 确定性拒绝(与隐藏状态无关)。
    expect(limiter.tryTake()).toBe(false);
    expect(limiter.tryTake()).toBe(false);

    // 500 ms 补充 1.5 个令牌 → 1 次放行后再拒。
    nowMs = 500;
    expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(false);

    // 长时间流逝:补充至多到桶容量(不无限累积)。
    nowMs = 60_000;
    expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(false);
  });

  it("同一事件序列恒同一结论(确定性,I-4)", () => {
    const run = (): boolean[] => {
      let nowMs = 0;
      const limiter = new MessageRateLimiter({ capacityPerSecond: 2, now: () => nowMs });
      return [0, 0, 100, 100, 100, 700].map((tick) => {
        nowMs = tick;
        return limiter.tryTake();
      });
    };
    expect(run()).toEqual(run());
  });
});

// ── BoundedSendBuffer ───────────────────────────────────────────────────────

describe("有界发送缓冲(背压,D-API-44)", () => {
  it("FIFO 出队 + 单飞写(帧序保持,前帧回调前不写下帧)", async () => {
    const written: string[] = [];
    const unacknowledged: ((error?: Error) => void)[] = [];
    const buffer = new BoundedSendBuffer({
      sink: (data, onWritten) => {
        // 单飞:进入 sink 时没有别的帧在写(无一挂起回调)。
        expect(unacknowledged.length).toBe(0);
        unacknowledged.push(onWritten);
        written.push(data);
      },
      limit: 8,
      onOverflow: () => undefined,
    });

    expect(buffer.enqueue("f1")).toBe(true);
    expect(buffer.enqueue("f2")).toBe(true);
    expect(written).toEqual(["f1"]); // f2 在队等待
    expect(buffer.pendingCount).toBe(2);

    unacknowledged.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(written).toEqual(["f1", "f2"]);
    unacknowledged.shift()?.();
    expect(buffer.isDrained()).toBe(true);
  });

  it("队列达到上限即溢出(一次性触发,不做无界队列)", async () => {
    const overflowCount: number[] = [];
    const unacknowledged: ((error?: Error) => void)[] = [];
    const buffer = new BoundedSendBuffer({
      sink: (_data, onWritten) => {
        // 慢消费者:写回调挂起,不释放。
        unacknowledged.push(onWritten);
      },
      limit: 2,
      onOverflow: () => overflowCount.push(1),
    });

    // f1 在写挂起,f2 / f3 入队(队列长 2 = 上限),f4 触发溢出。
    expect(buffer.enqueue("f1")).toBe(true);
    expect(buffer.enqueue("f2")).toBe(true);
    expect(buffer.enqueue("f3")).toBe(true);
    expect(buffer.enqueue("f4")).toBe(false); // 触发溢出
    expect(buffer.overflowed).toBe(true);
    expect(buffer.enqueue("f5")).toBe(false); // 溢出后一切拒绝
    expect(overflowCount).toHaveLength(1);

    buffer.dispose();
    expect(buffer.enqueue("f6")).toBe(false);
    await buffer.waitDrained(1);
  });

  it("waitDrained:清空即满足,挂起中超时返回 false", async () => {
    const buffer = new BoundedSendBuffer({
      sink: (_data, onWritten) => {
        // 永不回调:模拟慢消费者。
        void onWritten;
      },
      limit: 4,
      onOverflow: () => undefined,
    });
    buffer.enqueue("f1");
    expect(await buffer.waitDrained(20)).toBe(false);
  });
});

// ── ActionChannelConnection × 替身 socket:背压断开路径 ─────────────────────

const CLAIMS: SessionCredentialClaims = {
  sessionId: "sess-test-channel",
  tenantId: "tenant-alpha",
  userId: "user-42",
  challengeId: "chal-stack-escape",
  challengeVersion: "1.2.3",
  jti: "test-jti",
  expiresAt: 4_102_444_800,
};

const ACCEPTED_RESPONSE: ActionResponse = {
  requestId: "req-server-1",
  revision: 1,
  status: "running",
  projectionDelta: null,
  publicEvents: [],
};

function buildChannel(socket: StubChannelSocket, options: { sendBufferLimit: number }): ActionChannelConnection {
  const manager = {
    applyAction: async (): Promise<ActionResponse> => ACCEPTED_RESPONSE,
  } as unknown as LiveSessionManager;
  const registry = new SessionConnectionRegistry({
    logger: TEST_LOGGER,
    disconnectKeepaliveSeconds: 300,
    routeTtlSeconds: 300,
    ownerId: "test-owner",
  });
  const connection = new ActionChannelConnection({
    socket: socket,
    claims: CLAIMS,
    manager,
    idempotencyWindow: { checkAndRecord: async () => "fresh" },
    registry,
    logger: TEST_LOGGER,
    limits: { maxJsonDepth: 16, maxArrayLength: 256, maxStringLength: 4096 },
    heartbeatIntervalSeconds: 3600,
    idleTimeoutSeconds: 7200,
    messageRatePerSecond: 1000,
    sendBufferLimit: options.sendBufferLimit,
  });
  connection.start();
  return connection;
}

function frameText(seq: number): string {
  return JSON.stringify({
    protocolVersion: 1,
    type: "action",
    sessionId: CLAIMS.sessionId,
    seq,
    payload: {
      protocolVersion: 1,
      sessionId: CLAIMS.sessionId,
      clientSeq: seq,
      baseRevision: 0,
      idempotencyKey: `idem-bp-${seq}`,
      action: { type: "step", args: {} },
    },
  });
}

async function settleMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("背压断开路径(慢消费者超限,D-API-44)", () => {
  it("发送缓冲超限:断开前尽力直发错误帧(budget_exhausted)并 close 1013", async () => {
    const socket = new StubChannelSocket();
    const connection = buildChannel(socket, { sendBufferLimit: 2 });

    // 第 1 帧:响应写入后立即被消费(建立正常流);随后消费者停摆。
    socket.emitMessage(Buffer.from(frameText(1), "utf8"));
    await settleMicrotasks();
    socket.flushWrites();
    await settleMicrotasks();

    // 第 2 ~ 5 帧:响应 2 在写挂起,响应 3 / 4 填满队列,响应 5 触发溢出。
    for (let seq = 2; seq <= 5; seq += 1) {
      socket.emitMessage(Buffer.from(frameText(seq), "utf8"));
      await settleMicrotasks();
    }

    // 溢出路径:错误帧绕过缓冲直发 + close 1013(不做无界队列)。
    const errorWrite = socket.sent.find((data) => data.includes("send buffer limit exceeded"));
    expect(errorWrite).toBeDefined();
    const parsedError = WssFrameSchema.parse(JSON.parse(errorWrite ?? "{}") as WssFrame);
    expect(parsedError.type).toBe("error");
    if (parsedError.type === "error") {
      expect(parsedError.payload.code).toBe("budget_exhausted");
      expect(parsedError.payload.message).toBe("send buffer limit exceeded");
    }
    expect(socket.closes.at(-1)?.code).toBe(1013);

    // 消费者追上后停机收尾路径照常(waitDrained 满足,不再悬挂)。
    await socket.drainFully();
    await connection.closeForShutdown();
  });

  it("消费正常时缓冲不积压:响应帧按 FIFO 全量下发(帧序 = 执行序)", async () => {
    const socket = new StubChannelSocket();
    const connection = buildChannel(socket, { sendBufferLimit: 8 });

    for (let seq = 1; seq <= 3; seq += 1) {
      socket.emitMessage(Buffer.from(frameText(seq), "utf8"));
      await settleMicrotasks();
      socket.flushWrites();
      await settleMicrotasks();
    }
    expect(socket.sent).toHaveLength(3);
    socket.sent
      .map((data) => WssFrameSchema.parse(JSON.parse(data) as WssFrame))
      .forEach((frame, index) => {
        expect(frame.type).toBe("action_response");
        expect(frame.seq).toBe(index + 1);
      });
    expect(connection.isClosed).toBe(false);
  });
});

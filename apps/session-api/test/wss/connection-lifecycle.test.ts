/**
 * WSS 通道连接生命周期测试(任务分解 WP-5 第 4 / 5 条;D-API-40 / 42 / 45 / 49):
 * 断线保持计时器(启动 / 重连取消 / 到期钩子 + route 键释放)、多连接踢旧、
 * 心跳空闲判定、停机收尾。
 *
 * 驱动方式:真实 ActionChannelConnection + StubChannelSocket(事件手动派发、
 * 心跳用真实短定时器)。injectWS 的 Duplexify 模拟传输不把"客户端发起 close"
 * 传播为服务端 close 事件,故断线 / 保持窗口路径在此以替身 socket 直驱事件面;
 * 真实传输面的握手 / 帧收发 / 服务端主动关闭由 channel.integration.test.ts 覆盖。
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionCredentialClaims } from "@stackmaster/protocol/server-only";
import type { ActionResponse } from "@stackmaster/protocol";
import { WssFrameSchema } from "@stackmaster/protocol";

import { ActionChannelConnection } from "../../src/wss/wss-channel.js";
import { SessionConnectionRegistry } from "../../src/wss/connection-registry.js";
import { MemoryRouteStore } from "../../src/persistence/index.js";
import { createLogger } from "../../src/logger.js";
import { StubChannelSocket } from "./helpers/stub-socket.js";
import type { LiveSessionManager } from "../../src/sessions/session-manager.js";

const TEST_LOGGER = createLogger({
  logLevel: "warn",
  nodeEnv: "test",
  logErrorStacks: false,
} as Parameters<typeof createLogger>[0]);

const CLAIMS: SessionCredentialClaims = {
  sessionId: "sess-lifecycle",
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

interface LifecycleHarness {
  readonly routeStore: MemoryRouteStore;
  readonly registry: SessionConnectionRegistry;
  readonly expired: { sessionId: string; tenantId: string }[];
  connect(): { socket: StubChannelSocket; connection: ActionChannelConnection };
}

/**
 * 真实连接 × 替身 socket 装配:每次 connect() 生成一条新连接(升级完成后的
 * 形态,start() 即激活注册表)。
 */
function buildHarness(input: {
  disconnectKeepaliveSeconds: number;
  heartbeatIntervalSeconds?: number;
  idleTimeoutSeconds?: number;
}): LifecycleHarness {
  const manager = {
    applyAction: async (): Promise<ActionResponse> => ACCEPTED_RESPONSE,
  } as unknown as LiveSessionManager;
  const routeStore = new MemoryRouteStore();
  const expired: { sessionId: string; tenantId: string }[] = [];
  const registry = new SessionConnectionRegistry({
    logger: TEST_LOGGER,
    disconnectKeepaliveSeconds: input.disconnectKeepaliveSeconds,
    routeStore,
    routeTtlSeconds: 300,
    ownerId: "owner-test",
    onKeepaliveExpiry: (session) => {
      expired.push(session);
    },
  });
  return {
    routeStore,
    registry,
    expired,
    connect() {
      const socket = new StubChannelSocket();
      const connection = new ActionChannelConnection({
        socket,
        claims: CLAIMS,
        manager,
        idempotencyWindow: { checkAndRecord: async () => "fresh" },
        registry,
        logger: TEST_LOGGER,
        limits: { maxJsonDepth: 16, maxArrayLength: 256, maxStringLength: 4096 },
        heartbeatIntervalSeconds: input.heartbeatIntervalSeconds ?? 3600,
        idleTimeoutSeconds: input.idleTimeoutSeconds ?? 7200,
        messageRatePerSecond: 1000,
        sendBufferLimit: 64,
      });
      connection.start();
      return { socket, connection };
    },
  };
}

describe("断线保持窗口(D-API-45;计时器启动 / 取消归 WP-5,回收执行面归 WP-6)", () => {
  it("最后连接断开 → 计时器启动(route 键保持);重连 → 计时器取消;到期 → 钩子 + route 键释放", async () => {
    const harness = buildHarness({ disconnectKeepaliveSeconds: 0.15 });
    const first = harness.connect();
    expect(harness.registry.hasActive(CLAIMS.sessionId)).toBe(true);
    // 激活即绑定路由键(T0 单实例消费,D-API-49)。
    await expect(harness.routeStore.resolve(CLAIMS.sessionId)).resolves.toBe("owner-test");

    // 断开(服务端视角 close)→ 会话保持:计时器启动,route 键在窗口内仍在。
    first.socket.emitClose();
    expect(harness.registry.hasActive(CLAIMS.sessionId)).toBe(false);
    expect(harness.registry.keepalivePendingSessionIds()).toEqual([CLAIMS.sessionId]);
    await expect(harness.routeStore.resolve(CLAIMS.sessionId)).resolves.toBe("owner-test");

    // 重连 → 计时器取消(§4.2.3:会话保持、状态可对齐,不触发回收)。
    const second = harness.connect();
    expect(harness.registry.keepalivePendingSessionIds()).toEqual([]);

    // 再次断开且不重连 → 到期:钩子恰好一次,route 键释放。
    second.socket.emitClose();
    await vi.waitFor(
      () => {
        if (harness.expired.length === 0) {
          throw new Error("等待保持窗口到期超时");
        }
      },
      { timeout: 3000, interval: 10 },
    );
    expect(harness.expired).toEqual([{ sessionId: CLAIMS.sessionId, tenantId: CLAIMS.tenantId }]);
    await expect(harness.routeStore.resolve(CLAIMS.sessionId)).resolves.toBeNull();
    expect(harness.registry.keepalivePendingSessionIds()).toEqual([]);
  });
});

describe("多连接踢旧(D-API-40)", () => {
  it("同会话第二连接激活 → 旧连接收错误帧说明 + close 1008,注册表单属主,新连接可用", async () => {
    const harness = buildHarness({ disconnectKeepaliveSeconds: 5 });
    const first = harness.connect();
    const second = harness.connect();

    // 旧连接:错误帧(connection replaced)→ close 1008。
    expect(first.socket.sent).toHaveLength(1);
    const kickFrame = first.socket.sent[0] ?? "{}";
    const kick = WssFrameSchema.parse(JSON.parse(kickFrame) as never);
    expect(kick.type).toBe("error");
    if (kick.type === "error") {
      expect(kick.payload.message).toBe("connection replaced");
    }
    expect(first.socket.closes.at(-1)?.code).toBe(1008);

    // 注册表单属主:新连接可用,串行不变性底线(每会话至多一条活跃通道)。
    expect(harness.registry.hasActive(CLAIMS.sessionId)).toBe(true);
    second.socket.emitMessage(Buffer.from(JSON.stringify({
      protocolVersion: 1,
      type: "action",
      sessionId: CLAIMS.sessionId,
      seq: 1,
      payload: {
        protocolVersion: 1,
        sessionId: CLAIMS.sessionId,
        clientSeq: 1,
        baseRevision: 0,
        idempotencyKey: "idem-kick-1",
        action: { type: "step", args: {} },
      },
    }), "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const responses = second.socket.sent.map((data) => WssFrameSchema.parse(JSON.parse(data) as never));
    expect(responses.some((frame) => frame.type === "action_response")).toBe(true);

    // 旧连接收尾:close 事件后注销,不触发保持计时器(会话仍有活跃通道)。
    first.socket.emitClose();
    expect(harness.registry.hasActive(CLAIMS.sessionId)).toBe(true);
    expect(harness.registry.keepalivePendingSessionIds()).toEqual([]);
  });
});

describe("心跳与空闲(D-API-42;真实短定时器 + 替身 socket)", () => {
  it("活跃连接在心跳节拍下被 ping 且不被判空闲(pong 缺席但窗口未满)", async () => {
    const harness = buildHarness({
      disconnectKeepaliveSeconds: 5,
      heartbeatIntervalSeconds: 0.02,
      idleTimeoutSeconds: 3,
    });
    const { socket } = harness.connect();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(socket.pingCount).toBeGreaterThanOrEqual(2);
    expect(socket.closes).toHaveLength(0);
  });

  it("静默超过空闲阈值 → 错误帧(connection idle timeout)+ close 1000,且只触发一次", async () => {
    const harness = buildHarness({
      disconnectKeepaliveSeconds: 5,
      heartbeatIntervalSeconds: 0.02,
      idleTimeoutSeconds: 0.08,
    });
    const { socket, connection } = harness.connect();
    await vi.waitFor(
      () => {
        if (!socket.sent.some((data) => data.includes("connection idle timeout"))) {
          throw new Error("等待空闲错误帧超时");
        }
      },
      { timeout: 3000, interval: 10 },
    );
    const idleError = WssFrameSchema.parse(
      JSON.parse(socket.sent.find((data) => data.includes("connection idle timeout")) ?? "{}") as never,
    );
    expect(idleError.type).toBe("error");
    if (idleError.type === "error") {
      expect(idleError.payload.code).toBe("budget_exhausted");
    }
    await vi.waitFor(
      () => {
        if (socket.closes.at(-1)?.code !== 1000) {
          throw new Error("等待空闲关闭超时");
        }
      },
      { timeout: 3000, interval: 10 },
    );
    // 关闭发起后节拍重入被抑制:不再追加 close / 错误帧。
    const closeCount = socket.closes.length;
    const sentCount = socket.sent.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(socket.closes.length).toBe(closeCount);
    expect(socket.sent.length).toBe(sentCount);
    expect(connection.isClosed).toBe(false); // 等待对端 close 握手(替身不回),事件面收尾
  });
});

describe("停机收尾(D-API-48)", () => {
  it("closeAll:冲刷发送缓冲 → 全部活跃连接 close 1001 → 注册表清空、计时器取消", async () => {
    const harness = buildHarness({ disconnectKeepaliveSeconds: 0.1 });
    const first = harness.connect();
    const second = harness.connect();
    first.socket.emitClose();
    await new Promise((resolve) => setTimeout(resolve, 10)); // 保持计时器待到期

    await harness.registry.closeAll();
    expect(second.socket.closes.at(-1)?.code).toBe(1001);
    expect(harness.registry.activeCount).toBe(0);
    // 待到期的保持计时器随停机取消(会话状态由停机冲刷落盘,回收归重启恢复)。
    expect(harness.registry.keepalivePendingSessionIds()).toEqual([]);
  });
});

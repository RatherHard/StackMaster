/**
 * SessionClient 全链路测试(WP-F2):mock fetch / mock WebSocket 驱动,
 * 不开真实套接字。覆盖:REST 5 命令与 Cookie 语义、动作信封账本
 * (clientSeq / baseRevision / idempotencyKey)、rejected 耦合、增量应用与
 * revision 演进、truncated → 自动 sync-projection、断线保留投影 + 指数退避
 * 重连 + sync 对齐、版本锚定首帧、踢旧连接单连接策略、429 限流帧分发。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { SessionClient, type ConnectionStatusEvent } from "../../src/client/session-client.js";
import { SessionClientError, SessionCommandError } from "../../src/client/session-errors.js";
import { resolveWebSocketUrl } from "../../src/client/transport.js";
import {
  CREATE_INPUT,
  FakeFrames,
  FakeTimers,
  FakeWebSocket,
  SESSION_COOKIE,
  SESSION_ID,
  createMockFetch,
  fakeWebSocketFactory,
  makeActionResponse,
  makeDelta,
  makeProjection,
  serverFrame,
  settle,
  stepAction,
  writeAction,
  type MockFetch,
} from "../helpers/fixtures.js";

/** 测试装配体:mock 全套依赖的 SessionClient。 */
interface Harness {
  readonly client: SessionClient;
  readonly mockFetch: MockFetch;
  readonly frames: FakeFrames;
  readonly timers: FakeTimers;
  readonly statusEvents: ConnectionStatusEvent[];
}

interface HarnessOptions {
  /** sync-projection 返回的 revision(默认恒 5)。 */
  readonly syncRevision?: () => number;
}

function createHarness(options: HarnessOptions = {}): Harness {
  FakeWebSocket.reset();
  const frames = new FakeFrames();
  const timers = new FakeTimers();
  const syncRevision = options.syncRevision ?? (() => 5);
  const mockFetch = createMockFetch((request) => {
    const path = new URL(request.url).pathname;
    switch (path) {
      case "/sessions":
        return {
          status: 201,
          body: {
            command: "create_session",
            payload: { sessionId: SESSION_ID, revision: 0, projection: makeProjection() },
          },
          setCookie: `${SESSION_COOKIE}; Path=/sessions; HttpOnly; SameSite=Strict`,
        };
      case "/sessions/projection-sync":
        return {
          status: 200,
          body: {
            command: "sync_projection",
            payload: {
              revision: syncRevision(),
              projection: makeProjection({ revision: syncRevision() }),
            },
          },
        };
      case "/sessions/checkpoints":
        return {
          status: 200,
          body: { command: "list_checkpoints", payload: { checkpoints: [] } },
        };
      case "/sessions/submissions":
        return {
          status: 200,
          body: { command: "submit", payload: { submissionId: "submission-0001", revision: 0 } },
        };
      case "/sessions/close":
        return { status: 200, body: { command: "close_session", payload: { revision: 3 } } };
      default:
        return {
          status: 404,
          body: { code: "internal_error", message: "no such route (mock)" },
        };
    }
  });
  let keyCounter = 0;
  const statusEvents: ConnectionStatusEvent[] = [];
  const client = new SessionClient({
    fetch: mockFetch.fetch,
    webSocketFactory: fakeWebSocketFactory,
    raf: frames.raf,
    cancelRaf: frames.cancelRaf,
    scheduleTimer: timers.schedule,
    cancelTimer: timers.cancel,
    generateIdempotencyKey: () => `key-${String((keyCounter += 1)).padStart(4, "0")}`,
    baseUrl: "http://127.0.0.1:13000",
    reconnect: { initialDelayMs: 500, maxDelayMs: 8000 },
  });
  client.onConnectionStatus((event) => statusEvents.push(event));
  return { client, mockFetch, frames, timers, statusEvents };
}

/** 装配到"已建会话 + 已连接"状态(create → connect → accept),返回当前套接字。 */
async function createAndConnect(harness: Harness): Promise<FakeWebSocket> {
  await harness.client.createSession(CREATE_INPUT);
  harness.client.connect();
  const socket = FakeWebSocket.last;
  socket.serverAccepts();
  return socket;
}

/** 取第 n 个已发送帧的 requestId(响应关联键)。 */
function requestKey(socket: FakeWebSocket, index: number): string {
  const frame = socket.sent[index] as { requestId?: string } | undefined;
  return frame?.requestId ?? "";
}

beforeEach(() => {
  FakeWebSocket.reset();
});

// ── REST 5 命令 ─────────────────────────────────────────────────────────────

describe("SessionClient REST 5 命令", () => {
  it("create_session 以冻结信封 POST /sessions,携带 credentials include,响应写入投影存储", async () => {
    const harness = createHarness();
    const response = await harness.client.createSession(CREATE_INPUT);

    expect(response.command).toBe("create_session");
    expect(response.payload.sessionId).toBe(SESSION_ID);
    expect(harness.client.sessionId).toBe(SESSION_ID);
    const call = harness.mockFetch.calls[0];
    expect(call?.url).toBe("http://127.0.0.1:13000/sessions");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.credentials).toBe("include");
    expect(call?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(call?.init.body))).toEqual({
      protocolVersion: 1,
      command: "create_session",
      payload: { ...CREATE_INPUT },
    });
    // 初始公开投影已入存储(revision 0 = 首个动作 baseRevision 的对齐锚)。
    expect(harness.client.store.revision).toBe(0);
    expect(harness.client.projection?.visibleRegions[0]?.regionId).toBe("region-stack");
  });

  it("create_session 的 Set-Cookie 被后续命令携带(mock Cookie 罐语义)", async () => {
    const harness = createHarness();
    await harness.client.createSession(CREATE_INPUT);
    expect(harness.mockFetch.calls[0]?.cookieHeader).toBeNull();

    await harness.client.syncProjection();
    expect(harness.mockFetch.lastCall().cookieHeader).toBe(SESSION_COOKIE);
  });

  it("四个凭证保护命令各对应冻结路由,请求体只含 sessionId 载荷", async () => {
    const harness = createHarness();
    await harness.client.createSession(CREATE_INPUT);

    await harness.client.syncProjection();
    await harness.client.listCheckpoints();
    await harness.client.submit();
    await harness.client.closeSession();

    const rest = harness.mockFetch.calls.slice(1);
    expect(rest.map((call) => new URL(call.url).pathname)).toEqual([
      "/sessions/projection-sync",
      "/sessions/checkpoints",
      "/sessions/submissions",
      "/sessions/close",
    ]);
    expect(rest.map((call) => JSON.parse(String(call.init.body)).command)).toEqual([
      "sync_projection",
      "list_checkpoints",
      "submit",
      "close_session",
    ]);
    for (const call of rest) {
      const body = JSON.parse(String(call.init.body));
      expect(body.protocolVersion).toBe(1);
      expect(body.payload).toEqual({ sessionId: SESSION_ID });
      expect(call.init.credentials).toBe("include");
    }
  });

  it("REST 429 限流(budget_exhausted 冻结形态)抛 SessionCommandError 并分发命令错误", async () => {
    FakeWebSocket.reset();
    const commandErrors: SessionCommandError[] = [];
    const mockFetch = createMockFetch(() => ({
      status: 429,
      body: { code: "budget_exhausted", message: "rate limit exceeded (mock)" },
    }));
    const client = new SessionClient({ fetch: mockFetch.fetch });
    client.onCommandError((error) => commandErrors.push(error));

    await expect(client.createSession(CREATE_INPUT)).rejects.toBeInstanceOf(SessionCommandError);
    expect(commandErrors).toHaveLength(1);
    expect(commandErrors[0]?.httpStatus).toBe(429);
    expect(commandErrors[0]?.publicError.code).toBe("budget_exhausted");
  });

  it("REST 失败响应体非 JSON 时合成为 internal_error 兜底(零网关细节透出)", async () => {
    FakeWebSocket.reset();
    const mockFetch = createMockFetch(() => ({
      status: 502,
      body: undefined,
      malformedJson: true,
    }));
    const client = new SessionClient({ fetch: mockFetch.fetch });
    await expect(client.createSession(CREATE_INPUT)).rejects.toMatchObject({
      httpStatus: 502,
    });
    await expect(client.createSession(CREATE_INPUT)).rejects.toSatisfy(
      (error: SessionCommandError) => error.publicError.code === "internal_error",
    );
  });

  it("缺省幂等键生成器在无 crypto.randomUUID 环境确定性失败(提示注入)", async () => {
    FakeWebSocket.reset();
    const mockFetch = createMockFetch((request) => {
      if (new URL(request.url).pathname === "/sessions") {
        return {
          status: 201,
          body: {
            command: "create_session",
            payload: { sessionId: SESSION_ID, revision: 0, projection: makeProjection() },
          },
          setCookie: `${SESSION_COOKIE}; Path=/sessions`,
        };
      }
      throw new Error("unexpected route (mock)");
    });
    const frames = new FakeFrames();
    const client = new SessionClient({
      fetch: mockFetch.fetch,
      webSocketFactory: fakeWebSocketFactory,
      raf: frames.raf,
      cancelRaf: frames.cancelRaf,
    });
    // globalThis.crypto 是 getter-only:经 defineProperty 临时摘除再还原。
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    try {
      await client.createSession(CREATE_INPUT);
      client.connect();
      FakeWebSocket.last.serverAccepts();
      expect(() => client.sendAction(stepAction())).toThrow("generateIdempotencyKey");
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(globalThis, "crypto", descriptor);
      }
      client.dispose();
    }
  });

  it("尚未 createSession 时命令抛 no_session", async () => {
    const harness = createHarness();
    await expect(harness.client.syncProjection()).rejects.toMatchObject({ code: "no_session" });
  });
});

// ── 认证 WSS:连接与动作信封 ────────────────────────────────────────────────

describe("SessionClient 认证 WSS 通道", () => {
  it("connect 经 baseUrl 解析 /sessions/channel 升级地址并进入 connected", async () => {
    const harness = createHarness();
    expect(resolveWebSocketUrl("http://127.0.0.1:13000")).toBe(
      "ws://127.0.0.1:13000/sessions/channel",
    );
    expect(resolveWebSocketUrl("https://example.host")).toBe("wss://example.host/sessions/channel");

    await harness.client.createSession(CREATE_INPUT);
    harness.client.connect();
    expect(FakeWebSocket.last.url).toBe("ws://127.0.0.1:13000/sessions/channel");
    FakeWebSocket.last.serverAccepts();
    expect(harness.client.status).toBe("connected");
    expect(harness.statusEvents.map((event) => event.status)).toEqual(["connecting", "connected"]);
  });

  it("首连不触发 sync-projection(初始投影随 create_session 交付)", async () => {
    const harness = createHarness();
    await createAndConnect(harness);
    expect(
      harness.mockFetch.calls.some((call) => call.url.endsWith("/sessions/projection-sync")),
    ).toBe(false);
  });

  it("每帧携带 protocolVersion 完成连接级锚定,客户端只发 action 帧", async () => {
    const harness = createHarness();
    const socket = await createAndConnect(harness);

    harness.client.sendAction(stepAction());
    harness.client.sendAction(stepAction());
    expect(socket.sent).toHaveLength(2);
    for (const frame of socket.sent) {
      expect(frame).toMatchObject({ protocolVersion: 1, type: "action", sessionId: SESSION_ID });
      expect(frame).toHaveProperty("payload.protocolVersion", 1);
    }
  });

  it("动作信封:clientSeq 自 1 严格递增、传输 seq 连接内递增、idempotencyKey 每动作唯一", async () => {
    const harness = createHarness();
    const socket = await createAndConnect(harness);

    harness.client.sendAction(stepAction());
    harness.client.sendAction(writeAction("0x1000", "aabb"));
    harness.client.sendAction(stepAction());

    const frames = socket.sent as Array<Record<string, unknown>>;
    expect(frames.map((frame) => frame.seq)).toEqual([1, 2, 3]);
    expect(frames.map((frame) => (frame.payload as Record<string, unknown>).clientSeq)).toEqual([
      1, 2, 3,
    ]);
    const keys = frames.map((frame) => (frame.payload as Record<string, unknown>).idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    expect(harness.client.lastClientSeq).toBe(3);
    // requestId 以幂等键承载(响应帧回显,传输层关联与载荷账本同键)。
    expect(frames.map((frame) => frame.requestId)).toEqual(keys);
  });

  it("baseRevision 对齐最近已知投影 revision,并随已执行响应演进", async () => {
    const harness = createHarness();
    const socket = await createAndConnect(harness);

    harness.client.sendAction(stepAction());
    const first = socket.sent[0] as { payload: { baseRevision: number; idempotencyKey: string } };
    expect(first.payload.baseRevision).toBe(0);

    socket.serverSends(
      serverFrame(
        "action_response",
        makeActionResponse({ revision: 1, status: "paused" }),
        1,
        first.payload.idempotencyKey,
      ),
    );
    harness.frames.flush();

    harness.client.sendAction(stepAction());
    const second = socket.sent[1] as { payload: { baseRevision: number } };
    expect(second.payload.baseRevision).toBe(1);
  });

  it("create_session 重建会话时账本重置(clientSeq 归零重计、通道按单连接策略换新)", async () => {
    const harness = createHarness();
    const firstSocket = await createAndConnect(harness);
    harness.client.sendAction(stepAction());
    expect(harness.client.lastClientSeq).toBe(1);

    await harness.client.createSession(CREATE_INPUT);
    expect(harness.client.lastClientSeq).toBe(0);

    harness.client.connect();
    const nextSocket = FakeWebSocket.last;
    expect(nextSocket).not.toBe(firstSocket);
    nextSocket.serverAccepts();
    harness.client.sendAction(stepAction());
    const frame = nextSocket.sent[0] as {
      seq: number;
      payload: { clientSeq: number; baseRevision: number };
    };
    expect(frame.seq).toBe(1);
    expect(frame.payload.clientSeq).toBe(1);
  });
});

// ── 响应处理:增量、拒绝、truncated、错误帧 ─────────────────────────────────

describe("SessionClient 动作响应处理", () => {
  it("响应增量入队后于 rAF 帧内批量应用,多响应合帧单次通知", async () => {
    const harness = createHarness();
    const socket = await createAndConnect(harness);
    const notifications: number[] = [];
    harness.client.onProjectionChanged(() =>
      notifications.push(harness.client.store.revision ?? -1),
    );

    harness.client.sendAction(stepAction());
    harness.client.sendAction(stepAction());
    socket.serverSends(
      serverFrame(
        "action_response",
        makeActionResponse({
          revision: 1,
          status: "running",
          projectionDelta: makeDelta({
            revision: 1,
            dirtyRanges: [
              { regionId: "region-stack", startAddressHex: "0x1002", bytesHex: "aabb" },
            ],
          }),
        }),
        1,
        requestKey(socket, 0),
      ),
    );
    socket.serverSends(
      serverFrame(
        "action_response",
        makeActionResponse({
          revision: 2,
          status: "running",
          projectionDelta: makeDelta({
            revision: 2,
            dirtyRanges: [
              { regionId: "region-stack", startAddressHex: "0x1003", bytesHex: "ccdd" },
            ],
          }),
        }),
        2,
        requestKey(socket, 1),
      ),
    );

    // 帧前:增量未应用(入队),零通知。
    expect(harness.frames.scheduledCount).toBe(1);
    expect(harness.client.store.revision).toBe(0);
    expect(notifications).toHaveLength(0);

    harness.frames.flush();
    // 合帧:两个增量单帧批应用,通知恰一次,字节按序合并。
    expect(harness.client.store.revision).toBe(2);
    expect(notifications).toEqual([2]);
    expect(harness.client.projection?.visibleRegions[0]?.bytesHex).toBe("0102aaccdd060708");
  });

  it("rejected 耦合:错误事件立即分发、投影与 revision 不动", async () => {
    const harness = createHarness();
    const socket = await createAndConnect(harness);
    const rejected: Array<{ code: string; revision: number }> = [];
    harness.client.onActionRejected((error, response) => {
      rejected.push({ code: error.code, revision: response.revision });
    });

    harness.client.sendAction(writeAction("0x9999", "aabb"));
    socket.serverSends(
      serverFrame(
        "action_response",
        makeActionResponse({
          revision: 0,
          status: "rejected",
          userVisibleError: {
            code: "inaccessible_address",
            message: "目标地址不可见(mock)",
            addressHex: null,
          },
        }),
        1,
        requestKey(socket, 0),
      ),
    );

    // rejected 立即分发(离散事件,不经 rAF)。
    expect(rejected).toEqual([{ code: "inaccessible_address", revision: 0 }]);
    harness.frames.flush();
    // 投影与 revision 保持原状(拒绝不前进,零本地推导)。
    expect(harness.client.store.revision).toBe(0);
    expect(harness.client.projection?.visibleRegions[0]?.bytesHex).toBe("0102030405060708");
  });

  it("无 delta 的已执行动作(create_checkpoint 类)仅前进 revision", async () => {
    const harness = createHarness();
    const socket = await createAndConnect(harness);

    harness.client.sendAction(stepAction());
    socket.serverSends(
      serverFrame(
        "action_response",
        makeActionResponse({ revision: 1, status: "paused" }),
        1,
        requestKey(socket, 0),
      ),
    );
    harness.frames.flush();

    expect(harness.client.store.revision).toBe(1);
    expect(harness.client.projection?.visibleRegions[0]?.bytesHex).toBe("0102030405060708");
  });

  it("增量整体替换字段:changedRegisters 按名替换、controlFlow/status/callStackSummary 替换", async () => {
    const harness = createHarness();
    const socket = await createAndConnect(harness);

    harness.client.sendAction(stepAction());
    socket.serverSends(
      serverFrame(
        "action_response",
        makeActionResponse({
          revision: 1,
          status: "paused",
          projectionDelta: makeDelta({
            revision: 1,
            changedRegisters: [{ name: "RSP", valueHex: "0xBFF8" }],
            controlFlow: {
              currentInstruction: { addressHex: "0x0042", text: "mov rbp, rsp" },
              pausedOn: "call",
            },
            status: "paused",
            callStackSummary: [
              { index: 0, functionLabel: "main", returnAddressHex: "0x0045" },
            ],
          }),
        }),
        1,
        requestKey(socket, 0),
      ),
    );
    harness.frames.flush();

    const projection = harness.client.projection;
    expect(projection?.visibleRegisters.map((register) => register.valueHex)).toEqual([
      "0xBFF8",
      "0xB008",
    ]);
    expect(projection?.controlFlow.currentInstruction.text).toBe("mov rbp, rsp");
    expect(projection?.status).toBe("paused");
    expect(projection?.callStackSummary[0]?.functionLabel).toBe("main");
  });

  it("dirtyRange 带 truncated 标记 ⇒ 帧内应用后自动 sync-projection 重新对齐", async () => {
    const harness = createHarness({ syncRevision: () => 7 });
    const socket = await createAndConnect(harness);

    harness.client.sendAction(stepAction());
    socket.serverSends(
      serverFrame(
        "action_response",
        makeActionResponse({
          revision: 1,
          status: "running",
          projectionDelta: makeDelta({
            revision: 1,
            dirtyRanges: [
              {
                regionId: "region-stack",
                startAddressHex: "0x1004",
                bytesHex: "aabbccdd",
                truncated: true,
              },
            ],
          }),
        }),
        1,
        requestKey(socket, 0),
      ),
    );
    harness.frames.flush();
    await settle();

    // sanctioned 路径(9.1):sync-projection 重发最近完整投影,以新 revision 继续。
    const syncCall = harness.mockFetch.calls
      .slice(1)
      .find((call) => call.url.endsWith("/sessions/projection-sync"));
    expect(syncCall).toBeDefined();
    expect(JSON.parse(String(syncCall?.init.body)).payload).toEqual({ sessionId: SESSION_ID });
    expect(harness.client.store.revision).toBe(7);

    harness.client.sendAction(stepAction());
    const sent = socket.sent[1] as { payload: { baseRevision: number } };
    expect(sent.payload.baseRevision).toBe(7);
  });

  it("429 限流错误帧(budget_exhausted)分发通道错误,连接保持", async () => {
    const harness = createHarness();
    const socket = await createAndConnect(harness);
    const channelErrors: Array<{ code: string; source: string }> = [];
    harness.client.onChannelError((error, source) =>
      channelErrors.push({ code: error.code, source }),
    );

    socket.serverSends(
      serverFrame("error", { code: "budget_exhausted", message: "message rate limit exceeded" }, 1),
    );

    expect(channelErrors).toEqual([{ code: "budget_exhausted", source: "server-frame" }]);
    expect(harness.client.status).toBe("connected");
  });

  it("畸形通道帧(JSON 不可解析 / 契约漂移 / 方向违规)分发 client-frame 通道错误", async () => {
    const harness = createHarness();
    const socket = await createAndConnect(harness);
    const sources: string[] = [];
    harness.client.onChannelError((_error, source) => sources.push(source));

    socket.serverSendsText("not-json{");
    socket.serverSends({ unexpected: true });
    socket.serverSends(
      serverFrame("action", {
        protocolVersion: 1,
        sessionId: SESSION_ID,
        clientSeq: 1,
        baseRevision: 0,
        idempotencyKey: "k",
        action: { type: "step", args: {} },
      }),
    );
    expect(sources).toEqual(["client-frame", "client-frame", "client-frame"]);
    expect(harness.client.status).toBe("connected");
  });
});

// ── 断线重连与状态机 ─────────────────────────────────────────────────────────

describe("SessionClient 断线重连", () => {
  it("断线保留最近公开投影,指数退避重连,成功后立即 sync 对齐并以新 revision 继续", async () => {
    const harness = createHarness({ syncRevision: () => 5 });
    const socket = await createAndConnect(harness);
    harness.client.sendAction(stepAction());
    socket.serverSends(
      serverFrame(
        "action_response",
        makeActionResponse({
          revision: 1,
          status: "running",
          projectionDelta: makeDelta({
            revision: 1,
            dirtyRanges: [
              { regionId: "region-stack", startAddressHex: "0x1000", bytesHex: "ffee" },
            ],
          }),
        }),
        1,
        requestKey(socket, 0),
      ),
    );
    harness.frames.flush();

    // 服务端空闲超时(D-API-48:close 1000)断开。
    socket.serverCloses(1000, "idle timeout");
    expect(harness.client.status).toBe("reconnecting");
    expect(harness.statusEvents.at(-1)).toMatchObject({
      status: "reconnecting",
      closeCode: 1000,
      reason: "idle-timeout",
      attempt: 1,
      retryDelayMs: 500,
    });
    // 只展示最近投影:断线期间快照不变(零本地 VM 降级)。
    expect(harness.client.store.revision).toBe(1);
    expect(harness.client.projection?.visibleRegions[0]?.bytesHex).toBe("ffee030405060708");

    // 退避到期 → 新连接(传输 seq 归零);clientSeq 不随重连重置。
    await harness.timers.runNext();
    const reconnected = FakeWebSocket.last;
    expect(reconnected).not.toBe(socket);
    reconnected.serverAccepts();
    await settle();

    const syncCall = harness.mockFetch.calls
      .slice(1)
      .find((call) => call.url.endsWith("/sessions/projection-sync"));
    expect(syncCall).toBeDefined();
    expect(JSON.parse(String(syncCall?.init.body)).payload).toEqual({ sessionId: SESSION_ID });
    expect(harness.client.store.revision).toBe(5);
    expect(harness.client.status).toBe("connected");

    harness.client.sendAction(stepAction());
    const frame = reconnected.sent[0] as {
      seq: number;
      payload: { clientSeq: number; baseRevision: number };
    };
    expect(frame.seq).toBe(1); // 传输层 seq 连接内从 1 重计。
    expect(frame.payload.clientSeq).toBe(2); // 会话级 clientSeq 继续。
    expect(frame.payload.baseRevision).toBe(5); // 以对齐后的 revision 继续。
  });

  it("指数退避按 2^n 增长并被 maxDelayMs 封顶(连续失败不成功打开)", async () => {
    const harness = createHarness();
    await harness.client.createSession(CREATE_INPUT);
    harness.client.connect();
    FakeWebSocket.last.serverAccepts();

    // 每轮:关闭当前连接(退避调度)→ 定时器到期重开新连接(仍不开门)→ 再关。
    // 尝试计数只在成功 open 时归零,延迟序列即 initial·2^n 并被上限封顶。
    const delays: Array<number | null> = [];
    for (let round = 1; round <= 6; round += 1) {
      FakeWebSocket.last.serverCloses(1001, "server shutting down");
      delays.push(harness.statusEvents.at(-1)?.retryDelayMs ?? null);
      await harness.timers.runNext();
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
  });

  it("踢旧连接(replaced 错误帧 + close 1008)处理为单连接策略:不自动重连", async () => {
    const harness = createHarness();
    const socket = await createAndConnect(harness);

    socket.serverSends(
      serverFrame("error", { code: "invalid_input_format", message: "connection replaced" }, 1),
    );
    socket.serverCloses(1008, "connection replaced");

    expect(harness.client.status).toBe("disconnected");
    expect(harness.statusEvents.at(-1)).toMatchObject({
      status: "disconnected",
      closeCode: 1008,
      reason: "connection-replaced",
    });
    expect(harness.timers.size).toBe(0);
    // 断线期投递动作被拒(不排队;对齐语义归重连后的 sync-projection)。
    expect(() => harness.client.sendAction(stepAction())).toThrow(SessionClientError);
  });

  it.each([
    [1008, "unauthenticated"],
    [1009, "frame-too-large"],
    [1013, "backpressure"],
    [1006, "abnormal"],
  ] as const)("close %i 语义化断线原因并按可重连性收敛(%s)", async (code, reason) => {
    const harness = createHarness();
    const socket = await createAndConnect(harness);
    socket.serverCloses(code, "mock");
    if (code === 1008) {
      // 无 replaced 错误帧的 1008 = 策略关闭(升级后未认证族):不重连。
      expect(harness.client.status).toBe("disconnected");
      expect(harness.statusEvents.at(-1)).toMatchObject({ reason: "unauthenticated" });
      expect(harness.timers.size).toBe(0);
      return;
    }
    expect(harness.client.status).toBe("reconnecting");
    expect(harness.statusEvents.at(-1)).toMatchObject({ closeCode: code, reason });
    expect(harness.timers.size).toBe(1);
  });

  it("disconnect() 取消挂起重连并停于 disconnected", async () => {
    const harness = createHarness();
    const socket = await createAndConnect(harness);
    socket.serverCloses(1000, "idle timeout");
    expect(harness.timers.size).toBe(1);

    harness.client.disconnect();
    expect(harness.client.status).toBe("disconnected");
    expect(harness.timers.size).toBe(0);
  });

  it("重连后的自动 sync 失败经 onCommandError 分发(契约漂移合成为 internal_error 兜底)", async () => {
    FakeWebSocket.reset();
    const commandErrors: SessionCommandError[] = [];
    // create 正常;sync-projection 返回 200 但响应体非契约 JSON(实现事故形态)。
    const mockFetch = createMockFetch((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/sessions") {
        return {
          status: 201,
          body: {
            command: "create_session",
            payload: { sessionId: SESSION_ID, revision: 0, projection: makeProjection() },
          },
          setCookie: `${SESSION_COOKIE}; Path=/sessions`,
        };
      }
      return { status: 200, body: { not: "a session command response" } };
    });
    const frames = new FakeFrames();
    const timers = new FakeTimers();
    let keyCounter = 0;
    const client = new SessionClient({
      fetch: mockFetch.fetch,
      webSocketFactory: fakeWebSocketFactory,
      raf: frames.raf,
      cancelRaf: frames.cancelRaf,
      scheduleTimer: timers.schedule,
      cancelTimer: timers.cancel,
      generateIdempotencyKey: () => `key-${String((keyCounter += 1)).padStart(4, "0")}`,
      baseUrl: "http://127.0.0.1:13000",
    });
    client.onCommandError((error) => commandErrors.push(error));

    await client.createSession(CREATE_INPUT);
    client.connect();
    FakeWebSocket.last.serverAccepts();
    FakeWebSocket.last.serverCloses(1000, "idle timeout");
    await timers.runNext();
    FakeWebSocket.last.serverAccepts();
    await settle();

    expect(commandErrors).toHaveLength(1);
    // 非命令错误的失败合成为 internal_error 兜底(httpStatus 0 = 无 HTTP 面)。
    expect(commandErrors[0]?.httpStatus).toBe(0);
    expect(commandErrors[0]?.publicError.code).toBe("internal_error");
    client.dispose();
  });

  it("closeSession 成功后主动断开动作通道", async () => {
    const harness = createHarness();
    await createAndConnect(harness);
    await harness.client.closeSession();
    expect(harness.client.status).toBe("disconnected");
    expect(harness.statusEvents.at(-1)).toMatchObject({ reason: "client-closed" });
  });

  it("dispose 释放订阅与挂起帧回调,后续 connect 抛错", async () => {
    const harness = createHarness();
    const notifications: number[] = [];
    const unsubscribe = harness.client.onProjectionChanged(() => notifications.push(1));
    unsubscribe();
    await createAndConnect(harness);
    harness.client.dispose();
    expect(() => harness.client.connect()).toThrow(SessionClientError);
    harness.frames.flush();
    expect(notifications).toHaveLength(0);
  });
});

// ── rAF 合帧调度(Node / SSR 降级形态)─────────────────────────────────────

describe("rAF 合帧调度", () => {
  it("无 rAF 环境降级为微任务批处理(注入 queueMicrotask 形态)", async () => {
    FakeWebSocket.reset();
    const mockFetch = createMockFetch((request) => {
      if (new URL(request.url).pathname === "/sessions") {
        return {
          status: 201,
          body: {
            command: "create_session",
            payload: { sessionId: SESSION_ID, revision: 0, projection: makeProjection() },
          },
          setCookie: `${SESSION_COOKIE}; Path=/sessions`,
        };
      }
      throw new Error("unexpected route (mock)");
    });
    const notifications: number[] = [];
    const client = new SessionClient({
      fetch: mockFetch.fetch,
      webSocketFactory: fakeWebSocketFactory,
      // Node / SSR 降级形态:微任务批处理(不可取消,句柄恒 0)。
      raf: (callback) => {
        queueMicrotask(callback);
        return 0;
      },
      generateIdempotencyKey: () => "microtask-key-0001",
    });

    await client.createSession(CREATE_INPUT);
    client.connect();
    const socket = FakeWebSocket.last;
    socket.serverAccepts();
    client.onProjectionChanged(() => notifications.push(client.store.revision ?? -1));

    client.sendAction(stepAction());
    socket.serverSends(
      serverFrame(
        "action_response",
        makeActionResponse({
          revision: 1,
          status: "paused",
          projectionDelta: makeDelta({ revision: 1 }),
        }),
        1,
        "microtask-key-0001",
      ),
    );
    await settle();
    expect(client.store.revision).toBe(1);
    expect(notifications).toEqual([1]);
  });

  it("缺省帧调度器在无 requestAnimationFrame 环境走微任务、句柄 0 不可取消", async () => {
    const { defaultFrameCanceler, defaultFrameScheduler } = await import(
      "../../src/client/transport.js"
    );
    const global = globalThis as {
      requestAnimationFrame?: unknown;
      cancelAnimationFrame?: unknown;
    };
    const originalRaf = global.requestAnimationFrame;
    const originalCancel = global.cancelAnimationFrame;
    global.requestAnimationFrame = undefined;
    let ran = false;
    let cancelCalled = false;
    global.cancelAnimationFrame = () => {
      cancelCalled = true;
    };

    try {
      const handle = defaultFrameScheduler(() => {
        ran = true;
      });
      expect(handle).toBe(0);
      defaultFrameCanceler(handle);
      expect(cancelCalled).toBe(false);
      await Promise.resolve();
      expect(ran).toBe(true);
    } finally {
      global.requestAnimationFrame = originalRaf;
      global.cancelAnimationFrame = originalCancel;
    }
  });
});

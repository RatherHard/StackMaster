/**
 * DebugChannelClient 全链路测试(WP-F8):mock WebSocket 手工驱动——attach
 * 自动化与帧形态、requestId 关联、推送帧(无 requestId)分发、错误帧关联
 * 拒绝、版本锚定 / 方向 / 会话绑定漂移兜底、seq 递增、dispose 收尾。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { DEBUG_CHANNEL_PROTOCOL_VERSION } from "@stackmaster/protocol";

import {
  DebugChannelClient,
  DebugChannelClientError,
  resolveDebugChannelUrl,
} from "../../src/client/debug-channel-client.js";
import {
  FakeWebSocket,
  fakeWebSocketFactory,
  settle,
} from "../helpers/fixtures.js";

const SESSION_ID = "session-debug-0001";

/** 调试通道 S→C 帧封装(经冻结 Schema 由客户端重新校验;此处手工组帧)。 */
function serverFrame(type: string, payload: unknown, seq: number, requestId?: string): unknown {
  return {
    protocolVersion: DEBUG_CHANNEL_PROTOCOL_VERSION,
    type,
    sessionId: SESSION_ID,
    seq,
    ...(requestId === undefined ? {} : { requestId }),
    payload,
  };
}

interface Harness {
  readonly client: DebugChannelClient;
  readonly socket: FakeWebSocket;
  readonly events: { kind: string; payload?: unknown; error?: unknown; status?: string }[];
}

/** 挂载并完成连接(connect + serverAccepts;测试主体从已连接态起步)。 */
function mount(overrides: Partial<Parameters<typeof createClient>[0]> = {}): Harness {
  const client = createClient(overrides);
  const events: Harness["events"] = [];
  client.onEvent((event) => {
    events.push(event as { kind: string });
  });
  client.connect();
  const socket = FakeWebSocket.last;
  socket.serverAccepts();
  return { client, socket, events };
}

function createClient(options: {
  origin?: { kind: "revision"; revision: number };
  generateRequestId?: () => string;
  channelUrl?: string;
} = {}): DebugChannelClient {
  FakeWebSocket.reset();
  let requestSeq = 0;
  return new DebugChannelClient({
    sessionId: SESSION_ID,
    origin: options.origin ?? { kind: "revision", revision: 3 },
    webSocketFactory: fakeWebSocketFactory,
    generateRequestId: options.generateRequestId ?? (() => `req-${(requestSeq += 1)}`),
    ...(options.channelUrl === undefined ? {} : { channelUrl: options.channelUrl }),
  });
}

beforeEach(() => {
  FakeWebSocket.reset();
});

describe("连接生命周期与 attach 自动化", () => {
  it("connect → open 即自动发送 debug_attach(版本锚定 / 会话绑定 / origin revision)", async () => {
    const { client, socket } = mount();
    await settle();

    expect(socket.sent).toHaveLength(1);
    const attach = socket.sent[0] as Record<string, unknown>;
    expect(attach.protocolVersion).toBe(DEBUG_CHANNEL_PROTOCOL_VERSION);
    expect(attach.type).toBe("debug_attach");
    expect(attach.sessionId).toBe(SESSION_ID);
    expect(attach.seq).toBe(1);
    expect(attach.requestId).toBe("req-1");
    expect(attach.payload).toEqual({ origin: { kind: "revision", revision: 3 } });
    expect(client.status).toBe("connected");
  });

  it("状态事件流:connecting → connected;服务端关闭 → disconnected + 在途拒绝", async () => {
    const { client, socket, events } = mount();
    await settle();

    const inFlight = client.requestWindow("0x400000", 16);
    socket.serverCloses(1000, "idle");
    await expect(inFlight).rejects.toThrow("调试通道已关闭");
    expect(client.status).toBe("disconnected");
    const statuses = events.filter((event) => event.kind === "status").map((event) => event.status);
    expect(statuses).toEqual(["connecting", "connected", "disconnected"]);
  });

  it("connect 幂等:已连接时重复调用不再发帧", async () => {
    const { client, socket } = mount();
    client.connect(); // 幂等:no-op。
    expect(socket.sent).toHaveLength(1); // 仅 attach 一帧。
  });

  it("通道 URL:显式 channelUrl 优先;缺省按 baseUrl 解析 debug 端点", () => {
    expect(resolveDebugChannelUrl("http://127.0.0.1:13000")).toBe(
      "ws://127.0.0.1:13000/sessions/debug-channel",
    );
    expect(resolveDebugChannelUrl("https://host.example")).toBe(
      "wss://host.example/sessions/debug-channel",
    );
  });
});

describe("请求面:requestId 关联与帧形态", () => {
  it("requestWindow:发出 debug_window 帧;回执按 requestId 解析 promise", async () => {
    const { client, socket } = mount();

    const pending = client.requestWindow("0x401000", 8);
    await settle();
    const windowFrame = socket.sent[1] as Record<string, unknown>;
    expect(windowFrame.type).toBe("debug_window");
    expect(windowFrame.seq).toBe(2);
    expect(windowFrame.requestId).toBe("req-2");
    expect(windowFrame.payload).toEqual({ addressHex: "0x401000", byteLength: 8 });

    socket.serverSends(
      serverFrame("debug_window_data", { addressHex: "0x401000", bytesHex: "0102" }, 1, "req-2"),
    );
    const payload = await pending;
    expect(payload).toEqual({ addressHex: "0x401000", bytesHex: "0102" });
  });

  it("requestSearch:不带 maxHits 的载荷最小形态;回执解析", async () => {
    const { client, socket } = mount();

    const pending = client.requestSearch("beef");
    await settle();
    expect((socket.sent[1] as Record<string, unknown>).payload).toEqual({ patternHex: "beef" });

    socket.serverSends(
      serverFrame(
        "debug_search_results",
        { hits: [{ addressHex: "0x1000", bytesHex: "beef" }] },
        2,
        "req-2",
      ),
    );
    const payload = await pending;
    expect(payload.hits).toHaveLength(1);
  });

  it("step:空载荷 debug_step;debug_paused 回执(带 requestId)解析", async () => {
    const { client, socket } = mount();

    const pending = client.step();
    await settle();
    expect((socket.sent[1] as Record<string, unknown>).payload).toEqual({});

    socket.serverSends(
      serverFrame("debug_paused", { reason: "step", addressHex: "0x401004" }, 3, "req-2"),
    );
    await expect(pending).resolves.toEqual({ reason: "step", addressHex: "0x401004" });
  });

  it("runToBreakpoint:断点集合载荷原样透传", async () => {
    const { client, socket } = mount();

    const pending = client.runToBreakpoint(["0x401008", "0x401010"]);
    await settle();
    expect((socket.sent[1] as Record<string, unknown>).payload).toEqual({
      breakpoints: ["0x401008", "0x401010"],
    });
    socket.serverSends(
      serverFrame("debug_paused", { reason: "breakpoint", addressHex: "0x401008" }, 4, "req-2"),
    );
    await expect(pending).resolves.toBeDefined();
  });

  it("未连接请求立即拒绝(不排队投递)", async () => {
    const client = createClient(); // 未 connect。
    await expect(client.requestWindow("0x1000", 8)).rejects.toThrow(DebugChannelClientError);
  });
});

describe("推送帧与错误帧", () => {
  it("debug_instruction_stream 推送帧(无 requestId)只分发事件,不影响在途请求", async () => {
    const { client, socket, events } = mount();

    const pending = client.requestWindow("0x400000", 16);
    socket.serverSends(
      serverFrame(
        "debug_instruction_stream",
        { instructions: [{ addressHex: "0x400000", text: "push rbp" }] },
        5,
      ),
    );
    await settle();
    expect(events.filter((event) => event.kind === "instruction-stream")).toHaveLength(1);
    // 在途请求不受推送帧影响(仍可被其 requestId 回执解析)。
    socket.serverSends(
      serverFrame("debug_window_data", { addressHex: "0x400000", bytesHex: "55" }, 6, "req-2"),
    );
    await expect(pending).resolves.toBeDefined();
  });

  it("error 带 requestId → 关联在途拒绝 + error 事件(冻结 PublicError 形态)", async () => {
    const { client, socket, events } = mount();

    const pending = client.requestWindow("0xfffffffffff", 16);
    socket.serverSends(
      serverFrame("error", { code: "invalid_input_format", message: "地址不可达" }, 7, "req-2"),
    );
    await expect(pending).rejects.toThrow("地址不可达");
    const errorEvent = events.find((event) => event.kind === "error");
    expect(errorEvent).toBeDefined();
  });

  it("error 帧无 requestId → 全部在途兜底拒绝(通道级失败)", async () => {
    const { client, socket } = mount();

    const pendingA = client.requestWindow("0x1000", 8);
    const pendingB = client.step();
    socket.serverSends(serverFrame("error", { code: "budget_exhausted", message: "限流" }, 8));
    await expect(pendingA).rejects.toThrow("限流");
    await expect(pendingB).rejects.toThrow("限流");
  });
});

describe("契约漂移兜底(客户端侧)", () => {
  it("版本漂移帧 → internal_error 漂移事件(连接级锚定由服务端拒绝,客户端兜底)", async () => {
    const { socket, events } = mount();

    socket.serverSends({
      protocolVersion: DEBUG_CHANNEL_PROTOCOL_VERSION + 1,
      type: "debug_paused",
      sessionId: SESSION_ID,
      seq: 1,
      payload: { reason: "step", addressHex: "0x1000" },
    });
    const errorEvent = events.find((event) => event.kind === "error") as { error?: { code: string } };
    expect(errorEvent?.error?.code).toBe("internal_error");
  });

  it("方向违规帧(C→S 类型自服务端到达)→ 漂移事件", async () => {
    const { socket, events } = mount();

    socket.serverSends(
      serverFrame("debug_window", { addressHex: "0x1000", byteLength: 8 }, 9),
    );
    const errorEvent = events.find((event) => event.kind === "error") as { error?: { message: string } };
    expect(errorEvent?.error?.message).toContain("方向违规");
  });

  it("会话绑定不匹配帧 → 漂移事件", async () => {
    const { socket, events } = mount();

    socket.serverSends({
      protocolVersion: DEBUG_CHANNEL_PROTOCOL_VERSION,
      type: "debug_paused",
      sessionId: "session-other",
      seq: 1,
      payload: { reason: "step", addressHex: "0x1000" },
    });
    const errorEvent = events.find((event) => event.kind === "error") as { error?: { message: string } };
    expect(errorEvent?.error?.message).toContain("会话绑定不匹配");
  });

  it("非 JSON 帧 → 漂移事件", async () => {
    const { socket, events } = mount();

    socket.serverSendsText("not-json{{");
    expect(events.some((event) => event.kind === "error")).toBe(true);
  });
});

describe("dispose 收尾", () => {
  it("dispose:在途请求拒绝、事件退订生效、后续请求抛错", async () => {
    const { client, socket, events } = mount();
    const pending = client.requestWindow("0x1000", 8);

    client.dispose();
    // socket.close 先行触发 onclose 兜底拒绝(close 语义优先于 dispose 直拒)。
    await expect(pending).rejects.toThrow(DebugChannelClientError);
    expect(client.status).toBe("disconnected");
    expect(() => client.requestWindow("0x1000", 8)).toThrow(/dispose/);
    const before = events.length;
    socket.serverSends(serverFrame("debug_paused", { reason: "step", addressHex: "0x1000" }, 10));
    expect(events.length).toBe(before); // 退订后零事件。
  });
});

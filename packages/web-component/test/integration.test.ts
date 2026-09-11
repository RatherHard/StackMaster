/**
 * 端到端 jsdom 集成:mock 宿主(postMessage)+ mock 引导端点(fetch)+
 * mock session-api(fetch / WebSocket)全链路——
 *   fragment esid → hello → ready → 引导配置 → create_session → 认证 WSS
 *   → 工作区挂载 → height_changed 上报 → 主题 / 语言消息生效;
 *   以及降级路径(引导取回失败 / create_session 失败 + 重试入口)。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { PwnMemoryVm } from "../src/index.js";
import { SessionClient, type WebSocketFactory } from "@stackmaster/vm-ui";
import {
  controlMessage,
  createSessionResponseBody,
  FakeClock,
  FakeFrames,
  FakeParentWindow,
  FakeScheduler,
  FakeWebSocket,
  flushMicrotasks,
  HOST_ORIGIN,
  readyMessage,
  TEST_ESID,
} from "./helpers.js";
import type { RecordedRequest } from "./helpers.js";

const BOOTSTRAP_URL = "https://host.example/host-api/embed-bootstrap";
const SESSION_API_ORIGIN = "https://sessionapi.example";

/** 队列取值(响应队列耗尽后保持最后一个;索引越界确定性抛错)。 */
function pick<T>(queue: readonly T[], index: number): T {
  const item = queue[index];
  if (item === undefined) {
    throw new Error("mock 响应队列索引越界");
  }
  return item;
}

interface ChainOptions {
  /** 引导端点逐次响应(队列耗尽后保持最后一个)。 */
  readonly bootstrapResponses?: ReadonlyArray<{ status: number; body: unknown }>;
  /** create_session 逐次响应(队列耗尽后保持最后一个)。 */
  readonly createSessionResponses?: ReadonlyArray<{ status: number; body: unknown }>;
  readonly measureHeight?: () => number;
}

/** 组装全链路元素(全部传输面 mock;返回断言面)。 */
async function mountFullChain(options: ChainOptions = {}) {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const frames = new FakeFrames();
  const parent = new FakeParentWindow();
  const requests: RecordedRequest[] = [];
  let bootstrapCalls = 0;
  let createCalls = 0;
  const height = options.measureHeight?.() ?? 480;

  const element = document.createElement("pwn-memory-vm") as PwnMemoryVm;
  element.locationHash = `#esid=${TEST_ESID}`;
  element.bootstrapEndpoint = BOOTSTRAP_URL;
  element.handshakeTimeoutMs = 30000;
  element.parentWindow = parent;
  element.clock = () => clock.now();
  element.scheduler = scheduler;
  element.frameScheduler = frames;
  element.measureHeight = () => height;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      body: JSON.parse(String(init?.body ?? "null")) as unknown,
    };
    requests.push(request);
    if (request.url === BOOTSTRAP_URL && request.method === "POST") {
      const queue = options.bootstrapResponses ?? [
        {
          status: 200,
          body: {
            embedToken: "opaque-embed-token-e2e",
            sessionApiOrigin: SESSION_API_ORIGIN,
            challengeId: "challenge-e2e-0001",
            challengeVersion: "1.0.0",
            embedSessionId: TEST_ESID,
          },
        },
      ];
      const response = pick(queue, Math.min(bootstrapCalls, queue.length - 1));
      bootstrapCalls += 1;
      return new Response(JSON.stringify(response.body), { status: response.status });
    }
    if (request.url === `${SESSION_API_ORIGIN}/sessions` && request.method === "POST") {
      const queue = options.createSessionResponses ?? [
        { status: 201, body: createSessionResponseBody("session-e2e-0001") },
      ];
      const response = pick(queue, Math.min(createCalls, queue.length - 1));
      createCalls += 1;
      return new Response(JSON.stringify(response.body), { status: response.status });
    }
    return new Response(JSON.stringify({ code: "invalid_input_format", message: "resource not found" }), {
      status: 404,
    });
  }) as typeof fetch;
  element.fetchImpl = fetchImpl;
  element.createSessionClient = (sessionOptions) =>
    new SessionClient({
      ...sessionOptions,
      fetch: fetchImpl,
      webSocketFactory: ((url: string) => new FakeWebSocket(url)) as WebSocketFactory,
    });
  document.body.append(element);
  await element.updateComplete;

  const dispatchFromHost = (data: unknown): void => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: HOST_ORIGIN,
        source: parent as unknown as MessageEventSource,
        data,
      }),
    );
  };
  return {
    element,
    parent,
    requests,
    frames,
    dispatchFromHost,
    shadow: () => {
      const root = element.shadowRoot;
      if (root === null) throw new Error("shadow root 缺失");
      return root;
    },
    async settle(): Promise<void> {
      await flushMicrotasks();
      await element.updateComplete;
    },
  };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("端到端:引导 → create_session → 工作区挂载 → 高度 / 主题 / 语言", () => {
  it("全链路:hello → ready → 引导取回 → create_session(token 三方比对输入)→ 工作区挂载", async () => {
    const h = await mountFullChain();

    // 1. hello 已发出(seq 1,targetOrigin *)。
    expect(h.parent.at(0)).toMatchObject({ targetOrigin: "*", message: { type: "hello", seq: 1 } });

    // 2. 宿主 ready → 元素消费;引导配置取回并行完成。
    h.dispatchFromHost(readyMessage(TEST_ESID));
    await h.settle();

    // 3. create_session 载荷 = 冻结契约面(challengeId / challengeVersion /
    //    embedSessionId=esid / embedToken;身份零承载,POST /sessions)。
    const createCall = h.requests.find((r) => r.url === `${SESSION_API_ORIGIN}/sessions`);
    expect(createCall).toBeDefined();
    expect(createCall?.method).toBe("POST");
    expect(createCall?.body).toMatchObject({
      protocolVersion: 1,
      command: "create_session",
      payload: {
        challengeId: "challenge-e2e-0001",
        challengeVersion: "1.0.0",
        embedSessionId: TEST_ESID,
        embedToken: "opaque-embed-token-e2e",
      },
    });

    // 4. 工作区挂载(data-testid 锚;vm-ui 的 <sm-workspace> 已升级且注入 client)。
    expect(h.element.phase).toBe("session-ready");
    const workspace = h.shadow().querySelector("sm-workspace");
    expect(workspace).not.toBeNull();
    await flushMicrotasks();
    const client = (workspace as unknown as { client?: SessionClient }).client ?? null;
    expect(client).not.toBeNull();
    expect(client?.sessionId).toBe("session-e2e-0001");
    expect(client?.status).toBe("connected"); // FakeWebSocket 微任务内 open。
    expect(client?.projection?.revision).toBe(0);
  });

  it("height 变化 → height_changed 上报(钉住 origin);主题 / 语言消息生效", async () => {
    let height = 300;
    const h = await mountFullChain();
    h.element.measureHeight = () => height; // 测量源由测试闭包驱动。
    h.dispatchFromHost(readyMessage(TEST_ESID));
    await h.settle();
    expect(h.element.phase).toBe("session-ready");

    h.frames.flush(); // 初始高度上报帧。
    const heightSeq = (): number[] =>
      h.parent.calls
        .filter((c) => (c.message as { type: string }).type === "height_changed")
        .map((c) => (c.message as { payload: { heightPx: number } }).payload.heightPx);
    expect(heightSeq()).toEqual([300]);

    height = 560;
    h.element.notifyContentHeightChange();
    h.frames.flush();
    const heightCalls = h.parent.calls.filter(
      (c) => (c.message as { type: string }).type === "height_changed",
    );
    const lastHeight = heightCalls[heightCalls.length - 1];
    expect(lastHeight?.targetOrigin).toBe(HOST_ORIGIN);
    expect(heightSeq()).toEqual([300, 560]);

    // 运行中主题 / 语言切换:接线位生效(attribute + 快照)。
    h.dispatchFromHost(controlMessage("theme_changed", TEST_ESID, 2, "dark"));
    h.dispatchFromHost(controlMessage("language_changed", TEST_ESID, 3, "en-US"));
    await h.element.updateComplete;
    expect(h.element.getAttribute("data-sm-theme")).toBe("dark");
    expect(h.element.getAttribute("data-sm-language")).toBe("en-US");
    expect(h.element.appearanceSnapshot.language).toBe("en-US");
  });

  it("引导取回失败 → bootstrap-failed 降级(零反射静态文案);重试成功后完成建会", async () => {
    const h = await mountFullChain({
      bootstrapResponses: [
        { status: 404, body: { error: "bootstrap_not_found", message: "resource not found" } },
        {
          status: 200,
          body: {
            embedToken: "opaque-embed-token-retry",
            sessionApiOrigin: SESSION_API_ORIGIN,
            challengeId: "challenge-e2e-0001",
            challengeVersion: "1.0.0",
            embedSessionId: TEST_ESID,
          },
        },
      ],
    });
    h.dispatchFromHost(readyMessage(TEST_ESID));
    await h.settle();
    // 首次取回 404:降级显示(静态文案,不回显响应内容)。
    expect(h.element.phase).toBe("degraded");
    expect(h.element.degradedReason).toBe("bootstrap-failed");
    const statusText = h.shadow().querySelector("[data-testid=pwn-status]")?.textContent ?? "";
    expect(statusText).toContain("引导配置取回失败");
    expect(statusText).not.toContain("bootstrap_not_found"); // 零反射。
    // 重试入口 → 取回成功 → ready 已在 → create_session 完成。
    h.shadow().querySelector<HTMLButtonElement>("[data-testid=pwn-retry-button]")?.click();
    await h.settle();
    expect(h.element.phase).toBe("session-ready");
    const createCall = h.requests.find((r) => r.url === `${SESSION_API_ORIGIN}/sessions`);
    expect((createCall?.body as { payload?: { embedToken?: string } }).payload?.embedToken).toBe(
      "opaque-embed-token-retry",
    );
  });

  it("create_session 失败 → session-failed 降级;重试入口重建会话(成功即挂载)", async () => {
    const h = await mountFullChain({
      createSessionResponses: [
        { status: 422, body: { code: "challenge_invalid", message: "challenge invalid" } },
        { status: 201, body: createSessionResponseBody("session-e2e-retry") },
      ],
    });
    h.dispatchFromHost(readyMessage(TEST_ESID));
    await h.settle();
    expect(h.element.phase).toBe("degraded");
    expect(h.element.degradedReason).toBe("session-failed");
    const statusText = h.shadow().querySelector("[data-testid=pwn-status]")?.textContent ?? "";
    expect(statusText).toContain("会话创建失败");
    expect(statusText).not.toContain("challenge_invalid"); // 零反射。
    h.shadow().querySelector<HTMLButtonElement>("[data-testid=pwn-retry-button]")?.click();
    await h.settle();
    expect(h.element.phase).toBe("session-ready");
    const workspace = h.shadow().querySelector("sm-workspace");
    expect(workspace).not.toBeNull();
    await flushMicrotasks();
    expect((workspace as unknown as { client?: SessionClient }).client?.sessionId).toBe("session-e2e-retry");
  });
});

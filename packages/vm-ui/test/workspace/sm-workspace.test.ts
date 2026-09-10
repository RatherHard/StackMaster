/**
 * <sm-workspace> 工作区容器集成测试(WP-F5):
 *  - 平铺(FE-WS-02,Q1 v1):双标签页并排、列间滚动可达(scrollToColumn)、
 *    列内分割、拖拽换位(pointer 事件模拟)、同类型多开(FE-MV-01)、
 *    关闭生命周期与空态、debug 占位空态;
 *  - 菜单动作(真实 SessionClient mock 全链路):step / reset 帧形态、
 *    终态禁用 + 引导、断线横幅、connection-replaced 手动重连、
 *    rejected 错误呈现(含 explanation);
 *  - 跨视图集成:寄存器交叉标注左缘出现与点击展开(FE-RG-04)、跳转链
 *    形似地址行挂载(FE-ST-07)、viewport-jump 滚动 / 窗口外反馈(FE-ST-09)。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionClient } from "../../src/client/session-client.js";
import { SmWorkspace } from "../../src/workspace/sm-workspace.js";
import {
  CREATE_INPUT,
  FakeFrames,
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
  type MockFetch,
} from "../helpers/fixtures.js";

// ── 平铺测试夹具(无 client:直接注入 FakeMemoryDataSource)──────────────────

import { FakeMemoryDataSource } from "../views/byte/fake-data-source.js";

/** 等待若干渲染帧(virtualizer 可见范围计算收敛)。 */
async function settleFrames(frames: number): Promise<void> {
  for (let frame = 0; frame < frames; frame += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    await Promise.resolve();
  }
}

function pointer(type: string, x: number, y: number): MouseEvent {
  return new MouseEvent(type, { bubbles: true, composed: true, clientX: x, clientY: y });
}

async function mountWorkspace(): Promise<SmWorkspace> {
  const element = new SmWorkspace();
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function shadowOf(element: SmWorkspace): ShadowRoot {
  return element.shadowRoot as ShadowRoot;
}

function panelsOf(element: SmWorkspace): HTMLElement[] {
  return [...shadowOf(element).querySelectorAll(".tab-panel")] as HTMLElement[];
}

// ── 菜单/集成测试夹具(真实 SessionClient + mock 传输)──────────────────────

/** 工作区投影:栈区域首行 = 小端 0x2004(形似地址,落 heap 区域),RSP 命中窗口。 */
function workspaceProjection(status: "running" | "paused" | "won" | "failed" = "paused") {
  return makeProjection({
    status,
    revision: 0,
    visibleRegions: [
      {
        regionId: "region-stack",
        label: "stack",
        startAddressHex: "0x1000",
        byteLength: 4096,
        permissions: "rw",
        bytesHex: "0420000000000000" + "0000000000000000",
        truncated: false,
      },
      {
        regionId: "region-heap",
        label: "heap",
        startAddressHex: "0x2000",
        byteLength: 64,
        permissions: "rw",
        bytesHex: "aa",
        truncated: true,
      },
    ],
    visibleRegisters: [
      { name: "RSP", valueHex: "0x1004" },
      { name: "RBP", valueHex: "0x100C" },
    ],
  });
}

interface ClientHarness {
  readonly client: SessionClient;
  readonly frames: FakeFrames;
  readonly mockFetch: MockFetch;
}

function createClientHarness(): ClientHarness {
  FakeWebSocket.reset();
  const frames = new FakeFrames();
  const mockFetch = createMockFetch((request) => {
    const path = new URL(request.url).pathname;
    switch (path) {
      case "/sessions":
        return {
          status: 201,
          body: {
            command: "create_session",
            payload: { sessionId: SESSION_ID, revision: 0, projection: workspaceProjection() },
          },
          setCookie: `${SESSION_COOKIE}; Path=/sessions; HttpOnly; SameSite=Strict`,
        };
      case "/sessions/projection-sync":
        return {
          status: 200,
          body: {
            command: "sync_projection",
            payload: { revision: 0, projection: workspaceProjection() },
          },
        };
      case "/sessions/close":
        return { status: 200, body: { command: "close_session", payload: { revision: 0 } } };
      default:
        return { status: 404, body: { code: "internal_error", message: "no such route (mock)" } };
    }
  });
  const client = new SessionClient({
    fetch: mockFetch.fetch,
    webSocketFactory: fakeWebSocketFactory,
    raf: frames.raf,
    cancelRaf: frames.cancelRaf,
    scheduleTimer: () => ({ handle: 0 }),
    cancelTimer: () => undefined,
    generateIdempotencyKey: (() => {
      let counter = 0;
      return () => `key-${String((counter += 1))}`;
    })(),
    baseUrl: "http://127.0.0.1:13000",
  });
  return { client, frames, mockFetch };
}

/** 装配"已建会话 + 已连接 + 已开一个栈视图标签页"的工作区。 */
async function mountConnectedWorkspace(): Promise<{
  workspace: SmWorkspace;
  harness: ClientHarness;
  socket: FakeWebSocket;
}> {
  const harness = createClientHarness();
  const workspace = await mountWorkspace();
  workspace.client = harness.client;
  await workspace.updateComplete;
  await harness.client.createSession(CREATE_INPUT);
  harness.client.connect();
  const socket = FakeWebSocket.last;
  socket.serverAccepts();
  await settle();
  harness.frames.flush();
  await workspace.updateComplete;

  const tabId = workspace.openTab("stack");
  expect(tabId).not.toBeNull();
  await workspace.updateComplete;
  await settleFrames(4);
  return { workspace, harness, socket };
}

function firstByteView(workspace: SmWorkspace) {
  const byteTab = shadowOf(workspace).querySelector("sm-byte-tab");
  if (byteTab === null) {
    throw new Error("未找到字节页内容");
  }
  const view = (byteTab as unknown as { byteView: { shadowRoot: ShadowRoot } }).byteView;
  if (view === null || view === undefined) {
    throw new Error("字节页尚未渲染字节视图");
  }
  return view;
}

function dataRows(workspace: SmWorkspace): Element[] {
  return [...firstByteView(workspace).shadowRoot.querySelectorAll(".byte-row[data-row-address]")];
}

function menuShadow(workspace: SmWorkspace): ShadowRoot {
  const menu = shadowOf(workspace).querySelector("sm-workspace-menu");
  if (menu === null) {
    throw new Error("未找到工作区菜单");
  }
  return menu.shadowRoot as ShadowRoot;
}

function respondExecuted(socket: FakeWebSocket, requestId: string): void {
  socket.serverSends(
    serverFrame(
      "action_response",
      makeActionResponse({
        revision: 1,
        status: "paused",
        projectionDelta: makeDelta({
          revision: 1,
          dirtyRanges: [
            { regionId: "region-stack", startAddressHex: "0x1008", bytesHex: "ff" },
          ],
        }),
      }),
      1,
      requestId,
    ),
  );
}

beforeEach(() => {
  FakeWebSocket.reset();
});

// ── 平铺(FE-WS-02 / FE-WS-01 / FE-MV-01)────────────────────────────────────

describe("<sm-workspace> 列式滚动平铺(FE-WS-02)", () => {
  it("双标签页并排:打开两个标签页落入同列分割,两面板同时呈现(验收底线)", async () => {
    const workspace = await mountWorkspace();
    workspace.dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-stack",
          label: "stack",
          startAddressHex: "0x1000",
          byteLength: 4096,
          permissions: "rw",
          windowBytesHex: "000102030405060708090a0b0c0d0e0f",
        },
      ],
      [{ name: "RSP", valueHex: "0x1004" }],
    );
    await workspace.updateComplete;
    workspace.openTab("stack");
    workspace.openTab("registers");
    await workspace.updateComplete;

    const panels = panelsOf(workspace);
    expect(panels).toHaveLength(2);
    expect(panels[0]?.getAttribute("aria-label")).toBe("栈视图 1");
    expect(panels[1]?.getAttribute("aria-label")).toBe("寄存器视图 1");
    expect(panels[0]?.closest(".column")).toBe(panels[1]?.closest(".column"));
    // 列间水平滚动形态:列容器可横向滚动(Niri 式可达任意列)。
    expect(shadowOf(workspace).querySelector("[data-columns]")).not.toBeNull();
    workspace.remove();
  });

  it("列间滚动可达任意列:scrollToColumn 让目标列面板调用 scrollIntoView", async () => {
    const workspace = await mountWorkspace();
    workspace.dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-stack",
          label: "stack",
          startAddressHex: "0x1000",
          byteLength: 4096,
          permissions: "rw",
          windowBytesHex: "000102030405060708090a0b0c0d0e0f",
        },
      ],
      [{ name: "RSP", valueHex: "0x1004" }],
    );
    await workspace.updateComplete;
    const a = workspace.openTab("stack") as string;
    const b = workspace.openTab("free") as string;
    await workspace.updateComplete;
    // jsdom 无 scrollIntoView:临时替换原型实现收集调用者(测试后还原)。
    const original = Element.prototype.scrollIntoView;
    const scrolledTo: Element[] = [];
    Element.prototype.scrollIntoView = function scrollIntoViewStub(this: Element): void {
      scrolledTo.push(this);
    };
    try {
      workspace.scrollToColumn(0);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
    expect(scrolledTo).toHaveLength(1);
    expect(scrolledTo[0]?.getAttribute("data-tab-id")).toBe(a);
    expect(a).not.toBe(b);
    workspace.remove();
  });

  it("拖拽换位:pointer 事件模拟——源页拖到目标页下半 → 插到其后", async () => {
    const workspace = await mountWorkspace();
    workspace.dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-stack",
          label: "stack",
          startAddressHex: "0x1000",
          byteLength: 4096,
          permissions: "rw",
          windowBytesHex: "000102030405060708090a0b0c0d0e0f",
        },
      ],
      [{ name: "RSP", valueHex: "0x1004" }],
    );
    await workspace.updateComplete;
    const a = workspace.openTab("stack") as string;
    const b = workspace.openTab("free") as string;
    const c = workspace.openTab("registers") as string;
    await workspace.updateComplete;

    const panelA = shadowOf(workspace).querySelector(`[data-tab-id="${a}"]`) as HTMLElement;
    const panelB = shadowOf(workspace).querySelector(`[data-tab-id="${b}"]`) as HTMLElement;
    // 按下(标题栏)→ 位移过阈值 → 在 B 下半抬起(插到 B 之后)。
    (panelA.querySelector(".tab-bar") as HTMLElement).dispatchEvent(pointer("pointerdown", 10, 10));
    shadowOf(workspace).dispatchEvent(pointer("pointermove", 40, 40));
    panelB.dispatchEvent(pointer("pointerup", 10, 999));
    await workspace.updateComplete;

    const order = panelsOf(workspace).map((panel) => panel.getAttribute("data-tab-id"));
    expect(order).toEqual([b, a, c]);
    workspace.remove();
  });

  it("拖到列区空白 → 开新列(尾插)", async () => {
    const workspace = await mountWorkspace();
    workspace.dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-stack",
          label: "stack",
          startAddressHex: "0x1000",
          byteLength: 4096,
          permissions: "rw",
          windowBytesHex: "000102030405060708090a0b0c0d0e0f",
        },
      ],
      [{ name: "RSP", valueHex: "0x1004" }],
    );
    await workspace.updateComplete;
    const a = workspace.openTab("stack") as string;
    const b = workspace.openTab("free") as string;
    await workspace.updateComplete;

    const columns = shadowOf(workspace).querySelector("[data-columns]") as HTMLElement;
    const panelA = shadowOf(workspace).querySelector(`[data-tab-id="${a}"]`) as HTMLElement;
    (panelA.querySelector(".tab-bar") as HTMLElement).dispatchEvent(pointer("pointerdown", 10, 10));
    shadowOf(workspace).dispatchEvent(pointer("pointermove", 60, 60));
    columns.dispatchEvent(pointer("pointerup", 10, 10));
    await workspace.updateComplete;

    // a 摘除后开新列:列 0 剩 b,列 1 = a(尾插)。
    expect(workspace.layoutSnapshot.columns).toHaveLength(2);
    expect(workspace.layoutSnapshot.columns[0]?.tabIds).toEqual([b]);
    expect(workspace.layoutSnapshot.columns[1]?.tabIds).toEqual([a]);
    workspace.remove();
  });

  it("位移未过阈值 = 激活点击(拖拽与点击的区分)", async () => {
    const workspace = await mountWorkspace();
    workspace.dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-stack",
          label: "stack",
          startAddressHex: "0x1000",
          byteLength: 4096,
          permissions: "rw",
          windowBytesHex: "000102030405060708090a0b0c0d0e0f",
        },
      ],
      [{ name: "RSP", valueHex: "0x1004" }],
    );
    await workspace.updateComplete;
    const a = workspace.openTab("stack") as string;
    workspace.openTab("registers");
    await workspace.updateComplete;
    expect(workspace.layoutSnapshot.focusedTabId).not.toBe(a);

    const panelA = shadowOf(workspace).querySelector(`[data-tab-id="${a}"]`) as HTMLElement;
    (panelA.querySelector(".tab-bar") as HTMLElement).dispatchEvent(pointer("pointerdown", 10, 10));
    shadowOf(workspace).dispatchEvent(pointer("pointermove", 11, 11));
    shadowOf(workspace).dispatchEvent(pointer("pointerup", 11, 11));
    await workspace.updateComplete;
    expect(workspace.layoutSnapshot.focusedTabId).toBe(a);
    workspace.remove();
  });
});

describe("<sm-workspace> 标签页生命周期(FE-WS-01 / FE-MV-01)", () => {
  it("同类型可多开:两个栈视图序号 1/2 并列呈现", async () => {
    const workspace = await mountWorkspace();
    workspace.dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-stack",
          label: "stack",
          startAddressHex: "0x1000",
          byteLength: 4096,
          permissions: "rw",
          windowBytesHex: "000102030405060708090a0b0c0d0e0f",
        },
      ],
      [{ name: "RSP", valueHex: "0x1004" }],
    );
    await workspace.updateComplete;
    workspace.openTab("stack");
    workspace.openTab("stack");
    await workspace.updateComplete;

    const titles = panelsOf(workspace).map((panel) => panel.getAttribute("aria-label"));
    expect(titles).toEqual(["栈视图 1", "栈视图 2"]);
    workspace.remove();
  });

  it("关闭标签页移除面板;关闭最后一个 → 空态引导打开", async () => {
    const workspace = await mountWorkspace();
    workspace.dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-stack",
          label: "stack",
          startAddressHex: "0x1000",
          byteLength: 4096,
          permissions: "rw",
          windowBytesHex: "000102030405060708090a0b0c0d0e0f",
        },
      ],
      [{ name: "RSP", valueHex: "0x1004" }],
    );
    await workspace.updateComplete;
    const a = workspace.openTab("stack") as string;
    await workspace.updateComplete;

    const closeButton = shadowOf(workspace).querySelector(
      `[data-tab-id="${a}"] .tab-close`,
    ) as HTMLButtonElement;
    closeButton.click();
    await workspace.updateComplete;

    expect(panelsOf(workspace)).toHaveLength(0);
    expect(shadowOf(workspace).querySelector(".empty")?.textContent).toContain("工作区为空");
    workspace.remove();
  });

  it("焦点标签页带 focused 标记;激活切换跟随点击", async () => {
    const workspace = await mountWorkspace();
    workspace.dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-stack",
          label: "stack",
          startAddressHex: "0x1000",
          byteLength: 4096,
          permissions: "rw",
          windowBytesHex: "000102030405060708090a0b0c0d0e0f",
        },
      ],
      [{ name: "RSP", valueHex: "0x1004" }],
    );
    await workspace.updateComplete;
    const a = workspace.openTab("stack") as string;
    const b = workspace.openTab("registers") as string;
    await workspace.updateComplete;

    const panelA = shadowOf(workspace).querySelector(`[data-tab-id="${a}"]`) as HTMLElement;
    const panelB = shadowOf(workspace).querySelector(`[data-tab-id="${b}"]`) as HTMLElement;
    // 新开的标签页获得焦点:初始焦点在 b。
    expect(panelB.classList.contains("focused")).toBe(true);
    expect(panelA.classList.contains("focused")).toBe(false);

    workspace.activateTab(a);
    await workspace.updateComplete;
    expect(panelA.classList.contains("focused")).toBe(true);
    expect(panelB.classList.contains("focused")).toBe(false);
    workspace.remove();
  });

  it("debug 占位类型:呈现「调试模式档由 WP-F8 提供」空态(注册位不实现)", async () => {
    const workspace = await mountWorkspace();
    const tabId = workspace.openTab("debug");
    expect(tabId).not.toBeNull();
    await workspace.updateComplete;

    const panel = shadowOf(workspace).querySelector(`[data-tab-id="${tabId}"]`);
    expect(panel?.querySelector(".tab-placeholder")?.textContent).toContain("调试模式档由 WP-F8 提供");
    expect(panel?.querySelector("sm-byte-tab")).toBeNull();
    workspace.remove();
  });

  it("未登记类型打开返回 null(注册表封闭消费面)", async () => {
    const workspace = await mountWorkspace();
    expect(workspace.openTab("payload")).toBeNull();
    expect(workspace.layoutSnapshot.tabs).toHaveLength(0);
    workspace.remove();
  });
});

// ── 菜单动作(真实 SessionClient mock 全链路)────────────────────────────────

describe("<sm-workspace> 顶部菜单动作(FE-WS-03/04a/05)", () => {
  it("指令步进:点击菜单 → 发送 {type:\"step\", args:{}} 动作帧;投影增量回流刷新视图", async () => {
    const { workspace, harness, socket } = await mountConnectedWorkspace();
    harness.frames.flush();

    (menuShadow(workspace).querySelector("button.step-button") as HTMLButtonElement).click();
    await settle();

    const sent = socket.sent.at(-1) as { payload?: { action?: { type: string; args: unknown } } };
    expect(sent?.payload?.action).toEqual({ type: "step", args: {} });

    // 服务端响应(执行 + 增量)→ 投影变更 → 视图刷新 + revision 前进。
    const requestId = (socket.sent.at(-1) as { requestId?: string })?.requestId ?? "";
    respondExecuted(socket, requestId);
    harness.frames.flush();
    await settleFrames(3);
    await workspace.updateComplete;

    expect(menuShadow(workspace).querySelector(".revision")?.textContent).toBe("1");
    const rows = dataRows(workspace);
    const secondRow = rows.find((row) => row.getAttribute("data-row-address") === "0x1008");
    expect(secondRow?.textContent).toContain("ff");
    workspace.remove();
    harness.client.dispose();
  });

  it("重启测试环境:运行中可点 → 发送 reset 动作帧", async () => {
    const { workspace, harness, socket } = await mountConnectedWorkspace();

    (menuShadow(workspace).querySelector("button.reset-button") as HTMLButtonElement).click();
    await settle();

    const sent = socket.sent.at(-1) as { payload?: { action?: { type: string } } };
    expect(sent?.payload?.action?.type).toBe("reset");
    workspace.remove();
    harness.client.dispose();
  });

  it("终态会话(won):reset 禁用 + 引导呈现;新建会话按钮发出 new-session-request", async () => {
    const { workspace, harness } = await mountConnectedWorkspace();
    harness.client.store.replaceProjection(workspaceProjection("won"));
    harness.frames.flush();
    await workspace.updateComplete;

    expect((menuShadow(workspace).querySelector("button.reset-button") as HTMLButtonElement).disabled).toBe(true);
    const guidance = menuShadow(workspace).querySelector(".guidance");
    expect(guidance?.textContent).toContain("测试环境已结束,请新建会话");

    const requests: Event[] = [];
    workspace.addEventListener("new-session-request", (event) => requests.push(event));
    (menuShadow(workspace).querySelector("button.new-session-button") as HTMLButtonElement).click();
    expect(requests).toHaveLength(1);
    workspace.remove();
    harness.client.dispose();
  });

  it("未连接时点击 step:呈现可解释错误,不投递(断线不排队)", async () => {
    const harness = createClientHarness();
    const workspace = await mountWorkspace();
    workspace.client = harness.client;
    await workspace.updateComplete;
    // 未 createSession / 未 connect → sendAction 抛 not_connected。
    (menuShadow(workspace).querySelector("button.step-button") as HTMLButtonElement).disabled = false;
    (menuShadow(workspace).querySelector("button.step-button") as HTMLButtonElement).click();
    await workspace.updateComplete;

    const errorBar = menuShadow(workspace).querySelector(".error");
    expect(errorBar?.textContent).toContain("未连接");
    workspace.remove();
    harness.client.dispose();
  });
});

describe("<sm-workspace> 连接状态呈现(FE-WS-03)", () => {
  it("已连接:状态区呈现 status/revision/connected,无横幅", async () => {
    const { workspace, harness } = await mountConnectedWorkspace();

    expect(menuShadow(workspace).querySelector(".session-status")?.textContent).toBe("paused");
    expect(menuShadow(workspace).querySelector(".connection-status")?.textContent).toBe("connected");
    expect(menuShadow(workspace).querySelector(".banner")).toBeNull();
    workspace.remove();
    harness.client.dispose();
  });

  it("断线重连:横幅呈现最近投影 revision + attempt / retryDelayMs", async () => {
    const { workspace, harness, socket } = await mountConnectedWorkspace();
    socket.serverCloses(1000, "");
    await settle();
    await workspace.updateComplete;

    const banner = menuShadow(workspace).querySelector(".banner") as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.textContent).toContain("最近一次公开投影(revision 0)");
    expect(banner.textContent).toContain("第 1 次重试");
    expect(banner.textContent).toContain("500 ms 后重试");
    expect(menuShadow(workspace).querySelector(".connection-status")?.textContent).toBe("reconnecting");
    workspace.remove();
    harness.client.dispose();
  });

  it("connection-replaced:错误帧 + close 1008 → 提示手动重连;点击重连开新连接", async () => {
    const { workspace, harness, socket } = await mountConnectedWorkspace();
    socket.serverSends(
      serverFrame("error", { code: "internal_error", message: "connection replaced" }, 1),
    );
    socket.serverCloses(1008, "policy");
    await settle();
    await workspace.updateComplete;

    const banner = menuShadow(workspace).querySelector(".banner") as HTMLElement;
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("连接已被同一会话的新连接取代");
    expect(menuShadow(workspace).querySelector(".connection-status")?.textContent).toBe("disconnected");

    const instancesBefore = FakeWebSocket.instances.length;
    (menuShadow(workspace).querySelector("button.reconnect-button") as HTMLButtonElement).click();
    await settle();
    expect(FakeWebSocket.instances.length).toBe(instancesBefore + 1);
    workspace.remove();
    harness.client.dispose();
  });

  it("投影变更 → 各标签页内容 refresh()(组合根接线口径)", async () => {
    const { workspace, harness, socket } = await mountConnectedWorkspace();
    workspace.openTab("registers");
    await workspace.updateComplete;
    await settleFrames(3);

    const rowsBefore = dataRows(workspace).length;
    expect(rowsBefore).toBeGreaterThan(0);

    socket.serverSends(
      serverFrame(
        "action_response",
        makeActionResponse({ revision: 1, status: "paused", projectionDelta: null }),
        1,
      ),
    );
    harness.frames.flush();
    await settleFrames(3);
    await workspace.updateComplete;
    expect(menuShadow(workspace).querySelector(".revision")?.textContent).toBe("1");
    workspace.remove();
    harness.client.dispose();
  });
});

describe("<sm-workspace> 拒绝呈现(可解释性,不只 code)", () => {
  it("onActionRejected → userVisibleError 呈现 code/message/explanation", async () => {
    const { workspace, harness, socket } = await mountConnectedWorkspace();

    (menuShadow(workspace).querySelector("button.step-button") as HTMLButtonElement).click();
    await settle();
    const requestId = (socket.sent.at(-1) as { requestId?: string })?.requestId ?? "";
    socket.serverSends(
      serverFrame(
        "action_response",
        makeActionResponse({
          revision: 0,
          status: "rejected",
          userVisibleError: {
            code: "session_terminal",
            message: "会话已进入终态",
          },
        }),
        1,
        requestId,
      ),
    );
    await settle();
    await workspace.updateComplete;

    const errorBar = menuShadow(workspace).querySelector(".error") as HTMLElement;
    expect(errorBar.getAttribute("role")).toBe("alert");
    expect(errorBar.textContent).toContain("[session_terminal]");
    expect(errorBar.textContent).toContain("会话已进入终态");
    workspace.remove();
    harness.client.dispose();
  });
});

// ── 跨视图集成(FE-RG-04 / FE-ST-07 / FE-ST-09)────────────────────────────

describe("<sm-workspace> 跨视图集成接线", () => {
  it("寄存器交叉标注:命中行左缘出现标注按钮;点击展开寄存器值(FE-RG-04)", async () => {
    const { workspace, harness } = await mountConnectedWorkspace();
    const view = firstByteView(workspace);
    const row = view.shadowRoot.querySelector('.byte-row[data-row-address="0x1000"]');
    expect(row).not.toBeNull();

    // RSP = 0x1004 → 命中行 0x1000;RBP = 0x100c → 命中行 0x1008(按行区间过滤)。
    const annotation = row?.querySelector("sm-register-annotation");
    expect(annotation).not.toBeNull();
    const button = annotation?.shadowRoot?.querySelector("button.reg-annotation");
    expect(button?.getAttribute("data-registers")).toBe("RSP");

    (button as HTMLButtonElement).click();
    await (annotation as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    const annotationText = ((annotation?.shadowRoot?.textContent ?? "") as string).replace(/\s+/g, " ");
    expect(annotationText).toContain("RSP = 0x1004");

    const row2 = view.shadowRoot.querySelector('.byte-row[data-row-address="0x1008"]');
    const annotation2 = row2?.querySelector("sm-register-annotation");
    expect(annotation2?.shadowRoot?.querySelector("button.reg-annotation")?.getAttribute("data-registers")).toBe(
      "RBP",
    );
    workspace.remove();
    harness.client.dispose();
  });

  it("跳转链:8 字节小端解释形似地址的行挂载 <sm-jump-chain>,非地址行不挂(FE-ST-07)", async () => {
    const { workspace, harness } = await mountConnectedWorkspace();
    const view = firstByteView(workspace);

    const addressRow = view.shadowRoot.querySelector('.byte-row[data-row-address="0x1000"]');
    const chain = addressRow?.querySelector("sm-jump-chain");
    expect(chain).not.toBeNull();
    expect(chain?.getAttribute("start-address-hex")).toBe("0x1000");

    const plainRow = view.shadowRoot.querySelector('.byte-row[data-row-address="0x1008"]');
    expect(plainRow?.querySelector("sm-jump-chain")).toBeNull();
    workspace.remove();
    harness.client.dispose();
  });

  it("viewport-jump 窗口内:滚动到目标行并给出反馈(FE-ST-09)", async () => {
    const { workspace, harness } = await mountConnectedWorkspace();
    const view = firstByteView(workspace);
    const scrollToIndex = vi.fn();
    const list = view.shadowRoot.querySelector("lit-virtualizer") as unknown as {
      scrollToIndex: unknown;
    };
    list.scrollToIndex = scrollToIndex;

    const chain = view.shadowRoot.querySelector('.byte-row[data-row-address="0x1000"] sm-jump-chain');
    chain?.dispatchEvent(
      new CustomEvent("viewport-jump", {
        detail: { addressHex: "0x1004", withinWindow: true },
        bubbles: true,
        composed: true,
      }),
    );
    await settleFrames(3);
    await workspace.updateComplete;

    expect(scrollToIndex).toHaveBeenCalled();
    expect(shadowOf(workspace).querySelector(".jump-feedback")?.textContent).toContain("已跳转到");
    workspace.remove();
    harness.client.dispose();
  });

  it("viewport-jump 窗口外:不滚动,呈现「在可见窗口之外」反馈", async () => {
    const { workspace, harness } = await mountConnectedWorkspace();
    const view = firstByteView(workspace);
    const scrollToIndex = vi.fn();
    const list = view.shadowRoot.querySelector("lit-virtualizer") as unknown as {
      scrollToIndex: unknown;
    };
    list.scrollToIndex = scrollToIndex;

    const chain = view.shadowRoot.querySelector('.byte-row[data-row-address="0x1000"] sm-jump-chain');
    chain?.dispatchEvent(
      new CustomEvent("viewport-jump", {
        detail: { addressHex: "0x9999", withinWindow: false },
        bubbles: true,
        composed: true,
      }),
    );
    await settleFrames(3);
    await workspace.updateComplete;

    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(shadowOf(workspace).querySelector(".jump-feedback")?.textContent).toContain("在可见窗口之外");
    workspace.remove();
    harness.client.dispose();
  });
});

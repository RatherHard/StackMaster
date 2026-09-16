/**
 * <sm-workspace> 工作区容器集成测试(WP-F5 平铺 × WP-71 固定窗口集 / D-MP-1 ×
 * WP-72 Niri 布局交互):
 *  - 固定窗口集:挂载即按注册表登记集合建窗(各恰一实例、常驻)、无任何关闭
 *    入口、无空态引导、聚焦导航(focusWindow 聚焦 + 相机居中,不改变实例数);
 *  - 平铺(FE-WS-02,Q1 v1;WP-72 起默认列排布 = **当前宽度档预设** P0):列间
 *    滚动可达(scrollToColumn → 相机),列宽 / 窗高与三类落点见
 *    `sm-workspace-layout.test.ts`;
 *  - 菜单动作(真实 SessionClient mock 全链路):step / reset 帧形态、
 *    终态禁用 + 引导、断线横幅、connection-replaced 手动重连、
 *    rejected 错误呈现(含 explanation);
 *  - 跨视图集成:寄存器交叉标注左缘出现与点击展开(FE-RG-04)、跳转链
 *    形似地址行挂载(FE-ST-07)、viewport-jump 滚动 / 窗口外反馈(FE-ST-09)。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionClient } from "../../src/client/session-client.js";
import { SmWorkspace } from "../../src/workspace/sm-workspace.js";
import { isWindowSetComplete } from "../../src/workspace/workspace-model.js";
import { PAYLOAD_TAB_TYPE, defaultTabTypeRegistry } from "../../src/workspace/tab-registry.js";
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

/** 默认注册表登记类型集(窗口集权威来源)。 */
const REGISTERED_TYPES: readonly string[] = defaultTabTypeRegistry
  .list()
  .map((descriptor) => descriptor.type);

/**
 * P0 预设(宽屏 5 列)下的窗口呈现序(WP-72 起默认列排布 = 预设表):
 * DOM 序随**列分组**而非登记序。
 */
const P0_PRESENTATION_ORDER: readonly string[] = [
  "stack",
  "registers",
  "debug",
  "free",
  "payload",
  "call-stack",
  "structure",
  "timeline",
  "checkpoints",
  "memory-diff",
];

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

function windowTypesOf(element: SmWorkspace): string[] {
  return panelsOf(element).map((panel) => panel.getAttribute("data-tab-id") ?? "");
}

function panelOf(element: SmWorkspace, windowType: string): HTMLElement {
  const panel = shadowOf(element).querySelector(`[data-tab-id="${windowType}"]`);
  if (panel === null) {
    throw new Error(`未找到窗口面板:${windowType}`);
  }
  return panel as HTMLElement;
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

/** 装配"已建会话 + 已连接的工作区"(窗口集随挂载常驻,无需开窗)。 */
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

// ── 固定窗口集(D-MP-1 / WP-71)──────────────────────────────────────────────

describe("<sm-workspace> 固定窗口集(D-MP-1:全部窗口常驻、无关闭)", () => {
  it("挂载即按注册表登记集合建窗:全部类型各恰一实例常驻呈现(验收底线)", async () => {
    const workspace = await mountWorkspace();
    await workspace.updateComplete;

    const types = windowTypesOf(workspace);
    // 窗口集 ≡ 注册表登记集合(各恰一实例);DOM 序 = P0 预设列分组序。
    expect([...types].sort()).toEqual([...REGISTERED_TYPES].sort());
    expect(types).toEqual([...P0_PRESENTATION_ORDER]);
    expect(new Set(types).size).toBe(REGISTERED_TYPES.length);
    expect(workspace.layoutSnapshot.tabs).toHaveLength(REGISTERED_TYPES.length);
    // 结构性不变量:窗口集 ≡ 注册表类型集,各恰一实例(无重无漏、无空列)。
    expect(isWindowSetComplete(workspace.layoutSnapshot)).toBe(true);
    workspace.remove();
  });

  it("窗口标题 = 注册表展示名(无类型内序号);标题栏与 aria-label 同源", async () => {
    const workspace = await mountWorkspace();

    const labels = panelsOf(workspace).map((panel) => panel.getAttribute("aria-label"));
    expect(labels).toEqual([
      "栈视图",
      "寄存器视图",
      "指令视图",
      "自由视图",
      "Payload 搭建",
      "调用栈",
      "结构视图",
      "时间线",
      "checkpoint",
      "内存 diff",
    ]);
    expect(panelOf(workspace, "stack").querySelector(".tab-title")?.textContent?.trim()).toBe("栈视图");
    workspace.remove();
  });

  it("无任何关闭入口:标题栏无关闭按钮、窗口内无关闭语义 aria、公共 API 无关闭方法", async () => {
    const workspace = await mountWorkspace();

    // 面一:窗口标题栏无关闭按钮(标题栏只承载标题与拖拽)。
    expect(shadowOf(workspace).querySelector(".tab-close")).toBeNull();
    for (const panel of panelsOf(workspace)) {
      expect(panel.querySelector(".tab-bar")?.querySelector("button")).toBeNull();
      expect(panel.querySelector(".tab-title")?.textContent?.trim()).toBe(panel.getAttribute("aria-label"));
    }
    // 面二:工作区自身无任何关闭语义属性(aria / title / data 锚)。
    expect([...shadowOf(workspace).querySelectorAll("[data-close], [data-tab-close]")]).toHaveLength(0);
    for (const element of shadowOf(workspace).querySelectorAll("*")) {
      const labels = [element.getAttribute("aria-label"), element.getAttribute("title")];
      for (const label of labels) {
        expect(label ?? "").not.toMatch(/关闭|(^|\W)close/i);
      }
    }
    // 面三:公共 API 无开 / 关入口(生命周期退场)。
    expect((workspace as unknown as Record<string, unknown>)["closeTab"]).toBeUndefined();
    expect((workspace as unknown as Record<string, unknown>)["openTab"]).toBeUndefined();
    workspace.remove();
  });

  it("窗口集恒非空:空态引导退场(无 .empty 呈现)", async () => {
    const workspace = await mountWorkspace();

    expect(shadowOf(workspace).querySelector(".empty")).toBeNull();
    expect(shadowOf(workspace).querySelector("[data-columns]")).not.toBeNull();
    workspace.remove();
  });

  it("focusWindow(type):聚焦 + 滚动到该窗口,窗口实例数不变(不是开窗)", async () => {
    const workspace = await mountWorkspace();
    const before = workspace.layoutSnapshot;
    const original = Element.prototype.scrollIntoView;
    const scrolledTo: Element[] = [];
    Element.prototype.scrollIntoView = function scrollIntoViewStub(this: Element): void {
      scrolledTo.push(this);
    };
    let focused: boolean;
    try {
      focused = workspace.focusWindow("registers");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
    await workspace.updateComplete;

    expect(focused).toBe(true);
    expect(workspace.layoutSnapshot.focusedTabId).toBe("registers");
    expect(scrolledTo.map((element) => element.getAttribute("data-tab-id"))).toContain("registers");
    // 布局与窗口集不变(仅焦点移动)。
    expect(workspace.layoutSnapshot.columns).toEqual(before.columns);
    expect(workspace.layoutSnapshot.tabs).toEqual(before.tabs);
    expect(isWindowSetComplete(workspace.layoutSnapshot)).toBe(true);
    workspace.remove();
  });

  it("focusWindow 未登记类型返回 false 且不改变布局与焦点(注册表封闭消费面)", async () => {
    const workspace = await mountWorkspace();
    const before = workspace.layoutSnapshot;

    expect(workspace.focusWindow("totally-unregistered-kind")).toBe(false);
    await workspace.updateComplete;

    expect(workspace.layoutSnapshot).toEqual(before);
    workspace.remove();
  });

  it("菜单「窗口」聚焦入口:点击发出 focus-window 动作 → 焦点移动到该窗口", async () => {
    const workspace = await mountWorkspace();
    expect(workspace.layoutSnapshot.focusedTabId).toBe("stack");

    const button = menuShadow(workspace).querySelector(
      'button.focus-window[data-window-type="payload"]',
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    button.click();
    await workspace.updateComplete;

    expect(workspace.layoutSnapshot.focusedTabId).toBe(PAYLOAD_TAB_TYPE);
    expect(panelsOf(workspace)).toHaveLength(REGISTERED_TYPES.length);
    workspace.remove();
  });

  it("首帧前接入会话(client 与挂载同 tick):窗口集绑定不触发未渲染内容的 refresh 崩溃", async () => {
    // 嵌入形态时序(web-component 插件装配):元素挂载后同一 tick 注入 client,
    // 首帧尚未渲染即发生数据源装配 / 投影回流 —— 内容元素的 refresh() 必须
    // 延后到其 renderRoot 就绪(否则内部 querySelector 取空抛错)。
    const harness = createClientHarness();
    const workspace = new SmWorkspace();
    document.body.append(workspace);
    workspace.client = harness.client;
    await workspace.updateComplete;

    await harness.client.createSession(CREATE_INPUT);
    harness.client.connect();
    FakeWebSocket.last.serverAccepts();
    await settle();
    harness.frames.flush();
    await workspace.updateComplete;
    await settleFrames(3);

    // 窗口集常驻且内容已渲染(字节窗口刷新后仍可查字节视图)。
    expect([...windowTypesOf(workspace)].sort()).toEqual([...REGISTERED_TYPES].sort());
    expect(firstByteView(workspace)).not.toBeUndefined();
    workspace.remove();
    harness.client.dispose();
  });
});

// ── 平铺(FE-WS-02 / FE-WS-01;WP-72 起默认列排布 = 宽度档预设)─────────────

describe("<sm-workspace> 列式滚动平铺(FE-WS-02)", () => {
  it("缺省布局 = 当前宽度档预设(jsdom 1024 → P0);列容器承载横向滚动", async () => {
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

    // WP-72:预设经 `bindWindows(entries, columns)` 单点注入(此处 P0 五列)。
    expect(workspace.layoutPresetId).toBe("P0");
    expect(workspace.layoutSnapshot.columns.map((column) => [...column.tabIds])).toEqual([
      ["stack", "registers"],
      ["debug", "free"],
      ["payload"],
      ["call-stack", "structure"],
      ["timeline", "checkpoints", "memory-diff"],
    ]);
    expect(shadowOf(workspace).querySelector("[data-columns]")).not.toBeNull();
    workspace.remove();
  });

  it("列间滚动可达任意列:scrollToColumn 经相机计算把目标列居中", async () => {
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

    // jsdom 无布局:桩列区几何 + 目标列矩形,断言相机算出的滚动位。
    const columns = shadowOf(workspace).querySelector("[data-columns]") as HTMLElement;
    const rect = (left: number, width: number): DOMRect =>
      ({ left, width, top: 0, height: 300, right: left + width, bottom: 300, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
    Object.defineProperty(columns, "clientWidth", { configurable: true, value: 1000 });
    Object.defineProperty(columns, "scrollWidth", { configurable: true, value: 4000 });
    columns.getBoundingClientRect = () => rect(0, 1000);
    const target = shadowOf(workspace).querySelector('[data-column-index="1"]') as HTMLElement;
    target.getBoundingClientRect = () => rect(600, 500);

    workspace.scrollToColumn(1);
    // 居中:600 + 250 − 500 = 350。
    expect(columns.scrollLeft).toBe(350);
    workspace.remove();
  });

  it("拖拽换位:pointer 事件模拟——源窗拖到另一列窗口下半 → 跨列插到其后(源列仍在)", async () => {
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

    const panelA = panelOf(workspace, "stack");
    const panelB = panelOf(workspace, "free");
    // 按下(标题栏)→ 位移过阈值 → 在 B 下半抬起(插到 B 之后)。
    (panelA.querySelector(".tab-bar") as HTMLElement).dispatchEvent(pointer("pointerdown", 10, 10));
    shadowOf(workspace).dispatchEvent(pointer("pointermove", 40, 40));
    panelB.dispatchEvent(pointer("pointerup", 10, 999));
    await workspace.updateComplete;

    // 源列(P0 列 0 = [stack, registers])未空 → 列数不变;
    // 目标列(列 1 = [debug, free])在 free 之后插入 stack。
    expect(workspace.layoutSnapshot.columns[0]?.tabIds).toEqual(["registers"]);
    expect(workspace.layoutSnapshot.columns[1]?.tabIds).toEqual(["debug", "free", "stack"]);
    expect(workspace.layoutSnapshot.columns).toHaveLength(5);
    expect(isWindowSetComplete(workspace.layoutSnapshot)).toBe(true);
    workspace.remove();
  });

  it("拖到列区空白 → 在末位新建列位(尾插)", async () => {
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

    const columns = shadowOf(workspace).querySelector("[data-columns]") as HTMLElement;
    const panelA = panelOf(workspace, "stack");
    (panelA.querySelector(".tab-bar") as HTMLElement).dispatchEvent(pointer("pointerdown", 10, 10));
    shadowOf(workspace).dispatchEvent(pointer("pointermove", 60, 60));
    columns.dispatchEvent(pointer("pointerup", 10, 10));
    await workspace.updateComplete;

    // stack 摘除后开新列:原列仍在(registers),新列追加在末尾(尾插)。
    const snapshot = workspace.layoutSnapshot;
    expect(snapshot.columns).toHaveLength(6);
    expect(snapshot.columns.at(-1)?.tabIds).toEqual(["stack"]);
    expect(snapshot.columns[0]?.tabIds).toEqual(["registers"]);
    expect(isWindowSetComplete(snapshot)).toBe(true);
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
    expect(workspace.layoutSnapshot.focusedTabId).toBe("stack");

    const panelFree = panelOf(workspace, "free");
    (panelFree.querySelector(".tab-bar") as HTMLElement).dispatchEvent(pointer("pointerdown", 10, 10));
    shadowOf(workspace).dispatchEvent(pointer("pointermove", 11, 11));
    shadowOf(workspace).dispatchEvent(pointer("pointerup", 11, 11));
    await workspace.updateComplete;
    expect(workspace.layoutSnapshot.focusedTabId).toBe("free");
    workspace.remove();
  });

  it("焦点窗口带 focused 标记;activateTab 切换跟随", async () => {
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

    // 缺省焦点 = 登记序首窗(stack)。
    expect(panelOf(workspace, "stack").classList.contains("focused")).toBe(true);
    expect(panelOf(workspace, "registers").classList.contains("focused")).toBe(false);

    workspace.activateTab("registers");
    await workspace.updateComplete;
    expect(panelOf(workspace, "registers").classList.contains("focused")).toBe(true);
    expect(panelOf(workspace, "stack").classList.contains("focused")).toBe(false);
    workspace.remove();
  });

  it("debug 类型(WP-F8)= 指令视图真工厂:解题模式呈现调试模式引导空态", async () => {
    const workspace = await mountWorkspace();
    await workspace.updateComplete;

    const panel = panelOf(workspace, "debug");
    // 解题模式(公开投影数据源,无 instructionStream)→ 指令视图呈现引导。
    expect(panel.querySelector("sm-instruction-view")).toBeInstanceOf(HTMLElement);
    expect(panel.querySelector("sm-instruction-view")?.shadowRoot?.textContent).toContain("切换到调试模式");
    expect(panel.querySelector("sm-byte-tab")).toBeNull();
    workspace.remove();
  });

  it("payload 窗口(WP-F6):工厂产出内容、组合根注入 actionSink、菜单积木步进接线(FE-WS-04b)", async () => {
    const workspace = await mountWorkspace();
    workspace.dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-stack",
          label: "stack",
          startAddressHex: "0x1000",
          byteLength: 4096,
          permissions: "rw",
          windowBytesHex: "00",
        },
      ],
      [],
    );
    await settleFrames(2);

    const content = shadowOf(workspace).querySelector("sm-payload-tab") as HTMLElement & {
      actionSink?: unknown;
      stepOnce?: () => void;
    };
    expect(content).not.toBeNull();
    // 组合根注入:actionSink 当前为 null(未接 client),但属性面已就位。
    expect("actionSink" in content).toBe(true);
    expect(typeof content.stepOnce).toBe("function");

    // 焦点窗口 = payload → 菜单「积木步进」可用。
    workspace.focusWindow(PAYLOAD_TAB_TYPE);
    await workspace.updateComplete;
    const payloadStepButton = menuShadow(workspace).querySelector(
      "button.payload-step-button",
    ) as HTMLButtonElement;
    expect(payloadStepButton.disabled).toBe(false);

    // 菜单动作 → 内容元素 stepOnce()(未接通道:可解释反馈,不抛错)。
    expect(() =>
      menuShadow(workspace).querySelector("button.payload-step-button")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, composed: true }),
      ),
    ).not.toThrow();
    await settleFrames(2);
    const logLines = [...content.shadowRoot?.querySelectorAll("ol.output-log li") ?? []];
    expect(logLines.some((line) => line.textContent?.includes("尚未连接会话"))).toBe(true);
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

  it("投影变更 → 各窗口内容 refresh()(组合根接线口径)", async () => {
    const { workspace, harness, socket } = await mountConnectedWorkspace();
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
    const list = view.shadowRoot.querySelector("sm-window-list") as unknown as {
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
    const list = view.shadowRoot.querySelector("sm-window-list") as unknown as {
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

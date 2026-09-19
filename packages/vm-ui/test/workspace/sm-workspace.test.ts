/**
 * <sm-workspace> 工作区容器集成测试(WP-F5 × WP-71 固定窗口集 / D-MP-1 ×
 * **2026-09-18 整页布局改版 = D-API-153 / D-UI-1 ~ D-UI-7**)。
 *
 *  - **固定窗口集**:挂载即按注册表登记集合建窗(各恰一实例、常驻)、无任何关闭
 *    入口、无空态引导、聚焦导航(focusWindow 聚焦 + 滚动到该视图);payload 的
 *    **唯一呈现位 = 右半侧**(主控 2026-09-18 裁定 A:左半侧视图栈不渲染 payload
 *    视图位 —— 消重名地标、消空面板;模型层仍登记全部 10 类,D-MP-1 不破);
 *  - **整页布局(D-UI-1 ~ D-UI-7)**:两分固定等分 / 恰两个可见视位(定高算式)/
 *    `Ctrl + ↑↓` 切换(**preventDefault** + 边界不环绕)/ 列表内重排(pointer 拖拽 +
 *    `Alt + ↑↓`)/ 窄屏左半侧宽度底线 / 面板 `aria-label` 不变 + 列表按钮键盘路径 +
 *    `aria-live` 播报;**布局结构面与样式面**见 `sm-workspace-layout.test.ts`,
 *    模型与算式联动见 `workspace-layout-model.test.ts`;
 *  - 菜单动作(真实 SessionClient mock 全链路):step / reset 帧形态、
 *    终态禁用 + 引导、断线横幅、connection-replaced 手动重连、
 *    rejected 错误呈现(含 explanation);
 *  - 跨视图集成:寄存器交叉标注左缘出现与点击展开(FE-RG-04)、跳转链
 *    形似地址行挂载(FE-ST-07)、viewport-jump 滚动 / 窗口外反馈(FE-ST-09);
 *  - 效果面(WP-74):装饰锚与「不承载信息」口径、动效纪律(no-preference /
 *    reduce)与主题消费 + 字号下限的**声明面**机检;真机计算值与 composed 树
 *    全树扫描归 E2E(`e2e/reduced-motion.spec.ts` + decoration.ts)。
 *
 * **已废止(整条退出)**:Niri 式列条带交互(列宽像素护栏 / 列高下限 / 列间与窗间
 * 分隔条 / 预设档位 / 焦点列相机 / 三类拖拽落点 / `scrollToColumn` / `layoutPresetId`)
 * —— 原「列式滚动平铺(FE-WS-02)」整组用例**随 D-API-153 废止**,
 * 由下方「整页布局」组按新语义取代。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionClient } from "../../src/client/session-client.js";
import { SmWorkspace } from "../../src/workspace/sm-workspace.js";
import {
  DEFAULT_VIEW_ORDER,
  HEX_ROW_HEIGHT_PX,
  SIDE_PANEL_MIN_WIDTH_PX,
  VIEW_PANEL_CHROME_HEIGHT_PX,
  VIEW_SLOT_MIN_VISIBLE_HEX_ROWS,
  VISIBLE_VIEW_SLOT_COUNT,
  viewSlotHeightPx,
} from "../../src/workspace/layout-presets.js";
import { isWindowSetComplete } from "../../src/workspace/workspace-model.js";
import { PAYLOAD_TAB_TYPE, defaultTabTypeRegistry } from "../../src/workspace/tab-registry.js";
import type { SmJumpChain } from "../../src/views/chain/sm-jump-chain.js";
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

// ── 测试夹具(无 client:直接注入 FakeMemoryDataSource)──────────────────────

import { FakeMemoryDataSource } from "../views/byte/fake-data-source.js";

/** 默认注册表登记类型集(窗口集权威来源;模型层仍登记全部 10 类)。 */
const REGISTERED_TYPES: readonly string[] = defaultTabTypeRegistry
  .list()
  .map((descriptor) => descriptor.type);

/**
 * **左半侧视图栈的呈现序**(改版后 = `DEFAULT_VIEW_ORDER` 去掉固定承载于右半侧的
 * payload)。DOM 序 = 默认顺序(经 `orderByDefault` 单点注入),不再有列分组。
 */
const PRESENTATION_ORDER: readonly string[] = DEFAULT_VIEW_ORDER.filter(
  (type) => type !== PAYLOAD_TAB_TYPE,
);

/** 左半侧应渲染的视图位类型集(挂载即全选 ⇒ = 登记集 − payload)。 */
const LEFT_VIEW_TYPES: readonly string[] = REGISTERED_TYPES.filter(
  (type) => type !== PAYLOAD_TAB_TYPE,
);

/** 等待若干渲染帧(virtualizer 可见范围计算收敛)。 */
async function settleFrames(frames: number): Promise<void> {
  for (let frame = 0; frame < frames; frame += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    await Promise.resolve();
  }
}

/** 指针事件(`cancelable` 置真:拖拽路径断言 preventDefault 语义用同一构造)。 */
function pointer(type: string, x: number, y: number): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    composed: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
}

/** 键盘事件(`cancelable: true` —— 否则 `preventDefault()` 不置 `defaultPrevented`)。 */
function key(type: string, keyName: string, modifiers: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent(type, {
    bubbles: true,
    composed: true,
    cancelable: true,
    key: keyName,
    ...modifiers,
  });
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

/** 左半侧视图栈内的视图位(按 DOM 序)。 */
function panelsOf(element: SmWorkspace): HTMLElement[] {
  return [...shadowOf(element).querySelectorAll("[data-view-stack] [data-view-panel]")] as HTMLElement[];
}

function viewTypesOf(element: SmWorkspace): string[] {
  return panelsOf(element).map((panel) => panel.getAttribute("data-view-panel") ?? "");
}

function panelOf(element: SmWorkspace, viewType: string): HTMLElement {
  const panel = shadowOf(element).querySelector(`[data-view-panel="${viewType}"]`);
  if (panel === null) {
    throw new Error(`未找到视图位:${viewType}`);
  }
  return panel as HTMLElement;
}

/** 可缺席的视图位查询(「不该渲染」类断言用;无面板返回 null)。 */
function panelOrNull(element: SmWorkspace, viewType: string): HTMLElement | null {
  return shadowOf(element).querySelector(`[data-view-panel="${viewType}"]`);
}

/**
 * `Ctrl + ↑/↓` 的**切换域**(主控 2026-09-18 裁定:与左半侧渲染集一致 ——
 * 可见视图 **− 固定承载于右半侧的 payload**;模型经可选 `isEligible` 过滤回调
 * 接收该判据,自身零 payload 字面量)。
 */
function switchDomainOf(element: SmWorkspace): string[] {
  return element.layoutSnapshot.views
    .filter((view) => view.visible && view.type !== PAYLOAD_TAB_TYPE)
    .map((view) => view.type);
}

/** 左半侧容器(视图管理窗口;`Ctrl + ↑↓` 的键盘捕获点)。 */
function leftRoleOf(element: SmWorkspace): HTMLElement {
  return shadowOf(element).querySelector(".ws-left") as HTMLElement;
}

/** 右半侧容器(payload 搭建窗口)。 */
function rightRoleOf(element: SmWorkspace): HTMLElement {
  return shadowOf(element).querySelector(".ws-right") as HTMLElement;
}

/** 视图管理窗口的列表项(按 DOM 序)。 */
function listItemsOf(element: SmWorkspace): HTMLElement[] {
  return [...shadowOf(element).querySelectorAll(".view-list-item")] as HTMLElement[];
}

/** 列表项类型序列(排序断言的直接读面)。 */
function listOrderOf(element: SmWorkspace): string[] {
  return listItemsOf(element).map((item) => item.getAttribute("data-view-type") ?? "");
}

/** `aria-live="polite"` 列表播报文本(D-UI-7 ③)。 */
function listAnnouncementOf(element: SmWorkspace): string {
  return (
    shadowOf(element).querySelector("[data-view-list-status]")?.textContent?.trim() ?? ""
  );
}

/** 常驻状态行文本(切换落点宣读面)。 */
function layoutStatusOf(element: SmWorkspace): string {
  return shadowOf(element).querySelector(".layout-status")?.textContent?.trim() ?? "";
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
  it("挂载即按注册表登记集合建窗:全部类型各恰一实例常驻(验收底线)", async () => {
    const workspace = await mountWorkspace();
    await workspace.updateComplete;

    // 模型面:登记集 10 类全在场,呈现序 = DEFAULT_VIEW_ORDER(默认顺序唯一来源)。
    const modelTypes = workspace.layoutSnapshot.views.map((view) => view.type);
    expect([...modelTypes].sort()).toEqual([...REGISTERED_TYPES].sort());
    expect(modelTypes).toEqual([...DEFAULT_VIEW_ORDER]);
    expect(isWindowSetComplete(workspace.layoutSnapshot)).toBe(true);

    // DOM 面:左半侧视图栈渲染「登记集 − payload」(payload 的唯一呈现位 = 右半侧),
    // DOM 序 = 默认顺序(不再有列分组)。
    const types = viewTypesOf(workspace);
    expect([...types].sort()).toEqual([...LEFT_VIEW_TYPES].sort());
    expect(types).toEqual([...PRESENTATION_ORDER]);
    expect(new Set(types).size).toBe(LEFT_VIEW_TYPES.length);
    // payload 视图位的唯一呈现位 = 右半侧(同一实例)。
    expect(shadowOf(workspace).querySelector('[data-view-panel="payload"]')).toBeNull();
    expect(rightRoleOf(workspace).querySelector("sm-payload-tab-host")).not.toBeNull();
    workspace.remove();
  });

  it("视图标题 = 注册表展示名(无类型内序号);类型名标签与 aria-label 同源", async () => {
    const workspace = await mountWorkspace();

    const labels = panelsOf(workspace).map((panel) => panel.getAttribute("aria-label"));
    expect(labels).toEqual([
      "栈视图",
      "寄存器视图",
      "指令视图",
      "自由视图",
      "调用栈",
      "结构视图",
      "时间线",
      "checkpoint",
      "内存 diff",
    ]);
    // 类型名写在视图内左上角(无独立标题栏);与面板地标名同源。
    expect(panelOf(workspace, "stack").querySelector(".view-label")?.textContent?.trim()).toBe("栈视图");
    expect(panelOf(workspace, "stack").firstElementChild?.classList.contains("view-label")).toBe(true);
    workspace.remove();
  });

  it("无任何关闭入口:视图位内零控件、无关闭语义 aria、公共 API 无关闭方法", async () => {
    const workspace = await mountWorkspace();

    // 面一:视图位是纯呈现区(零按钮 / 零 tabindex 后代;`.tab-bar` / `.tab-close` 已随改版退场)。
    expect(shadowOf(workspace).querySelector(".tab-close")).toBeNull();
    expect(shadowOf(workspace).querySelectorAll(".tab-bar")).toHaveLength(0);
    for (const panel of panelsOf(workspace)) {
      expect(panel.querySelector("button")).toBeNull();
      expect(panel.querySelector("[tabindex]")).toBeNull();
      expect(panel.querySelector("input, select, textarea")).toBeNull();
      expect(panel.querySelector(".view-label")?.textContent?.trim()).toBe(
        panel.getAttribute("aria-label"),
      );
    }
    // 面二:工作区自身无任何关闭语义属性(aria / title / data 锚)。
    expect([...shadowOf(workspace).querySelectorAll("[data-close], [data-tab-close]")]).toHaveLength(0);
    for (const element of shadowOf(workspace).querySelectorAll("*")) {
      const labels = [element.getAttribute("aria-label"), element.getAttribute("title")];
      for (const label of labels) {
        expect(label ?? "").not.toMatch(/关闭|(^|\W)close/i);
      }
    }
    // 面三:公共 API 无开 / 关入口(生命周期退场;列式 API 亦不留别名)。
    const surface = workspace as unknown as Record<string, unknown>;
    for (const retired of [
      "closeTab",
      "openTab",
      "scrollToColumn",
      "layoutPresetId",
      "resetLayout",
      "setFocusedColumnWidth",
      "focusedColumnIndex",
    ]) {
      expect(surface[retired], `已废止 API 仍暴露:${retired}`).toBeUndefined();
    }
    workspace.remove();
  });

  it("视图集恒非空:空态引导退场(无 .empty 呈现)", async () => {
    const workspace = await mountWorkspace();

    expect(shadowOf(workspace).querySelector(".empty")).toBeNull();
    expect(shadowOf(workspace).querySelector("[data-view-stack]")).not.toBeNull();
    workspace.remove();
  });

  it("focusWindow(type):聚焦 + 滚动到该视图,视图集与顺序不变(不是开窗)", async () => {
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
    expect(scrolledTo.map((element) => element.getAttribute("data-view-panel"))).toContain("registers");
    // 视图集 / 顺序 / 可见性 / 左半侧宽零变化(仅焦点移动)。
    expect(workspace.layoutSnapshot.views).toEqual(before.views);
    expect(viewTypesOf(workspace)).toEqual([...PRESENTATION_ORDER]);
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

  it("菜单「视图」聚焦入口:点击发出 focus-window 动作 → 焦点移动到该视图", async () => {
    const workspace = await mountWorkspace();
    expect(workspace.layoutSnapshot.focusedTabId).toBe("stack");

    const button = menuShadow(workspace).querySelector(
      'button.focus-window[data-window-type="payload"]',
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    button.click();
    await workspace.updateComplete;

    // payload 无左半侧视图位,但**聚焦导航照常可用**(模型面仍登记 payload)。
    expect(workspace.layoutSnapshot.focusedTabId).toBe(PAYLOAD_TAB_TYPE);
    expect(viewTypesOf(workspace)).toEqual([...PRESENTATION_ORDER]);
    expect(panelsOf(workspace)).toHaveLength(LEFT_VIEW_TYPES.length);
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
    expect([...viewTypesOf(workspace)].sort()).toEqual([...LEFT_VIEW_TYPES].sort());
    expect(rightRoleOf(workspace).querySelector("sm-payload-tab-host")).not.toBeNull();
    expect(firstByteView(workspace)).not.toBeUndefined();
    workspace.remove();
    harness.client.dispose();
  });
});

// ── 整页布局与视图管理窗口(D-UI-1 ~ D-UI-7;取代原「列式滚动平铺」)──────────

describe("<sm-workspace> 整页布局与视图管理窗口(D-UI-1 ~ D-UI-7)", () => {
  it("D-UI-1:页主体两分(左右半侧是同一网格的直接子项;零分隔条;右半侧固定承载 payload)", async () => {
    const workspace = await mountWorkspace();
    const shadow = shadowOf(workspace);

    const body = shadow.querySelector("[data-workspace-body]") as HTMLElement;
    const left = leftRoleOf(workspace);
    const right = rightRoleOf(workspace);
    expect(body).not.toBeNull();
    expect(left.parentElement).toBe(body);
    expect(right.parentElement).toBe(body);
    // 两分固定:**无 gap / 无 border / 零 divider / 零分界拖拽手柄**(无边框紧密贴合)。
    expect(shadow.querySelectorAll('[role="separator"], .column-divider, .row-divider, .ws-divider')).toHaveLength(
      0,
    );
    // 两半侧各就各位(左半侧 = 视图管理窗口;右半侧 = payload 搭建窗口)。
    expect(left.getAttribute("aria-label")).toBe("视图管理窗口");
    expect(right.getAttribute("aria-label")).toBe("Payload 搭建");
    expect(right.querySelector("sm-payload-tab-host")).not.toBeNull();
    workspace.remove();
  });

  it("D-UI-2:恰两个可见视位语义(定高算式;渲染数不做裁剪;每视位 ≥ chrome + 4 行)", async () => {
    const workspace = await mountWorkspace();
    const panels = panelsOf(workspace);

    // ① 渲染数 = 可见视图数 − 1(payload 固定承载于右半侧):不做「只渲染两个」的裁剪。
    const visible = workspace.layoutSnapshot.views.filter((view) => view.visible);
    expect(visible).toHaveLength(REGISTERED_TYPES.length);
    expect(panels).toHaveLength(LEFT_VIEW_TYPES.length);
    expect(VISIBLE_VIEW_SLOT_COUNT).toBe(2);
    // ② 每个可见视图位都有**内联确定高度**,且 = viewSlotHeightPx(左半侧高)。
    const expectedSlot = viewSlotHeightPx(window.innerHeight);
    for (const panel of panels) {
      expect(panel.style.blockSize).toBe(`${expectedSlot}px`);
      // ③ 可读性判据:视位高 − chrome 后仍容纳 ≥ N 行(下限保证「装得下一行字节」)。
      const rows = (Number.parseFloat(panel.style.blockSize) - VIEW_PANEL_CHROME_HEIGHT_PX) / HEX_ROW_HEIGHT_PX;
      expect(rows).toBeGreaterThanOrEqual(VIEW_SLOT_MIN_VISIBLE_HEX_ROWS);
    }
    // ④ 可视区恰两个视位由**定高算式**承载(空间不足即 `.ws-stack` 纵向滚动,不压缩)。
    expect(panels.length).toBeGreaterThan(VISIBLE_VIEW_SLOT_COUNT);
    workspace.remove();
  });

  it("D-UI-3:Ctrl + ↑ / ↓ 切换可见视图位(切换 + preventDefault + 边界不环绕 + 状态行宣读)", async () => {
    const workspace = await mountWorkspace();
    const left = leftRoleOf(workspace);
    const status = () => shadowOf(workspace).querySelector(".layout-status") as HTMLElement;

    /**
     * 切换域 = **左半侧可见视图位序**(主控裁定:与左半侧渲染集一致,
     * 跳过固定承载于右半侧的 payload)。断言按此口径落 —— payload 不在序列内。
     */
    const domain = switchDomainOf(workspace);
    expect(domain).toEqual([...PRESENTATION_ORDER]);
    expect(domain).toHaveLength(LEFT_VIEW_TYPES.length);
    expect(domain).not.toContain(PAYLOAD_TAB_TYPE);
    expect(domain.at(-1)).toBe("memory-diff");

    expect(workspace.activeViewType).toBeNull();
    expect(status().getAttribute("data-active-view")).toBeNull();

    // ↓:首次落在**首个可见视图位**;必须 preventDefault(覆盖浏览器页面滚动默认)。
    const down = key("keydown", "ArrowDown", { ctrlKey: true });
    left.dispatchEvent(down);
    await workspace.updateComplete;
    expect(down.defaultPrevented).toBe(true);
    expect(workspace.activeViewType).toBe(domain[0]);
    expect(status().getAttribute("data-active-view")).toBe(domain[0]);
    expect(layoutStatusOf(workspace)).toContain("栈视图");
    expect(layoutStatusOf(workspace)).toContain("Ctrl");

    // ↓ 逐步推进到**末个可见视图位**(边界不环绕:继续按不再变化);
    // 每一步都不得停在 payload(它固定承载于右半侧,不在切换序列内)。
    for (let step = 1; step < domain.length; step += 1) {
      const event = key("keydown", "ArrowDown", { ctrlKey: true });
      left.dispatchEvent(event);
      await workspace.updateComplete;
      expect(event.defaultPrevented).toBe(true);
      expect(workspace.activeViewType).toBe(domain[step]);
      expect(workspace.activeViewType).not.toBe(PAYLOAD_TAB_TYPE);
      // 每一步的落点都有对应的左半侧视图位(切换域 ≡ 渲染集)。
      expect(panelOrNull(workspace, workspace.activeViewType as string)).not.toBeNull();
    }
    expect(workspace.activeViewType).toBe(domain[domain.length - 1]);
    expect(layoutStatusOf(workspace)).toContain("内存 diff");

    const beyond = key("keydown", "ArrowDown", { ctrlKey: true });
    left.dispatchEvent(beyond);
    await workspace.updateComplete;
    expect(workspace.activeViewType).toBe(domain[domain.length - 1]); // 边界不环绕。
    expect(beyond.defaultPrevented).toBe(true);

    // ↑:回退一格;首位的 ↑ 亦不环绕。
    left.dispatchEvent(key("keydown", "ArrowUp", { ctrlKey: true }));
    await workspace.updateComplete;
    expect(workspace.activeViewType).toBe(domain[domain.length - 2]);

    // 无 Ctrl 的方向键不介入(不 preventDefault、不切换)。
    const plain = key("keydown", "ArrowDown");
    left.dispatchEvent(plain);
    await workspace.updateComplete;
    expect(plain.defaultPrevented).toBe(false);
    expect(workspace.activeViewType).toBe(domain[domain.length - 2]);

    // 隐藏落点所在视图 ⇒ 落点复位(不可见视图不在切换序列内)。
    expect(workspace.setViewVisible(domain[domain.length - 2] as string, false)).toBe(true);
    await workspace.updateComplete;
    expect(workspace.activeViewType).toBeNull();
    workspace.remove();
  });

  it("D-UI-4:列表内重排——pointer 拖拽(落点指示 + 拖拽态 + 播报「已移动到第 N 位」)", async () => {
    const workspace = await mountWorkspace();
    const items = listItemsOf(workspace);
    const source = items[0] as HTMLElement; // stack
    const target = items[1] as HTMLElement; // registers

    expect(source.getAttribute("data-view-type")).toBe("stack");
    expect(target.getAttribute("data-view-index")).toBe("1");

    source.dispatchEvent(pointer("pointerdown", 10, 10));
    // 位移未过阈值 ⇒ 仍是点击,不进入拖拽态。
    target.dispatchEvent(pointer("pointermove", 11, 11));
    await workspace.updateComplete;
    expect(source.classList.contains("dragging")).toBe(false);

    // 越过阈值 + 落在目标条目**下半** ⇒ 落点指示 = drop-after。
    target.dispatchEvent(pointer("pointermove", 10, 299));
    await workspace.updateComplete;
    expect(source.classList.contains("dragging")).toBe(true);
    expect(target.classList.contains("drop-after")).toBe(true);
    expect(target.classList.contains("drop-before")).toBe(false);

    target.dispatchEvent(pointer("pointerup", 10, 299));
    await workspace.updateComplete;

    // 列表内重排恰一种落点语义:stack 落在 registers 之后(第 2 位)。
    expect(listOrderOf(workspace).slice(0, 2)).toEqual(["registers", "stack"]);
    expect(listOrderOf(workspace)).toHaveLength(REGISTERED_TYPES.length);
    // DOM 序与模型序一致(左半侧视图栈随之重排;payload 不在栈内)。
    expect(viewTypesOf(workspace)).toEqual(
      listOrderOf(workspace).filter((type) => type !== PAYLOAD_TAB_TYPE),
    );
    // 拖拽态清除 + aria-live 播报。
    expect(shadowOf(workspace).querySelector(".dragging")).toBeNull();
    expect(shadowOf(workspace).querySelector(".drop-after")).toBeNull();
    expect(listAnnouncementOf(workspace)).toBe("已把「栈视图」移动到第 2 位");
    expect(isWindowSetComplete(workspace.layoutSnapshot)).toBe(true);
    workspace.remove();
  });

  it("D-UI-4:列表内重排——Alt + ↑ / ↓ 键盘等价路径(preventDefault)", async () => {
    const workspace = await mountWorkspace();
    const item = shadowOf(workspace).querySelector(
      '.view-list-item[data-view-type="stack"]',
    ) as HTMLElement;

    const down = key("keydown", "ArrowDown", { altKey: true });
    item.dispatchEvent(down);
    await workspace.updateComplete;
    expect(down.defaultPrevented).toBe(true);
    expect(listOrderOf(workspace).slice(0, 2)).toEqual(["registers", "stack"]);
    expect(listAnnouncementOf(workspace)).toBe("已把「栈视图」移动到第 2 位");

    // ↑ 回到原位(在列表内上下移动该条目)。
    const moved = shadowOf(workspace).querySelector(
      '.view-list-item[data-view-type="stack"]',
    ) as HTMLElement;
    const up = key("keydown", "ArrowUp", { altKey: true });
    moved.dispatchEvent(up);
    await workspace.updateComplete;
    expect(up.defaultPrevented).toBe(true);
    expect(listOrderOf(workspace).slice(0, 2)).toEqual(["stack", "registers"]);
    expect(listAnnouncementOf(workspace)).toBe("已把「栈视图」移动到第 1 位");

    // 无 Alt 的方向键不介入(列表内移动只认 Alt 组合)。
    const plain = key("keydown", "ArrowDown");
    moved.dispatchEvent(plain);
    await workspace.updateComplete;
    expect(plain.defaultPrevented).toBe(false);
    expect(listOrderOf(workspace).slice(0, 2)).toEqual(["stack", "registers"]);
    workspace.remove();
  });

  it("D-UI-5:窄屏底线与页面横向滚动语义(结构断言;真实读数归真机几何)", async () => {
    const workspace = await mountWorkspace();

    // 形态不随视口宽改变:无「隐藏右半侧 / 上下堆叠 / 单列」分支 —— 窄屏由
    // `.ws-left` 的 `min-inline-size: 452.4px` 与两轨保底把右半侧挤出视口。
    expect(leftRoleOf(workspace).classList.contains("ws-left")).toBe(true);
    expect(rightRoleOf(workspace)).not.toBeNull();
    const styles = (
      (SmWorkspace as unknown as { elementStyles?: { cssText?: string }[] }).elementStyles ?? []
    )
      .map((style) => style.cssText ?? "")
      .join("\n");
    expect(styles).toContain(`min-inline-size: ${SIDE_PANEL_MIN_WIDTH_PX}px`);
    expect(styles).toContain(`minmax(${SIDE_PANEL_MIN_WIDTH_PX}px, 1fr)`);

    // jsdom 无布局:只断言「登记面」—— 尺寸变化写入 leftRoleWidth(D-UI-5 的核对面),
    // 且**不夹取**到底线(底线由 CSS 承担)。
    Object.defineProperty(leftRoleOf(workspace), "clientWidth", { configurable: true, value: 320 });
    Object.defineProperty(leftRoleOf(workspace), "clientHeight", { configurable: true, value: 640 });
    window.dispatchEvent(new Event("resize"));
    await workspace.updateComplete;
    expect(workspace.leftRoleWidth).toBe(320);
    expect(SIDE_PANEL_MIN_WIDTH_PX).toBeGreaterThan(320);
    workspace.remove();
  });

  it("D-UI-7:面板 aria-label 不变 + 列表按钮键盘路径 + aria-live 播报文本", async () => {
    const workspace = await mountWorkspace();
    const shadow = shadowOf(workspace);

    // ① 地标名不因标题栏消失而改名(避免二次 axe 地标重名回归):面板 aria-label
    //    = 视图标题;类型名标签在面板内左上角。
    expect(panelOf(workspace, "stack").getAttribute("aria-label")).toBe("栈视图");
    expect(panelOf(workspace, "stack").querySelector(".view-label")?.textContent?.trim()).toBe("栈视图");
    // 视图位是独立 region,不得被 aria-hidden / presentation 简化掉。
    for (const panel of panelsOf(workspace)) {
      expect(panel.getAttribute("aria-hidden")).toBeNull();
      expect(panel.getAttribute("role")).toBeNull();
    }

    // ② 列表按钮:可展开 / 收起的 `<details>` + `<summary>`(原生 aria-expanded),
    //    条目可聚焦、勾选用原生 checkbox、序号由 span 承载。
    const button = shadow.querySelector(".view-list-button") as HTMLDetailsElement;
    const summary = button.querySelector("summary") as HTMLElement;
    expect(button.tagName).toBe("DETAILS");
    expect(summary.textContent?.trim()).toBe("视图列表(勾选显示 / 拖拽排序)");
    expect(button.open).toBe(false); // 缺省收起(可展开)
    button.open = true;
    await workspace.updateComplete;
    expect(button.open).toBe(true);

    const item = shadow.querySelector('.view-list-item[data-view-type="stack"]') as HTMLElement;
    expect(item.getAttribute("tabindex")).toBe("0");
    const checkbox = item.querySelector(
      'input[type="checkbox"].view-list-checkbox[data-view-visible="stack"]',
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(checkbox.labels?.[0]?.textContent?.trim()).toBe("栈视图");
    expect(item.querySelector(".view-list-order")?.textContent?.trim()).toBe("1");

    // ③ 勾选(原生 checkbox;Space 由原生承担)⇒ aria-live="polite" 播报「已隐藏」。
    expect(shadow.querySelector("[data-view-list-status]")?.getAttribute("aria-live")).toBe("polite");
    checkbox.click();
    await workspace.updateComplete;
    expect(listAnnouncementOf(workspace)).toBe("已隐藏「栈视图」");
    expect(panelOrNull(workspace, "stack")).toBeNull();
    // 再次勾选 ⇒ 播报「已显示」且面板回来(可见性只改显示,不是开 / 关)。
    (shadow.querySelector('.view-list-item[data-view-type="stack"] input[type="checkbox"]') as HTMLInputElement).click();
    await workspace.updateComplete;
    expect(listAnnouncementOf(workspace)).toBe("已显示「栈视图」");
    expect(panelOrNull(workspace, "stack")).not.toBeNull();
    expect(workspace.layoutSnapshot.views).toHaveLength(REGISTERED_TYPES.length);
    workspace.remove();
  });

  it("D-UI-7 补充裁定:勾选 / 排序的**唯一入口** = 左半侧列表按钮(视图位内零第二入口)", async () => {
    const workspace = await mountWorkspace();
    const shadow = shadowOf(workspace);

    // 勾选入口唯一:工作区 shadow 内恰 REGISTERED_TYPES.length 个 checkbox,且全部
    // 落在列表项内(视图位 / 右半侧零 checkbox)。
    const checkboxes = [...shadow.querySelectorAll('input[type="checkbox"]')];
    expect(checkboxes).toHaveLength(REGISTERED_TYPES.length);
    for (const checkbox of checkboxes) {
      expect(checkbox.closest(".view-list-item")).not.toBeNull();
    }
    expect(shadow.querySelectorAll('[data-view-stack] input, .ws-right input')).toHaveLength(0);
    // 排序入口唯一:零拖拽把手(条目自身即把手),视图位零 tabindex / 零 pointer 语义锚。
    expect(shadow.querySelectorAll(".drag-handle, [data-drag-handle], [draggable]")).toHaveLength(0);
    for (const panel of panelsOf(workspace)) {
      expect(panel.querySelector("[tabindex]")).toBeNull();
    }
    workspace.remove();
  });

  it("焦点视图位带 focused 标记;activateTab 切换跟随", async () => {
    const workspace = await mountWorkspace();
    await workspace.updateComplete;

    // 缺省焦点 = 默认顺序首项(stack)。
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

    // WP-83:payload 工厂已换**惰性宿主**(`<sm-payload-tab-host>`),真组件要等
    // 动态 `import()` 完成 —— 宿主暴露 `whenReady()` 就绪钩子(WP-80 与 WP-83 的
    // 共同接缝:注册表内容元素的 duck-typing 注入面现在落在宿主上)。直接断言
    // 「连接后同步存在 `<sm-payload-tab>`」会随加载时序抖动(全量套件高负载下
    // 实测红、单文件跑绿)。
    const host = shadowOf(workspace).querySelector("sm-payload-tab-host") as HTMLElement & {
      actionSink?: unknown;
      stepOnce?: () => void;
      whenReady: () => Promise<HTMLElement & { actionSink?: unknown; stepOnce?: () => void }>;
    };
    expect(host).not.toBeNull();
    // 组合根注入:actionSink 当前为 null(未接 client),但属性面已就位(宿主转发访问器)。
    expect("actionSink" in host).toBe(true);
    expect(typeof host.stepOnce).toBe("function");

    const content = await host.whenReady();
    expect(content.shadowRoot).not.toBeNull();

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
    const chain = addressRow?.querySelector("sm-jump-chain") as SmJumpChain | null;
    expect(chain).not.toBeNull();
    // ① 属性面绑定真的生效(既有缺陷:裸属性 `start-address-hex` 从未被组件观察
    //    ⇒ `startAddressHex` 恒空、链恒空渲染;此处断言属性值本身)。
    expect(chain?.startAddressHex).toBe("0x1000");
    // ② 链真的渲染出内容(能抓住「链恒空渲染」回归的断言;裸属性断言测不到)。
    await (chain as SmJumpChain).updateComplete;
    const chainShadow = (chain as SmJumpChain).shadowRoot as ShadowRoot;
    expect(chainShadow.querySelector(".chain")).not.toBeNull();
    expect(chainShadow.querySelector('.chain-address[data-address="0x1000"]')).not.toBeNull();

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

// ── 效果面(WP-74:扫描线 overlay / 光标闪烁 / 终端式标题栏)────────────────────

/**
 * 终态契约 C1~C9 的判定在真机 E2E(`apps/plugin-dev/e2e/reduced-motion.spec.ts`
 * × `e2e/helpers/decoration.ts` 文件头);本组是 **jsdom 结构面**机检:装饰锚 /
 * 不承载信息口径 / 零控件口径 / 样式面契约标记(jsdom 不评估媒体查询,故动画与
 * 强度取值只能以声明文本机检,token 驱动的计算值面归真机)。
 */
describe("<sm-workspace> 效果面(WP-74)", () => {
  /** 组件静态样式合并文本(与 sm-workspace-layout.test.ts 同款读法;静态面,无需挂载)。 */
  function stylesTextOf(): string {
    const styles =
      (SmWorkspace as unknown as { elementStyles?: { cssText?: string }[] }).elementStyles ?? [];
    expect(styles.length, "组件静态样式缺席?").toBeGreaterThan(0);
    return styles.map((style) => style.cssText ?? "").join("\n").replace(/\s+/g, " ");
  }

  /** 可聚焦后代(与 E2E decoration.ts 的判定式同款)。 */
  const FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';

  it("扫描线 overlay:锚在场、装饰不承载信息、强度与形态由 token 驱动(C1~C4/C7)", async () => {
    const workspace = await mountWorkspace();

    const scanlines = [...shadowOf(workspace).querySelectorAll('[data-sm-decoration="scanline"]')];
    expect(scanlines).toHaveLength(1);
    const scanline = scanlines[0] as HTMLElement;
    // C7:纯装饰(aria-hidden + 零文本 + 零可聚焦后代),命中测试不受影响(C4)。
    expect(scanline.getAttribute("aria-hidden")).toBe("true");
    expect(scanline.getAttribute("part")).toBe("scanline");
    expect(scanline.textContent?.trim()).toBe("");
    expect(scanline.querySelectorAll(FOCUSABLE)).toHaveLength(0);

    const cssText = stylesTextOf();
    // C2 形态 + C4 命中测试(静态属性,与动效偏好无关)+ C3 强度由
    // --sm-scanline-opacity 驱动;C8 基态不生成(reduce 下零绘制)。
    expect(cssText).toContain("repeating-linear-gradient");
    expect(cssText).toMatch(/\.sm-scanline\s*\{[^}]*pointer-events: none/);
    expect(cssText).toContain("opacity: var(--sm-scanline-opacity, 0)");
    expect(cssText).toMatch(/\.sm-scanline\s*\{[^}]*display: none/);
    workspace.remove();
  });

  it("光标装饰:随独立标题栏整条退场(零 caret 节点);视图位仍零控件(C5/C6/C7)", async () => {
    const workspace = await mountWorkspace();
    const panels = panelsOf(workspace);

    // 回归护栏(原用例在此处**假绿**:`.`tab-bar` 退场后 `carets.length = 0`
    // 与 `panelsOf()` 取旧选择器得到的 0 相等 —— 断言两边都空,什么都没测)。
    // 改版后「终端式标题栏角标」随 `.tab-bar` 退场 ⇒ **恰零个 caret 装饰节点**;
    // 视图位数量非零,断言两侧都真实非空(避免再次退化为空断言)。
    expect(panels.length).toBe(LEFT_VIEW_TYPES.length);
    const carets = [...shadowOf(workspace).querySelectorAll('[data-sm-decoration="caret"]')];
    expect(carets).toHaveLength(0);
    // 唯一保留的装饰 = 扫描线 overlay(恰 1 个)。
    expect(shadowOf(workspace).querySelectorAll('[data-sm-decoration="scanline"]')).toHaveLength(1);

    // 视图位仍零控件 / 零可聚焦后代(D-UI-7 ②:视图位是独立 region,不用装饰简化)。
    for (const panel of panels) {
      expect(panel.querySelector(`button, a[href], input, select, textarea, [tabindex]`)).toBeNull();
      expect(panel.querySelectorAll('[data-sm-decoration="caret"]')).toHaveLength(0);
      expect(panel.getAttribute("aria-hidden")).toBeNull();
    }

    const cssText = stylesTextOf();
    // C6(声明面保留):动画周期解析自 --sm-caret-blink,且为阶跃(steps)而非平滑淡入淡出。
    expect(cssText).toContain("animation-duration: var(--sm-caret-blink, 0s)");
    expect(cssText).toContain("steps(1, end)");
    workspace.remove();
  });

  it("动效纪律:全部动画包在 no-preference 内,reduce 下装饰 display: none(C8/C9)", () => {
    const cssText = stylesTextOf();

    expect(cssText).toContain("@media (prefers-reduced-motion: no-preference)");
    expect(cssText).toContain("@media (prefers-reduced-motion: reduce)");
    // reduce 覆盖:C8 = 装饰不可见(display: none);C9 = 无 reduce 外动画声明。
    const reduceIndex = cssText.indexOf("@media (prefers-reduced-motion: reduce)");
    const reduceBody = cssText.slice(reduceIndex);
    expect(reduceBody).toMatch(/\.sm-scanline[^{]*\{[^}]*display: none/);
    expect(reduceBody).toMatch(/\.sm-caret[^{]*\{[^}]*display: none/);
    // 动画只用 opacity(零大面积 glow / text-shadow)。
    expect(cssText).not.toContain("text-shadow");
  });

  it("主题消费与字号下限(§2.1):等宽字体栈走 token,无小于 13px 的字号", () => {
    const cssText = stylesTextOf();

    // 等宽字体栈 = token + 逐字回退栈(字体栈字面量内联,零模板插值)。
    expect(cssText).toContain(
      'font-family: var(--sm-font-mono, ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, "Noto Sans Mono CJK SC", monospace)',
    );
    // 字号下限 13px(0.8125rem = 13px,仓库既有等价惯例)。
    const sizes = [...cssText.matchAll(/font-size:\s*([\d.]+)rem/g)].map((match) =>
      Number(match[1]),
    );
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) {
      expect(size, `字号低于 13px 下限:${size}rem`).toBeGreaterThanOrEqual(0.8125);
    }
  });
});

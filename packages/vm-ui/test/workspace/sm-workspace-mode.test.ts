/**
 * <sm-workspace> 模式切换与 ED 挂接测试(WP-F8 / FE-WS-04c/06/07 + FE-ED 系):
 *  - debugModeAvailable 门槛(未启用题目隐藏切换项);
 *  - 模式切换:数据源换绑(字节视图换绑即重建 = 锚点重置口径)、what-if
 *    横幅显隐、运行到断点动作、payload 标签页状态两模式共用(元素不销毁);
 *  - ED 挂接:结构视图 highlights 注入与 highlight-jump 联动、时间线条目
 *    (动作账本)、checkpoint 刷新时点(list_checkpoints 重拉)、提示揭示
 *    (failed 计数)、错误解释(userVisibleError + teachingNote)。
 *
 * 调试档数据源以替身注入(debugDataSourceFactory 测试接缝);会话链路 =
 * 真实 SessionClient + mock 传输(与 sm-workspace.test 同一基建)。
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { DebugDataSource, DebugDataSourceChangeEvent } from "../../src/datasource/debug-data-source.js";
import type { MemoryDataSource } from "../../src/datasource/types.js";
import { SessionClient } from "../../src/client/session-client.js";
import { ProjectionDataSource } from "../../src/datasource/projection-data-source.js";
import { SmWorkspace } from "../../src/workspace/sm-workspace.js";
import { SmByteTab } from "../../src/workspace/byte-tab.js";
import { PAYLOAD_TAB_TYPE, createDefaultTabTypeRegistry } from "../../src/workspace/tab-registry.js";
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

// ── 会话链路夹具(与 sm-workspace.test 同形态;/sessions/checkpoints 增列)──

function workspaceProjection() {
  return makeProjection({
    status: "running",
    revision: 0,
    visibleRegions: [
      {
        regionId: "region-stack",
        label: "stack",
        startAddressHex: "0x1000",
        byteLength: 4096,
        permissions: "rw",
        bytesHex: "0102030405060708",
        truncated: false,
      },
    ],
    visibleRegisters: [
      { name: "RSP", valueHex: "0x1004" },
      { name: "RIP", valueHex: "0x1004" },
    ],
  });
}

const CHECKPOINTS_PAYLOAD = {
  checkpoints: [{ checkpointId: "ckpt-0001", revision: 2, label: "dev-label" }],
};

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
      case "/sessions/checkpoints":
        return {
          status: 200,
          body: { command: "list_checkpoints", payload: CHECKPOINTS_PAYLOAD },
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

// ── 调试档数据源替身(工厂注面;记录 attach / dispose / runToBreakpoint)────

class StubDebugSource implements MemoryDataSource {
  attachCount = 0;
  disposed = false;
  readonly runCalls: readonly (readonly string[])[] = [];
  readonly prefetchRequests: string[] = [];
  breakpoints: readonly string[] = ["0x1004"];
  readonly #listeners: ((event: DebugDataSourceChangeEvent) => void)[] = [];

  get breakpointCount(): number {
    return this.breakpoints.length;
  }

  isBreakpoint(addressHex: string): boolean {
    return this.breakpoints.includes(addressHex);
  }

  addBreakpoint(addressHex: string): void {
    if (!this.breakpoints.includes(addressHex)) {
      this.breakpoints = [...this.breakpoints, addressHex];
      this.emit({ kind: "breakpoints", breakpoints: this.breakpoints });
    }
  }

  removeBreakpoint(addressHex: string): void {
    if (this.breakpoints.includes(addressHex)) {
      this.breakpoints = this.breakpoints.filter((entry) => entry !== addressHex);
      this.emit({ kind: "breakpoints", breakpoints: this.breakpoints });
    }
  }

  toggleBreakpoint(addressHex: string): void {
    if (this.breakpoints.includes(addressHex)) {
      this.removeBreakpoint(addressHex);
    } else {
      this.addBreakpoint(addressHex);
    }
  }

  onChange(listener: (event: DebugDataSourceChangeEvent) => void): () => void {
    this.#listeners.push(listener);
    return () => {
      const index = this.#listeners.indexOf(listener);
      if (index >= 0) {
        this.#listeners.splice(index, 1);
      }
    };
  }

  emit(event: DebugDataSourceChangeEvent): void {
    for (const listener of [...this.#listeners]) {
      listener(event);
    }
  }

  attach(): void {
    this.attachCount += 1;
  }

  dispose(): void {
    this.disposed = true;
  }

  async runToBreakpoint(addresses?: readonly string[]): Promise<{ reason: string; addressHex: string }> {
    (this.runCalls as string[][]).push([...(addresses ?? this.breakpoints)]);
    return { reason: "breakpoint", addressHex: "0x1004" };
  }

  async prefetchWindow(addressHex: string): Promise<unknown> {
    this.prefetchRequests.push(addressHex);
    return { addressHex, bytesHex: "00" };
  }

  regions() {
    return [];
  }

  registers() {
    return [];
  }

  bytesRows() {
    return [];
  }

  search() {
    return [];
  }

  instructionStream() {
    return [];
  }
}

// ── 挂载工具 ─────────────────────────────────────────────────────────────────

async function settleFrames(frames: number): Promise<void> {
  for (let frame = 0; frame < frames; frame += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    await Promise.resolve();
  }
}

interface Fixture {
  readonly workspace: SmWorkspace;
  readonly harness: ClientHarness;
  readonly socket: FakeWebSocket;
  readonly stub: StubDebugSource;
}

/** 装配"已建会话 + 已连接 + 栈视图 + 调试工厂注入(debugModeAvailable=true)"。 */
async function mountDebugCapableWorkspace(): Promise<Fixture> {
  const harness = createClientHarness();
  const workspace = new SmWorkspace();
  workspace.debugModeAvailable = true;
  const stub = new StubDebugSource();
  workspace.debugDataSourceFactory = () => stub as unknown as DebugDataSource;
  document.body.append(workspace);
  await workspace.updateComplete;

  workspace.client = harness.client;
  await workspace.updateComplete;
  await harness.client.createSession(CREATE_INPUT);
  harness.client.connect();
  const socket = FakeWebSocket.last;
  socket.serverAccepts();
  await settle();
  harness.frames.flush();
  await workspace.updateComplete;

  workspace.openTab("stack");
  await workspace.updateComplete;
  await settleFrames(3);
  return { workspace, harness, socket, stub };
}

function shadowOf(workspace: SmWorkspace): ShadowRoot {
  return workspace.shadowRoot as ShadowRoot;
}

function menuShadow(workspace: SmWorkspace): ShadowRoot {
  return (shadowOf(workspace).querySelector("sm-workspace-menu") as HTMLElement).shadowRoot as ShadowRoot;
}

function byteTabOf(workspace: SmWorkspace): SmByteTab {
  const tab = shadowOf(workspace).querySelector("sm-byte-tab");
  if (tab === null) {
    throw new Error("未找到字节页内容");
  }
  return tab as SmByteTab;
}

function clickMenuButton(workspace: SmWorkspace, selector: string): void {
  const button = menuShadow(workspace).querySelector(selector);
  if (button === null) {
    throw new Error(`菜单按钮不存在:${selector}`);
  }
  button.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
}

function sendActionFromServer(socket: FakeWebSocket, response: ReturnType<typeof makeActionResponse>): void {
  const sent = socket.sent.at(-1) as Record<string, unknown> | undefined;
  socket.serverSends(
    serverFrame("action_response", response, 99, sent?.requestId as string | undefined),
  );
}

beforeEach(() => {
  FakeWebSocket.reset();
});

// ── FE-WS-06:模式切换 ─────────────────────────────────────────────────────

describe("FE-WS-06:debugModeAvailable 门槛与模式切换", () => {
  it("未启用调试(debugModeAvailable=false)的题目:菜单隐藏模式切换项", async () => {
    const harness = createClientHarness();
    const workspace = new SmWorkspace(); // 缺省 false。
    document.body.append(workspace);
    await workspace.updateComplete;
    expect(menuShadow(workspace).querySelector(".mode-toggle-button")).toBeNull();
    workspace.remove();
    void harness;
  });

  it("启用调试:切换项可见;点击 → 换绑调试数据源 + attach + what-if 横幅", async () => {
    const { workspace, stub } = await mountDebugCapableWorkspace();
    expect(menuShadow(workspace).querySelector(".mode-toggle-button")?.textContent).toContain("切换到调试模式");

    clickMenuButton(workspace, ".mode-toggle-button");
    await workspace.updateComplete;

    expect(workspace.mode).toBe("debug");
    expect(stub.attachCount).toBe(1);
    expect(workspace.debugDataSource).toBe(stub);
    // 数据源换绑:字节页(含其内部字节视图)拿到 DebugDataSource(换绑即重建
    // = F5 既有锚点/滚动重置口径,验收依据)。
    expect(byteTabOf(workspace).dataSource).toBe(stub as unknown as MemoryDataSource);
    // 菜单:切换项文案反转 + 模式指示 + what-if 纪律横幅常驻(ADR-DC1 条款 7)。
    expect(menuShadow(workspace).querySelector(".mode-toggle-button")?.textContent).toContain("返回解题模式");
    expect(menuShadow(workspace).querySelector(".mode-indicator")?.textContent).toContain("调试模式");
    const banner = menuShadow(workspace).querySelector(".whatif-banner");
    expect(banner?.textContent).toContain("调试通过 ≠ 提交通过");
    expect(banner?.textContent).toContain("ASLR");
    workspace.remove();
  });

  it("返回解题模式:调试档释放 + 重绑公开投影数据源 + 横幅消隐", async () => {
    const { workspace, stub, harness } = await mountDebugCapableWorkspace();
    clickMenuButton(workspace, ".mode-toggle-button");
    await workspace.updateComplete;

    clickMenuButton(workspace, ".mode-toggle-button");
    await workspace.updateComplete;

    expect(workspace.mode).toBe("solve");
    expect(stub.disposed).toBe(true);
    expect(workspace.dataSource).toBeInstanceOf(ProjectionDataSource);
    expect(workspace.dataSource).not.toBe(stub);
    expect(byteTabOf(workspace).dataSource).toBeInstanceOf(ProjectionDataSource);
    expect(menuShadow(workspace).querySelector(".whatif-banner")).toBeNull();
    void harness;
    workspace.remove();
  });
});

// ── FE-WS-07:payload 状态两模式共用 ────────────────────────────────────────

describe("FE-WS-07:payload 标签页状态两模式共用", () => {
  it("模式切换不销毁 payload 元素(程序状态保留;dataSource 换绑不重建元素)", async () => {
    const { workspace } = await mountDebugCapableWorkspace();
    const payloadId = workspace.openTab("payload");
    expect(payloadId).not.toBeNull();
    await workspace.updateComplete;
    const payloadBefore = shadowOf(workspace).querySelector("sm-payload-tab");

    clickMenuButton(workspace, ".mode-toggle-button");
    await workspace.updateComplete;

    const payloadAfter = shadowOf(workspace).querySelector("sm-payload-tab");
    expect(payloadAfter).toBe(payloadBefore); // 元素同一性 = 状态共用。
    workspace.remove();
  });

  it("断点积木双档:切调试模式时并入内容元素 breakpointAddresses() 声明面", async () => {
    // 经 tabTypes 注入带 breakpointAddresses 的替身 payload 页(模拟编译器
    // 演进后断点步骤携带地址;v1 真实 payload 页返回空集)。
    const harness = createClientHarness();
    const workspace = new SmWorkspace();
    workspace.debugModeAvailable = true;
    const stub = new StubDebugSource();
    stub.breakpoints = [];
    workspace.debugDataSourceFactory = () => stub as unknown as DebugDataSource;
    const fakeContent = document.createElement("div") as unknown as HTMLElement & { breakpointAddresses: () => readonly string[] };
    fakeContent.breakpointAddresses = () => ["0x1004", "0x1008"];
    const registry = createDefaultTabTypeRegistry();
    registry.register({ type: PAYLOAD_TAB_TYPE, label: "Payload 搭建", createContent: () => fakeContent });
    workspace.tabTypes = registry;
    document.body.append(workspace);
    await workspace.updateComplete;
    workspace.client = harness.client;
    await workspace.updateComplete;
    await harness.client.createSession(CREATE_INPUT);
    harness.client.connect();
    FakeWebSocket.last.serverAccepts();
    await settle();
    harness.frames.flush();
    await workspace.updateComplete;

    workspace.openTab("payload");
    await workspace.updateComplete;
    clickMenuButton(workspace, ".mode-toggle-button");
    await workspace.updateComplete;

    expect(workspace.mode).toBe("debug");
    expect(stub.breakpoints.slice().sort()).toEqual(["0x1004", "0x1008"]);
    workspace.remove();
  });
});

// ── FE-WS-04c:运行到断点 ──────────────────────────────────────────────────

describe("FE-WS-04c:运行到断点(调试通道原生暂停点)", () => {
  it("解题模式禁用;调试模式 + 断点集合非空可用,点击以当前集合调用", async () => {
    const { workspace, stub } = await mountDebugCapableWorkspace();
    const runButton = () => menuShadow(workspace).querySelector(".run-to-breakpoint-button");

    // 解题模式:禁用。
    expect(runButton()?.hasAttribute("disabled")).toBe(true);

    clickMenuButton(workspace, ".mode-toggle-button");
    await workspace.updateComplete;
    // 调试模式 + 断点 0x1004 + 会话 running + 通道 connected → 可用。
    expect(runButton()?.hasAttribute("disabled")).toBe(false);
    runButton()?.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
    await settle();
    expect(stub.runCalls).toEqual([["0x1004"]]);
    workspace.remove();
  });

  it("断点集合为空:按钮禁用(指令视图断点事件回流刷新)", async () => {
    const { workspace, stub } = await mountDebugCapableWorkspace();
    clickMenuButton(workspace, ".mode-toggle-button");
    await workspace.updateComplete;
    stub.breakpoints = [];
    stub.emit({ kind: "breakpoints", breakpoints: [] });
    await workspace.updateComplete;
    expect(menuShadow(workspace).querySelector(".run-to-breakpoint-button")?.hasAttribute("disabled")).toBe(true);
    workspace.remove();
  });
});

// ── ED 挂接(FE-ED-01/03/04/05/06/07)────────────────────────────────────

describe("ED 挂接:结构视图(highlights 注入 + highlight-jump 联动)", () => {
  it("highlights 来自公开投影 semanticHighlights;highlight-jump → 字节视图定位反馈", async () => {
    const { workspace } = await mountDebugCapableWorkspace();
    workspace.openTab("structure");
    await workspace.updateComplete;
    const structure = shadowOf(workspace).querySelector("sm-structure-view") as unknown as HTMLElement & {
      highlights: readonly unknown[];
    };
    expect(structure.highlights).toHaveLength(1); // 夹具投影 semanticHighlights。
    expect(structure.highlights[0]).toMatchObject({ kind: "buffer_start" });

    structure.dispatchEvent(
      new CustomEvent("highlight-jump", {
        detail: { regionId: "region-stack", addressHex: "0x1004" },
        bubbles: true,
        composed: true,
      }),
    );
    await workspace.updateComplete;
    expect(shadowOf(workspace).querySelector(".jump-feedback")?.textContent).toContain("已跳转到");
    workspace.remove();
  });

  it("highlight-jump 落点缓存外:调试档自动 prefetch 后重试", async () => {
    const { workspace, stub } = await mountDebugCapableWorkspace();
    workspace.openTab("structure");
    clickMenuButton(workspace, ".mode-toggle-button");
    await workspace.updateComplete;
    const structure = shadowOf(workspace).querySelector("sm-structure-view");
    structure?.dispatchEvent(
      new CustomEvent("highlight-jump", {
        detail: { regionId: "region-stack", addressHex: "0x1800" },
        bubbles: true,
        composed: true,
      }),
    );
    await settle();
    await workspace.updateComplete;
    // 调试模式下窗口外落点自动请求窗口(prefetch),滚动不可达仍明示窗口外。
    expect(stub.prefetchRequests).toEqual(["0x1800"]);
    expect(shadowOf(workspace).querySelector(".jump-feedback")?.textContent).toContain("在可见窗口之外");
    workspace.remove();
  });
});

describe("ED 挂接:时间线(动作账本)与内存 diff(前快照 + delta)", () => {
  it("动作响应流入账本:时间线条目增长;diff 页收到 beforeRegions + delta", async () => {
    const { workspace, harness, socket } = await mountDebugCapableWorkspace();
    workspace.openTab("timeline");
    workspace.openTab("memory-diff");
    await workspace.updateComplete;
    const timeline = shadowOf(workspace).querySelector("sm-timeline") as unknown as HTMLElement & {
      entries: readonly unknown[];
    };
    const diff = shadowOf(workspace).querySelector("sm-memory-diff") as unknown as {
      delta: unknown;
    };
    expect(timeline.entries).toHaveLength(0);

    // 菜单「指令步进」→ step 动作 → 服务端执行回执(带 dirtyRange)。
    clickMenuButton(workspace, ".step-button");
    await settle();
    sendActionFromServer(
      socket,
      makeActionResponse({
        revision: 1,
        status: "paused",
        projectionDelta: makeDelta({
          revision: 1,
          dirtyRanges: [{ regionId: "region-stack", startAddressHex: "0x1000", bytesHex: "ff", truncated: true }],
        }),
      }),
    );
    harness.frames.flush();
    await settle();
    await workspace.updateComplete;

    expect(timeline.entries).toHaveLength(1);
    expect(timeline.entries[0]).toMatchObject({ kind: "action", revision: 1 });
    expect(diff.delta).not.toBeNull();
    workspace.remove();
  });
});

describe("ED 挂接:checkpoint(create/checkout 响应回流刷新列表)", () => {
  it("checkpoint 动作响应到达且未拒 → 重拉 list_checkpoints 注入列表", async () => {
    const { workspace, harness, socket } = await mountDebugCapableWorkspace();
    workspace.openTab("checkpoints");
    await workspace.updateComplete;
    const checkpoints = shadowOf(workspace).querySelector("sm-checkpoints") as unknown as HTMLElement & {
      checkpoints: readonly unknown[];
      sendAction: ((action: unknown) => void) | null;
      shadowRoot: ShadowRoot | null;
    };
    expect(checkpoints.sendAction).toBeTypeOf("function");
    const callsBefore = harness.mockFetch.calls.length;

    // 经组件 create 表单派发(校验注入面):label 输入 + 创建按钮。
    const input = checkpoints.shadowRoot?.querySelector<HTMLInputElement>("input[type=text]");
    if (input === undefined || input === null) {
      throw new Error("未找到 checkpoint 标签输入");
    }
    input.value = "dev-label";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    const createButton = checkpoints.shadowRoot?.querySelector<HTMLButtonElement>(".create-row button");
    createButton?.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
    await settle();
    sendActionFromServer(
      socket,
      makeActionResponse({ revision: 2, status: "running", projectionDelta: null }),
    );
    harness.frames.flush();
    await settle();
    await workspace.updateComplete;

    // list_checkpoints 重拉(REST) + 列表注入。
    expect(harness.mockFetch.calls.length).toBeGreaterThan(callsBefore);
    expect(harness.mockFetch.calls.at(-1)?.url).toContain("/sessions/checkpoints");
    expect(checkpoints.checkpoints).toEqual(CHECKPOINTS_PAYLOAD.checkpoints);
    workspace.remove();
  });
});

describe("ED 挂接:提示 ladder(failed 计数)与错误解释(userVisibleError)", () => {
  it("failed 响应累计失败计数;after_n_failures 提示自动揭示", async () => {
    const { workspace, socket } = await mountDebugCapableWorkspace();
    workspace.challengeDescriptor = {
      hintLadder: [
        { order: 1, revealPolicy: "after_n_failures", failureThreshold: 1, hintText: "失败一次后可见的提示" },
      ],
      publicErrorMapping: [{ errorCode: "canary_violation", teachingNote: "canary 教学注解(夹具)" }],
    };
    await workspace.updateComplete;
    const ladder = shadowOf(workspace).querySelector("sm-hint-ladder") as HTMLElement & { failures: number };

    // failed 动作响应(教学失败反馈)→ 宿主自账计数 +1。
    clickMenuButton(workspace, ".step-button");
    await settle();
    sendActionFromServer(socket, makeActionResponse({ revision: 1, status: "failed", projectionDelta: null }));
    await workspace.updateComplete;

    expect(ladder.failures).toBe(1);
    expect(ladder.shadowRoot?.textContent).toContain("失败一次后可见的提示");
    workspace.remove();
  });

  it("rejected 响应:错误解释呈现 code + 描述包 teachingNote(与菜单内联呈现并存)", async () => {
    const { workspace, socket } = await mountDebugCapableWorkspace();
    workspace.challengeDescriptor = {
      publicErrorMapping: [{ errorCode: "canary_violation", teachingNote: "canary 教学注解(夹具)" }],
    };
    await workspace.updateComplete;
    const explainer = shadowOf(workspace).querySelector("sm-error-explainer") as unknown as HTMLElement & {
      error: unknown;
      shadowRoot: ShadowRoot | null;
    };

    clickMenuButton(workspace, ".step-button");
    await settle();
    sendActionFromServer(
      socket,
      makeActionResponse({
        revision: 1,
        status: "rejected",
        userVisibleError: {
          code: "canary_violation",
          message: "canary 被破坏",
          addressHex: "0x1008",
          explanation: { hints: ["检查写入长度"] },
        },
      }),
    );
    await workspace.updateComplete;

    expect((explainer.error as { code: string }).code).toBe("canary_violation");
    expect(explainer.shadowRoot?.textContent).toContain("canary 教学注解(夹具)");
    // F5 菜单内联拒绝呈现并存(增强而非替换)。
    expect(menuShadow(workspace).querySelector(".error")?.textContent).toContain("动作被拒绝");
    workspace.remove();
  });
});

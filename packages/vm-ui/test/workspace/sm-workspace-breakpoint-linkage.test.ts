/**
 * <sm-workspace> 断点联动全链路集成测试(WP-76 #3 / #4)。
 *
 * 链路(缺省组合根装配路径,与 `sm-workspace-debug-projection.test.ts` 同法;
 * **唯一替身 = 全局 `WebSocket` 桩**,缺省装配路径无传输注入点):
 *
 *   payload 断点积木 → **真实编译**(公开投影求值环境取当前指令指针)
 *   → `payload-breakpoints-changed` → 切调试模式 → `#mergePayloadBreakpoints`
 *   → `DebugDataSource.addBreakpoint` → 指令视图行断点面 + 菜单「运行到断点」
 *   可用性翻转 → `debug_run_to_breakpoint` → 服务端 `debug_paused`
 *   (reason = breakpoint)→ 指令视图 rip 锚点 = 命中地址 + 暂停行原因
 *   → 寄存器交叉标注 / 链延伸伪汇编 chip / payload 客户端步进暂停分面。
 *
 * 数据纪律:断点地址的唯一来源 = **公开投影的当前指令指针**(`registers()` 的
 * RIP);组件不推断未下发信息,也不新增数据通道(ADR-DC1 what-if 纪律)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEBUG_CHANNEL_PROTOCOL_VERSION,
  type PublicStateProjection,
} from "@stackmaster/protocol";

import { SessionClient } from "../../src/client/session-client.js";
import { DebugDataSource } from "../../src/datasource/debug-data-source.js";
import type { BlocklySerializedState } from "../../src/payload/compiler/types.js";
import { SmPayloadTab } from "../../src/payload/sm-payload-tab.js";
import { SmInstructionView } from "../../src/views/instruction/sm-instruction-view.js";
import { SmWorkspace } from "../../src/workspace/sm-workspace.js";
import {
  CREATE_INPUT,
  FakeFrames,
  FakeWebSocket,
  SESSION_COOKIE,
  SESSION_ID,
  createMockFetch,
  fakeWebSocketFactory,
  makeProjection,
  settle,
  type MockFetch,
} from "../helpers/fixtures.js";

/** 断点地址(公开投影当前指令指针 = 代码区起点)。 */
const BREAKPOINT_ADDRESS = "0x401000";

/**
 * 公开投影夹具:
 *  - 栈区 @0x1000(rw;首 8 字节小端 = 0x401000 ⇒ 字节行产跳转链到代码区);
 *  - 代码区 @0x401000(rx);
 *  - 寄存器 RSP / **RIP**(断点地址解析唯一来源)。
 */
function linkageProjection(): PublicStateProjection {
  return makeProjection({
    status: "paused",
    revision: 0,
    visibleRegions: [
      {
        regionId: "region-stack",
        label: "stack",
        startAddressHex: "0x1000",
        byteLength: 4096,
        permissions: "rw",
        bytesHex: "0010400000000000",
        truncated: false,
      },
      {
        regionId: "region-code",
        label: "code",
        startAddressHex: "0x401000",
        byteLength: 4096,
        permissions: "rx",
        bytesHex: "55",
        truncated: true,
      },
    ],
    visibleRegisters: [
      { name: "RSP", valueHex: "0x1000" },
      { name: "RIP", valueHex: BREAKPOINT_ADDRESS },
    ],
  });
}

/** 调试通道窗口回执:栈区 64 字节(首 8 字节已含 0x401000 指针)。 */
const STACK_WINDOW_HEX = "0010400000000000555555555555555".repeat(4);
/** 调试通道窗口回执:代码区 64 字节(0x401000 起 = RIP 命中行)。 */
const CODE_WINDOW_HEX = `${"55"}${"00".repeat(63)}`;

/** payload 程序:写字节 → 断点积木(断点 = 客户端暂停点标记)。 */
function breakpointProgram(): BlocklySerializedState {
  return {
    blocks: {
      languageVersion: 0,
      blocks: [
        {
          type: "payload_start",
          id: "start",
          next: {
            block: {
              type: "payload_write_bytes",
              id: "wb",
              fields: { BYTES: "4142" },
              inputs: {
                ADDR: { block: { type: "payload_num", id: "addr", fields: { N: "0x1000" } } },
              },
              next: { block: { type: "payload_breakpoint", id: "bp" } },
            },
          },
        },
      ],
    },
  };
}

/** 服务端 S→C 调试帧封装(客户端按冻结 Schema 重新校验)。 */
function debugFrame(type: string, payload: unknown, seq: number, requestId?: string): unknown {
  return {
    protocolVersion: DEBUG_CHANNEL_PROTOCOL_VERSION,
    type,
    sessionId: SESSION_ID,
    seq,
    ...(requestId === undefined ? {} : { requestId }),
    payload,
  };
}

// ── 全局 WebSocket 桩(调试通道装配路径无注入点)──────────────────────────

const nativeWebSocket = globalThis.WebSocket;

function installFakeGlobalWebSocket(): void {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: FakeWebSocket,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: nativeWebSocket,
  });
});

// ── 夹具 ───────────────────────────────────────────────────────────────────

interface LinkageFixture {
  readonly workspace: SmWorkspace;
  readonly client: SessionClient;
  readonly frames: FakeFrames;
  /** 调试通道套接字(进入调试模式后由 `enterDebugMode` 换绑)。 */
  debugSocket: FakeWebSocket;
  readonly mockFetch: MockFetch;
  seq: number;
}

function createClientHarness(): { client: SessionClient; frames: FakeFrames; mockFetch: MockFetch } {
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
            payload: { sessionId: SESSION_ID, revision: 0, projection: linkageProjection() },
          },
          setCookie: `${SESSION_COOKIE}; Path=/sessions; HttpOnly; SameSite=Strict`,
        };
      case "/sessions/projection-sync":
        return {
          status: 200,
          body: {
            command: "sync_projection",
            payload: { revision: 0, projection: linkageProjection() },
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

async function settleFrames(frames: number): Promise<void> {
  for (let frame = 0; frame < frames; frame += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    await Promise.resolve();
  }
}

function shadowOf(workspace: SmWorkspace): ShadowRoot {
  return workspace.shadowRoot as ShadowRoot;
}

function menuButton(workspace: SmWorkspace, selector: string): HTMLButtonElement | null {
  const menu = shadowOf(workspace).querySelector("sm-workspace-menu");
  return (menu?.shadowRoot as ShadowRoot | null)?.querySelector<HTMLButtonElement>(selector) ?? null;
}

function clickModeToggle(workspace: SmWorkspace): void {
  const button = menuButton(workspace, ".mode-toggle-button");
  if (button === null) {
    throw new Error("未找到模式切换按钮(调试模式不可用?)");
  }
  button.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
}

/** 装配「已建会话 + 已连接 + 窗口集常驻」的**解题档**工作区。 */
async function mountSolveModeWorkspace(): Promise<LinkageFixture> {
  const { client, frames, mockFetch } = createClientHarness();
  const workspace = new SmWorkspace();
  workspace.debugModeAvailable = true;
  document.body.append(workspace);
  await workspace.updateComplete;

  workspace.client = client;
  await workspace.updateComplete;
  await client.createSession(CREATE_INPUT);
  client.connect();
  FakeWebSocket.last.serverAccepts();
  await settle();
  frames.flush();
  await workspace.updateComplete;
  await settleFrames(3);

  return {
    workspace,
    client,
    frames,
    debugSocket: FakeWebSocket.last, // 占位:进入调试模式后替换为调试通道套接字。
    mockFetch,
    seq: 1,
  };
}

/** 进入调试模式并完成 attach(缺省装配路径 → 真实 createDebugDataSource)。 */
async function enterDebugMode(fixture: LinkageFixture): Promise<FakeWebSocket> {
  const { workspace } = fixture;
  installFakeGlobalWebSocket();
  FakeWebSocket.reset();
  clickModeToggle(workspace);
  await workspace.updateComplete;

  const debugSocket = FakeWebSocket.last;
  debugSocket.serverAccepts();
  fixture.seq += 1;
  debugSocket.serverSends(
    debugFrame(
      "debug_attached",
      { revision: 0, status: "paused", paused: { addressHex: BREAKPOINT_ADDRESS } },
      fixture.seq,
    ),
  );
  await workspace.updateComplete;
  await settle();
  fixture.debugSocket = debugSocket;
  return debugSocket;
}

function debugSourceOf(fixture: LinkageFixture): DebugDataSource {
  const source = fixture.workspace.debugDataSource;
  if (source === null) {
    throw new Error("调试模式未装配调试档数据源(装配路径断裂)");
  }
  return source;
}

/** 指令流推送(真实服务端在暂停后 `#pushInstructionStream`,此处仅桩替套接字)。 */
function pushInstructionStream(fixture: LinkageFixture): void {
  fixture.seq += 1;
  fixture.debugSocket.serverSends(
    debugFrame(
      "debug_instruction_stream",
      {
        instructions: [
          { addressHex: "0x401000", bytesHex: "55", text: "push rbp" },
          { addressHex: "0x401004", bytesHex: "4889e5", text: "mov rbp, rsp" },
          { addressHex: "0x401010", bytesHex: "c3", text: "ret" },
        ],
      },
      fixture.seq,
    ),
  );
}

/**
 * 结构视图高亮跳转 → 工作区真实跳转管线(F8 接线):未缓存落点触发
 * `debug_window` prefetch,回执入缓存后 `#refreshContents()`(注解缓存重建)。
 * 这是字节视图 / 指令视图标注缓存的**唯一生产刷新入口**。
 */
async function highlightJump(
  fixture: LinkageFixture,
  regionId: string,
  addressHex: string,
): Promise<void> {
  const { workspace, debugSocket } = fixture;
  const structure = shadowOf(workspace).querySelector("sm-structure-view");
  expect(structure).not.toBeNull();
  structure?.dispatchEvent(
    new CustomEvent("highlight-jump", { detail: { regionId, addressHex }, bubbles: true, composed: true }),
  );
  await settle();

  const request = debugSocket.sent.at(-1) as Record<string, unknown> | undefined;
  if (request?.type === "debug_window") {
    const bytesHex = addressHex === "0x1000" ? STACK_WINDOW_HEX : CODE_WINDOW_HEX;
    fixture.seq += 1;
    debugSocket.serverSends(
      debugFrame(
        "debug_window_data",
        { addressHex, bytesHex },
        fixture.seq,
        request.requestId as string,
      ),
    );
    await settle();
  }
  await settleFrames(3);
  await workspace.updateComplete;
}

function instructionViewOf(fixture: LinkageFixture): SmInstructionView {
  const view = shadowOf(fixture.workspace).querySelector("sm-instruction-view");
  if (view === null) {
    throw new Error("指令视图窗口缺席(固定窗口集不变量破裂)");
  }
  return view as SmInstructionView;
}

function payloadTabOf(fixture: LinkageFixture): SmPayloadTab {
  const tab = shadowOf(fixture.workspace).querySelector("sm-payload-tab");
  if (tab === null) {
    throw new Error("payload 标签页窗口缺席(固定窗口集不变量破裂)");
  }
  return tab as SmPayloadTab;
}

beforeEach(() => {
  FakeWebSocket.reset();
});

// ── 断点地址进入调试档断点集合(WP-76 #1/#2)────────────────────────────────

describe("WP-76 断点联动:payload 断点积木 → 调试档断点集合", () => {
  it("解题档编译即解析出真实地址;切调试模式后并入断点集合且启用「运行到断点」", async () => {
    const fixture = await mountSolveModeWorkspace();
    const { workspace } = fixture;
    // 1) 解题档编译:地址来源 = 公开投影当前指令指针(RIP),非协议面字段。
    const tab = payloadTabOf(fixture);
    tab.loadWorkspaceState(breakpointProgram());
    await tab.updateComplete;
    const result = tab.compileNow();
    expect(result?.ok).toBe(true);
    expect(tab.breakpointAddresses()).toEqual([BREAKPOINT_ADDRESS]);
    expect(workspace.debugDataSource).toBeNull(); // 解题档:零调试通道。

    // 2) 切调试模式 → 缺省装配路径 → 并入真实断点(非空断言)。
    const debugSocket = await enterDebugMode(fixture);
    expect(workspace.mode).toBe("debug");
    expect(debugSocket.url).toContain("/sessions/debug-channel");
    const debugSource = debugSourceOf(fixture);
    expect(debugSource.breakpoints).toEqual([BREAKPOINT_ADDRESS]);
    expect(debugSource.breakpointCount).toBeGreaterThan(0);

    // 3) 菜单「运行到断点」可用性翻转(true)。
    pushInstructionStream(fixture);
    await settle();
    await settleFrames(3);
    await workspace.updateComplete;
    const runToBreakpoint = menuButton(workspace, ".run-to-breakpoint-button");
    expect(runToBreakpoint).not.toBeNull();
    expect(runToBreakpoint?.disabled).toBe(false);

    // 4) 指令视图行断点面同步(断点集合 = 同一 DebugDataSource)。
    const view = instructionViewOf(fixture);
    await view.updateComplete;
    await settleFrames(3);
    const row = view.shadowRoot?.querySelector(
      `.instruction-row[data-instruction-address="${BREAKPOINT_ADDRESS}"]`,
    );
    expect(row).not.toBeNull();
    expect(row?.querySelector(".breakpoint-toggle")?.getAttribute("aria-pressed")).toBe("true");

    workspace.remove();
    fixture.client.dispose();
  });
});

// ── 运行到断点命中 → 指令视图 rip 锚点(WP-76 #3)────────────────────────────

describe("WP-76 断点联动:运行到断点命中 → 暂停原因与 rip 锚点", () => {
  it("debug_run_to_breakpoint 携带真实断点集合;命中后暂停原因 = breakpoint 且锚点 = 命中地址", async () => {
    const fixture = await mountSolveModeWorkspace();
    const { workspace } = fixture;
    const tab = payloadTabOf(fixture);
    tab.loadWorkspaceState(breakpointProgram());
    await tab.updateComplete;
    tab.compileNow();

    const debugSocket = await enterDebugMode(fixture);
    pushInstructionStream(fixture);
    await settle();
    await settleFrames(3);
    await workspace.updateComplete;
    const view = instructionViewOf(fixture);
    await view.updateComplete;
    await settleFrames(3);

    // 1) 菜单动作 → 调试通道帧携带**并入后的真实断点集合**。
    menuButton(workspace, ".run-to-breakpoint-button")?.dispatchEvent(
      new Event("click", { bubbles: true, composed: true }),
    );
    await settle();
    const runRequest = debugSocket.sent.at(-1) as Record<string, unknown>;
    expect(runRequest.type).toBe("debug_run_to_breakpoint");
    expect(runRequest.payload).toEqual({ breakpoints: [BREAKPOINT_ADDRESS] });

    // 2) 服务端命中回执:debug_paused(reason = breakpoint)。
    fixture.seq += 1;
    debugSocket.serverSends(
      debugFrame(
        "debug_paused",
        { reason: "breakpoint", addressHex: BREAKPOINT_ADDRESS },
        fixture.seq,
      ),
    );
    await settle();
    await settleFrames(3);
    await workspace.updateComplete;
    await view.updateComplete;

    const debugSource = debugSourceOf(fixture);
    expect(debugSource.paused?.reason).toBe("breakpoint");
    expect(debugSource.pausedAddressHex).toBe(BREAKPOINT_ADDRESS);

    // 3) 指令视图:rip 锚点 = 命中地址 + 命中行为暂停行 + 断点原因文案。
    expect(view.anchorAddressHex).toBe(BREAKPOINT_ADDRESS);
    const pausedRow = view.shadowRoot?.querySelector(".instruction-row.paused-row");
    expect(pausedRow?.getAttribute("data-instruction-address")).toBe(BREAKPOINT_ADDRESS);
    expect(
      view.shadowRoot?.querySelector(".paused-line:not(.client-step-pause)")?.textContent,
    ).toContain("断点");

    workspace.remove();
    fixture.client.dispose();
  });
});

// ── WP-75 #6 标注 / WP-76 #4 客户端暂停 / 链延伸 chip:工作区注入面 ──────────

describe("WP-76 工作区注入面:指令视图标注 / 客户端暂停 / 链延伸伪汇编", () => {
  it("同一份寄存器命中集与客户端暂停落点注入指令视图;链延伸落点产出伪汇编 chip", async () => {
    const fixture = await mountSolveModeWorkspace();
    const { workspace } = fixture;
    const tab = payloadTabOf(fixture);
    tab.loadWorkspaceState(breakpointProgram());
    await tab.updateComplete;
    tab.compileNow();

    await enterDebugMode(fixture);
    pushInstructionStream(fixture);
    await settle();

    // ① 链延伸伪汇编:栈区窗口入缓存(高亮跳转 = 生产 prefetch + 刷新入口)
    //    ⇒ 链 0x1000 → 0x401000(代码区)⇒ 追加一条伪汇编 chip
    //    (调试档 = 调试通道已下发的指令流,零新增数据通道)。
    await highlightJump(fixture, "region-stack", "0x1000");
    const byteTab = shadowOf(workspace).querySelector("sm-byte-tab");
    const byteView = (byteTab as unknown as { byteView: { shadowRoot: ShadowRoot } | null })
      .byteView;
    const chainRow = byteView?.shadowRoot.querySelector('.byte-row[data-row-address="0x1000"]');
    const chain = chainRow?.querySelector("sm-jump-chain") as
      | (HTMLElement & { shadowRoot: ShadowRoot; updateComplete?: Promise<unknown> })
      | null;
    expect(chain).not.toBeNull();
    await chain?.updateComplete;
    const chip = chain?.shadowRoot?.querySelector("[data-pseudo-asm]");
    expect(chip?.getAttribute("data-pseudo-asm-address")).toBe(BREAKPOINT_ADDRESS);
    expect(chip?.getAttribute("data-pseudo-asm-source")).toBe("debug");
    expect(chip?.textContent).toContain("push rbp");

    // ② WP-75 #6:代码区窗口入缓存 ⇒ RIP 命中已下发窗口 → 指令行左缘标注
    //    (命中集 = 工作区注解缓存的**同一份**,指令视图不做第二次计算)。
    await highlightJump(fixture, "region-code", BREAKPOINT_ADDRESS);
    const view = instructionViewOf(fixture);
    await view.updateComplete;
    await settleFrames(3);
    // 注入的是**整份**注解缓存(RSP 命中栈区窗口 + RIP 命中代码区窗口);
    // 指令视图按行地址精确匹配 → 只有 RIP 命中行呈现标注。
    expect(view.registerHits.map((hit) => hit.registerName)).toEqual(["RSP", "RIP"]);
    const row = view.shadowRoot?.querySelector(
      `.instruction-row[data-instruction-address="${BREAKPOINT_ADDRESS}"]`,
    );
    const annotation = row?.querySelector(".row-address > sm-register-annotation");
    expect(annotation).not.toBeNull();
    expect(
      annotation?.shadowRoot?.querySelector("button.reg-annotation")?.getAttribute("data-registers"),
    ).toBe("RIP");

    // ③ WP-76 #4:payload 客户端步进暂停 → 指令视图独立一行(不冒充服务端暂停
    //    原因)。事件发出面(执行器真实暂停)由 payload 标签页测试覆盖,此处
    //    只验证工作区注入 + 分面呈现。
    tab.dispatchEvent(
      new CustomEvent("payload-client-pause", {
        detail: { reason: "breakpoint", stepIndex: 1, addressHex: "0x401004" },
        bubbles: true,
        composed: true,
      }),
    );
    await settleFrames(2);
    await workspace.updateComplete;
    await view.updateComplete;
    expect(view.clientPauseAddressHex).toBe("0x401004");
    const clientLine = view.shadowRoot?.querySelector(".client-step-pause");
    expect(clientLine?.textContent).toContain("客户端步进暂停");
    expect(clientLine?.textContent).toContain("0x00401004");

    workspace.remove();
    fixture.client.dispose();
  });
});

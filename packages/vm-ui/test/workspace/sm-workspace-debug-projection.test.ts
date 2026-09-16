/**
 * <sm-workspace> 调试档装配路径集成测试(WP-70:调试档数据源投影接线修复)。
 *
 * **缺陷漏网原因(登记)**:既有调试模式测试(`test/workspace/sm-workspace-mode.test.ts`)
 * 一律经 `debugDataSourceFactory` **测试接缝**注入替身工厂,恰好绕开缺省组合根
 * 装配路径——工厂 `createDebugDataSource` 从不把 `projectionProvider` 透传给
 * `DebugDataSource` 的断裂因此在测试面不可见(调试档 `regions()` / `registers()` /
 * 行区域归属恒空)。本文件**不注入该接缝**,走「工作区 → 调试模式 → 真实
 * `createDebugDataSource` → 调试通道 attach → prefetchWindow」全链路:
 * 唯一替身 = 全局 `WebSocket` 桩(假套接字基建;缺省装配路径无传输注入点)。
 *
 * 断言面(与 WP-70 缺陷三处对应):`regions()` 非空、`registers()` 非空、
 * `bytesRows()` 行区域归属非空、字节行左缘寄存器交叉标注命中非空。
 * 投影结构同构映射是调试档 VMA / 寄存器 / 区域归属的**唯一来源**(公开投影面,
 * 零私有信息推导;ADR-DC1 what-if 纪律)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEBUG_CHANNEL_PROTOCOL_VERSION,
  type PublicStateProjection,
} from "@stackmaster/protocol";

import { SessionClient } from "../../src/client/session-client.js";
import { DebugDataSource } from "../../src/datasource/debug-data-source.js";
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

// ── 夹具:公开投影(区域列表 + 寄存器面 = 调试档结构同构映射源)──────────────

/** 工作区投影:栈区域 @0x1000(RSP / RBP 命中其窗口)+ 代码区域 @0x400000。 */
function debugWorkspaceProjection(): PublicStateProjection {
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
        bytesHex: "0102030405060708",
        truncated: false,
      },
      {
        regionId: "region-code",
        label: "code",
        startAddressHex: "0x400000",
        byteLength: 4096,
        permissions: "rx",
        bytesHex: "00",
        truncated: true,
      },
    ],
    visibleRegisters: [
      { name: "RSP", valueHex: "0x1004" },
      { name: "RBP", valueHex: "0x100C" },
    ],
  });
}

/** 调试通道窗口回执字节(64 字节:0x1000..0x1040,覆盖 RSP / RBP 命中行)。 */
const WINDOW_BYTES_HEX = "0102030405060708".repeat(8);

/** 服务端 S→C 调试帧封装(客户端按冻结 Schema 重新校验,漂移即兜底错误)。 */
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

// ── 全局 WebSocket 桩(缺省装配路径无传输注入点:唯一替身)──────────────────

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

// ── 装配:会话链路(真实 SessionClient + mock 传输)──────────────────────────

interface DebugFixture {
  readonly workspace: SmWorkspace;
  readonly client: SessionClient;
  readonly frames: FakeFrames;
  readonly debugSocket: FakeWebSocket;
  readonly mockFetch: MockFetch;
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
            payload: { sessionId: SESSION_ID, revision: 0, projection: debugWorkspaceProjection() },
          },
          setCookie: `${SESSION_COOKIE}; Path=/sessions; HttpOnly; SameSite=Strict`,
        };
      case "/sessions/projection-sync":
        return {
          status: 200,
          body: {
            command: "sync_projection",
            payload: { revision: 0, projection: debugWorkspaceProjection() },
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

function clickModeToggle(workspace: SmWorkspace): void {
  const menu = shadowOf(workspace).querySelector("sm-workspace-menu");
  const button = (menu?.shadowRoot as ShadowRoot | null)?.querySelector(".mode-toggle-button");
  if (button === null || button === undefined) {
    throw new Error("未找到模式切换按钮(调试模式不可用?)");
  }
  button.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
}

/**
 * 装配「已建会话 + 已连接 + 窗口集常驻 + 进入调试模式」——**缺省组合根装配路径**
 * (不设 `debugDataSourceFactory`):工作区 → 真实 `createDebugDataSource` →
 * 调试通道连接 + `debug_attached` 回执。
 */
async function mountDebugModeWorkspace(): Promise<DebugFixture> {
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

  await workspace.updateComplete;
  await settleFrames(3);

  // 进入调试模式:仅此处的套接字面被桩替身(装配与投影来源全部为真实实现)。
  installFakeGlobalWebSocket();
  FakeWebSocket.reset();
  clickModeToggle(workspace);
  await workspace.updateComplete;

  const debugSocket = FakeWebSocket.last;
  debugSocket.serverAccepts();
  debugSocket.serverSends(
    debugFrame("debug_attached", { revision: 0, status: "paused", paused: { addressHex: "0x1000" } }, 1),
  );
  await workspace.updateComplete;
  await settle();

  const debugSource = workspace.debugDataSource;
  if (debugSource === null) {
    throw new Error("调试模式未装配调试档数据源(装配路径断裂)");
  }
  return { workspace, client, frames, debugSocket, mockFetch };
}

function debugSourceOf(fixture: DebugFixture): DebugDataSource {
  return fixture.workspace.debugDataSource as DebugDataSource;
}

beforeEach(() => {
  FakeWebSocket.reset();
});

// ── 装配链路控制面:attach 真实到达(证明红灯归因于投影接线而非链路断裂)────

describe("WP-70 装配路径控制面:调试通道 attach", () => {
  it("缺省装配的 attach 帧携带会话 id / 协议版本 / revision 起点", async () => {
    const fixture = await mountDebugModeWorkspace();
    const { workspace, debugSocket } = fixture;
    expect(workspace.mode).toBe("debug");
    expect(debugSourceOf(fixture)).toBeInstanceOf(DebugDataSource);
    expect(debugSocket.url).toContain("/sessions/debug-channel");

    const attach = debugSocket.sent[0] as Record<string, unknown>;
    expect(attach.type).toBe("debug_attach");
    expect(attach.protocolVersion).toBe(DEBUG_CHANNEL_PROTOCOL_VERSION);
    expect(attach.sessionId).toBe(SESSION_ID);
    expect(attach.payload).toEqual({ origin: { kind: "revision", revision: 0 } });
    workspace.remove();
    fixture.client.dispose();
  });
});

// ── 缺陷三处症状:regions / registers / 行区域归属 ─────────────────────────

describe("WP-70 装配路径:调试档 regions() 来自公开投影", () => {
  it("regions() 非空且为公开投影 visibleRegions 的结构同构映射", async () => {
    const fixture = await mountDebugModeWorkspace();
    const regions = debugSourceOf(fixture).regions();
    expect(regions.map((entry) => entry.regionId)).toEqual(["region-stack", "region-code"]);
    expect(regions[0]).toMatchObject({
      label: "stack",
      startAddressHex: "0x1000",
      byteLength: 4096,
      permissions: "rw",
    });
    // 零缓存(未 prefetch):windowByteLength = 0 → 截断标记为 true。
    expect(regions[0]?.windowByteLength).toBe(0);
    expect(regions[0]?.truncated).toBe(true);
    fixture.workspace.remove();
    fixture.client.dispose();
  });
});

describe("WP-70 装配路径:调试档 registers() 来自公开投影", () => {
  it("registers() 非空且为公开投影 visibleRegisters 的结构同构映射", async () => {
    const fixture = await mountDebugModeWorkspace();
    expect(debugSourceOf(fixture).registers()).toEqual([
      { name: "RSP", valueHex: "0x1004" },
      { name: "RBP", valueHex: "0x100C" },
    ]);
    fixture.workspace.remove();
    fixture.client.dispose();
  });
});

/**
 * 经结构视图高亮跳转触发调试档自动 prefetchWindow(F8 真实接线:落点缓存外
 * → prefetch → 刷新各内容)→ 回执入缓存 + 标注缓存重建完成。
 */
async function prefetchFirstWindow(fixture: DebugFixture): Promise<void> {
  const { workspace, debugSocket } = fixture;
  // 结构视图窗口挂载即常驻(WP-71 固定窗口集),无需开窗。
  await workspace.updateComplete;
  const structure = shadowOf(workspace).querySelector("sm-structure-view");
  expect(structure).not.toBeNull();
  structure?.dispatchEvent(
    new CustomEvent("highlight-jump", {
      detail: { regionId: "region-stack", addressHex: "0x1000" },
      bubbles: true,
      composed: true,
    }),
  );
  await settle();

  const windowRequest = debugSocket.sent.at(-1) as Record<string, unknown>;
  expect(windowRequest.type).toBe("debug_window");
  expect(windowRequest.payload).toMatchObject({ addressHex: "0x1000" });
  debugSocket.serverSends(
    debugFrame(
      "debug_window_data",
      { addressHex: "0x1000", bytesHex: WINDOW_BYTES_HEX },
      2,
      windowRequest.requestId as string,
    ),
  );
  await settle();
  await settleFrames(3);
  await workspace.updateComplete;
}

describe("WP-70 装配路径:prefetch 后行区域归属", () => {
  it("bytesRows 的行区域归属非空(regionId / offset 来自公开投影)", async () => {
    const fixture = await mountDebugModeWorkspace();
    await prefetchFirstWindow(fixture);

    // 行区域归属(debug-data-source.ts:391 的 regions 来源)非空。
    const cells = debugSourceOf(fixture)
      .bytesRows({ startAddressHex: "0x1000", endAddressHex: "0x1010" })
      .flatMap((row) => row.cells);
    expect(cells).toHaveLength(16);
    expect(cells.every((cell) => cell.regionId === "region-stack")).toBe(true);
    expect(cells[0]?.offset).toBe(0);
    expect(cells[0]?.byteHex).toBe("01");
    // 覆盖面随缓存窗口前进(region 起点 → 最远缓存末尾)。
    expect(debugSourceOf(fixture).regions()[0]?.windowByteLength).toBe(64);
    fixture.workspace.remove();
    fixture.client.dispose();
  });
});

describe("WP-70 装配路径:字节行左缘寄存器交叉标注", () => {
  it("prefetch 后字节行左缘出现寄存器交叉标注(命中非空)", async () => {
    const fixture = await mountDebugModeWorkspace();
    const { workspace } = fixture;
    await prefetchFirstWindow(fixture);

    const byteTab = shadowOf(workspace).querySelector("sm-byte-tab");
    const view = (byteTab as unknown as { byteView: { shadowRoot: ShadowRoot } | null }).byteView;
    expect(view).not.toBeNull();
    const row = view?.shadowRoot.querySelector('.byte-row[data-row-address="0x1000"]');
    expect(row).not.toBeNull();
    const annotation = row?.querySelector("sm-register-annotation");
    expect(annotation).not.toBeNull();
    expect(
      annotation?.shadowRoot?.querySelector("button.reg-annotation")?.getAttribute("data-registers"),
    ).toBe("RSP");

    const row2 = view?.shadowRoot.querySelector('.byte-row[data-row-address="0x1008"]');
    expect(
      row2?.querySelector("sm-register-annotation")?.shadowRoot
        ?.querySelector("button.reg-annotation")
        ?.getAttribute("data-registers"),
    ).toBe("RBP");
    workspace.remove();
    fixture.client.dispose();
  });
});

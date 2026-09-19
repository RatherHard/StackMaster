/**
 * <pwn-memory-vm> jsdom 组件测试(mock window.parent postMessage + 时钟注入):
 * esid 读取 / 缺失降级、hello 发起与重试、ready 消费与 origin 钉住、超时降级
 * 与重试入口、能力降级矩阵、主题 / 语言接线位、高度管道门控、V-12 零反馈。
 */
import { beforeEach, describe, expect, it } from "vitest";

// 经包公开入口导入(覆盖 index.ts 装配面;导入即注册自定义元素)。
import { PwnMemoryVm } from "../src/index.js";
import {
  controlMessage,
  FakeClock,
  FakeFrames,
  FakeParentWindow,
  FakeScheduler,
  flushMicrotasks,
  HOST_ORIGIN,
  readyMessage,
  settleAsyncWork,
  TEST_ESID,
} from "./helpers.js";
import type { RecordedRequest } from "./helpers.js";

/** 组装元素假体并挂载(属性在插入前就位;返回常用查询面)。 */
async function mountElement(overrides: {
  hash?: string;
  bootstrapEndpoint?: string;
  fetchHandler?: (request: RecordedRequest) => { status: number; body: unknown };
  createSessionClient?: PwnMemoryVm["createSessionClient"];
  handshakeTimeoutMs?: number;
  helloMaxRetries?: number;
  measureHeight?: () => number;
  /** 挂载前就位的外部 attribute(WP-73:插件文档页预置 data-sm-theme 形态)。 */
  hostAttributes?: Readonly<Record<string, string>>;
} = {}) {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const frames = new FakeFrames();
  const parent = new FakeParentWindow();
  const requests: RecordedRequest[] = [];

  const element = document.createElement("pwn-memory-vm") as PwnMemoryVm;
  element.locationHash = overrides.hash ?? `#esid=${TEST_ESID}`;
  element.parentWindow = parent;
  element.clock = () => clock.now();
  element.scheduler = scheduler;
  element.frameScheduler = frames;
  for (const [name, value] of Object.entries(overrides.hostAttributes ?? {})) {
    element.setAttribute(name, value);
  }
  if (overrides.bootstrapEndpoint !== undefined) {
    element.bootstrapEndpoint = overrides.bootstrapEndpoint;
  }
  if (overrides.handshakeTimeoutMs !== undefined) {
    element.handshakeTimeoutMs = overrides.handshakeTimeoutMs;
  }
  if (overrides.helloMaxRetries !== undefined) {
    element.helloMaxRetries = overrides.helloMaxRetries;
  }
  if (overrides.measureHeight !== undefined) {
    element.measureHeight = overrides.measureHeight;
  }
  if (overrides.createSessionClient !== undefined) {
    element.createSessionClient = overrides.createSessionClient;
  }
  if (overrides.fetchHandler !== undefined) {
    element.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request: RecordedRequest = {
        url: String(input),
        method: init?.method ?? "GET",
        body: JSON.parse(String(init?.body ?? "null")) as unknown,
      };
      requests.push(request);
      const response = overrides.fetchHandler?.(request) ?? { status: 404, body: {} };
      return new Response(JSON.stringify(response.body), { status: response.status });
    }) as typeof fetch;
  }
  document.body.append(element);
  await element.updateComplete;
  return {
    element,
    parent,
    clock,
    scheduler,
    frames,
    requests,
    shadow: () => {
      const root = element.shadowRoot;
      if (root === null) throw new Error("shadow root 缺失");
      return root;
    },
    statusText: () => element.shadowRoot?.querySelector("[data-testid=pwn-status]")?.textContent ?? null,
    retryButton: () =>
      element.shadowRoot?.querySelector<HTMLButtonElement>("[data-testid=pwn-retry-button]") ?? null,
    async settle(): Promise<void> {
      // 排空到异步静止(宏任务边界;固定微任务跳数随运行时版本漂移,见
      // helpers.ts `settleAsyncWork` 注释)。
      await settleAsyncWork(element);
    },
  };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("<pwn-memory-vm>:esid 读取与降级显示", () => {
  it("注册自定义元素(占位桩退场)", () => {
    expect(customElements.get("pwn-memory-vm")).toBe(PwnMemoryVm);
  });

  it("fragment 缺失 esid → 直接降级(静态文案,零请求、零握手)", async () => {
    const h = await mountElement({ hash: "#section-anchor", bootstrapEndpoint: "https://h.example/b" });
    expect(h.element.phase).toBe("degraded");
    expect(h.element.degradedReason).toBe("esid-missing");
    expect(h.statusText()).toContain("嵌入会话缺失");
    expect(h.retryButton()).toBeNull(); // 无重试入口。
    expect(h.parent.callCount).toBe(0);
    expect(h.requests).toEqual([]);
  });

  it("esid 形态不符(熵下限)与缺失同路径降级", async () => {
    const h = await mountElement({ hash: "#esid=short-value", bootstrapEndpoint: "https://h.example/b" });
    expect(h.element.degradedReason).toBe("esid-missing");
  });

  it("esid 就绪 → hello 立即发出(seq=1,targetOrigin=*),引导取回并行", async () => {
    const h = await mountElement({
      bootstrapEndpoint: "https://h.example/host-api/embed-bootstrap",
      fetchHandler: () => ({ status: 200, body: { error: "not used here" } }),
    });
    expect(h.parent.callCount).toBe(1);
    expect(h.parent.at(0).targetOrigin).toBe("*");
    expect(h.parent.at(0).message).toMatchObject({ type: "hello", seq: 1, sessionId: TEST_ESID });
    await h.settle();
    // 引导取回失败 → 降级(静态文案);hello 已发出的事实不受影响。
    expect(h.element.degradedReason).toBe("bootstrap-failed");
    expect(h.requests.length).toBe(1);
    expect(h.requests[0]?.method).toBe("POST");
    expect(h.requests[0]?.body).toEqual({ embedSessionId: TEST_ESID });
    expect(h.requests[0]?.url).not.toContain(TEST_ESID);
  });

  it("未配置引导端点 → bootstrap-failed 降级(握手照常发起)", async () => {
    const h = await mountElement({});
    expect(h.parent.callCount).toBe(1);
    await h.settle();
    expect(h.element.degradedReason).toBe("bootstrap-failed");
  });
});

describe("<pwn-memory-vm>:超时降级与重试入口(§4.3 / §4.5)", () => {
  it("T_handshake 窗口耗尽 → 降级显示;重试入口触发同会话重发(seq 递增)", async () => {
    const h = await mountElement({ handshakeTimeoutMs: 3000, helloMaxRetries: 0 });
    h.clock.advance(3000);
    h.scheduler.runDue();
    await h.element.updateComplete;
    expect(h.element.degradedReason).toBe("handshake-timeout");
    expect(h.statusText()).toContain("连接宿主超时");
    const retry = h.retryButton();
    expect(retry).not.toBeNull();
    retry?.click();
    await h.element.updateComplete;
    // 重试 = 同会话 hello 重发(seq 2);降级 UI 撤除。
    expect(h.parent.callCount).toBe(2);
    const seqs = h.parent.calls.map((c) => (c.message as { seq: number }).seq);
    expect(seqs).toEqual([1, 2]);
    expect(h.element.degradedReason).toBeNull();
    expect(h.retryButton()).toBeNull();
  });

  it("降级后迟到的 ready 完成握手:降级 UI 撤除、进入就绪态", async () => {
    const h = await mountElement({ handshakeTimeoutMs: 3000, helloMaxRetries: 0 });
    h.clock.advance(3000);
    h.scheduler.runDue();
    await h.element.updateComplete;
    expect(h.element.degradedReason).toBe("handshake-timeout");
    // 宿主模拟:向元素窗口派发合法 ready(与握手会话同一监听窗口 =
    // jsdom 全局 window;source = parentWindow 假体)。
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: HOST_ORIGIN,
        source: h.element.parentWindow as unknown as MessageEventSource,
        data: readyMessage(TEST_ESID),
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: HOST_ORIGIN,
        source: h.element.parentWindow as unknown as MessageEventSource,
        data: readyMessage(TEST_ESID),
      }),
    );
    await h.settle();
    expect(h.element.degradedReason).toBeNull();
    expect(h.element.appearanceSnapshot.theme).toBe("light");
  });
});

describe("<pwn-memory-vm>:主题 / 语言接线位(WP-53 接口锚;2026-09-18 单主题 D-UI-6)", () => {
  it("ready.config 的 theme 进状态面、但不驱动视觉:锚恒 terminal、color-scheme 恒 dark", async () => {
    const h = await mountElement({ handshakeTimeoutMs: 30000 });
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: HOST_ORIGIN,
        source: h.element.parentWindow as unknown as MessageEventSource,
        data: readyMessage(TEST_ESID, { theme: "dark", language: "en-US" }),
      }),
    );
    await h.element.updateComplete;
    // 协议三值仍被状态面保持(宿主下发了什么 = 事实)。
    expect(h.element.appearanceSnapshot).toEqual({
      theme: "dark",
      resolvedTheme: "dark",
      language: "en-US",
    });
    // 视觉落地面单值化:锚恒 terminal、color-scheme 恒 dark(终端属暗族)。
    expect(h.element.getAttribute("data-sm-theme")).toBe("terminal");
    expect(h.element.style.colorScheme).toBe("dark");
    expect(h.element.getAttribute("data-sm-language")).toBe("en-US");
  });

  it("运行中 theme_changed / language_changed 消费接线(theme 三值保持;语言照旧落地)", async () => {
    const h = await mountElement({ handshakeTimeoutMs: 30000 });
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: HOST_ORIGIN,
        source: h.element.parentWindow as unknown as MessageEventSource,
        data: readyMessage(TEST_ESID),
      }),
    );
    await h.element.updateComplete;
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: HOST_ORIGIN,
        source: h.element.parentWindow as unknown as MessageEventSource,
        data: controlMessage("theme_changed", TEST_ESID, 2, "auto"),
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: HOST_ORIGIN,
        source: h.element.parentWindow as unknown as MessageEventSource,
        data: controlMessage("language_changed", TEST_ESID, 3, "en-US"),
      }),
    );
    await h.element.updateComplete;
    expect(h.element.appearanceSnapshot.theme).toBe("auto");
    expect(h.element.getAttribute("data-sm-language")).toBe("en-US");
    // 单主题:theme_changed 不改锚(恒 terminal)。
    expect(h.element.getAttribute("data-sm-theme")).toBe("terminal");
  });

  it("内置默认:未 ready 前 theme=light(协议默认)+ 锚已落 terminal / zh-CN", async () => {
    const h = await mountElement({});
    expect(h.element.appearanceSnapshot).toEqual({
      theme: "light",
      resolvedTheme: "dark",
      language: "zh-CN",
    });
    expect(h.element.getAttribute("data-sm-theme")).toBe("terminal");
    expect(h.element.style.colorScheme).toBe("dark");
  });
});

describe("<pwn-memory-vm>:单主题落锚(2026-09-18 D-UI-6;原 WP-73 外部锚承载面退役)", () => {
  /**
   * 原本段 6 例(WP-73「terminal 锚承载 / 外部锚优先」)随 D-UI-6 单主题收敛
   * **整条废止**:三值判别对象消失后,「插件从不写 terminal 故外部锚必为外部
   * 所写」这一前提不再成立(插件自身即写 terminal),`#observeAnchor` 观察器也
   * 一并删除(理由见 `src/pwn-memory-vm.ts` 的对应注释块)。此处只保留单主题
   * 形态的**当前语义**锚点,原断言面(锚恒在场 / color-scheme 恒 dark)仍在
   * 上一段与 `integration.test.ts` 覆盖。
   */
  it("挂载即落 terminal 锚 + color-scheme dark(无需宿主下发、不依赖外部预置)", async () => {
    const h = await mountElement({ handshakeTimeoutMs: 30000 });
    expect(h.element.getAttribute("data-sm-theme")).toBe("terminal");
    expect(h.element.style.colorScheme).toBe("dark");
  });

  it("外部改写锚值不再被观察器回写(观察器已退役;单主题保证改由 :root 缺省承载)", async () => {
    const h = await mountElement({ handshakeTimeoutMs: 30000 });
    h.element.setAttribute("data-sm-theme", "light");
    await flushMicrotasks();
    // 无观察器 ⇒ 外部写入的锚保持原样,插件不再夺回(原「外部锚优先」路径).
    expect(h.element.getAttribute("data-sm-theme")).toBe("light");
    // 视觉不受影响::root 级缺省 = 终端(样式表层面,机检于 vm-ui
    // test/theming/theme-terminal.test.ts 的「未设锚也是终端」用例)。
    expect(h.element.style.colorScheme).toBe("dark");
  });

  it("宿主 theme_changed 不改锚:terminal 恒在场(协议值只进状态面)", async () => {
    const h = await mountElement({ handshakeTimeoutMs: 30000 });
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: HOST_ORIGIN,
        source: h.element.parentWindow as unknown as MessageEventSource,
        data: readyMessage(TEST_ESID),
      }),
    );
    await h.element.updateComplete;
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: HOST_ORIGIN,
        source: h.element.parentWindow as unknown as MessageEventSource,
        data: controlMessage("theme_changed", TEST_ESID, 2, "light"),
      }),
    );
    await h.element.updateComplete;
    expect(h.element.getAttribute("data-sm-theme")).toBe("terminal");
    expect(h.element.style.colorScheme).toBe("dark");
    expect(h.element.appearanceSnapshot.theme).toBe("light");
  });
});

describe("<pwn-memory-vm>:能力降级矩阵(§4.4)", () => {
  /** 建立已就绪元素(指定授予集)。 */
  async function mountReady(grantedCapabilities: string[]) {
    const h = await mountElement({ handshakeTimeoutMs: 30000, measureHeight: () => 480 });
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: HOST_ORIGIN,
        source: h.element.parentWindow as unknown as MessageEventSource,
        data: readyMessage(TEST_ESID, { grantedCapabilities }),
      }),
    );
    await h.element.updateComplete;
    return h;
  }

  it("未授予 auto_resize → 高度管道不装配:通知变化也不发 height_changed", async () => {
    const h = await mountReady(["theme", "language"]);
    h.element.notifyContentHeightChange();
    h.frames.flush();
    expect(h.parent.calls.some((c) => (c.message as { type: string }).type === "height_changed")).toBe(false);
  });

  it("capabilities 空数组 = 完全静态形态:外观保持默认、控制消息按 V-8 丢弃", async () => {
    const h = await mountReady([]);
    expect(h.element.appearanceSnapshot.theme).toBe("light");
    h.element.notifyContentHeightChange();
    h.frames.flush();
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: HOST_ORIGIN,
        source: h.element.parentWindow as unknown as MessageEventSource,
        data: controlMessage("theme_changed", TEST_ESID, 2, "dark"),
      }),
    );
    await h.element.updateComplete;
    expect(h.element.appearanceSnapshot.theme).toBe("light");
    expect(h.element.violationCounters["v8-capability-violation"]).toBe(1);
    expect(h.parent.calls.filter((c) => (c.message as { type: string }).type === "height_changed")).toEqual([]);
  });

  it("授予 auto_resize → 初始上报 + 内容变化驱动上报(rAF 合流、载荷为实际内容高度)", async () => {
    let height = 320;
    const h = await mountElement({
      handshakeTimeoutMs: 30000,
      measureHeight: () => height,
      createSessionClient: undefined,
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: HOST_ORIGIN,
        source: h.element.parentWindow as unknown as MessageEventSource,
        data: readyMessage(TEST_ESID, { grantedCapabilities: ["auto_resize"] }),
      }),
    );
    h.frames.flush(); // 初始上报所在帧。
    await h.element.updateComplete;
    const heights = h.parent.calls
      .filter((c) => (c.message as { type: string }).type === "height_changed")
      .map((c) => (c.message as { payload: { heightPx: number } }).payload.heightPx);
    expect(heights).toEqual([320]);
    // 内容变化 → 通知 → 同帧合流为一次,尾沿最新值。
    height = 640;
    h.element.notifyContentHeightChange();
    h.element.notifyContentHeightChange();
    h.frames.flush();
    const after = h.parent.calls
      .filter((c) => (c.message as { type: string }).type === "height_changed")
      .map((c) => (c.message as { payload: { heightPx: number } }).payload.heightPx);
    expect(after).toEqual([320, 640]);
    // 上报 targetOrigin 已钉住(V-11)。
    const heightCalls = h.parent.calls.filter(
      (c) => (c.message as { type: string }).type === "height_changed",
    );
    const lastHeightCall = heightCalls[heightCalls.length - 1];
    expect(lastHeightCall?.targetOrigin).toBe(HOST_ORIGIN);
  });
});

describe("<pwn-memory-vm>:iframe 重载 = 从空状态重新握手(§4.5)", () => {
  it("重新挂载新元素实例:seq 从 1 重来、外观回内置默认(不继承高水位 / 主题)", async () => {
    const first = await mountElement({ handshakeTimeoutMs: 30000 });
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: HOST_ORIGIN,
        source: first.element.parentWindow as unknown as MessageEventSource,
        data: readyMessage(TEST_ESID),
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: HOST_ORIGIN,
        source: first.element.parentWindow as unknown as MessageEventSource,
        data: controlMessage("theme_changed", TEST_ESID, 2, "dark"),
      }),
    );
    await first.element.updateComplete;
    expect(first.element.appearanceSnapshot.theme).toBe("dark");
    first.element.remove();

    // 重载 = 新文档 = 新元素实例(宿主换新 esid;此处同 fragment 验证状态零继承)。
    const second = await mountElement({ handshakeTimeoutMs: 30000 });
    expect(second.element.appearanceSnapshot.theme).toBe("light");
    expect(second.parent.at(0).message).toMatchObject({ type: "hello", seq: 1 });
    // 旧会话的宿主高水位不继承:宿主可重新以 seq=1 回 ready。
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: HOST_ORIGIN,
        source: second.element.parentWindow as unknown as MessageEventSource,
        data: readyMessage(TEST_ESID, { seq: 1 }),
      }),
    );
    await second.element.updateComplete;
    expect(second.element.appearanceSnapshot.theme).toBe("light");
    expect(second.element.violationCounters["v7-stale-seq"] ?? 0).toBe(0);
  });
});

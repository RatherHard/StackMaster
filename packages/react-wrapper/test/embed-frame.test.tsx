/**
 * react-wrapper 冒烟与 props/handle 面:render → iframe 挂接 → 握手模拟 →
 * 事件回调断言 → handle 命令面(reload / 控制 / 计数)。真实 DOM iframe
 * (jsdom contentWindow)+ 注入式 message 事件;出站经 postMessage spy 捕获。
 *
 * 句柄捕获用 refBox({ current }) 模式:避免 TS 对 `let x: T | null = null`
 * 的控制流收窄把回调赋值误判为恒 null。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EmbedFrame, type EmbedFrameHandle, type EmbedFrameProps } from "../src/index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLUGIN_ORIGIN = "https://plugin.example";
const PLUGIN_URL = "https://plugin.example/vm/index.html";

const baseProps: EmbedFrameProps = {
  pluginUrl: PLUGIN_URL,
  pluginOrigin: PLUGIN_ORIGIN,
  config: { theme: "light", language: "zh-CN" },
  title: "题目工作区",
};

/** ref 回调的承载盒(closure 赋值 + 属性读取,绕开控制流误收窄)。 */
interface RefBox {
  current: EmbedFrameHandle | null;
}

const refBox = (): RefBox => ({ current: null });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function getIframe(): HTMLIFrameElement {
  const iframe = container.querySelector("iframe");
  if (iframe === null) throw new Error("iframe 未渲染");
  return iframe;
}

/** 捕获 iframe.contentWindow.postMessage 出站(jsdom 真窗口 + spy)。 */
function spyOutbound(iframe: HTMLIFrameElement): Array<{ message: unknown; targetOrigin: string }> {
  const win = iframe.contentWindow;
  if (win === null) throw new Error("contentWindow 不可用");
  const calls: Array<{ message: unknown; targetOrigin: string }> = [];
  vi.spyOn(win, "postMessage").mockImplementation(((message: unknown, targetOrigin: string) => {
    calls.push({ message, targetOrigin });
  }) as typeof win.postMessage);
  return calls;
}

function helloJson(esid: string): string {
  return JSON.stringify({
    protocolVersion: 1,
    type: "hello",
    sessionId: esid,
    seq: 1,
    payload: { supportedVersions: [1], capabilities: ["theme", "language", "auto_resize"] },
  });
}

/** render(props)+ 可选回调挂钩;返回 iframe 与 handle 盒。 */
async function renderFrame(
  props: EmbedFrameProps,
  box: RefBox = refBox(),
): Promise<RefBox> {
  await act(async () => {
    root.render(
      <EmbedFrame
        {...props}
        ref={(handle) => {
          box.current = handle;
        }}
      />,
    );
  });
  return box;
}

/** render → load → hello 三步(事件回调断言的公共前置)。 */
async function renderLoadAndHello(
  props: EmbedFrameProps,
): Promise<{ box: RefBox; iframe: HTMLIFrameElement; esid: string }> {
  const box = await renderFrame(props);
  const iframe = getIframe();
  const esid = iframe.src.split("#esid=")[1] ?? "";
  await act(async () => {
    iframe.dispatchEvent(new Event("load"));
  });
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: PLUGIN_ORIGIN,
        source: iframe.contentWindow,
        data: helloJson(esid),
      }),
    );
  });
  return { box, iframe, esid };
}

describe("<EmbedFrame> 渲染与挂接", () => {
  it("渲染带标题的 iframe,src 经 SDK 构造(fragment 只放 22 字符 esid)", async () => {
    await renderFrame({
      ...baseProps,
      testId: "embed-under-test",
      sandbox: "allow-scripts",
    });
    const iframe = getIframe();
    expect(iframe.getAttribute("title")).toBe("题目工作区");
    expect(iframe.getAttribute("data-testid")).toBe("embed-under-test");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.src.startsWith(`${PLUGIN_URL}#esid=`)).toBe(true);
    const esid = iframe.src.split("#esid=")[1] ?? "";
    expect(esid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(iframe.src).not.toContain("token");
  });
});

describe("握手与事件回调", () => {
  it("load → hello → onHandshakeComplete(事件面回调)", async () => {
    const handshakes: unknown[] = [];
    await renderLoadAndHello({
      ...baseProps,
      onHandshakeComplete: (detail) => handshakes.push(detail),
    });
    expect(handshakes).toHaveLength(1);
    expect(handshakes[0]).toMatchObject({
      negotiatedVersion: 1,
      config: { theme: "light", language: "zh-CN" },
      grantedCapabilities: ["theme", "language", "auto_resize"],
    });
  });

  it("出站 ready 信封与 targetOrigin(spy 先于握手挂接)", async () => {
    const box = refBox();
    await renderFrame(baseProps, box);
    const iframe = getIframe();
    const calls = spyOutbound(iframe);
    await act(async () => {
      iframe.dispatchEvent(new Event("load"));
    });
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: PLUGIN_ORIGIN,
          source: iframe.contentWindow,
          data: helloJson(box.current?.embedSessionId ?? ""),
        }),
      );
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.targetOrigin).toBe(PLUGIN_ORIGIN);
    expect(calls[0]?.message).toMatchObject({
      protocolVersion: 1,
      type: "ready",
      seq: 1,
      payload: {
        grantedCapabilities: ["theme", "language", "auto_resize"],
        config: { theme: "light", language: "zh-CN" },
      },
    });
    expect(box.current?.state).toBe("ready");
  });
});

describe("handle 命令面", () => {
  it("sendThemeChanged / sendLanguageChanged 出站信封正确;计数面可读", async () => {
    const { box, iframe } = await renderLoadAndHello(baseProps);
    const calls = spyOutbound(iframe);
    let themeSent = false;
    let languageSent = false;
    act(() => {
      themeSent = box.current?.sendThemeChanged("dark") ?? false;
      languageSent = box.current?.sendLanguageChanged("en-US") ?? false;
    });
    expect(themeSent).toBe(true);
    expect(languageSent).toBe(true);
    expect(calls.map((call) => (call.message as { type: string }).type)).toEqual([
      "theme_changed",
      "language_changed",
    ]);
    expect(calls.every((call) => call.targetOrigin === PLUGIN_ORIGIN)).toBe(true);
    expect(Object.keys(box.current?.violationCounters ?? {}).length).toBeGreaterThanOrEqual(13);
  });

  it("reload 轮换 esid 并同步更新 iframe src;旧会话消息被 V-5 拒绝", async () => {
    const countersChanged: unknown[] = [];
    const { box, iframe, esid: oldEsid } = await renderLoadAndHello({
      ...baseProps,
      onViolationCountersChanged: (detail) => countersChanged.push(detail),
    });

    let newEsid = "";
    act(() => {
      newEsid = box.current?.reload().sessionId ?? "";
    });
    expect(newEsid).not.toBe(oldEsid);
    expect(iframe.src).toBe(`${PLUGIN_URL}#esid=${newEsid}`);

    // 旧 esid 消息:V-5 丢弃 + 计数(计数回调随发)。
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: PLUGIN_ORIGIN,
          source: iframe.contentWindow,
          data: JSON.stringify({
            protocolVersion: 1,
            type: "hello",
            sessionId: oldEsid,
            seq: 1,
            payload: { supportedVersions: [1], capabilities: [] },
          }),
        }),
      );
    });
    expect(box.current?.violationCounters["v5-session-mismatch"]).toBe(1);
    expect(countersChanged).toHaveLength(1);
  });

  it("deliverTokenViaPort 在握手前抛错(薄透传,V-13 前置)", async () => {
    const box = await renderFrame(baseProps);
    expect(() => box.current?.deliverTokenViaPort("t")).toThrow();
  });
});

describe("卸载清理", () => {
  it("unmount 后 message 事件不再进入会话(监听移除,零计数)", async () => {
    const { box } = await renderLoadAndHello(baseProps);
    const esid = box.current?.embedSessionId ?? "";
    act(() => {
      root.unmount();
    });
    // 卸载后容器已空;再派发消息不得抛错(session 监听已移除)。
    expect(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: PLUGIN_ORIGIN,
          source: window,
          data: helloJson(esid),
        }),
      ),
    ).not.toThrow();
  });

  it("卸载后 handle 的防御面:getters 空值 / 控制命令空转 / reload 抛错", async () => {
    const { box } = await renderLoadAndHello(baseProps);
    // React 卸载时会把 ref 回调置回 null:先留存 handle 对象本体。
    const handle = box.current;
    if (handle === null) throw new Error("handle 未取得");
    act(() => {
      root.unmount();
    });
    expect(handle.session).toBeNull();
    expect(handle.embedSessionId).toBeNull();
    expect(handle.state).toBeNull();
    expect(handle.violationCounters).toEqual({});
    act(() => {
      expect(() => handle.reload()).toThrow("EmbedFrame 未挂载");
      expect(handle.sendThemeChanged("dark")).toBe(false);
      expect(handle.sendLanguageChanged("zh")).toBe(false);
      handle.deliverTokenViaPort("t");
    });
  });
});

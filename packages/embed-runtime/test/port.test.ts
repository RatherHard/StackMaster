/**
 * MessageChannel port 转移与凭证交付(D-API-75 备用通道 + V-13 红灯)。
 *
 * 断言面:
 *  - port 转移前置缺失(握手未完成 / 未挂接 iframe)→ 拒绝交付(V-13 红灯);
 *  - 正常路径:转移消息零载荷(除 port2 本体外无凭证无绑定值),token 只经
 *    port 信封送达(桩插件侧收包断言);
 *  - SDK 全部 contentWindow.postMessage 出站调用零凭证载荷(V-13 发出面);
 *  - port 转移后控制面消息改走 port(§4.2 控制面强化)。
 */
import { describe, expect, it } from "vitest";

import {
  EMBED_PORT_CREDENTIAL_KIND,
  EmbedPortDeliveryError,
  type EmbedMessageChannelLike,
  type EmbedMessagePortLike,
} from "../src/index.js";
import {
  completeHandshake,
  helloJson,
  PLUGIN_ORIGIN,
  startHarness,
  type Harness,
} from "./helpers/fakes.js";

/** 记录型假 port(桩插件侧收包断言)。 */
class FakePort implements EmbedMessagePortLike {
  public readonly inbox: unknown[] = [];
  public closed = false;

  public postMessage(message: unknown): void {
    this.inbox.push(message);
  }

  public close(): void {
    this.closed = true;
  }
}

/** 记录型假 MessageChannel。 */
class FakeChannel implements EmbedMessageChannelLike {
  public readonly port1 = new FakePort();
  public readonly port2 = new FakePort();
}

/** 组装注入了通道工厂的 harness(返回 harness 与创建的假通道)。 */
function startPortHarness(options: { opaqueOrigin?: boolean } = {}): {
  h: Harness;
  channel: FakeChannel;
} {
  const channel = new FakeChannel();
  const h = startHarness({
    opaqueOrigin: options.opaqueOrigin === true,
    channelFactory: () => channel,
  });
  return { h, channel };
}

describe("deliverTokenViaPort:port 转移前置(V-13 红灯)", () => {
  it("握手未完成 → EmbedPortDeliveryError,零出站、零通道创建", () => {
    const channel = new FakeChannel();
    const h = startHarness({ channelFactory: () => channel });
    expect(() => h.session.deliverTokenViaPort("token-under-test")).toThrow(EmbedPortDeliveryError);
    expect(h.plugin.callCount).toBe(0);
    expect(channel.port1.inbox).toHaveLength(0);
    h.session.dispose();
  });

  it("未挂接 iframe / contentWindow 不可用 → 拒绝交付(fail-closed)", () => {
    const channel = new FakeChannel();
    const h = startHarness({ channelFactory: () => channel });
    completeHandshake(h);
    // 模拟 iframe 被宿主移除:contentWindow 置 null(窗口绑定失效)。
    (h.iframe as { contentWindow: FakePort | null }).contentWindow = null;
    expect(() => h.session.deliverTokenViaPort("token-under-test")).toThrow(EmbedPortDeliveryError);
    h.session.dispose();
  });

  it("空 token → 拒绝交付", () => {
    const { h } = startPortHarness();
    completeHandshake(h);
    expect(() => h.session.deliverTokenViaPort("")).toThrow(EmbedPortDeliveryError);
    h.session.dispose();
  });
});

describe("deliverTokenViaPort:正常路径", () => {
  it("port2 经 contentWindow 转移(零载荷),token 只经 port 信封送达", () => {
    const { h, channel } = startPortHarness({ opaqueOrigin: true });
    completeHandshake(h);

    const token = "embed-token-under-test";
    h.session.deliverTokenViaPort(token);

    // 转移消息:除 port2 本体外零载荷(message === null);opaque 目标允许 "*"。
    const transferCall = h.plugin.calls.at(-1);
    expect(transferCall?.message).toBeNull();
    expect(transferCall?.targetOrigin).toBe("*");
    expect(transferCall?.transfer).toHaveLength(1);
    // token 只出现在 port 信封(WP-52 插件侧按 EMBED_PORT_CREDENTIAL_KIND 消费)。
    expect(channel.port1.inbox).toEqual([{ kind: EMBED_PORT_CREDENTIAL_KIND, credential: token }]);
    expect(h.session.isPortActive()).toBe(true);
    h.session.dispose();
  });

  it("非 opaque:转移消息 targetOrigin 为明确插件来源(V-11)", () => {
    const { h, channel } = startPortHarness();
    completeHandshake(h);
    h.session.deliverTokenViaPort("t2");
    const transferCall = h.plugin.calls.at(-1);
    expect(transferCall?.targetOrigin).toBe(PLUGIN_ORIGIN);
    expect(channel.port1.inbox).toHaveLength(1);
    h.session.dispose();
  });

  it("port 转移后控制面消息改走 port(§4.2),不再经 contentWindow", () => {
    const { h, channel } = startPortHarness();
    completeHandshake(h);
    const beforePort = h.plugin.callCount;

    h.session.deliverTokenViaPort("t3");
    h.session.sendThemeChanged("light");
    h.session.sendLanguageChanged("en-US");

    // 转移后控制面消息走 port:contentWindow 只多了转移调用本身。
    expect(h.plugin.callCount).toBe(beforePort + 1);
    expect(channel.port1.inbox).toHaveLength(3);
    expect(channel.port1.inbox[1]).toMatchObject({ type: "theme_changed", payload: { theme: "light" } });
    expect(channel.port1.inbox[2]).toMatchObject({ type: "language_changed", payload: { language: "en-US" } });
    h.session.dispose();
  });

  it("dispose / reload 关闭 port 并复位激活态", () => {
    const { h, channel } = startPortHarness();
    completeHandshake(h);
    h.session.deliverTokenViaPort("t4");
    expect(h.session.isPortActive()).toBe(true);

    h.session.reload();
    expect(h.session.isPortActive()).toBe(false);
    expect(channel.port1.closed).toBe(true);
    h.session.dispose();
  });
});

describe("V-13 发出面:SDK 的 contentWindow.postMessage 零凭证载荷", () => {
  it("全流程(握手 → 控制)出站信封均为 EmbedMessage 形态,零凭证字段", () => {
    const h = startHarness();
    completeHandshake(h);
    h.session.sendThemeChanged("dark");
    h.session.sendLanguageChanged("en-US");

    const serialized = h.plugin.serializedOutbound();
    // 发出面从未接触 token 值(凭证只走 deliverTokenViaPort 的 port 信封)。
    expect(serialized).not.toContain("embed-token");
    for (const call of h.plugin.calls) {
      expect(call.message).toMatchObject({ sessionId: h.session.getEmbedSessionId() });
      expect(call.message).not.toHaveProperty("credential");
      expect(call.message).not.toHaveProperty("token");
    }
    h.session.dispose();
  });

  it("port 交付后,token 仍不出现在任何 contentWindow.postMessage 载荷中", () => {
    const { h, channel } = startPortHarness();
    completeHandshake(h);
    const token = "embed-token-never-on-wire";
    h.session.deliverTokenViaPort(token);
    h.session.sendThemeChanged("auto");

    // 序列化全部 contentWindow 出站(含转移消息):token 值零出现(V-13)。
    expect(h.plugin.serializedOutbound()).not.toContain(token);
    // token 唯一出现点 = port 信封。
    expect(JSON.stringify(channel.port1.inbox)).toContain(token);
    h.session.dispose();
  });

  it("hello 携带攻击性 token 形态字段被 Schema 拒绝(信封不容私加,V-4/V-13)", () => {
    const h = startHarness();
    h.session.notifyIframeLoad();
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      helloJson(h.session.getEmbedSessionId(), { extra: { embedToken: "forged" } }),
    );
    expect(h.session.getViolationCounters()["v4-schema-invalid"]).toBe(1);
    expect(h.session.getState()).toBe("awaiting-hello");
    h.session.dispose();
  });
});

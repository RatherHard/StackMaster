/**
 * 13.3 iframe 面全场景(嵌入协议 §5.1 映射表逐行)+ 握手五路径:
 * 常规(§4.1)/ opaque(§4.2)/ 版本失败(§4.3)/ 能力降级(§4.4)/
 * 超时与重载(§4.5)。全部以注入假体获得确定性,零真实等待。
 */
import { describe, expect, it } from "vitest";

import { EmbedCapabilityNotGrantedError, VIOLATION_COUNTER_KEYS } from "../src/index.js";
import {
  completeHandshake,
  FakePluginWindow,
  heightChangedJson,
  helloJson,
  PLUGIN_ORIGIN,
  PLUGIN_URL,
  startHarness,
  type Harness,
} from "./helpers/fakes.js";

describe("13.3 握手常规路径(§4.1,非 opaque)", () => {
  it("load → hello → ready:状态机就绪、ready 信封六字段与能力授予正确", () => {
    const h = startHarness();
    completeHandshake(h);

    expect(h.session.getState()).toBe("ready");
    expect(h.session.getNegotiatedVersion()).toBe(1);
    expect(h.session.getGrantedCapabilities()).toEqual(["theme", "language", "auto_resize"]);
    expect(h.events.handshake).toHaveLength(1);
    expect(h.events.handshake[0]?.grantedCapabilities).toEqual(["theme", "language", "auto_resize"]);

    // 出站只有一条 ready;targetOrigin 为明确插件来源(V-11)。
    expect(h.plugin.callCount).toBe(1);
    const ready = h.plugin.calls[0];
    expect(ready?.targetOrigin).toBe(PLUGIN_ORIGIN);
    expect(ready?.transfer).toBeUndefined();
    expect(ready?.message).toEqual({
      protocolVersion: 1,
      type: "ready",
      sessionId: h.session.getEmbedSessionId(),
      seq: 1,
      payload: {
        grantedCapabilities: ["theme", "language", "auto_resize"],
        config: { theme: "light", language: "zh-CN" },
      },
    });
    h.session.dispose();
  });

  it("esid 经 buildIframeSrc 只进 fragment(硬门槛:零凭证、22 字符)", () => {
    const h = startHarness();
    const src = h.session.buildIframeSrc();
    expect(src).toBe(`${PLUGIN_URL}#esid=${h.session.getEmbedSessionId()}`);
    const esid = src.split("#esid=")[1] ?? "";
    expect(esid).toHaveLength(22);
    expect(esid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(src).not.toContain("token");
    h.session.dispose();
  });

  it("宿主不支持能力(§4.4):授予集收缩,未授予方向的消息丢弃 + 计数", () => {
    const h = startHarness({ grantableCapabilities: ["theme"] });
    completeHandshake(h);

    expect(h.session.getGrantedCapabilities()).toEqual(["theme"]);
    expect(h.plugin.calls[0]?.message).toMatchObject({
      type: "ready",
      payload: { grantedCapabilities: ["theme"] },
    });

    // auto_resize 未授予:height_changed 出现即 V-8 丢弃 + 计数,会话不中断。
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      heightChangedJson(h.session.getEmbedSessionId(), 2, 400),
    );
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v8CapabilityViolation]).toBe(1);
    expect(h.events.height).toHaveLength(0);
    expect(h.session.getState()).toBe("ready");

    // language 未授予:宿主侧发送义务(§4.4)以类型化错误呈现,不产生出站。
    expect(() => h.session.sendLanguageChanged("en-US")).toThrow(EmbedCapabilityNotGrantedError);
    expect(h.plugin.callCount).toBe(1);
    h.session.dispose();
  });

  it("高度上报贯通:V-7 通过后发出 height-changed 事件(含收紧标记)", () => {
    const h = startHarness({ maxHeightPx: 500 });
    completeHandshake(h);
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      heightChangedJson(h.session.getEmbedSessionId(), 2, 900),
    );
    expect(h.events.height).toHaveLength(1);
    expect(h.events.height[0]).toMatchObject({ heightPx: 500, clamped: true, seq: 2 });
    h.session.dispose();
  });
});

describe("13.3 handshake 超时(§4.5 宿主侧)", () => {
  it("T_handshake 内未收 hello → 标记不可用;迟到 hello 丢弃 + 计数,零出站", () => {
    const h = startHarness();
    h.session.notifyIframeLoad();
    expect(h.session.getState()).toBe("awaiting-hello");
    expect(h.scheduler.pendingCount).toBe(1);

    h.clock.advance(10000);
    expect(h.scheduler.runDue()).toBe(1);

    expect(h.session.getState()).toBe("unavailable");
    expect(h.events.unavailable).toHaveLength(1);
    expect(h.events.unavailable[0]?.reason).toBe("handshake-timeout");

    // 迟到 hello:丢弃 + 计数,零出站(§4.5 停止控制面投递)。
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      helloJson(h.session.getEmbedSessionId()),
    );
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.unavailableDrop]).toBe(1);
    expect(h.plugin.callCount).toBe(0);
    h.session.dispose();
  });

  it("T_handshake clamp:越界取边界值(D-API-77,3000–30000)", () => {
    const short = startHarness({ handshakeTimeoutMs: 1 });
    short.session.notifyIframeLoad();
    short.clock.advance(2999);
    expect(short.scheduler.runDue()).toBe(0);
    short.clock.advance(1);
    expect(short.scheduler.runDue()).toBe(1);
    expect(short.session.getState()).toBe("unavailable");
    short.session.dispose();

    const long = startHarness({ handshakeTimeoutMs: 999999 });
    long.session.notifyIframeLoad();
    long.clock.advance(29999);
    expect(long.scheduler.runDue()).toBe(0);
    long.clock.advance(1);
    expect(long.scheduler.runDue()).toBe(1);
    long.session.dispose();
  });
});

describe("13.3 重复 / 乱序 / 非法序列号(V-7 + §4.5)", () => {
  it("握手完成后再收 hello = 状态违规:丢弃 + 计数,不回任何消息", () => {
    const h = startHarness();
    completeHandshake(h);
    expect(h.plugin.callCount).toBe(1);

    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      helloJson(h.session.getEmbedSessionId(), { seq: 2 }),
    );
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.stateHelloAfterReady]).toBe(1);
    expect(h.plugin.callCount).toBe(1);
    expect(h.session.getState()).toBe("ready");
    h.session.dispose();
  });

  it("消息乱序 / 重复:seq ≤ 高水位丢弃;跳号允许", () => {
    const h = startHarness();
    completeHandshake(h);
    const esid = h.session.getEmbedSessionId();

    h.hostWindow.dispatchMessage(PLUGIN_ORIGIN, h.iframe.contentWindow, heightChangedJson(esid, 5));
    expect(h.events.height).toHaveLength(1);
    // 重复(seq 5)与过期(seq 3)一律丢弃。
    h.hostWindow.dispatchMessage(PLUGIN_ORIGIN, h.iframe.contentWindow, heightChangedJson(esid, 5));
    h.hostWindow.dispatchMessage(PLUGIN_ORIGIN, h.iframe.contentWindow, heightChangedJson(esid, 3));
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v7StaleSeq]).toBe(2);
    // 跳号(seq 9)允许。
    h.hostWindow.dispatchMessage(PLUGIN_ORIGIN, h.iframe.contentWindow, heightChangedJson(esid, 9));
    expect(h.events.height).toHaveLength(2);
    expect(h.events.height[1]?.seq).toBe(9);
    h.session.dispose();
  });

  it("非法序列号(seq 0 / 负数)在 Schema 层拒绝(V-4)", () => {
    const h = startHarness();
    completeHandshake(h);
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      heightChangedJson(h.session.getEmbedSessionId(), 0),
    );
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v4SchemaInvalid]).toBe(1);
    expect(h.events.height).toHaveLength(0);
    h.session.dispose();
  });
});

describe("13.3 不受信任来源(V-1 / V-1')", () => {
  it("非 opaque:origin ≠ 插件来源 → 丢弃 + 计数,零出站", () => {
    const h = startHarness();
    h.session.notifyIframeLoad();
    h.hostWindow.dispatchMessage(
      "https://evil.example",
      h.iframe.contentWindow,
      helloJson(h.session.getEmbedSessionId()),
    );
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v1OriginMismatch]).toBe(1);
    expect(h.plugin.callCount).toBe(0);
    expect(h.session.getState()).toBe("awaiting-hello");
    h.session.dispose();
  });

  it("非 opaque:source ≠ 挂接 iframe 的 contentWindow → 丢弃 + 计数(V-5 窗口绑定)", () => {
    const h = startHarness();
    h.session.notifyIframeLoad();
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      new FakePluginWindow(),
      helloJson(h.session.getEmbedSessionId()),
    );
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v1pSourceMismatch]).toBe(1);
    expect(h.plugin.callCount).toBe(0);
    h.session.dispose();
  });

  it("opaque(§4.2):不采信 origin,只认 source 三重绑定;source 正确即握手成功", () => {
    const h = startHarness({ opaqueOrigin: true });
    h.session.notifyIframeLoad();
    // origin 为任意值(含 "null" 之外的伪造值)不影响结论——它不是信任信号。
    h.hostWindow.dispatchMessage(
      "https://whatever.example",
      h.iframe.contentWindow,
      helloJson(h.session.getEmbedSessionId()),
    );
    expect(h.session.getState()).toBe("ready");
    // opaque 目标的 ready 允许 "*"(V-11),信任来自 source + sessionId + seq。
    expect(h.plugin.calls[0]?.targetOrigin).toBe("*");
    h.session.dispose();
  });

  it("opaque:source ≠ contentWindow → 丢弃 + 计数", () => {
    const h = startHarness({ opaqueOrigin: true });
    h.session.notifyIframeLoad();
    h.hostWindow.dispatchMessage(
      "null",
      new FakePluginWindow(),
      helloJson(h.session.getEmbedSessionId()),
    );
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v1pSourceMismatch]).toBe(1);
    expect(h.session.getState()).toBe("awaiting-hello");
    h.session.dispose();
  });
});

describe("13.3 宿主不支持协议版本(§4.3 + V-3)", () => {
  it("交集为空:不回 ready,标记不可用(reason=version-negotiation-failed)", () => {
    const h = startHarness();
    h.session.notifyIframeLoad();
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      helloJson(h.session.getEmbedSessionId(), { supportedVersions: [2, 3] }),
    );
    expect(h.plugin.callCount).toBe(0);
    expect(h.session.getState()).toBe("unavailable");
    expect(h.events.unavailable).toHaveLength(1);
    expect(h.events.unavailable[0]?.reason).toBe("version-negotiation-failed");
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v3UnsupportedVersion]).toBe(1);
    h.session.dispose();
  });

  it("protocolVersion 超出受理集:丢弃 + 计数(V-3 单消息面)", () => {
    const h = startHarness();
    h.session.notifyIframeLoad();
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      helloJson(h.session.getEmbedSessionId(), { protocolVersion: 2 }),
    );
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v3UnsupportedVersion]).toBe(1);
    expect(h.plugin.callCount).toBe(0);
    expect(h.session.getState()).toBe("awaiting-hello");
    h.session.dispose();
  });

  it("版本协商 max-wins 语义:交集取最大(negotiate 纯函数)", async () => {
    const { negotiateEmbedProtocolVersion } = await import("../src/index.js");
    expect(negotiateEmbedProtocolVersion([1], [1])).toBe(1);
    expect(negotiateEmbedProtocolVersion([1, 2], [2])).toBe(2);
    expect(negotiateEmbedProtocolVersion([2, 1], [3, 1, 2])).toBe(2);
    expect(negotiateEmbedProtocolVersion([1, 2], [2, 1, 2, 1])).toBe(2);
    expect(negotiateEmbedProtocolVersion([1], [2, 3])).toBeNull();
    expect(negotiateEmbedProtocolVersion([], [1])).toBeNull();
  });
});

describe("13.3 iframe 重载(§4.5 + V-5 旧值作废)", () => {
  it("reload:新 esid、旧值立即作废、重走完整握手、seq 高水位不继承", () => {
    const h = startHarness();
    completeHandshake(h);
    const oldEsid = h.session.getEmbedSessionId();

    // 重载前把对端高水位推到 10。
    h.hostWindow.dispatchMessage(PLUGIN_ORIGIN, h.iframe.contentWindow, heightChangedJson(oldEsid, 10));
    expect(h.events.height).toHaveLength(1);

    const reload = h.session.reload();
    expect(reload.sessionId).not.toBe(oldEsid);
    expect(h.events.reloads).toHaveLength(1);
    expect(h.session.getState()).toBe("idle");
    expect(h.session.getGrantedCapabilities()).toEqual([]);

    // 旧 esid 消息立即作废(V-5)。
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      heightChangedJson(oldEsid, 11),
    );
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v5SessionMismatch]).toBe(1);

    // 重走完整握手;新会话插件侧从空状态开始——若继承旧高水位(10),
    // hello seq 1 就会被 V-7 丢弃;被接受即证明高水位已复位。
    completeHandshake(h, { seq: 1 });
    expect(h.session.getState()).toBe("ready");
    expect(h.session.getEmbedSessionId()).toBe(reload.sessionId);
    // 高水位从本次 hello(seq 1)重新起算:height seq 2 通过,seq 1 重复被拒。
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      heightChangedJson(reload.sessionId, 2),
    );
    expect(h.events.height).toHaveLength(2);
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      heightChangedJson(reload.sessionId, 1),
    );
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v7StaleSeq]).toBe(1);
    h.session.dispose();
  });

  it("重载后再超时:同样标记不可用", () => {
    const h: Harness = startHarness();
    completeHandshake(h);
    h.session.reload();
    h.session.notifyIframeLoad();
    h.clock.advance(10000);
    h.scheduler.runDue();
    expect(h.session.getState()).toBe("unavailable");
    expect(h.events.unavailable[h.events.unavailable.length - 1]?.reason).toBe("handshake-timeout");
    h.session.dispose();
  });
});

describe("dispose 与事件面", () => {
  it("dispose:监听移除、后续消息不再计数、发出 unavailable(disposed)", () => {
    const h = startHarness();
    completeHandshake(h);
    h.session.dispose();
    expect(h.session.getState()).toBe("unavailable");
    expect(h.events.unavailable).toHaveLength(1);
    expect(h.events.unavailable[0]?.reason).toBe("disposed");

    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      helloJson(h.session.getEmbedSessionId(), { seq: 5 }),
    );
    expect(Object.values(h.session.getViolationCounters()).every((v) => v === 0)).toBe(true);
  });

  it("每次违规计数伴随 violation-counters-changed 事件且快照全键稳定", () => {
    const h = startHarness();
    h.session.notifyIframeLoad();
    h.hostWindow.dispatchMessage("https://evil.example", h.iframe.contentWindow, "{}");
    expect(h.events.counters).toHaveLength(1);
    expect(h.events.counters[0]?.counters[VIOLATION_COUNTER_KEYS.v1OriginMismatch]).toBe(1);
    expect(Object.keys(h.events.counters[0]?.counters ?? {}).length).toBeGreaterThanOrEqual(13);
    h.session.dispose();
  });
});

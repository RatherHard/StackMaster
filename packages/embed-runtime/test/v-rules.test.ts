/**
 * V-1 ~ V-13 逐规则确定性红灯矩阵(嵌入协议 §五;完成标准:每条规则至少
 * 一个红灯,丢弃 + 计数可断言,V-12 断言零回复消息发出)。
 *
 * V-9 / V-11 / V-13 为结构性 / 发送面规则,红灯形态:
 *  - V-9:伪造权威字段(成绩 / 成功标志)落入 V-4 Schema 拒绝;
 *  - V-11:断言发送面 targetOrigin 纪律(非 opaque 恒明确值,opaque 允许 "*");
 *  - V-13:断言 SDK 发出面零凭证载荷 + port 转移前置(test/port.test.ts)。
 */
import { describe, expect, it } from "vitest";

import { MAX_EMBED_MESSAGE_BYTES } from "@stackmaster/protocol";

import {
  EmbedInvalidOptionError,
  EmbedUnavailableError,
  VIOLATION_COUNTER_KEYS,
} from "../src/index.js";
import {
  completeHandshake,
  helloJson,
  PLUGIN_ORIGIN,
  startHarness,
} from "./helpers/fakes.js";

/** 汇集全部红灯后的出站调用数(V-12 断言:违规只丢弃,零回复)。 */
function outboundCount(h: ReturnType<typeof startHarness>): number {
  return h.plugin.callCount;
}

describe("V-1 来源校验(非 opaque)", () => {
  it("origin 不等于插件来源 → v1-origin-mismatch,丢弃,零回复", () => {
    const h = startHarness();
    h.session.notifyIframeLoad();
    h.hostWindow.dispatchMessage(
      "https://evil.example",
      h.iframe.contentWindow,
      helloJson(h.session.getEmbedSessionId()),
    );
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v1OriginMismatch]).toBe(1);
    expect(h.session.getState()).toBe("awaiting-hello");
    expect(outboundCount(h)).toBe(0);
    h.session.dispose();
  });
});

describe("V-1' source 绑定(opaque 与窗口绑定复核)", () => {
  it("source 非预期窗口 → v1p-source-mismatch,丢弃,零回复", () => {
    const h = startHarness({ opaqueOrigin: true });
    h.session.notifyIframeLoad();
    h.hostWindow.dispatchMessage("null", null, helloJson(h.session.getEmbedSessionId()));
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v1pSourceMismatch]).toBe(1);
    expect(outboundCount(h)).toBe(0);
    h.session.dispose();
  });
});

describe("V-2 消息大小与 JSON 对象", () => {
  it("序列化字节超 MAX_EMBED_MESSAGE_BYTES → v2-oversized(JSON 解析前丢弃)", () => {
    const h = startHarness();
    completeHandshake(h);
    const oversized = JSON.stringify({
      protocolVersion: 1,
      type: "height_changed",
      sessionId: h.session.getEmbedSessionId(),
      seq: 2,
      payload: { heightPx: 1, padding: "x".repeat(MAX_EMBED_MESSAGE_BYTES) },
    });
    expect(new TextEncoder().encode(oversized).length).toBeGreaterThan(MAX_EMBED_MESSAGE_BYTES);
    h.hostWindow.dispatchMessage(PLUGIN_ORIGIN, h.iframe.contentWindow, oversized);
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v2Oversized]).toBe(1);
    expect(h.events.height).toHaveLength(0);
    expect(outboundCount(h)).toBe(1);
    h.session.dispose();
  });

  it("非 JSON 对象数据(数字 / 坏 JSON / JSON 数组)→ v2-non-json", () => {
    const h = startHarness();
    completeHandshake(h);
    h.hostWindow.dispatchMessage(PLUGIN_ORIGIN, h.iframe.contentWindow, 42);
    h.hostWindow.dispatchMessage(PLUGIN_ORIGIN, h.iframe.contentWindow, "not-json{{");
    h.hostWindow.dispatchMessage(PLUGIN_ORIGIN, h.iframe.contentWindow, "[1,2,3]");
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v2NonJson]).toBe(3);
    expect(outboundCount(h)).toBe(1);
    h.session.dispose();
  });
});

describe("V-3 版本校验(N-1 受理集)", () => {
  it("protocolVersion=2 → v3-unsupported-version", () => {
    const h = startHarness();
    h.session.notifyIframeLoad();
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      helloJson(h.session.getEmbedSessionId(), { protocolVersion: 2 }),
    );
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v3UnsupportedVersion]).toBe(1);
    expect(outboundCount(h)).toBe(0);
    h.session.dispose();
  });
});

describe("V-4 Schema 校验与未知类型 / 字段", () => {
  it("未知消息类型 → v4-schema-invalid", () => {
    const h = startHarness();
    completeHandshake(h);
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      JSON.stringify({
        protocolVersion: 1,
        type: "win_report",
        sessionId: h.session.getEmbedSessionId(),
        seq: 2,
        payload: {},
      }),
    );
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v4SchemaInvalid]).toBe(1);
    h.session.dispose();
  });

  it("未知 payload 字段 / 坏枚举 / 坏标识符(strictObject)→ v4-schema-invalid", () => {
    const h = startHarness();
    completeHandshake(h);
    const esid = h.session.getEmbedSessionId();
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      JSON.stringify({
        protocolVersion: 1,
        type: "hello",
        sessionId: esid,
        seq: 2,
        payload: { supportedVersions: [1], capabilities: ["theme"], sneaky: true },
      }),
    );
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      JSON.stringify({
        protocolVersion: 1,
        type: "height_changed",
        sessionId: esid,
        seq: 3,
        payload: { heightPx: -5 },
      }),
    );
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      JSON.stringify({
        protocolVersion: 1,
        type: "height_changed",
        sessionId: "短 id",
        seq: 4,
        payload: { heightPx: 5 },
      }),
    );
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v4SchemaInvalid]).toBe(3);
    h.session.dispose();
  });
});

describe("V-5 会话绑定", () => {
  it("esid 不全等(含重载后旧值)→ v5-session-mismatch,丢弃,零回复", () => {
    const h = startHarness();
    completeHandshake(h);
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      helloJson("AAAAAAAAAAAAAAAAAAAAAA", { seq: 2 }),
    );
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v5SessionMismatch]).toBe(1);
    expect(outboundCount(h)).toBe(1);
    h.session.dispose();
  });
});

describe("V-6 方向校验", () => {
  it("宿主收到宿主→插件方向类型(ready / theme_changed)→ v6-wrong-direction", () => {
    const h = startHarness();
    completeHandshake(h);
    const esid = h.session.getEmbedSessionId();
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      JSON.stringify({
        protocolVersion: 1,
        type: "ready",
        sessionId: esid,
        seq: 2,
        payload: { grantedCapabilities: [], config: { theme: "light", language: "zh" } },
      }),
    );
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      JSON.stringify({
        protocolVersion: 1,
        type: "theme_changed",
        sessionId: esid,
        seq: 3,
        payload: { theme: "dark" },
      }),
    );
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v6WrongDirection]).toBe(2);
    expect(outboundCount(h)).toBe(1);
    h.session.dispose();
  });
});

describe("V-7 序列号防重放", () => {
  it("seq ≤ 高水位丢弃;非法序列号走 Schema;跳号允许", () => {
    const h = startHarness();
    completeHandshake(h);
    const esid = h.session.getEmbedSessionId();
    h.hostWindow.dispatchMessage(PLUGIN_ORIGIN, h.iframe.contentWindow,
      JSON.stringify({ protocolVersion: 1, type: "height_changed", sessionId: esid, seq: 7, payload: { heightPx: 10 } }));
    h.hostWindow.dispatchMessage(PLUGIN_ORIGIN, h.iframe.contentWindow,
      JSON.stringify({ protocolVersion: 1, type: "height_changed", sessionId: esid, seq: 7, payload: { heightPx: 10 } }));
    h.hostWindow.dispatchMessage(PLUGIN_ORIGIN, h.iframe.contentWindow,
      JSON.stringify({ protocolVersion: 1, type: "height_changed", sessionId: esid, seq: 6, payload: { heightPx: 10 } }));
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v7StaleSeq]).toBe(2);
    expect(h.events.height).toHaveLength(1);
    h.session.dispose();
  });
});

describe("V-8 能力一致性", () => {
  it("auto_resize 未授予时收到 height_changed → v8-capability-violation,会话不中断", () => {
    const h = startHarness();
    completeHandshake(h, { capabilities: ["theme", "language"] });
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      JSON.stringify({
        protocolVersion: 1,
        type: "height_changed",
        sessionId: h.session.getEmbedSessionId(),
        seq: 2,
        payload: { heightPx: 100 },
      }),
    );
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v8CapabilityViolation]).toBe(1);
    expect(h.events.height).toHaveLength(0);
    expect(h.session.getState()).toBe("ready");
    h.session.dispose();
  });
});

describe("V-9 非权威语义(结构性:伪造即 V-4)", () => {
  it("伪造成绩 / 成功标志的信封字段篡改被 Schema 拒绝(ZR-T4 红灯样例)", () => {
    const h = startHarness();
    completeHandshake(h);
    h.hostWindow.dispatchMessage(
      PLUGIN_ORIGIN,
      h.iframe.contentWindow,
      JSON.stringify({
        protocolVersion: 1,
        type: "hello",
        sessionId: h.session.getEmbedSessionId(),
        seq: 2,
        won: true,
        score: 9999,
        payload: { supportedVersions: [1], capabilities: [] },
      }),
    );
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v4SchemaInvalid]).toBe(1);
    expect(outboundCount(h)).toBe(1);
    h.session.dispose();
  });
});

describe("V-10 频率限制(每 embed 会话按消息类型;D-API-77 参数)", () => {
  it("height_changed 每秒 30 条:第 31 条丢弃 + 计数;窗口滑动后恢复", () => {
    const h = startHarness();
    completeHandshake(h);
    const esid = h.session.getEmbedSessionId();
    let seq = 1;
    for (let i = 0; i < 30; i += 1) {
      seq += 1;
      h.hostWindow.dispatchMessage(PLUGIN_ORIGIN, h.iframe.contentWindow,
        JSON.stringify({ protocolVersion: 1, type: "height_changed", sessionId: esid, seq, payload: { heightPx: 10 + i } }));
    }
    expect(h.events.height).toHaveLength(30);
    seq += 1;
    h.hostWindow.dispatchMessage(PLUGIN_ORIGIN, h.iframe.contentWindow,
      JSON.stringify({ protocolVersion: 1, type: "height_changed", sessionId: esid, seq, payload: { heightPx: 999 } }));
    expect(h.events.height).toHaveLength(30);
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v10RateLimit]).toBe(1);

    h.clock.advance(1001);
    seq += 1;
    h.hostWindow.dispatchMessage(PLUGIN_ORIGIN, h.iframe.contentWindow,
      JSON.stringify({ protocolVersion: 1, type: "height_changed", sessionId: esid, seq, payload: { heightPx: 1000 } }));
    expect(h.events.height).toHaveLength(31);
    h.session.dispose();
  });

  it("宿主自控消息同受 V-10 约束:controlMessageMaxPerSecond 超限丢弃 + 计数", () => {
    const h = startHarness({ controlMessageMaxPerSecond: 2 });
    completeHandshake(h);
    expect(h.session.sendThemeChanged("dark")).toBe(true);
    expect(h.session.sendThemeChanged("light")).toBe(true);
    expect(h.session.sendThemeChanged("dark")).toBe(false);
    expect(h.session.getViolationCounters()[VIOLATION_COUNTER_KEYS.v10RateLimit]).toBe(1);
    // 只发出 2 条(theme_changed 2 条;第 3 条被自限丢弃)。
    expect(h.plugin.calls.filter((c) => (c.message as { type?: string }).type === "theme_changed")).toHaveLength(2);
    h.session.dispose();
  });

  it("不同消息类型独立计数(theme_changed 不挤占 language_changed 配额)", () => {
    const h = startHarness({ controlMessageMaxPerSecond: 1 });
    completeHandshake(h);
    expect(h.session.sendThemeChanged("dark")).toBe(true);
    expect(h.session.sendThemeChanged("auto")).toBe(false);
    expect(h.session.sendLanguageChanged("en-US")).toBe(true);
    h.session.dispose();
  });
});

describe("V-11 targetOrigin 纪律(结构性:发送面断言)", () => {
  it("非 opaque 插件恒用明确 targetOrigin(ready 与控制消息)", () => {
    const h = startHarness();
    completeHandshake(h);
    h.session.sendThemeChanged("dark");
    expect(h.plugin.calls.every((call) => call.targetOrigin === PLUGIN_ORIGIN)).toBe(true);
    h.session.dispose();
  });

  it("opaque 目标允许 \"*\"(§4.2;信任来自三重绑定而非 \"*\")", () => {
    const h = startHarness({ opaqueOrigin: true });
    completeHandshake(h);
    h.session.sendThemeChanged("dark");
    expect(h.plugin.calls.map((call) => call.targetOrigin)).toEqual(["*", "*"]);
    h.session.dispose();
  });
});

describe("V-12 失败静默(结构性:零回复断言)", () => {
  it("混合违规批量注入:只丢弃 + 计数,除 ready 外零出站,会话不中断", () => {
    const h = startHarness();
    completeHandshake(h);
    const esid = h.session.getEmbedSessionId();
    expect(outboundCount(h)).toBe(1); // ready

    h.hostWindow.dispatchMessage("https://evil.example", h.iframe.contentWindow, helloJson(esid, { seq: 2 }));
    h.hostWindow.dispatchMessage(PLUGIN_ORIGIN, h.iframe.contentWindow, 42);
    h.hostWindow.dispatchMessage(PLUGIN_ORIGIN, h.iframe.contentWindow, helloJson(esid, { protocolVersion: 9 }));
    h.hostWindow.dispatchMessage(PLUGIN_ORIGIN, h.iframe.contentWindow,
      JSON.stringify({ protocolVersion: 1, type: "win", sessionId: esid, seq: 3, payload: {} }));
    h.hostWindow.dispatchMessage(PLUGIN_ORIGIN, h.iframe.contentWindow, helloJson("BBBBBBBBBBBBBBBBBBBBBB", { seq: 4 }));
    h.hostWindow.dispatchMessage(PLUGIN_ORIGIN, h.iframe.contentWindow,
      JSON.stringify({ protocolVersion: 1, type: "theme_changed", sessionId: esid, seq: 5, payload: { theme: "dark" } }));

    const counters = h.session.getViolationCounters();
    expect(counters[VIOLATION_COUNTER_KEYS.v1OriginMismatch]).toBe(1);
    expect(counters[VIOLATION_COUNTER_KEYS.v2NonJson]).toBe(1);
    expect(counters[VIOLATION_COUNTER_KEYS.v3UnsupportedVersion]).toBe(1);
    expect(counters[VIOLATION_COUNTER_KEYS.v4SchemaInvalid]).toBe(1);
    expect(counters[VIOLATION_COUNTER_KEYS.v5SessionMismatch]).toBe(1);
    expect(counters[VIOLATION_COUNTER_KEYS.v6WrongDirection]).toBe(1);
    // 零回复:出站调用数不变;会话仍 ready(V-12 不中断)。
    expect(outboundCount(h)).toBe(1);
    expect(h.session.getState()).toBe("ready");
    h.session.dispose();
  });
});

describe("装配期拒绝(选项面 fail-closed)", () => {
  it("maxHeightPx 超协议冻结上限 → EmbedInvalidOptionError(D-API-77:只可收紧)", () => {
    expect(() => startHarness({ maxHeightPx: 100001 })).toThrow(EmbedInvalidOptionError);
  });

  it("supportedVersions 声明无 Schema 的版本 → 装配拒绝(fail-closed)", () => {
    expect(() => startHarness({ supportedVersions: [1, 2] })).toThrow(EmbedInvalidOptionError);
  });

  it("pluginUrl 携带 fragment → 装配拒绝(esid fragment 纪律)", () => {
    expect(() => startHarness({ pluginUrl: "https://plugin.example/vm#other" })).toThrow(
      EmbedInvalidOptionError,
    );
  });

  it("非整数频率参数 → 装配拒绝;越界版本 / 空受理集 → 装配拒绝", () => {
    expect(() => startHarness({ handshakeTimeoutMs: 1.5 })).toThrow(EmbedInvalidOptionError);
    expect(() => startHarness({ supportedVersions: [] })).toThrow(EmbedInvalidOptionError);
    expect(() => startHarness({ supportedVersions: [0] })).toThrow(EmbedInvalidOptionError);
  });

  it("不可用后 / 未就绪的控制面发送 → 类型化错误,零出站", () => {
    const h = startHarness();
    expect(() => h.session.sendThemeChanged("dark")).toThrow(EmbedUnavailableError);
    completeHandshake(h);
    h.session.dispose();
    expect(() => h.session.sendThemeChanged("dark")).toThrow(EmbedUnavailableError);
    h.session.dispose();
  });
});

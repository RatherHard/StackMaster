/**
 * 插件侧握手状态机单测(V-1'/V-1/V-2/V-3/V-4/V-5/V-6/V-7/V-8/V-10/V-11/V-12
 * 插件角色逐规则;§4.3 重试预算 / §4.5 ready 幂等重放 / port 路径)。
 */
import { describe, expect, it } from "vitest";
import type { EmbedCapability } from "@stackmaster/protocol";

import {
  PWN_EMBED_EVENTS,
  PluginEmbedHandshake,
  type PluginCredentialDetail,
  type PluginDegradedDetail,
  type PluginLanguageChangedDetail,
  type PluginReadyDetail,
  type PluginThemeChangedDetail,
  type PluginViolationDetail,
} from "../../src/plugin/handshake.js";
import {
  controlMessage,
  FakeClock,
  FakeListenWindow,
  FakeParentWindow,
  FakePort,
  FakeScheduler,
  HOST_ORIGIN,
  readyMessage,
  TEST_ESID,
} from "../helpers.js";

/** 测试用插件窗口假体(V-1' 的期望 source)。 */
const PLUGIN_SOURCE = { marker: "plugin-window" } as unknown as MessageEventSource;
const OTHER_SOURCE = { marker: "attacker" } as unknown as MessageEventSource;

/** 组装假体并创建会话(start 前状态;事件全部收集)。 */
function makeSession(
  overrides: {
    helloMaxRetries?: number;
    handshakeTimeoutMs?: number;
    controlMessageMaxPerSecond?: number;
    capabilities?: readonly EmbedCapability[];
  } = {},
) {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const parent = new FakeParentWindow();
  const listen = new FakeListenWindow();
  const ready: PluginReadyDetail[] = [];
  const degraded: PluginDegradedDetail[] = [];
  const themes: PluginThemeChangedDetail[] = [];
  const languages: PluginLanguageChangedDetail[] = [];
  const violations: PluginViolationDetail[] = [];
  const credentials: PluginCredentialDetail[] = [];
  const session = new PluginEmbedHandshake({
    esid: TEST_ESID,
    ...(overrides.helloMaxRetries !== undefined ? { helloMaxRetries: overrides.helloMaxRetries } : {}),
    ...(overrides.handshakeTimeoutMs !== undefined
      ? { handshakeTimeoutMs: overrides.handshakeTimeoutMs }
      : {}),
    ...(overrides.controlMessageMaxPerSecond !== undefined
      ? { controlMessageMaxPerSecond: overrides.controlMessageMaxPerSecond }
      : {}),
    ...(overrides.capabilities !== undefined ? { capabilities: overrides.capabilities } : {}),
    clock: () => clock.now(),
    scheduler,
    parentWindow: parent,
    expectedSource: PLUGIN_SOURCE,
    listenWindow: listen,
  });
  session.addEventListener(PWN_EMBED_EVENTS.ready, (e) => ready.push((e as CustomEvent<PluginReadyDetail>).detail));
  session.addEventListener(PWN_EMBED_EVENTS.degraded, (e) =>
    degraded.push((e as CustomEvent<PluginDegradedDetail>).detail),
  );
  session.addEventListener(PWN_EMBED_EVENTS.themeChanged, (e) =>
    themes.push((e as CustomEvent<PluginThemeChangedDetail>).detail),
  );
  session.addEventListener(PWN_EMBED_EVENTS.languageChanged, (e) =>
    languages.push((e as CustomEvent<PluginLanguageChangedDetail>).detail),
  );
  session.addEventListener(PWN_EMBED_EVENTS.violation, (e) =>
    violations.push((e as CustomEvent<PluginViolationDetail>).detail),
  );
  session.addEventListener(PWN_EMBED_EVENTS.credential, (e) =>
    credentials.push((e as CustomEvent<PluginCredentialDetail>).detail),
  );
  return {
    session,
    parent,
    listen,
    clock,
    scheduler,
    ready,
    degraded,
    themes,
    languages,
    violations,
    credentials,
    /** 模拟宿主发来一条 window 消息(默认 origin / source 已绑定)。 */
    host: {
      send(data: unknown, over: { origin?: string; source?: unknown } = {}) {
        listen.dispatchMessage({
          data,
          origin: over.origin ?? HOST_ORIGIN,
          ...(over.source !== undefined ? { source: over.source } : { source: PLUGIN_SOURCE }),
        });
      },
    },
  };
}

/** 完成常规握手:发出 hello → 宿主回 ready(seq=1,全部能力授予)。 */
function completeHandshake(
  harness: ReturnType<typeof makeSession>,
  readyOverrides: Parameters<typeof readyMessage>[1] = {},
): void {
  harness.host.send(readyMessage(TEST_ESID, readyOverrides));
}

describe("插件侧握手:hello 发起(§4.1 / §4.3)", () => {
  it("start 发出 hello:seq=1、supportedVersions=[1]、capabilities 默认全部三项、targetOrigin=*", () => {
    const h = makeSession();
    h.session.start();
    expect(h.parent.callCount).toBe(1);
    const call = h.parent.at(0);
    expect(call.targetOrigin).toBe("*");
    expect(call.message).toMatchObject({
      protocolVersion: 1,
      type: "hello",
      sessionId: TEST_ESID,
      seq: 1,
      payload: {
        supportedVersions: [1],
        capabilities: ["theme", "language", "auto_resize"],
      },
    });
  });

  it("T_handshake 窗口内按预算重发,seq 递增(预算 2 次重试 → 首发共 3 条)", () => {
    // 窗口 4000ms、预算重试 2 次(总发送 3):间隔 1333ms → 0 / 1333 / 2666。
    const h = makeSession({ handshakeTimeoutMs: 4000, helloMaxRetries: 2 });
    h.session.start();
    h.clock.advance(1400);
    h.scheduler.runDue();
    h.clock.advance(1400);
    h.scheduler.runDue();
    expect(h.parent.callCount).toBe(3);
    const seqs = h.parent.calls.map((c) => (c.message as { seq: number }).seq);
    expect(seqs).toEqual([1, 2, 3]);
    // 窗口到期仍未就绪 → 降级事件。
    h.clock.advance(1400);
    h.scheduler.runDue();
    expect(h.degraded.length).toBe(1);
    expect(h.degraded[0]?.reason).toBe("handshake-timeout");
    expect(h.session.state).toBe("degraded");
  });

  it("重试预算耗尽不再发送(不向宿主重试风暴,§4.3)", () => {
    const h = makeSession({ handshakeTimeoutMs: 3000, helloMaxRetries: 1 });
    h.session.start();
    h.clock.advance(2000);
    h.scheduler.runDue();
    h.clock.advance(5000);
    h.scheduler.runDue();
    expect(h.parent.callCount).toBe(2); // 首发一次 + 重试一次,不再增长。
    expect(h.degraded.length).toBe(1);
  });

  it("ready 到达即清计时器:窗口内不再重发 hello", () => {
    const h = makeSession({ handshakeTimeoutMs: 3000, helloMaxRetries: 3 });
    h.session.start();
    completeHandshake(h);
    const sentBefore = h.parent.callCount;
    h.clock.advance(30000);
    h.scheduler.runDue();
    expect(h.parent.callCount).toBe(sentBefore);
    expect(h.degraded.length).toBe(0);
    expect(h.session.state).toBe("ready");
  });

  it("helloMaxRetries=0 → 窗口内仅首发一次,到期降级", () => {
    const h = makeSession({ handshakeTimeoutMs: 3000, helloMaxRetries: 0 });
    h.session.start();
    h.clock.advance(30000);
    h.scheduler.runDue();
    expect(h.parent.callCount).toBe(1);
    expect(h.degraded.length).toBe(1);
  });
});

describe("ready 消费(V-1'/V-5/V-7/V-8/V-11)", () => {
  it("V-1':source ≠ window.parent 丢弃 + 计数,零反馈(V-12)", () => {
    const h = makeSession();
    h.session.start();
    h.host.send(readyMessage(TEST_ESID), { source: OTHER_SOURCE });
    expect(h.ready.length).toBe(0);
    expect(h.session.getViolationCounters()["v1p-source-mismatch"]).toBe(1);
    // 零反馈:出站仍只有 hello 一条。
    expect(h.parent.callCount).toBe(1);
  });

  it("V-5:sessionId ≠ 本端 esid 丢弃 + 计数", () => {
    const h = makeSession();
    h.session.start();
    h.host.send(readyMessage("OTHER-ESID-VALUE-0123456789x"));
    expect(h.ready.length).toBe(0);
    expect(h.session.getViolationCounters()["v5-session-mismatch"]).toBe(1);
  });

  it("ready 首达:钉住宿主 origin(V-11),此后发送一律明确 targetOrigin", () => {
    const h = makeSession();
    h.session.start();
    completeHandshake(h);
    expect(h.ready.length).toBe(1);
    expect(h.ready[0]?.pinnedOrigin).toBe(HOST_ORIGIN);
    expect(h.ready[0]?.replay).toBe(false);
    expect(h.session.pinnedOrigin).toBe(HOST_ORIGIN);
    // 就绪后 height_changed 以钉住 origin 发送(授予面完整)。
    expect(h.session.sendHeightChanged(320)).toBe(true);
    expect(h.parent.lastTargetOrigin).toBe(HOST_ORIGIN);
    expect(h.parent.lastTargetOrigin).not.toBe("*");
  });

  it("V-1(握手后):origin 与钉住值不等 → 丢弃 + 计数", () => {
    const h = makeSession();
    h.session.start();
    completeHandshake(h);
    h.host.send(controlMessage("theme_changed", TEST_ESID, 2, "dark"), { origin: "https://evil.example" });
    expect(h.themes.length).toBe(0);
    expect(h.session.getViolationCounters()["v1-origin-mismatch"]).toBe(1);
  });

  it("V-7:ready 重发 seq 更大 → 接受并幂等重放初始化;seq 更小 → 丢弃 + 计数", () => {
    const h = makeSession();
    h.session.start();
    completeHandshake(h); // seq 1。
    // 宿侧重试:seq 2(更大)→ 幂等重放(replay=true,配置重应用)。
    h.host.send(readyMessage(TEST_ESID, { seq: 2, theme: "dark" }));
    expect(h.ready.length).toBe(2);
    expect(h.ready[1]?.replay).toBe(true);
    expect(h.ready[1]?.config.theme).toBe("dark");
    // 宿侧重试旧包:seq 1(≤ 高水位 2)→ 丢弃 + 计数。
    h.host.send(readyMessage(TEST_ESID, { seq: 1 }));
    expect(h.ready.length).toBe(2);
    expect(h.session.getViolationCounters()["v7-stale-seq"]).toBe(1);
  });

  it("防御性 V-8:granted ⊄ 本端声明集 → 丢弃 + 计数(不信任类型标注)", () => {
    const h = makeSession({ capabilities: ["theme"] });
    h.session.start();
    h.host.send(readyMessage(TEST_ESID, { grantedCapabilities: ["theme", "auto_resize"] }));
    expect(h.ready.length).toBe(0);
    expect(h.session.getViolationCounters()["v8-capability-violation"]).toBe(1);
  });
});

describe("方向过滤与控制消息(V-6 / V-8 / V-10)", () => {
  it("V-6:宿主 → 插件方向集之外的类型(hello/height_changed 回声)丢弃 + 计数", () => {
    const h = makeSession();
    h.session.start();
    completeHandshake(h);
    h.host.send({ protocolVersion: 1, type: "hello", sessionId: TEST_ESID, seq: 5, payload: { supportedVersions: [1], capabilities: [] } });
    h.host.send({ protocolVersion: 1, type: "height_changed", sessionId: TEST_ESID, seq: 6, payload: { heightPx: 10 } });
    expect(h.session.getViolationCounters()["v6-wrong-direction"]).toBe(2);
  });

  it("V-8 三行表:未授予 theme/language 时对应消息丢弃 + 计数,不中断会话", () => {
    const h = makeSession();
    h.session.start();
    completeHandshake(h, { grantedCapabilities: ["auto_resize"] });
    h.host.send(controlMessage("theme_changed", TEST_ESID, 2, "dark"));
    h.host.send(controlMessage("language_changed", TEST_ESID, 3, "en-US"));
    expect(h.themes.length).toBe(0);
    expect(h.languages.length).toBe(0);
    expect(h.session.getViolationCounters()["v8-capability-violation"]).toBe(2);
    // 不中断:授予的 auto_resize 上报仍然工作。
    expect(h.session.sendHeightChanged(480)).toBe(true);
  });

  it("V-8:授予后 theme_changed / language_changed 正常消费", () => {
    const h = makeSession();
    h.session.start();
    completeHandshake(h);
    h.host.send(controlMessage("theme_changed", TEST_ESID, 2, "dark"));
    h.host.send(controlMessage("language_changed", TEST_ESID, 3, "en-US"));
    expect(h.themes).toEqual([{ theme: "dark" }]);
    expect(h.languages).toEqual([{ language: "en-US" }]);
  });

  it("V-10 入站外圈:控制消息超过每秒上限丢弃 + 计数", () => {
    const h = makeSession({ controlMessageMaxPerSecond: 2 });
    h.session.start();
    completeHandshake(h);
    for (let seq = 2; seq <= 5; seq += 1) {
      h.host.send(controlMessage("theme_changed", TEST_ESID, seq, "dark"));
    }
    expect(h.themes.length).toBe(2);
    expect(h.session.getViolationCounters()["v10-rate-limit"]).toBe(2);
  });
});

describe("V-2 / V-3 / V-4(到达形态与契约校验)", () => {
  it("V-2:不可解析 / 非对象 / 超大消息丢弃 + 计数", () => {
    const h = makeSession();
    h.session.start();
    h.host.send("not json {{{");
    h.host.send(42);
    h.host.send("[1,2,3]");
    const oversized = JSON.stringify({
      protocolVersion: 1,
      type: "ready",
      sessionId: TEST_ESID,
      seq: 1,
      payload: { grantedCapabilities: [], config: { theme: "light", language: "zh" } },
      pad: "x".repeat(70000),
    });
    h.host.send(oversized);
    const counters = h.session.getViolationCounters();
    expect(counters["v2-non-json"]).toBe(3);
    expect(counters["v2-oversized"]).toBe(1);
  });

  it("V-2:字符串 JSON 形态的合法 ready 同样受理(到达形态兼容)", () => {
    const h = makeSession();
    h.session.start();
    h.host.send(JSON.stringify(readyMessage(TEST_ESID)));
    expect(h.ready.length).toBe(1);
  });

  it("V-3:不支持的 protocolVersion 丢弃 + 计数", () => {
    const h = makeSession();
    h.session.start();
    const message = readyMessage(TEST_ESID) as Record<string, unknown>;
    message.protocolVersion = 2;
    h.host.send(message);
    expect(h.ready.length).toBe(0);
    expect(h.session.getViolationCounters()["v3-unsupported-version"]).toBe(1);
  });

  it("V-4:未知类型 / 未知字段 / 坏枚举丢弃 + 计数(V-9 伪造字段结构性落网)", () => {
    const h = makeSession();
    h.session.start();
    h.host.send({ protocolVersion: 1, type: "you_won", sessionId: TEST_ESID, seq: 1, payload: {} });
    h.host.send({ protocolVersion: 1, type: "ready", sessionId: TEST_ESID, seq: 1, forgedScore: 100, payload: { grantedCapabilities: [], config: { theme: "light", language: "zh" } } });
    h.host.send({ protocolVersion: 1, type: "ready", sessionId: TEST_ESID, seq: 1, payload: { grantedCapabilities: [], config: { theme: "blue", language: "zh" } } });
    expect(h.ready.length).toBe(0);
    expect(h.session.getViolationCounters()["v4-schema-invalid"]).toBe(3);
  });
});

describe("降级与恢复(§4.3 / §4.5)", () => {
  it("降级后迟到的 ready 通过全部校验仍可完成握手(慢网韧性)", () => {
    const h = makeSession({ handshakeTimeoutMs: 3000, helloMaxRetries: 0 });
    h.session.start();
    h.clock.advance(4000);
    h.scheduler.runDue();
    expect(h.session.state).toBe("degraded");
    h.host.send(readyMessage(TEST_ESID));
    expect(h.ready.length).toBe(1);
    expect(h.session.state).toBe("ready");
    expect(h.session.getViolationCounters()["unavailable-drop"] ?? 0).toBe(0);
  });

  it("用户重试入口:同会话重发 hello(seq 递增不清零),重开窗口", () => {
    const h = makeSession({ handshakeTimeoutMs: 3000, helloMaxRetries: 0 });
    h.session.start();
    h.clock.advance(4000);
    h.scheduler.runDue();
    expect(h.degraded.length).toBe(1);
    h.session.retry();
    const seqs = h.parent.calls.map((c) => (c.message as { seq: number }).seq);
    expect(seqs).toEqual([1, 2]);
    // 新窗口内 ready 到达:完成握手。
    h.host.send(readyMessage(TEST_ESID));
    expect(h.session.state).toBe("ready");
  });

  it("已就绪后 retry 为 no-op;dispose 后消息与 retry 一律 no-op", () => {
    const h = makeSession();
    h.session.start();
    completeHandshake(h);
    h.session.retry();
    expect(h.parent.callCount).toBe(1); // 就绪后无新 hello。
    h.session.dispose();
    h.host.send(controlMessage("theme_changed", TEST_ESID, 2, "dark"));
    expect(h.themes.length).toBe(0);
    expect(h.session.sendHeightChanged(480)).toBe(false);
    h.session.retry();
    expect(h.parent.callCount).toBe(1);
  });
});

describe("port 路径(WP-51 wire 形态 / D-API-75 备用通道 b)", () => {
  it("port 转移消息(ports 非空)→ 绑定 port;控制面消息改走 port 正常消费", () => {
    const h = makeSession();
    h.session.start();
    const port = new FakePort();
    h.listen.dispatchMessage({ data: null, origin: HOST_ORIGIN, source: PLUGIN_SOURCE, ports: [port] });
    completeHandshake(h); // 窗口消息的 ready 仍可先行(port 绑定不影响窗口路径)。
    port.dispatch(controlMessage("theme_changed", TEST_ESID, 9, "dark"));
    expect(h.themes).toEqual([{ theme: "dark" }]);
    // 就绪后插件发送改走 port(V-11 / §4.2 控制面强化)。
    expect(h.session.sendHeightChanged(600)).toBe(true);
    expect(port.sent).toEqual([
      { protocolVersion: 1, type: "height_changed", sessionId: TEST_ESID, seq: 2, payload: { heightPx: 600 } },
    ]);
  });

  it("port 凭证信封(kind=stackmaster:embed-credential)→ credential 事件(值只搬运零解析)", () => {
    const h = makeSession();
    h.session.start();
    const port = new FakePort();
    h.listen.dispatchMessage({ data: null, ports: [port] });
    port.dispatch({ kind: "stackmaster:embed-credential", credential: "opaque-token" });
    expect(h.credentials).toEqual([{ credential: "opaque-token" }]);
    // 形态不符的信封(kind 对但 credential 缺失)→ V-4 计数。
    port.dispatch({ kind: "stackmaster:embed-credential" });
    expect(h.session.getViolationCounters()["v4-schema-invalid"]).toBe(1);
  });
});

describe("计数快照形态(V-12 插件本地面)", () => {
  it("每次递增伴随 violation 事件携带快照;计数只增;键与宿主侧同词汇", () => {
    const h = makeSession();
    h.session.start();
    h.host.send(readyMessage(TEST_ESID), { source: OTHER_SOURCE });
    h.host.send(readyMessage(TEST_ESID), { source: OTHER_SOURCE });
    expect(h.violations.length).toBe(2);
    expect(h.violations[0]?.key).toBe("v1p-source-mismatch");
    expect(h.violations[1]?.counters["v1p-source-mismatch"]).toBe(2);
    // 计数键词汇与 embed-runtime VIOLATION_COUNTER_KEYS 同名(13.3 同一断言锚)。
    expect(Object.keys(h.violations[1]?.counters ?? {})).toContain("v1-origin-mismatch");
  });
});

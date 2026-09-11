/**
 * WP-55 E2E:嵌入协议面(宿主模拟页 5173 × 插件文档页 5174;13.3 iframe 面
 * 场景,嵌入协议 §5.1 映射表逐行;退出条件 1 / 6 的浏览器面)。
 *
 * 场景 → 用例映射(13.3 / §5.1):
 *   常规握手(§4.1 全链路)            → 「正常握手全链路……」
 *   iframe 重载(§4.5 新 esid 旧值作废)→ 「iframe 重载……」
 *   握手超时(§4.3/§4.5 双侧)        → 「插件侧握手超时……」「宿主侧 T_handshake……」
 *   不受信来源 / 伪造消息(V-1~V-8,V-12)→ 「伪造消息与不受信来源……」
 *   能力降级(§4.4 三行)             → 「未授予 theme / language……」「未授予 auto_resize……」
 *   版本协商失败(§4.3)              → 「版本协商失败……」
 *   断线恢复嵌入侧呈现(退出条件 6)   → 「断线恢复嵌入侧呈现……」
 *
 * 断言纪律(硬门槛):一切校验失败 = 丢弃 + 本地计数、零反馈、零中断(V-12)——
 * 两侧计数读数(宿主 host-mock-counters / 插件 violationCounters 诊断 getter)
 * 递增,同时会话状态机不受影响;伪造内容零回显(静态文案与受控事件日志之外
 * 不出现任何对端消息细节)。
 *
 * 环境口径:compose 全拓扑(demo-override 登记 5173/5174 origin)由
 * global-setup 拉起;5174 插件站点由 playwright webServer 拉起;每用例唯一
 * challengeId / tenantId(seed 纪律同 fixtures.ts);Playwright 串行单 worker。
 */
import { expect, type FrameLocator, type Page, type WebSocketRoute } from "@playwright/test";

import {
  closeEmbedSessionBestEffort,
  embedViaHostMock,
  hostCounters,
  hostEventLog,
  injectViaPanel,
  PLUGIN_SITE_URL,
  pluginAppearance,
  pluginCounters,
  pluginFragmentEsid,
  pluginMenuButton,
  pluginMenuStatus,
  pluginOpenTabButton,
  pluginPhase,
  pluginVm,
  postFromPluginToHost,
} from "./helpers/embed.js";
import { test } from "./fixtures.js";

/** 轮询等待宿主计数某键达到阈值(注入到计数回流为异步事件)。 */
async function waitForHostCounter(page: Page, key: string, atLeast: number): Promise<void> {
  await expect
    .poll(async () => (await hostCounters(page))[key] ?? 0, {
      message: `宿主违规计数 ${key} 未达到 ${atLeast}`,
    })
    .toBeGreaterThanOrEqual(atLeast);
}

/** 轮询等待插件计数某键达到阈值(V-12 本地面异步回流)。 */
async function waitForPluginCounter(
  plugin: FrameLocator,
  key: string,
  atLeast: number,
): Promise<void> {
  await expect
    .poll(async () => (await pluginCounters(plugin))[key] ?? 0, {
      message: `插件违规计数 ${key} 未达到 ${atLeast}`,
    })
    .toBeGreaterThanOrEqual(atLeast);
}

test.describe("嵌入协议面(宿主模拟页 × 插件文档页;13.3 iframe 面)", () => {
  test("正常握手全链路:签发 → 嵌入 → 握手 → create_session → 动作 → 投影渲染(revision 前进)", async ({
    page,
  }) => {
    // 受限 CSP 形态自证:插件文档页响应携带 script-src 'self',本用例全功能
    // (握手 / create_session / 工作区 / 动作)在该 CSP 下运行 = 功能不受限。
    const pluginPageResponse = await page.request.get(PLUGIN_SITE_URL);
    expect(pluginPageResponse.headers()["content-security-policy"]).toContain("script-src 'self'");

    const handle = await embedViaHostMock(page);

    // 握手结果面:协商版本 = 1(max-wins;冻结期双方受理集均为 [1])、
    // 授予能力全量(冻结枚举序)、插件外观接线位落地。
    await expect(page.getByTestId("host-mock-negotiated")).toHaveText("1");
    await expect(page.getByTestId("host-mock-granted")).toHaveText("theme, language, auto_resize");
    const appearance = await pluginAppearance(handle.plugin);
    expect(appearance.theme).toBe("light");
    expect(appearance.resolvedTheme).toBe("light");
    expect(appearance.language).toBe("zh-CN");

    // 投影渲染 + 核心交互可达(寄存器视图,非虚拟化路径;初始 RSP 与 seed 同源)。
    // (环境口径:本机 Chromium 对跨源 iframe 按需出帧,首次交互前 rAF 合流
    // 管道不出帧——先驱动一次 iframe 内交互,再断言 height_changed,见决策草稿。)
    await pluginOpenTabButton(handle.plugin, "registers").click();
    await expect(handle.plugin.locator("sm-register-view")).toContainText("RSP");
    await expect(handle.plugin.locator("sm-register-view")).toContainText("0x7FFFF008");

    // height_changed 上报(auto_resize 授予;rAF 合流管道,宿主事件日志可见)。
    await expect(page.getByTestId("host-mock-event-log")).toContainText("height_changed", {
      timeout: 15_000,
    });

    // 动作 → 投影 revision 前进(认证 WSS;embed token 三方比对已由
    // create_session 201 证明)。
    await expect(pluginMenuStatus(handle.plugin, "revision")).toHaveText("0");
    await pluginMenuButton(handle.plugin, "step-button").click();
    await expect(pluginMenuStatus(handle.plugin, "revision")).toHaveText("1");
    await expect(pluginMenuStatus(handle.plugin, "connection-status")).toHaveText("connected");

    // 全链路零违规(V-12 本地面两侧清零;WP-52 冒烟第六步的 spec 形态)。
    const host = await hostCounters(page);
    for (const [key, value] of Object.entries(host)) {
      expect(value, `宿主计数 ${key} 应为 0`).toBe(0);
    }
    const pluginSide = await pluginCounters(handle.plugin);
    for (const [key, value] of Object.entries(pluginSide)) {
      expect(value, `插件计数 ${key} 应为 0`).toBe(0);
    }

    await closeEmbedSessionBestEffort(handle);
  });

  test("iframe 重载(§4.5):新 esid 轮换、旧 esid 消息按 V-5 拒绝、插件从空状态重新握手", async ({
    page,
  }) => {
    const handle = await embedViaHostMock(page);
    const oldEsid = handle.esid;

    // 宿主发起重载:新 esid、旧值立即作废、重签 token、iframe 重建。
    await page.getByTestId("host-mock-reload-button").click();
    await expect(page.getByTestId("host-mock-esid")).not.toHaveText(oldEsid);
    const newEsid = (await page.getByTestId("host-mock-esid").textContent()) ?? "";
    expect(newEsid).not.toBe(oldEsid);
    // iframe src fragment 只携带新 esid(硬门槛:fragment 纪律)。
    await expect(page.getByTestId("host-mock-iframe")).toHaveAttribute(
      "src",
      new RegExp(`#esid=${newEsid}$`),
    );
    await expect(page.getByTestId("host-mock-event-log")).toContainText("重载发起:新 esid");

    // 重载后从空状态重新握手(新文档 = 新元素实例;seq / 外观 / 授予全零重开)。
    await expect(page.getByTestId("host-mock-state")).toContainText("ready", { timeout: 20_000 });
    await handle.plugin.locator('[data-testid="pwn-workspace"] sm-workspace').waitFor({
      timeout: 20_000,
    });
    await expect(pluginMenuStatus(handle.plugin, "revision")).toHaveText("0");

    // 旧 esid 的 hello(满足 V-1/V-1'/V-2/V-3/V-4)→ 按 V-5 拒绝 + 计数,
    // 零反馈、会话不受影响。
    await postFromPluginToHost(handle.plugin, {
      protocolVersion: 1,
      type: "hello",
      sessionId: oldEsid,
      seq: 100,
      payload: { supportedVersions: [1], capabilities: ["theme", "language", "auto_resize"] },
    });
    await waitForHostCounter(page, "v5-session-mismatch", 1);
    await expect(page.getByTestId("host-mock-state")).toContainText("ready");
    await expect(pluginMenuStatus(handle.plugin, "connection-status")).toHaveText("connected");

    await closeEmbedSessionBestEffort(handle);
  });

  test("插件侧握手超时 → 降级显示(静态文案零反射;重试入口;§4.3)", async ({ page }) => {
    // 静默宿主页(5173 同源,route fulfill):只签发引导记录 + 建指向插件页的
    // iframe,不监听消息、不回 ready——插件 hello 落空,T_handshake(3 s 收紧
    // 形态,经变体插件页 attribute)耗尽 → 降级显示。
    const tenantId = `e2e-embed-timeout-${Math.random().toString(36).slice(2, 10)}`;
    const challengeId = `chal-embed-timeout-${Math.random().toString(36).slice(2, 10)}`;
    await page.route(/\/e2e-silent-host\.html$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>E2E 静默宿主</title></head>
<body><script type="module">
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const esid = btoa(String.fromCharCode(...bytes)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  await fetch("/host-api/embed-tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenantId: ${JSON.stringify(tenantId)}, userId: "e2e-user-timeout",
      challengeId: ${JSON.stringify(challengeId)}, challengeVersion: "1.0.0", embedSessionId: esid }),
  });
  const iframe = document.createElement("iframe");
  iframe.sandbox = "allow-scripts allow-same-origin allow-forms";
  iframe.setAttribute("data-testid", "host-mock-iframe");
  iframe.src = "http://localhost:5174/?e2e=fast-timeout#esid=" + esid;
  document.body.append(iframe);
</script></body></html>`,
      }),
    );
    // 插件页变体:同源产物 + 收紧的 T_handshake / 零重试预算(attribute 面
    // 仅供部署收紧与测试注入,D-API-77;bootstrap 端点与正式页同值)。
    await page.route(/localhost:5174\/\?e2e=fast-timeout$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: { "content-security-policy": "script-src 'self'" },
        body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>E2E 快速超时插件</title></head>
<body><pwn-memory-vm
  bootstrap-endpoint="http://localhost:5173/host-api/embed-bootstrap"
  handshake-timeout-ms="3000"
  hello-max-retries="0"
></pwn-memory-vm>
<script type="module" src="./pwn-memory-vm.js"></script></body></html>`,
      }),
    );

    await page.goto("http://localhost:5173/e2e-silent-host.html");
    const plugin = page.frameLocator('[data-testid="host-mock-iframe"]');

    // 降级显示:pwn-degraded + 降级键 + 静态文案 + 重试入口。
    const degraded = plugin.locator('[data-testid="pwn-degraded"]');
    await expect(degraded).toBeVisible({ timeout: 20_000 });
    await expect(degraded).toHaveAttribute("data-pwn-reason", "handshake-timeout");
    await expect(plugin.locator('[data-testid="pwn-status"]')).toHaveText(
      "连接宿主超时:在时限内未完成握手。可点击重试,或从宿主平台重新进入。",
    );
    await expect(plugin.locator('[data-testid="pwn-retry-button"]')).toBeVisible();
    // 零反射面:降级容器不携带 esid / 端点 / 任何消息细节(纯静态文案)。
    const degradedText = (await degraded.textContent()) ?? "";
    expect(degradedText).not.toMatch(/esid|http|token|bootstrap/i);
    expect(await pluginPhase(plugin)).toBe("degraded");

    // 重试入口(§4.5 同会话重发预算重开):仍无宿主 → 维持降级静态文案。
    await plugin.locator('[data-testid="pwn-retry-button"]').click();
    await expect(degraded).toHaveAttribute("data-pwn-reason", "handshake-timeout");
    await expect(plugin.locator('[data-testid="pwn-status"]')).toHaveText(
      "连接宿主超时:在时限内未完成握手。可点击重试,或从宿主平台重新进入。",
    );
  });

  test("宿主侧 T_handshake 超时 → 会话不可用标记与控制面停止(静默插件形态;§4.5)", async ({
    page,
  }) => {
    // 插件 URL 指向静默变体页(fulfill:纯 HTML 零脚本 → 永不 hello);
    // 宿主 T_handshake(默认 10 s)耗尽 → embed 会话不可用标记。
    await page.route(/localhost:5174\/\?e2e=silent-plugin$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>静默插件(E2E)</title></head><body></body></html>',
      }),
    );
    const handle = await embedViaHostMock(page, {
      pluginUrl: `${PLUGIN_SITE_URL}?e2e=silent-plugin`,
      seed: false,
      waitForWorkspace: false,
      handshakeExpectation: "none",
    });

    await expect(page.getByTestId("host-mock-state")).toContainText("不可用", { timeout: 20_000 });
    await expect(page.getByTestId("host-mock-state")).toContainText("handshake-timeout");
    await expect(page.getByTestId("host-mock-event-log")).toContainText("embed 会话不可用");
    // 不可用后控制面投递停止:主题 / 语言控件失效由面板 disabled 表达。
    await expect(page.getByTestId("host-mock-theme-select")).toBeDisabled();
    expect(handle.sessionId).toBeNull();
  });

  test("伪造消息与不受信来源:两侧违规计数递增、会话不中断、零回复、零 console 泄漏(V-12 / ZR-B7)", async ({
    page,
  }) => {
    const handle = await embedViaHostMock(page);
    const esid = handle.esid;

    // ZR-B7 抽样断言:注入窗口内宿主页与插件帧 console error / warning 面为空
    // (违规只计数、零内部细节;三个浏览器包源码零 console 调用为结构前提)。
    const consoleProblems: string[] = [];
    const consoleListener = (message: {
      type(): string;
      text(): string;
      location(): { url: string };
    }): void => {
      if (message.type() === "error" || message.type() === "warning") {
        consoleProblems.push(`${message.type()}: ${message.text()} @ ${message.location().url}`);
      }
    };
    page.on("console", consoleListener);

    // ① 不受信来源(宿主窗口自投递,source ≠ iframe.contentWindow 且 origin
    //    ≠ 插件来源)→ 宿主 V-1 计数。
    await injectViaPanel(page, "host-window", "wrong-direction-ready");
    await waitForHostCounter(page, "v1-origin-mismatch", 1);

    // ② 受入侵插件面投递重复 hello(esid 合法、seq 前进)→ 状态违规计数
    //    (§4.5:握手完成后再收 hello)。
    await postFromPluginToHost(handle.plugin, {
      protocolVersion: 1,
      type: "hello",
      sessionId: esid,
      seq: 50,
      payload: { supportedVersions: [1], capabilities: ["theme", "language", "auto_resize"] },
    });
    await waitForHostCounter(page, "state-hello-after-ready", 1);

    // ③ 乱序 seq 的 height_changed → V-7 计数(Schema seq 下限 = 1,故以
    //    「已推进高水位的合法 seq=1」承载乱序形态:真实高度上报已把对端
    //    高水位推进到 ≥ 2,seq=1 即过期;先交互一次以驱动真实高度上报)。
    await pluginOpenTabButton(handle.plugin, "registers").click();
    await expect(page.getByTestId("host-mock-event-log")).toContainText("height_changed", {
      timeout: 15_000,
    });
    await postFromPluginToHost(handle.plugin, {
      protocolVersion: 1,
      type: "height_changed",
      sessionId: esid,
      seq: 1,
      payload: { heightPx: 600 },
    });
    await waitForHostCounter(page, "v7-stale-seq", 1);

    // ④ 宿主→插件方向的 ready 投给宿主(方向违规;V-5 之后落 V-6)。
    await postFromPluginToHost(handle.plugin, {
      protocolVersion: 1,
      type: "ready",
      sessionId: esid,
      seq: 51,
      payload: { grantedCapabilities: ["theme"], config: { theme: "dark", language: "zh-CN" } },
    });
    await waitForHostCounter(page, "v6-wrong-direction", 1);

    // ⑤ 面板向插件 iframe 注入错 sessionId 的 ready → 插件 V-5 计数。
    await injectViaPanel(page, "plugin-iframe", "wrong-esid-ready");
    await waitForPluginCounter(handle.plugin, "v5-session-mismatch", 1);

    // ⑥ 面板向插件 iframe 注入 hello(插件→宿主方向)→ 插件 V-6 计数。
    await injectViaPanel(page, "plugin-iframe", "wrong-direction-hello");
    await waitForPluginCounter(handle.plugin, "v6-wrong-direction", 1);

    // ⑦ 面板向插件 iframe 注入 seq=0 的 theme_changed → 插件 V-7 计数。
    await injectViaPanel(page, "plugin-iframe", "stale-seq-theme");
    await waitForPluginCounter(handle.plugin, "v7-stale-seq", 1);

    // 会话不中断:注入后宿主状态机仍 ready、插件仍 session-ready、revision
    // 仍可前进(动作照常);主题切换照常生效(未受伪造 ready 的 granted 扰动)。
    await expect(page.getByTestId("host-mock-state")).toContainText("ready");
    expect(await pluginPhase(handle.plugin)).toBe("session-ready");
    await pluginMenuButton(handle.plugin, "step-button").click();
    await expect(pluginMenuStatus(handle.plugin, "revision")).toHaveText("1");
    await page.getByTestId("host-mock-theme-select").selectOption("dark");
    await expect(pluginVm(handle.plugin)).toHaveAttribute("data-sm-theme", "dark", {
      timeout: 10_000,
    });

    // 零反馈:插件工作区无任何错误呈现(error explainer 组件随教学面板恒
    // 挂载,其错误内容位缺席 = 无拒绝面呈现)。
    await expect(handle.plugin.locator("sm-error-explainer .code-badge")).toHaveCount(0);

    page.off("console", consoleListener);
    expect(consoleProblems, `console 面泄漏内部细节:\n${consoleProblems.join("\n")}`).toEqual([]);

    await closeEmbedSessionBestEffort(handle);
  });

  test("未授予 theme / language → 内置默认外观、控制消息被宿主拒绝(§4.4)", async ({
    page,
  }) => {
    const handle = await embedViaHostMock(page, {
      grantTheme: false,
      grantLanguage: false,
    });

    // 宿主授予面:hello 声明全量,宿主可授予集收紧 → 授予 = {auto_resize}。
    await expect(page.getByTestId("host-mock-granted")).toHaveText("auto_resize");

    // 插件外观保持内置默认(light / zh-CN),外观接线位仍在。
    const appearance = await pluginAppearance(handle.plugin);
    expect(appearance.theme).toBe("light");
    expect(appearance.resolvedTheme).toBe("light");
    expect(appearance.language).toBe("zh-CN");
    await expect(pluginVm(handle.plugin)).toHaveAttribute("data-sm-theme", "light");
    await expect(pluginVm(handle.plugin)).toHaveAttribute("data-sm-language", "zh-CN");

    // 宿主控制面义务(§4.4):未授予能力不得发送——sendThemeChanged 抛
    // EmbedCapabilityNotGrantedError,宿主事件日志呈现发送失败(会话不中断)。
    await page.getByTestId("host-mock-theme-select").selectOption("dark");
    await expect(page.getByTestId("host-mock-event-log")).toContainText("theme_changed 发送失败");
    await expect(pluginVm(handle.plugin)).toHaveAttribute("data-sm-theme", "light");

    // auto_resize 仍授予:height_changed 照常(降级只影响未授予能力;先驱动
    // 一次 iframe 内交互以出帧,环境口径见「正常握手全链路」用例内注记)。
    await pluginOpenTabButton(handle.plugin, "registers").click();
    await expect(handle.plugin.locator("sm-register-view")).toContainText("RSP");
    await expect(page.getByTestId("host-mock-event-log")).toContainText("height_changed", {
      timeout: 15_000,
    });
    // 插件侧零违规计数(未授予 theme 下 theme_changed 根本不发出——宿主义务面)。
    expect((await pluginCounters(handle.plugin))["v8-capability-violation"]).toBe(0);

    await closeEmbedSessionBestEffort(handle);
  });

  test("未授予 auto_resize → 固定高度、无 height_changed;theme 切换仍生效(§4.4)", async ({
    page,
  }) => {
    const handle = await embedViaHostMock(page, {
      grantAutoResize: false,
    });

    await expect(page.getByTestId("host-mock-granted")).toHaveText("theme, language");

    // 固定高度:高度管道未装配 → 宿主事件日志零 height_changed(等待超过
    // 正常上报时延,确认「不发送」而非「未到达」)。
    await handle.plugin.locator('[data-testid="pwn-workspace"] sm-workspace').waitFor({
      timeout: 20_000,
    });
    await page.waitForTimeout(2_000);
    expect(await hostEventLog(page)).not.toContain("height_changed");
    // iframe 高度保持宿主初始样式(未被 height_changed 事件改写)。
    await expect(page.getByTestId("host-mock-iframe")).toHaveCSS("height", "480px");

    // 已授予 theme:运行中切换照常生效(授予面与高度面互不影响)。
    await page.getByTestId("host-mock-theme-select").selectOption("dark");
    await expect(pluginVm(handle.plugin)).toHaveAttribute("data-sm-theme", "dark", {
      timeout: 10_000,
    });

    await closeEmbedSessionBestEffort(handle);
  });

  test("版本协商失败(§4.3):supportedVersions 无交集 → 宿主不可用降级 + 迟到消息不可用丢弃", async ({
    page,
  }) => {
    // 伪插件形态(静默页零脚本,esid 自 fragment 读出):由 E2E 以插件上下文
    // 发送 supportedVersions=[2] 的 hello——与宿主受理集 [1] 无交集。
    await page.route(/localhost:5174\/\?e2e=fake-plugin$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>伪插件(E2E)</title></head><body></body></html>',
      }),
    );
    const handle = await embedViaHostMock(page, {
      pluginUrl: `${PLUGIN_SITE_URL}?e2e=fake-plugin`,
      seed: false,
      waitForWorkspace: false,
      handshakeExpectation: "awaiting-hello",
    });
    const plugin = handle.plugin;
    const esid = await pluginFragmentEsid(plugin);
    expect(esid).toBe(handle.esid);

    // 无交集 hello → §4.3 失败路径:v3 计数 + 会话不可用(version-negotiation-failed)。
    await postFromPluginToHost(plugin, {
      protocolVersion: 1,
      type: "hello",
      sessionId: esid,
      seq: 1,
      payload: { supportedVersions: [2], capabilities: ["theme", "language", "auto_resize"] },
    });
    await waitForHostCounter(page, "v3-unsupported-version", 1);
    await expect(page.getByTestId("host-mock-state")).toContainText("不可用", { timeout: 10_000 });
    await expect(page.getByTestId("host-mock-state")).toContainText("version-negotiation-failed");
    // 协商版本保持未定(零 ready 返回 = 零反馈)。
    await expect(page.getByTestId("host-mock-negotiated")).toHaveText("—");

    // 不可用后迟到消息(合法版本 1 的 hello)→ unavailable-drop 计数,状态不变。
    await postFromPluginToHost(plugin, {
      protocolVersion: 1,
      type: "hello",
      sessionId: esid,
      seq: 2,
      payload: { supportedVersions: [1], capabilities: ["theme", "language", "auto_resize"] },
    });
    await waitForHostCounter(page, "unavailable-drop", 1);
    await expect(page.getByTestId("host-mock-state")).toContainText("version-negotiation-failed");
  });

  test("断线恢复嵌入侧呈现:iframe 内断线横幅 → 重连 sync-projection → revision 不回退(退出条件 6)", async ({
    page,
  }) => {
    // 注入机制沿 disconnect-recovery.spec(页面侧 routeWebSocket 以 close 1000
    // 断开 = 服务端侧空闲超时语义):本用例把注入点注册在宿主模拟页上,拦截
    // 插件 iframe(5174)直连 session-api 的认证 WSS——Playwright 页面级路由
    // 覆盖跨源帧的 WebSocket。
    let channel: WebSocketRoute | null = null;
    await page.routeWebSocket(/\/sessions\/channel$/, (ws) => {
      channel = ws;
      ws.connectToServer();
    });

    const handle = await embedViaHostMock(page);
    const plugin = handle.plugin;

    await pluginOpenTabButton(plugin, "registers").click();
    await expect(plugin.locator("sm-register-view")).toContainText("RSP");

    const revisionBefore = (await pluginMenuStatus(plugin, "revision").textContent())?.trim();
    expect(revisionBefore ?? "").toMatch(/^\d+$/);

    // 服务端侧断开(iframe 形态):断线横幅出现,明示最近一次公开投影 +
    // 零本地 VM 降级(硬门槛)。
    if (channel === null) {
      throw new Error("插件 iframe 的动作通道尚未建立,无法注入断线");
    }
    // 回调内赋值不参与本函数的控制流分析(既有 disconnect-recovery.spec 同款),
    // 运行期该处必为 WebSocketRoute。
    await (channel as WebSocketRoute).close({ code: 1000, reason: "server-side drop (e2e embed)" });
    const banner = plugin.locator("sm-workspace-menu .banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("最近一次公开投影");
    await expect(banner).toContainText("本工作区不做任何本地 VM 执行降级");

    // 重连(注入点保持透传):横幅消失、连接态 connected、sync-projection 对齐。
    let syncCalls = 0;
    await page.route(/\/sessions\/projection-sync$/, async (route) => {
      syncCalls += 1;
      await route.fallback();
    });
    await expect(banner).toHaveCount(0);
    await expect(pluginMenuStatus(plugin, "connection-status")).toHaveText("connected");
    await expect
      .poll(() => syncCalls, { message: "重连后未触发 sync-projection" })
      .toBeGreaterThanOrEqual(1);

    // revision 不回退(重连 sync 对齐同值)。
    const revisionAfter = (await pluginMenuStatus(plugin, "revision").textContent())?.trim() ?? "";
    expect(Number(revisionAfter)).toBeGreaterThanOrEqual(Number(revisionBefore ?? "0"));

    await closeEmbedSessionBestEffort(handle);
  });
});


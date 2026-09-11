/**
 * 嵌入面 E2E 帮手(WP-55):宿主模拟页(5173,vite dev + dev-server.mjs 签发
 * 代理/引导取回)× 插件文档页(5174,plugin-site-server 正式产物,CSP
 * script-src 'self')× compose 全拓扑(session-api 13000,demo-override 已登记
 * 5173 / 5174 origin)。
 *
 * 职责:
 *  - embedViaHostMock:驱动宿主模拟页完成「唯一题目上下文登记 → 签发 → 嵌入 →
 *    握手 → create_session → 工作区挂载」全链路(每用例唯一 tenant/challengeId
 *    的隔离纪律与 fixtures.ts 一致);经 create_session 201 响应捕获 sessionId
 *    供回收(插件 iframe 直连 session-api,Shell 的 #dev-status 在本形态不存在的
 *    等价替代);
 *  - 两侧违规计数读出:宿主 = host-mock-counters 表(embed-runtime
 *    ViolationCounters 快照,全键稳定);插件 = pwn-memory-vm 的
 *    violationCounters / phase / appearanceSnapshot 诊断 getter(V-12 本地面);
 *  - 伪造消息注入:宿主方向经宿主模拟页诊断面板(host-mock inject-* 控件),
 *    插件方向经同一面板的「插件 iframe」目标(host 页调
 *    iframe.contentWindow.postMessage——source === window.parent、origin 为
 *    钉住值,恰好穿过 V-1'/V-1 后由场景命中 V-5/V-6/V-7/V-8)。
 */
import { randomBytes } from "node:crypto";

import { expect, type FrameLocator, type Locator, type Page, type Response } from "@playwright/test";

import { seedChallenge } from "./compose.js";
import { e2eEnv } from "./env.js";

/** 宿主模拟页(WP-51 联调面;签发代理 + 引导取回端点由 vite 中间件承载)。 */
export const HOST_MOCK_URL = "http://localhost:5173/host-mock/";
/** 插件文档页(WP-52 正式产物;插件独立来源 origin)。 */
export const PLUGIN_SITE_URL = "http://localhost:5174/";

/** embedViaHostMock 建立后的句柄。 */
export interface EmbedSessionHandle {
  /** 宿主模拟页(iframe 宿主侧)。 */
  readonly page: Page;
  /** 插件 iframe 的 FrameLocator(Playwright 跨源帧穿透)。 */
  readonly plugin: FrameLocator;
  /** create_session 201 响应捕获的会话标识(回收用;未捕获为 null)。 */
  readonly sessionId: string | null;
  /** 本次嵌入的 esid(host-mock-esid 面板读数)。 */
  readonly esid: string;
}

export interface EmbedViaHostMockOptions {
  /** 题目上下文(缺省每用例随机;challengeId 必须每用例唯一——全局唯一键)。 */
  readonly challengeId?: string;
  readonly tenantId?: string;
  readonly userId?: string;
  /** 插件 URL(缺省正式产物 5174;可指向变体形态)。 */
  readonly pluginUrl?: string;
  /** 宿主可授予能力(§4.4 降级矩阵;缺省全部授予)。 */
  readonly grantAutoResize?: boolean;
  readonly grantTheme?: boolean;
  readonly grantLanguage?: boolean;
  /** 初始外观(随 ready.config 下发)。 */
  readonly theme?: string;
  readonly language?: string;
  /** 是否登记题目(缺省 true;超时/降级类不建会话的用例可关)。 */
  readonly seed?: boolean;
  /** 是否等待插件工作区挂载(缺省 true;插件侧降级类用例传 false)。 */
  readonly waitForWorkspace?: boolean;
  /**
   * 嵌入后等待的宿主状态(缺省 "ready";§4.5 宿主侧超时用例传 "none"——其
   * 预期终点就是「不可用(handshake-timeout)」,由用例自行断言;伪插件注入
   * 类用例传 "awaiting-hello"——在 T_handshake 窗口内注入伪造 hello)。
   */
  readonly handshakeExpectation?: "ready" | "awaiting-hello" | "none";
}

/**
 * 驱动宿主模拟页完成一次完整嵌入(登记 → 签发 → 嵌入 → 握手,按需等待工作区)。
 * 返回句柄;调用方以 closeEmbedSessionBestEffort 回收。
 */
export async function embedViaHostMock(
  page: Page,
  options: EmbedViaHostMockOptions = {},
): Promise<EmbedSessionHandle> {
  const env = e2eEnv();
  const tenantId = options.tenantId ?? `e2e-embed-${randomBytes(5).toString("hex")}`;
  const userId = options.userId ?? `e2e-user-${randomBytes(4).toString("hex")}`;
  const challengeId = options.challengeId ?? `chal-embed-${randomBytes(5).toString("hex")}`;
  if (options.seed !== false) {
    seedChallenge({ challengeId, tenantId });
  }

  // create_session 201 响应捕获(插件 iframe 直连 session-api;context 级
  // Origin 对齐路由对 iframe 请求同样生效,不影响响应体)。
  let sessionId: string | null = null;
  const onCreateResponse = (response: Response): void => {
    if (
      response.status() === 201 &&
      response.request().method() === "POST" &&
      response.url().endsWith("/sessions")
    ) {
      void response
        .json()
        .then((body: { payload?: { sessionId?: unknown } }) => {
          const value = body?.payload?.sessionId;
          if (typeof value === "string") {
            sessionId = value;
          }
        })
        .catch(() => undefined);
    }
  };
  page.on("response", onCreateResponse);

  await page.goto(HOST_MOCK_URL);
  await page.getByTestId("host-mock-plugin-url").fill(options.pluginUrl ?? PLUGIN_SITE_URL);
  await page.locator("#tenant-id").fill(tenantId);
  await page.locator("#user-id").fill(userId);
  await page.locator("#challenge-id").fill(challengeId);
  await page.locator("#challenge-version").fill(env.challengeVersion);
  // 能力授予勾选(缺省全授予;§4.4 降级矩阵按用例收紧)。
  await setCapability(page, "host-mock-cap-auto-resize", options.grantAutoResize ?? true);
  await setCapability(page, "host-mock-cap-theme", options.grantTheme ?? true);
  await setCapability(page, "host-mock-cap-language", options.grantLanguage ?? true);
  if (options.theme !== undefined) {
    await page.getByTestId("host-mock-theme-select").selectOption(options.theme);
  }
  if (options.language !== undefined) {
    await page.getByTestId("host-mock-language-select").selectOption(options.language);
  }

  await page.getByTestId("host-mock-embed-button").click();
  // 嵌入后等待的宿主状态(签名见选项注释)。
  const expectation = options.handshakeExpectation ?? "ready";
  if (expectation === "ready") {
    // 握手完成(宿主侧 V-1/V-1'/V-5/V-7 通过)。
    await expect(page.getByTestId("host-mock-state")).toContainText("ready", { timeout: 20_000 });
  } else {
    // iframe 出现 + esid 面板就位(签发成功、iframe 已挂载)。
    await page.getByTestId("host-mock-iframe").waitFor({ timeout: 20_000 });
    await expect(page.getByTestId("host-mock-esid")).not.toHaveText("—", { timeout: 20_000 });
    if (expectation === "awaiting-hello") {
      // load 事件驱动 idle → awaiting-hello(T_handshake 窗口开启)。
      await expect(page.getByTestId("host-mock-state")).toContainText("awaiting-hello", {
        timeout: 20_000,
      });
    }
  }
  const esid = (await page.getByTestId("host-mock-esid").textContent()) ?? "";

  const plugin = page.frameLocator('[data-testid="host-mock-iframe"]');
  if (options.waitForWorkspace !== false) {
    // 引导取回 → create_session → <sm-workspace> 挂载(插件侧全链路)。
    await plugin.locator('[data-testid="pwn-workspace"] sm-workspace').waitFor({ timeout: 20_000 });
    await expect(pluginMenuStatus(plugin, "connection-status")).toHaveText("connected", {
      timeout: 20_000,
    });
  }
  return { page, plugin, sessionId, esid };
}

/** 能力勾选框置位(仅在与期望不符时操作,避免多余 change 事件)。 */
async function setCapability(page: Page, testId: string, wanted: boolean): Promise<void> {
  const box = page.getByTestId(testId);
  if ((await box.isChecked()) !== wanted) {
    await box.setChecked(wanted);
  }
}

/** 尽力回收嵌入会话(close_session;Cookie 与白名单 Origin 呈递同 Shell 形态)。 */
export async function closeEmbedSessionBestEffort(handle: EmbedSessionHandle): Promise<void> {
  if (handle.sessionId === null) {
    return;
  }
  await closeEmbedSessionById(handle.page, handle.sessionId);
}

/** 按会话标识尽力 close_session(响应捕获失败时的备用:menu 无法读出时跳过)。 */
export async function closeEmbedSessionById(page: Page, sessionId: string): Promise<void> {
  const env = e2eEnv();
  const cookie = (await page.context().cookies()).find(
    (candidate) => candidate.name === "sm_session_credential",
  );
  if (cookie === undefined) {
    return;
  }
  await fetch(`${env.sessionApiOrigin}/sessions/close`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${cookie.name}=${cookie.value}`,
      origin: env.allowedOrigin,
    },
    body: JSON.stringify({
      command: "close_session",
      protocolVersion: 1,
      payload: { sessionId },
    }),
  }).catch(() => undefined);
}

/* ── 插件 iframe 内的定位帮手(与 fixtures.ts 的 Shell 锚同词汇;sm 结构契约)── */

/** 插件元素(pwn-memory-vm;诊断 getter 挂载点)。 */
export function pluginVm(plugin: FrameLocator): Locator {
  return plugin.locator("pwn-memory-vm");
}

/** 工作区菜单(FrameLocator 形态)。 */
export function pluginMenu(plugin: FrameLocator): Locator {
  return plugin.locator("sm-workspace-menu");
}

/** 菜单「打开」按钮(data-tab-type 注册表契约)。 */
export function pluginOpenTabButton(plugin: FrameLocator, tabType: string): Locator {
  return pluginMenu(plugin).locator(`button.open-tab[data-tab-type="${tabType}"]`);
}

/** 菜单动作按钮(class 契约:step-button / reset-button)。 */
export function pluginMenuButton(plugin: FrameLocator, actionClass: string): Locator {
  return pluginMenu(plugin).locator(`button.${actionClass}`);
}

/** 会话状态行(projectionStatus / revision / connectionStatus)。 */
export function pluginMenuStatus(
  plugin: FrameLocator,
  part: "session-status" | "revision" | "connection-status",
): Locator {
  return pluginMenu(plugin).locator(`.${part}`);
}

/* ── 诊断读出(宿主 / 插件两侧 V-12 本地面)───────────────────────────────── */

/**
 * 宿主侧违规计数快照(host-mock-counters 表;embed-runtime ViolationCounters
 * 快照全键稳定,未命中补 0)。
 */
export async function hostCounters(page: Page): Promise<Record<string, number>> {
  return page.getByTestId("host-mock-counters").locator("tbody tr").evaluateAll((rows) =>
    Object.fromEntries(
      rows.map((row) => {
        const cells = row.querySelectorAll("td");
        const key = cells[0]?.textContent?.trim() ?? "";
        return [key, Number(cells[1]?.textContent?.trim() ?? "0")];
      }),
    ),
  );
}

/** 插件侧违规计数快照(violationCounters 诊断 getter;协议键 + 本地高度键)。 */
export async function pluginCounters(plugin: FrameLocator): Promise<Record<string, number>> {
  return pluginVm(plugin).evaluate((element) => {
    const vm = element as { violationCounters?: Readonly<Record<string, number>> };
    return { ...(vm.violationCounters ?? {}) };
  });
}

/** 插件当前阶段(diagnostics:connecting | degraded | session-ready)。 */
export async function pluginPhase(plugin: FrameLocator): Promise<string> {
  return pluginVm(plugin).evaluate((element) => {
    const vm = element as { phase?: string };
    return vm.phase ?? "unknown";
  });
}

/** 插件外观快照(theme 三值 / resolved 二值 / language)。 */
export async function pluginAppearance(
  plugin: FrameLocator,
): Promise<{ theme: string; resolvedTheme: string; language: string }> {
  return pluginVm(plugin).evaluate((element) => {
    const vm = element as {
      appearanceSnapshot?: { theme: string; resolvedTheme: string; language: string };
    };
    const snapshot = vm.appearanceSnapshot;
    if (snapshot === undefined) {
      throw new Error("appearanceSnapshot 诊断面不可用");
    }
    return {
      theme: snapshot.theme,
      resolvedTheme: snapshot.resolvedTheme,
      language: snapshot.language,
    };
  });
}

/** 宿主事件日志文本(height_changed / 注入回执 / 不可用事件的观察面)。 */
export async function hostEventLog(page: Page): Promise<string> {
  return (await page.getByTestId("host-mock-event-log").textContent()) ?? "";
}

/* ── 伪造消息注入(诊断面板;两侧计数与零反馈断言的驱动面)───────────────── */

export type InjectTarget = "host-window" | "plugin-iframe";
export type InjectScenario =
  | "wrong-direction-ready"
  | "wrong-esid-ready"
  | "wrong-direction-hello"
  | "stale-seq-theme"
  | "ungranted-theme";

/** 经宿主模拟页诊断面板注入一条伪造 postMessage(场景语义见 host-mock/index.html)。 */
export async function injectViaPanel(
  page: Page,
  target: InjectTarget,
  scenario: InjectScenario,
): Promise<void> {
  await page.getByTestId("host-mock-inject-target").selectOption(target);
  await page.getByTestId("host-mock-inject-scenario").selectOption(scenario);
  await page.getByTestId("host-mock-inject-button").click();
}

/**
 * 从插件 iframe 上下文向宿主窗口投递任意消息(Playwright 跨源帧求值;等价
 * 「受入侵插件面」威胁模型——source === iframe.contentWindow、origin 为插件
 * 来源,恰好穿过宿主 V-1/V-1' 后命中 V-2~V-7 各规则)。
 */
export async function postFromPluginToHost(
  plugin: FrameLocator,
  message: unknown,
): Promise<void> {
  // locator.evaluate 首参 = 锚元素(忽略),信封走第二参(arg);锚定 html
  // 元素(伪插件变体页不含 pwn-memory-vm 元素,html 恒存在)。
  await plugin.locator("html").evaluate((_element, envelope) => {
    window.parent.postMessage(envelope, "*");
  }, message);
}

/** 读插件 iframe 的 location.hash(esid fragment;fake-plugin 场景自证用)。 */
export async function pluginFragmentEsid(plugin: FrameLocator): Promise<string> {
  // 锚定 html 元素(fake-plugin 变体页不含 pwn-memory-vm 元素,html 恒存在)。
  return plugin.locator("html").evaluate(() => {
    const hash = window.location.hash;
    return hash.startsWith("#esid=") ? hash.slice("#esid=".length) : "";
  });
}

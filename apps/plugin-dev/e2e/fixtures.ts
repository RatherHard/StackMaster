/**
 * E2E 测试夹具(WP-F7):真实 compose 拓扑 + plugin-dev 开发壳全链路。
 *
 * 夹具职责:
 *  - **来源对齐(CSRF 闸,D-API-17)**:浏览器经 vite 反代同源访问 /sessions,
 *    但对 POST 浏览器恒携带本页 Origin(localhost:5173),而 compose 拓扑登记
 *    的白名单为 compose/app.yaml 的开发合成来源——本夹具对发往 /sessions 的
 *    HTTP 请求改写 Origin 为拓扑登记值(生产形态中宿主来源本就登记在
 *    SESSION_API_ALLOWED_ORIGINS;此处只在测试夹具层等价模拟,不改产品代码);
 *  - **createdSession**:每用例签发唯一 embed token(scripts/issue-embed-token.mjs
 *    的服务端间路径)→ 表单填写同一题目上下文 →「创建并连接」→ 等待壳状态行
 *    确认会话已建立。
 *
 * 选择器策略(并行 WP-71 / WP-72 / WP-73 改 UI 的稳定性前提):优先稳定结构
 * 属性——表单 `input[name]`(壳源码契约)、菜单窗口入口 `data-window-type` /
 * class(vm-ui 注册表契约)、窗口面板 `data-tab-id`(窗口 id ≡ 类型键,WP-71
 * 固定窗口集)、`role` 语义化 DOM(vm-ui 硬门槛);不引入任何对文本排版的脆弱
 * 断言,不给 vm-ui 组件追加 data-testid。
 */
import { randomBytes } from "node:crypto";

import { test as base, expect, type Locator, type Page } from "@playwright/test";

import { e2eEnv } from "./helpers/env.js";
import { seedChallenge } from "./helpers/compose.js";
import { issueEmbedToken } from "../scripts/issue-embed-token.mjs";

export { expect };

/** 会话凭证 Cookie 名(冻结契约 D-API-12;与 session-api src/auth/cookie.ts 同值)。 */
const SESSION_CREDENTIAL_COOKIE_NAME = "sm_session_credential";

export interface E2EFixtures {
  /** 已建立会话的开发壳页面(create_session 201 + WSS connected)。 */
  createdSession: Page;
}

/**
 * 经开发壳表单建立会话(题目登记 → 签发唯一 embed token → 表单填写 → 提交 →
 * 确认)。供 createdSession 夹具与需要「先注册 WS 注入点、再建会话」的用例
 * 共用。
 *
 * 租户隔离:compose 拓扑的并发会话预算是真实生产行为(D-API-50,默认按租户),
 * 用例间以唯一租户 + 该租户下的幂等题目登记隔离(同一题目内容重复登记确定性
 * 拒绝并复用,与 seed 脚本同语义),互不挤占预算,残留会话也不阻塞复跑。
 *
 * @param options.registerChallenge 题目登记帮手(WP-54:descriptor.spec 传入
 *   seedFormalChallenge 以登记正式下发语料题;缺省 = 生命周期教学题 seed)。
 * @param options.path 页面路径(WP-54:正式通道传
 *   `/?descriptor=formal&challengeId=…&challengeVersion=…`)。
 * @returns 建立的 sessionId(dev-status 确认文本解析;尽力回收用)。
 */
export async function createSessionViaForm(
  page: Page,
  options: {
    readonly registerChallenge?: (ctx: { challengeId: string; tenantId: string }) => void;
    readonly path?: string;
    readonly challengeId?: string;
    readonly tenantId?: string;
  } = {},
): Promise<string | null> {
  const env = e2eEnv();
  // 1. 本用例唯一租户下登记题目(幂等;失败即环境问题,快速报错)。
  //    challenge_versions 全局唯一键 = (challenge_id, content_version),无租户
  //    维度——题目隔离必须用「每用例唯一 challengeId」表达(跨租户复用同一
  //    challengeId 会撞全局唯一键且按租户复查落空)。
  //    WP-54:challengeId / tenantId 可由用例显式给定(正式下发通道的页面
  //    路径需在 goto 前携带题目上下文)。
  const tenantId = options.tenantId ?? `e2e-${randomBytes(5).toString("hex")}`;
  const userId = `e2e-user-${randomBytes(4).toString("hex")}`;
  const challengeId = options.challengeId ?? `chal-e2e-${randomBytes(5).toString("hex")}`;
  (options.registerChallenge ?? seedChallenge)({ challengeId, tenantId });
  // 2. 服务端间签发(凭证只经环境变量;embedSessionId 每用例唯一,且与表单
  //    填写值一致——create_session 对 token claims 与 payload 做三方比对)。
  const embedSessionId = randomBytes(16).toString("base64url");
  const issued = await issueEmbedToken({
    origin: env.sessionApiOrigin,
    bearerToken: process.env["SESSION_API_HOST_BACKEND_TOKEN"] ?? "",
    tenantId,
    userId,
    challengeId,
    challengeVersion: env.challengeVersion,
    embedSessionId,
  });
  // 3. 开发壳表单填写(与 token claims 三方一致的题目上下文)→ 提交。
  await page.goto(options.path ?? "/");
  // vm-ui 产物动态加载 + 接线完成信号:组件注册发生在模块求值期,接线是
  // 其后的同一微任务链——观察到 custom element 即表单提交处理器已挂。
  await page.waitForFunction(() => customElements.get("sm-workspace") !== undefined);
  await page.locator("form.session-form input[name=\"challengeId\"]").fill(challengeId);
  await page.locator("form.session-form input[name=\"challengeVersion\"]").fill(env.challengeVersion);
  await page.locator("form.session-form input[name=\"embedSessionId\"]").fill(embedSessionId);
  await page.locator("form.session-form input[name=\"embedToken\"]").fill(issued.embedToken);
  await page.locator("form.session-form button.create-button").click();
  // 4. 壳状态行确认(会话已创建并连接;失败路径会改写为「会话创建失败」)。
  await expect(page.locator("#dev-status")).toContainText("会话已创建并连接");
  const status = await page.locator("#dev-status").textContent();
  const match = /sessionId=([^)]+)/.exec(status ?? "");
  return match === null ? null : (match[1] ?? null);
}

/**
 * 尽力关闭会话(close_session;Cookie + 白名单 Origin 呈递,与浏览器面同一
 * 契约)。失败静默——回收是卫生措施,预算由租户隔离兜底。
 */
export async function closeSessionBestEffort(page: Page, sessionId: string): Promise<void> {
  const env = e2eEnv();
  const cookie = (await page.context().cookies())
    .find((candidate) => candidate.name === SESSION_CREDENTIAL_COOKIE_NAME);
  if (cookie === undefined) {
    return;
  }
  await fetch(`${env.sessionApiOrigin}/sessions/close`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookie.value}`,
      origin: env.allowedOrigin,
    },
    body: JSON.stringify({
      command: "close_session",
      protocolVersion: 1,
      payload: { sessionId },
    }),
  }).catch(() => undefined);
}

export const test = base.extend<E2EFixtures>({
  // 每用例独立 context:安装 /sessions 的 Origin 对齐路由(CSRF 闸等价模拟)。
  context: async ({ context }, use) => {
    const env = e2eEnv();
    await context.route(/\/sessions(\/|$)/, async (route) => {
      const headers = { ...route.request().headers(), origin: env.allowedOrigin };
      await route.continue({ headers });
    });
    await use(context);
  },

  createdSession: async ({ page }, use) => {
    const sessionId = await createSessionViaForm(page);
    await use(page);
    // 会话回收(卫生措施;tenant 隔离已兜底预算)。
    if (sessionId !== null) {
      await closeSessionBestEffort(page, sessionId);
    }
  },
});

// ── 工作区定位帮手(选择器唯一登记点;vm-ui 结构契约)───────────────────────

/** 工作区菜单(窗口分组 / 运行动作 / 会话状态面)。 */
export function menu(page: Page): Locator {
  return page.locator("sm-workspace-menu");
}

/**
 * 菜单窗口入口(D-MP-1 聚焦导航;稳定键 = `data-window-type` 注册表契约)。
 * 点击 = 聚焦 + 滚动到该窗口(窗口集常驻,非开窗)。
 */
export function focusWindowButton(page: Page, windowType: string): Locator {
  return menu(page).locator(`button.focus-window[data-window-type="${windowType}"]`);
}

/** 工作区窗口面板(常驻;`data-tab-id` = 窗口 id ≡ 注册表类型键)。 */
export function workspaceWindows(page: Page): Locator {
  return page.locator("sm-workspace .tab-panel[data-tab-id]");
}

/** 指定类型的窗口面板。 */
export function workspaceWindow(page: Page, windowType: string): Locator {
  return page.locator(`sm-workspace .tab-panel[data-tab-id="${windowType}"]`);
}

/** 窗口集呈现序(data-tab-id 数组;不变量断言用)。 */
export async function workspaceWindowTypes(page: Page): Promise<string[]> {
  return page.locator("sm-workspace").evaluate((element) =>
    [...element.shadowRoot!.querySelectorAll(".tab-panel[data-tab-id]")].map(
      (panel) => panel.getAttribute("data-tab-id") ?? "",
    ),
  );
}

/** 菜单动作按钮(class 契约:step-button / reset-button)。 */
export function menuButton(page: Page, actionClass: string): Locator {
  return menu(page).locator(`button.${actionClass}`);
}

/** 会话状态行(projectionStatus / revision / connectionStatus)。 */
export function menuStatus(page: Page, part: "session-status" | "revision" | "connection-status"): Locator {
  return menu(page).locator(`.${part}`);
}

/** 断线横幅(disconnected / reconnecting 呈现;恢复即整体缺席)。 */
export function disconnectBanner(page: Page): Locator {
  return menu(page).locator(".banner");
}

/** 字节视图数据行(role=row + data-row-address;虚拟列表只渲染可视行)。 */
export function byteRows(page: Page): Locator {
  return page.locator("sm-byte-view .byte-row[data-row-address]");
}

// ── 工作区布局定位帮手(WP-72:Niri 式布局交互;选择器唯一登记点)─────────────
//
// 锚一律取**结构属性 / 语义 role**(`data-column-index` / `data-column-divider` /
// `data-row-divider` / `data-width-ratio` / `data-layout-preset` / `role=separator`),
// 不依赖文案排版与像素几何。

/** 列容器(横向条带 `.columns`;相机滚动的滚动容器)。 */
export function layoutStrip(page: Page): Locator {
  return page.locator("sm-workspace [data-columns]");
}

/** 全部列(列序锚 = `data-column-index`)。 */
export function layoutColumns(page: Page): Locator {
  return page.locator("sm-workspace .column[data-column-index]");
}

/** 指定列序的列。 */
export function layoutColumn(page: Page, columnIndex: number): Locator {
  return page.locator(`sm-workspace .column[data-column-index="${columnIndex}"]`);
}

/** 列间分隔条(`data-column-divider` = 该空隙右侧列的列序 = 新建列位插入位置)。 */
export function columnDivider(page: Page, gapIndex: number): Locator {
  return page.locator(`sm-workspace .column-divider[data-column-divider="${gapIndex}"]`);
}

/** 同列窗间分隔条(`data-row-divider` = `列序:上侧窗口序号`)。 */
export function rowDivider(page: Page, columnIndex: number, index: number): Locator {
  return page.locator(`sm-workspace .row-divider[data-row-divider="${columnIndex}:${index}"]`);
}

/** 菜单「布局」组:列宽预设档按钮(1/4、1/3、1/2、2/3、全宽)。 */
export function widthPresetButton(page: Page, ratio: string): Locator {
  return menu(page).locator(`button.width-preset[data-width-ratio="${ratio}"]`);
}

/** 菜单「布局」组:「重置布局」按钮。 */
export function resetLayoutButton(page: Page): Locator {
  return menu(page).locator("button.reset-layout-button");
}

/** 菜单「布局」组的当前档位标识(P0 / P1 / P2;布局档位唯一呈现面)。 */
export function layoutPresetBadge(page: Page): Locator {
  return menu(page).locator("[data-layout-preset] .layout-preset");
}

/** 布局状态行(常驻 `role=status`;布局变更宣读面)。 */
export function layoutStatus(page: Page): Locator {
  return page.locator("sm-workspace .layout-status");
}

/** 列分组呈现(逐列窗口类型键数组;布局断言主面)。 */
export async function layoutColumnGroups(page: Page): Promise<string[][]> {
  return page.locator("sm-workspace").evaluate((element) =>
    [...(element.shadowRoot?.querySelectorAll(".column[data-column-index]") ?? [])].map((column) =>
      [...column.querySelectorAll(".tab-panel[data-tab-id]")].map(
        (panel) => panel.getAttribute("data-tab-id") ?? "",
      ),
    ),
  );
}

/** 逐列像素宽(列宽护栏与列宽档断言的几何面)。 */
export async function layoutColumnWidthPx(page: Page): Promise<number[]> {
  return page.locator("sm-workspace .column[data-column-index]").evaluateAll((columns) =>
    columns.map((column) => column.getBoundingClientRect().width),
  );
}

/**
 * 真实鼠标拖拽:在目标元素中心按下,位移 (deltaX, deltaY) 后抬起。
 * 与组件层 `DRAG_THRESHOLD_PX`(3px)阈值语义一致——位移过阈值即进入拖拽。
 *
 * **先等相机收敛**:焦点列居中是平滑滚动动画,几何读取与鼠标按下之间若条带仍在
 * 滚动,落点会错位(拖拽失效)。收敛后再取几何。
 */
export async function dragBy(
  page: Page,
  target: Locator,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  await waitForCameraSettled(page);
  const box = await target.boundingBox();
  if (box === null) {
    throw new Error("拖拽目标无可测几何(元素未渲染?)");
  }
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 8 });
  await page.mouse.up();
  await waitForCameraSettled(page);
}

/**
 * 窗口拖拽落点(WP-72 三类落点):自 `from` 的标题栏按下,移动到 `to` 的
 * 上半 / 下半区后抬起(落点语义由组件按 clientY 判定)。同样先等相机收敛。
 */
export async function dragWindowTo(
  page: Page,
  from: Locator,
  to: Locator,
  at: "upper" | "lower",
): Promise<void> {
  await waitForCameraSettled(page);
  const fromBox = await from.locator(".tab-bar").boundingBox();
  const toBox = await to.boundingBox();
  if (fromBox === null || toBox === null) {
    throw new Error("窗口拖拽几何不可测(窗口未渲染?)");
  }
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  const targetY = at === "upper" ? toBox.y + toBox.height * 0.25 : toBox.y + toBox.height * 0.75;
  await page.mouse.move(toBox.x + toBox.width / 2, targetY, { steps: 10 });
  await page.mouse.up();
  await waitForCameraSettled(page);
}

/** 相机滚动收敛等待(平滑滚动为动画;轮询 scrollLeft 稳定)。 */
export async function waitForCameraSettled(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const before = await layoutStrip(page).evaluate((element) => element.scrollLeft);
        await page.waitForTimeout(60);
        const after = await layoutStrip(page).evaluate((element) => element.scrollLeft);
        return before === after;
      },
      { timeout: 5_000 },
    )
    .toBe(true);
}

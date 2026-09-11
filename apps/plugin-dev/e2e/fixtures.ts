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
 * 选择器策略(并行 WP-F8 改 UI 的稳定性前提):优先稳定结构属性——表单
 * `input[name]`(壳源码契约)、菜单按钮 `data-tab-type` / class(vm-ui 注册表
 * 契约)、`role` 语义化 DOM(vm-ui 硬门槛);不引入任何对文本排版的脆弱断言,
 * 不给 vm-ui 组件追加 data-testid。
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
 * @returns 建立的 sessionId(dev-status 确认文本解析;尽力回收用)。
 */
export async function createSessionViaForm(page: Page): Promise<string | null> {
  const env = e2eEnv();
  // 1. 本用例唯一租户下登记题目(幂等;失败即环境问题,快速报错)。
  //    challenge_versions 全局唯一键 = (challenge_id, content_version),无租户
  //    维度——题目隔离必须用「每用例唯一 challengeId」表达(跨租户复用同一
  //    challengeId 会撞全局唯一键且按租户复查落空)。
  const tenantId = `e2e-${randomBytes(5).toString("hex")}`;
  const userId = `e2e-user-${randomBytes(4).toString("hex")}`;
  const challengeId = `chal-e2e-${randomBytes(5).toString("hex")}`;
  seedChallenge({ challengeId, tenantId });
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
  await page.goto("/");
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

/** 工作区菜单(打开分组 / 运行动作 / 会话状态面)。 */
export function menu(page: Page): Locator {
  return page.locator("sm-workspace-menu");
}

/** 菜单「打开」按钮(稳定键 = data-tab-type 注册表契约)。 */
export function openTabButton(page: Page, tabType: string): Locator {
  return menu(page).locator(`button.open-tab[data-tab-type="${tabType}"]`);
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

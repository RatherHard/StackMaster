/**
 * 启动地址链夹具(WP-95;与 `apps/plugin-dev/e2e/fixtures.ts#createSessionViaForm`
 * **同体裁、换链路** —— 该应用已于 2026-09-19 随 WP-96 物理删除,此处只作历史对照)。
 *
 * ## 链路(旧 → 新)
 *
 * | | 旧链(plugin-dev / 已退役) | 新链(本文件) |
 * |---|---|---|
 * | 授权取得 | `POST /auth/embed-tokens`(宿主凭证)→ embed token 交给表单 | `POST /auth/launch-tickets`(宿主凭证)→ **一次性启动地址** |
 * | 浏览器入口 | 开发壳表单填 4 键 | `page.goto(launchUrl)` —— **顶层导航** |
 * | 授权落地 | `create_session` payload 带 embed token | 服务端换票 → `Set-Cookie: sm_launch_grant` → **302 到干净路径** |
 * | 就绪判据 | 壳状态行 + 工作区菜单权威连接态 | 工作区菜单权威连接态(`connection-status=connected`) |
 *
 * ## 为什么必须 `page.goto` 而不是 `fetch` / `request`
 *
 * 换票路由的闸之一是 **`Sec-Fetch-Mode: navigate`**(D-LT-2)。只有**顶层导航**才会
 * 由浏览器带上该头;`fetch` / `APIRequestContext` 发出的请求 `Sec-Fetch-Mode` 是
 * `cors` / `no-cors` ⇒ 换票必然 401,而那不是我们要验的语义。
 *
 * ## 前置(本机默认不可达;见 `apps/page-app/README.md` §5.2)
 *
 * 需要真实拓扑(compose)+ 已构建的 page-app 产物被 session-api 托管:
 *  1. `pnpm --filter @stackmaster/session-api compose:app:up`;
 *  2. `pnpm --filter @stackmaster/vm-ui build` + `pnpm --filter @stackmaster/page-app build`;
 *  3. `node apps/session-api/k6/seed-challenge.mjs`(登记题目);
 *  4. `SESSION_API_HOST_BACKEND_TOKEN` 注入测试进程。
 *
 * **本机 Docker 引擎不可达**(`dockerDesktopLinuxEngine` 管道缺失)⇒ 该链在本机
 * **不可实测**;由 `E2E_LAUNCH_CHAIN=1` 显式开启,未开启时用例 `test.skip`
 * (不伪装成通过),见 `launch-chain.spec.ts`。
 */
import { expect, type Page } from "@playwright/test";

/** 启动票据签发端点(契约常量同值;此处按字面量写入夹具,不引契约包以免跨包静态依赖)。 */
const LAUNCH_TICKET_ISSUANCE_ROUTE = "/auth/launch-tickets";
/** 票据查询参数名(D-LT-2:方案 A = URL query + 服务端立即消费 + 302 抹除)。 */
const LAUNCH_TICKET_QUERY_PARAM = "t";

/** 启动地址链的环境配置(全部走环境变量;凭证不入库、无缺省值)。 */
export interface LaunchChainEnv {
  /** session-api 直连源(签发端点的基址;**不是**页面源)。 */
  readonly sessionApiOrigin: string;
  /** 宿主凭证(**只经环境变量**;缺失即拒绝运行,不回落)。 */
  readonly hostBackendToken: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
}

/** 从环境变量解析启动地址链配置。 */
export function launchChainEnv(env: NodeJS.ProcessEnv = process.env): LaunchChainEnv {
  return {
    sessionApiOrigin: env["SESSION_API_ORIGIN"] ?? "http://127.0.0.1:13000",
    hostBackendToken: env["SESSION_API_HOST_BACKEND_TOKEN"] ?? "",
    challengeId: env["E2E_CHALLENGE_ID"] ?? "chal-stack-escape",
    challengeVersion: env["E2E_CHALLENGE_VERSION"] ?? "1.2.3",
  };
}

/** 签发结果(契约 `LaunchTicketResponse`:恰两键 `launchUrl` / `expiresAt`)。 */
export interface IssuedLaunchTicket {
  readonly launchUrl: string;
  readonly expiresAt: number;
}

/**
 * 调签发端点取一次性启动地址(宿主凭证;body **恰两键** `{challengeId, version}`)。
 *
 * 契约依据 = D-LT-1:请求体恰两键且不含身份字段(租户 / 用户由服务端派生)。
 */
export async function issueLaunchTicket(
  env: LaunchChainEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<IssuedLaunchTicket> {
  if (env.hostBackendToken === "") {
    throw new Error(
      "缺少 SESSION_API_HOST_BACKEND_TOKEN(宿主凭证只经环境变量;见 apps/page-app/README.md §5.2)",
    );
  }
  const response = await fetchImpl(`${env.sessionApiOrigin}${LAUNCH_TICKET_ISSUANCE_ROUTE}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.hostBackendToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ challengeId: env.challengeId, version: env.challengeVersion }),
  });
  expect(response.status, `签发端点应回 201(实测 ${response.status})`).toBe(201);
  const body = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort(), "签发响应体应恰两键 {expiresAt, launchUrl}").toEqual([
    "expiresAt",
    "launchUrl",
  ]);
  const launchUrl = body["launchUrl"];
  const expiresAt = body["expiresAt"];
  if (typeof launchUrl !== "string" || typeof expiresAt !== "number") {
    throw new Error("签发响应体形状不符(launchUrl / expiresAt)");
  }
  return { launchUrl, expiresAt };
}

/** 探测后端是否可达(签发端点;不可达即真实拓扑未起,用于 `test.skip` 判定)。 */
export async function launchBackendReachable(
  env: LaunchChainEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${env.sessionApiOrigin}/healthz`);
    return response.status < 500;
  } catch {
    return false;
  }
}

/**
 * 走完整启动地址链并把会话建立起来(**新链的唯一入口**;供用例共用)。
 *
 * 断言链:
 *  1. 签发响应恰两键 `{launchUrl, expiresAt}`;
 *  2. `page.goto(launchUrl)` = **顶层导航**(`Sec-Fetch-Mode: navigate` 由浏览器补);
 *  3. 换票 302 后**地址栏不含 `?t=`**(票据被服务端消费并抹除;D-LT-2 方案 A);
 *  4. 页面装配完成:`<sm-workspace>` 就位;
 *  5. 权威就绪信号 = 工作区菜单 `connection-status=connected`(**不是**壳文案 ——
 *     该文案在 `connect()` 调用后立即写入,不是就绪信号,见 D-API-152 的取证)。
 *
 * @returns 换票后的干净地址(供用例继续断言)。
 */
export async function createSessionViaLaunchAddress(page: Page): Promise<string> {
  const env = launchChainEnv();
  const issued = await issueLaunchTicket(env);
  expect(
    issued.launchUrl.includes(`?${LAUNCH_TICKET_QUERY_PARAM}=`),
    `签发的 launchUrl 应携带一次性票据查询串(实测 ${issued.launchUrl})`,
  ).toBe(true);

  await page.goto(issued.launchUrl);

  // 3. 302 已发生 ⇒ 地址栏是**干净路径**(无查询串、无票据)。
  const parked = new URL(page.url());
  expect(
    parked.search,
    `换票后地址栏不得残留查询串(实测 ${page.url()})`,
  ).toBe("");
  expect(
    parked.pathname,
    `换票后应停在干净路径 /app/c/:challengeId/:version(实测 ${parked.pathname})`,
  ).toBe(`/app/c/${encodeURIComponent(env.challengeId)}/${encodeURIComponent(env.challengeVersion)}`);

  // 4. 页面已装配(真 vm-ui 产物按 URL 加载完成后挂载)。
  await expect(page.locator("sm-workspace")).toHaveCount(1, { timeout: 20_000 });

  // 5. 权威连接态(同源 ⇒ Cookie 随升级呈递;这是「新形态下无需第三方 Cookie」的正面证据)。
  await expect(page.locator("sm-workspace-menu .connection-status")).toHaveText("connected", {
    timeout: 30_000,
  });

  return page.url();
}

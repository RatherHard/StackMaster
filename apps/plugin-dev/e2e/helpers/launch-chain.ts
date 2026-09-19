/**
 * plugin-dev 的**启动地址链**夹具(分发改版 WP-95)。
 *
 * ## 为什么在这里也有一份(而不是只留 page-app 的)
 *
 * `apps/plugin-dev` 是**退役面**(WP-96 物理删除),但在删除之前它仍是本仓库
 * **唯一带真实 compose 拓扑**的 E2E 壳。WP-95 的纪律是「能改就改成启动地址链,
 * 改不动的如实登记为随 WP-96 退役面删除消解」:
 *  - **能改的** = 只要「拿到一个已建立工作区的页面」的那类用例(布局 / 会话 / payload),
 *    其夹具换成启动地址链即可 —— 本文件承载换法;
 *  - **改不动的** = 断言 **退役面本身**的用例(宿主模拟页 iframe / 表单四键 /
 *    embed token 面 / 主题三值),它们的**被测对象已不存在** ⇒ 不得为了绿而放松断言,
 *    处置 = 随 WP-96 删除该面(逐文件登记见 `e2e/RETIRED-SURFACE.md`)。
 *
 * ## 链路(与 `apps/page-app/e2e/helpers/launch-chain.ts` 同源、同断言)
 *
 * ```
 * POST /auth/launch-tickets(Bearer = SESSION_API_HOST_BACKEND_TOKEN;body 恰两键)
 *   → { launchUrl, expiresAt }
 *   → page.goto(launchUrl)            ← **顶层导航**(Sec-Fetch-Mode: navigate)
 *   → 服务端换票:消费票据 + Set-Cookie: sm_launch_grant + 302 到干净路径
 *   → 页面装配 → 工作区菜单 connection-status=connected
 * ```
 *
 * **与 page-app 版本的一处差异(如实登记)**:plugin-dev 的开发壳页面源是
 * `http://localhost:5173`(vite dev server),而 session-api 在 `:13000` —— 两者
 * **跨源** ⇒ 换票签发的 Cookie 以 `Path=/sessions` + `SameSite` 呈递,跨源下
 * **可能不成立**(这正是遗留 #1 webkit 面的成因类)。故本夹具的换票地址取
 * `SESSION_API_PUBLIC_ORIGIN`(**服务端自托管页面**的源),即「真形态」,
 * 而不是 dev 壳源;需要 dev 壳页面的用例属退役面(见 RETIRED-SURFACE.md)。
 */
import { expect, type Page } from "@playwright/test";

/** 启动票据签发端点(契约常量同值;本文件按字面量引用,避免 e2e 静态依赖契约包)。 */
const LAUNCH_TICKET_ISSUANCE_ROUTE = "/auth/launch-tickets";

/** 启动地址链的环境视图(全部走环境变量;凭证只经环境变量)。 */
export interface PluginDevLaunchEnv {
  readonly sessionApiOrigin: string;
  readonly hostBackendToken: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
}

/** 解析启动地址链环境(缺省沿用既有 E2E 端口与题目上下文)。 */
export function pluginDevLaunchEnv(env: NodeJS.ProcessEnv = process.env): PluginDevLaunchEnv {
  return {
    sessionApiOrigin: env["SESSION_API_ORIGIN"] ?? "http://127.0.0.1:13000",
    hostBackendToken: env["SESSION_API_HOST_BACKEND_TOKEN"] ?? "",
    challengeId: env["E2E_CHALLENGE_ID"] ?? "chal-e2e-plugin-dev",
    challengeVersion: env["E2E_CHALLENGE_VERSION"] ?? "1.0.0",
  };
}

/** 后端是否可达(用于 skip 判定;不把「拓扑没起」伪装成通过)。 */
export async function pluginDevBackendReachable(
  env: PluginDevLaunchEnv = pluginDevLaunchEnv(),
): Promise<boolean> {
  try {
    const response = await fetch(`${env.sessionApiOrigin}/healthz`);
    return response.status < 500;
  } catch {
    return false;
  }
}

/**
 * 经**启动地址链**打开页面并等待工作区就绪。
 *
 * @returns 换票后的干净地址(无 `?t=`;供用例继续断言)。
 */
export async function openWorkspaceViaLaunchAddress(page: Page): Promise<string> {
  const env = pluginDevLaunchEnv();
  if (env.hostBackendToken === "") {
    throw new Error("缺少 SESSION_API_HOST_BACKEND_TOKEN(宿主凭证只经环境变量)");
  }
  const response = await fetch(`${env.sessionApiOrigin}${LAUNCH_TICKET_ISSUANCE_ROUTE}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.hostBackendToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ challengeId: env.challengeId, version: env.challengeVersion }),
  });
  expect(response.status, `签发端点应回 201(实测 ${response.status})`).toBe(201);
  const body = (await response.json()) as { launchUrl?: unknown };
  if (typeof body.launchUrl !== "string") {
    throw new Error("签发响应缺少 launchUrl");
  }
  await page.goto(body.launchUrl);
  // 换票 302 后地址栏无票据(方案 A:服务端消费并抹除)。
  expect(new URL(page.url()).search, `换票后地址栏不得残留查询串(${page.url()})`).toBe("");
  await expect(page.locator("sm-workspace")).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator("sm-workspace-menu .connection-status")).toHaveText("connected", {
    timeout: 30_000,
  });
  return page.url();
}

/**
 * 启动地址链真机 E2E(WP-95;E2E 改页面分发的那一半)。
 *
 * ## 这一半与 `page-app.spec.ts` / `geometry-guard.spec.ts` 的分工
 *
 * | spec | 后端 | 判什么 |
 * |---|---|---|
 * | `page-app.spec.ts` | 无(stub `POST /sessions`) | 页面侧行为:恰一次 `create_session`、载荷恰两键、零 401、窄屏可达 |
 * | `geometry-guard.spec.ts` | 无(同 stub) | D-UI-2 几何契约四条 × 四视口 |
 * | **本文件** | **真拓扑(compose)** | **签发 → 顶层导航 → 换票 302 抹票 → Cookie 授权 → 同源 WSS connected → 票据单次消费** |
 *
 * ## 本机不可实测的如实登记
 *
 * 本机 **Docker 引擎不可达**(`dockerDesktopLinuxEngine` 管道缺失,已多次实测)⇒
 * 真拓扑起不来 ⇒ 本文件在默认情形下 **`test.skip`**(不算通过)。
 * 前置四步与复跑命令见 `apps/page-app/README.md` §5.2;开启方式:
 *
 * ```powershell
 * # ① 拓扑(需要 Docker)
 * pnpm --filter @stackmaster/session-api compose:app:up
 * # ② 构建 vm-ui 与页面产物(session-api 从 apps/page-app/dist 托管)
 * pnpm --filter @stackmaster/vm-ui build; pnpm --filter @stackmaster/page-app build
 * # ③ 登记题目
 * node apps/session-api/k6/seed-challenge.mjs
 * # ④ 复跑本文件(显式开启;凭证只经环境变量)
 * $env:E2E_LAUNCH_CHAIN='1'
 * $env:SESSION_API_HOST_BACKEND_TOKEN='<宿主凭证>'
 * $env:SESSION_API_ORIGIN='http://127.0.0.1:13000'
 * pnpm --filter @stackmaster/page-app exec playwright test e2e/launch-chain.spec.ts
 * ```
 *
 * 若 `E2E_LAUNCH_CHAIN=1` 已设但 `/healthz` 不可达,用例体**先 skip 并打印原因**
 * (不把「环境没起来」伪装成「断言通过」)。
 */
import { expect, test } from "@playwright/test";

import {
  createSessionViaLaunchAddress,
  issueLaunchTicket,
  launchBackendReachable,
  launchChainEnv,
} from "./helpers/launch-chain.js";

/** 显式开关:`E2E_LAUNCH_CHAIN=1` 才尝试真拓扑(否则整文件 skip)。 */
const ENABLED =
  process.env["E2E_LAUNCH_CHAIN"] === "1" || process.env["E2E_LAUNCH_CHAIN"] === "true";

test.describe("启动地址链:签发 → 顶层导航 → 换票 302 → Cookie → 同源 WSS", () => {
  test.skip(
    !ENABLED,
    "未开启:需要真实拓扑(compose)+ page-app 产物托管;开启方式见本文件头与 README §5.2",
  );

  test("换票后地址栏无票据、页面同源建立会话(connection-status=connected)", async ({ page }) => {
    const env = launchChainEnv();
    if (!(await launchBackendReachable(env))) {
      test.skip(
        true,
        `session-api 不可达(${env.sessionApiOrigin})⇒ 真实拓扑未起(Docker 引擎不可达是本机已知环境事实)`,
      );
      return;
    }
    const cleanUrl = await createSessionViaLaunchAddress(page);
    expect(cleanUrl).not.toContain("?t=");
    console.log(`[launch-chain] 换票后干净地址 = ${cleanUrl}`);
  });

  test("票据单次消费:同一张票二次打开 = 401(统一形态,不重试)", async ({ page }) => {
    const env = launchChainEnv();
    if (!(await launchBackendReachable(env))) {
      test.skip(true, `session-api 不可达(${env.sessionApiOrigin})⇒ 真实拓扑未起`);
      return;
    }
    const issued = await issueLaunchTicket(env);
    // 第一次导航 = 消费成功(302 → 干净页面)。
    await page.goto(issued.launchUrl);
    expect(new URL(page.url()).search).toBe("");
    // 第二次导航 = 票据已被消费 ⇒ **401 统一形态**(不建会话、不重定向到页面)。
    const replay = await page.goto(issued.launchUrl);
    expect(replay?.status(), "同一张票二次消费应回 401").toBe(401);
  });
});

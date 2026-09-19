/**
 * page-app 真机冒烟配置(分发改版 WP-92)。
 *
 * ## 拓扑(本机可跑;不需要 Docker)
 *
 * ```
 * chromium → vite preview(localhost:5190,托管**已构建**的 dist/)
 *              └─ /vm-ui/index.js  ← 构建期从 packages/vm-ui/dist 拷入的真实产物
 *              └─ /sessions        ← 由 Playwright route 拦截并返回**契约合法**的
 *                                     create_session 应答(不连后端)
 * ```
 *
 * 本机 Docker 不可用(`dockerDesktopLinuxEngine` 管道缺失,已多次实测)⇒
 * session-api 的 compose 拓扑起不来 ⇒ **不连真后端**。因此本文件断言的是
 * 「页面 + 真 vm-ui 产物」这一半,以及"页面发出的请求恰好是它该发的那一个";
 * 换票 → Cookie → 建会话的**服务端**链路由
 * `apps/session-api/test/launch/static-hosting.test.ts`(in-process 装配)与
 * WP-95 的端到端冒烟承担(命令见 `README.md`)。
 *
 * 关键点:页面必须**恰发一次** `POST /sessions`,且**不发**任何 401 相关请求
 * —— 这正是"浏览器侧不做授权判断、失败不重试"的可观测形态。
 *
 * 复跑:`pnpm --filter @stackmaster/page-app test:e2e`(会先 `pnpm run build`)。
 */
import { defineConfig, devices } from "@playwright/test";

const ci = process.env["CI"] === "1" || process.env["CI"] === "true";

/** 预览端口(与 dev server 5180 区分:预览跑的是**构建产物**)。 */
export const PREVIEW_PORT = 5190;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // 产物落 .tmp/(根 .gitignore 已覆盖),不进 git。
  outputDir: ".tmp/playwright-artifacts",
  reporter: [["list"]],
  use: {
    // 用 `localhost` 而非 `127.0.0.1`:vite 的 dev / preview server 缺省只绑
    // `localhost`(本机实测 `127.0.0.1` 连不上),写死域名可免于平台解析差异。
    baseURL: `http://localhost:${PREVIEW_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    // **已构建产物**的静态托管 —— 与生产形态(session-api 托管 dist)同构,
    // 只是换了个静态服务器。
    command: `pnpm exec vite preview --port ${PREVIEW_PORT} --strictPort`,
    url: `http://localhost:${PREVIEW_PORT}/`,
    reuseExistingServer: true,
    timeout: 60_000,
    // 关掉开发态反代:本冒烟**不连后端**(本机 Docker 不可用),`/app/**`
    // 必须由静态托管回落到 `index.html`(SPA 形态),否则请求会打到不存在的
    // session-api 并得到 502(实测踩过)。
    env: { SESSION_API_PROXY: "off" },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

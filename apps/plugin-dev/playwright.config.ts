/**
 * Playwright 配置(WP-F7 最小集;plugin-dev 壳内,真实 compose 拓扑全链路)。
 *
 * 拓扑:chromium → vite dev server(localhost:5173,webServer 拉起)→
 * /sessions 反代 → compose 全拓扑(session-api 13000;由 e2e/global-setup.ts
 * 拉起并登记题目,teardown 收尾——外部托管时自动跳过,见 helpers/compose.ts)。
 *
 * 前置:`pnpm build`(vm-ui dist 供壳加载;session-api dist 供 seed 脚本)+
 * 环境变量 SESSION_API_HOST_BACKEND_TOKEN(compose dev 合成值,只走环境变量)。
 * 复跑:`pnpm --filter @stackmaster/plugin-dev test:e2e`(保留拓扑调试:
 * E2E_KEEP_COMPOSE=1;假设拓扑已在跑:E2E_SKIP_COMPOSE=1)。
 */
import { defineConfig, devices } from "@playwright/test";

/** CI 形态:禁 only、失败重跑一次;本地零重试(暴露不稳定而非掩盖)。 */
const ci = process.env["CI"] === "1" || process.env["CI"] === "true";

export default defineConfig({
  testDir: "./e2e",
  // 真实后端共享单拓扑(会话并发预算 D-API-50):串行执行最稳,不做用例并行。
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  // 全局 30 分钟上限(compose 冷构建 + 全链路;正常增量运行远低于此)。
  globalTimeout: 30 * 60_000,
  timeout: 60_000,
  expect: {
    // create_session / 重连 sync 涉及 worker spawn 与真实网络,放宽到 15s。
    timeout: 15_000,
  },
  // 产物落 .tmp/(仓库 .gitignore 已覆盖),不进 git。
  outputDir: ".tmp/playwright-artifacts",
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    // 单个定位器动作上限(与 expect.timeout 对齐;避免缺陷红灯烧满用例超时)。
    actionTimeout: 15_000,
  },
  webServer: {
    // vite dev server(E2E 专用配置:在 vite.config.ts 之上叠加 vm-ui dist 的
    // ?import 重定向——Vite 8 拒绝 publicDir 文件的模块化请求,见该文件头)。
    command: "pnpm exec vite --config e2e/vite.e2e.config.ts --strictPort",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

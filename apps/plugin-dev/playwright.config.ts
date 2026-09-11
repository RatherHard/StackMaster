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
/**
 * 13.4 浏览器矩阵形态(WP-55):`E2E_MATRIX=1` 时追加 firefox / webkit 项目
 * (chromium 恒在)。默认(全量门禁)只跑 chromium——既有 9 用例与嵌入面 /
 * axe spec 不随矩阵三倍膨胀;矩阵复跑命令见 e2e/browser-matrix.spec.ts 文件头。
 */
const matrix = process.env["E2E_MATRIX"] === "1";

export default defineConfig({
  testDir: "./e2e",
  // 真实后端共享单拓扑(会话并发预算 D-API-50):串行执行最稳,不做用例并行。
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  // 全局上限(compose 冷构建 + 全链路;正常增量运行远低于此;矩阵形态追加
  // firefox / webkit 的 18 格 × 会话链路,上限放宽)。
  globalTimeout: matrix ? 75 * 60_000 : 30 * 60_000,
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
  webServer: [
    {
      // vite dev server(E2E 专用配置:在 vite.config.ts 之上叠加 vm-ui dist 的
      // ?import 重定向——Vite 8 拒绝 publicDir 文件的模块化请求,见该文件头)。
      // 引导取回端点白名单含 5175(非根路径部署形态的插件 origin)。
      command: "pnpm exec vite --config e2e/vite.e2e.config.ts --strictPort",
      url: "http://localhost:5173",
      reuseExistingServer: true,
      timeout: 120_000,
      env: { PLUGIN_SITE_ORIGIN: "http://localhost:5174,http://localhost:5175" },
    },
    {
      // 插件文档页站点(WP-52 demo 拓扑:插件独立来源 origin = 5174;嵌入面
      // E2E 的 iframe src 目标页,CSP script-src 'self' 由该服务器注入)。
      command: "pnpm exec node host-mock/plugin-site-server.mjs",
      url: "http://localhost:5174/",
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      // 非根路径部署形态(WP-55 13.4):同一静态服务器以子路径前缀拉起于 5175,
      // 证明自包含产物「整目录拷贝部署于任意路径前缀」的真实可达性(CLI 参数
      // 形态,跨平台无 shell env 依赖)。
      command:
        "node host-mock/plugin-site-server.mjs --port 5175 --base-path /e2e/sub/path",
      url: "http://localhost:5175/e2e/sub/path/",
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    ...(matrix
      ? [
          { name: "firefox", use: { ...devices["Desktop Firefox"] } },
          { name: "webkit", use: { ...devices["Desktop Safari"] } },
        ]
      : []),
  ],
});

/**
 * 嵌入链路脚本冒烟(WP-52;真实浏览器,非 jsdom——Playwright 归属 WP-55,
 * 本脚本只是联调冒烟驱动,不落 @playwright/test 用例)。
 *
 * 前置(三终端):
 *   1. compose 拓扑:`pnpm --filter @stackmaster/session-api compose:app:up`
 *      (demo-override 已增补 5174 进 ALLOWED_ORIGINS;如栈在跑需以更新后的
 *      override 重建:`docker compose -p session-api-app -f deps.yaml -f app.yaml
 *      -f demo-override.yaml up -d`,工作目录 apps/session-api/compose);
 *   2. 宿主模拟页(含签发代理 + 引导取回端点):
 *      `SESSION_API_HOST_BACKEND_TOKEN=host-backend-shared-credential-0123456789 \
 *       pnpm --filter @stackmaster/plugin-dev dev`
 *      (端口 5173;注意清掉占用 5173/5174 的旧 vite 实例,否则引号端点/插件页
 *      会被错误的服务器应答);
 *   3. 插件文档页站点:`pnpm --filter @stackmaster/plugin-dev dev:plugin-site`
 *      (需先 `pnpm --filter @stackmaster/web-component build`)。
 *
 * 运行:`node host-mock/smoke-embed.mjs`(在 apps/plugin-dev 下)。
 *
 * 断言链:签发并嵌入 → hello → ready(宿主面板状态)→ 插件页跨源取回引导配置
 * → create_session(三方比对)→ 工作区挂载(sm-workspace)→ height_changed
 * (宿主事件日志)→ theme_changed 经 postMessage 生效(iframe 内 data-sm-theme)
 * → 全链路零违规计数。退出码 0 = 全链路绿;任何一步超时/断言失败 = 非零。
 */
import { chromium } from "@playwright/test";

const HOST_MOCK_URL = "http://localhost:5173/host-mock/";
const STEP_TIMEOUT_MS = 20_000;

/* 本脚本在 Node 侧驱动 Playwright;下方回调内出现的 window / document 运行于
 * 浏览器上下文(page.waitForFunction / page.evaluate 的序列化函数)。 */

/** 分步输出(冒烟报告面)。 */
function step(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[smoke] ${mark} ${name}${detail === "" ? "" : ` —— ${detail}`}`);
  if (!ok) process.exitCode = 1;
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(HOST_MOCK_URL, { waitUntil: "load" });

  // 1. 签发并嵌入(宿主模拟页 → vite 代理签发 → embed-runtime 建 iframe)。
  await page.getByTestId("host-mock-embed-button").click();

  // 2. 握手完成(宿主面板状态 = ready;embed-runtime 消费 hello 后回 ready)。
  await page.waitForFunction(
    () => document.querySelector('[data-testid="host-mock-state"]')?.textContent?.includes("ready"),
    null,
    { timeout: STEP_TIMEOUT_MS },
  );
  step("hello → ready 握手完成(宿主侧 V-1/V-1'/V-5/V-7 通过)", true);

  // 3. 插件页(独立来源插件文档页)完成引导取回 + create_session + 工作区挂载。
  const plugin = page.frameLocator('[data-testid="host-mock-iframe"]');
  await plugin.locator('[data-testid="pwn-workspace"] sm-workspace').waitFor({ timeout: STEP_TIMEOUT_MS });
  step("引导取回 → create_session → <sm-workspace> 挂载(token 三方比对消费)", true);

  // 4. 外观接线位就绪(ready.config 应用;data-sm-* attribute)。
  const appearance = await plugin
    .locator("pwn-memory-vm")
    .evaluate((el) => ({ theme: el.getAttribute("data-sm-theme"), language: el.getAttribute("data-sm-language") }));
  step(
    "ready.config 主题 / 语言接线位落地",
    appearance.theme !== null && appearance.language !== null,
    `data-sm-theme=${appearance.theme} data-sm-language=${appearance.language}`,
  );

  // 5. height_changed 上报(iframe 内容高度 → 宿主事件日志)。
  // 环境口径(WP-55):Playwright/Chromium 对跨源 iframe 按需出帧,rAF 合流
  // 管道首帧排队——先在 iframe 内驱动一次交互(打开寄存器视图)出帧释放。
  await plugin.locator('button.open-tab[data-tab-type="registers"]').click();
  await plugin.locator("sm-register-view").waitFor({ timeout: STEP_TIMEOUT_MS });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="host-mock-event-log"]')?.textContent?.includes("height_changed"),
    null,
    { timeout: STEP_TIMEOUT_MS },
  );
  step("height_changed 上报(auto_resize 授予;rAF 合流管道)", true);

  // 6. 运行中主题切换(宿主 → 插件;插件接线位落地 data-sm-theme)。
  await page.getByTestId("host-mock-theme-select").selectOption("dark");
  await plugin.locator("pwn-memory-vm[data-sm-theme='dark']").waitFor({ timeout: STEP_TIMEOUT_MS });
  step("theme_changed → 插件主题接线生效(V-8 授予面;V-11 钉住 origin)", true);

  // 7. 宿主面板违规计数零(V-12:全链路零校验失败)。
  const countersText = await page.evaluate(
    () => document.querySelector('[data-testid="host-mock-counters"]')?.textContent ?? "",
  );
  const nonZero = [...countersText.matchAll(/\b(v\d[^:\s]*|state-[^:\s]*|unavailable-[^:\s]*)\D+(\d+)/g)]
    .map((m) => [m[1], Number(m[2])])
    .filter(([, n]) => n > 0);
  step("全链路零违规计数(V-12 本地面清零)", nonZero.length === 0, JSON.stringify(nonZero));
} catch (error) {
  step(`冒烟中断:${error instanceof Error ? error.message.split("\n")[0] : String(error)}`, false);
  process.exitCode = 1;
} finally {
  await browser.close();
}

/**
 * WP-55 E2E:13.4 浏览器矩阵(六宽度 × 三浏览器 + 主题切换 / 键盘操作 /
 * reduced-motion / 高对比度 / 非根路径部署 / 受限 CSP)。
 *
 * 运行形态(矩阵专用,不进默认全量套件——chromium 全量由其余 spec 承载):
 *   前置:pnpm exec playwright install firefox webkit(不可达项如实登记)
 *   E2E_MATRIX=1 pnpm --filter @stackmaster/plugin-dev exec playwright test e2e/browser-matrix.spec.ts
 *
 * 矩阵格 = 六宽度(320/375/768/1024/1440/1920)× {chromium, firefox, webkit}
 * × 两面(嵌入面[宿主模拟页 × 插件 iframe]、plugin-dev 壳面),每格最小核心
 * 断言(维度齐全优先,用例不膨胀):
 *   ① 投影渲染可达(寄存器视图非虚拟化路径;虚拟列表字节行的真实浏览器渲染
 *     受 lit-virtualizer 已知缺陷影响,见 session.spec.ts 文件头登记——矩阵格
 *     以栈视图区域选择器可达 + 寄存器行渲染为投影证据,字节行断言沿该登记);
 *   ② 无横向溢出破版(宿主页与插件 iframe 文档 scrollWidth ≤ innerWidth);
 *   ③ 核心交互可达(step 动作 → revision 前进)。
 *
 * 附加维度(chromium 口径格;主题/键盘/reduced-motion/高对比度为浏览器能力
 * 仿真,不随三浏览器重复):主题切换(dark 双面可达)、键盘操作(Tab 序 +
 * Enter 激活核心动作)、reduced-motion(emulateMedia)、高对比度(forcedColors
 * 仿真 + 断言无破版;Windows 高对比度真机抽样登记于决策草稿)、非根路径部署
 * (plugin-site-server --base-path 形态拉起于 5175 子路径)、受限 CSP(插件页
 * script-src 'self' 响应头在场 + 全格功能不受限)。
 *
 * 屏幕阅读器抽样:自动化不可替代,人工抽样项(对象 / 步骤 / 判定标准)登记于
 * `docs/develop/阶段五WP55决策草稿.md`(沿 axe color-contrast 遗留登记先例)。
 */
import { expect, type FrameLocator, type Page } from "@playwright/test";

import {
  closeEmbedSessionBestEffort,
  embedViaHostMock,
  PLUGIN_SITE_URL,
  pluginMenuButton,
  pluginMenuStatus,
  pluginOpenTabButton,
  pluginVm,
} from "./helpers/embed.js";
import { menuButton, menuStatus, test } from "./fixtures.js";

const matrixEnabled = process.env["E2E_MATRIX"] === "1";
const WIDTHS = [320, 375, 768, 1024, 1440, 1920] as const;

/** 非根路径部署形态的插件 URL(5175 子路径;playwright webServer 拉起)。 */
const PLUGIN_SUBPATH_URL = "http://localhost:5175/e2e/sub/path/";

/** 宿主页无横向溢出(破版断言;+1px 容差吸收亚像素舍入)。 */
async function hostPageNoHorizontalOverflow(page: Page): Promise<void> {
  const scrollWidth = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(scrollWidth, "宿主页出现横向溢出破版").toBeLessThanOrEqual(1);
}

/** 插件 iframe 文档无横向溢出。 */
async function pluginNoHorizontalOverflow(plugin: FrameLocator): Promise<void> {
  const scrollWidth = await plugin
    .locator("html")
    .evaluate((element) => (element.ownerDocument.defaultView?.innerWidth ?? 0) - element.scrollWidth);
  expect(scrollWidth, "插件 iframe 出现横向溢出破版").toBeGreaterThanOrEqual(-1);
}

/** 核心交互:step 动作经认证 WSS → revision 前进(嵌入面)。 */
async function pluginStepAdvancesRevision(plugin: FrameLocator): Promise<void> {
  const before = Number((await pluginMenuStatus(plugin, "revision").textContent())?.trim() ?? "0");
  await pluginMenuButton(plugin, "step-button").click();
  await expect(pluginMenuStatus(plugin, "revision")).toHaveText(String(before + 1));
}

test.describe("13.4 浏览器矩阵(六宽度 × 三浏览器;E2E_MATRIX=1 复跑)", () => {
  test.skip(!matrixEnabled, "矩阵形态专用:以 E2E_MATRIX=1 复跑(见文件头命令)");

  for (const width of WIDTHS) {
    test.describe(`宽度 ${width}px`, () => {
      test.use({ viewport: { width, height: 1024 } });

      test(`嵌入面:投影可达 / 无横向溢出 / 核心交互可达 / 受限 CSP 头在场`, async ({
        page,
      }) => {
        // 受限 CSP 自证:插件文档页 script-src 'self' 响应头在场,本格全功能
        // 在该 CSP 下运行(非根路径与非默认宽度不影响 CSP 形态)。
        const csp = (await page.request.get(PLUGIN_SITE_URL)).headers()[
          "content-security-policy"
        ];
        expect(csp).toContain("script-src 'self'");

        const handle = await embedViaHostMock(page);

        // ① 投影渲染可达:寄存器视图行(非虚拟化路径)+ 栈视图区域选择器
        //    (虚拟列表面;字节行断言沿 lit-virtualizer 已知缺陷登记)。
        await pluginOpenTabButton(handle.plugin, "registers").click();
        await expect(handle.plugin.locator("sm-register-view")).toContainText("RSP");
        const registerRows = handle.plugin.locator(
          'sm-register-view [role="row"], sm-register-view tbody tr',
        );
        await expect(registerRows.first()).toBeVisible();
        await pluginOpenTabButton(handle.plugin, "stack").click();
        await expect(handle.plugin.locator("sm-byte-view .region-select")).toBeVisible();

        // ② 无横向溢出破版(宿主 + iframe 双文档)。
        await hostPageNoHorizontalOverflow(page);
        await pluginNoHorizontalOverflow(handle.plugin);

        // ③ 核心交互可达。
        await pluginOpenTabButton(handle.plugin, "registers").click();
        await pluginStepAdvancesRevision(handle.plugin);

        await closeEmbedSessionBestEffort(handle);
      });

      test(`壳面(plugin-dev 表单 + 工作区):投影可达 / 无横向溢出 / 核心交互可达`, async ({
        createdSession,
      }) => {
        const page = createdSession;

        await page.locator('button.open-tab[data-tab-type="registers"]').click();
        await expect(page.locator("sm-register-view")).toContainText("RSP");
        const registerRows = page.locator(
          'sm-register-view [role="row"], sm-register-view tbody tr',
        );
        await expect(registerRows.first()).toBeVisible();

        const scrollDiff = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(scrollDiff, "壳面出现横向溢出破版").toBeLessThanOrEqual(1);

        const before = Number((await menuStatus(page, "revision").textContent())?.trim() ?? "0");
        await menuButton(page, "step-button").click();
        await expect(menuStatus(page, "revision")).toHaveText(String(before + 1));
      });
    });
  }

  test.describe("附加维度(chromium 口径格)", () => {
    test.skip(({ browserName }) => browserName !== "chromium", "附加维度为 chromium 口径格");
    test.use({ viewport: { width: 1024, height: 1024 } });

    test("主题切换:dark 下嵌入面双文档可达且无破版", async ({ page }) => {
      const handle = await embedViaHostMock(page);
      await page.getByTestId("host-mock-theme-select").selectOption("dark");
      await expect(pluginVm(handle.plugin)).toHaveAttribute("data-sm-theme", "dark");
      // 级联生效:dark 变量计算值(WP-53 变量表)。
      await expect
        .poll(() =>
          pluginVm(handle.plugin).evaluate(
            (element) => getComputedStyle(element).getPropertyValue("--sm-border").trim(),
          ),
        )
        .toBe("rgb(255 255 255 / 22%)");
      await pluginOpenTabButton(handle.plugin, "registers").click();
      await expect(handle.plugin.locator("sm-register-view")).toContainText("RSP");
      await hostPageNoHorizontalOverflow(page);
      await pluginNoHorizontalOverflow(handle.plugin);
      await pluginStepAdvancesRevision(handle.plugin);
      await closeEmbedSessionBestEffort(handle);
    });

    test("键盘操作:Tab 序可达核心动作,Enter 激活 step(revision 前进)", async ({ page }) => {
      const handle = await embedViaHostMock(page);
      await pluginOpenTabButton(handle.plugin, "registers").click();
      // 焦点落入 iframe 内(点击建立焦点),随后纯键盘导航:Tab 巡航至
      // step-button(预算 = 菜单动作组 + 打开组全量按钮数,循环回绕可达 =
      // 焦点序未被困);Enter 激活。
      await pluginOpenTabButton(handle.plugin, "registers").focus();
      const visited: string[] = [];
      let reached = false;
      for (let tabIndex = 0; tabIndex < 16 && !reached; tabIndex += 1) {
        await page.keyboard.press("Tab");
        const marker = await handle.plugin.locator("html").evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          const shadowPath: string[] = [];
          // 穿 shadow 边界收集 activeElement 的类名(菜单位于嵌套 shadow 内)。
          let node = active;
          while (node !== null) {
            shadowPath.push(`${node.tagName?.toLowerCase() ?? "?"}.${String(node.className ?? "")}`);
            node = (node.shadowRoot?.activeElement as HTMLElement | null) ?? null;
          }
          return shadowPath.join(" > ");
        });
        visited.push(marker);
        reached = marker.includes("step-button");
      }
      const focusTrail = visited.join(" | ");
      expect(reached, "Tab 序未在 16 步内到达 step 动作按钮;焦点序列: " + focusTrail).toBe(true);
      // Enter 激活焦点按钮(动作经认证 WSS 回流 → revision 前进;可重试断言)。
      const before = Number(
        (await pluginMenuStatus(handle.plugin, "revision").textContent())?.trim() ?? "0",
      );
      await page.keyboard.press("Enter");
      await expect(pluginMenuStatus(handle.plugin, "revision")).toHaveText(String(before + 1), {
        timeout: 15_000,
      });
      await closeEmbedSessionBestEffort(handle);
    });

    test("reduced-motion:emulateMedia reduce 下嵌入面功能完整", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const handle = await embedViaHostMock(page);
      await pluginOpenTabButton(handle.plugin, "registers").click();
      await expect(handle.plugin.locator("sm-register-view")).toContainText("RSP");
      await pluginStepAdvancesRevision(handle.plugin);
      await hostPageNoHorizontalOverflow(page);
      await closeEmbedSessionBestEffort(handle);
    });

    test("高对比度:forcedColors active 下嵌入面无破版、核心交互可达", async ({ page }) => {
      await page.emulateMedia({ forcedColors: "active" });
      const handle = await embedViaHostMock(page);
      await pluginOpenTabButton(handle.plugin, "registers").click();
      await expect(handle.plugin.locator("sm-register-view")).toContainText("RSP");
      await expect(handle.plugin.locator("sm-register-view")).toContainText("0x7FFFF008");
      await hostPageNoHorizontalOverflow(page);
      await pluginNoHorizontalOverflow(handle.plugin);
      await pluginStepAdvancesRevision(handle.plugin);
      await closeEmbedSessionBestEffort(handle);
    });

    test("非根路径部署:5175 子路径形态插件页完整嵌入链路", async ({ page }) => {
      const handle = await embedViaHostMock(page, { pluginUrl: PLUGIN_SUBPATH_URL });

      // 插件 iframe 确以子路径 URL 承载(整目录拷贝部署语义)。
      const frameUrl = handle.page
        .frames()
        .find((candidate) => candidate.url().startsWith("http://localhost:5175"))
        ?.url();
      expect(frameUrl?.startsWith(`${PLUGIN_SUBPATH_URL}#esid=`)).toBe(true);

      await expect(handle.plugin.locator('[data-testid="pwn-workspace"] sm-workspace')).toBeVisible();
      await pluginOpenTabButton(handle.plugin, "registers").click();
      await expect(handle.plugin.locator("sm-register-view")).toContainText("RSP");
      await pluginStepAdvancesRevision(handle.plugin);
      await hostPageNoHorizontalOverflow(page);
      await closeEmbedSessionBestEffort(handle);
    });
  });
});

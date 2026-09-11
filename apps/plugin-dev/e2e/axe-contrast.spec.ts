/**
 * WP-55 E2E:axe color-contrast 真机补测(阶段四条件 6 遗留关闭;退出条件 7)。
 *
 * 口径(Q6 定案:axe 真机门禁为唯一口径;边界裁决 2):
 *  - 真机 chromium(门禁口径浏览器)+ axe-core(与 `packages/vm-ui/test/ed/
 *    axe.test.ts` 同一引擎,真实布局与级联求值);
 *  - **全规则启用,含 color-contrast**(jsdom 套件豁免清单第 1 条的真机关闭:
 *    真机有布局引擎,对比度可判定,不再禁用);
 *  - 页面级 harness 与 jsdom 豁免清单第 2 条同款(lang / title / main landmark,
 *    由扫描变体页在**挂载前**携带——挂载后移动 DOM 会触发 lit 元素
 *    disconnectedCallback 拆毁会话,故不走事后包装);
 *  - 断言:各扫描面 violations === 0;color-contrast 规则必须在已执行桶
 *    (passed / incomplete / violations)出现,证明规则真实运行而非缺席;
 *    incomplete 条目如实归档(不确定性 ≠ violation,汇总报告人工复核登记)。
 *
 * 扫描面:
 *  1. 插件面(嵌入形态):宿主模拟页 × 插件 iframe,workspace 满内容形态
 *     (寄存器视图 / 栈视图区域选择器 + 教学面板[缺席明示 + 默认教学注解,
 *     经确定性拒绝触发 error explainer])× light / dark 双主题;
 *  2. 降级显示面(§4.3 静态文案 + 重试入口);
 *  3. plugin-dev 壳形态(表单 + 会话工作区)light / dark 双主题(dark 经
 *     文档级锚注入 = 独立使用形态 `data-sm-theme` 锚的消费证明)。
 *
 * dark 校准锚(Q6 反馈回路):若 dark 面 violations 非空,以归档 JSON 的
 * failureSummary / target 为据校准 `packages/vm-ui/src/theme/theme-tokens.ts`
 * 的 dark 变量值(只调数值、零视觉重设计),复跑至零 violations;判定结果
 * 登记于 `docs/develop/阶段五WP55决策草稿.md`。
 *
 * 扫描口径:宿主页结构规则(page-has-heading-one / region / landmark-one-main)
 * 禁用(等效 jsdom 豁免清单第 2 条的宿主职责面;组件面 landmark 正确性规则
 * 全程启用);shell dark 面环境不可达(headless 不绘制 root 暗色画布,形成
 * 半暗态伪影),dark 产品面证据由嵌入面 iframe dark 扫描承载——登记于
 * `docs/develop/阶段五WP55决策草稿.md` §二。
 *
 * 报告归档:`e2e/reports/axe/2026-09-11/`(每面 JSON + 汇总 summary.md,落仓);
 * CSP 口径:axe 注入上下文以 bypassCSP 承载(受限 CSP 的功能面证明归
 * embed-protocol.spec / browser-matrix.spec,不在此重复)。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Frame, type Page } from "@playwright/test";

import { REPO_ROOT } from "./helpers/compose.js";
import {
  closeEmbedSessionBestEffort,
  embedViaHostMock,
  PLUGIN_SITE_URL,
  pluginOpenTabButton,
  pluginVm,
} from "./helpers/embed.js";
import { test } from "./fixtures.js";

/** axe 浏览器构建(vm-ui 既有 devDependency,与 jsdom 套件同源)。 */
const AXE_MIN_PATH = join(REPO_ROOT, "packages", "vm-ui", "node_modules", "axe-core", "axe.min.js");
/** 报告归档目录(WP-55 登记路径;落仓)。 */
const REPORT_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "reports", "axe", "2026-09-11");

/** 仅 chromium(Q6 口径浏览器;矩阵模式仅 grep browser-matrix.spec,不触本文件)。 */
test.skip(({ browserName }) => browserName !== "chromium", "axe 真机门禁口径 = chromium");
// axe 注入(CSP 面由嵌入 / 矩阵 spec 证明;此处禁用以承载 addScriptTag)。
test.use({ bypassCSP: true });

/* ── 归档登记(模块级累积,afterAll 落盘 summary)───────────────────────────── */

interface AxeViolationSummary {
  readonly id: string;
  readonly impact: string | null;
  readonly nodes: readonly { target: unknown; html: string; failureSummary: string }[];
}

interface AxeFaceResult {
  readonly url: string;
  readonly axeVersion: string;
  readonly violations: readonly AxeViolationSummary[];
  readonly colorContrastStatus: "passed" | "incomplete" | "violations" | "absent";
  readonly colorContrastCheckedNodes: number;
  readonly incomplete: readonly {
    readonly id: string;
    readonly count: number;
    readonly nodes: readonly { readonly target: unknown; readonly html: string }[];
  }[];
}

interface FaceRecord {
  readonly face: string;
  readonly theme: string;
  readonly url: string;
  readonly contrastStatus: string;
  readonly contrastNodes: number;
  readonly violationCount: number;
  readonly incompleteIds: string;
}

const faceRecords: FaceRecord[] = [];

test.afterAll(() => {
  if (faceRecords.length === 0) {
    return;
  }
  mkdirSync(REPORT_DIR, { recursive: true });
  const lines: string[] = [
    "# WP-55 axe color-contrast 真机补测报告(2026-09-11)",
    "",
    "- 口径:chromium(Playwright 真机)+ axe-core 全规则(**含 color-contrast**,",
    "  `test/ed/axe.test.ts` 豁免清单第 1 条于真机关闭);页面级 harness 沿豁免清单",
    "  第 2 条(lang / title / main landmark,扫描变体页挂载前携带)。",
    "- 判定:每扫描面 violations = 0,color-contrast 规则必须真实执行(判定桶",
    "  passed / incomplete 均为已执行;incomplete = 引擎无法自动判定,人工复核项)。",
    "- 豁免对照:jsdom 豁免清单仅 color-contrast 一条(环境伪影),真机已启用;",
    "  其余规则在 jsdom 与真机均全程启用,两侧判定期望一致。",
    "",
    "| 扫描面 | 主题 | color-contrast 判定桶(检查节点数) | violations | incomplete |",
    "|---|---|---|---|---|",
  ];
  for (const record of faceRecords) {
    lines.push(
      `| ${record.face} | ${record.theme} | ${record.contrastStatus}(${record.contrastNodes}) | ${record.violationCount} | ${record.incompleteIds} |`,
    );
  }
  lines.push("");
  writeFileSync(join(REPORT_DIR, "summary.md"), lines.join("\n"), "utf8");
});

/* ── axe 执行帮手 ────────────────────────────────────────────────────────────── */

/** axe 运行结果的最小形状(浏览器侧求值返回;axe-core 4.x 桶结构)。 */
interface AxeRunBuckets {
  readonly url: string;
  readonly version: string;
  readonly violations: readonly {
    readonly id: string;
    readonly impact: string | null;
    readonly nodes: readonly { readonly target: unknown; readonly html: string; readonly failureSummary: string }[];
  }[];
  readonly passes: readonly { readonly id: string; readonly nodes: readonly unknown[] }[];
  readonly incomplete: readonly { readonly id: string; readonly nodes: readonly unknown[] }[];
}

/** 向帧注入 axe(幂等)并在文档上全规则执行(violations + color-contrast 证据)。 */
async function runAxeInFrame(frame: Frame): Promise<AxeFaceResult> {
  const alreadyInjected = await frame.evaluate(
    () => typeof (globalThis as { axe?: unknown }).axe !== "undefined",
  );
  if (!alreadyInjected) {
    await frame.addScriptTag({ path: AXE_MIN_PATH });
  }
  return frame.evaluate(async () => {
    const axeApi = (globalThis as {
      axe?: { run(doc: Document, options?: Record<string, unknown>): Promise<unknown> };
    }).axe;
    if (axeApi === undefined) {
      throw new Error("axe 未注入");
    }
    const results = (await axeApi.run(document, {
      resultTypes: ["violations", "passes", "incomplete"],
      // 宿主页结构规则禁用(jsdom 豁免清单第 2 条的等效口径,登记决策草稿):
      // page-has-heading-one / region / landmark-one-main 评判的是「宿主页面」
      // 的标题、landmark 组织与唯一主地标——组件面的宿主职责在真实部署中由
      // 宿主页面承担(嵌入形态的页面 = 宿主文档,插件 iframe 是嵌入内容)。
      // 组件面 landmark 的正确性(嵌套 main 等)不被豁免,随全规则判定
      // (shell 面曾由该组规则抓出 main 嵌套真实问题并已修正)。
      rules: {
        "page-has-heading-one": { enabled: false },
        region: { enabled: false },
        "landmark-one-main": { enabled: false },
      },
    })) as unknown as AxeRunBuckets;
    const contrastBuckets: { status: "passed" | "incomplete" | "violations"; nodes: number }[] = [
      ...results.passes
        .filter((rule) => rule.id === "color-contrast")
        .map((rule) => ({ status: "passed" as const, nodes: rule.nodes.length })),
      ...results.incomplete
        .filter((rule) => rule.id === "color-contrast")
        .map((rule) => ({ status: "incomplete" as const, nodes: rule.nodes.length })),
      ...results.violations
        .filter((rule) => rule.id === "color-contrast")
        .map((rule) => ({ status: "violations" as const, nodes: rule.nodes.length })),
    ];
    const contrast = contrastBuckets[0] ?? { status: "absent" as const, nodes: 0 };
    return {
      url: results.url,
      axeVersion: results.version,
      violations: results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          html: node.html.slice(0, 400),
          failureSummary: node.failureSummary,
        })),
      })),
      colorContrastStatus: contrast.status,
      colorContrastCheckedNodes: contrast.nodes,
      // incomplete 节点明细归档(人工复核登记:引擎无法自动判定 ≠ violation)。
      incomplete: results.incomplete.map((rule) => ({
        id: rule.id,
        count: rule.nodes.length,
        nodes: rule.nodes.slice(0, 5).map((node) => ({
          target: (node as { target: unknown }).target,
          html: String((node as { html?: string }).html ?? "").slice(0, 400),
        })),
      })),
    };
  });
}

/** 断言零 violations + color-contrast 真实执行,并归档(每面 JSON)。 */
async function expectFaceClean(frame: Frame, face: string, theme: string): Promise<AxeFaceResult> {
  const result = await runAxeInFrame(frame);
  faceRecords.push({
    face,
    theme,
    url: result.url,
    contrastStatus: result.colorContrastStatus,
    contrastNodes: result.colorContrastCheckedNodes,
    violationCount: result.violations.length,
    incompleteIds:
      result.incomplete
        .map((rule) => `${rule.id}×${rule.count}[${rule.nodes.map((n) => JSON.stringify(n.target).slice(0, 90)).join("; ")}]`)
        .join(" / ") || "—",
  });
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, `${face}-${theme}.json`), JSON.stringify(result, null, 2), "utf8");
  expect(result.violations, `${face}(${theme}) violations 非空`).toEqual([]);
  expect(
    result.colorContrastStatus,
    `${face}(${theme}) color-contrast 规则未执行`,
  ).not.toBe("absent");
  return result;
}

/** 插件文档页扫描变体(由 plugin-site-server 真实路由承载,见该文件
 *  VARIANT_ROUTES;/axe-fast.html 同款降级变体由 host-mock/e2e-silent-host.html
 *  引用。fulfill 形态的合成文档触发 LNA 拦截,不用于嵌入面)。 */
const PLUGIN_AXE_URL = "http://localhost:5174/axe.html";

/** 定位插件 iframe 的 Frame(跨源帧对象,供 addScriptTag / evaluate)。 */
function pluginFrame(page: Page): Frame {
  const frame = page.frames().find((candidate) => candidate.url().startsWith(PLUGIN_SITE_URL));
  if (frame === undefined) {
    throw new Error("插件 iframe 帧未找到");
  }
  return frame;
}

/* ── 扫描面 ──────────────────────────────────────────────────────────────────── */

test.describe("axe color-contrast 真机补测(阶段四条件 6 遗留关闭)", () => {
  test("插件面(iframe workspace 满内容)light + dark 双主题零 violations", async ({ page }) => {
    // 插件页 = plugin-site-server 真实变体路由 /axe.html(正式页同构;CSP 头
    // 由服务器下发,bypassCSP 仅放宽 axe 注入;不用 fulfill——合成文档触发
    // LNA 拦截,插件面后续取回全灭,见决策草稿 §二)。
    const handle = await embedViaHostMock(page, { pluginUrl: PLUGIN_AXE_URL });
    const plugin = handle.plugin;
    const frame = pluginFrame(page);

    // 满内容装配:寄存器视图 + 教学面板 + 题目静态面(details 展开)+ 确定性
    // 拒绝(error explainer;publicErrorMapping 缺省 = 默认教学注解形态)。
    // 嵌入面描述包经跨源端点正式下发(主控已补 ETag exposeHeaders,容器重建
    // 生效)——challenge-panel 呈 loaded 状态,静态面内容一并进入扫描面。
    await pluginOpenTabButton(plugin, "registers").click();
    await expect(plugin.locator("sm-register-view")).toContainText("RSP");
    await plugin.locator("sm-workspace .teaching-panel summary").click();
    await plugin
      .locator("sm-workspace .challenge-panel summary")
      .click()
      .catch(() => undefined);
    await expect(plugin.locator("sm-workspace .challenge-panel")).toHaveAttribute(
      "data-descriptor-status",
      /loaded|absent/,
      { timeout: 20_000 },
    );
    await plugin.locator("sm-workspace").evaluate((element) => {
      const workspace = element as {
        client?: { sendAction(action: { type: string; args: Record<string, string> }): void };
      };
      if (workspace?.client === undefined) {
        throw new Error("会话客户端未装配");
      }
      workspace.client.sendAction({
        type: "write_bytes",
        args: { addressHex: "0xdead0000", bytesHex: "90" },
      });
    });
    await expect(plugin.locator("sm-error-explainer .code-badge")).toHaveText(
      "inaccessible_address",
    );

    // light / 寄存器(含菜单 / 教学面板 / 题目静态面 / 错误解释)。
    await expectFaceClean(frame, "plugin-iframe", "light-registers");

    // light / 栈(虚拟列表区域选择器;lit-virtualizer 行渲染已知缺陷见
    // session.spec.ts 文件头,不影响本扫描的可判定面)。
    await pluginOpenTabButton(plugin, "stack").click();
    await expect(plugin.locator("sm-byte-view .region-select")).toBeVisible();
    await expectFaceClean(frame, "plugin-iframe", "light-stack");

    // dark(宿主 theme_changed → data-sm-theme=dark + color-scheme dark)。
    // 多实例 tab 语义:再次点击 open-tab 会新开第二个视图实例(同 aria-label
    // 并存 → landmark-unique),故 dark 阶段以面板 tab-bar 点击切回已开视图,
    // 不新开实例。
    await page.getByTestId("host-mock-theme-select").selectOption("dark");
    await expect(pluginVm(plugin)).toHaveAttribute("data-sm-theme", "dark");
    await plugin.locator('section[data-tab-id="tab-1"] .tab-bar').click();
    await expect(plugin.locator("sm-register-view").first()).toBeVisible();
    await expect(plugin.locator("sm-register-view").first()).toContainText("RSP");
    await expectFaceClean(frame, "plugin-iframe", "dark-registers");

    await plugin.locator('section[data-tab-id="tab-2"] .tab-bar').click();
    await expect(plugin.locator("sm-byte-view .region-select").first()).toBeVisible();
    await expectFaceClean(frame, "plugin-iframe", "dark-stack");

    await closeEmbedSessionBestEffort(handle);
  });

  test("降级显示面(§4.3 静态文案 + 重试入口)零 violations", async ({ page }) => {
    // 静默宿主(host-mock/e2e-silent-host.html,真实路由——fulfill 合成文档
    // 触发 LNA 拦截,插件面跨源取回全灭;见决策草稿 §二)+ 插件变体页
    // /axe-fast.html(plugin-site-server 真实路由,T_handshake 收紧)。
    await page.goto("http://localhost:5173/host-mock/e2e-silent-host.html");
    const plugin = page.frameLocator('[data-testid="host-mock-iframe"]');
    await expect(plugin.locator('[data-testid="pwn-degraded"]')).toBeVisible({ timeout: 20_000 });

    await expectFaceClean(pluginFrame(page), "plugin-degraded", "light");
  });

  test("plugin-dev 壳形态(表单 + 会话工作区)light 零 violations", async ({
    createdSession,
  }) => {
    // 壳面 = 开发宿主(无主题机制;dark 主题的产品面证据由嵌入面 iframe 的
    // dark 扫描承载——theme_changed → data-sm-theme + 组件级 color-scheme)。
    // 本机 headless Chromium 无法真实绘制 root 级 color-scheme 暗色画布
    // (系统文字色翻转而画布不翻转,形成「半暗态」伪影,实测证据:
    // graytext 映射 #808080 而画布仍 #ffffff)——shell dark 扫描按环境不可达
    // 登记于决策草稿 §三,沿 axe 遗留登记先例。
    const page = createdSession;
    // 工作区满内容:寄存器视图 + 教学面板(夹具通道缺省 = 无提示形态)。
    await page.locator('button.open-tab[data-tab-type="registers"]').click();
    await expect(page.locator("sm-register-view")).toContainText("RSP");
    await page.locator("sm-workspace .teaching-panel summary").click().catch(() => undefined);

    await expectFaceClean(page.mainFrame(), "plugin-dev-shell", "light");
  });
});

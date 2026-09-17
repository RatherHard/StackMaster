/**
 * E2E:axe color-contrast 真机门禁(WP-55 建立;WP-74 扩面为三预设 × 四面)。
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
 * 扫描面矩阵(WP-74 扩面:预设 × 既有扫描面):
 *  1. 插件面(嵌入形态):宿主模拟页 × 插件 iframe,workspace 满内容形态
 *     (寄存器视图 / 栈视图区域选择器 + 教学面板[缺席明示 + 默认教学注解,
 *     经确定性拒绝触发 error explainer])× **light / dark / terminal** 三预设;
 *  2. 降级显示面(§4.3 静态文案 + 重试入口)× light / terminal;
 *  3. plugin-dev 壳形态(表单 + 会话工作区)× light / terminal(dark 经
 *     文档级锚注入 = 独立使用形态 `data-sm-theme` 锚的消费证明)。
 *
 * 预设承载路径(WP-74;非对称是协议约束而非疏漏):
 *  - light / dark = 宿主控制消息 `theme_changed`(嵌入协议 `EMBED_THEMES`
 *    三值 light / dark / auto),插件落 `data-sm-theme` 二值 + `color-scheme`;
 *  - **terminal 不经嵌入协议**(D-MP-2 冻结面),由外部锚承载,见
 *    `e2e/helpers/theme-anchor.ts` 的三条路径:插件文档页挂载前预置
 *    (`/axe-terminal.html` 变体路由,本 spec 的插件面 terminal 段)、运行期外部
 *    锚写入(MutationObserver 路径,本 spec 的降级面 terminal 段)、独立使用
 *    形态 `theme` 属性(本 spec 的壳面 terminal 段);
 *  - 落锚后一律抽样 terminal token 计算值(`--sm-bg-base` / effect 两值,
 *    `expectTerminalTokensActive`)证明变量真的级联,而非只有 attribute 在场。
 *
 * 不可达格登记(沿既有先例如实登记,不虚报):
 *  - **shell dark 面**:本机 headless Chromium 不绘制 root 级暗色画布(系统文字
 *    色翻转而画布不翻转 = 半暗态伪影);dark 主题的产品面证据由嵌入面 iframe 承载;
 *  - **degraded dark 面**:降级形态无握手完成 ⇒ 宿主 `theme_changed` 通道不存在,
 *    而宿主元素的外部锚会被插件按自身 resolvedTheme(light)写回 —— `terminal`
 *    是该写回路径的唯一例外(插件自身从不写 terminal),故降级面只有 light /
 *    terminal 两格可达。matrix = 6(插件面)+ 2(降级面)+ 2(壳面)= **10 JSON**。
 *
 * 校准锚(Q6 反馈回路):若某面 violations 非空,以归档 JSON 的
 * failureSummary / target 为据校准 `packages/vm-ui/src/theme/theme-tokens.ts`
 * 的对应预设变量值(只调数值、零视觉重设计),复跑至零 violations;判定结果
 * 登记于 `docs/develop/阶段五WP55决策草稿.md`(WP-74 三预设扩面的数值面归
 * WP-74 报告)。
 *
 * 扫描口径:宿主页结构规则(page-has-heading-one / region / landmark-one-main)
 * 禁用(等效 jsdom 豁免清单第 2 条的宿主职责面;组件面 landmark 正确性规则
 * 全程启用)。
 *
 * 报告归档:**运行当日** `e2e/reports/axe/<YYYY-MM-DD>/`(每面 JSON + 汇总
 * summary.md,落仓)。归档即历史证据 ⇒ 目录按日期新增、**无覆盖开关**:
 * `2026-09-11/` 是 WP-55 的测量证据,只增不改(此前 `REPORT_DIR` 硬编码为
 * WP-55 日期且标题绑定 WP-55,导致每次跑 axe 都覆写该历史目录 —— WP-74 首件
 * 已修)。
 * CSP 口径:axe 注入上下文以 bypassCSP 承载(受限 CSP 的功能面证明归
 * embed-protocol.spec / browser-matrix.spec,不在此重复)。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Frame, type FrameLocator } from "@playwright/test";

import { REPO_ROOT } from "./helpers/compose.js";
import {
  closeEmbedSessionBestEffort,
  embedViaHostMock,
  pluginFocusWindowButton,
  pluginVm,
  pluginWindow,
} from "./helpers/embed.js";
import { pluginFrameOf } from "./helpers/frames.js";
import {
  applyTerminalThemeOnWorkspace,
  expectTerminalTokensActive,
  PLUGIN_TERMINAL_URL,
  setTerminalAnchorOnPluginHost,
  THEME_ANCHOR_ATTRIBUTE,
  TERMINAL_THEME_VALUE,
} from "./helpers/theme-anchor.js";
import { test } from "./fixtures.js";

/** axe 浏览器构建(vm-ui 既有 devDependency,与 jsdom 套件同源)。 */
const AXE_MIN_PATH = join(REPO_ROOT, "packages", "vm-ui", "node_modules", "axe-core", "axe.min.js");

/**
 * 归档目录 = **运行当日**(`reports/axe/<YYYY-MM-DD>/`;WP-74 首件)。
 * 取值用运行进程的本地日期(CI = runner 本地,即 UTC);目录**不可指定**,
 * 历史归档只能被新目录并列、永不被覆写。
 */
function reportDateStamp(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 本次运行的归档日期(归档目录名与汇总标题同源)。 */
const RUN_DATE = reportDateStamp();
/** 报告归档目录(按运行日期新增;历史目录只增不改)。 */
const REPORT_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "reports", "axe", RUN_DATE);

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
  /** 主题预设(light / dark / terminal)。 */
  readonly preset: string;
  /** 视图 / 形态(registers / stack;降级面与壳面无细分,记 —)。 */
  readonly surface: string;
  /** 归档标签(= `<preset>-<surface>`,surface 为空时即 preset;JSON 文件名用)。 */
  readonly theme: string;
  readonly url: string;
  readonly contrastStatus: string;
  readonly contrastNodes: number;
  readonly violationCount: number;
  readonly incompleteIds: string;
}

/** 一次扫描面的登记三元组(面 / 预设 / 视图形态;归档标签由三者拼出)。 */
interface AxeFaceTarget {
  readonly face: string;
  readonly preset: string;
  readonly surface: string;
  readonly theme: string;
}

/** 构造扫描面登记(surface 缺省 = 该面无视图细分,归档标签回落为预设名)。 */
function faceTarget(face: string, preset: string, surface = ""): AxeFaceTarget {
  return { face, preset, surface, theme: surface === "" ? preset : `${preset}-${surface}` };
}

const faceRecords: FaceRecord[] = [];

test.afterAll(() => {
  if (faceRecords.length === 0) {
    return;
  }
  mkdirSync(REPORT_DIR, { recursive: true });
  const lines: string[] = [
    `# axe color-contrast 真机补测报告(${RUN_DATE})`,
    "",
    `- 生成:WP-74 \`e2e/axe-contrast.spec.ts\` 真机扫描(chromium 门禁口径),归档目录 = **运行当日**`,
    `  \`e2e/reports/axe/${RUN_DATE}/\`(每扫描面一份 JSON + 本汇总)。`,
    "- **归档纪律**:归档即历史证据,目录按日期新增、**无覆盖开关**;历史目录(如 WP-55 的",
    "  `2026-09-11/`)只增不改,永不被新测量覆写。",
    "- 口径:chromium(Playwright 真机)+ axe-core 全规则(**含 color-contrast**,",
    "  `test/ed/axe.test.ts` 豁免清单第 1 条于真机关闭);页面级 harness 沿豁免清单",
    "  第 2 条(lang / title / main landmark,扫描变体页挂载前携带)。",
    "- 判定:每扫描面 violations = 0,color-contrast 规则必须真实执行(判定桶",
    "  passed / incomplete 均为已执行;incomplete = 引擎无法自动判定,人工复核项)。",
    "- 豁免对照:jsdom 豁免清单仅 color-contrast 一条(环境伪影),真机已启用;",
    "  其余规则在 jsdom 与真机均全程启用,两侧判定期望一致。",
    "- 面矩阵:三预设 × 既有扫描面 = 插件面(registers / stack × light / dark / terminal);",
    "  降级面(light / terminal);壳面(light / terminal)。预设承载路径:light / dark 走嵌入协议",
    "  `theme_changed`;terminal 不经协议(EMBED_THEMES 冻结),由外部 `data-sm-theme` 锚承载",
    "  (插件文档页预置 / 运行期写入 / 独立使用形态 theme 属性,见 `e2e/helpers/theme-anchor.ts`)。",
    "- 不可达格登记(如实登记):shell dark(本机 headless 不绘制 root 级暗色画布,半暗态伪影)、",
    "  degraded dark(降级形态无握手 ⇒ 无 theme_changed 通道,宿主元素外部锚被插件写回 resolvedTheme)。",
    "",
    "| 扫描面 | 预设 | 视图 / 形态 | 归档 JSON | color-contrast 判定桶(检查节点数) | violations | incomplete |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const record of faceRecords) {
    lines.push(
      `| ${record.face} | ${record.preset} | ${record.surface === "" ? "—" : record.surface} | ${record.face}-${record.theme}.json | ${record.contrastStatus}(${record.contrastNodes}) | ${record.violationCount} | ${record.incompleteIds} |`,
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
async function expectFaceClean(frame: Frame, target: AxeFaceTarget): Promise<AxeFaceResult> {
  const result = await runAxeInFrame(frame);
  faceRecords.push({
    face: target.face,
    preset: target.preset,
    surface: target.surface,
    theme: target.theme,
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
  writeFileSync(
    join(REPORT_DIR, `${target.face}-${target.theme}.json`),
    JSON.stringify(result, null, 2),
    "utf8",
  );
  const label = `${target.face}(${target.theme})`;
  expect(result.violations, `${label} violations 非空`).toEqual([]);
  expect(result.colorContrastStatus, `${label} color-contrast 规则未执行`).not.toBe("absent");
  return result;
}

/** 插件文档页扫描变体(由 plugin-site-server 真实路由承载,见该文件
 *  VARIANT_ROUTES;/axe-fast.html 同款降级变体由 host-mock/e2e-silent-host.html
 *  引用;/axe-terminal.html = WP-74 的 terminal 锚预置变体。fulfill 形态的合成
 *  文档触发 LNA 拦截,不用于嵌入面)。 */
const PLUGIN_AXE_URL = "http://localhost:5174/axe.html";

/**
 * 插件面满内容装配(插件面 light / dark / terminal 三段共用;消除逐面重复):
 * 寄存器视图聚焦 + 教学面板展开 + 题目静态面展开 + 确定性拒绝(error explainer,
 * publicErrorMapping 缺省 = 默认教学注解形态)。嵌入面描述包经跨源端点正式下发
 * (主控已补 ETag exposeHeaders,容器重建生效)—— challenge-panel 呈 loaded
 * 状态,静态面内容一并进入扫描面。
 */
async function preparePluginFullContent(plugin: FrameLocator): Promise<void> {
  await pluginFocusWindowButton(plugin, "registers").click();
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
}

/* ── 扫描面 ──────────────────────────────────────────────────────────────────── */

test.describe("axe color-contrast 真机补测(阶段四条件 6 遗留关闭;WP-74 三预设扩面)", () => {
  test("插件面(iframe workspace 满内容)light + dark 双预设零 violations", async ({ page }) => {
    // 插件页 = plugin-site-server 真实变体路由 /axe.html(正式页同构;CSP 头
    // 由服务器下发,bypassCSP 仅放宽 axe 注入;不用 fulfill——合成文档触发
    // LNA 拦截,插件面后续取回全灭,见决策草稿 §二)。
    const handle = await embedViaHostMock(page, { pluginUrl: PLUGIN_AXE_URL });
    const plugin = handle.plugin;
    const frame = pluginFrameOf(page);

    // 满内容装配(寄存器视图 + 教学面板 + 题目静态面 + 确定性拒绝)。
    await preparePluginFullContent(plugin);

    // light / 寄存器(含菜单 / 教学面板 / 题目静态面 / 错误解释)。
    await expectFaceClean(frame, faceTarget("plugin-iframe", "light", "registers"));

    // light / 栈(虚拟列表区域选择器;lit-virtualizer 行渲染已知缺陷见
    // session.spec.ts 文件头,不影响本扫描的可判定面。窗口集常驻 ⇒
    // stack / free 两个字节窗口同时在场,选择器按窗口面板收敛)。
    await pluginFocusWindowButton(plugin, "stack").click();
    await expect(pluginWindow(plugin, "stack").locator("sm-byte-view .region-select")).toBeVisible();
    await expectFaceClean(frame, faceTarget("plugin-iframe", "light", "stack"));

    // dark(宿主 theme_changed → data-sm-theme=dark + color-scheme dark)。
    // 固定窗口集(WP-71 / D-MP-1):全部窗口常驻且**各类型唯一**(无重复
    // aria-label 面),dark 阶段经菜单「窗口」聚焦入口切换焦点视图——点击
    // 已聚焦窗口不新增实例(aria-pressed 表达当前焦点)。
    await page.getByTestId("host-mock-theme-select").selectOption("dark");
    await expect(pluginVm(plugin)).toHaveAttribute("data-sm-theme", "dark");
    await pluginFocusWindowButton(plugin, "registers").click();
    await expect(plugin.locator("sm-register-view").first()).toBeVisible();
    await expect(plugin.locator("sm-register-view").first()).toContainText("RSP");
    await expectFaceClean(frame, faceTarget("plugin-iframe", "dark", "registers"));

    await pluginFocusWindowButton(plugin, "stack").click();
    await expect(pluginWindow(plugin, "stack").locator("sm-byte-view .region-select")).toBeVisible();
    await expectFaceClean(frame, faceTarget("plugin-iframe", "dark", "stack"));

    await closeEmbedSessionBestEffort(handle);
  });

  test("插件面 terminal 预设(文档页预置外部锚)零 violations", async ({ page }) => {
    // terminal 承载路径 1(正式集成形态)= 插件文档页**挂载前**预置
    // `data-sm-theme="terminal"`(plugin-site-server 变体路由 /axe-terminal.html)。
    // 独立会话:锚在页面 HTML 里就位,插件 connectedCallback 判定为外部显式锚
    // → 保留锚 + 落 color-scheme dark,后续握手 / 会话建立 / theme_changed
    // 均不改写该锚(web-component #applyAppearanceToHost;jsdom 结构断言见
    // packages/web-component/test/pwn-memory-vm.test.ts:255)。
    test.setTimeout(150_000);
    const handle = await embedViaHostMock(page, { pluginUrl: PLUGIN_TERMINAL_URL });
    const plugin = handle.plugin;
    const frame = pluginFrameOf(page);

    // 锚在场 + 变量真的级联(只看 attribute 不足以证明预设生效)。
    await expect(pluginVm(plugin)).toHaveAttribute(THEME_ANCHOR_ATTRIBUTE, TERMINAL_THEME_VALUE);
    await expectTerminalTokensActive(pluginVm(plugin));

    await test.step("terminal / 寄存器", async () => {
      await preparePluginFullContent(plugin);
      await expectFaceClean(frame, faceTarget("plugin-iframe", "terminal", "registers"));
    });

    await test.step("terminal / 栈", async () => {
      await pluginFocusWindowButton(plugin, "stack").click();
      await expect(
        pluginWindow(plugin, "stack").locator("sm-byte-view .region-select"),
      ).toBeVisible();
      // 落锚在切换视图后仍保持在位(会话事件不清锚)。
      await expect(pluginVm(plugin)).toHaveAttribute(THEME_ANCHOR_ATTRIBUTE, TERMINAL_THEME_VALUE);
      await expectFaceClean(frame, faceTarget("plugin-iframe", "terminal", "stack"));
    });

    await closeEmbedSessionBestEffort(handle);
  });

  test("降级显示面(§4.3 静态文案 + 重试入口)light 零 violations;terminal 格登记不可达", async ({
    page,
  }) => {
    // 降级形态含两个面(light + terminal),加本用例的握手超时等待,放宽上限。
    test.setTimeout(120_000);
    // 静默宿主(host-mock/e2e-silent-host.html,真实路由——fulfill 合成文档
    // 触发 LNA 拦截,插件面跨源取回全灭;见决策草稿 §二)+ 插件变体页
    // /axe-fast.html(plugin-site-server 真实路由,T_handshake 收紧)。
    await page.goto("http://localhost:5173/host-mock/e2e-silent-host.html");
    const plugin = page.frameLocator('[data-testid="host-mock-iframe"]');
    await expect(plugin.locator('[data-testid="pwn-degraded"]')).toBeVisible({ timeout: 20_000 });

    await expectFaceClean(pluginFrameOf(page), faceTarget("plugin-degraded", "light"));

    // terminal 格**登记为不可达**(与 `shell dark` / `degraded dark` 同列,如实登记):
    // 降级形态**不安装文档级主题 token 样式表**——该样式表由组件侧
    // `ensureSmThemeStyles` 安装,而降级形态没有 sm-workspace / 没有 themed 组件
    // 树(只有静态文案 + 重试入口)⇒ 锚写上去也没有变量可级联,`--sm-bg-base`
    // 取不到值(实测:锚 attribute 在场且被保留,但 computed 为空串)。
    // 处置:**只断言锚写回的结构事实**,不声称 token 已生效、不扫描该格 ——
    // 不用 harness 注入产品路径不会产生的样式表来制造假绿。
    const frame = pluginFrameOf(page);
    await setTerminalAnchorOnPluginHost(frame);
    await expect(pluginVm(plugin)).toHaveAttribute(THEME_ANCHOR_ATTRIBUTE, TERMINAL_THEME_VALUE);
  });

  test("plugin-dev 壳形态(表单 + 会话工作区)light + terminal 零 violations", async ({
    createdSession,
  }) => {
    // 壳面 = 开发宿主(无嵌入外观机制;dark 主题的产品面证据由嵌入面 iframe 的
    // dark 扫描承载——theme_changed → data-sm-theme + 组件级 color-scheme)。
    // 本机 headless Chromium 无法真实绘制 root 级 color-scheme 暗色画布
    // (系统文字色翻转而画布不翻转,形成「半暗态」伪影,实测证据:
    // graytext 映射 #808080 而画布仍 #ffffff)——shell dark 扫描按环境不可达
    // 登记于决策草稿 §三,沿 axe 遗留登记先例。
    test.setTimeout(120_000);
    const page = createdSession;
    // 工作区满内容:窗口集常驻(寄存器视图聚焦进入视口)+ 教学面板
    // (夹具通道缺省 = 无提示形态)。
    await page.locator('button.focus-window[data-window-type="registers"]').click();
    await expect(page.locator("sm-register-view")).toContainText("RSP");
    await page.locator("sm-workspace .teaching-panel summary").click().catch(() => undefined);

    await expectFaceClean(page.mainFrame(), faceTarget("plugin-dev-shell", "light"));

    // terminal(承载路径 3 = 独立使用形态):工作区 `theme` 属性 → 组件转写
    // 自身 `data-sm-theme` 锚(theme-tokens §机制 3「最近锚优先」)。壳面作为
    // 开发宿主不引入 color-scheme 映射(那是嵌入形态 #applyAppearanceToHost
    // 的产品行为;壳面 root 级 color-scheme 即上述半暗态伪影的来源)——
    // terminal 面在壳面 = terminal token 锚 + 系统色关键词底色,组件消费
    // `--sm-bg-*` / `--sm-fg`(WP-74 组件面)后该面才是完整终端呈现。
    await applyTerminalThemeOnWorkspace(page);
    await expect(page.locator("sm-workspace")).toHaveAttribute(
      THEME_ANCHOR_ATTRIBUTE,
      TERMINAL_THEME_VALUE,
    );
    await expectTerminalTokensActive(page.locator("sm-workspace"));
    await expectFaceClean(page.mainFrame(), faceTarget("plugin-dev-shell", "terminal"));
  });
});

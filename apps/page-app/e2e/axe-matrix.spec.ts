/**
 * axe 真机面矩阵(**分发改版新面集合**;WP-95 重定义,替代退役的 `plugin-iframe-*` 九面)。
 *
 * ## 为什么面集合要重定义
 *
 * 退役面的历史九面 = `plugin-iframe-{light,dark,terminal}
 * × {registers,stack}` + `plugin-dev-shell-{light,terminal}` + `plugin-degraded-light`
 * —— **全部属退役面**(嵌入协议整体退役;light / dark 随终端单主题退役)。新形态是
 * 「与 API 同源的独立页面 + 终端单主题」⇒ 面集合按**视口档 × 关键形态**重切。
 *
 * ## 新面集合(逐面列出)
 *
 * 每面 = `page-app-<视口宽>×<视口高>-<状态>`;共 **9 面**:
 *
 * | # | 面 | 视口 | 状态 | 覆盖的形态 |
 * |---|---|---|---|---|
 * | 1 | `page-app-1440x900-default` | 1440×900 | 两个可见视图位(栈 + 寄存器)+ 列表按钮收起 + 右半侧 payload | D-UI-1 / 2 的默认形态;面板地标名;视图内左上角类型名 |
 * | 2 | `page-app-1440x900-list-open` | 1440×900 | 列表按钮**展开**(原生 checkbox 勾选面 + 播报区) | D-UI-4 / 7 ③ 的键盘与勾选面 |
 * | 3 | `page-app-1440x900-instruction` | 1440×900 | 指令视图滚入视口 | 指令视图(伪汇编 chip / 跳转链)对比度 |
 * | 4 | `page-app-1440x900-payload` | 1440×900 | 右半侧 payload 搭建窗口 | WP-83 惰性宿主 + Blockly 画布(深底精灵 token) |
 * | 5 | `page-app-1024x768-default` | 1024×768 | 同 1 | 紧凑档两分形态 |
 * | 6 | `page-app-1024x768-list-open` | 1024×768 | 同 2 | 紧凑档列表面(工具区换行后) |
 * | 7 | `page-app-768x900-default` | 768×900 | 同 1 | 窄档(页面横向滚动,右半侧在视口外) |
 * | 8 | `page-app-375x667-default` | 375×667 | 同 1 | 极窄档(两半侧各保底 452.4px) |
 * | 9 | `page-app-375x667-payload` | 375×667 | 同 4 | 极窄档 payload 面 |
 *
 * **为什么这么切**(理由,不留白):
 *  - **视口档**取 1440 / 1024 / 768 / 375 —— 与几何护栏同档,便于「同一读数集合」对照;
 *    1440 = 宽档常态(两半侧各 720px)、1024 = 中档、768 / 375 = 保底窄档(D-UI-5);
 *  - **状态**取「默认 / 列表展开 / 指令视图 / payload」——它们是**结构上不同的子树**:
 *    默认面 = 面板 + 视图内标签;列表展开面 = 原生 checkbox + 播报区(D-UI-7 ③ 的
 *    aria 面);指令视图 = 跳转链 chip(历史 `graytext` 4.47:1 缺陷所在面);
 *    payload = Blockly 画布(`--sm-canvas-sprite-filter` 的消费面);
 *  - **不再有 light / dark 面**:终端单主题(D-UI-6)⇒ 同一面只有一套取值;
 *  - **不再有 degraded 面**:降级形态属嵌入面(握手超时 / 服务端缺席明示),页面形态
 *    无此形态(描述包缺席 = `descriptorStatus="absent"`,不是「降级组件」)。
 *
 * ## 归档纪律(遗留 #13 / #14 的修法;新形态另起目录)
 *
 *  - **目录**:`e2e/reports/axe/<YYYY-MM-DD>/<run>/`(`run` = `run-1` / `run-2` …
 *    或环境变量 `AXE_ARCHIVE_LABEL` 显式命名)⇒ **同日复跑不覆盖**;
 *    **退役面的历史归档**已随 WP-96 从 `apps/plugin-dev/e2e/reports/axe/**`
 *    **搬迁**到 `docs/archive/axe-归档-plugin-dev/**`(原件随该应用物理删除;归档
 *    **只增不改**,本文件绝不写它;搬迁是**字节级拷贝**,逐文件 SHA256 一致 ——
 *    见 `docs/archive/README.md`);
 *  - **确定性**:归档前**规范化** —— 剥 `esid`(会话 UUID)、剥 Lit
 *    `?lit$<hash>$` / `<!--?lit$…$-->` 标记、对象键排序、LF 行尾、末尾换行。
 *    于是「测量结果相同 ⇒ 字节相同」,不再产生伪 diff;
 *  - **`summary.md` 分列两栏**:「自动判定通过(axe passes)」与「无法判定(axe
 *    incomplete)」——**不得**把 `incomplete` 写成「正向通过」(遗留 #14 的薄绿纪律);
 *  - **`summary.md` 记「未扫描面清单」**:登记面集合里**未在本轮产出 JSON** 的面
 *    (前置断言先失败 / 显式跳过)⇒ 归档目录**内部自洽**(遗留 #13 ⑤)。
 *
 * ## `incomplete` 如实登记
 *
 * 单主题下 axe 对 `color-contrast` 仍可能因**半透明覆盖层**(扫描线 `opacity ≤ 0.06`
 * 等效果面)无法自动判定 ⇒ 该面 `colorContrastStatus = "incomplete"`,节点数进
 * 「无法判定」栏。**这与 violations = 0 是两件事**,汇总表逐面分列,不合并成一句「零违规」。
 *
 * ## 本机可跑性
 *
 * 与 `page-app.spec.ts` 同一基座:真 chromium + 真 vm-ui 产物 + `vite preview` +
 * Playwright 注入 `POST /sessions`(**不需要 Docker**)。归档目录落
 * `apps/page-app/e2e/reports/axe/**`(新增面集合,与 `docs/archive/axe-归档-plugin-dev/**`
 * 的历史目录**分处两地**、互不影响)。
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page, type Route } from "@playwright/test";

import { launchRedeemPath } from "../src/launch-path.js";

/** axe 浏览器构建(与 vm-ui 的 jsdom 套件同一份 devDependency)。 */
const AXE_MIN_PATH = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "vm-ui",
  "node_modules",
  "axe-core",
  "axe.min.js",
);

const CHALLENGE_ID = "chal-stack-escape";
const CHALLENGE_VERSION = "1.2.3";

/** 契约合法的公开投影(与 `page-app.spec.ts` 同形)。 */
const PROJECTION = {
  revision: 0,
  visibleRegions: [
    {
      regionId: "code",
      label: "代码区",
      startAddressHex: "0x401000",
      byteLength: 4096,
      permissions: "rx",
      bytesHex: "554889e54883ec2048897dfcb8000000",
      truncated: true,
    },
    {
      regionId: "stack",
      label: "栈区",
      startAddressHex: "0x7FFFF000",
      byteLength: 8192,
      permissions: "rw",
      bytesHex: "0000000000000000111111111111111122222222222222223333333333333333",
      truncated: true,
    },
  ],
  visibleRegisters: [
    { name: "RAX", valueHex: "0x0" },
    { name: "RSP", valueHex: "0x7FFFF000" },
    { name: "RIP", valueHex: "0x401000" },
  ],
  callStackSummary: [],
  controlFlow: { currentInstruction: { addressHex: "0x401000", text: "push rbp" }, pausedOn: null },
  semanticHighlights: [],
  status: "running",
} as const;

/* ── 归档(确定性 + 同日不覆盖)───────────────────────────────────────────── */

/** 运行当日(本地日期;与既有 axe 归档的日期口径一致)。 */
function reportDateStamp(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const RUN_DATE = reportDateStamp();
const AXE_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "reports", "axe");

/** 本轮运行目录名(`run-N` 或 `AXE_ARCHIVE_LABEL`;报告文本与路径同源)。 */
const RUN_LABEL = process.env["AXE_ARCHIVE_LABEL"] !== undefined && process.env["AXE_ARCHIVE_LABEL"] !== ""
  ? (process.env["AXE_ARCHIVE_LABEL"] as string)
  : `run-${resolveRunSequence()}`;

/** 当日已存在的最大 `run-N` 序号 + 1(同日复跑不覆盖)。 */
function resolveRunSequence(): number {
  const dayDir = join(AXE_ROOT, RUN_DATE);
  if (!existsSync(dayDir)) {
    return 1;
  }
  const used = readdirSync(dayDir)
    .map((name) => /^run-(\d+)$/.exec(name))
    .filter((matched): matched is RegExpExecArray => matched !== null)
    .map((matched) => Number(matched[1]));
  return used.length === 0 ? 1 : Math.max(...used) + 1;
}

/** 本轮归档目录。 */
const RUN_DIR = join(AXE_ROOT, RUN_DATE, RUN_LABEL);

/**
 * 归档**确定性**规范化(遗留 #13 修法):剥会话 UUID(`esid`)与 Lit 模板标记
 * (`?lit$<hash>$` / `<!--?lit$…$-->`),对象键排序,统一 LF,末尾换行。
 *
 * 「规范化」的判据 = **两次测量结果相同 ⇒ 归档字节相同**(不再有伪 diff)。
 */
export function canonicalizeForArchive(text: string): string {
  return (
    text
      // Lit 模板标记(两种形态:`?lit$123$` 与 HTML 注释 `<!--?lit$123$-->`)。
      .replaceAll(/<!--\?lit\$[^$]*\$-->/g, "")
      .replaceAll(/\?lit\$[^$]*\$/g, "")
      // 会话标识(前后端会话 id / 授权凭证 jti 的 UUID 形态)。
      .replaceAll(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        "<uuid>",
      )
      // 统一行尾。
      .replaceAll("\r\n", "\n")
  );
}

/** 递归键排序 + 规范化字符串(JSON 归档的确定性形态)。 */
function canonicalJson(value: unknown): string {
  const sortKeys = (input: unknown): unknown => {
    if (typeof input === "string") {
      return canonicalizeForArchive(input);
    }
    if (Array.isArray(input)) {
      return input.map(sortKeys);
    }
    if (input !== null && typeof input === "object") {
      const entries = Object.entries(input as Record<string, unknown>).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      return Object.fromEntries(entries.map(([key, item]) => [key, sortKeys(item)]));
    }
    return input;
  };
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/* ── 面登记 ──────────────────────────────────────────────────────────────── */

/** 面定义(新面集合;见文件头表格)。 */
interface FaceDefinition {
  /** 视口(与几何护栏同档)。 */
  readonly width: number;
  readonly height: number;
  /** 状态键(default / list-open / instruction / payload)。 */
  readonly state: "default" | "list-open" | "instruction" | "payload";
  /** 该状态为何单独成面(写进 summary.md,不留白)。 */
  readonly rationale: string;
}

const FACES: readonly FaceDefinition[] = [
  {
    width: 1440,
    height: 900,
    state: "default",
    rationale: "默认形态:两个可见视图位(栈 + 寄存器)+ 列表收起 + 右半侧 payload 同屏",
  },
  {
    width: 1440,
    height: 900,
    state: "list-open",
    rationale: "列表按钮展开:原生 checkbox 勾选面 + aria-live 播报区(D-UI-4 / D-UI-7 ③)",
  },
  {
    width: 1440,
    height: 900,
    state: "instruction",
    rationale: "指令视图:伪汇编 chip / 跳转链(历史上 graytext 4.47:1 缺陷所在面)",
  },
  {
    width: 1440,
    height: 900,
    state: "payload",
    rationale: "payload 搭建窗口:WP-83 惰性宿主 + Blockly 画布(深底精灵处理 token)",
  },
  { width: 1024, height: 768, state: "default", rationale: "中档默认形态(工具区开始换行)" },
  { width: 1024, height: 768, state: "list-open", rationale: "中档列表展开面" },
  { width: 768, height: 900, state: "default", rationale: "窄档默认形态(页面横向滚动,右半侧在视口外)" },
  { width: 375, height: 667, state: "default", rationale: "极窄档默认形态(两半侧各保底 452.4px)" },
  { width: 375, height: 667, state: "payload", rationale: "极窄档 payload 面" },
];

/** 面键(`page-app-<w>x<h>-<state>`;归档文件名与 summary 行同源)。 */
function faceKey(face: FaceDefinition): string {
  return `page-app-${face.width}x${face.height}-${face.state}`;
}

/** 一轮扫描的逐面结果(归档 + 汇总的单一来源)。 */
interface FaceResult {
  readonly key: string;
  readonly url: string;
  readonly violationCount: number;
  /** 自动判定**通过**的节点数(axe `passes` 桶全规则合计)。 */
  readonly passedNodes: number;
  /** **无法判定**的节点数(axe `incomplete` 桶全规则合计;与 passes 分列)。 */
  readonly incompleteNodes: number;
  readonly colorContrastStatus: "passed" | "incomplete" | "violations" | "absent";
  readonly colorContrastPassedNodes: number;
  readonly colorContrastIncompleteNodes: number;
  readonly incompleteIds: readonly string[];
}

const faceResults: FaceResult[] = [];

/** axe 结果的最小形状(浏览器侧求值返回;axe-core 4.x 桶结构)。 */
interface AxeRunResult {
  readonly url: string;
  readonly version: string;
  readonly violations: readonly {
    readonly id: string;
    readonly impact: string | null;
    readonly nodes: readonly { readonly target: unknown; readonly html: string; readonly failureSummary: string }[];
  }[];
  readonly passes: readonly { readonly id: string; readonly nodes: readonly unknown[] }[];
  readonly incomplete: readonly {
    readonly id: string;
    readonly nodes: readonly { readonly target: unknown; readonly html: string }[];
  }[];
}

/** 向主帧注入 axe(幂等)并全规则执行。 */
async function runAxe(page: Page): Promise<AxeRunResult> {
  const already = await page.evaluate(
    () => typeof (globalThis as { axe?: unknown }).axe !== "undefined",
  );
  if (!already) {
    await page.addScriptTag({ path: AXE_MIN_PATH });
  }
  return page.evaluate(async () => {
    const axeApi = (
      globalThis as { axe?: { run(doc: Document, options?: Record<string, unknown>): Promise<unknown> } }
    ).axe;
    if (axeApi === undefined) {
      throw new Error("axe 未注入");
    }
    return (await axeApi.run(document, {
      resultTypes: ["violations", "passes", "incomplete"],
      // 页面级结构规则禁用:它们是**部署形态**的职责(页面由 session-api 托管,
      // 其 head 由构建产物给出),不是组件面判据;组件面的 landmark 正确性
      // (嵌套 main / 地标重名)不被豁免,随全规则判定。
      rules: {
        "page-has-heading-one": { enabled: false },
        region: { enabled: false },
        "landmark-one-main": { enabled: false },
      },
    })) as unknown as AxeRunResult;
  });
}

/** 安装 `POST /sessions` 应答(不连后端;同 `page-app.spec.ts`)。 */
async function installCreateSessionStub(page: Page): Promise<void> {
  await page.route("/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        command: "create_session",
        payload: { sessionId: "session-axe-0001", revision: 0, projection: PROJECTION },
      }),
    });
  });
}

/** 按状态把页面摆到该面要扫的形态。 */
async function applyState(page: Page, state: FaceDefinition["state"]): Promise<void> {
  const workspace = page.locator("sm-workspace");
  if (state === "list-open") {
    await workspace.locator("details.view-list-button > summary").click();
    await expect(workspace.locator("li.view-list-item").first()).toBeVisible();
    return;
  }
  if (state === "instruction") {
    await workspace.locator('[data-view-panel="debug"]').scrollIntoViewIfNeeded();
    await expect(workspace.locator("sm-instruction-view").first()).toBeVisible({ timeout: 20_000 });
    return;
  }
  if (state === "payload") {
    await expect(page.locator("sm-payload-tab-host, sm-payload-tab").first()).toBeVisible({
      timeout: 20_000,
    });
  }
}

/** 按规则 id 汇总节点数(axe 可能把**同一条规则**同时放进多个桶)。 */
function nodesByRule(
  buckets: readonly { readonly id: string; readonly nodes: readonly unknown[] }[],
): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const rule of buckets) {
    totals.set(rule.id, (totals.get(rule.id) ?? 0) + rule.nodes.length);
  }
  return totals;
}

/** 扫描一面:断言 violations = 0、color-contrast 规则真实执行、归档该面 JSON。 */
async function scanFace(page: Page, face: FaceDefinition): Promise<void> {
  const key = faceKey(face);
  const result = await runAxe(page);
  // ⚠ 实测口径(2026-09-19):axe 对同一条规则可能**同时**给出 passes 与 incomplete
  // 两类条目(同一面里 `color-contrast` 同时出现在两桶)⇒ **逐桶求和**,不能只取
  // 首个命中(那样会把 114 个「无法判定」节点误报成 0 —— 正是遗留 #14 的薄绿形态)。
  const passedByRule = nodesByRule(result.passes);
  const incompleteByRule = nodesByRule(result.incomplete);
  const violationByRule = nodesByRule(result.violations);
  const contrastPassed = passedByRule.get("color-contrast") ?? 0;
  const contrastIncomplete = incompleteByRule.get("color-contrast") ?? 0;
  const contrastViolations = violationByRule.get("color-contrast") ?? 0;
  const contrastStatus: FaceResult["colorContrastStatus"] =
    contrastViolations > 0
      ? "violations"
      : contrastIncomplete > 0 && contrastPassed === 0
        ? "incomplete"
        : contrastPassed > 0 || contrastIncomplete > 0
          ? "passed"
          : "absent";
  const record: FaceResult = {
    key,
    url: result.url,
    violationCount: result.violations.length,
    passedNodes: result.passes.reduce((total, rule) => total + rule.nodes.length, 0),
    incompleteNodes: result.incomplete.reduce((total, rule) => total + rule.nodes.length, 0),
    colorContrastStatus: contrastStatus,
    colorContrastPassedNodes: contrastPassed,
    colorContrastIncompleteNodes: contrastIncomplete,
    incompleteIds: result.incomplete.map((rule) => `${rule.id}×${rule.nodes.length}`),
  };
  faceResults.push(record);
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(
    join(RUN_DIR, `${key}.json`),
    canonicalJson({
      face: key,
      viewport: `${face.width}x${face.height}`,
      state: face.state,
      rationale: face.rationale,
      url: result.url,
      axeVersion: result.version,
      violations: result.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          html: node.html.slice(0, 400),
          failureSummary: node.failureSummary,
        })),
      })),
      passedNodes: record.passedNodes,
      incompleteNodes: record.incompleteNodes,
      incomplete: result.incomplete.map((rule) => ({
        id: rule.id,
        count: rule.nodes.length,
        nodes: rule.nodes.slice(0, 5).map((node) => ({
          target: node.target,
          html: String(node.html ?? "").slice(0, 400),
        })),
      })),
      colorContrast: {
        status: contrastStatus,
        passedNodes: contrastPassed,
        incompleteNodes: contrastIncomplete,
        violationsNodes: contrastViolations,
      },
    }),
    "utf8",
  );

  // 断言面(与归档同源):violations = 0;color-contrast 规则必须真实执行。
  expect(result.violations, `${key} violations 非空:${JSON.stringify(result.violations)}`).toEqual(
    [],
  );
  expect(result.version, "axe 未回版本号(注入或执行有问题)").not.toBe("");
  expect(record.colorContrastStatus, `${key} color-contrast 规则未执行(absent)`).not.toBe("absent");
}

/* ── 汇总(summary.md:两栏分列 + 未扫描面清单)────────────────────────────── */

test.afterAll(() => {
  if (faceResults.length === 0) {
    return;
  }
  mkdirSync(RUN_DIR, { recursive: true });
  const scannedKeys = new Set(faceResults.map((record) => record.key));
  const unscanned = FACES.map(faceKey).filter((key) => !scannedKeys.has(key));
  const lines: string[] = [
    `# axe 真机面矩阵报告(page-app 新面集合;${RUN_DATE} / ${RUN_LABEL})`,
    "",
    "- 载体:`apps/page-app/e2e/axe-matrix.spec.ts`(真 chromium + 真 vm-ui 产物 + `vite preview`;",
    "  `POST /sessions` 由 Playwright 按契约形态注入 ⇒ **不需要 Docker**)。",
    "- 归档目录:apps/page-app/e2e/reports/axe/" + RUN_DATE + "/" + RUN_LABEL + "/",
    "  (**同日复跑不覆盖**:序号目录或 `AXE_ARCHIVE_LABEL` 显式命名;遗留 #13 修法)。",
    "- 归档确定性(遗留 #13):剥 `esid`(UUID)与 Lit `?lit$…$` 标记、对象键排序、统一 LF ⇒",
    "  「测量结果相同 ⇒ 归档字节相同」,不再产生伪 diff。",
    "- **退役面的历史归档** = `docs/archive/axe-归档-plugin-dev/**`(原 `apps/plugin-dev/e2e/reports/axe/**`,",
    "  2026-09-19 随 WP-96 **字节级搬迁**后删除原件;九面 `plugin-iframe-*` 等)**只增不改**,",
    "  本报告不触碰;那些面随嵌入协议整体退役而不再可达。",
    "",
    "## 面集合(新形态;逐面理由)",
    "",
    "| 面 | 视口 | 状态 | 单独成面的理由 |",
    "|---|---|---|---|",
  ];
  for (const face of FACES) {
    lines.push(`| ${faceKey(face)} | ${face.width}×${face.height} | ${face.state} | ${face.rationale} |`);
  }
  lines.push(
    "",
    "## 结果(**自动判定通过 / 无法判定**分列 —— 不得把 incomplete 写成「正向通过」)",
    "",
    "| 面 | violations | 自动判定通过(节点) | 无法判定 incomplete(节点) | color-contrast(通过 / 无法判定 / 违规) |",
    "|---|---|---|---|---|",
  );
  for (const record of faceResults) {
    lines.push(
      `| ${record.key} | ${record.violationCount} | ${record.passedNodes} | ${record.incompleteNodes} | ${record.colorContrastStatus}(${record.colorContrastPassedNodes} / ${record.colorContrastIncompleteNodes} / ${record.colorContrastStatus === "violations" ? ">0" : "0"}) |`,
    );
  }
  lines.push(
    "",
    `- 合计:${faceResults.length} 面,**violations = 0**;自动判定通过节点 = ${faceResults.reduce(
      (total, record) => total + record.passedNodes,
      0,
    )};无法判定节点 = ${faceResults.reduce((total, record) => total + record.incompleteNodes, 0)}。`,
    "- **声明的边界**「violations = 0」只说明**自动可判定**部分无违规;`incomplete` 面(含",
    "  color-contrast 因半透明覆盖层 / 扫描线无法计算合成对比度者)属**人工复核项**,与",
    "  「正向通过」不是同一句话(遗留 #14 的薄绿纪律)。",
    "",
    "### 无法判定明细(incomplete;逐面逐规则)",
    "",
  );
  const withIncomplete = faceResults.filter((record) => record.incompleteIds.length > 0);
  if (withIncomplete.length === 0) {
    lines.push("- (本轮无 incomplete 条目)");
  } else {
    for (const record of withIncomplete) {
      lines.push(`- ${record.key}:${record.incompleteIds.join(" / ")}`);
    }
  }
  lines.push(
    "",
    "## 未扫描面清单(归档自洽性;遗留 #13 ⑤)",
    "",
  );
  if (unscanned.length === 0) {
    lines.push("- 无 —— 声明的 9 面全部产出 JSON。");
  } else {
    lines.push(
      "- ⚠ 下列**声明面未产出 JSON**(前置断言先失败或被跳过)⇒ 归档目录不完整,单看结果表无法察觉:",
    );
    for (const key of unscanned) {
      lines.push(`  - ${key}`);
    }
  }
  lines.push("");
  writeFileSync(join(RUN_DIR, "summary.md"), canonicalizeForArchive(lines.join("\n")), "utf8");
});

/* ── 用例:逐面扫描 ─────────────────────────────────────────────────────── */

test.describe("axe 真机面矩阵(page-app 新面集合;chromium 门禁口径)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "axe 真机门禁口径 = chromium");

  for (const face of FACES) {
    test(`${faceKey(face)}:violations = 0(${face.rationale})`, async ({ page }) => {
      await page.setViewportSize({ width: face.width, height: face.height });
      await installCreateSessionStub(page);
      await page.goto(launchRedeemPath(CHALLENGE_ID, CHALLENGE_VERSION));
      await expect(page.locator("sm-workspace")).toHaveCount(1);
      await expect(page.locator("sm-workspace .ws-left [data-view-panel]").first()).toBeVisible({
        timeout: 20_000,
      });
      await applyState(page, face.state);
      await scanFace(page, face);
    });
  }
});

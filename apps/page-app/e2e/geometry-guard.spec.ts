/**
 * 几何护栏 E2E(分发改版 WP-95;承接遗留 #33;判据 = **D-UI-2 几何契约四条**)。
 *
 * ## 为什么是这条路(而不是加一条单测)
 *
 * 本仓库两次真实教训:**axe 9/9 面 0 违规时窗口只有 146px**(连一行字节都看不见)、
 * **vm-ui 895 单测全绿时窗高拖拽在真机失效**(只兑现 7.5px)。jsdom 无布局引擎、
 * axe 只看无障碍与对比度 ⇒ **几何类缺陷系统性不被单元 / 结构断言覆盖**。故本文件
 * 的每一条判据都读**真 chromium 布局引擎**给出的渲染结果(`clientHeight` /
 * `scrollHeight` / `getBoundingClientRect`),**不断言任何常量算式**:
 * `MIN_ROW_HEIGHT_PX` / `columnMinHeightPx` / `columnChromePx`(D-API-152 的历史
 * 几何面)**不出现在本文件任何一条断言里**;`layout-presets.ts` 的高度面常量也
 * **不被引用** —— 判据全取浏览器实测值(chrome 由真实元素盒相加、行高由真实行盒量)。
 *
 * ## 逐条对照 D-UI-2 的四条
 *
 *  1. **左半侧 = 滚动容器**:`stack.scrollHeight > stack.clientHeight`(溢出由内部
 *     滚动承载,而不是把视图压扁);
 *  2. **每个可见视图位的 `clientHeight` ≥ 一个「面板 chrome + N 行字节」下限** ——
 *     **N ≥ 1 为红线,N = 4 为目标**:
 *     ① 红线 = 每个**可见视图位**的 `clientHeight` ≥ 实测 chrome + 1 个实测行高,
 *        且每个字节视图**至少 1 行完整可见**;
 *     ② 目标 = 每个字节视图**完整可见数据行 ≥ 4**;
 *  3. `document.documentElement.scrollHeight ≤ innerHeight + 1`(整页不纵向溢出);
 *  4. 两半侧**严格 1:1 且间隙 0px**(D-UI-1:无 gap / 无 border / 无 divider)。
 *
 * ## 多视口(与 WP-93/94 的几何 harness 同档,便于逐值对照)
 *
 * `1440×900` / `1024×768` / `768×900` / `375×667`。窄档两半侧各保底 452.4px
 * ⇒ 页面横向滚动(D-UI-5),故 768 / 375 档同时是「右半侧可达」的回归护栏。
 *
 * ## ⚠ 已登记的几何缺口(本 WP **只取证、不修产品代码**)
 *
 * 真机实测(2026-09-18;`E2E_MATRIX=1` 三引擎,**数值逐引擎不同**,完整登记见
 * `KNOWN_GEOMETRY_GAPS` 与运行日志 `[geometry-guard:*]`):
 *
 * | 视角 | 视口 | 视图位高 | 实测 chrome | 字节视图可视高 | **完整可见数据行** | 判据 |
 * |---|---|---|---|---|---|---|
 * | chromium | 1440×900 | 336 | 188.1(列头行 21.8) | 125.9 | **4** | 红线 + 目标**双绿** |
 * | chromium | 1024×768 | 267 | **296.5**(列头行 **84.2**) | 0 | **0** | **双红** |
 * | chromium | 768×900 | 321 | **322.5** | 0 | **0** | **双红** |
 * | chromium | 375×667 | 265 | 188.1 | 54.9 | **1** | 红线绿 / 目标红 |
 * | firefox | 1440×900 | 352 | 157.1 | 172.9 | **7** | 双绿 |
 * | firefox | 1024×768 | 283 | **300.5** | 0 | **0** | **双红** |
 * | firefox | 768×900 | 349 | **387.5** | 0 | **0** | **双红** |
 * | firefox | 375×667 | 265 | 190.1 | 52.9 | **1** | 红线绿 / 目标红 |
 * | webkit | 1440×900 | 353 | 170.1 | 161.4 | **6** | 双绿 |
 * | webkit | 1024×768 | 284 | **321.5** | 0 | **0** | **双红** |
 * | webkit | 768×900 | 350 | **410.5** | 0 | **0** | **双红** |
 * | webkit | 375×667 | 265 | 207.1 | 36.4 | **0** | **双红** |
 *
 * **视图位高、chrome、可见行数三者都随引擎变化**(JS 布局引擎的字号 / 折行差异)
 * ⇒ 登记表键取 **`<引擎>:<视口>`**;这是**真实差异**,不是噪声,不得抹平。
 *
 * **成因(逐层取证,非猜测)**:字节视图的 `.byte-row` 网格是
 * `grid-template-columns: 16ch 26ch 1fr`(+ `column-gap: 1ch` + `padding-inline: 0.75rem`)
 * ⇒ **固定轨宽 ≈ 346px**;而 `<sm-byte-tab>` 的 `.layout` 在 `> 40rem` 时**恒切出
 * 224px(14rem)VMA 侧栏** ⇒ 1024 档视图位 512px 里字节视图只剩 **278px**、
 * 768 档(452px)只剩 **218px**。网格放不下 346px ⇒ 第三列被压到 **~14px**、
 * 「特殊显示」表头折成 4 行 ⇒ **列头行 21.8px → 84.2px**;工具区(含跳转 / 搜索
 * 表单)在窄档也换行长高 ⇒ **chrome(≈296 ~ 410)反而超过视图位高(267 ~ 350)**
 * ⇒ 列表(其 `min-block-size` 是 4 行地板 83.2px)**整块落在面板可视区之下**,
 * 视图位内滚动也够不到一行完整数据行(实测 0 行)。
 *
 * **与 WP-93/94 的 harness 读数对照(同一缺陷,harness 已含但未被当作判据)**:
 * `packages/vm-ui/test/geometry` 的 harness 在 1024×768 实测
 * `byteVisibleRowCount = 2 / listClientHeight = 83`;其 `N = 4` 结论建立在
 * **列表容器高 83px ≈ 4 × 20.8px** 之上,而首个数据行实测 **43.59px**(挂跳转链)
 * ⇒ 「4 行」在真机上从未成立。本文件把判据从「容器高」改成「**完整可见行数**」,
 * 这是「按渲染结果断言」的直接后果。
 *
 * **处置(不粉饰)**:红线与目标两套件都按**实测失败形态**与登记表
 * (`KNOWN_GEOMETRY_GAPS`)逐字比对,并另加一层「实测逐类型行数 == 登记值」——
 * 缺口仍在且形态未变 ⇒ 绿;缺口被修好、或失败形态 / 行数漂移 ⇒ **红**(强制复核)。
 * 修法落在 `packages/vm-ui`(列头 / 工具区的窄档形态),**本 WP 不改产品代码**
 * ⇒ 缺口以登记表形式留档,承接方见 WP-95 报告。
 *
 * ## 反例自证(机检必须能抓到它声称要抓的东西;2026-09-18 实测)
 *
 * | # | 临时改动(模拟的回归形态) | 结果(实测) |
 * |---|---|---|
 * | ① | 红线「完整可见数据行 ≥ 1」改为 `≥ 4`(目标值) | **375×667 变红**:`Received: "…字节视图 stack 一行完整数据行都看不见(可见 1 行)"` |
 * | ② | 视图位下限改为 `clientHeight ≥ 实测 chrome + 实测行高 且 ≥ 4000` | **四档全部变红**(红线套件 4 failed) |
 * | ③ | 文档层 `scrollHeight ≤ innerHeight + 1` 改为 `≤ innerHeight − 100` | **1440×900 变红**:`Received: "D-UI-2 ③ 文档层纵向溢出 0px"` |
 * | ④ | 两半侧 1:1 断言 | **未实跑**(临时改左半侧 `min-inline-size` 需改 vm-ui 产品代码,超出本 WP 授权面)。依机制**预期**:窄档(768 / 375)变红、宽档(1440 / 1024)不变 —— `min-inline-size` 只在视口宽 < 2×452.4px 时生效;**如实登记为「未实测、按机制预期」,不冒充已测** |
 *
 * ①②③ 三次红灯均**由本文件的断言**报出(非超时 / 非选择器未命中);还原后回到基线
 * (红线 1440/375 绿、1024/768 按登记缺口;目标面同理;全套 9 passed)。
 *
 * ## 未覆盖(如实登记)
 *
 * 真后端链路(签发 → 换票 → Cookie → `create_session`)本机 **Docker 引擎不可达**
 * ⇒ 换票侧的 302 / Cookie 断言由 `apps/session-api/test/launch/**`(in-process)
 * 与 WP-97 的真机复跑承担;本文件判的是**页面侧几何**,用 Playwright 按契约形态
 * 注入 `POST /sessions` 应答(与 `page-app.spec.ts` 同一基座)。
 */
import { expect, test, type Page, type Route } from "@playwright/test";

import { launchRedeemPath } from "../src/launch-path.js";

const CHALLENGE_ID = "chal-stack-escape";
const CHALLENGE_VERSION = "1.2.3";

/** 目标行数(D-UI-2:N = 4 为目标;红线 = N ≥ 1)。 */
const TARGET_VISIBLE_HEX_ROWS = 4;
/** 红线行数(D-UI-2:N ≥ 1)。 */
const RED_LINE_VISIBLE_HEX_ROWS = 1;
/** 浮点比较容差(布局引擎回小数)。 */
const EPSILON_PX = 1;

/** 多视口矩阵(与 WP-93/94 的几何 harness 同档,便于逐值对照)。 */
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 900 },
  { width: 375, height: 667 },
] as const;

/**
 * 已登记几何缺口的**登记表**(键 = `<引擎>:<视口>`;见文件头「已登记的几何缺口」)。
 *
 * - `byteViewTypes` = 该档左半侧**渲染出**的字节视图类型(按面板顺序;栈 / 自由);
 * - `byteViewRows` = 逐类型的「完整可见数据行数」(红线与目标面失败文本共用同一读数);
 * - `redLinePanelFloorTypes` = 被压到「chrome + 1 行」之下的视图位类型;
 * - `redLineActive` = 该档红线**是否不成立**(false = 红线成立,只有目标面缺口)。
 *
 * 条目存在 = 该档按登记形态判定;不存在 = 该档必须**全绿**。
 * **引擎差异已登记**:同一视口的读数随引擎而变(webkit 折行最高 ⇒ 375 也只有 0 行)。
 */
interface KnownGeometryGap {
  readonly byteViewTypes: readonly string[];
  readonly byteViewRows: Readonly<Record<string, number>>;
  readonly redLinePanelFloorTypes: readonly string[];
  readonly redLineActive: boolean;
}

const KNOWN_GEOMETRY_GAPS: Readonly<Record<string, KnownGeometryGap>> = {
  // ── chromium(门禁口径浏览器;实测值见文件头表格)────────────────────────────
  // 1024 / 768:视图位高低于「实测 chrome + 1 行」,且两个字节视图都 0 行完整可见。
  "chromium:1024x768": {
    byteViewTypes: ["stack", "free"],
    byteViewRows: { stack: 0, free: 0 },
    redLinePanelFloorTypes: ["stack"],
    redLineActive: true,
  },
  "chromium:768x900": {
    byteViewTypes: ["stack", "free"],
    byteViewRows: { stack: 0, free: 0 },
    redLinePanelFloorTypes: ["stack"],
    redLineActive: true,
  },
  // 375:红线成立(可见 1 行),**仅**目标面不达标(N = 4 需 4 行)。
  "chromium:375x667": {
    byteViewTypes: ["stack", "free"],
    byteViewRows: { stack: 1, free: 1 },
    redLinePanelFloorTypes: [],
    redLineActive: false,
  },
  // ── firefox(实测:chrome 更低 / 视图位更高 ⇒ 1440 可见 7 行)────────────────
  "firefox:1024x768": {
    byteViewTypes: ["stack", "free"],
    byteViewRows: { stack: 0, free: 0 },
    redLinePanelFloorTypes: ["stack"],
    redLineActive: true,
  },
  "firefox:768x900": {
    byteViewTypes: ["stack", "free"],
    byteViewRows: { stack: 0, free: 0 },
    redLinePanelFloorTypes: ["stack"],
    redLineActive: true,
  },
  "firefox:375x667": {
    byteViewTypes: ["stack", "free"],
    byteViewRows: { stack: 1, free: 1 },
    redLinePanelFloorTypes: [],
    redLineActive: false,
  },
  // ── webkit(实测:chrome 最高 ⇒ 375 也只有 0 行;1024 / 768 视图位同样被压扁)──
  "webkit:1024x768": {
    byteViewTypes: ["stack", "free"],
    byteViewRows: { stack: 0, free: 0 },
    redLinePanelFloorTypes: ["stack"],
    redLineActive: true,
  },
  "webkit:768x900": {
    byteViewTypes: ["stack", "free"],
    byteViewRows: { stack: 0, free: 0 },
    redLinePanelFloorTypes: ["stack"],
    redLineActive: true,
  },
  "webkit:375x667": {
    byteViewTypes: ["stack", "free"],
    byteViewRows: { stack: 0, free: 0 },
    redLinePanelFloorTypes: [],
    redLineActive: true,
  },
};

/** 契约合法的公开投影(与 `page-app.spec.ts` 同形;栈区多行以便计数)。 */
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
      bytesHex:
        "0000000000000000111111111111111122222222222222223333333333333333" +
        "4444444444444444555555555555555566666666666666667777777777777777" +
        "88888888888888889999999999999999aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb",
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

/** 安装 `POST /sessions` 的契约形态应答(不连后端;同 `page-app.spec.ts`)。 */
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
        payload: { sessionId: "session-geometry-0001", revision: 0, projection: PROJECTION },
      }),
    });
  });
}

/** 单个视图位的真机几何读数。 */
interface PanelReading {
  readonly type: string;
  readonly clientHeight: number;
  /** 面板内实测 chrome 高 = 工具区 + 列头行(真实元素盒相加;组件无关)。 */
  readonly measuredChromePx: number;
  /** 字节视图滚动容器与视图位相交后的**可见高**(非字节视图为 -1)。 */
  readonly listViewportPx: number;
  /** 该可见窗内**完整可见**的数据行数(非字节视图为 -1)。 */
  readonly fullyVisibleHexRows: number;
  /** 实测数据行行高(px;取完整可见行中的首个,否则取首个已渲染行)。 */
  readonly measuredRowHeightPx: number;
}

/** 一次视口的全部几何读数。 */
interface GeometryReading {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly documentScrollHeight: number;
  readonly documentScrollWidth: number;
  readonly leftClientWidth: number;
  readonly rightClientWidth: number;
  readonly horizontalGapPx: number;
  readonly leftBorderPx: number;
  readonly rightBorderPx: number;
  readonly stackClientHeight: number;
  readonly stackScrollHeight: number;
  readonly panels: readonly PanelReading[];
  /** 落在左半侧滚动容器可视窗口内的视图位下标(D-UI-2「可见视图位」的判定)。 */
  readonly panelsInStackView: readonly number[];
}

/**
 * 真机几何读数(全部来自布局引擎,零常量算式参与)。
 *
 * 口径:
 *  - **可见视图位** = 面板盒与 `.ws-stack` 可视窗口相交者;
 *  - **完整可见数据行** = 行盒完全落在「`.byte-list` 盒 ∩ 视图位盒」内者 ——
 *    即「用户一眼能看见几行字节」(被裁剪的行不计入);
 *  - **实测 chrome** = `.toolbar` 盒高 + `.byte-row.header-row` 盒高。
 */
async function readGeometry(page: Page): Promise<GeometryReading> {
  return page.evaluate(() => {
    const round = (value: number): number => Math.round(value * 100) / 100;
    const workspace = document.querySelector("sm-workspace") as HTMLElement | null;
    const shadow = workspace?.shadowRoot ?? null;
    const left = shadow?.querySelector('[data-view-role="left"]') as HTMLElement | null;
    const right = shadow?.querySelector('[data-view-role="right"]') as HTMLElement | null;
    const stack = shadow?.querySelector("[data-view-stack]") as HTMLElement | null;
    const leftRect = left?.getBoundingClientRect() ?? null;
    const rightRect = right?.getBoundingClientRect() ?? null;
    const stackRect = stack?.getBoundingClientRect() ?? null;
    const borderOf = (element: HTMLElement | null): number => {
      if (element === null) {
        return -1;
      }
      const computed = getComputedStyle(element);
      return (
        Number.parseFloat(computed.borderLeftWidth) + Number.parseFloat(computed.borderRightWidth)
      );
    };
    const panels: PanelReading[] = [];
    const panelsInStackView: number[] = [];
    const panelElements = [...(shadow?.querySelectorAll(".ws-view[data-view-panel]") ?? [])];
    panelElements.forEach((element, index) => {
      const panel = element as HTMLElement;
      const box = panel.getBoundingClientRect();
      if (
        stackRect !== null &&
        box.bottom > stackRect.top + 1 &&
        box.top < stackRect.top + (stack?.clientHeight ?? 0) - 1
      ) {
        panelsInStackView.push(index);
      }
      const push = (
        measuredChromePx = -1,
        listViewportPx = -1,
        fullyVisibleHexRows = -1,
        measuredRowHeightPx = -1,
      ): void => {
        panels.push({
          type: panel.getAttribute("data-view-panel") ?? "",
          clientHeight: panel.clientHeight,
          measuredChromePx,
          listViewportPx,
          fullyVisibleHexRows,
          measuredRowHeightPx,
        });
      };
      const byteRoot = panel.querySelector("sm-byte-tab")?.shadowRoot?.querySelector("sm-byte-view")
        ?.shadowRoot as ShadowRoot | null | undefined;
      if (byteRoot === null || byteRoot === undefined) {
        push();
        return;
      }
      const toolbar = byteRoot.querySelector(".toolbar") as HTMLElement | null;
      const headerRow = byteRoot.querySelector(".byte-row.header-row") as HTMLElement | null;
      const measuredChromePx = round(
        (toolbar?.getBoundingClientRect().height ?? 0) +
          (headerRow?.getBoundingClientRect().height ?? 0),
      );
      const list = byteRoot.querySelector("sm-window-list.byte-list") as HTMLElement | null;
      if (list === null) {
        push(measuredChromePx);
        return;
      }
      const listRect = list.getBoundingClientRect();
      const dataRows = [...list.querySelectorAll(".byte-row[data-row-address]")].map((row) =>
        (row as HTMLElement).getBoundingClientRect(),
      );
      const visibleTop = Math.max(listRect.top, box.top);
      const visibleBottom = Math.min(listRect.bottom, box.bottom);
      const fullyVisible = dataRows.filter(
        (rect) =>
          rect.height > 0 && rect.top >= visibleTop - 0.5 && rect.bottom <= visibleBottom + 0.5,
      );
      const sample = fullyVisible[0] ?? dataRows.find((rect) => rect.height > 0);
      push(
        measuredChromePx,
        round(Math.max(0, visibleBottom - visibleTop)),
        fullyVisible.length,
        sample === undefined ? -1 : round(sample.height),
      );
    });
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      documentScrollWidth: document.documentElement.scrollWidth,
      leftClientWidth: left?.clientWidth ?? -1,
      rightClientWidth: right?.clientWidth ?? -1,
      horizontalGapPx:
        leftRect === null || rightRect === null ? -1 : round(rightRect.left - leftRect.right),
      leftBorderPx: borderOf(left),
      rightBorderPx: borderOf(right),
      stackClientHeight: stack?.clientHeight ?? -1,
      stackScrollHeight: stack?.scrollHeight ?? -1,
      panels,
      panelsInStackView,
    } satisfies GeometryReading;
  });
}

/** 打开启动地址(与 `page-app.spec.ts` 同路径解析;页面不读票据)。 */
async function openWorkspace(page: Page): Promise<void> {
  await page.goto(launchRedeemPath(CHALLENGE_ID, CHALLENGE_VERSION));
  await expect(page.locator("sm-workspace")).toHaveCount(1);
  await expect(page.locator("sm-workspace .ws-left [data-view-panel]").first()).toBeVisible({
    timeout: 20_000,
  });
}

/** 视口标签(`1024x768`;与 `KNOWN_GEOMETRY_GAPS` 的键同源)。 */
function viewportKey(viewport: { width: number; height: number }): string {
  return `${viewport.width}x${viewport.height}`;
}

/**
 * 登记表键 = **引擎 × 视口**(`chromium:375x667` / `webkit:375x667` …)。
 *
 * **为什么引擎进键**(2026-09-18 `E2E_MATRIX=1` 实测):**同一视口的可见行数随引擎而变** ——
 * 375×667 在 chromium 下可见 **1** 行,在 **webkit** 下可见 **0** 行(webkit 的工具栏 /
 * 列头行折行高度更大,把数据行整块推出面板)。若按「视口」单键登记,矩阵跑起来会以
 * 「形态漂移」失败 —— 那不是噪声,而是**真实差异**;故按引擎分别登记,读数各自留档。
 */
function gapKey(browserName: string, viewport: { width: number; height: number }): string {
  return `${browserName}:${viewportKey(viewport)}`;
}

/** 归集红线失败(空数组 = 红线全过)。 */
function collectRedLineFailures(reading: GeometryReading): string[] {
  const failures: string[] = [];
  if (reading.stackScrollHeight <= reading.stackClientHeight) {
    failures.push(
      `D-UI-2 ① 左半侧不是滚动容器(client=${reading.stackClientHeight} / scroll=${reading.stackScrollHeight})`,
    );
  }
  if (reading.panelsInStackView.length === 0) {
    failures.push("D-UI-2 ② 左半侧可视窗口内没有任何视图位");
    return failures;
  }
  // 视图位高度下限(chrome + 1 行)。非字节视图位没有「字节 chrome」含量面
  // ⇒ 用**同一份实测行高**作地板,不引入任何常量算式。
  const measuredRowHeightPx =
    reading.panels.find((panel) => panel.measuredRowHeightPx > 0)?.measuredRowHeightPx ?? -1;
  if (measuredRowHeightPx <= 0) {
    failures.push("D-UI-2 ② 左半侧没有实测到数据行行高(字节视图未渲染)");
  }
  for (const index of reading.panelsInStackView) {
    const panel = reading.panels[index];
    if (panel === undefined) {
      continue;
    }
    const floorPx =
      panel.measuredChromePx > 0
        ? panel.measuredChromePx + panel.measuredRowHeightPx
        : measuredRowHeightPx;
    if (panel.clientHeight < floorPx - EPSILON_PX) {
      failures.push(
        `D-UI-2 ② 视图位 ${panel.type} 被压到「chrome + 1 行字节」之下(${panel.clientHeight}px < ${floorPx}px)`,
      );
    }
  }
  const bytePanels = reading.panels.filter((panel) => panel.listViewportPx >= 0);
  if (bytePanels.length === 0) {
    failures.push("D-UI-2 ② 左半侧没有渲染任何字节视图");
  }
  for (const panel of bytePanels) {
    // 可见区为零(面板盒与列表盒不相交)= 该字节视图一行都看不见
    // (红线形态之二;它与「完整可见行数为 0」是两件事:前者连行盒都不在面板内)。
    if (panel.listViewportPx <= EPSILON_PX) {
      failures.push(
        `D-UI-2 ②(红线)字节视图 ${panel.type} 的可见区为零(面板盒与列表盒不相交)`,
      );
    }
    if (panel.fullyVisibleHexRows < RED_LINE_VISIBLE_HEX_ROWS) {
      failures.push(
        `D-UI-2 ②(红线)字节视图 ${panel.type} 一行完整数据行都看不见(可见 ${panel.fullyVisibleHexRows} 行)`,
      );
    }
  }
  if (reading.documentScrollHeight > reading.innerHeight + 1) {
    failures.push(
      `D-UI-2 ③ 文档层纵向溢出 ${reading.documentScrollHeight - reading.innerHeight}px`,
    );
  }
  if (Math.abs(reading.leftClientWidth - reading.rightClientWidth) !== 0) {
    failures.push(
      `D-UI-1 两半侧非 1:1(left=${reading.leftClientWidth} / right=${reading.rightClientWidth})`,
    );
  }
  if (reading.horizontalGapPx !== 0) {
    failures.push(`D-UI-1 两半侧之间出现间隙 ${reading.horizontalGapPx}px`);
  }
  if (reading.leftBorderPx !== 0 || reading.rightBorderPx !== 0) {
    failures.push(
      `D-UI-1 出现边框(left=${reading.leftBorderPx} / right=${reading.rightBorderPx})`,
    );
  }
  return failures;
}

/** 归集目标面失败(N = 4;空数组 = 目标达成)。 */
function collectTargetFailures(reading: GeometryReading): string[] {
  const failures: string[] = [];
  for (const panel of reading.panels.filter((candidate) => candidate.listViewportPx >= 0)) {
    if (panel.fullyVisibleHexRows < TARGET_VISIBLE_HEX_ROWS) {
      failures.push(targetFailureText(panel, reading));
    }
  }
  return failures;
}

/**
 * 登记读数一致性(**显式失败通道**)。
 *
 * 失败文本里带的是**实测**行数 ⇒ 若只比对文本,「登记 0 行、实测 3 行」也会因为
 * 两边都由实测渲染而**假绿**。故另加一层:实测逐类型行数必须**等于**登记值
 * (偏离即「状态已变、须复核」)。
 */
function assertRegisteredRowCounts(key: string, reading: GeometryReading): void {
  const gap = KNOWN_GEOMETRY_GAPS[key];
  if (gap === undefined) {
    return;
  }
  const measured: Record<string, number> = {};
  for (const panel of reading.panels.filter((candidate) => candidate.listViewportPx >= 0)) {
    measured[panel.type] = panel.fullyVisibleHexRows;
  }
  expect(
    measured,
    `已登记缺口档 ${key} 的实测逐类型可见行数偏离登记值(登记 ${JSON.stringify(gap.byteViewRows)})⇒ 状态已变,请复核`,
  ).toEqual(gap.byteViewRows);
  expect(
    Object.keys(measured).sort(),
    `已登记缺口档 ${key} 渲染出的字节视图类型集合与登记表不符(登记 ${JSON.stringify(gap.byteViewTypes)})`,
  ).toEqual([...gap.byteViewTypes].sort());
}

/** 目标面失败文本的**规范形态**(与 `collectTargetFailures` 逐字同源)。 */
function targetFailureText(panel: PanelReading, reading: GeometryReading): string {
  void reading;
  return `字节视图 ${panel.type} 完整可见数据行 ${panel.fullyVisibleHexRows} 行(< ${TARGET_VISIBLE_HEX_ROWS};清单高 ${panel.listViewportPx}px / 实测行高 ${panel.measuredRowHeightPx}px)`;
}

/** 红线失败文本的**规范形态**之一(视图位被压扁;与 `collectRedLineFailures` 同源)。 */
function redLinePanelFloorText(type: string, reading: GeometryReading): string {
  const panel = reading.panels.find((candidate) => candidate.type === type);
  const floorPx =
    panel !== undefined && panel.measuredChromePx > 0
      ? panel.measuredChromePx + panel.measuredRowHeightPx
      : -1;
  return `D-UI-2 ② 视图位 ${type} 被压到「chrome + 1 行字节」之下(${panel?.clientHeight ?? -1}px < ${floorPx}px)`;
}

/** 红线失败文本的**规范形态**之二(字节视图一行都看不见)。 */
function redLineRowText(type: string, visibleRows: number): string {
  return `D-UI-2 ②(红线)字节视图 ${type} 一行完整数据行都看不见(可见 ${visibleRows} 行)`;
}

/** 红线失败文本的**规范形态**之三(可见区为零:面板盒与列表盒不相交)。 */
function redLineZeroViewportText(type: string): string {
  return `D-UI-2 ②(红线)字节视图 ${type} 的可见区为零(面板盒与列表盒不相交)`;
}

/**
 * 按登记表渲染该档**应有**的红线失败文本(红线成立的档 = 空数组)。
 *
 * 顺序与 `collectRedLineFailures` **逐段一致**:先「视图位被压扁」(按可见视图位
 * 顺序),再逐字节视图「可见区为零」+「一行都看不见」(按面板顺序)。
 */
function expectedRedLineFailures(key: string, reading: GeometryReading): string[] {
  const gap = KNOWN_GEOMETRY_GAPS[key];
  if (gap === undefined || !gap.redLineActive) {
    return [];
  }
  const rowFailures: string[] = [];
  for (const panel of reading.panels.filter((candidate) => candidate.listViewportPx >= 0)) {
    if (panel.listViewportPx <= EPSILON_PX) {
      rowFailures.push(redLineZeroViewportText(panel.type));
    }
    const registered = gap.byteViewRows[panel.type];
    if (registered !== undefined && registered < RED_LINE_VISIBLE_HEX_ROWS) {
      rowFailures.push(redLineRowText(panel.type, registered));
    }
  }
  return [
    ...gap.redLinePanelFloorTypes.map((type) => redLinePanelFloorText(type, reading)),
    ...rowFailures,
  ];
}

/** 按登记表渲染该档**应有**的目标面失败文本(仅列登记了读数的字节视图类型)。 */
function expectedTargetFailures(key: string, reading: GeometryReading): string[] {
  const gap = KNOWN_GEOMETRY_GAPS[key];
  if (gap === undefined) {
    return [];
  }
  return reading.panels
    .filter((panel) => panel.listViewportPx >= 0 && gap.byteViewRows[panel.type] !== undefined)
    .map((panel) => targetFailureText(panel, reading));
}

/**
 * 已登记缺口档的**失败形态登记断言**(不使用 `test.fail()`)。
 *
 * ## 为什么不用 `test.fail()`(实测结论,勿回退)
 *
 * `test.fail(condition)` 的语义是「该用例**必须**失败」:用例体一路跑到结尾
 * (哪怕全部断言都通过)会被判为 **unexpected pass**。而登记缺口档的理想结局正是
 * 「跑完且一致」⇒ 二者直接冲突。实测还发现(playwright 1.63):在 `test.fail()`
 * 标注的用例里,`expect(...).toEqual(...)` 的**失败不抛错**(同一段代码在未标注的
 * 用例里正常抛)⇒ 「读数与登记不符」会被静默吞掉,正是本仓库反复登记的那类假绿。
 *
 * ⇒ 处置:**登记缺口档断言「失败形态恰好等于登记表」**(相等即绿):
 *  - 缺口仍在、形态未变 ⇒ 绿(当前基线);
 *  - 缺口被修好、或失败形态漂移 ⇒ **红**(强制复核并更新登记表)。
 */
function assertRegisteredFailureShape(
  key: string,
  failures: readonly string[],
  expected: readonly string[],
): void {
  expect(
    failures.join("\n"),
    `已登记几何缺口 ${key} 的失败形态必须与登记表逐字一致 ⇒ 不一致 = 状态已变,请复核 KNOWN_GEOMETRY_GAPS`,
  ).toBe(expected.join("\n"));
}

test.describe("几何护栏(红线:每个视图位 ≥ chrome + 1 行字节,字节视图 ≥ 1 行)", () => {
  for (const viewport of VIEWPORTS) {
    const label = viewportKey(viewport);
    test(`${label}:左半侧滚动 + 视图位可读红线 + 整页不溢出 + 两半侧 1:1`, async ({
      page,
      browserName,
    }) => {
      const key = gapKey(browserName, viewport);
      const knownGap = KNOWN_GEOMETRY_GAPS[key];
      await page.setViewportSize(viewport);
      await installCreateSessionStub(page);
      await openWorkspace(page);

      const reading = await readGeometry(page);
      // 真机读数留档(验收证据;断言在下方)。
      console.log(`[geometry-guard:${key}] ${JSON.stringify(reading)}`);

      const failures = collectRedLineFailures(reading);
      if (knownGap === undefined) {
        expect(failures.join("\n")).toBe("");
        return;
      }
      assertRegisteredFailureShape(key, failures, expectedRedLineFailures(key, reading));
      assertRegisteredRowCounts(key, reading);
    });
  }

  test("窄档(375×667):页面横向滚动使右半侧可达(D-UI-5 回归护栏)", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await installCreateSessionStub(page);
    await openWorkspace(page);

    const reading = await readGeometry(page);
    expect(
      reading.documentScrollWidth - reading.innerWidth,
      "窄档未产生横向滚动 ⇒ 右半侧被裁剪(overflow:hidden 升格回归)",
    ).toBeGreaterThan(0);

    const right = page.locator("sm-workspace .ws-right");
    await right.scrollIntoViewIfNeeded();
    await expect(right).toBeInViewport();
  });
});

test.describe("几何护栏(目标面:N = 4 行)", () => {
  for (const viewport of VIEWPORTS) {
    const label = viewportKey(viewport);
    test(`${label}:字节视图完整可见数据行 ≥ ${TARGET_VISIBLE_HEX_ROWS}`, async ({
      page,
      browserName,
    }) => {
      const key = gapKey(browserName, viewport);
      const knownGap = KNOWN_GEOMETRY_GAPS[key];
      await page.setViewportSize(viewport);
      await installCreateSessionStub(page);
      await openWorkspace(page);

      const reading = await readGeometry(page);
      const failures = collectTargetFailures(reading);
      if (knownGap === undefined) {
        // 未登记缺口的档:目标面必须达成。
        expect(failures.join("\n")).toBe("");
        return;
      }
      // 已登记缺口的档:失败形态必须与登记表逐字一致(见函数文档)。
      assertRegisteredFailureShape(key, failures, expectedTargetFailures(key, reading));
      assertRegisteredRowCounts(key, reading);
    });
  }
});

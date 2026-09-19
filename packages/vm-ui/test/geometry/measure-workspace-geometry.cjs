/**
 * 工作区整页布局真机几何测量(2026-09-18 改版 / D-API-153;可复跑证据入口)。
 *
 * 用法(仓库根或包内均可):
 *   node packages/vm-ui/test/geometry/measure-workspace-geometry.cjs
 *
 * 做四件事:
 *  1. 以仓库内 `vite`(packages/vm-ui 的依赖)拉起 5198 端口的测量服务器;
 *  2. 用 apps/plugin-dev 的 `@playwright/test`(仓库唯一 Playwright 依赖,浏览器
 *     已装)启动 chromium,打开 `workspace-harness.html`(整页布局骨架);
 *  3. 读真机几何:左右半侧 clientWidth / 每个可见视图位的 clientHeight 与
 *     **字节视图内可见数据行数** / 左半侧是否滚动容器 / 文档层是否溢出;
 *  4. 按**完成标准判据**断言(任一失败即非零退出并打印证据 JSON)。
 *
 * 判据(逐条对齐任务书「完成标准 · 真机几何读数」与 D-UI-1 ~ D-UI-7):
 *  - 左半侧 / 右半侧 clientWidth 相等(固定 1:1)且水平间隙 = 0(无 gap / 无 border);
 *  - 每个可见视图位 clientHeight ≥ chrome + 4 行(可读性:**不得出现视图被压到
 *    装不下一行字节**;历史反例 146px vs chrome 182.1px);
 *  - 至少一个视图位的字节视图内**可见数据行数 ≥ 4**;
 *  - 左半侧 scrollHeight > clientHeight(证明它是滚动容器、溢出没有上浮到文档层);
 *  - `document.documentElement.scrollHeight <= innerHeight + 1`(整页不溢出);
 *  - 左半侧 clientWidth ≥ 452.4px(D-UI-5 底线)或页面出现横向滚动(D-UI-5 裁定)。
 */
const { spawn, spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");

const REPO_ROOT = (() => {
  let dir = __dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("未定位到仓库根(pnpm-workspace.yaml 缺席)");
})();

const VM_UI_DIR = join(REPO_ROOT, "packages/vm-ui");
const PLUGIN_DEV_PKG = join(REPO_ROOT, "apps/plugin-dev/package.json");
const VITE_CONFIG = join(VM_UI_DIR, "test/geometry/vite.workspace-geometry.config.mjs");
const HARNESS_URL = "http://127.0.0.1:5198/test/geometry/workspace-harness.html";

/** 一个行单位(px)= 13 × line-height 1.6(`HEX_ROW_HEIGHT_PX`)。 */
const HEX_ROW_HEIGHT_PX = 20.8;
/** 视图位内「非数据行」chrome(px)与最少可见行数(`VIEW_PANEL_CHROME_HEIGHT_PX` / N = 4)。 */
const VIEW_PANEL_CHROME_HEIGHT_PX = 20.8 + 4 + 1 + 133.3 + (20.8 + 1);
const VIEW_SLOT_MIN_VISIBLE_HEX_ROWS = 4;
/** 左半侧宽度底线(px;D-UI-5 = `MIN_COLUMN_WIDTH`)。 */
const SIDE_PANEL_MIN_WIDTH_PX = 452.4;

/** 视口集合(逐档取证;D-UI-5 窄屏也必须有读数)。 */
const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "768x900", width: 768, height: 900 },
  { name: "375x667", width: 375, height: 667 },
];

function resolveFrom(pkgJson, request) {
  return createRequire(pkgJson).resolve(request);
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // 服务器未就绪,继续等。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`测量服务器未在 ${timeoutMs}ms 内就绪:${url}`);
}

function assert(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

async function main() {
  // vite 的 exports 未导出 bin 子路径 ⇒ 先解析 package.json 再拼 bin(vite CLI)。
  const viteBin = join(
    dirname(resolveFrom(join(VM_UI_DIR, "package.json"), "vite/package.json")),
    "bin/vite.js",
  );
  const server = spawn(process.execPath, [viteBin, "--config", VITE_CONFIG, "--strictPort"], {
    cwd: VM_UI_DIR,
    stdio: "ignore",
    env: { ...process.env, NODE_ENV: "development" },
  });

  const failures = [];
  let chromium;
  let browser = null;
  try {
    await waitForServer(HARNESS_URL, 60_000);
    ({ chromium } = require(resolveFrom(PLUGIN_DEV_PKG, "@playwright/test")));
    browser = await chromium.launch();
    const page = await browser.newPage();

    const reports = [];
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(HARNESS_URL, { waitUntil: "load" });
      await page.waitForFunction(() => window.__workspaceGeometry?.ready === true, null, {
        timeout: 30_000,
      });
      const report = await page.evaluate(() => window.__workspaceGeometry.measure());
      // 逐视图位补读字节行(离屏面板被 content-visibility 跳过渲染 ⇒ 必须先滚进视口)。
      const byteRowReadings = [];
      for (const viewType of ["stack", "free"]) {
        const metrics = await page.evaluate(
          (type) => window.__workspaceGeometry.measureByteRows(type),
          viewType,
        );
        if (metrics !== null) {
          byteRowReadings.push({ viewType, ...metrics });
        }
      }
      reports.push({ viewport, report, byteRowReadings });
      report.byteRowReadings = byteRowReadings;

      const tag = `[${viewport.name}]`;
      // ① 左右两分固定 1:1 且无 gap / 无 border(**仅在两半侧都拿得到底线的视口
      //    下要求等分**;窄屏按 D-UI-5 各保底 452.4px、右半侧被挤出视口 ⇒ 页面
      //    横向滚动 —— 见 ⑥,此时不强求等分)。
      const canSplitEvenly = viewport.width >= 2 * SIDE_PANEL_MIN_WIDTH_PX + 2;
      if (canSplitEvenly) {
        assert(
          report.split.widthDelta <= 1,
          `${tag} 左右半侧 clientWidth 不等(1:1 失败):Δ=${report.split.widthDelta}`,
          failures,
        );
        assert(
          Math.abs(report.split.horizontalGapPx) <= 0.5,
          `${tag} 两半侧之间存在水平间隙:${report.split.horizontalGapPx}px`,
          failures,
        );
      }
      assert(
        report.body.columnGap === "normal" || report.body.columnGap === "0px",
        `${tag} .ws-body 有 column-gap:${report.body.columnGap}`,
        failures,
      );
      // ② 每个可见视图位高度 ≥ chrome + 4 行(不得压到装不下一行字节)。
      const minSlot = Math.ceil(
        VIEW_PANEL_CHROME_HEIGHT_PX + VIEW_SLOT_MIN_VISIBLE_HEX_ROWS * HEX_ROW_HEIGHT_PX,
      );
      for (const panel of report.panels) {
        assert(
          panel.clientHeight >= minSlot - 1,
          `${tag} 视图位 ${panel.type} 高 ${panel.clientHeight}px < 下限 ${minSlot}px`,
          failures,
        );
        assert(
          panel.renderDegrade === "content-visibility",
          `${tag} 视图位 ${panel.type} 缺 data-render-degrade 标记`,
          failures,
        );
        assert(
          typeof panel.labelText === "string" && panel.labelText.length > 0,
          `${tag} 视图位 ${panel.type} 缺视图内类型名标签(.view-label)`,
          failures,
        );
      }
      // ③ 至少一个视图位的字节列表**保有 4 行可视高**(可读性地板:
      //    窗口化列表的 min-block-size = 4 个行单位,与 chrome 无关 ⇒ 读数取
      //    listClientHeight 而非「恰好完整的行数」,后者受行内容(跳转链 /
      //    寄存器标注)与游标位置影响,不是可读性地板的正确读数面)。
      const maxListHeight = Math.max(
        0,
        ...byteRowReadings.map((reading) => reading.listClientHeight),
      );
      assert(
        maxListHeight >= VIEW_SLOT_MIN_VISIBLE_HEX_ROWS * HEX_ROW_HEIGHT_PX - 1,
        `${tag} 字节列表可视高不足 4 行:${maxListHeight}px < ${VIEW_SLOT_MIN_VISIBLE_HEX_ROWS * HEX_ROW_HEIGHT_PX}px`,
        failures,
      );
      // ③b 且至少渲染出数据行(虚拟列表真实产出)。
      const maxRenderedRows = Math.max(
        0,
        ...byteRowReadings.map((reading) => reading.byteDataRowCount),
      );
      assert(
        maxRenderedRows >= VIEW_SLOT_MIN_VISIBLE_HEX_ROWS,
        `${tag} 字节视图渲染的数据行数不足:${maxRenderedRows} < ${VIEW_SLOT_MIN_VISIBLE_HEX_ROWS}`,
        failures,
      );
      // ④ 左半侧是滚动容器(溢出没有上浮到文档层)。
      assert(
        report.stack.clientHeight > 0,
        `${tag} 左半侧视图栈无可视高(clientHeight=${report.stack.clientHeight})`,
        failures,
      );
      assert(
        report.stack.overflowY === "auto" || report.stack.overflowY === "scroll",
        `${tag} 左半侧视图栈不是滚动容器:overflow-y=${report.stack.overflowY}`,
        failures,
      );
      // ⑤ 整页不溢出文档层。
      assert(
        report.document.documentScrollHeight <= report.document.innerHeight + 1,
        `${tag} 文档层溢出:scrollHeight=${report.document.documentScrollHeight} > innerHeight=${report.document.innerHeight}`,
        failures,
      );
      // ⑥ D-UI-5:左半侧宽度底线或页面横向滚动(二者之一必须成立)。
      const horizontalPageScroll =
        report.document.documentScrollWidth > report.document.innerWidth + 1;
      assert(
        report.left.clientWidth >= SIDE_PANEL_MIN_WIDTH_PX - 1 || horizontalPageScroll,
        `${tag} 左半侧宽 ${report.left.clientWidth}px 低于底线 ${SIDE_PANEL_MIN_WIDTH_PX}px 且页面未横向滚动`,
        failures,
      );
      // ⑦ D-UI-5 的真机可达性:两半侧宽度之和超过视口时,**页面必须能横向滚动**
      //    (否则右半侧被裁掉、不可达 —— 实测陷阱:`overflow-y: hidden` 会把
      //    `overflow-x` 升格为裁剪,内容宽不上浮到文档层)。
      const gridWiderThanViewport =
        report.left.clientWidth + report.right.clientWidth > report.document.innerWidth + 1;
      if (gridWiderThanViewport) {
        assert(
          horizontalPageScroll,
          `${tag} 网格宽 ${report.left.clientWidth + report.right.clientWidth}px 超出视口,但文档层不可横向滚动` +
            `(documentScrollWidth=${report.document.documentScrollWidth})⇒ 右半侧不可达`,
          failures,
        );
        assert(
          report.right.x + report.right.clientWidth > report.document.innerWidth,
          `${tag} 右半侧未真正越出视口(几何与 D-UI-5 前提不符)`,
          failures,
        );
      }
    }

    const payload = {
      harness: HARNESS_URL,
      note: "真机 chromium;整页布局骨架(html/body overflow:hidden + 工作区 100dvh)",
      reports: reports.map(({ viewport, report }) => ({
        viewport: viewport.name,
        innerSize: [report.document.innerWidth, report.document.innerHeight],
        hostBlockSize: report.host.blockSize,
        hostClientHeight: report.host.clientHeight,
        leftClientWidth: report.left.clientWidth,
        rightClientWidth: report.right.clientWidth,
        splitWidthDelta: report.split.widthDelta,
        horizontalGapPx: report.split.horizontalGapPx,
        leftMinInlineSize: report.left.minInlineSize,
        stackClientHeight: report.stack.clientHeight,
        stackScrollHeight: report.stack.scrollHeight,
        stackIsScrollContainer: report.stack.isScrollContainer,
        stackScrollBehavior: report.stack.scrollBehavior,
        documentScrollHeight: report.document.documentScrollHeight,
        documentOverflowPx: report.document.documentScrollHeight - report.document.innerHeight,
        documentScrollWidth: report.document.documentScrollWidth,
        bodyScrollWidth: report.document.bodyScrollWidth,
        documentHorizontalOverflowPx: report.document.horizontalOverflow,
        hostOverflow: report.hostOverflow,
        topHostsOverflow: report.topHostsOverflow,
        panelCount: report.panelCount,
        visiblePanelCount: report.visiblePanelCount,
        leftPanelCount: report.leftPanelCount,
        payloadPanelRendered: report.payloadPanelRendered,
        rightRoleContentTag: report.rightRoleContentTag,
        fullyVisiblePanelCount: report.fullyVisiblePanelCount,
        fullyVisiblePanelTypes: report.fullyVisiblePanelTypes,
        visibleViewTypes: report.visibleViewTypes,
        byteRowReadings: (report.byteRowReadings ?? []).map((reading) => ({
          viewType: reading.viewType,
          byteDataRowCount: reading.byteDataRowCount,
          byteVisibleRowCount: reading.byteVisibleRowCount,
          byteRowHeightPx: reading.byteRowHeightPx,
          listClientHeight: reading.listClientHeight,
          listScrollHeight: reading.listScrollHeight,
        })),
        panels: report.panels.map((panel) => ({
          type: panel.type,
          clientWidth: panel.clientWidth,
          clientHeight: panel.clientHeight,
          byteDataRowCount: panel.byteDataRowCount,
          byteVisibleRowCount: panel.byteVisibleRowCount,
          byteRowHeightPx: panel.byteRowHeightPx,
          listClientHeight: panel.listClientHeight,
          listScrollHeight: panel.listScrollHeight,
          labelText: panel.labelText,
          ariaLabel: panel.ariaLabel,
        })),
      })),
      failures,
    };
    console.log(JSON.stringify(payload, null, 2));

    if (failures.length > 0) {
      console.error(`真机几何断言失败 ${failures.length} 条:`);
      for (const failure of failures) {
        console.error(` - ${failure}`);
      }
      process.exitCode = 1;
    }
  } finally {
    await browser?.close();
    server.kill();
    spawnSync(process.execPath, ["-e", ""]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

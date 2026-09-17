/**
 * 指令视图行高真机几何测量(M3 遗留-5 ①,可复跑证据入口)。
 *
 * 用法(仓库根或包内均可):
 *   node packages/vm-ui/test/geometry/measure-instruction-geometry.cjs
 *
 * 做四件事:
 *  1. 以仓库内 `vite`(packages/vm-ui 的依赖)拉起 5199 端口的测量服务器;
 *  2. 用 apps/plugin-dev 的 `@playwright/test`(仓库唯一 Playwright 依赖,浏览器
 *     已装)启动 chromium,分别打开 `?variant=current`(当前源码)与
 *     `?variant=prefix`(修复前构建产物)两个形态;
 *  3. 在同一页面骨架 / 同一 CSS / 同一数据夹具下测量行高、真行盒数、一屏行数、
 *     锚点行可见比例;
 *  4. 按**收紧后的阈值**断言(修复前形态只作对照读数,不作为通过条件),
 *     任一断言失败即非零退出并打印证据 JSON。
 *
 * 修复前形态取自 `dist/sm-workspace-CpaZ0UGg.js`(2026-09-17 17:15 的构建产物,
 * 模板空白未收窄);若该产物已被后续构建清理,脚本明确报错而非静默降级。
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
const PREFIX_BUILD = join(VM_UI_DIR, "dist/sm-workspace-CpaZ0UGg.js");
const HARNESS_URL = "http://127.0.0.1:5199/test/geometry/harness.html";

/** 收紧后的断言阈值(修复后形态必须全部满足)。 */
const EXPECT = {
  rowHeightMin: 20.8, // 13px × line-height 1.6 = 20.8px(一个行盒)
  rowHeightMax: 28,
  maxLineBoxes: 1.05,
  minRowsInM2Panel: 8,
  minAnchorVisibleRatioInList: 0.9,
};
/** 修复前对照读数(仅登记期望量级,不作通过条件,但必须显著劣于修复后)。 */
const EXPECT_PREFIX = {
  minRowHeight: 90,
  maxRowsInM2Panel: 2.2,
  minAddressLineBoxes: 3,
  minAnnotationLineBoxes: 3,
};

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

function killTree(pid) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // 已退出。
    }
  }
}

function check(results) {
  const failures = [];
  const note = (ok, message) => {
    if (!ok) {
      failures.push(message);
    }
    console.log(`${ok ? "PASS" : "FAIL"} ${message}`);
  };

  const current = results.current;
  const prefix = results.prefix;

  note(
    current.plainRow.height >= EXPECT.rowHeightMin && current.plainRow.height <= EXPECT.rowHeightMax,
    `修复后行高 ${current.plainRow.height}px ∈ [${EXPECT.rowHeightMin}, ${EXPECT.rowHeightMax}]`,
  );
  for (const [name, cell] of Object.entries(current.plainRow.cells)) {
    note(
      cell !== null && cell.geometricLineBoxes <= EXPECT.maxLineBoxes,
      `修复后 ${name} 几何行盒 = ${cell?.geometricLineBoxes}(要求 ≤ ${EXPECT.maxLineBoxes})`,
    );
  }
  const currentNewlineCells = {
    "地址列": current.plainRow.cells.address,
    "伪机器码列": current.plainRow.cells.bytes,
    "断点按钮": current.plainRow.cells.breakpointButton,
    "锚点行寄存器标注": current.anchorRow.cells.annotation,
    "锚点行地址列": current.anchorRow.cells.address,
  };
  for (const [name, cell] of Object.entries(currentNewlineCells)) {
    note(
      cell !== null && cell.preservedNewlines === 0,
      `修复后 ${name} 保留换行数 = ${cell?.preservedNewlines}(要求 0:pre 单元格内零幻影换行)`,
    );
  }
  note(
    current.rowsPerScreen.inM2Panel >= EXPECT.minRowsInM2Panel,
    `修复后一屏行数(面板 231px) = ${current.rowsPerScreen.inM2Panel}(要求 ≥ ${EXPECT.minRowsInM2Panel})`,
  );
  note(
    current.anchorRow.visibleRatioInList >= EXPECT.minAnchorVisibleRatioInList,
    `修复后锚点行列表内可见比例 = ${current.anchorRow.visibleRatioInList}(要求 ≥ ${EXPECT.minAnchorVisibleRatioInList})`,
  );
  note(
    current.headerRowHeight > 0 &&
      Math.abs(current.headerRowHeight - current.plainRow.height) <= 8,
    `修复后数据行高(${current.plainRow.height}px)与表头行高(${current.headerRowHeight}px)同量级`,
  );

  note(
    prefix.plainRow.height >= EXPECT_PREFIX.minRowHeight,
    `修复前对照:行高 ${prefix.plainRow.height}px(期望 ≥ ${EXPECT_PREFIX.minRowHeight},复现 M2 记录的 113px 量级)`,
  );
  note(
    prefix.rowsPerScreen.inM2Panel <= EXPECT_PREFIX.maxRowsInM2Panel,
    `修复前对照:一屏行数 = ${prefix.rowsPerScreen.inM2Panel}(期望 ≤ ${EXPECT_PREFIX.maxRowsInM2Panel},复现「一屏 ≈1.5 行」)`,
  );
  note(
    (prefix.plainRow.cells.address?.geometricLineBoxes ?? 0) >= EXPECT_PREFIX.minAddressLineBoxes,
    `修复前对照:地址列几何行盒 = ${prefix.plainRow.cells.address?.geometricLineBoxes}(期望 ≥ ${EXPECT_PREFIX.minAddressLineBoxes})`,
  );
  note(
    (prefix.plainRow.cells.address?.preservedNewlines ?? 0) >= 4,
    `修复前对照:地址列保留换行数 = ${prefix.plainRow.cells.address?.preservedNewlines}(期望 ≥ 4)`,
  );
  note(
    (prefix.anchorRow.cells.annotation?.preservedNewlines ?? 0) >= 2,
    `修复前对照:锚点行标注保留换行数 = ${prefix.anchorRow.cells.annotation?.preservedNewlines}(期望 ≥ 2)`,
  );
  note(
    (prefix.anchorRow.cells.annotation?.geometricLineBoxes ?? 0) >=
      EXPECT_PREFIX.minAnnotationLineBoxes,
    `修复前对照:锚点行标注几何行盒 = ${prefix.anchorRow.cells.annotation?.geometricLineBoxes}(期望 ≥ ${EXPECT_PREFIX.minAnnotationLineBoxes})`,
  );
  note(
    current.plainRow.height * 4 <= prefix.plainRow.height,
    `修复后行高 ≤ 修复前 / 4(${current.plainRow.height} × 4 ≤ ${prefix.plainRow.height})`,
  );

  return failures;
}

async function main() {
  if (!existsSync(PREFIX_BUILD)) {
    throw new Error(
      `修复前对照构建产物缺席:${PREFIX_BUILD}\n` +
        "该文件是 2026-09-17 17:15 的修复前构建(模板空白未收窄),被后续构建覆盖/清理后本测量无法给出「修复前」读数。",
    );
  }

  // vite 的 exports 未导出 bin 子路径 ⇒ 先解析 package.json 再拼 bin(vite CLI)。
  const viteBin = join(
    dirname(resolveFrom(join(VM_UI_DIR, "package.json"), "vite/package.json")),
    "bin/vite.js",
  );
  const playwright = createRequire(PLUGIN_DEV_PKG)("@playwright/test");
  const { chromium } = playwright;

  const server = spawn(
    process.execPath,
    [viteBin, "--config", "test/geometry/vite.geometry.config.mjs", "--strictPort"],
    { cwd: VM_UI_DIR, stdio: "inherit" },
  );

  let browser = null;
  try {
    await waitForServer(HARNESS_URL, 90_000);
    browser = await chromium.launch({ headless: true });
    const results = {};
    for (const variant of ["current", "prefix"]) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const consoleErrors = [];
      page.on("pageerror", (error) => consoleErrors.push(String(error)));
      await page.goto(`${HARNESS_URL}?variant=${variant}`, { waitUntil: "load" });
      await page.waitForFunction(() => window.__geometry?.ready === true, null, { timeout: 30_000 });
      const report = await page.evaluate(() => window.__geometry.measure());
      await page.close();
      if (consoleErrors.length > 0) {
        throw new Error(`[${variant}] 夹具页面报错:${consoleErrors.join(" | ")}`);
      }
      results[variant] = report;
    }

    console.log("\n=== 真机几何证据(JSON) ===");
    console.log(JSON.stringify(results, null, 2));
    console.log("\n=== 阈值断言 ===");
    const failures = check(results);
    if (failures.length > 0) {
      console.error(`\n[geometry] ${failures.length} 项断言未通过`);
      process.exitCode = 1;
      return;
    }
    console.log("\n[geometry] 全部断言通过");
  } finally {
    if (browser !== null) {
      await browser.close();
    }
    killTree(server.pid);
  }
}

main().catch((error) => {
  console.error(`[geometry] 测量失败:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

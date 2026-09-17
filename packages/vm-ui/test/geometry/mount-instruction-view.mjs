/* global document, window, location, customElements, IntersectionObserver, getComputedStyle, requestAnimationFrame, URLSearchParams */
/**
 * 指令视图真机几何夹具(M3 遗留-5 ①)。
 *
 * 页面按 `?variant=current|prefix` 装载**同一组件的两个形态**:
 *  - `current` = 当前源码(`/src/views/instruction/sm-instruction-view.ts`);
 *  - `prefix`  = 修复前构建产物(`/dist/sm-workspace-CpaZ0UGg.js`,2026-09-17
 *    17:15,模板字面空白未收窄的形态;其 `.row-address` 字面量见该文件
 *    31311~31327 行)。
 *
 * 数据夹具 = 调试档数据源的 duck-typing 替身(与
 * `test/views/instruction/sm-instruction-view.test.ts#FakeDebugSource` 同口径):
 * 40 条指令 + RIP 锚点落在第 25 条(0x401060)+ 该行一个寄存器交叉标注。
 *
 * 测量口径(全部真机 DOM 几何,不用 jsdom 行盒代理):
 *  - `rowHeight` = 首个数据行的 `getBoundingClientRect().height`;
 *  - `lineBoxes` = `Range.getClientRects()` 去重后的行盒个数(真行盒计数);
 *  - `rowsPerScreen` = 列表视口高 / 行高;`rowsInM2Panel` = 231 / 行高(M2 记录
 *    的应用内面板高 231px);
 *  - `anchorVisibleRatio` = IntersectionObserver(root=null)的 `intersectionRatio`,
 *    与 Playwright `toBeInViewport` 同语义(祖先裁剪参与计算),读数前调用
 *    视图自身的锚点滚动路径 `list.scrollToIndex(anchorIndex, "center")`。
 */
const params = new URLSearchParams(location.search);
const variant = params.get("variant") === "prefix" ? "prefix" : "current";

/** 修复前构建产物(修复前形态;注释见文件头)。 */
const PREFIX_BUILD = "/dist/sm-workspace-CpaZ0UGg.js";
/** 当前源码(修复后形态)。 */
const CURRENT_SOURCE = "/src/views/instruction/sm-instruction-view.ts";

const ANCHOR_ADDRESS = "0x401060";
const ROW_COUNT = 40;
/** M2 真机记录的应用内指令窗口面板高度(px)。 */
const M2_PANEL_HEIGHT = 231;

function addressAt(index) {
  return `0x${(0x401000 + index * 4).toString(16)}`;
}

/** 调试档数据源替身(duck-typing:视图只消费这些面)。 */
class FakeDebugSource {
  constructor() {
    this.rows = [];
    for (let index = 0; index < ROW_COUNT; index += 1) {
      this.rows.push({
        addressHex: addressAt(index),
        bytesHex: index % 3 === 0 ? "4889e5" : index % 3 === 1 ? "c3" : undefined,
        text: index === 12 ? "call 0x401060" : index % 2 === 0 ? "mov eax, ebx" : "add rsp, 8",
        ...(index === 12 ? { jumpTargetHex: ANCHOR_ADDRESS } : {}),
      });
    }
    this.breakpoints = [ANCHOR_ADDRESS];
    this.pausedAddressHex = ANCHOR_ADDRESS;
    this.paused = null;
    this.attached = null;
    this.functions = [];
    this.listeners = [];
  }

  onChange(listener) {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    };
  }

  emit() {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  async prefetchWindow(addressHex) {
    return { addressHex, bytesHex: "00" };
  }

  async searchAllMemory() {
    return { hits: [], truncated: false };
  }

  toggleBreakpoint(addressHex) {
    this.breakpoints = this.breakpoints.includes(addressHex)
      ? this.breakpoints.filter((entry) => entry !== addressHex)
      : [...this.breakpoints, addressHex];
    this.emit();
  }

  addBreakpoint(addressHex) {
    if (!this.breakpoints.includes(addressHex)) {
      this.breakpoints = [...this.breakpoints, addressHex];
      this.emit();
    }
  }

  removeBreakpoint(addressHex) {
    this.breakpoints = this.breakpoints.filter((entry) => entry !== addressHex);
    this.emit();
  }

  isBreakpoint(addressHex) {
    return this.breakpoints.includes(addressHex);
  }

  get breakpointCount() {
    return this.breakpoints.length;
  }

  instructions() {
    return [...this.rows];
  }

  instructionAt(addressHex) {
    return this.rows.find((entry) => entry.addressHex === addressHex) ?? null;
  }

  instructionStream(range) {
    return this.rows
      .filter(
        (entry) =>
          BigInt(entry.addressHex) >= BigInt(range.startAddressHex) &&
          BigInt(entry.addressHex) < BigInt(range.endAddressHex),
      )
      .map((entry) => ({ addressHex: entry.addressHex, text: entry.text }));
  }

  functions_list() {
    return [];
  }

  regions() {
    return [];
  }

  registers() {
    return [{ name: "RIP", valueHex: ANCHOR_ADDRESS }];
  }

  bytesRows() {
    return [];
  }

  search() {
    return [];
  }
}

function frames(count) {
  return new Promise((resolve) => {
    let left = count;
    const step = () => {
      left -= 1;
      if (left <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** 真行盒计数(Range 客户端矩形按 top 去重;按钮等 inline-block 会各自贡献一个矩形)。 */
function lineBoxCount(element) {
  if (element === null || element === undefined) {
    return 0;
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  const tops = new Set();
  for (const rect of range.getClientRects()) {
    if (rect.height > 0) {
      tops.add(Math.round(rect.top * 10) / 10);
    }
  }
  return tops.size;
}

/**
 * 几何行盒数 = 元素高 / 行盒高(四舍五入)。
 * 这是「单元格占几个行盒」的**几何**读数:幻影空行的唯一后果就是它 > 1。
 * (Range 矩形数会把 inline-block 按钮的独立矩形也计入,不能直接当行盒数用。)
 */
function geometricLineBoxes(element, lineHeightPx) {
  if (element === null || element === undefined || lineHeightPx <= 0) {
    return 0;
  }
  return Math.round((element.getBoundingClientRect().height / lineHeightPx) * 100) / 100;
}

function cellReport(cell, lineHeightPx) {
  if (cell === null || cell === undefined) {
    return null;
  }
  const text = cell.textContent ?? "";
  return {
    height: Number(cell.getBoundingClientRect().height.toFixed(2)),
    geometricLineBoxes: geometricLineBoxes(cell, lineHeightPx),
    clientRectTops: lineBoxCount(cell),
    /**
     * 幻影空行的**直接指纹**:`white-space: pre` 单元格里被逐字保留的换行符个数
     * (模板排版空白)。修复后必须为 0;修复前 = 模板里写在单元格内的换行数。
     */
    preservedNewlines: text.split("\n").length - 1,
    text,
  };
}

/** IntersectionObserver 可见比例(与 Playwright toBeInViewport 同语义)。 */
function visibleRatio(element) {
  return new Promise((resolve) => {
    const observer = new IntersectionObserver((entries) => {
      observer.disconnect();
      resolve(entries[0]?.intersectionRatio ?? 0);
    });
    observer.observe(element);
    window.setTimeout(() => {
      observer.disconnect();
      resolve(0);
    }, 1000);
  });
}

function rectOf(element) {
  const rect = element?.getBoundingClientRect() ?? null;
  return rect === null ? null : { top: rect.top, height: rect.height, width: rect.width };
}

async function measure() {
  const stage = document.querySelector("#stage");
  stage.replaceChildren();
  const view = document.createElement("sm-instruction-view");
  stage.append(view);

  const source = new FakeDebugSource();
  view.dataSource = source;
  view.registerHits = [
    {
      registerName: "RIP",
      valueHex: ANCHOR_ADDRESS,
      targetAddressHex: ANCHOR_ADDRESS,
      regionId: "code",
      offset: 0,
    },
  ];
  await view.updateComplete;
  await frames(8);

  const shadow = view.shadowRoot;
  const list = shadow.querySelector("sm-window-list.instruction-list");
  const rows = [...shadow.querySelectorAll(".instruction-row")];
  const dataRows = rows.filter((row) => row.querySelector('[role="cell"]') !== null);
  const headerRow = rows.find((row) => row.querySelector('[role="columnheader"]') !== null) ?? null;
  const firstRow = dataRows[0] ?? rows[0] ?? null;
  const lineHeightPx = Number.parseFloat(
    firstRow === null ? "0" : getComputedStyle(firstRow).lineHeight,
  );
  const listViewport = {
    clientHeight: list?.clientHeight ?? 0,
    scrollHeight: list?.scrollHeight ?? 0,
    fallbackRowHeight: list?.rowHeight ?? null,
  };

  // 锚点行:走视图自身的锚点滚动路径(居中),再读可见比例。
  const anchorIndex = source.instructions().findIndex((entry) => entry.addressHex === ANCHOR_ADDRESS);
  if (list !== null && anchorIndex >= 0) {
    list.scrollToIndex(anchorIndex, "center");
  }
  await frames(8);
  const anchorRow =
    shadow.querySelector(`[data-instruction-address="${ANCHOR_ADDRESS}"]`) ?? null;
  const anchorRect = rectOf(anchorRow);
  const listRect = rectOf(list);
  const panelRect = rectOf(stage);
  /** 与 IntersectionObserver(Playwright toBeInViewport)同语义:含舞台裁剪。 */
  const anchorVisibleRatioPanel = anchorRow === null ? 0 : await visibleRatio(anchorRow);
  /** 只按列表视口裁剪:隔离 ①(行高)对锚点可见性的作用。 */
  const anchorVisibleRatioInList =
    anchorRect === null || listRect === null || anchorRect.height <= 0
      ? 0
      : Number(
          (
            Math.max(
              0,
              Math.min(anchorRect.top + anchorRect.height, listRect.top + listRect.height) -
                Math.max(anchorRect.top, listRect.top),
            ) / anchorRect.height
          ).toFixed(3),
        );

  /** 完全落在列表视口内的行数(滚动后真机可见行数)。 */
  let fullyVisibleRows = 0;
  if (listRect !== null) {
    for (const row of shadow.querySelectorAll(".instruction-row")) {
      const rect = row.getBoundingClientRect();
      if (rect.top >= listRect.top - 0.5 && rect.bottom <= listRect.top + listRect.height + 0.5) {
        fullyVisibleRows += 1;
      }
    }
  }

  const rowHeight = firstRow?.getBoundingClientRect().height ?? 0;
  const report = {
    variant,
    href: location.href,
    lineHeightPx: Number(lineHeightPx.toFixed(2)),
    rowCount: dataRows.length,
    plainRow: {
      address: firstRow?.getAttribute("data-instruction-address") ?? null,
      height: Number(rowHeight.toFixed(2)),
      cells: {
        address: cellReport(firstRow?.querySelector(".row-address") ?? null, lineHeightPx),
        bytes: cellReport(firstRow?.querySelector(".row-bytes") ?? null, lineHeightPx),
        breakpointButton: cellReport(firstRow?.querySelector(".breakpoint-toggle") ?? null, lineHeightPx),
      },
    },
    headerRowHeight: Number((headerRow?.getBoundingClientRect().height ?? 0).toFixed(2)),
    listViewport,
    rowsPerScreen: {
      inListViewport:
        listViewport.clientHeight > 0 ? Number((listViewport.clientHeight / rowHeight).toFixed(2)) : null,
      inM2Panel: rowHeight > 0 ? Number((M2_PANEL_HEIGHT / rowHeight).toFixed(2)) : null,
    },
    fullyVisibleRows,
    anchorRow: {
      address: ANCHOR_ADDRESS,
      height: Number((anchorRect?.height ?? 0).toFixed(2)),
      cells: {
        address: cellReport(anchorRow?.querySelector(".row-address") ?? null, lineHeightPx),
        annotation: cellReport(
          anchorRow?.querySelector("sm-register-annotation")?.shadowRoot?.querySelector(".annotation") ??
            null,
          lineHeightPx,
        ),
      },
      visibleRatioInList: anchorVisibleRatioInList,
      visibleRatioInPanel: Number(anchorVisibleRatioPanel.toFixed(3)),
      rect: anchorRect,
      listRect,
      panelRect,
    },
  };
  document.querySelector("#report").textContent = JSON.stringify(report, null, 2);
  return report;
}

// 动态导入含变量 ⇒ 显式关闭 Vite 的静态分析告警(两形态路径均在文件头常量里)。
const module_ = await import(/* @vite-ignore */ variant === "prefix" ? PREFIX_BUILD : CURRENT_SOURCE);
void module_;
await customElements.whenDefined("sm-instruction-view");

window.__geometry = { variant, measure, ready: true };
document.querySelector("#report").textContent = `variant=${variant} ready`;

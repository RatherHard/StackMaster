/* global document, window, customElements, getComputedStyle, requestAnimationFrame, KeyboardEvent, HTMLElement */
/**
 * 工作区整页布局真机几何夹具(2026-09-18 改版 / D-API-153;
 * 承接遗留 #33 的几何护栏义务)。
 *
 * 挂载真组件 `<sm-workspace>`(源码经 Vite 现场转译),注入:
 *  - 缺省注册表(十类视图,**全部常驻**;D-MP-1);
 *  - 内存版 `MemoryDataSource` 替身(字节视图有数据 ⇒ 可数「可见数据行」)。
 *
 * 导出 `window.__workspaceGeometry`:
 *  - `measure()` → 一次性读全部几何(逐项见 `measure` 内的字段注释);
 *  - `setVisible(type, visible)` / `moveView(type, index)` / `stepActive(delta)`
 *    (驱动列表按钮语义的几何复核)。
 */
// 侧作用 import:注册 sm-workspace 自定义元素(本夹具只用 DOM 面,不用类值)。
import "../../src/workspace/sm-workspace.js";
import "../../src/views/byte/byte-view.js";

const ROW_BYTES = 8;
/** 区域规格:16 行 × 8 字节 = 128 字节(stack 区域,供字节视图渲染数据行)。 */
const REGION_BYTES = 128;
const STACK_BASE = 0x7fffffffe000n;

function addressToHex(address) {
  return `0x${address.toString(16)}`;
}

/** 内存版 MemoryDataSource 替身(只实现视图消费面)。 */
function createDataSource() {
  const bytesHex = Array.from({ length: REGION_BYTES }, (_, index) =>
    (index % 251).toString(16).padStart(2, "0"),
  ).join("");
  const region = {
    regionId: "stack",
    label: "stack",
    startAddressHex: addressToHex(STACK_BASE),
    byteLength: REGION_BYTES,
    permissions: "rw",
    windowByteLength: REGION_BYTES,
    truncated: false,
  };
  return {
    regions: () => [region],
    registers: () => [
      { name: "RIP", valueHex: "0x401000" },
      { name: "RSP", valueHex: addressToHex(STACK_BASE) },
    ],
    xregisters: () => [],
    bytesRows: (range) => {
      const start = BigInt(range.startAddressHex);
      const end = BigInt(range.endAddressHex);
      const rows = [];
      let base = start - (start % BigInt(ROW_BYTES));
      while (base < end && base < STACK_BASE + BigInt(REGION_BYTES)) {
        const cells = [];
        for (let offset = 0; offset < ROW_BYTES; offset += 1) {
          const address = base + BigInt(offset);
          const index = Number(address - STACK_BASE);
          const inRegion = index >= 0 && index < REGION_BYTES;
          cells.push({
            addressHex: addressToHex(address),
            regionId: inRegion ? "stack" : null,
            offset: inRegion ? index : null,
            byteHex: inRegion ? bytesHex.slice(index * 2, index * 2 + 2) : null,
            byte: inRegion ? Number.parseInt(bytesHex.slice(index * 2, index * 2 + 2), 16) : null,
          });
        }
        rows.push({ addressHex: addressToHex(base), cells });
        base += BigInt(ROW_BYTES);
      }
      return rows;
    },
    search: () => [],
  };
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

/** 等待全部子组件渲染收敛(视图内容元素在挂载后才异步首渲染)。 */
async function settle(rounds = 24) {
  for (let index = 0; index < rounds; index += 1) {
    const panels = [...workspace.shadowRoot.querySelectorAll(".ws-view")];
    await Promise.all(
      panels
        .map((panel) => panel.querySelector("sm-byte-tab"))
        .filter((element) => element !== null && element !== undefined)
        .map((element) => element.updateComplete),
    );
    await workspace.updateComplete;
    await frames(1);
  }
}

const stage = document.querySelector("#stage");
await customElements.whenDefined("sm-workspace");
const workspace = document.createElement("sm-workspace");
const source = createDataSource();
stage.append(workspace);
workspace.dataSource = source;
window.__workspaceGeometryProbe = {
  assignedSame: workspace.dataSource === source,
  assignedNull: workspace.dataSource === null,
  regionCount: workspace.dataSource?.regions?.().length ?? null,
};

await workspace.updateComplete;
await frames(8);
await settle();
await frames(8);

/** 视口 / 文档层读数。 */
function documentMetrics() {
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    documentScrollHeight: document.documentElement.scrollHeight,
    documentClientHeight: document.documentElement.clientHeight,
    bodyScrollHeight: document.body.scrollHeight,
  };
}

/**
 * 一个视图位的几何 + 字节行读数。
 *
 * 字节行在**多级 shadow 嵌套**内(`sm-workspace` → `sm-byte-tab` →
 * `sm-byte-view` → `sm-window-list`(light DOM) → `.byte-row`),故沿链穿透取。
 */
function panelMetrics(element) {
  const rect = element.getBoundingClientRect();
  const byteTab = element.querySelector("sm-byte-tab");
  const byteView = byteTab?.shadowRoot?.querySelector("sm-byte-view") ?? null;
  const list = byteView?.shadowRoot?.querySelector("sm-window-list") ?? null;
  const rows = list === null ? [] : [...list.querySelectorAll(".byte-row")];
  const dataRows = rows.filter((row) => row.getAttribute("role") === "row" && row.querySelector(".row-hex") !== null && row.getAttribute("data-row-address") !== null);
  const listRect = list?.getBoundingClientRect() ?? null;
  const listViewport = list?.clientHeight ?? 0;
  const fullyVisibleRows =
    listRect === null
      ? 0
      : dataRows.filter((row) => {
          const rowRect = row.getBoundingClientRect();
          return (
            rowRect.height > 0 &&
            rowRect.top >= listRect.top - 1 &&
            rowRect.bottom <= listRect.top + listViewport + 1
          );
        }).length;
  return {
    type: element.getAttribute("data-view-panel"),
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
    rect: { top: rect.top, height: rect.height, width: rect.width },
    contentVisibility: getComputedStyle(element).contentVisibility,
    renderDegrade: element.getAttribute("data-render-degrade"),
    labelText: element.querySelector(".view-label")?.textContent ?? null,
    ariaLabel: element.getAttribute("aria-label"),
    /** 已渲染的字节数据行数(虚拟列表切片)。 */
    byteDataRowCount: dataRows.length,
    /** 完全落在列表视口内的字节数据行数(可读性判据的读数)。 */
    byteVisibleRowCount: fullyVisibleRows,
    byteRowHeightPx:
      dataRows[0] === undefined ? null : Number(dataRows[0].getBoundingClientRect().height.toFixed(2)),
    listClientHeight: listViewport,
    listScrollHeight: list?.scrollHeight ?? 0,
  };
}

const api = {
  ready: true,
  setVisible(type, visible) {
    return workspace.setViewVisible(type, visible);
  },
  moveView(type, index) {
    return workspace.moveView(type, index);
  },
  stepActive(delta) {
    return workspace.layoutSnapshot.activeType !== null || delta !== 0
      ? (() => {
          const before = workspace.layoutSnapshot.activeType;
          const event = new KeyboardEvent("keydown", {
            key: delta > 0 ? "ArrowDown" : "ArrowUp",
            ctrlKey: true,
            bubbles: true,
            composed: true,
            cancelable: true,
          });
          workspace.shadowRoot.querySelector(".ws-left").dispatchEvent(event);
          return {
            before,
            after: workspace.layoutSnapshot.activeType,
            defaultPrevented: event.defaultPrevented,
          };
        })()
      : null;
  },
  async measure() {
    await workspace.updateComplete;
    await frames(8);
    const root = workspace.shadowRoot;
    const left = root.querySelector(".ws-left");
    const right = root.querySelector(".ws-right");
    const body = root.querySelector(".ws-body");
    const stack = root.querySelector(".ws-stack");
    const bodyStyle = getComputedStyle(body);
    const leftStyle = getComputedStyle(left);
    const stackStyle = getComputedStyle(stack);
    const panels = [...root.querySelectorAll(".ws-view[data-view-panel]")];
    const leftRect = left.getBoundingClientRect();
    const rightRect = right.getBoundingClientRect();
    const fullyVisiblePanels = panels.filter((panel) => {
      const rect = panel.getBoundingClientRect();
      return (
        rect.height > 0 &&
        rect.top >= leftRect.top - 1 &&
        rect.bottom <= leftRect.bottom + 1
      );
    });
    return {
      document: {
        ...documentMetrics(),
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
      },
      hostOverflow: `${getComputedStyle(workspace).overflowX}/${getComputedStyle(workspace).overflowY}`,
      topHostsOverflow: [...document.body.children]
        .filter((child) => child.id !== "report")
        .map((child) => `${child.id || child.tagName}:${getComputedStyle(child).overflowX}`),
      host: {
        blockSize: getComputedStyle(workspace).blockSize,
        clientHeight: workspace.clientHeight,
        clientWidth: workspace.clientWidth,
        minBlockSize: getComputedStyle(workspace).minBlockSize,
      },
      body: {
        gridTemplateColumns: bodyStyle.gridTemplateColumns,
        columnGap: bodyStyle.columnGap,
        rowGap: bodyStyle.rowGap,
        borderTopWidth: bodyStyle.borderTopWidth,
        borderLeftWidth: bodyStyle.borderLeftWidth,
      },
      left: {
        clientWidth: left.clientWidth,
        clientHeight: left.clientHeight,
        minInlineSize: leftStyle.minInlineSize,
        x: leftRect.x,
        right: leftRect.right,
      },
      right: {
        clientWidth: right.clientWidth,
        clientHeight: right.clientHeight,
        x: rightRect.x,
        right: rightRect.right,
      },
      split: {
        /** 左右 clientWidth 之差(1:1 断言)。 */
        widthDelta: Math.abs(left.clientWidth - right.clientWidth),
        /** 两半侧之间的水平间隙(无 gap / 无 border 断言)。 */
        horizontalGapPx: rightRect.x - leftRect.right,
      },
      stack: {
        clientHeight: stack.clientHeight,
        scrollHeight: stack.scrollHeight,
        overflowY: stackStyle.overflowY,
        scrollBehavior: stackStyle.scrollBehavior,
        /** 左半侧是滚动容器:scrollHeight > clientHeight(溢出没有上浮到文档层)。 */
        isScrollContainer: stack.scrollHeight > stack.clientHeight,
      },
      /** 视图位高度算式的输入口径(诊断用):左半侧可视高。 */
      measuredLeftRoleHeight: (() => {
        const element = root.querySelector(".ws-left");
        const measured = element instanceof HTMLElement ? element.clientHeight : 0;
        return measured > 0 ? measured : window.innerHeight;
      })(),
      panels: panels.map(panelMetrics),
      panelCount: panels.length,
      visiblePanelCount: workspace.layoutSnapshot.views.filter((view) => view.visible).length,
      leftPanelCount: workspace.layoutSnapshot.views.filter(
        (view) => view.visible && view.type !== "payload",
      ).length,
      payloadPanelRendered: root.querySelector('.ws-view[data-view-panel="payload"]') !== null,
      rightRoleContentTag: right.firstElementChild?.tagName ?? null,
      fullyVisiblePanelCount: fullyVisiblePanels.length,
      fullyVisiblePanelTypes: fullyVisiblePanels.map((panel) =>
        panel.getAttribute("data-view-panel"),
      ),
      visibleViewTypes: workspace.layoutSnapshot.views
        .filter((view) => view.visible)
        .map((view) => view.type),
      activeType: workspace.layoutSnapshot.activeType,
      focusedType: workspace.layoutSnapshot.focusedType,
      leftRoleWidth: workspace.layoutSnapshot.leftRoleWidth,
    };
  },

  /**
   * 逐视图位读字节行:**离屏面板被 `content-visibility: auto` 跳过渲染**
   * (零 JS 降级机制的固有行为)⇒ 必须先把它滚进左半侧视口再计数。
   *
   * 读数前把**视图位自身的滚动面归零**(左半侧视图栈 + 字节视图的虚拟列表),
   * 使「可见数据行数」= 该视图位能容纳的行数(而不是「上次滚动停留位置」的
   * 偶然读数)。
   */
  async measureByteRows(type) {
    const root = workspace.shadowRoot;
    const stack = root.querySelector(".ws-stack");
    const panel = root.querySelector(`.ws-view[data-view-panel="${type}"]`);
    if (panel === null) {
      return null;
    }
    panel.scrollIntoView({ block: "nearest" });
    await frames(8);
    const list =
      panel.querySelector("sm-byte-tab")?.shadowRoot
        ?.querySelector("sm-byte-view")
        ?.shadowRoot?.querySelector("sm-window-list") ?? null;
    if (list !== null) {
      list.scrollTop = 0;
      await frames(8);
    }
    const metrics = panelMetrics(panel);
    stack.scrollTop = 0;
    await frames(2);
    return metrics;
  },
};

window.__workspaceGeometry = api;
document.querySelector("#report").textContent = "ready";

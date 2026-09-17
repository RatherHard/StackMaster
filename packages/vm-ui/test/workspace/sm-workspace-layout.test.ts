/**
 * <sm-workspace> Niri 式布局交互测试(WP-72 / 中期计划 §2.2 交互设计 1~8):
 *
 *  - **默认预设注入**:接入即按**当前宽度档**预设(P0 / P1 / P2)绑定窗口集
 *    (预设经 `bindWindows(entries, columns)` 单点注入,不存在第二处默认布局);
 *  - **列宽可调**:列间分隔条(pointer 拖拽 + 键盘方向键)+ 菜单列宽预设档,
 *    夹取到 `MIN_COLUMN_WIDTH` 护栏;
 *  - **窗高可调**:同列窗间分隔条(单窗列无分隔条);拖拽期间虚拟列表不重排;
 *  - **焦点列居中**:相机纯函数驱动的显式滚动计算(jsdom 无布局 → 结构断言);
 *  - **三类落点显式化**:同列堆叠 / 跨列移动 / 列间空隙新建列位 + 落点指示;
 *  - **响应式降级**:中宽 P1(3 列合并)/ 窄条 P2(单列纵向);
 *  - **视口外降级渲染**:`content-visibility: auto` 语义标记 + 结构断言;
 *  - **重置布局**:清空调整并回到**当前宽度**对应的预设(宽屏 = P0)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { SmWorkspace } from "../../src/workspace/sm-workspace.js";
import {
  LAYOUT_PRESET_P0,
  LAYOUT_PRESET_P1,
  LAYOUT_PRESET_P2,
  COLUMN_GAP_PX,
  MIN_COLUMN_WIDTH,
} from "../../src/workspace/layout-presets.js";
import {
  MIN_ROW_HEIGHT_PX,
  ROW_DIVIDER_HEIGHT_PX,
  columnChromePx,
  columnMinHeightPx,
} from "../../src/workspace/layout-divider.js";
import { isLayoutStateValid, isWindowSetComplete } from "../../src/workspace/workspace-model.js";
import { defaultTabTypeRegistry } from "../../src/workspace/tab-registry.js";
import { FakeMemoryDataSource } from "../views/byte/fake-data-source.js";

const REGISTERED_TYPES: readonly string[] = defaultTabTypeRegistry
  .list()
  .map((descriptor) => descriptor.type);

/** jsdom 缺省视口宽(1024)下工作区宽度档 = P0(≥ WIDE_MIN_PX)。 */
const DEFAULT_VIEWPORT = 1024;

function pointer(type: string, x: number, y: number): MouseEvent {
  return new MouseEvent(type, { bubbles: true, composed: true, clientX: x, clientY: y });
}

function key(type: string, keyName: string): KeyboardEvent {
  return new KeyboardEvent(type, { bubbles: true, composed: true, key: keyName });
}

function rect(left: number, width: number, top = 0, height = 300): DOMRect {
  return {
    left,
    width,
    top,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

async function mountWorkspace(): Promise<SmWorkspace> {
  const element = new SmWorkspace();
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function shadowOf(element: SmWorkspace): ShadowRoot {
  return element.shadowRoot as ShadowRoot;
}

function columnsElement(workspace: SmWorkspace): HTMLElement {
  return shadowOf(workspace).querySelector("[data-columns]") as HTMLElement;
}

function columnElement(workspace: SmWorkspace, index: number): HTMLElement {
  return shadowOf(workspace).querySelector(`[data-column-index="${index}"]`) as HTMLElement;
}

function panelOf(workspace: SmWorkspace, tabId: string): HTMLElement {
  const panel = shadowOf(workspace).querySelector(`[data-tab-id="${tabId}"]`);
  if (panel === null) {
    throw new Error(`未找到窗口面板:${tabId}`);
  }
  return panel as HTMLElement;
}

function menuShadow(workspace: SmWorkspace): ShadowRoot {
  const menu = shadowOf(workspace).querySelector("sm-workspace-menu");
  if (menu === null) {
    throw new Error("未找到工作区菜单");
  }
  return menu.shadowRoot as ShadowRoot;
}

function statusText(workspace: SmWorkspace): string {
  const status = shadowOf(workspace).querySelector(".layout-status");
  return status?.textContent?.trim() ?? "";
}

/** 以工作区数据源装配字节视图(虚拟列表行断言用)。 */
function mountDataSource(workspace: SmWorkspace): void {
  workspace.dataSource = new FakeMemoryDataSource(
    [
      {
        regionId: "region-stack",
        label: "stack",
        startAddressHex: "0x1000",
        byteLength: 4096,
        permissions: "rw",
        windowBytesHex: "000102030405060708090a0b0c0d0e0f",
      },
    ],
    [{ name: "RSP", valueHex: "0x1004" }],
  );
}

/** 首个字节窗口内的虚拟列表元素(字节视图 shadow 内;身份保持断言用)。 */
function byteListOf(workspace: SmWorkspace): Element | null {
  const byteTab = shadowOf(workspace).querySelector("sm-byte-tab") as unknown as {
    byteView?: { shadowRoot: ShadowRoot } | null;
  } | null;
  return byteTab?.byteView?.shadowRoot.querySelector("sm-window-list") ?? null;
}

/** 等待若干渲染帧(虚拟列表可见范围计算收敛)。 */
async function settleFrames(frames: number): Promise<void> {
  for (let frame = 0; frame < frames; frame += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    await Promise.resolve();
  }
}

/** 视口宽桩(jsdom 缺省 1024;恢复由 afterEach 承担)。 */
const originalInnerWidth = window.innerWidth;

function stubViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

afterEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  vi.restoreAllMocks();
});

describe("默认布局预设:按当前宽度档经 bindWindows 单点注入", () => {
  it("宽屏(jsdom 1024)→ P0:P0 逐列窗口分组直接生效", async () => {
    const workspace = await mountWorkspace();

    expect(workspace.layoutPresetId).toBe("P0");
    expect(workspace.layoutSnapshot.columns.map((column) => [...column.tabIds])).toEqual(
      LAYOUT_PRESET_P0.columns.map((column) => [...column]),
    );
    expect(workspace.layoutSnapshot.columns).toHaveLength(5);
    expect(isWindowSetComplete(workspace.layoutSnapshot)).toBe(true);
    expect(isLayoutStateValid(workspace.layoutSnapshot)).toBe(true);
    workspace.remove();
  });

  it("列宽按占比渲染为像素,且不低于最小可读宽护栏", async () => {
    const workspace = await mountWorkspace();

    for (let index = 0; index < 5; index += 1) {
      // 等分 1024/5 = 204.8px < 452.4px 护栏 → 渲染为护栏宽度(横向滚动可达)。
      expect(columnElement(workspace, index).style.inlineSize).toBe(`${MIN_COLUMN_WIDTH}px`);
    }
    workspace.remove();
  });

  it("单窗列自动占满列高(比例 [1]);多窗列为等分比例", async () => {
    const workspace = await mountWorkspace();

    expect(workspace.layoutSnapshot.columns.map((column) => [...column.rowHeights])).toEqual([
      [0.5, 0.5],
      [0.5, 0.5],
      [1],
      [0.5, 0.5],
      [1 / 3, 1 / 3, 1 / 3],
    ]);
    workspace.remove();
  });
});

describe("视口外窗口降级渲染(content-visibility)", () => {
  it("每个窗口面板带降级渲染语义标记", async () => {
    const workspace = await mountWorkspace();

    const panels = [...shadowOf(workspace).querySelectorAll(".tab-panel")];
    expect(panels).toHaveLength(REGISTERED_TYPES.length);
    for (const panel of panels) {
      expect(panel.getAttribute("data-render-degrade")).toBe("content-visibility");
    }
    workspace.remove();
  });

  it("组件样式表声明 content-visibility: auto + contain-intrinsic-size", () => {
    const styles =
      (SmWorkspace as unknown as { elementStyles?: { cssText?: string }[] }).elementStyles ?? [];
    const cssText = styles.map((style) => style.cssText ?? "").join("\n");
    expect(cssText).toContain("content-visibility: auto");
    expect(cssText).toContain("contain-intrinsic-size");
  });
});

describe("窗高下限(布局层落地:面板下限 + 列内下限之和 ⇒ 不压扁、改为滚动)", () => {
  it("面板下限来自推导常量(不再是裸的 9rem),降级占位同步", () => {
    const styles =
      (SmWorkspace as unknown as { elementStyles?: { cssText?: string }[] }).elementStyles ?? [];
    const cssText = styles.map((style) => style.cssText ?? "").join("\n");
    expect(cssText).toContain(`min-block-size: ${MIN_ROW_HEIGHT_PX}px`);
    expect(cssText).toContain(`contain-intrinsic-size: auto ${MIN_ROW_HEIGHT_PX}px`);
    // 回归护栏:旧的裸 9rem 写法一旦回来即红(144px 不足一个字节行单位 × 4 + chrome)。
    expect(cssText).not.toContain("9rem");
  });

  it("默认布局路径:每列都带与窗高比例相符的列高下限(不是只影响拖拽)", async () => {
    const workspace = await mountWorkspace();

    const snapshot = workspace.layoutSnapshot;
    snapshot.columns.forEach((column, index) => {
      const element = columnElement(workspace, index);
      expect(element.style.minBlockSize, `列 ${index} 缺列高下限`).toBe(
        `${columnMinHeightPx(column.rowHeights)}px`,
      );
      // 列高下限 ≥ 单窗下限(内容盒),且随窗口数单调增长。
      expect(columnMinHeightPx(column.rowHeights)).toBeGreaterThanOrEqual(MIN_ROW_HEIGHT_PX);
    });
    workspace.remove();
  });

  it("列高下限恒 ≥ 列内各面板下限之和(不至于把窗口压到下限以下)", async () => {
    const workspace = await mountWorkspace();

    for (const column of workspace.layoutSnapshot.columns) {
      const count = column.tabIds.length;
      expect(columnMinHeightPx(column.rowHeights)).toBeGreaterThanOrEqual(
        count * MIN_ROW_HEIGHT_PX,
      );
    }
    workspace.remove();
  });

  it("空间充足时比例分配照常:下限和 < 条带内容高 ⇒ 不触发溢出(比例才是分配依据)", () => {
    // P0 两窗列(嵌入式条带内容高 672 − 上下内边距 16 = 656):等分下限 560 < 656。
    expect(columnMinHeightPx([0.5, 0.5])).toBeLessThan(656);
    // 该列两窗等分后单窗 ≈ 320px,高于下限 ⇒ 拖拽仍有可分配空间。
    expect((656 - ROW_DIVIDER_HEIGHT_PX - 2 * COLUMN_GAP_PX) / 2).toBeGreaterThan(MIN_ROW_HEIGHT_PX);
  });

  it("空间不足时改为滚动:列高下限 > 条带内容高(P1 四窗列 / P0 三窗列)", () => {
    const equal = (count: number): number[] => Array.from({ length: count }, () => 1 / count);
    // P1(iframe 960 高)条带内容高 656;四窗列下限和 1144 ⇒ 溢出。
    expect(columnMinHeightPx(equal(4))).toBeGreaterThan(656);
    // P0 三窗列下限和 852 > 656 ⇒ 同样溢出(空间不足即滚动,而非压扁)。
    expect(columnMinHeightPx(equal(3))).toBeGreaterThan(656);
    // 比例偏斜后列高下限进一步长高(列盒 ≡ 内容高度,拖拽换算基准不偏)。
    expect(columnMinHeightPx([0.8, 0.1, 0.1])).toBeGreaterThan(columnMinHeightPx(equal(3)));
  });
});

describe("列宽可调:列间分隔条(pointer 拖拽 + 键盘)", () => {
  it("相邻列间渲染垂直分隔条(role=separator、可聚焦、带 aria 值)", async () => {
    const workspace = await mountWorkspace();

    const dividers = [...shadowOf(workspace).querySelectorAll(".column-divider")];
    // 5 列 ⇒ 4 个列间空隙。
    expect(dividers).toHaveLength(4);
    const first = dividers[0] as HTMLElement;
    expect(first.getAttribute("role")).toBe("separator");
    expect(first.getAttribute("aria-orientation")).toBe("vertical");
    expect(first.getAttribute("tabindex")).toBe("0");
    expect(first.getAttribute("aria-label")).toBeTruthy();
    expect(Number(first.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    // 空隙索引 = 该空隙右侧列的列序(新建列位落点的插入位置)。
    expect(first.getAttribute("data-column-divider")).toBe("1");
    workspace.remove();
  });

  it("pointer 拖拽分隔条:左侧列变宽、右侧列宽自持,并给出状态反馈", async () => {
    const workspace = await mountWorkspace();
    const before = workspace.layoutSnapshot.columns.map((column) => column.widthRatio);
    const divider = shadowOf(workspace).querySelector('[data-column-divider="1"]') as HTMLElement;

    divider.dispatchEvent(pointer("pointerdown", 500, 300));
    shadowOf(workspace).dispatchEvent(pointer("pointermove", 560, 300));
    await workspace.updateComplete;
    const duringDrag = statusText(workspace);
    shadowOf(workspace).dispatchEvent(pointer("pointerup", 560, 300));
    await workspace.updateComplete;

    const after = workspace.layoutSnapshot.columns.map((column) => column.widthRatio);
    // 位移 +60px / 视口 1024 ⇒ 宽度像素 +60(右侧列与其余列不变)。
    expect(after[0]! * DEFAULT_VIEWPORT).toBeCloseTo(before[0]! * DEFAULT_VIEWPORT + 60, 6);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
    expect(duringDrag.length).toBeGreaterThan(0);
    expect(isLayoutStateValid(workspace.layoutSnapshot)).toBe(true);
    workspace.remove();
  });

  it("位移未过阈值不算拖拽(分隔条不调整)", async () => {
    const workspace = await mountWorkspace();
    const before = workspace.layoutSnapshot.columns.map((column) => column.widthRatio);
    const divider = shadowOf(workspace).querySelector('[data-column-divider="1"]') as HTMLElement;

    divider.dispatchEvent(pointer("pointerdown", 500, 300));
    shadowOf(workspace).dispatchEvent(pointer("pointermove", 502, 300));
    shadowOf(workspace).dispatchEvent(pointer("pointerup", 502, 300));
    await workspace.updateComplete;

    expect(workspace.layoutSnapshot.columns.map((column) => column.widthRatio)).toEqual(before);
    workspace.remove();
  });

  it("键盘调整分隔条:方向键改变列宽并给出可宣读反馈", async () => {
    const workspace = await mountWorkspace();
    const before = workspace.layoutSnapshot.columns[0]?.widthRatio ?? 0;
    const divider = shadowOf(workspace).querySelector('[data-column-divider="1"]') as HTMLElement;

    divider.dispatchEvent(key("keydown", "ArrowRight"));
    await workspace.updateComplete;

    const after = workspace.layoutSnapshot.columns[0]?.widthRatio ?? 0;
    expect(after).toBeGreaterThan(before);
    expect(statusText(workspace).length).toBeGreaterThan(0);
    workspace.remove();
  });

  it("列宽护栏:拖到极小仍不低于最小可读宽", async () => {
    const workspace = await mountWorkspace();
    const divider = shadowOf(workspace).querySelector('[data-column-divider="1"]') as HTMLElement;

    divider.dispatchEvent(pointer("pointerdown", 900, 300));
    shadowOf(workspace).dispatchEvent(pointer("pointermove", 100, 300));
    shadowOf(workspace).dispatchEvent(pointer("pointerup", 100, 300));
    await workspace.updateComplete;

    expect((workspace.layoutSnapshot.columns[0]?.widthRatio ?? 0) * DEFAULT_VIEWPORT).toBeCloseTo(
      MIN_COLUMN_WIDTH,
      6,
    );
    workspace.remove();
  });
});

describe("窗高可调:同列窗间分隔条", () => {
  it("多窗列渲染 n−1 条水平分隔条;单窗列零分隔条", async () => {
    const workspace = await mountWorkspace();

    expect(
      shadowOf(workspace).querySelectorAll('[data-column-index="0"] .row-divider'),
    ).toHaveLength(1);
    expect(
      shadowOf(workspace).querySelectorAll('[data-column-index="2"] .row-divider'),
    ).toHaveLength(0);
    expect(
      shadowOf(workspace).querySelectorAll('[data-column-index="4"] .row-divider'),
    ).toHaveLength(2);
    const divider = shadowOf(workspace).querySelector('[data-row-divider="0:0"]') as HTMLElement;
    expect(divider.getAttribute("role")).toBe("separator");
    expect(divider.getAttribute("aria-orientation")).toBe("horizontal");
    expect(divider.getAttribute("tabindex")).toBe("0");
    workspace.remove();
  });

  it("拖拽窗高分隔条:同列两窗比例反向变化,和恒为 1", async () => {
    const workspace = await mountWorkspace();
    // 列高基准必须容得下「两个窗高下限」(2 × 266 = 532)——400px 的假几何在新
    // 下限下已不可行(下限和 > 列高 ⇒ 拖拽退化),故取 900px 真机量级基准。
    Object.defineProperty(columnElement(workspace, 0), "clientHeight", {
      configurable: true,
      value: 900,
    });
    const divider = shadowOf(workspace).querySelector('[data-row-divider="0:0"]') as HTMLElement;

    divider.dispatchEvent(pointer("pointerdown", 100, 200));
    shadowOf(workspace).dispatchEvent(pointer("pointermove", 100, 290));
    shadowOf(workspace).dispatchEvent(pointer("pointerup", 100, 290));
    await workspace.updateComplete;

    const heights = workspace.layoutSnapshot.columns[0]?.rowHeights ?? [];
    // 像素语义:位移 90px 全量落在上窗(自由空间 = 列高 900 − 非面板占位 28 = 872)
    // ⇒ 上窗 436 + 90 = 526、下窗 436 − 90 = 346,两侧都高于下限(266)。
    const free = 900 - columnChromePx(2);
    expect(heights[0]).toBeCloseTo((0.5 * free + 90) / free, 9);
    expect(heights[1]).toBeCloseTo((0.5 * free - 90) / free, 9);
    expect(heights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9);
    // 比例的唯一呈现路径:面板内联 flex-grow(高度分配依据;零 DOM 重建)。
    expect(Number(panelOf(workspace, "stack").style.flexGrow)).toBeCloseTo(heights[0] as number, 9);
    expect(Number(panelOf(workspace, "registers").style.flexGrow)).toBeCloseTo(
      heights[1] as number,
      9,
    );
    expect(isLayoutStateValid(workspace.layoutSnapshot)).toBe(true);
    workspace.remove();
  });

  it("窗高下限:拖拽压不出比下限更矮的窗口(被压侧像素高 = 下限)", async () => {
    const workspace = await mountWorkspace();
    const columnHeight = 900;
    Object.defineProperty(columnElement(workspace, 0), "clientHeight", {
      configurable: true,
      value: columnHeight,
    });
    const divider = shadowOf(workspace).querySelector('[data-row-divider="0:0"]') as HTMLElement;

    // 请求把上窗压到 ≈76px(436 − 360)⇒ 夹取到 MIN_ROW_HEIGHT_PX。
    divider.dispatchEvent(pointer("pointerdown", 100, 200));
    shadowOf(workspace).dispatchEvent(pointer("pointermove", 100, 200 - 0.4 * columnHeight));
    shadowOf(workspace).dispatchEvent(pointer("pointerup", 100, 200 - 0.4 * columnHeight));
    await workspace.updateComplete;

    const heights = workspace.layoutSnapshot.columns[0]?.rowHeights ?? [];
    // 列高下限随新比例长高(被压侧贴底)⇒ 自由空间 = 266 + 796。
    const free = columnMinHeightPx(heights) - columnChromePx(2);
    expect((heights[0] as number) * free).toBeCloseTo(MIN_ROW_HEIGHT_PX, 6);
    expect(free).toBeGreaterThan(columnHeight - columnChromePx(2));
    expect(heights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9);
    workspace.remove();
  });

  it("溢出列拖拽:像素基准在按下瞬间冻结(拖拽期间列高长高不回灌进换算)", async () => {
    const workspace = await mountWorkspace();
    // 按下时列高 = 下限 560(自由空间 532 = 2 × 266:恰好只够两个下限)。
    const column = columnElement(workspace, 0);
    Object.defineProperty(column, "clientHeight", { configurable: true, value: 560 });
    const divider = shadowOf(workspace).querySelector('[data-row-divider="0:0"]') as HTMLElement;
    divider.dispatchEvent(pointer("pointerdown", 100, 200));

    // 拖拽途中列盒被本列下限顶高(真机会发生)——旧实现每步重读 clientHeight,
    // 于是同样的 startHeights 按新自由空间重新摊开:非相邻窗跟着变高、列高比位移长。
    Object.defineProperty(column, "clientHeight", { configurable: true, value: 900 });
    shadowOf(workspace).dispatchEvent(pointer("pointermove", 100, 260));
    shadowOf(workspace).dispatchEvent(pointer("pointerup", 100, 260));
    await workspace.updateComplete;

    // 位移 60px 全量落在上窗、下窗贴住下限、像素和 = 560 基准的自由空间 + 60。
    const free = 560 - columnChromePx(2);
    const heights = workspace.layoutSnapshot.columns[0]?.rowHeights ?? [];
    expect((heights[0] as number) * (free + 60)).toBeCloseTo(0.5 * free + 60, 6);
    expect((heights[1] as number) * (free + 60)).toBeCloseTo(MIN_ROW_HEIGHT_PX, 6);
    expect(heights[0]).toBeCloseTo((0.5 * free + 60) / (free + 60), 9);
    expect(heights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9);
    // 自洽:列高下限(渲染层按同一比例算出的列盒)正好等于新内容高。
    expect(columnMinHeightPx(heights)).toBeCloseTo(560 + 60, 6);
    workspace.remove();
  });

  it("单窗列面板 flex-grow 恒 1(自动占满列高)", async () => {
    const workspace = await mountWorkspace();
    expect(panelOf(workspace, "payload").style.flexGrow).toBe("1");
    workspace.remove();
  });

  it("拖拽期间虚拟列表不重排(面板与列表元素身份保持不变)", async () => {
    const workspace = await mountWorkspace();
    mountDataSource(workspace);
    await workspace.updateComplete;
    await settleFrames(3);

    const panelBefore = panelOf(workspace, "stack");
    const listBefore = byteListOf(workspace);
    expect(listBefore).not.toBeNull();

    Object.defineProperty(columnElement(workspace, 0), "clientHeight", {
      configurable: true,
      value: 900,
    });
    const divider = shadowOf(workspace).querySelector('[data-row-divider="0:0"]') as HTMLElement;
    divider.dispatchEvent(pointer("pointerdown", 100, 200));
    shadowOf(workspace).dispatchEvent(pointer("pointermove", 100, 260));
    await workspace.updateComplete;

    // 拖拽进行中:面板与虚拟列表实例未被替换(只改容器比例)。
    expect(panelOf(workspace, "stack")).toBe(panelBefore);
    expect(byteListOf(workspace)).toBe(listBefore);

    shadowOf(workspace).dispatchEvent(pointer("pointerup", 100, 260));
    await workspace.updateComplete;
    expect(panelOf(workspace, "stack")).toBe(panelBefore);
    workspace.remove();
  });

  it("单窗列不受窗高分隔条影响:比例恒 [1](自动占满列高)", async () => {
    const workspace = await mountWorkspace();
    expect(shadowOf(workspace).querySelector('[data-column-index="2"] .row-divider')).toBeNull();
    expect(workspace.layoutSnapshot.columns[2]?.rowHeights).toEqual([1]);
    workspace.remove();
  });
});

describe("焦点列居中(相机跟随)与三类落点显式化", () => {
  it("聚焦窗口 → 相机按纯函数计算滚动位使焦点列居中", async () => {
    const workspace = await mountWorkspace();
    const columns = columnsElement(workspace);
    Object.defineProperty(columns, "clientWidth", { configurable: true, value: 1000 });
    Object.defineProperty(columns, "scrollWidth", { configurable: true, value: 4000 });
    columns.getBoundingClientRect = () => rect(0, 1000);
    // 第 3 列(payload)内容坐标 [1200, 1700)。
    columnElement(workspace, 2).getBoundingClientRect = () => rect(1200, 500);

    const button = menuShadow(workspace).querySelector(
      'button.focus-window[data-window-type="payload"]',
    ) as HTMLButtonElement;
    button.click();
    await workspace.updateComplete;

    expect(workspace.focusedColumnIndex).toBe(2);
    // 居中:1200 + 250 − 500 = 950(jsdom 无 Element.scrollTo → 直接赋 scrollLeft)。
    expect(columns.scrollLeft).toBe(950);
    workspace.remove();
  });

  it("列宽大于内容时相机不产生负滚动(首列居中夹取到 0)", async () => {
    const workspace = await mountWorkspace();
    const columns = columnsElement(workspace);
    Object.defineProperty(columns, "clientWidth", { configurable: true, value: 1000 });
    Object.defineProperty(columns, "scrollWidth", { configurable: true, value: 4000 });
    columns.getBoundingClientRect = () => rect(0, 1000);
    columnElement(workspace, 0).getBoundingClientRect = () => rect(0, 500);

    workspace.scrollToColumn(0);
    expect(columns.scrollLeft).toBe(0);
    workspace.remove();
  });

  it("尊重 prefers-reduced-motion:平滑滚动降级为即时定位", async () => {
    const workspace = await mountWorkspace();
    const matchMedia = vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
    }));
    Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });
    const columns = columnsElement(workspace);
    Object.defineProperty(columns, "clientWidth", { configurable: true, value: 1000 });
    Object.defineProperty(columns, "scrollWidth", { configurable: true, value: 4000 });
    columns.getBoundingClientRect = () => rect(0, 1000);
    columnElement(workspace, 2).getBoundingClientRect = () => rect(1200, 500);
    const scrollTo = vi.fn();
    Object.defineProperty(columns, "scrollTo", { configurable: true, value: scrollTo });

    workspace.scrollToColumn(2);

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo.mock.calls[0]?.[0]).toMatchObject({ left: 950, behavior: "auto" });
    workspace.remove();
  });

  it("落点一:落到同列窗口下半部 → 同列堆叠(指示 + 状态反馈 + 拖拽结束清除)", async () => {
    const workspace = await mountWorkspace();
    const source = panelOf(workspace, "stack");
    (source.querySelector(".tab-bar") as HTMLElement).dispatchEvent(pointer("pointerdown", 10, 10));
    shadowOf(workspace).dispatchEvent(pointer("pointermove", 40, 40));

    // 同列第 2 窗(registers)下半部 = 插到其后。
    const target = panelOf(workspace, "registers");
    target.dispatchEvent(pointer("pointermove", 10, 250));
    await workspace.updateComplete;
    expect(target.classList.contains("drop-target")).toBe(true);
    expect(target.getAttribute("data-drop-kind")).toBe("stack");
    expect(statusText(workspace).length).toBeGreaterThan(0);

    target.dispatchEvent(pointer("pointerup", 10, 250));
    await workspace.updateComplete;

    expect(workspace.layoutSnapshot.columns[0]?.tabIds).toEqual(["registers", "stack"]);
    expect(workspace.layoutSnapshot.columns).toHaveLength(5);
    expect(shadowOf(workspace).querySelector(".drop-target")).toBeNull();
    expect(isWindowSetComplete(workspace.layoutSnapshot)).toBe(true);
    workspace.remove();
  });

  it("落点二:落到另一列窗口上半部 → 跨列移动(该列内插入)", async () => {
    const workspace = await mountWorkspace();
    const source = panelOf(workspace, "stack");
    (source.querySelector(".tab-bar") as HTMLElement).dispatchEvent(pointer("pointerdown", 10, 10));
    shadowOf(workspace).dispatchEvent(pointer("pointermove", 40, 40));

    const target = panelOf(workspace, "free");
    target.dispatchEvent(pointer("pointermove", 10, 10));
    await workspace.updateComplete;
    expect(target.getAttribute("data-drop-kind")).toBe("cross-column");

    target.dispatchEvent(pointer("pointerup", 10, 10));
    await workspace.updateComplete;

    const snapshot = workspace.layoutSnapshot;
    expect(snapshot.columns[0]?.tabIds).toEqual(["registers"]);
    expect(snapshot.columns[1]?.tabIds).toEqual(["debug", "stack", "free"]);
    expect(snapshot.columns).toHaveLength(5);
    expect(isWindowSetComplete(snapshot)).toBe(true);
    workspace.remove();
  });

  it("落点三:落到列间空隙 → 在该列序位置新建列位(非尾插)", async () => {
    const workspace = await mountWorkspace();
    const source = panelOf(workspace, "stack");
    (source.querySelector(".tab-bar") as HTMLElement).dispatchEvent(pointer("pointerdown", 10, 10));
    shadowOf(workspace).dispatchEvent(pointer("pointermove", 40, 40));

    const gap = shadowOf(workspace).querySelector('[data-column-divider="2"]') as HTMLElement;
    gap.dispatchEvent(pointer("pointermove", 700, 300));
    await workspace.updateComplete;
    expect(gap.classList.contains("drop-target")).toBe(true);
    expect(gap.getAttribute("data-drop-kind")).toBe("new-column");

    gap.dispatchEvent(pointer("pointerup", 700, 300));
    await workspace.updateComplete;

    const snapshot = workspace.layoutSnapshot;
    expect(snapshot.columns.map((column) => [...column.tabIds])).toEqual([
      ["registers"],
      ["debug", "free"],
      ["stack"],
      ["payload"],
      ["call-stack", "structure"],
      ["timeline", "checkpoints", "memory-diff"],
    ]);
    expect(isWindowSetComplete(snapshot)).toBe(true);
    expect(isLayoutStateValid(snapshot)).toBe(true);
    workspace.remove();
  });

  it("键盘可达兜底:标题栏可聚焦,方向键在列内调整窗口顺序", async () => {
    const workspace = await mountWorkspace();
    const bar = panelOf(workspace, "stack").querySelector(".tab-bar") as HTMLElement;
    expect(bar.getAttribute("tabindex")).toBe("0");

    bar.dispatchEvent(key("keydown", "ArrowDown"));
    await workspace.updateComplete;

    expect(workspace.layoutSnapshot.columns[0]?.tabIds).toEqual(["registers", "stack"]);
    expect(statusText(workspace).length).toBeGreaterThan(0);
    workspace.remove();
  });

  it("键盘可达兜底:方向键跨列移动窗口(左邻列尾插 / 右邻列首插)", async () => {
    const workspace = await mountWorkspace();
    const bar = panelOf(workspace, "debug").querySelector(".tab-bar") as HTMLElement;

    bar.dispatchEvent(key("keydown", "ArrowRight"));
    await workspace.updateComplete;

    expect(workspace.layoutSnapshot.columns[1]?.tabIds).toEqual(["free"]);
    expect(workspace.layoutSnapshot.columns[2]?.tabIds).toEqual(["debug", "payload"]);
    expect(isWindowSetComplete(workspace.layoutSnapshot)).toBe(true);
    workspace.remove();
  });
});

describe("菜单布局组:列宽预设档 + 重置布局", () => {
  it("渲染五个列宽档 + 重置布局项,并呈现当前档位", async () => {
    const workspace = await mountWorkspace();
    const menu = menuShadow(workspace);

    const presets = [...menu.querySelectorAll("button.width-preset")];
    expect(presets.map((button) => button.getAttribute("data-width-ratio"))).toEqual([
      "0.25",
      "0.3333333333333333",
      "0.5",
      "0.6666666666666666",
      "1",
    ]);
    expect(menu.querySelector("button.reset-layout-button")).not.toBeNull();
    expect(menu.querySelector("[data-layout-preset]")?.getAttribute("data-layout-preset")).toBe(
      "P0",
    );
    workspace.remove();
  });

  it("点击列宽档 → 焦点列宽度变为该占比(夹取后)", async () => {
    const workspace = await mountWorkspace();
    const button = menuShadow(workspace).querySelector(
      'button.width-preset[data-width-ratio="0.5"]',
    ) as HTMLButtonElement;

    button.click();
    await workspace.updateComplete;

    expect(workspace.focusedColumnIndex).toBe(0);
    expect(workspace.layoutSnapshot.columns[0]?.widthRatio).toBeCloseTo(0.5, 9);
    // 其余列不受影响。
    expect(workspace.layoutSnapshot.columns[1]?.widthRatio).toBeCloseTo(
      MIN_COLUMN_WIDTH / DEFAULT_VIEWPORT,
      9,
    );
    expect(statusText(workspace).length).toBeGreaterThan(0);
    workspace.remove();
  });

  it("全宽档:焦点列铺满容器(占比 1)", async () => {
    const workspace = await mountWorkspace();
    const button = menuShadow(workspace).querySelector(
      'button.width-preset[data-width-ratio="1"]',
    ) as HTMLButtonElement;

    button.click();
    await workspace.updateComplete;

    expect(workspace.layoutSnapshot.columns[0]?.widthRatio).toBe(1);
    expect(columnElement(workspace, 0).style.inlineSize).toBe(`${DEFAULT_VIEWPORT}px`);
    workspace.remove();
  });

  it("重置布局:清空列宽 / 窗高调整并回到当前宽度对应预设(P0)", async () => {
    const workspace = await mountWorkspace();
    // 先做两项用户调整(列宽 + 窗高)。
    const widthButton = menuShadow(workspace).querySelector(
      'button.width-preset[data-width-ratio="1"]',
    ) as HTMLButtonElement;
    widthButton.click();
    Object.defineProperty(columnElement(workspace, 0), "clientHeight", {
      configurable: true,
      value: 900,
    });
    const divider = shadowOf(workspace).querySelector('[data-row-divider="0:0"]') as HTMLElement;
    divider.dispatchEvent(pointer("pointerdown", 100, 200));
    shadowOf(workspace).dispatchEvent(pointer("pointermove", 100, 290));
    shadowOf(workspace).dispatchEvent(pointer("pointerup", 100, 290));
    await workspace.updateComplete;
    expect(workspace.layoutSnapshot.columns[0]?.widthRatio).toBe(1);
    // 窗高已被拖拽调整(不再是缺省等分)。
    expect(workspace.layoutSnapshot.columns[0]?.rowHeights[0]).toBeGreaterThan(0.5);

    const resetButton = menuShadow(workspace).querySelector(
      "button.reset-layout-button",
    ) as HTMLButtonElement;
    resetButton.click();
    await workspace.updateComplete;

    expect(workspace.layoutSnapshot.columns.map((column) => [...column.tabIds])).toEqual(
      LAYOUT_PRESET_P0.columns.map((column) => [...column]),
    );
    expect(workspace.layoutSnapshot.columns.map((column) => column.widthRatio)).toEqual(
      LAYOUT_PRESET_P0.columns.map(() => MIN_COLUMN_WIDTH / DEFAULT_VIEWPORT),
    );
    expect(workspace.layoutSnapshot.columns[0]?.rowHeights).toEqual([0.5, 0.5]);
    expect(workspace.layoutPresetId).toBe("P0");
    expect(statusText(workspace).length).toBeGreaterThan(0);
    workspace.remove();
  });

  it("resetLayout 公共 API 与菜单项同路(清空调整 + 回当前档)", async () => {
    const workspace = await mountWorkspace();
    workspace.setFocusedColumnWidth(1);
    expect(workspace.layoutSnapshot.columns[0]?.widthRatio).toBe(1);

    workspace.resetLayout();
    await workspace.updateComplete;

    expect(workspace.layoutSnapshot.columns.map((column) => column.widthRatio)).toEqual(
      LAYOUT_PRESET_P0.columns.map(() => MIN_COLUMN_WIDTH / DEFAULT_VIEWPORT),
    );
    workspace.remove();
  });
});

describe("响应式降级:中宽合并列 / 窄条单列", () => {
  it("中宽(600px)→ P1:预设合并为 3 列", async () => {
    const workspace = await mountWorkspace();
    stubViewportWidth(600);
    await workspace.updateComplete;

    expect(workspace.layoutPresetId).toBe("P1");
    expect(workspace.layoutSnapshot.columns.map((column) => [...column.tabIds])).toEqual(
      LAYOUT_PRESET_P1.columns.map((column) => [...column]),
    );
    workspace.remove();
  });

  it("窄条(360px)→ P2:单列纵向,窗口切换条(菜单「窗口」组)承担聚焦", async () => {
    const workspace = await mountWorkspace();
    stubViewportWidth(360);
    await workspace.updateComplete;

    expect(workspace.layoutPresetId).toBe("P2");
    expect(workspace.layoutSnapshot.columns).toHaveLength(1);
    expect(workspace.layoutSnapshot.columns[0]?.tabIds).toEqual([...LAYOUT_PRESET_P2.columns[0]!]);
    expect(shadowOf(workspace).querySelectorAll(".column-divider")).toHaveLength(0);

    // 单列下聚焦导航仍可达(点击菜单窗口入口 → 焦点跟随)。
    const button = menuShadow(workspace).querySelector(
      'button.focus-window[data-window-type="checkpoints"]',
    ) as HTMLButtonElement;
    button.click();
    await workspace.updateComplete;
    expect(workspace.layoutSnapshot.focusedTabId).toBe("checkpoints");
    workspace.remove();
  });

  it("宽度回到宽屏 → 回到 P0(档位双向切换)", async () => {
    const workspace = await mountWorkspace();
    stubViewportWidth(360);
    await workspace.updateComplete;
    expect(workspace.layoutPresetId).toBe("P2");

    stubViewportWidth(1440);
    await workspace.updateComplete;

    expect(workspace.layoutPresetId).toBe("P0");
    expect(workspace.layoutSnapshot.columns).toHaveLength(5);
    expect(workspace.layoutSnapshot.viewportWidth).toBe(1440);
    workspace.remove();
  });

  it("同一档内宽度变化不重绑列结构(只更新列宽基准)", async () => {
    const workspace = await mountWorkspace();
    const before = workspace.layoutSnapshot.columns.map((column) => [...column.tabIds]);

    stubViewportWidth(1600);
    await workspace.updateComplete;

    expect(workspace.layoutSnapshot.columns.map((column) => [...column.tabIds])).toEqual(before);
    expect(workspace.layoutSnapshot.viewportWidth).toBe(1600);
    workspace.remove();
  });

  it("无 matchMedia 环境不抛错(prefers-reduced-motion 判定确定性回落)", async () => {
    const workspace = await mountWorkspace();
    const columns = columnsElement(workspace);
    Object.defineProperty(columns, "clientWidth", { configurable: true, value: 1000 });
    Object.defineProperty(columns, "scrollWidth", { configurable: true, value: 4000 });
    columns.getBoundingClientRect = () => rect(0, 1000);
    columnElement(workspace, 2).getBoundingClientRect = () => rect(1200, 500);
    const scrollTo = vi.fn();
    Object.defineProperty(columns, "scrollTo", { configurable: true, value: scrollTo });

    workspace.scrollToColumn(2);

    expect(scrollTo.mock.calls[0]?.[0]).toMatchObject({ behavior: "smooth" });
    workspace.remove();
  });
});

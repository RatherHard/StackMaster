/**
 * 分隔条拖拽纯函数测试(WP-72:列宽 / 窗高可调;与 `DRAG_THRESHOLD_PX` 阈值语义
 * 共用 pointer 挂点,这里只固定「位移 → 占比」的数学与护栏):
 *
 *  - **列宽**:边界平移只改**左侧列**的占比(右侧列宽度自持),夹取到
 *    `MIN_COLUMN_WIDTH` 护栏与全宽上限 1;
 *  - **窗高**:调同一列内相邻两窗的**像素**高(分隔条跟随指针),被减小的窗贴住
 *    下限后不再让位 ⇒ 富余空间列像素和守恒、溢出列像素和增长(列高随比例长高);
 *    模型不变量「比例和 = 1」在两种 regime 下都成立;
 *  - **退化输入**:无几何基准 / 越界索引 / 单窗列 / 自由空间非正 → 原值返回;
 *  - **窗高下限的双重身份**:`MIN_ROW_HEIGHT_PX` 既是拖拽下限,也是渲染层的
 *    布局下限;「列高下限 = 比例的函数」由 `columnMinHeightPx` 给算式,等分时退化
 *    为旧的「下限之和」算式(见本文件末两条 regime 用例)。
 */
import { describe, expect, it } from "vitest";

import {
  DIVIDER_KEY_STEP_PX,
  MIN_ROW_HEIGHT_PX,
  ROW_DIVIDER_HEIGHT_PX,
  ROW_DIVIDER_KEY_STEP,
  columnChromePx,
  columnMinHeightPx,
  columnWidthAfterDrag,
  rowHeightsAfterDrag,
} from "../../src/workspace/layout-divider.js";
import {
  COLUMN_GAP_PX,
  MIN_VISIBLE_HEX_ROWS,
  PANEL_CHROME_HEIGHT_PX,
  PANEL_BORDER_BLOCK_PX,
} from "../../src/workspace/layout-presets.js";

const MIN_WIDTH_PX = 452.4;

describe("columnWidthAfterDrag:列宽边界平移(只改左侧列,夹取护栏)", () => {
  it("向右拖 100px(视口 1000)→ 占比 +0.1", () => {
    const ratio = columnWidthAfterDrag({
      startRatio: 0.5,
      deltaPx: 100,
      viewportWidth: 1000,
      minWidthPx: MIN_WIDTH_PX,
    });
    expect(ratio).toBeCloseTo(0.6, 6);
  });

  it("向左拖越过最小可读宽 → 夹取到 MIN_COLUMN_WIDTH / 视口宽", () => {
    const ratio = columnWidthAfterDrag({
      startRatio: 0.5,
      deltaPx: -200,
      viewportWidth: 1000,
      minWidthPx: MIN_WIDTH_PX,
    });
    expect(ratio).toBeCloseTo(MIN_WIDTH_PX / 1000, 6);
  });

  it("向右拖越过全宽 → 夹取到 1(全宽档为上限)", () => {
    const ratio = columnWidthAfterDrag({
      startRatio: 0.9,
      deltaPx: 500,
      viewportWidth: 1000,
      minWidthPx: MIN_WIDTH_PX,
    });
    expect(ratio).toBe(1);
  });

  it("视口窄于最小列宽:护栏夹取不产生 > 1 的占比(退化为全宽)", () => {
    const ratio = columnWidthAfterDrag({
      startRatio: 1,
      deltaPx: -10,
      viewportWidth: 320,
      minWidthPx: MIN_WIDTH_PX,
    });
    expect(ratio).toBe(1);
  });

  it("无几何基准 / 非法位移 → 原值(零副作用)", () => {
    for (const viewportWidth of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        columnWidthAfterDrag({ startRatio: 0.5, deltaPx: 100, viewportWidth, minWidthPx: MIN_WIDTH_PX }),
      ).toBe(0.5);
    }
    expect(
      columnWidthAfterDrag({
        startRatio: 0.5,
        deltaPx: Number.NaN,
        viewportWidth: 1000,
        minWidthPx: MIN_WIDTH_PX,
      }),
    ).toBe(0.5);
  });
});

describe("rowHeightsAfterDrag:同列窗高对(像素语义:分隔条跟随指针;比例和恒 1)", () => {
  it("富余空间:相邻两窗一增一减、像素和守恒,其余窗不动(比例和恒 1)", () => {
    const columnHeightPx = 400;
    const free = columnHeightPx - columnChromePx(3);
    const heights = rowHeightsAfterDrag({
      heights: [1 / 3, 1 / 3, 1 / 3],
      index: 0,
      deltaPx: 40,
      columnHeightPx,
      minHeightPx: 40,
    });
    // 位移 40px 全量落在上窗;两侧都还在下限之上 ⇒ 像素和守恒。
    expect((heights[0] as number) * free).toBeCloseTo((1 / 3) * free + 40, 6);
    expect((heights[1] as number) * free).toBeCloseTo((1 / 3) * free - 40, 6);
    expect((heights[2] as number) * free).toBeCloseTo((1 / 3) * free, 9);
    expect(heights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9);
  });

  it("被减小的窗贴住下限:越界位移不再从它身上扣 ⇒ 像素和增长(列高随之增长)", () => {
    const columnHeightPx = 400;
    const free = columnHeightPx - columnChromePx(2);
    const heights = rowHeightsAfterDrag({
      heights: [0.5, 0.5],
      index: 0,
      deltaPx: 100,
      columnHeightPx,
      minHeightPx: 144,
    });
    // 列高下限是比例的函数 ⇒ 新列盒随「贴底那一侧」长高,自由空间随之变大。
    // (本用例的下限是合成值 144;渲染层用 MIN_ROW_HEIGHT_PX,口径同式不同值。)
    const grown = Math.max(...heights.map((ratio) => 144 / ratio));
    expect((heights[0] as number) * grown).toBeCloseTo(0.5 * free + 100, 6); // 增大的窗按位移变大
    expect((heights[1] as number) * grown).toBeCloseTo(144, 6); // 被减小的窗停在下限
    expect(grown).toBeGreaterThan(free); // 列总高增长(富余空间列则不变)
    expect(heights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9);
  });

  it("两侧请求都越过下限(退化几何)→ 两侧同抬到下限,比例仍合法(和恒 1)", () => {
    const heights = rowHeightsAfterDrag({
      heights: [0.5, 0.5],
      index: 0,
      deltaPx: 60,
      columnHeightPx: 400,
      minHeightPx: 250,
    });
    // 自由空间 372 < 2 × 250:两窗都夹到下限 ⇒ 等比例输入原样保留(不产生非法比例)。
    expect([...heights]).toEqual([0.5, 0.5]);
  });

  it("单窗列 / 越界索引 / 无列高基准 → 原值(单窗列自动占满列高)", () => {
    expect(
      [...rowHeightsAfterDrag({ heights: [1], index: 0, deltaPx: 40, columnHeightPx: 400, minHeightPx: 80 })],
    ).toEqual([1]);
    expect(
      [...rowHeightsAfterDrag({ heights: [0.5, 0.5], index: 1, deltaPx: 40, columnHeightPx: 400, minHeightPx: 80 })],
    ).toEqual([0.5, 0.5]);
    expect(
      [...rowHeightsAfterDrag({ heights: [0.5, 0.5], index: 0, deltaPx: 40, columnHeightPx: 0, minHeightPx: 80 })],
    ).toEqual([0.5, 0.5]);
    // 列高连面板边框 / 分隔条 / 列内间距都容不下:无自由空间 ⇒ 原值(零副作用)。
    expect(
      [
        ...rowHeightsAfterDrag({
          heights: [0.5, 0.5],
          index: 0,
          deltaPx: 40,
          columnHeightPx: columnChromePx(2),
          minHeightPx: 80,
        }),
      ],
    ).toEqual([0.5, 0.5]);
  });

  it("拖拽输入不修改传入数组(纯函数)", () => {
    const source = [0.5, 0.5] as const;
    rowHeightsAfterDrag({ heights: source, index: 0, deltaPx: 20, columnHeightPx: 400, minHeightPx: 80 });
    expect([...source]).toEqual([0.5, 0.5]);
  });
});

describe("键盘步进常量(分隔条方向键可达性)", () => {
  it("列宽步进为像素(32px),窗高步进为占比(5%)", () => {
    expect(DIVIDER_KEY_STEP_PX).toBe(32);
    expect(ROW_DIVIDER_KEY_STEP).toBeCloseTo(0.05, 6);
  });
});

describe("窗高下限:双重身份(布局下限 + 拖拽下限)与「列高下限 = 比例的函数」", () => {
  it("下限由面板 chrome + N 个行单位推导(不是裸的 9rem)", () => {
    expect(MIN_ROW_HEIGHT_PX).toBe(
      Math.ceil(PANEL_CHROME_HEIGHT_PX + MIN_VISIBLE_HEX_ROWS * (13 * 1.6)),
    );
    expect(MIN_ROW_HEIGHT_PX).toBe(266);
  });

  it("拖拽下限:被压侧停在下限(比例 = 下限 ÷ 列的自由空间,不是 ÷ 列高)", () => {
    const columnHeightPx = 852;
    // 请求把上窗压到 0.1(≈85px)⇒ 夹取到 MIN_ROW_HEIGHT_PX。
    const heights = rowHeightsAfterDrag({
      heights: [0.5, 0.5],
      index: 0,
      deltaPx: -0.4 * columnHeightPx,
      columnHeightPx,
      minHeightPx: MIN_ROW_HEIGHT_PX,
    });
    // 列高下限随新比例长高 ⇒ 自由空间变大;被压窗的像素高恒等于下限。
    const free = columnMinHeightPx(heights) - columnChromePx(2);
    expect((heights[0] as number) * free).toBeCloseTo(MIN_ROW_HEIGHT_PX, 6);
    expect(heights[0]).toBeCloseTo(MIN_ROW_HEIGHT_PX / free, 9);
    expect(free).toBeGreaterThan(columnHeightPx - columnChromePx(2));
    expect(heights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9);
  });

  it("等分比例时列高下限 = n ×(下限 + 上下边框)+ (n−1)条分隔条 + (2n−2)处列内间距", () => {
    const gap = COLUMN_GAP_PX;
    const divider = ROW_DIVIDER_HEIGHT_PX;
    const equal = (count: number): number[] =>
      Array.from({ length: count }, () => 1 / count);
    for (const n of [1, 2, 3, 4, 10]) {
      expect(columnMinHeightPx(equal(n)), `n=${n}`).toBe(
        n * (MIN_ROW_HEIGHT_PX + 2 * PANEL_BORDER_BLOCK_PX) + (n - 1) * divider + (2 * n - 2) * gap,
      );
    }
    // 逐档实名值(算式漂移即红):P0 两窗列 / P1 三窗列 / P1 四窗列 / P2 十窗列。
    // 与旧算式(按窗口数)在等分比例上逐值相同 —— 新口径是它的推广,不是推翻。
    expect(columnMinHeightPx(equal(1))).toBe(268);
    expect(columnMinHeightPx(equal(2))).toBe(560);
    expect(columnMinHeightPx(equal(3))).toBe(852);
    expect(columnMinHeightPx(equal(4))).toBe(1144);
    expect(columnMinHeightPx(equal(10))).toBe(2896);
  });

  it("列高下限是比例的函数:比例越偏列盒越高,且保证每个面板都不低于下限", () => {
    // 偏斜比例:小比例那侧决定列盒高度(下限 ÷ 比例)。
    expect(columnMinHeightPx([0.7, 0.3])).toBeGreaterThan(columnMinHeightPx([0.5, 0.5]));
    // 口径机检(逐例):自由空间 = 列高下限 − 非面板占位 ⇒ 每个面板像素高 ≥ 下限。
    const cases: readonly (readonly number[])[] = [
      [1],
      [0.5, 0.5],
      [0.7, 0.3],
      [0.25, 0.75],
      [1 / 3, 1 / 3, 1 / 3],
      [0.8, 0.1, 0.1],
      [0.05, 0.05, 0.9],
    ];
    for (const heights of cases) {
      const free = columnMinHeightPx(heights) - columnChromePx(heights.length);
      for (const ratio of heights) {
        expect(ratio * free, JSON.stringify(heights)).toBeGreaterThanOrEqual(
          MIN_ROW_HEIGHT_PX - 1e-9,
        );
      }
    }
    // 退化输入:空列 / 无正比例 ⇒ 0(不给伪下限)。
    expect(columnMinHeightPx([])).toBe(0);
    expect(columnMinHeightPx([0, 0])).toBe(0);
    expect(columnMinHeightPx([Number.NaN])).toBe(0);
  });

  it("列内窗口越多下限越高(单调)", () => {
    const equal = (count: number): number[] => Array.from({ length: count }, () => 1 / count);
    for (let n = 1; n < 10; n += 1) {
      expect(columnMinHeightPx(equal(n + 1))).toBeGreaterThan(columnMinHeightPx(equal(n)));
    }
  });
});

/**
 * 本次修复的核心口径(两条 regime 各自固定,总覆盖不减):
 *  - **富余空间列**(列高 > 下限):相邻两窗一增一减 ⇒ 像素和守恒(上面第一条);
 *  - **溢出列**(列高 = 下限,自由空间恰好只够所有下限):拖拽**必须有效** ——
 *    增大的窗确实变大、被减小的窗停在下限、列总高随之增长(本篇)。
 */
describe("溢出列 regime:列高贴住下限时窗高拖拽仍有效", () => {
  it("列高 = 等分下限和(560)时拖 +60px:上窗 +60、下窗停在下限、列高 +60", () => {
    const heights = [0.5, 0.5];
    const columnHeightPx = columnMinHeightPx(heights);
    const freeBefore = columnHeightPx - columnChromePx(2);
    // 两个面板恰好各占 266(自由空间 532 = 2 × 266):增大只能靠压另一窗,而它已贴底。
    expect(freeBefore).toBe(2 * MIN_ROW_HEIGHT_PX);
    const next = rowHeightsAfterDrag({
      heights,
      index: 0,
      deltaPx: 60,
      columnHeightPx,
      minHeightPx: MIN_ROW_HEIGHT_PX,
    });
    const freeAfter = columnMinHeightPx(next) - columnChromePx(2);
    expect((next[0] as number) * freeAfter).toBeCloseTo(MIN_ROW_HEIGHT_PX + 60, 6); // 增大的窗变大
    expect((next[1] as number) * freeAfter).toBeCloseTo(MIN_ROW_HEIGHT_PX, 6); // 被减小窗 ≥ 下限
    expect(freeAfter).toBeCloseTo(freeBefore + 60, 6); // 列总高随之增长
    // 自洽:渲染层按同一比例算出的列高下限正好等于「新内容高」(无二次夹取)。
    expect(columnMinHeightPx(next)).toBeCloseTo(columnHeightPx + 60, 6);
    expect(heights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9);
    expect(next.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9);
  });

  it("三窗列:同样口径(被压窗贴底、其余窗像素不变、列高增长)", () => {
    const heights = [1 / 3, 1 / 3, 1 / 3];
    const columnHeightPx = columnMinHeightPx(heights);
    const next = rowHeightsAfterDrag({
      heights,
      index: 0,
      deltaPx: 90,
      columnHeightPx,
      minHeightPx: MIN_ROW_HEIGHT_PX,
    });
    const freeBefore = columnHeightPx - columnChromePx(3);
    const freeAfter = columnMinHeightPx(next) - columnChromePx(3);
    expect((next[0] as number) * freeAfter).toBeCloseTo((1 / 3) * freeBefore + 90, 6);
    expect((next[1] as number) * freeAfter).toBeCloseTo(MIN_ROW_HEIGHT_PX, 6);
    expect((next[2] as number) * freeAfter).toBeCloseTo((1 / 3) * freeBefore, 6); // 非相邻窗不动
    expect(freeAfter).toBeGreaterThan(freeBefore);
    expect(next.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9);
  });
});

/**
 * 分隔条拖拽纯函数测试(WP-72:列宽 / 窗高可调;与 `DRAG_THRESHOLD_PX` 阈值语义
 * 共用 pointer 挂点,这里只固定「位移 → 占比」的数学与护栏):
 *
 *  - **列宽**:边界平移只改**左侧列**的占比(右侧列宽度自持),夹取到
 *    `MIN_COLUMN_WIDTH` 护栏与全宽上限 1;
 *  - **窗高**:调同一列内相邻两窗的比例,**两窗占比之和恒定**(模型不变量
 *    「比例和 = 1」在拖拽中始终成立),夹取到窗高下限;
 *  - **退化输入**:无几何基准 / 越界索引 / 单窗列 → 原值返回(零副作用)。
 */
import { describe, expect, it } from "vitest";

import {
  DIVIDER_KEY_STEP_PX,
  ROW_DIVIDER_KEY_STEP,
  columnWidthAfterDrag,
  rowHeightsAfterDrag,
} from "../../src/workspace/layout-divider.js";

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

describe("rowHeightsAfterDrag:同列窗高比例对(和恒为 1)", () => {
  it("相邻两窗:拖动改变两者比例,其余窗不动(和恒为 1)", () => {
    const heights = rowHeightsAfterDrag({
      heights: [1 / 3, 1 / 3, 1 / 3],
      index: 0,
      deltaPx: 40,
      columnHeightPx: 400,
      minHeightPx: 80,
    });
    expect(heights[0]).toBeCloseTo(0.433333, 5);
    expect(heights[1]).toBeCloseTo(0.233333, 5);
    expect(heights[2]).toBeCloseTo(1 / 3, 6);
    expect(heights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9);
  });

  it("夹取到窗高下限:两窗和不变,越界侧让位给另一侧", () => {
    const heights = rowHeightsAfterDrag({
      heights: [0.5, 0.5],
      index: 0,
      deltaPx: 100,
      columnHeightPx: 400,
      minHeightPx: 144,
    });
    expect(heights[0]).toBeCloseTo(0.64, 6);
    expect(heights[1]).toBeCloseTo(0.36, 6);
    expect(heights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9);
  });

  it("窗高下限不可行(2 × 下限 > 两窗和)→ 原值返回(不破和不变量)", () => {
    const heights = rowHeightsAfterDrag({
      heights: [0.5, 0.5],
      index: 0,
      deltaPx: 60,
      columnHeightPx: 400,
      minHeightPx: 250,
    });
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

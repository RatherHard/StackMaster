/**
 * 焦点列相机纯函数测试(WP-72 §2.2 第 1 条「相机跟随焦点列」):
 *
 *  - **居中**:目标滚动位 = 列中心 − 视口中心(内容坐标系);
 *  - **相邻列两侧探出**:居中列宽 ≤ 视口宽时,左右邻列各自至少露出一部分
 *    (暗示可继续滚动) —— 以算术断言固定;
 *  - **端部夹取**:首列不产生负滚动;末列不越过内容右界;
 *  - **非法输入**:视口宽 / 列宽非有限或非正 → 0(不滚动,不抛错)。
 *
 * jsdom 无布局环境:本模块是纯函数,单测直接以数值承载;真机行为由 E2E 断言。
 */
import { describe, expect, it } from "vitest";

import {
  cameraScrollLeft,
  columnBoxFromRects,
  type ColumnBox,
} from "../../src/workspace/layout-camera.js";

/** 视口宽 1000 下:焦点列(宽 500)起点在内容坐标 600,左邻列 [100,600)、右邻列 [1100,1600)。 */
const VIEWPORT = 1000;
const FOCUS_COLUMN: ColumnBox = { start: 600, size: 500 };

describe("cameraScrollLeft:焦点列居中", () => {
  it("居中:scrollLeft = 列中心 − 视口中心(内容坐标系)", () => {
    expect(cameraScrollLeft(FOCUS_COLUMN, VIEWPORT)).toBe(350);
  });

  it("列宽 < 视口宽时:两侧邻列同时露出(探出语义,暗示可继续滚动)", () => {
    const narrow: ColumnBox = { start: 1200, size: 400 };
    const scrollLeft = cameraScrollLeft(narrow, VIEWPORT);
    expect(scrollLeft).toBe(900);
    // 可视区 [900, 1900):左邻列右界 1200 与右邻列左界 1600 均落在可视区内。
    const leftNeighbourRightEdge = narrow.start;
    const rightNeighbourLeftEdge = narrow.start + narrow.size;
    expect(leftNeighbourRightEdge).toBeGreaterThan(scrollLeft);
    expect(rightNeighbourLeftEdge).toBeLessThan(scrollLeft + VIEWPORT);
  });

  it("列宽 = 视口宽时:恰铺满可视区(无探出,但不偏置)", () => {
    const exact = cameraScrollLeft(FOCUS_COLUMN, FOCUS_COLUMN.size);
    expect(exact).toBe(FOCUS_COLUMN.start);
    expect(exact + FOCUS_COLUMN.size).toBe(FOCUS_COLUMN.start + FOCUS_COLUMN.size);
  });

  it("列宽 > 视口宽时:仍居中(两侧均被裁切,不偏置)", () => {
    const wide: ColumnBox = { start: 500, size: 1400 };
    expect(cameraScrollLeft(wide, VIEWPORT)).toBe(700);
  });
});

describe("cameraScrollLeft:端部夹取(不越界)", () => {
  it("首列(起点 0)→ 0,不产生负滚动", () => {
    expect(cameraScrollLeft({ start: 0, size: 500 }, VIEWPORT)).toBe(0);
  });

  it("给定内容总宽时:末列夹取到 scrollWidth − 视口宽", () => {
    const last: ColumnBox = { start: 1800, size: 300 };
    // 未夹取时为 1450,内容总宽 2000 ⇒ 上限 1000。
    expect(cameraScrollLeft(last, VIEWPORT, { scrollWidth: 2000 })).toBe(1000);
  });

  it("内容总宽 ≤ 视口宽:恒 0(无可滚动空间)", () => {
    expect(cameraScrollLeft({ start: 100, size: 300 }, VIEWPORT, { scrollWidth: 800 })).toBe(0);
  });

  it("未给定内容总宽:不夹取上界(调用方自担)", () => {
    expect(cameraScrollLeft({ start: 1800, size: 300 }, VIEWPORT)).toBe(1450);
  });
});

describe("cameraScrollLeft:非法输入确定性回落", () => {
  it("视口宽非正 / 非有限 → 0", () => {
    expect(cameraScrollLeft(FOCUS_COLUMN, 0)).toBe(0);
    expect(cameraScrollLeft(FOCUS_COLUMN, -10)).toBe(0);
    expect(cameraScrollLeft(FOCUS_COLUMN, Number.NaN)).toBe(0);
    expect(cameraScrollLeft(FOCUS_COLUMN, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("列宽非正 / 非有限 → 0(无几何可居中)", () => {
    expect(cameraScrollLeft({ start: 600, size: 0 }, VIEWPORT)).toBe(0);
    expect(cameraScrollLeft({ start: 600, size: -1 }, VIEWPORT)).toBe(0);
    expect(cameraScrollLeft({ start: Number.NaN, size: 500 }, VIEWPORT)).toBe(0);
  });
});

describe("columnBoxFromRects:视口矩形 → 内容坐标列盒", () => {
  it("内容坐标 = 列左界 − 容器左界 + 容器 scrollLeft", () => {
    const box = columnBoxFromRects({ left: 0, width: 1000 }, { left: 350, width: 500 }, 350);
    expect(box).toEqual({ start: 700, size: 500 });
    // 该几何下居中所需滚动位 = 700 + 250 − 500 = 450(比当前位置更靠右)。
    expect(cameraScrollLeft(box, 1000)).toBe(450);
  });

  it("容器滚动位计入内容坐标(与相机互为逆运算)", () => {
    const container = { left: 100, width: 1000 };
    const column = { left: 700, width: 408 };
    const scrollLeft = 300;
    const box = columnBoxFromRects(container, column, scrollLeft);
    expect(box.start).toBe(900);
    // 相机反向:同一几何下算出该列居中所需的滚动位。
    expect(cameraScrollLeft(box, container.width)).toBe(604);
  });
});

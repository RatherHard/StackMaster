/**
 * 宽度推导与视图位高度阈值测试(layout-presets;**2026-09-18 整页布局改版重写**)。
 *
 * **保留面**(推导值本身仍有效,只换载体):
 *  - `HEX_ROW_FONT_SIZE_PX` / `MONOSPACE_ADVANCE_EM` / `MONOSPACE_CHAR_WIDTH_PX`
 *    / `HEX_ROW_MIN_CHARS` / `MIN_COLUMN_WIDTH` —— 逐项推导式机检;
 *  - `SIDE_PANEL_MIN_WIDTH_PX = MIN_COLUMN_WIDTH`(**D-UI-5:该推导值改挂左半侧
 *    宽度底线**,不再约束「列宽」);
 *  - `DEFAULT_VIEW_ORDER` / `orderByDefault`(默认顺序 = 「重置视图」的默认顺序依据)。
 *
 * **新增面**:视图位高度算式 `viewSlotHeightPx()` 与 `VISIBLE_VIEW_SLOT_COUNT`
 * (D-UI-2 恰两个可见视图位;**只滚动、不压缩**的可读性载体)。
 *
 * **已废止(整条退出,不得复活)**:P0 / P1 / P2 三档与 `selectLayoutPreset` /
 * `layoutPresetById` / `LayoutPresetId` / `LAYOUT_PRESETS` / `LAYOUT_PRESET_*`、
 * 阈值表 `WIDE_MIN_PX` / `NARROW_MAX_PX`(档位判定语义)、`COLUMN_WIDTH_PRESETS`
 * 五档列宽、块轴阈值推导段(`PANEL_CHROME_HEIGHT_PX` / `MIN_VISIBLE_HEX_ROWS` /
 * `TAB_BAR_HEIGHT_PX` / `BYTE_*` / `COLUMN_GAP_PX` / `COLUMN_DIVIDER_WIDTH_PX`
 * / `CONTAINER_PADDING_PX` / `MIN_ROW_HEIGHT_PX`)—— 见模块头「本版废止」段。
 */
import { describe, expect, it } from "vitest";

import * as presets from "../../src/workspace/layout-presets.js";
import {
  DEFAULT_VIEW_ORDER,
  HEX_ROW_FONT_SIZE_PX,
  HEX_ROW_HEIGHT_PX,
  HEX_ROW_MIN_CHARS,
  MIN_COLUMN_WIDTH,
  MONOSPACE_ADVANCE_EM,
  MONOSPACE_CHAR_WIDTH_PX,
  SIDE_PANEL_MIN_WIDTH_PX,
  VIEW_PANEL_CHROME_HEIGHT_PX,
  VIEW_SLOT_MIN_VISIBLE_HEX_ROWS,
  VISIBLE_VIEW_SLOT_COUNT,
  orderByDefault,
  viewSlotHeightPx,
} from "../../src/workspace/layout-presets.js";
import {
  CALL_STACK_TAB_TYPE,
  CHECKPOINTS_TAB_TYPE,
  DEBUG_TAB_TYPE,
  FREE_TAB_TYPE,
  MEMORY_DIFF_TAB_TYPE,
  PAYLOAD_TAB_TYPE,
  REGISTERS_TAB_TYPE,
  STACK_TAB_TYPE,
  STRUCTURE_TAB_TYPE,
  TIMELINE_TAB_TYPE,
} from "../../src/workspace/tab-registry.js";

describe("宽度推导(保留并重新定位:载体 = 左半侧宽度底线)", () => {
  it("字符宽 = 字号 × advance 近似 = 13 × 0.6 = 7.8px", () => {
    expect(HEX_ROW_FONT_SIZE_PX).toBe(13);
    expect(MONOSPACE_ADVANCE_EM).toBeCloseTo(0.6, 6);
    expect(MONOSPACE_CHAR_WIDTH_PX).toBeCloseTo(7.8, 6);
  });

  it("十六进制行不折行字符数 = 58ch(逐段推导见模块头注释)", () => {
    expect(HEX_ROW_MIN_CHARS).toBe(58);
  });

  it("MIN_COLUMN_WIDTH = 字符宽 × 行字符数 = 452.4px", () => {
    expect(MIN_COLUMN_WIDTH).toBeCloseTo(MONOSPACE_CHAR_WIDTH_PX * HEX_ROW_MIN_CHARS, 6);
    expect(MIN_COLUMN_WIDTH).toBeCloseTo(452.4, 6);
  });

  it("SIDE_PANEL_MIN_WIDTH_PX = MIN_COLUMN_WIDTH(D-UI-5:同一推导值改挂左半侧)", () => {
    expect(SIDE_PANEL_MIN_WIDTH_PX).toBe(MIN_COLUMN_WIDTH);
    // 底线必须是可读的有意义量级(不是裸值)。
    expect(SIDE_PANEL_MIN_WIDTH_PX).toBeGreaterThan(400);
  });

  it("行单位 = 字号 × line-height 1.6 = 20.8px", () => {
    expect(HEX_ROW_HEIGHT_PX).toBeCloseTo(20.8, 6);
  });
});

describe("视图位高度算式(viewSlotHeightPx;可读性纪律的新载体)", () => {
  /** 下限 = chrome + N 个行单位(上取整)。 */
  const MIN_SLOT = Math.ceil(
    VIEW_PANEL_CHROME_HEIGHT_PX + VIEW_SLOT_MIN_VISIBLE_HEX_ROWS * HEX_ROW_HEIGHT_PX,
  );

  it("N = 4 行(一行 8 字节 ⇒ 32 字节 = MVP 教学闭环的最小可视片段)", () => {
    expect(VIEW_SLOT_MIN_VISIBLE_HEX_ROWS).toBe(4);
  });

  it("可见视图位数量 = 2(D-UI-2 定案,数量不可配置)", () => {
    expect(VISIBLE_VIEW_SLOT_COUNT).toBe(2);
  });

  it("矮视口 / 非法输入 → 确定性取**下限**(不压缩到装不下一行字节)", () => {
    expect(viewSlotHeightPx(200)).toBe(MIN_SLOT);
    expect(viewSlotHeightPx(0)).toBe(MIN_SLOT);
    expect(viewSlotHeightPx(-100)).toBe(MIN_SLOT);
    expect(viewSlotHeightPx(Number.NaN)).toBe(MIN_SLOT);
    expect(viewSlotHeightPx(Number.POSITIVE_INFINITY)).toBe(MIN_SLOT);
  });

  it("空间充足时 = 等分左半侧可视高(floor),单调不减", () => {
    const tall = viewSlotHeightPx(1000);
    const taller = viewSlotHeightPx(1400);
    expect(tall).toBeGreaterThan(MIN_SLOT);
    expect(taller).toBeGreaterThan(tall);
    // 等分:视位高 × 2 ≤ 左半侧高(按钮与留白亦在其中,故取宽松上界)。
    expect(tall * VISIBLE_VIEW_SLOT_COUNT).toBeLessThanOrEqual(1000);
  });

  it("**可读性判据**:任一视位高减去 chrome 后必容纳 ≥ N 个行单位", () => {
    for (const height of [0, 200, 400, 600, 900, 1440, 2160]) {
      const slot = viewSlotHeightPx(height);
      const rows = (slot - VIEW_PANEL_CHROME_HEIGHT_PX) / HEX_ROW_HEIGHT_PX;
      expect(rows, `leftRoleHeight=${String(height)} → ${String(slot)}px`).toBeGreaterThanOrEqual(
        VIEW_SLOT_MIN_VISIBLE_HEX_ROWS,
      );
    }
  });
});

describe("视图默认顺序(取代原「默认列排布」的唯一来源)", () => {
  it("DEFAULT_VIEW_ORDER 含全部十类登记类型,无重无漏", () => {
    const expected = [
      STACK_TAB_TYPE,
      REGISTERS_TAB_TYPE,
      DEBUG_TAB_TYPE,
      FREE_TAB_TYPE,
      PAYLOAD_TAB_TYPE,
      CALL_STACK_TAB_TYPE,
      STRUCTURE_TAB_TYPE,
      TIMELINE_TAB_TYPE,
      CHECKPOINTS_TAB_TYPE,
      MEMORY_DIFF_TAB_TYPE,
    ];
    expect([...DEFAULT_VIEW_ORDER]).toEqual(expected);
    expect(new Set(DEFAULT_VIEW_ORDER).size).toBe(DEFAULT_VIEW_ORDER.length);
  });

  it("orderByDefault:按默认顺序重排;未登记键按输入序补末尾(恒为全排列)", () => {
    expect(orderByDefault([FREE_TAB_TYPE, STACK_TAB_TYPE])).toEqual([
      STACK_TAB_TYPE,
      FREE_TAB_TYPE,
    ]);
    expect(orderByDefault([STACK_TAB_TYPE, "custom", FREE_TAB_TYPE])).toEqual([
      STACK_TAB_TYPE,
      FREE_TAB_TYPE,
      "custom",
    ]);
    expect(orderByDefault(["custom"])).toEqual(["custom"]);
    expect(orderByDefault([])).toEqual([]);
  });

  it("orderByDefault 不产生重复(重复输入键只落一次)", () => {
    expect(orderByDefault([STACK_TAB_TYPE, STACK_TAB_TYPE])).toEqual([STACK_TAB_TYPE]);
  });

  it("orderByDefault 与类型集合等价(长度恒等于去重后的输入集)", () => {
    const input = [PAYLOAD_TAB_TYPE, STACK_TAB_TYPE, "custom", FREE_TAB_TYPE];
    expect(orderByDefault(input)).toHaveLength(new Set(input).size);
  });
});

describe("已废止面:不得再导出任何兼容别名(D-API-153 整条退出)", () => {
  it("预设档 / 阈值表 / 列宽五档 / 块轴阈值推导常量全部不再导出", () => {
    const exported = presets as unknown as Record<string, unknown>;
    for (const retired of [
      "LAYOUT_PRESET_P0",
      "LAYOUT_PRESET_P1",
      "LAYOUT_PRESET_P2",
      "LAYOUT_PRESETS",
      "LayoutPresetId",
      "selectLayoutPreset",
      "layoutPresetById",
      "WIDE_MIN_PX",
      "NARROW_MAX_PX",
      "COLUMN_WIDTH_PRESETS",
      "COLUMN_GAP_PX",
      "COLUMN_DIVIDER_WIDTH_PX",
      "CONTAINER_PADDING_PX",
      "PANEL_CHROME_HEIGHT_PX",
      "MIN_VISIBLE_HEX_ROWS",
      "TAB_BAR_HEIGHT_PX",
      "BYTE_VIEW_BORDER_BLOCK_PX",
      "BYTE_TOOLBAR_HEIGHT_PX",
      "BYTE_HEADER_ROW_HEIGHT_PX",
      "PANEL_BORDER_BLOCK_PX",
      "MIN_ROW_HEIGHT_PX",
    ]) {
      expect(exported[retired], `已废止常量仍导出:${retired}`).toBeUndefined();
    }
  });
});

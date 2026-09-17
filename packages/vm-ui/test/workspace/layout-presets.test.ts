/**
 * 布局预设与阈值行为测试(WP-72 / D-MP-1 微调定案):
 *
 *  - **三表不变量机检**:P0 / P1 / P2 三张常量表各列出的类型键 = 注册表登记
 *    集合,**各恰一次、无重无漏**(登记序权威来源 = `createDefaultTabTypeRegistry()`);
 *  - **阈值推导式机检**:`MIN_COLUMN_WIDTH` / `WIDE_MIN_PX` / `NARROW_MAX_PX`
 *    三常量与推导式同批固定(漂移即红灯);**块轴(高度)侧同法**:面板 chrome
 *    逐项 + N(= 4)个行单位 ⇒ `MIN_ROW_HEIGHT_PX`(窗高下限);
 *  - **`selectLayoutPreset` 判定边界**:两条阈值线上下的档位归属;
 *  - **列宽预设档**:1/4、1/3、1/2、2/3、全宽五档(视口占比,单调递增且末档 = 全宽)。
 */
import { describe, expect, it } from "vitest";

import { defaultTabTypeRegistry } from "../../src/workspace/tab-registry.js";
import {
  BYTE_HEADER_ROW_HEIGHT_PX,
  BYTE_TOOLBAR_HEIGHT_PX,
  BYTE_VIEW_BORDER_BLOCK_PX,
  COLUMN_DIVIDER_WIDTH_PX,
  COLUMN_GAP_PX,
  COLUMN_WIDTH_PRESETS,
  CONTAINER_PADDING_PX,
  HEX_ROW_FONT_SIZE_PX,
  HEX_ROW_HEIGHT_PX,
  HEX_ROW_MIN_CHARS,
  LAYOUT_PRESET_P0,
  LAYOUT_PRESET_P1,
  LAYOUT_PRESET_P2,
  MIN_COLUMN_WIDTH,
  MIN_VISIBLE_HEX_ROWS,
  MONOSPACE_CHAR_WIDTH_PX,
  NARROW_MAX_PX,
  PANEL_CHROME_HEIGHT_PX,
  TAB_BAR_HEIGHT_PX,
  WIDE_MIN_PX,
  selectLayoutPreset,
} from "../../src/workspace/layout-presets.js";
import { MIN_ROW_HEIGHT_PX } from "../../src/workspace/layout-divider.js";

/** 注册表登记类型集(权威来源;与 tab-registry.test.ts 同序固定)。 */
const REGISTERED_TYPES: readonly string[] = defaultTabTypeRegistry
  .list()
  .map((descriptor) => descriptor.type);

/** 表内类型键平铺序(逐列逐窗)。 */
function flatTypes(columns: readonly (readonly string[])[]): string[] {
  return columns.flatMap((column) => [...column]);
}

describe("布局预设三表不变量(各列出的类型键各恰一次、无重无漏)", () => {
  it("P0(宽屏 5 列)= 主控定案逐列形态", () => {
    expect(LAYOUT_PRESET_P0.columns.map((column) => [...column])).toEqual([
      ["stack", "registers"],
      ["debug", "free"],
      ["payload"],
      ["call-stack", "structure"],
      ["timeline", "checkpoints", "memory-diff"],
    ]);
    expect(LAYOUT_PRESET_P0.id).toBe("P0");
  });

  it("P1(中宽 3 列预设合并)= 主控定案逐列形态", () => {
    expect(LAYOUT_PRESET_P1.columns.map((column) => [...column])).toEqual([
      ["stack", "registers", "free"],
      ["debug", "structure", "call-stack"],
      ["payload", "timeline", "checkpoints", "memory-diff"],
    ]);
    expect(LAYOUT_PRESET_P1.id).toBe("P1");
  });

  it("P2(窄条单列纵向)= 登记序单列", () => {
    expect(LAYOUT_PRESET_P2.columns.map((column) => [...column])).toEqual([
      ["stack", "free", "registers", "payload", "debug", "structure", "call-stack", "memory-diff", "timeline", "checkpoints"],
    ]);
    expect(LAYOUT_PRESET_P2.id).toBe("P2");
    expect(LAYOUT_PRESET_P2.columns).toHaveLength(1);
  });

  it("三表各自:登记集合各恰一次(无重无漏、无未登记键)", () => {
    for (const preset of [LAYOUT_PRESET_P0, LAYOUT_PRESET_P1, LAYOUT_PRESET_P2]) {
      const types = flatTypes(preset.columns);
      expect([...types].sort(), `${preset.id} 类型集漂移`).toEqual([...REGISTERED_TYPES].sort());
      expect(new Set(types).size, `${preset.id} 存在重复落位`).toBe(REGISTERED_TYPES.length);
      // 列内非空(平铺不变量:不存在空列)。
      for (const column of preset.columns) {
        expect(column.length).toBeGreaterThan(0);
      }
    }
  });

  it("三表列数: P0 = 5,P1 = 3,P2 = 1(断点减列语义)", () => {
    expect(LAYOUT_PRESET_P0.columns).toHaveLength(5);
    expect(LAYOUT_PRESET_P1.columns).toHaveLength(3);
    expect(LAYOUT_PRESET_P2.columns).toHaveLength(1);
  });
});

describe("列宽阈值推导式(WP-72:十六进制行不折行的最小可读宽度)", () => {
  it("字符宽 = 13px × 0.6em 近似(等宽字体 advance 通用近似)", () => {
    expect(MONOSPACE_CHAR_WIDTH_PX).toBeCloseTo(7.8, 6);
  });

  it("行字符数 = 58ch(地址列 16 + 间距 1 + 字节组列 26 + 间距 1 + 特殊显示 10 + 行内边距 4)", () => {
    expect(HEX_ROW_MIN_CHARS).toBe(58);
  });

  it("MIN_COLUMN_WIDTH = 字符宽 × 行字符数", () => {
    expect(MIN_COLUMN_WIDTH).toBeCloseTo(MONOSPACE_CHAR_WIDTH_PX * HEX_ROW_MIN_CHARS, 6);
    expect(MIN_COLUMN_WIDTH).toBeCloseTo(452.4, 6);
  });

  it("WIDE_MIN_PX = 2 × MIN_COLUMN_WIDTH + 列间空隙(列间距 × 2 + 分隔条宽)", () => {
    expect(WIDE_MIN_PX).toBeCloseTo(
      2 * MIN_COLUMN_WIDTH + 2 * COLUMN_GAP_PX + COLUMN_DIVIDER_WIDTH_PX,
      6,
    );
    expect(WIDE_MIN_PX).toBeCloseTo(932.8, 6);
  });

  it("NARROW_MAX_PX = MIN_COLUMN_WIDTH + 容器水平内边距(单列可读下限)", () => {
    expect(NARROW_MAX_PX).toBeCloseTo(MIN_COLUMN_WIDTH + CONTAINER_PADDING_PX, 6);
    expect(NARROW_MAX_PX).toBeCloseTo(468.4, 6);
  });

  it("阈值语义自洽:单列档上限 ≥ 最小列宽;宽屏门槛 ≥ 单列档上限", () => {
    expect(NARROW_MAX_PX).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH);
    expect(WIDE_MIN_PX).toBeGreaterThan(NARROW_MAX_PX);
  });
});

describe("高度阈值推导式(块轴:面板 chrome + N 个字节行单位 ⇒ 窗高下限)", () => {
  it("行单位 = 行字号 13px × line-height 1.6 = 20.8px", () => {
    expect(HEX_ROW_FONT_SIZE_PX).toBe(13);
    expect(HEX_ROW_HEIGHT_PX).toBeCloseTo(HEX_ROW_FONT_SIZE_PX * 1.6, 6);
    expect(HEX_ROW_HEIGHT_PX).toBeCloseTo(20.8, 6);
  });

  it("列头行 = 一个行单位 + 底边框", () => {
    expect(BYTE_HEADER_ROW_HEIGHT_PX).toBeCloseTo(HEX_ROW_HEIGHT_PX + 1, 6);
    expect(BYTE_HEADER_ROW_HEIGHT_PX).toBeCloseTo(21.8, 6);
  });

  it("面板 chrome = 标题栏 + 字节视图边框 + 工具区 + 列头行(逐项登记,漂移即红)", () => {
    expect(TAB_BAR_HEIGHT_PX).toBe(26);
    expect(BYTE_VIEW_BORDER_BLOCK_PX).toBe(1);
    expect(BYTE_TOOLBAR_HEIGHT_PX).toBeCloseTo(133.3, 6);
    expect(PANEL_CHROME_HEIGHT_PX).toBeCloseTo(
      TAB_BAR_HEIGHT_PX +
        BYTE_VIEW_BORDER_BLOCK_PX +
        BYTE_TOOLBAR_HEIGHT_PX +
        BYTE_HEADER_ROW_HEIGHT_PX,
      6,
    );
    expect(PANEL_CHROME_HEIGHT_PX).toBeCloseTo(182.1, 6);
  });

  it("可见行数 N = 4(32 字节 = 缓冲区首 16 + 保存的 rbp 8 + 返回地址 8)", () => {
    expect(MIN_VISIBLE_HEX_ROWS).toBe(4);
  });

  it("高度下限与宽度侧同法可推导:PANEL_CHROME + N × 行单位(上取整)", () => {
    expect(MIN_ROW_HEIGHT_PX).toBe(
      Math.ceil(PANEL_CHROME_HEIGHT_PX + MIN_VISIBLE_HEX_ROWS * HEX_ROW_HEIGHT_PX),
    );
    expect(MIN_ROW_HEIGHT_PX).toBe(266);
  });
});

describe("selectLayoutPreset 判定边界(纯函数)", () => {
  it("w ≥ WIDE_MIN_PX → P0", () => {
    expect(selectLayoutPreset(WIDE_MIN_PX).id).toBe("P0");
    expect(selectLayoutPreset(1440).id).toBe("P0");
  });

  it("NARROW_MAX_PX ≤ w < WIDE_MIN_PX → P1(含两端邻界)", () => {
    expect(selectLayoutPreset(WIDE_MIN_PX - 0.1).id).toBe("P1");
    expect(selectLayoutPreset(NARROW_MAX_PX).id).toBe("P1");
    expect(selectLayoutPreset(800).id).toBe("P1");
  });

  it("w < NARROW_MAX_PX → P2(含 0 与非法输入)", () => {
    expect(selectLayoutPreset(NARROW_MAX_PX - 0.1).id).toBe("P2");
    expect(selectLayoutPreset(420).id).toBe("P2");
    expect(selectLayoutPreset(0).id).toBe("P2");
    expect(selectLayoutPreset(Number.NaN).id).toBe("P2");
    expect(selectLayoutPreset(-100).id).toBe("P2");
  });
});

describe("列宽预设档(视口占比;1/4、1/3、1/2、2/3、全宽)", () => {
  it("恰五档且逐档严格递增,末档 = 全宽(1)", () => {
    const ratios = COLUMN_WIDTH_PRESETS.map((preset) => preset.ratio);
    expect(ratios).toEqual([1 / 4, 1 / 3, 1 / 2, 2 / 3, 1]);
    for (let index = 1; index < ratios.length; index += 1) {
      expect(ratios[index]).toBeGreaterThan(ratios[index - 1] as number);
    }
    expect(ratios.at(-1)).toBe(1);
  });

  it("每档携带稳定 id 与 i18n 键(菜单入口与快照断言同源)", () => {
    expect(COLUMN_WIDTH_PRESETS.map((preset) => preset.id)).toEqual([
      "quarter",
      "third",
      "half",
      "two-thirds",
      "full",
    ]);
    for (const preset of COLUMN_WIDTH_PRESETS) {
      expect(preset.labelKey.length).toBeGreaterThan(0);
    }
  });
});

/**
 * 工作区布局预设与可读性阈值(WP-72 / D-MP-1 微调定案;单一来源常量表)。
 *
 * 本模块是**默认列排布的唯一来源**:P0 / P1 / P2 三张常量表 + 一个纯判定函数
 * `selectLayoutPreset(viewportWidth)`。预设经 `WorkspaceLayoutModel.bindWindows
 * (entries, columns)` 的 `columns` 参数**单点注入**工作区——不得在任何其它
 * 位置再写一份默认列排布(第二处默认布局即红灯)。
 *
 * ── 阈值推导(登记推导式,不得随意取整)───────────────────────────────────────
 *
 * 可读性目标是「十六进制行不折行」:字节视图行(`src/views/byte/byte-view.ts`)
 * 是三段网格 —— 地址段 / 十六进制字节段 / 特殊显示(ASCII)段,行宽约束直接
 * 决定一个窗口能否被读懂。逐段数出字符数(以 13px 号等宽字体、`ch` 单位):
 *
 *   | 段 | 来源(CSS / 数据) | 字符数 |
 *   |---|---|---|
 *   | 地址列 | `grid-template-columns: 16ch`(内容 = `0x` + 8 位十六进制 = 10 字符,取较宽者) | 16 |
 *   | 列间距 | `column-gap: 1ch` | 1 |
 *   | 字节组列 | `26ch`(内容 = 8 字节 × 2 + 组间空格 1 = 17,取较宽者) | 26 |
 *   | 列间距 | `column-gap: 1ch` | 1 |
 *   | 特殊显示列 | 8 cell × (1 字符 + `margin-inline-end: 0.25ch`) | 10 |
 *   | 行内边距 | `padding-inline: 0.75rem` × 2 = 24px ÷ 7.8px = 3.08 → 上取整 | 4 |
 *   | **合计** | | **58ch** |
 *
 * 字符宽取 **13px × 0.6em**(`HEX_ROW_FONT_SIZE_PX` / `MONOSPACE_ADVANCE_EM`):
 * 13px = 组件既有字号(`font-size: 0.8125rem`,与「字号下限 13px」一致);0.6em
 * 是常见等宽字体的 advance 近似(DejaVu Sans Mono / Menlo 0.602、Consolas 0.55、
 * Cascadia Mono 0.6——取 0.6 为通用近似,登记理由见下)。⇒ 字符宽 = 7.8px。
 *
 * 由此(全部为登记常量,数值由推导式机检固定于
 * `test/workspace/layout-presets.test.ts`):
 *
 *  - `MIN_COLUMN_WIDTH = 58ch × 7.8px = 452.4px`(十六进制行不折行的最小可读宽度);
 *  - `WIDE_MIN_PX = 2 × MIN_COLUMN_WIDTH + 2 × 列间距 + 分隔条宽 = 932.8px`
 *    (≥2 列并排可读 + 其间的一个列间空隙);
 *  - `NARROW_MAX_PX = MIN_COLUMN_WIDTH + CONTAINER_PADDING_PX = 468.4px`(单列可读下限)。
 *
 * 判定:`w ≥ WIDE_MIN_PX` → **P0**(5 列);`NARROW_MAX_PX ≤ w < WIDE_MIN_PX` →
 * **P1**(3 列预设合并);`w < NARROW_MAX_PX` → **P2**(单列纵向 + 窗口切换条聚焦)。
 * 两个栏界的关系自检见测试:`NARROW_MAX_PX ≥ MIN_COLUMN_WIDTH` 且
 * `WIDE_MIN_PX > NARROW_MAX_PX`(阈值语义不冲突)。
 */

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
} from "./tab-registry.js";
import type { SmMessageKey } from "../i18n/i18n.js";

/** 行字号(px;`font-size: 0.8125rem` = 13px,与「字号下限 13px」一致)。 */
export const HEX_ROW_FONT_SIZE_PX = 13;
/** 等宽字体字符宽近似(em;0.6 为常见等宽字体 advance 通用近似)。 */
export const MONOSPACE_ADVANCE_EM = 0.6;
/** 等宽字符宽(px)= 字号 × advance 近似。 */
export const MONOSPACE_CHAR_WIDTH_PX = HEX_ROW_FONT_SIZE_PX * MONOSPACE_ADVANCE_EM;
/** 十六进制行不折行(含行内边距)所需字符数(推导表见模块头注释)。 */
export const HEX_ROW_MIN_CHARS = 58;
/** 列间距(px;`.columns` 的 `gap: 0.5rem`;每侧各一)。 */
export const COLUMN_GAP_PX = 8;
/** 列间分隔条宽度(px;`.column-divider` 的 `inline-size: 0.75rem`)。 */
export const COLUMN_DIVIDER_WIDTH_PX = 12;
/** 列区容器水平内边距合计(px;`.columns` 的 `padding: 0.5rem` × 2)。 */
export const CONTAINER_PADDING_PX = 16;

/** 列宽最小护栏(px):十六进制行不折行的最小可读宽度。 */
export const MIN_COLUMN_WIDTH = HEX_ROW_MIN_CHARS * MONOSPACE_CHAR_WIDTH_PX;
/**
 * 宽屏门槛(px):≥2 列并排可读 —— 两列最小可读宽 + 其间的一个列间空隙
 * (列间距 × 2 + 分隔条宽;分隔条是列间空隙的呈现形态,计入并排间距)。
 */
export const WIDE_MIN_PX =
  2 * MIN_COLUMN_WIDTH + 2 * COLUMN_GAP_PX + COLUMN_DIVIDER_WIDTH_PX;
/** 窄条上限(px):单列可读下限(低于此值即单列纵向降级)。 */
export const NARROW_MAX_PX = MIN_COLUMN_WIDTH + CONTAINER_PADDING_PX;

/** 布局预设档标识(P0 宽屏 / P1 中宽 / P2 窄条)。 */
export type LayoutPresetId = "P0" | "P1" | "P2";

/** 布局预设:列分组(每列 = 类型键有序序列)+ 档标识 + 该档宽度下限。 */
export interface LayoutPreset {
  readonly id: LayoutPresetId;
  /** 列分组:内层数组为「该列窗口类型键有序序列」。 */
  readonly columns: readonly (readonly string[])[];
  /** 该档生效的视口宽下限(px;判定式见模块头注释)。 */
  readonly minViewportWidth: number;
}

/**
 * **P0(宽屏 5 列,规范单一来源)**:列 1 = 栈视图 + 寄存器视图;列 2 = 指令视图 +
 * 自由视图;列 3 = Payload 搭建;列 4 = 调用栈 + 结构视图;列 5 = 时间线 +
 * checkpoint + 内存 diff。
 */
export const LAYOUT_PRESET_P0: LayoutPreset = {
  id: "P0",
  minViewportWidth: WIDE_MIN_PX,
  columns: [
    [STACK_TAB_TYPE, REGISTERS_TAB_TYPE],
    [DEBUG_TAB_TYPE, FREE_TAB_TYPE],
    [PAYLOAD_TAB_TYPE],
    [CALL_STACK_TAB_TYPE, STRUCTURE_TAB_TYPE],
    [TIMELINE_TAB_TYPE, CHECKPOINTS_TAB_TYPE, MEMORY_DIFF_TAB_TYPE],
  ],
};

/** **P1(中宽 3 列预设合并)**:宽屏预设按列合并关系收纳(登记序不改)。 */
export const LAYOUT_PRESET_P1: LayoutPreset = {
  id: "P1",
  minViewportWidth: NARROW_MAX_PX,
  columns: [
    [STACK_TAB_TYPE, REGISTERS_TAB_TYPE, FREE_TAB_TYPE],
    [DEBUG_TAB_TYPE, STRUCTURE_TAB_TYPE, CALL_STACK_TAB_TYPE],
    [PAYLOAD_TAB_TYPE, TIMELINE_TAB_TYPE, CHECKPOINTS_TAB_TYPE, MEMORY_DIFF_TAB_TYPE],
  ],
};

/**
 * **P2(窄条单列纵向)**:全部窗口按登记序单列纵向排布;窗口切换由既有菜单
 * 「窗口」聚焦组承担(不再新增开关入口)。
 */
export const LAYOUT_PRESET_P2: LayoutPreset = {
  id: "P2",
  minViewportWidth: 0,
  columns: [
    [
      STACK_TAB_TYPE,
      FREE_TAB_TYPE,
      REGISTERS_TAB_TYPE,
      PAYLOAD_TAB_TYPE,
      DEBUG_TAB_TYPE,
      STRUCTURE_TAB_TYPE,
      CALL_STACK_TAB_TYPE,
      MEMORY_DIFF_TAB_TYPE,
      TIMELINE_TAB_TYPE,
      CHECKPOINTS_TAB_TYPE,
    ],
  ],
};

/** 全部预设(档位由宽到窄;`selectLayoutPreset` 与「重置布局」同源消费)。 */
export const LAYOUT_PRESETS: readonly LayoutPreset[] = [
  LAYOUT_PRESET_P0,
  LAYOUT_PRESET_P1,
  LAYOUT_PRESET_P2,
];

/**
 * 视口宽 → 布局预设(纯函数;判定式见模块头注释)。
 * 非法输入(非有限 / ≤0)确定性落到最窄档 P2。
 */
export function selectLayoutPreset(viewportWidth: number): LayoutPreset {
  if (!Number.isFinite(viewportWidth) || viewportWidth < NARROW_MAX_PX) {
    return LAYOUT_PRESET_P2;
  }
  return viewportWidth >= WIDE_MIN_PX ? LAYOUT_PRESET_P0 : LAYOUT_PRESET_P1;
}

/** 按档标识取预设(未知标识回落 P0;「重置布局」按当前档取表)。 */
export function layoutPresetById(id: LayoutPresetId): LayoutPreset {
  return LAYOUT_PRESETS.find((preset) => preset.id === id) ?? LAYOUT_PRESET_P0;
}

/** 列宽预设档(1/4、1/3、1/2、2/3、全宽;以**视口占比**表达)。 */
export interface ColumnWidthPreset {
  readonly id: string;
  /** 视口占比(0 < ratio ≤ 1;进入模型快照面并夹取到 `MIN_COLUMN_WIDTH`)。 */
  readonly ratio: number;
  /** 菜单入口文案键(i18n 双目录同键集机检)。 */
  readonly labelKey: SmMessageKey;
}

/**
 * 五档列宽(中期计划 §2.2 第 2 条):作用于**焦点列**(Niri 式),占比形态进入
 * `WorkspaceLayoutModel` 快照面(`columns[].widthRatio`);模型按
 * `MIN_COLUMN_WIDTH / 视口宽` 夹取下限(可读性护栏)。
 */
export const COLUMN_WIDTH_PRESETS: readonly ColumnWidthPreset[] = [
  { id: "quarter", ratio: 1 / 4, labelKey: "menu.widthQuarter" },
  { id: "third", ratio: 1 / 3, labelKey: "menu.widthThird" },
  { id: "half", ratio: 1 / 2, labelKey: "menu.widthHalf" },
  { id: "two-thirds", ratio: 2 / 3, labelKey: "menu.widthTwoThirds" },
  { id: "full", ratio: 1, labelKey: "menu.widthFull" },
];

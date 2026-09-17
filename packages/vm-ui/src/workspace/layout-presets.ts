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
/**
 * 列间距(px;`.columns` 的 `gap: 0.5rem`;每侧各一)。同一数值也是**列内**子项
 * (窗口面板 / 窗高分隔条)之间的间距(`.column { gap: 0.5rem }`)——两处共用同一
 * 字号基准,故单常量登记;列内下限之和的算式消费它(见 `columnMinHeightPx`)。
 */
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

/* ── 块轴(高度)阈值推导 ────────────────────────────────────────────────────────
 *
 * 宽度侧的口径是「十六进制行不折行」(见上);高度侧此前**没有推导式** ——
 * 落地值是一句裸的 `.tab-panel { min-block-size: 9rem }`(144px),既未登记
 * 依据、也不足以真正显示一行字节(实测面板内字节视图工具区即 > 144px)。
 * 本段按与宽度侧同样的方式把高度下限**推导**出来并登记(数值由
 * `test/workspace/layout-presets.test.ts` 机检固定)。
 *
 * 口径与宽度侧**同前提**:「十六进制行不折行」(即宽度侧护栏成立)。若行折行,
 * 行高不再是一个行单位,而下限的语义是「一屏至少看见 N 行」——折行属于宽度侧
 * 缺陷,不在此处放大成高度下限。
 *
 * 逐段量出「面板顶部 → 第一行数据行」之间的**面板内 chrome**(px):
 *
 *   | 段 | 来源(CSS / 实测) | 高度 |
 *   |---|---|---|
 *   | 面板标题栏 | `.tab-bar`(实测,`_probe-fix.mjs --mode=workspace`) | 26 |
 *   | 字节视图上边框 | `sm-byte-view` 的 `:host { border: 1px solid }` | 1 |
 *   | 字节视图工具区 | 实测 133.3(免折行宽 766px;含标题行 / 区域与偏移控件 / 锚点条 / 跳转状态行) | 133.3 |
 *   | 字节视图列头行 | 行单位 + `border-block-end: 1px`(`.header-row`) | 21.8 |
 *   | **合计 `PANEL_CHROME_HEIGHT_PX`** | | **182.1** |
 *
 * 行单位(`HEX_ROW_HEIGHT_PX`)= 行字号 × `.byte-row` 的 `line-height: 1.6`
 * = 13 × 1.6 = **20.8px**。
 *
 * N 取 **4**(`MIN_VISIBLE_HEX_ROWS`):一行 8 字节 ⇒ 4 行 = 32 字节 = MVP
 * 教学闭环「缓冲区首 16 字节 + 保存的 rbp 8 字节 + 返回地址 8 字节」的最小
 * 可视片段;N < 4 时该闭环无法在一屏内同时看见(需要滚动才能对照,失去
 * 「一眼看懂」的教学价值)。
 *
 * ⇒ **面板内容盒下限 = 182.1 + 4 × 20.8 = 265.3 → 上取整 266px**
 * (落地点 = `layout-divider.ts` 的 `MIN_ROW_HEIGHT_PX`,同时充当窗高拖拽下限;
 * 渲染层在 `.tab-panel` 的 `min-block-size` 与「列内下限之和」两处消费)。
 *
 * 已知偏离(实测,不在本推导内):`sm-byte-tab` 的 14rem VMA 侧栏 + `.byte-row`
 * 固定的 58ch 网格使**现有三档列宽下**字节视图实际只有 ≈220px 宽 ⇒ 工具区与
 * 数据行都会折行(实测工具区 328.3、数据行 236.8~259.6)。宽度侧缺陷会把
 * 「一屏 N 行」的语义一并吃掉,但修它属于列宽 / 侧栏口径,不在高度下限内处理。
 */
/** 面板标题栏高度(px;实测 `.tab-bar`)。 */
export const TAB_BAR_HEIGHT_PX = 26;
/** 字节视图自身边框(块轴单侧,px;`sm-byte-view :host` 的 `border: 1px solid`)。 */
export const BYTE_VIEW_BORDER_BLOCK_PX = 1;
/** 字节视图工具区高度(px;免折行宽下实测:工具行 ×2 + 锚点条 + 跳转状态行 + 内边距 + 底边框)。 */
export const BYTE_TOOLBAR_HEIGHT_PX = 133.3;
/** 字节行行高(px)= 行字号 × `line-height: 1.6`(一行 8 字节)。 */
export const HEX_ROW_HEIGHT_PX = HEX_ROW_FONT_SIZE_PX * 1.6;
/** 字节视图列头行高度(px)= 一个行单位 + 底边框。 */
export const BYTE_HEADER_ROW_HEIGHT_PX = HEX_ROW_HEIGHT_PX + 1;
/** 面板顶部 → 第一行数据行之间的 chrome 合计(px;推导表见上)。 */
export const PANEL_CHROME_HEIGHT_PX =
  TAB_BAR_HEIGHT_PX + BYTE_VIEW_BORDER_BLOCK_PX + BYTE_TOOLBAR_HEIGHT_PX + BYTE_HEADER_ROW_HEIGHT_PX;
/** 下限语义要保证的可见字节行数(4 行 = 32 字节;取 4 的理由见上)。 */
export const MIN_VISIBLE_HEX_ROWS = 4;
/** 面板边框块轴单侧厚度(px;`.tab-panel { border: 1px solid }`;content-box ⇒ 不计入内容盒下限)。 */
export const PANEL_BORDER_BLOCK_PX = 1;

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

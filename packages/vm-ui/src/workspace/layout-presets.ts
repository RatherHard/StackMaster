/**
 * 工作区可读性阈值与视图默认顺序(单一来源常量表)。
 *
 * ── 2026-09-18 整页布局改版(D-API-153 / D-UI-1 ~ D-UI-7)────────────────────
 *
 * 本模块**曾**是「Niri 式列条带」的默认列排布唯一来源:P0 / P1 / P2 三张预设表
 * + `selectLayoutPreset(viewportWidth)` 纯函数 + 阈值表(`MIN_COLUMN_WIDTH` /
 * `WIDE_MIN_PX` / `NARROW_MAX_PX`)+ 列宽五档(`COLUMN_WIDTH_PRESETS`)。
 *
 * **本版废止(整条退出,不留兼容别名)**:
 *  - 视口宽预设 **P0 / P1 / P2** 三档与阈值判定表(`WIDE_MIN_PX` /
 *    `NARROW_MAX_PX` 的**档位判定**语义)、`selectLayoutPreset`、
 *    `layoutPresetById`、`LayoutPresetId`、`LAYOUT_PRESETS` / `LAYOUT_PRESET_*`;
 *  - 列宽五档 `COLUMN_WIDTH_PRESETS`(列结构随列条带退场);
 *  - 块轴(高度)阈值推导整段:面板标题栏 / 字节视图边框 / 工具区 / 列头行、
 *    `PANEL_CHROME_HEIGHT_PX` / `MIN_VISIBLE_HEX_ROWS` / `TAB_BAR_HEIGHT_PX` /
 *    `BYTE_*` / `COLUMN_GAP_PX` / `COLUMN_DIVIDER_WIDTH_PX` /
 *    `CONTAINER_PADDING_PX`、以及 **D-API-152 的窗高下限 `MIN_ROW_HEIGHT_PX`
 *    (= 266px)** —— 该下限与其配套的 `columnMinHeightPx` / `columnChromePx` /
 *    拖拽像素语义一并废止(载体 = `layout-divider.ts`,已删除)。
 *    **D-API-152 条目本身是历史决策,不得删除**(权威文本 =
 *    `docs/develop/决策…` 与 `docs/develop/前端的交互和开发设计.md` 文末
 *    2026-09-17 增补);本处只登记「本版废止」。
 *
 * **本版保留并重新定位**:
 *  - 宽度**推导值本身仍然有效** —— `HEX_ROW_FONT_SIZE_PX` /
 *    `MONOSPACE_ADVANCE_EM` / `MONOSPACE_CHAR_WIDTH_PX` / `HEX_ROW_MIN_CHARS`
 *    / `MIN_COLUMN_WIDTH`;但**载体变了**:它现在约束**左半侧的宽度底线**
 *    (见下 `SIDE_PANEL_MIN_WIDTH_PX` 与 D-UI-5),不再约束「列宽」。
 *  - `content-visibility` 视口外降级渲染(与布局形态无关)。
 *
 * ── 宽度推导(逐段字符数,不得随意取整)──────────────────────────────────────
 *
 * 可读性目标是「十六进制行不折行」:字节视图行(`src/views/byte/byte-view.ts`)
 * 是三段网格 —— 地址段 / 十六进制字节段 / 特殊显示(ASCII)段,行宽约束直接
 * 决定一个视图位能否被读懂。逐段数出字符数(以 13px 号等宽字体、`ch` 单位):
 *
 *   | 段 | 来源(CSS / 数据) | 字符数 |
 *   |---|---|---|
 *   | 地址列 | `grid-template-columns: 16ch`(内容 = `0x` + 8 位十六进制 = 10 字符,取较宽者) | 16 |
 *   | 列间距 | `column-gap: 1ch` | 1 |
 *   | 字节组列 | `26ch`(内容 = 8 字节 × 2 + 组间空格 1 = 17,取较宽者) | 26 |
 *   | 列间距 | `column-gap: 1ch` | 1 |
 *   | 特殊显示列 | 8 cell × (1 字符 + `margin-inline-end: 0.25ch`) | 10 |
 *   | 行内边距 | `padding-inline: 0.75rem` × 2 = 24px ÷ 7.8px = 3.08 → 上取整 | 4 |
 *   | **合计 `HEX_ROW_MIN_CHARS`** | | **58ch** |
 *
 * 字符宽取 **13px × 0.6em**(`HEX_ROW_FONT_SIZE_PX` / `MONOSPACE_ADVANCE_EM`):
 * 13px = 组件既有字号(`font-size: 0.8125rem`,与「字号下限 13px」一致);0.6em
 * 是常见等宽字体的 advance 近似(DejaVu Sans Mono / Menlo 0.602、Consolas 0.55、
 * Cascadia Mono 0.6 —— 取 0.6 为通用近似)。
 * ⇒ 字符宽 `MONOSPACE_CHAR_WIDTH_PX` = 7.8px,
 *   `MIN_COLUMN_WIDTH` = 58ch × 7.8px = **452.4px**(十六进制行不折行的最小可读宽度)。
 *
 * **⚠ 适用条件(2026-09-19 主控改述;D-UI-5 补,原「遗留 #36 已知偏离」已结案)**:
 * 字节视图自带 `14rem`(224px)VMA 侧栏(`src/workspace/byte-tab.ts` 的
 * `grid-template-columns: minmax(0, 1fr) 14rem`)⇒ 本常量**不含该侧栏**,
 * 它保证的只是「**十六进制行本身**不折行」。
 * **明文承认的代价**:**左半侧宽 < ≈766px 时,字节视图必有某种降级**
 * (折叠 VMA 侧栏 / 列头折行 / 视图内横向滚动)—— 这是**已接受的代价,不是缺陷**。
 * 阈值依据的落地形态(WP-95a / 遗留 #39):`byte-tab.ts` 按**容器宽**在 40rem
 * 折叠侧栏、`byte-view.ts` 把第三轨改可伸缩;见该两处注释的推导。
 * 「把本底线抬到 ≈766px」**已被否决**(会把表达力问题变成准入问题:
 * 固定 1:1 ⇒ 需视口 ≥ 1532px,1024 / 1366 笔记本被判不可用;**不得复活**)。
 *
 * ── 视图位可读高度(可读性纪律的**新载体**)──────────────────────────────────
 *
 * 本版把「压缩以适配」机制**整条移除**:空间不足时**只滚动、不压缩**。
 * 可读性由「左半侧纵向滚动承载溢出 + **每个视图位有确定高度**」满足 ——
 * 判据 = **不得出现「视图被压到装不下一行字节」**(历史反例:2026-09-17 取证,
 * 4 窗列每窗 146px 而面板 chrome 实测 182.1px)。
 *
 * 故本模块**新增**一组「视图位高度」常量(与已废止的 `MIN_ROW_HEIGHT_PX` 是
 * **不同口径**:后者是「面板总高下限 = chrome + N 行」的**布局压缩下限**;
 * 本组是「左半侧两个可见视图位各自的高度」= **等分左半侧可视高**,
 * 下限只保证「恰好装得下 `VIEW_SLOT_MIN_VISIBLE_HEX_ROWS` 行」)
 * ——算式见 `viewSlotHeightPx()`,落地点 = `sm-workspace.ts` 的 `.ws-view` 内联高。
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

// ── 宽度推导面(保留并重新定位:载体 = 左半侧宽度底线,见 D-UI-5)──────────────

/** 行字号(px;`font-size: 0.8125rem` = 13px,与「字号下限 13px」一致)。 */
export const HEX_ROW_FONT_SIZE_PX = 13;
/** 等宽字体字符宽近似(em;0.6 为常见等宽字体 advance 通用近似)。 */
export const MONOSPACE_ADVANCE_EM = 0.6;
/** 等宽字符宽(px)= 字号 × advance 近似 = 7.8px。 */
export const MONOSPACE_CHAR_WIDTH_PX = HEX_ROW_FONT_SIZE_PX * MONOSPACE_ADVANCE_EM;
/** 十六进制行不折行(含行内边距)所需字符数(推导表见模块头注释)。 */
export const HEX_ROW_MIN_CHARS = 58;
/** 十六进制行行高(px)= 行字号 × `.byte-row` 的 `line-height: 1.6` = 20.8px。 */
export const HEX_ROW_HEIGHT_PX = HEX_ROW_FONT_SIZE_PX * 1.6;

/**
 * 十六进制行不折行的最小可读宽度(px)= `HEX_ROW_MIN_CHARS` ×
 * `MONOSPACE_CHAR_WIDTH_PX` = **452.4px**。
 *
 * 推导式与前提见模块头注释(含遗留 #36 的已知偏离:该值**不含**字节视图自带的
 * 14rem 侧栏)。**注意**:该推导的载体已由「列宽」改为「左半侧宽度底线」
 * (`SIDE_PANEL_MIN_WIDTH_PX`);本常量保留原名以维持推导表的可追溯性。
 */
export const MIN_COLUMN_WIDTH = HEX_ROW_MIN_CHARS * MONOSPACE_CHAR_WIDTH_PX;

/**
 * **左半侧宽度底线(px)** —— 按 **D-UI-5**:该推导值**改挂左半侧宽度底线**。
 *
 * 整页布局不改变形态(左半侧 + 右半侧恒同屏);窄屏(视口宽 < 两半侧可读宽之和)
 * 时左半侧获得本 `min-width` 底线,**页面横向滚动**。
 * 取值 = `MIN_COLUMN_WIDTH`(同一推导值,不新发明):列条带废止 ⇒
 * 「十六进制行不折行」的**载体**由列宽变为左半侧宽。
 *
 * **含义改述(D-UI-5 补 / 2026-09-19 主控裁定;数值一个字不改)**:
 * 本底线保证的是「**十六进制行本身**不折行」(`58ch × 7.8px`),
 * **不含**字节视图自带的 `14rem`(224px)VMA 侧栏;且
 * **左半侧宽 < ≈766px 时字节视图必有某种降级**(折叠侧栏 / 折行 / 横向滚动),
 * 这是**已接受的代价,不是缺陷**。⇒ **不得**据本底线推断「一行字节一定能完整
 * 看见」;「完整可见数据行 ≥ 1」是**独立**的几何红线,由
 * `apps/page-app/e2e/geometry-guard.spec.ts` 真机量「**完整可见行盒数**」判定
 * (遗留 #39 的教训:量容器高会漏,见该文件头)。
 *
 * **N 的适用范围(D-UI-2 补)**:`N ≥ 1` = **红线**(全视口全引擎无条件);
 * `N = 4` = **条件目标**,**只在免折行宽度档(1440 类,依据 = 上面那条 ≈766px
 * 实测约束)要求**,其余档明文接受降级。**不得**把 `N` 悄悄改成 2 以制造达标。
 *
 * **否决项(D-UI-5,不得复活)**:窄屏隐藏右半侧 / 改为抽屉或 Tab 切换(需求把
 * 右半侧定为「固定」);窄屏改为上下堆叠;新增断点阈值表的替代物(预设阈值表已废止);
 * **把本底线抬到 ≈766px**(理由见模块头;会把表达力问题变成准入问题)。
 */
export const SIDE_PANEL_MIN_WIDTH_PX = MIN_COLUMN_WIDTH;

/** 左右两分比例(固定 1:1;D-UI-1:不可调、无分界拖拽手柄)。 */
export const SIDE_PANEL_FRACTION = "1fr";

// ── 视图位高度面(可读性纪律的新载体)──────────────────────────────────────────

/**
 * 面板「非数据行」chrome 高度(px):视图类型名标签行(`.view-label`)+
 * 视图位上下边框 + 字节视图工具区 / 列头行的**保守合计占位**。
 *
 * 用途 = `viewSlotHeightPx()` 的算式输入,**不参与任何布局压缩决策**
 * (压缩机制已整条移除)。
 *
 * 推导(2026-09-17 真机实测值,口径 = 免折行宽 766px 下的字节视图):
 *  - `.view-label` 行 = 1 行单位(20.8)+ `padding-block` 4 = 24.8;
 *  - 字节视图上边框 1(D-API-152 取证的 `BYTE_VIEW_BORDER_BLOCK_PX`);
 *  - 字节视图工具区 133.3(D-API-152 取证的 `BYTE_TOOLBAR_HEIGHT_PX`);
 *  - 字节视图列头行 21.8(一个行单位 + 1px 底边框)。
 *  ⇒ 24.8 + 1 + 133.3 + 21.8 = **180.9px**(比 D-API-152 的 182.1 少 1.2px,
 *  因本版无 .tab-bar 而多出 `.view-label` 行)。
 */
export const VIEW_PANEL_CHROME_HEIGHT_PX = HEX_ROW_HEIGHT_PX + 4 + 1 + 133.3 + (HEX_ROW_HEIGHT_PX + 1);

/**
 * 一个视图位**至少**要看得见的字节数据行数 = **4 行**(= 32 字节)。
 *
 * 取值理由与 D-API-152 的 N = 4 同源:一行 8 字节 ⇒ 4 行 = 32 字节 =
 * MVP 教学闭环「缓冲区首 16 字节 + 保存的 rbp 8 字节 + 返回地址 8 字节」的
 * 最小可视片段;N < 4 时该闭环无法在一屏内同时看见(需滚动才能对照,
 * 失去「一眼看懂」的教学价值)。
 *
 * **判据(D-UI-2 / FE-WS-15)**:左半侧每个**可见视图位**的 `clientHeight` 减去
 * `VIEW_PANEL_CHROME_HEIGHT_PX` 之后,必须容纳 ≥ 本常量个行单位。
 */
export const VIEW_SLOT_MIN_VISIBLE_HEX_ROWS = 4;

/**
 * 字节视图**自身**的可见数据行下限(行数)= 4。
 *
 * 与 `VIEW_SLOT_MIN_VISIBLE_HEX_ROWS` 同值但**不同面**:后者约束「工作区给出的
 * 视图位高度」,本常量约束「字节视图内容盒的下限」—— 窄屏下字节视图工具区会
 * 因换行长高(真机实测 768 宽档下工具区 252px,挤压数据行至接近 0),故字节视图
 * 自身需要一条地板:内容盒不低于 `chrome + N 行`,且**视图位必须胜出**
 * (`sm-workspace` 的 `.tab-content` 用 `overflow: visible` 让视口裁剪,而不是
 * 内层滚动条吞掉数据区 —— 否则本下限会被内层滚动抵消)。
 *
 * 判据同 FE-WS-15:**不得出现「视图被压到装不下一行字节」**;N = 4 的理由
 * (一行 8 字节 ⇒ 32 字节 = MVP 教学闭环最小可视片段)与视图位下限同源。
 */
export const BYTE_VIEW_MIN_VISIBLE_HEX_ROWS = 4;

/** 字节视图内容盒下限(px)= 一个行单位 + 4 个行单位(工具区 / 列头行的占位由视口裁剪承担)。 */
export const BYTE_VIEW_MIN_BLOCK_SIZE_PX =
  BYTE_VIEW_MIN_VISIBLE_HEX_ROWS * HEX_ROW_HEIGHT_PX;

/** 左半侧视图位之间的间隙 + 上下留白合计(px;`.ws-stack` 的 `gap: 0.5rem` ×1 + `margin-block: 0.5rem` ×2 = 24)。 */
export const VIEW_STACK_SPACING_PX = 24;
/** 左半侧列表按钮(视图管理窗口的 `<details><summary>`)占用高度(px;1 行 + 内边距)。 */
export const VIEW_LIST_BUTTON_HEIGHT_PX = HEX_ROW_HEIGHT_PX + 8;

/** 可见视图位数量(D-UI-2 定案:**固定两个**,数量不可配置)。 */
export const VISIBLE_VIEW_SLOT_COUNT = 2;

/**
 * 视图位高度换算(px;由左半侧可视高与可见视图位数推出)——
 * **算式登记在此,渲染层只消费结果**(`sm-workspace.ts` 的 `.ws-view` 内联
 * `block-size`),WP-95 真机几何断言按同一算式判据。
 *
 * 算式:
 * ```
 * 可用高 = max(0, 左半侧可视高 − 列表按钮高 − 留白合计)
 * 视位高 = floor(可用高 ÷ 可见视图位数)
 * 下限   = ceil(VIEW_PANEL_CHROME_HEIGHT_PX + VIEW_SLOT_MIN_VISIBLE_HEX_ROWS × HEX_ROW_HEIGHT_PX)
 * 结果   = max(视位高, 下限)
 * ```
 * - **可见视图位数 = 2**(D-UI-2:**固定两个可见视图位**,数量不可配置);
 * - 取 `max(…, 下限)` 即「**只滚动、不压缩**」:空间不足时视位高不低于下限,
 *   多余部分由左半侧纵向滚动承载;
 * - **N 随视口变化**:视位高 = 等分左半侧可视高 ⇒ 可见行数
 *   `= (视位高 − VIEW_PANEL_CHROME_HEIGHT_PX) ÷ HEX_ROW_HEIGHT_PX` **随视口高变化**
 *   (1440×900 下 ≈ (900 − 32 − 24.8 − 24) ÷ 2 = 409.6 → 约 11 行;
 *   320×480 这类窄矮视口下退化为下限 264px → 恰 4 行)。
 * - 非法输入(非有限 / ≤ 0)确定性回落到**下限**(不塌陷、不抛错)。
 */
export function viewSlotHeightPx(leftRoleHeightPx: number): number {
  const minHeight =
    VIEW_PANEL_CHROME_HEIGHT_PX + VIEW_SLOT_MIN_VISIBLE_HEX_ROWS * HEX_ROW_HEIGHT_PX;
  const minimum = Math.ceil(minHeight);
  if (!Number.isFinite(leftRoleHeightPx) || leftRoleHeightPx <= 0) {
    return minimum;
  }
  const usable = leftRoleHeightPx - VIEW_LIST_BUTTON_HEIGHT_PX - VIEW_STACK_SPACING_PX;
  const share = Math.floor(usable / VISIBLE_VIEW_SLOT_COUNT);
  return Math.max(share, minimum);
}

// ── 视图默认顺序(取代原「默认列排布」的唯一来源)──────────────────────────────

/**
 * **视图默认顺序(规范单一来源)**:`bindWindows(bindings)` / `resetViews()` 的
 * 顺序依据 —— 即「重置视图 = 恢复默认顺序 + 全选」的「默认顺序」定义。
 *
 * 顺序与改版前的 P0 列排布**登记序一致**(P0 逐列展平),使改版前后
 * 「视图纵向出现次序」的语义连续;本文件是**唯一来源**,工作区与菜单不得
 * 再写第二份默认顺序字面量。
 *
 * 注意:本表是**默认顺序**,不是「可见集合」——视图仍全部常驻,可见性由模型的
 * `visible` 标志承担(未勾选 = 不显示 = 「暂离」的**第二种成因**;D-MP-1 不修订)。
 */
export const DEFAULT_VIEW_ORDER: readonly string[] = [
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

/**
 * 按 `DEFAULT_VIEW_ORDER` 重排给定类型键(未登记 / 缺席的键按登记序补在末尾;
 * 结果恒为输入的全排列,无重无漏)。
 */
export function orderByDefault(types: readonly string[]): string[] {
  const known = new Set(types);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const type of DEFAULT_VIEW_ORDER) {
    if (known.has(type) && !seen.has(type)) {
      seen.add(type);
      ordered.push(type);
    }
  }
  for (const type of types) {
    if (!seen.has(type)) {
      seen.add(type);
      ordered.push(type);
    }
  }
  return ordered;
}

/**
 * 分隔条拖拽 / 键盘步进纯函数 + **块轴(高度)下限**(WP-72:列宽与窗高可调)。
 *
 * 与既有 pointer 基建的接缝:`DRAG_THRESHOLD_PX`(3px)阈值语义在组件层复用
 * (位移未过阈值 = 点击,不进入调整);本模块承担「位移 → 占比」的**数学与
 * 护栏**,并持有与拖拽共用同一数值的**窗高下限**(`MIN_ROW_HEIGHT_PX`,推导见
 * `layout-presets.ts`)与「列高下限 = 比例的函数」的算式(`columnMinHeightPx` /
 * `columnChromePx`),便于 jsdom 无布局环境下以单测固定:
 *
 *  - **列宽**:列间分隔条平移只改**左侧列**的视口占比(右侧列宽度自持,其左界
 *    随左列右界移动);夹取下限 = `MIN_COLUMN_WIDTH` 对应的占比、上限 = 1(全宽);
 *  - **窗高**:同列相邻两窗的分隔条**跟随指针**(像素语义):被增大的窗按位移
 *    变大、被减小的窗**贴着窗高下限停住**;两窗仍在富余空间内时像素和守恒
 *    (于是模型不变量「同列窗高比例和 = 1」在拖拽全程成立)——下限不可再让时
 *    多余位移转成**列高增长**(列的内容盒下界是比例的函数,见
 *    `columnMinHeightPx`),由条带 / 文档滚动承载,而不是把总量钉死;
 *  - **退化输入**:无几何基准(视口宽 / 列高 ≤ 0 或非有限)、越界索引、单窗列、
 *    自由空间非正(列高连面板边框 / 分隔条 / 列内间距都容不下)→ 原值返回
 *    (零副作用)。
 */

import {
  COLUMN_GAP_PX,
  PANEL_BORDER_BLOCK_PX,
  PANEL_CHROME_HEIGHT_PX,
  HEX_ROW_HEIGHT_PX,
  MIN_VISIBLE_HEX_ROWS,
} from "./layout-presets.js";

/** 分隔条方向键步进(px;列宽档粒度:一次按键 = 32px ≈ 4ch)。 */
export const DIVIDER_KEY_STEP_PX = 32;
/** 窗高分隔条方向键步进(占比;一次按键 = 列高的 5%)。 */
export const ROW_DIVIDER_KEY_STEP = 0.05;
/**
 * 窗高分隔条(px;`.row-divider` 的 `block-size: 0.5rem`)。
 * 列内下限之和的算式消费它(见 `columnMinHeightPx`)。
 */
export const ROW_DIVIDER_HEIGHT_PX = 8;
/**
 * 单窗最小可读高度(px;`.tab-panel` 的内容盒下限)。**双重身份**:
 *
 *  1. **布局下限** —— 渲染层把该值落到 `.tab-panel { min-block-size }`,窗高
 *     不再被 flex 等分压缩到它以下;空间不足时列的下限之和**可以**超过条带内容
 *     盒(列的内联 `min-block-size` 是比例的函数 ⇒ 列盒随比例长高,溢出的可见
 *     后代进入条带滚动区 / 文档滚动 ⇒ 画面改为滚动);
 *  2. **拖拽下限** —— `rowHeightsAfterDrag` 的像素下限(面板内容盒),
 *     用户拖不出比它更矮的窗口。
 *
 * 取值不是拍脑袋的 9rem,而是与宽度侧同法推导(推导表与 N 的取值理由见
 * `layout-presets.ts` 的「块轴(高度)阈值推导」段):
 *
 *   面板 chrome(标题栏 + 字节视图边框 + 工具区 + 列头行)182.1px
 *   + N(= 4)行 × 行高 20.8px = 265.3px → 上取整 **266px**
 *
 * 面板是 content-box ⇒ 渲染出的面板外高 = 该值 + 上下边框(`PANEL_BORDER_BLOCK_PX`
 * × 2),故「不低于下限」在渲染面同样成立(且有 2px 余量)。
 */
export const MIN_ROW_HEIGHT_PX = Math.ceil(
  PANEL_CHROME_HEIGHT_PX + MIN_VISIBLE_HEX_ROWS * HEX_ROW_HEIGHT_PX,
);

/**
 * 列内**非面板**占位合计(px):面板之外,列的内容盒被这些子项吃掉。
 *
 *   n × 2 × 面板边框(content-box ⇒ 边框在内容盒外,但计入列高)
 *   + (n−1) × 窗高分隔条
 *   + (2n−2) × 列内间距(`.column { gap: 0.5rem }`;n 个面板 + n−1 条分隔条
 *     ⇒ 子项间空隙 = 2n−2 处)
 *
 * 「列高」与「面板分得的自由空间」之间的换算基准:`F = 列高 − chrome`。拖拽的
 * 像素 ↔ 比例换算必须用 `F`(不是列高)——面板主尺寸 = 比例 × F,用列高会系统性
 * 高估可分配空间(实测:列高 852 / chrome 28 时偏差 3.3%)。
 */
export function columnChromePx(windowCount: number): number {
  if (!Number.isInteger(windowCount) || windowCount <= 0) {
    return 0;
  }
  const borders = windowCount * 2 * PANEL_BORDER_BLOCK_PX;
  const dividers = (windowCount - 1) * ROW_DIVIDER_HEIGHT_PX;
  const gaps = (2 * windowCount - 2) * COLUMN_GAP_PX;
  return borders + dividers + gaps;
}

/**
 * 单列的**列高下限**(px)= 比例的函数。
 *
 * 口径:**列高 = max(条带可用高度, 让每个面板都不低于下限所需的高度)**。
 * 面板 i 的主尺寸 = `ratio_i × F`(`F` = 列的自由空间)——要求每个面板内容盒
 * ≥ `MIN_ROW_HEIGHT_PX`,即
 *
 *   `F ≥ max_i(MIN_ROW_HEIGHT_PX / ratio_i)   (ratio_i > 0)`
 *
 * 于是列高下限 = 该下界 + `columnChromePx(n)`。**等分时退化为
 * `n × (MIN_ROW_HEIGHT_PX + 2 × 边框) + 分隔条 + 间距`** —— 即旧算式
 * (`columnMinHeightPx(n)`)是它在等分比例上的特例,不是另一套语义。
 *
 * 为什么必须是比例的函数:`.column` 是条带的弹性项,列高不足时面板会被压到
 * 下限以下(下限只剩「屏内至少 N 行字节」的意义被吃掉);而若列高被钉死在
 * 某个常数上,溢出列里的窗高拖拽就会**数学上不可能**(自由空间恒为 0,增大一
 * 窗只能靠减小同列另一窗,而另一窗已贴住下限)⇒ 拖拽无位移。列高随比例长高
 * 后:富余空间的列照旧守恒;溢出列的列盒随「贴住下限的那一窗」长高,由滚动承载。
 *
 * 非法输入(空数组 / 无正比例)返回 0(退化,不给伪下限)。
 */
export function columnMinHeightPx(heights: readonly number[]): number {
  const count = heights.length;
  if (count <= 0) {
    return 0;
  }
  const positive = heights.filter((ratio) => Number.isFinite(ratio) && ratio > 0);
  if (positive.length === 0) {
    return 0;
  }
  const freeMin = Math.max(...positive.map((ratio) => MIN_ROW_HEIGHT_PX / ratio));
  return freeMin + columnChromePx(count);
}

/** 列宽分隔条拖拽输入。 */
export interface ColumnWidthDragParams {
  /** 拖拽起始占比(左侧列的视口占比)。 */
  readonly startRatio: number;
  /** 累计位移(px;向右为正)。 */
  readonly deltaPx: number;
  /** 视口宽(px;占比换算基准)。 */
  readonly viewportWidth: number;
  /** 列宽下限(px;`MIN_COLUMN_WIDTH`)。 */
  readonly minWidthPx: number;
}

/** 列宽分隔条拖拽结果(左侧列新占比;夹取护栏与全宽上限后)。 */
export function columnWidthAfterDrag(params: ColumnWidthDragParams): number {
  const { startRatio, deltaPx, viewportWidth, minWidthPx } = params;
  if (!Number.isFinite(startRatio) || !Number.isFinite(deltaPx)) {
    return startRatio;
  }
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return startRatio; // 无几何基准(jsdom / 尺寸未就绪):不调整。
  }
  const minRatio = Number.isFinite(minWidthPx)
    ? Math.min(1, Math.max(0, minWidthPx) / viewportWidth)
    : 0;
  const next = startRatio + deltaPx / viewportWidth;
  return Math.min(Math.max(next, minRatio), 1);
}

/** 同列窗高分隔条拖拽输入。 */
export interface RowHeightDragParams {
  /** 当前窗高比例(和 = 1;长度 = 列内窗口数)。 */
  readonly heights: readonly number[];
  /** 分隔条下缘窗口序号(调整 `index` 与 `index + 1` 两窗)。 */
  readonly index: number;
  /** 累计位移(px;向下为正)。 */
  readonly deltaPx: number;
  /** 列高(px;`.column` 的 `clientHeight` = 列的内容盒高)。 */
  readonly columnHeightPx: number;
  /** 单窗最小高度(px;`MIN_ROW_HEIGHT_PX`,面板**内容盒**下限)。 */
  readonly minHeightPx: number;
}

/**
 * 同列窗高分隔条拖拽结果(新比例数组;长度与输入一致,和恒为 1)。
 *
 * **像素语义**(分隔条跟随指针):列的自由空间 `F = 列高 − columnChromePx(n)`
 * 按比例分给各面板,故面板像素高 = `比例 × F`。
 *
 *   上窗新像素 = max(上窗像素 + 位移, 下限)
 *   下窗新像素 = max(下窗像素 − 位移, 下限)
 *
 * 两窗都还在下限之上时,上式就是「一增一减、和不变」⇒ 像素和守恒、比例和恒 1
 * (富余空间列的既有语义);**被减小的窗贴住下限后**多余的位移不再从它身上扣,
 * 于是两窗像素之和变大 ⇒ 由 `columnMinHeightPx`(比例的函数)把列盒顶高、由滚动
 * 承载(溢出列的拖拽有效性)。比例 = 新像素 ÷ 新像素和(模型层再归一化一次)。
 *
 * 无法调整(见模块头注释的退化输入)时返回输入副本。
 */
export function rowHeightsAfterDrag(params: RowHeightDragParams): readonly number[] {
  const { heights, index, deltaPx, columnHeightPx, minHeightPx } = params;
  const unchanged = [...heights];
  if (index < 0 || index + 1 > heights.length - 1) {
    return unchanged; // 单窗列 / 越界:无相邻窗可分配。
  }
  if (!Number.isFinite(deltaPx) || !Number.isFinite(columnHeightPx) || columnHeightPx <= 0) {
    return unchanged; // 无几何基准。
  }
  const free = columnHeightPx - columnChromePx(heights.length);
  if (!(free > 0)) {
    return unchanged; // 列高连面板边框 / 分隔条 / 列内间距都容不下:无自由空间。
  }
  const min = Number.isFinite(minHeightPx) ? Math.max(0, minHeightPx) : 0;
  const pixels = heights.map((ratio) => (Number.isFinite(ratio) && ratio > 0 ? ratio : 0) * free);
  const before = pixels[index] ?? 0;
  const after = pixels[index + 1] ?? 0;
  const nextBefore = Math.max(before + deltaPx, min);
  const nextAfter = Math.max(after - deltaPx, min);
  const total = pixels.reduce((sum, value, position) => {
    if (position === index) {
      return sum + nextBefore;
    }
    if (position === index + 1) {
      return sum + nextAfter;
    }
    return sum + value;
  }, 0);
  if (!(total > 0)) {
    return unchanged; // 退化(全零像素):不产生非法比例。
  }
  return pixels.map((value, position) => {
    if (position === index) {
      return nextBefore / total;
    }
    if (position === index + 1) {
      return nextAfter / total;
    }
    return value / total;
  });
}

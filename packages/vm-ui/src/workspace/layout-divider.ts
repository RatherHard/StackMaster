/**
 * 分隔条拖拽 / 键盘步进纯函数(WP-72:列宽与窗高可调)。
 *
 * 与既有 pointer 基建的接缝:`DRAG_THRESHOLD_PX`(3px)阈值语义在组件层复用
 * (位移未过阈值 = 点击,不进入调整);本模块只承担「位移 → 占比」的**数学与
 * 护栏**,便于 jsdom 无布局环境下以单测固定:
 *
 *  - **列宽**:列间分隔条平移只改**左侧列**的视口占比(右侧列宽度自持,其左界
 *    随左列右界移动);夹取下限 = `MIN_COLUMN_WIDTH` 对应的占比、上限 = 1(全宽);
 *  - **窗高**:同列相邻两窗的分隔条按比例分配(两窗占比之**和恒定**,于是模型
 *    不变量「同列窗高比例和 = 1」在拖拽全程成立);两侧各夹取到窗高下限;
 *  - **退化输入**:无几何基准(视口宽 / 列高 ≤ 0 或非有限)、越界索引、单窗列、
 *    下限不可行(2 × 下限 > 两窗和)→ 原值返回(零副作用)。
 */

/** 分隔条方向键步进(px;列宽档粒度:一次按键 = 32px ≈ 4ch)。 */
export const DIVIDER_KEY_STEP_PX = 32;
/** 窗高分隔条方向键步进(占比;一次按键 = 列高的 5%)。 */
export const ROW_DIVIDER_KEY_STEP = 0.05;
/**
 * 单窗最小可读高度(px):`.tab-panel { min-block-size: 9rem }` × 16px = 144px
 * (窗高下限的像素基准;比例下限 = 该值 ÷ 列高)。
 */
export const MIN_ROW_HEIGHT_PX = 144;

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
  /** 列高(px;占比换算基准)。 */
  readonly columnHeightPx: number;
  /** 单窗最小高度(px;`MIN_ROW_HEIGHT_PX`)。 */
  readonly minHeightPx: number;
}

/**
 * 同列窗高分隔条拖拽结果(新比例数组;长度与输入一致,两窗之和恒定)。
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
  const before = heights[index] as number;
  const after = heights[index + 1] as number;
  const pairSum = before + after;
  const minRatio = Number.isFinite(minHeightPx)
    ? Math.max(0, minHeightPx) / columnHeightPx
    : 0;
  if (pairSum < 2 * minRatio) {
    return unchanged; // 下限不可行:不强行夹取(否则破坏「和恒定」不变量)。
  }
  const nextBefore = Math.min(Math.max(before + deltaPx / columnHeightPx, minRatio), pairSum - minRatio);
  const result = [...heights];
  result[index] = nextBefore;
  result[index + 1] = pairSum - nextBefore;
  return result;
}

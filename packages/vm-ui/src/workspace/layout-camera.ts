/**
 * 焦点列相机纯函数(WP-72 §2.2 第 1 条:列式滚动条带 + 相机跟随焦点列)。
 *
 * 语义(把滚动从 `scrollIntoView` 升级为**显式相机计算**):
 *  - **焦点列居中**:目标滚动位 = 焦点列中心 − 视口中心(内容坐标系);
 *  - **相邻列两侧探出**:焦点列宽 < 视口宽时,居中结果天然让左右邻列各露出
 *    一部分(暗示条带可继续滚动)——由居中算术直接保证,无需额外偏置;
 *  - **端部夹取**:不产生负滚动;给定内容总宽时不超过 `scrollWidth − 视口宽`;
 *  - **非法输入确定性回落 0**(jsdom 无布局 / 尺寸未就绪时不抛错、不跳位)。
 *
 * 本模块是纯函数、无 DOM 依赖:jsdom 下以数值单测承载,真机行为由 E2E 断言。
 * 动画纪律:本模块只算数值;平滑滚动与 `prefers-reduced-motion` 降级由调用方
 * (工作区)在 `scrollTo({ behavior })` 处决定,可复用的判定见
 * `prefersReducedMotion`。
 */

/** 列盒(内容坐标系:相对滚动容器内容左缘的偏移 + 宽度,单位 px)。 */
export interface ColumnBox {
  /** 列左界在滚动内容中的偏移(px;含容器已滚过的位移)。 */
  readonly start: number;
  /** 列宽(px)。 */
  readonly size: number;
}

/** 相机计算选项。 */
export interface CameraScrollOptions {
  /** 滚动内容总宽(px;给定即启用末端夹取,未给定则不夹取上界)。 */
  readonly scrollWidth?: number;
}

/** matchMedia 最小面(用于 `prefers-reduced-motion` 判定;无该全局时返回 null)。 */
export interface MediaQueryLike {
  readonly matches: boolean;
  readonly media?: string;
}

/** 视口矩形最小面(getBoundingClientRect 的结构子集)。 */
export interface RectLike {
  readonly left: number;
  readonly width: number;
}

/**
 * 视口矩形 → 内容坐标列盒(相机输入;与 `cameraScrollLeft` 互为逆运算)。
 * `scrollLeft` = 容器当前滚动位(getBoundingClientRect 给出的是视口相对坐标,
 * 内容坐标必须把已滚过的位移加回来)。
 */
export function columnBoxFromRects(
  container: RectLike,
  column: RectLike,
  scrollLeft: number,
): ColumnBox {
  return { start: column.left - container.left + scrollLeft, size: column.width };
}

/**
 * 焦点列居中所需的滚动位(px)。视口宽 ≤ 0 / 列宽 ≤ 0 / 坐标非有限 → 0。
 */
export function cameraScrollLeft(
  column: ColumnBox,
  viewportWidth: number,
  options: CameraScrollOptions = {},
): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return 0;
  }
  if (!Number.isFinite(column.start) || !Number.isFinite(column.size) || column.size <= 0) {
    return 0;
  }
  const centered = column.start + column.size / 2 - viewportWidth / 2;
  const lowerBounded = Math.max(centered, 0);
  const scrollWidth = options.scrollWidth;
  const upperBounded =
    scrollWidth !== undefined && Number.isFinite(scrollWidth) && scrollWidth > viewportWidth
      ? Math.min(lowerBounded, scrollWidth - viewportWidth)
      : lowerBounded;
  // 二位小数:滚动位亚像素无意义,取整让断言与真实 DOM scrollLeft 一致。
  return Math.round(upperBounded * 100) / 100;
}

/**
 * 是否要求减少动效(`prefers-reduced-motion: reduce`)。无 matchMedia 的环境
 * (jsdom / 部分测试环境)确定性回落 false(= 允许平滑滚动);media query 自身
 * 抛错时同样回落 false(动效纪律不因此失效,只退化为即时定位)。
 */
export function prefersReducedMotion(
  matchMedia?: ((query: string) => MediaQueryLike | null) | null,
): boolean {
  if (matchMedia === undefined || matchMedia === null) {
    return false;
  }
  try {
    return matchMedia("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

/** 取宿主默认 matchMedia(浏览器形态);无该全局返回 null(确定性回落)。 */
export function defaultMatchMedia(): ((query: string) => MediaQueryLike | null) | null {
  const globals = globalThis as { matchMedia?: (query: string) => MediaQueryLike };
  const bound = globals.matchMedia;
  return typeof bound === "function" ? bound.bind(globalThis) : null;
}

/**
 * WP-74 装饰面契约探测帮手(扫描线 overlay / 光标闪烁)。
 *
 * ## 契约(终态;实现方须满足,reduced-motion.spec.ts 按此断言)
 *
 * 效果面(§2.1)的实装落在 `packages/vm-ui/src/**`(WP-74 效果面波次);本文件
 * 只**探测与判定**,不实现任何效果。契约在实现方落地前即冻结,以便两边解耦:
 *
 * | 编号 | 对象 | 契约 | 判定属性(计算样式 / 属性) | 期望值 |
 * |---|---|---|---|---|
 * | C1 | 扫描线 overlay | 装饰节点须可被稳定识别 | `data-sm-decoration="scanline"`(首选)或 `part="scanline"` 或 `class="sm-scanline"` | 命中 ≥ 1(no-preference 下) |
 * | C2 | 扫描线 overlay | 形态 = `repeating-linear-gradient` 覆盖层 | `background-image` | 含 `repeating-linear-gradient` |
 * | C3 | 扫描线 overlay | 强度上限 ≤ 0.06(§2.1) | `opacity` | `0 < opacity ≤ 0.06` |
 * | C4 | 扫描线 overlay | 不影响命中测试 | `pointer-events` | `none` |
 * | C5 | 光标 | 装饰节点须可被稳定识别 | `data-sm-decoration="caret"`(首选)或 `part="caret"` 或 `class="sm-caret"` | 命中 ≥ 1(no-preference 下;见下「结构性兜底」) |
 * | C6 | 光标 | 闪烁动画消费 `--sm-caret-blink`(steps 动画,§2.1) | `animation-name` / `animation-duration` | 非 `none` / 解析自 `--sm-caret-blink`(`1.1s`) |
 * | C7 | 装饰全体 | **不承载信息**(屏幕阅读器口径) | `aria-hidden` + 文本 + 可聚焦后代 | `aria-hidden="true"` 且 `textContent.trim() === ""` 且 0 个可聚焦后代 |
 * | C7b | 扫描线 overlay | 不影响命中测试(C4 的判定属性;仅扫描线面强制) | `pointer-events` | `none`(光标节点不强制 —— 它可能位于可交互容器内) |
 * | C8 | 装饰全体 | reduce 下**不生效** | `display` / `visibility` / `opacity` | 三者之一:`none` / `hidden` / `0`(或节点整体缺席) |
 * | C9 | 装饰全体 | reduce 下**零非 none 动画**(全 composed 树) | `animation-name` | 全部为 `none` |
 *
 * **结构性兜底**:C1 / C5 的锚命名由实现方选定,故探测除属性 / part / 类名候选外
 * 另有两层兜底 —— 扫描线取「`aria-hidden="true"` + `pointer-events: none` +
 * `repeating-linear-gradient` 背景」的装饰层(C2 + C4 + C7 的联合形态);光标取
 * 「`animation-name` 非 none」的任一元素(no-preference 下终端预设的动画只应
 * 是装饰性闪烁)。兜底命中即视为契约满足,未命中则门禁红灯并打印探测清单。
 *
 * 遍历面 = 文档 **composed 树**(逐层穿 shadowRoot;vm-ui 全部组件在 shadow 内),
 * 元素数上限防失控;所有读数取 `getComputedStyle`(真实级联 + 媒体查询结果)。
 */
import type { Frame } from "@playwright/test";

/** 扫描线装饰节点的锚候选(顺序 = 优先级;首选为 `data-sm-decoration="scanline"`)。 */
export const SCANLINE_DECORATION_SELECTORS = [
  '[data-sm-decoration="scanline"]',
  '[part~="scanline"]',
  ".sm-scanline",
] as const;

/** 光标装饰节点的锚候选(顺序 = 优先级;首选为 `data-sm-decoration="caret"`)。 */
export const CARET_DECORATION_SELECTORS = [
  '[data-sm-decoration="caret"]',
  '[part~="caret"]',
  ".sm-caret",
] as const;

/** 装饰节点样本(判定所需的最小读数集;路径供红灯诊断)。 */
export interface DecorationSample {
  /** 元素路径(tag + 关键属性;红灯时直接可读)。 */
  readonly path: string;
  readonly display: string;
  readonly visibility: string;
  readonly opacity: string;
  readonly pointerEvents: string;
  readonly ariaHidden: string | null;
  readonly backgroundImage: string;
  readonly animationName: string;
  readonly animationDuration: string;
  readonly hasText: boolean;
  readonly focusableDescendants: number;
}

/** 一次 composed 树探测的结果(计数 + 首个样本;全部可 JSON 序列化)。 */
export interface DecorationState {
  /** reduce 仿真是否真的到达该帧(否则断言恒真,门禁失效 —— 必须自证)。 */
  readonly reduceMatches: boolean;
  /** 遍历到的元素数(证据行:确保遍历真的走到底)。 */
  readonly elementCount: number;
  readonly scanlineCount: number;
  readonly caretCount: number;
  /** 结构性兜底:装饰性渐变层数量(见文件头「结构性兜底」)。 */
  readonly gradientDecorationCount: number;
  /** composed 树中 `animation-name` 非 none 的元素数。 */
  readonly animatedCount: number;
  readonly scanline: DecorationSample | null;
  readonly caret: DecorationSample | null;
  readonly gradientDecoration: DecorationSample | null;
  readonly animated: DecorationSample | null;
}

/** 遍历元素数上限(防 shadow 树异常膨胀导致求值挂死;正常面 ≪ 此值)。 */
const MAX_WALKED_ELEMENTS = 8_000;

/** 在指定帧内做一次 composed 树装饰面探测。 */
export async function collectDecorationState(frame: Frame): Promise<DecorationState> {
  return frame.evaluate((contract) => {
    const walk = (root: Element): Element[] => {
      const collected: Element[] = [];
      const visit = (node: Element): void => {
        if (collected.length >= contract.maxWalkedElements) {
          return;
        }
        collected.push(node);
        for (const child of Array.from(node.children)) {
          visit(child);
        }
        const shadow = (node as HTMLElement).shadowRoot;
        if (shadow !== null) {
          for (const child of Array.from(shadow.children)) {
            visit(child);
          }
        }
      };
      visit(root);
      return collected;
    };

    const matchesAny = (element: Element, selectors: readonly string[]): boolean =>
      selectors.some((selector) => element.matches(selector));

    const describePath = (element: Element): string => {
      const parts: string[] = [];
      let node: Element | null = element;
      while (node !== null && parts.length < 6) {
        const attributes = ["data-sm-decoration", "part", "class", "data-testid", "aria-hidden"]
          .map((name) => {
            const value = node?.getAttribute(name) ?? null;
            return value === null ? "" : ` ${name}="${value}"`;
          })
          .join("");
        parts.push(`${node.tagName.toLowerCase()}${attributes}`);
        node = node.parentElement;
      }
      return parts.join(" < ");
    };

    const sample = (element: Element, style: CSSStyleDeclaration): DecorationSample => ({
      path: describePath(element),
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      ariaHidden: element.getAttribute("aria-hidden"),
      backgroundImage: style.backgroundImage,
      animationName: style.animationName,
      animationDuration: style.animationDuration,
      hasText: (element.textContent ?? "").trim() !== "",
      focusableDescendants: element.querySelectorAll(
        'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])',
      ).length,
    });

    let scanlineCount = 0;
    let caretCount = 0;
    let gradientDecorationCount = 0;
    let animatedCount = 0;
    let scanline: DecorationSample | null = null;
    let caret: DecorationSample | null = null;
    let gradientDecoration: DecorationSample | null = null;
    let animated: DecorationSample | null = null;

    const elements = walk(document.documentElement);
    for (const element of elements) {
      const style = getComputedStyle(element);
      const isScanline = matchesAny(element, contract.scanlineSelectors);
      const isCaret = matchesAny(element, contract.caretSelectors);
      const animatedHere =
        style.animationName !== "none" && style.animationName.trim() !== "";
      const gradientDecorationHere =
        element.getAttribute("aria-hidden") === "true" &&
        style.pointerEvents === "none" &&
        style.backgroundImage.includes("repeating-linear-gradient");

      if (isScanline) {
        scanlineCount += 1;
        scanline ??= sample(element, style);
      }
      if (isCaret) {
        caretCount += 1;
        caret ??= sample(element, style);
      }
      if (gradientDecorationHere) {
        gradientDecorationCount += 1;
        gradientDecoration ??= sample(element, style);
      }
      if (animatedHere) {
        animatedCount += 1;
        animated ??= sample(element, style);
      }
    }

    return {
      reduceMatches:
        typeof matchMedia === "function"
          ? matchMedia("(prefers-reduced-motion: reduce)").matches
          : false,
      elementCount: elements.length,
      scanlineCount,
      caretCount,
      gradientDecorationCount,
      animatedCount,
      scanline,
      caret,
      gradientDecoration,
      animated,
    };
  }, {
    scanlineSelectors: Array.from(SCANLINE_DECORATION_SELECTORS),
    caretSelectors: Array.from(CARET_DECORATION_SELECTORS),
    maxWalkedElements: MAX_WALKED_ELEMENTS,
  });
}

/** C8 判定:装饰节点在 reduce 下不可见(缺席由调用方另行覆盖)。 */
export function decorationInvisible(sample: DecorationSample): boolean {
  return (
    sample.display === "none" ||
    sample.visibility === "hidden" ||
    Number(sample.opacity) === 0
  );
}

/** C7 文案:屏幕阅读器口径的登记文字(断言失败信息与报告共用同一措辞)。 */
export const DECORATION_SEMANTICS_REGISTRATION =
  "装饰不承载信息(屏幕阅读器口径):扫描线 overlay / 光标闪烁为纯装饰,必须 " +
  'aria-hidden="true"、零文本内容、零可聚焦后代,且不影响命中测试(pointer-events: none);' +
  "一切状态与语义信息只经语义化 DOM(role / aria-live / region)表达,装饰缺席不丢失信息。";

/**
 * `<sm-workspace>` **整页布局结构面**测试(2026-09-18 整页布局改版 =
 * D-API-153 / D-UI-1 ~ D-UI-7 **整条重写**)。
 *
 * ## 本文件原测什么(已废止)
 *
 * 原文件测 Niri 式列条带交互:列宽像素护栏 / 列高下限 / 列间与窗间分隔条拖拽 /
 * 预设档位 / 焦点列相机 / 三类拖拽落点 —— **整条面随列条带废止**
 * (**随 D-API-153 废止**,含 `layout-divider.ts` / `layout-camera.ts` 已删除)。
 * 上述断言**不得复活**。
 *
 * ## 本文件现在测什么(布局结构面;交互面见 `sm-workspace.test.ts`)
 *
 *  - **D-UI-1** 左右两分 = 两轨等分网格、每轨保底 `SIDE_PANEL_MIN_WIDTH_PX`、
 *    **无 gap / 无 border / 零分隔条**;`:host` 自身即视口高(整页布局);
 *  - **D-UI-5** 左半侧宽度底线与窄屏语义的**结构**断言(真实横向滚动读数归真机
 *    几何断言 —— jsdom 无布局引擎);
 *  - **FE-WS-09** `.ws-stack` = 纵向滚动容器 + 丝滑滚动;`prefers-reduced-motion:
 *    reduce` 下降级为 `auto`;
 *  - **D-UI-2 / FE-WS-15** 每个可见视图位的**内联确定高度** = `viewSlotHeightPx()`
 *    的取值、**渲染数不做「只渲染两个」的裁剪**(左半侧渲染数 = 可见视图数 − 1,
 *    差额 = 固定承载于右半侧的 payload —— 主控 2026-09-18 裁定 A)、
 *    每视位 − chrome ≥ N 行;
 *  - **D-UI-7 ① / FE-WS-11** 视图类型名在视图内左上角(`.view-label` 是面板内
 *    第一个元素)、**无独立标题栏**(`.tab-bar` 退场);
 *  - 视口外降级渲染保留(`content-visibility` 语义标记 + 样式声明);
 *  - 右半侧 = payload 搭建窗口(payload 的**唯一**呈现位;固定承载**同一实例**)。
 */
import { describe, expect, it } from "vitest";

import { SmWorkspace } from "../../src/workspace/sm-workspace.js";
import {
  HEX_ROW_HEIGHT_PX,
  SIDE_PANEL_MIN_WIDTH_PX,
  VIEW_PANEL_CHROME_HEIGHT_PX,
  VIEW_SLOT_MIN_VISIBLE_HEX_ROWS,
  VISIBLE_VIEW_SLOT_COUNT,
  viewSlotHeightPx,
} from "../../src/workspace/layout-presets.js";
import { PAYLOAD_TAB_TYPE, defaultTabTypeRegistry } from "../../src/workspace/tab-registry.js";

const REGISTERED_TYPES: readonly string[] = defaultTabTypeRegistry
  .list()
  .map((descriptor) => descriptor.type);

/** 单视位的 `contain-intrinsic-size` 占位高(与组件内 `VIEW_SLOT_INTRINSIC_PX` 同式同源)。 */
const VIEW_SLOT_INTRINSIC_PX = Math.ceil(
  VIEW_PANEL_CHROME_HEIGHT_PX + VIEW_SLOT_MIN_VISIBLE_HEX_ROWS * HEX_ROW_HEIGHT_PX,
);

// ── 挂载与查询辅助 ───────────────────────────────────────────────────────────

async function mountWorkspace(): Promise<SmWorkspace> {
  const element = new SmWorkspace();
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function shadowOf(workspace: SmWorkspace): ShadowRoot {
  return workspace.shadowRoot as ShadowRoot;
}

function leftRoleOf(workspace: SmWorkspace): HTMLElement {
  return shadowOf(workspace).querySelector(".ws-left") as HTMLElement;
}

function rightRoleOf(workspace: SmWorkspace): HTMLElement {
  return shadowOf(workspace).querySelector(".ws-right") as HTMLElement;
}

function stackOf(workspace: SmWorkspace): HTMLElement {
  return shadowOf(workspace).querySelector("[data-view-stack]") as HTMLElement;
}

function panelsOf(workspace: SmWorkspace): HTMLElement[] {
  return [...shadowOf(workspace).querySelectorAll("[data-view-panel]")] as HTMLElement[];
}

function panelOf(workspace: SmWorkspace, type: string): HTMLElement | null {
  return shadowOf(workspace).querySelector(`[data-view-panel="${type}"]`);
}

/** 组件静态样式表文本(注释已剥离、空白归一 ⇒ 断言只看声明面)。 */
function stylesTextOf(): string {
  const styles =
    (SmWorkspace as unknown as { elementStyles?: { cssText?: string }[] }).elementStyles ?? [];
  expect(styles.length, "组件静态样式缺席?").toBeGreaterThan(0);
  return styles
    .map((style) => style.cssText ?? "")
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ");
}

/** 取某个选择器的**规则体**(花括号配对;输入须已注释剥离 + 空白归一)。 */
function ruleBodyOf(cssText: string, selector: string): string {
  const anchor = cssText.indexOf(`${selector} {`);
  expect(anchor, `静态样式表缺少选择器 ${selector}`).toBeGreaterThanOrEqual(0);
  const open = cssText.indexOf("{", anchor);
  let depth = 0;
  for (let index = open; index < cssText.length; index += 1) {
    const char = cssText[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return cssText.slice(open + 1, index);
      }
    }
  }
  throw new Error(`规则体未闭合:${selector}`);
}

/** 全部 `@media` 块(查询串 + 块体)。 */
function mediaBlocksOf(cssText: string): { readonly query: string; readonly body: string }[] {
  const blocks: { query: string; body: string }[] = [];
  const pattern = /@media\s+([^{]+)\{/g;
  let match = pattern.exec(cssText);
  while (match !== null) {
    const open = cssText.indexOf("{", match.index);
    let depth = 0;
    for (let index = open; index < cssText.length; index += 1) {
      const char = cssText[index];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          blocks.push({ query: (match[1] ?? "").trim(), body: cssText.slice(open + 1, index) });
          pattern.lastIndex = index + 1;
          break;
        }
      }
    }
    match = pattern.exec(cssText);
  }
  return blocks;
}

/** 内联确定高度(px;`style="block-size: Npx"`)。 */
function slotHeightOf(panel: HTMLElement): number {
  return Number.parseFloat(panel.style.blockSize);
}

/** 左半侧实测尺寸桩(jsdom 无布局引擎;尺寸驱动 = window resize 事件)。 */
async function stubLeftRoleSize(
  workspace: SmWorkspace,
  size: { readonly width: number; readonly height: number },
): Promise<void> {
  const left = leftRoleOf(workspace);
  Object.defineProperty(left, "clientWidth", { configurable: true, value: size.width });
  Object.defineProperty(left, "clientHeight", { configurable: true, value: size.height });
  window.dispatchEvent(new Event("resize"));
  await workspace.updateComplete;
}

// ── D-UI-1:整页布局与左右两分 ────────────────────────────────────────────────

describe("整页布局(D-UI-1:两分固定等分、无 gap / 无 border)", () => {
  it("`.ws-body` = 两轨等分网格且每轨保底 SIDE_PANEL_MIN_WIDTH_PX(无 gap / 无 border)", async () => {
    const cssText = stylesTextOf();
    const body = ruleBodyOf(cssText, ".ws-body");

    expect(body).toContain("display: grid");
    // 最终形态(主控 2026-09-18 裁定):两轨等分 + 每轨保底左半侧宽底线。
    expect(body).toContain(
      `grid-template-columns: repeat(2, minmax(${SIDE_PANEL_MIN_WIDTH_PX}px, 1fr))`,
    );
    // 「无边框、紧密贴合的矩形」:零 gap、零 border(divider 亦不在)。
    expect(body).not.toContain("gap");
    expect(body).not.toContain("border");

    const workspace = await mountWorkspace();
    expect(shadowOf(workspace).querySelector("[data-workspace-body]")).not.toBeNull();
    workspace.remove();
  });

  it("`:host` 自身即视口高(100dvh / 100%)且无固定 min-block-size(溢出不上浮到文档层)", () => {
    const host = ruleBodyOf(stylesTextOf(), ":host");

    expect(host).toContain("display: grid");
    expect(host).toContain("block-size: 100dvh");
    expect(host).toContain("block-size: 100%");
    expect(host).toContain("min-block-size: 0");
    // 无 border / 无圆角(整页形态);无固定高兜底。
    expect(host).not.toContain("border");
    expect(host).not.toContain("border-radius");
    // 回归护栏:旧固定高 24rem 与旧「压缩以适配」的裸 9rem 下限不得回退。
    const cssText = stylesTextOf();
    expect(cssText).not.toContain("24rem");
    expect(cssText).not.toContain("9rem");
  });

  it("视位之间零分隔条 / 零分界拖拽手柄(无 gap / 无 divider 硬约束)", async () => {
    const workspace = await mountWorkspace();
    const shadow = shadowOf(workspace);

    // DOM 面:零 separator / 零旧列条带遗留锚。
    for (const selector of [
      '[role="separator"]',
      ".column-divider",
      ".row-divider",
      ".ws-divider",
      "[data-column-divider]",
      "[data-row-divider]",
      "[data-columns]",
      "[data-column-index]",
    ]) {
      expect(shadow.querySelectorAll(selector), `旧列条带遗留锚仍在场:${selector}`).toHaveLength(0);
    }
    // 样式面:零 divider 类规则;视图位无边框 / 无圆角。
    const cssText = stylesTextOf();
    expect(cssText).not.toContain("column-divider");
    expect(cssText).not.toContain("row-divider");
    const viewRule = ruleBodyOf(cssText, ".ws-view");
    expect(viewRule).not.toContain("border");
    expect(viewRule).not.toContain("border-radius");
    workspace.remove();
  });

  it("左右两半侧各就各位:左半侧 = 视图管理窗口、右半侧 = payload 搭建窗口", async () => {
    const workspace = await mountWorkspace();
    const shadow = shadowOf(workspace);

    const left = shadow.querySelector('[data-view-role="left"]');
    const right = shadow.querySelector('[data-view-role="right"]');
    expect(left?.tagName).toBe("SECTION");
    expect(right?.tagName).toBe("SECTION");
    expect(left?.getAttribute("aria-label")).toBe("视图管理窗口");
    // 右半侧地标名 = payload 视图名(展示名与面板同源)。
    expect(right?.getAttribute("aria-label")).toBe("Payload 搭建");
    // 两半侧是同一 `.ws-body` 的子项(1:1 两轨)。
    expect(left?.parentElement).toBe(shadow.querySelector("[data-workspace-body]"));
    expect(right?.parentElement).toBe(shadow.querySelector("[data-workspace-body]"));
    workspace.remove();
  });
});

// ── D-UI-5:左半侧宽度底线与窄屏语义(结构面)────────────────────────────────

describe("左半侧宽度底线与窄屏语义(D-UI-5)", () => {
  it("`.ws-left` 的 `min-inline-size` = SIDE_PANEL_MIN_WIDTH_PX(插值后的 px 值)", () => {
    const cssText = stylesTextOf();
    const left = ruleBodyOf(cssText, ".ws-left");

    expect(left).toContain(`min-inline-size: ${SIDE_PANEL_MIN_WIDTH_PX}px`);
    // 插值确为推导值(不是随手字面量):58ch × 7.8px = 452.4px。
    expect(SIDE_PANEL_MIN_WIDTH_PX).toBeCloseTo(452.4, 6);
    expect(cssText).toContain("452.4px");
  });

  it("窄屏形态不改变:零「隐藏右半侧 / 上下堆叠 / 单列降级」的媒体查询替代物", () => {
    const cssText = stylesTextOf();
    const right = ruleBodyOf(cssText, ".ws-right");

    // 右半侧恒在场(形态不随宽度改变),且右半侧自身不设宽度下限 ——
    // 底线由 `.ws-body` 的**两轨保底**承担(D-UI-5 否决「隐藏右半侧」)。
    expect(right).toContain("min-block-size: 0");
    expect(right).not.toContain("display: none");
    for (const block of mediaBlocksOf(cssText)) {
      expect(block.body, `媒体查询 ${block.query} 改动了左右两分结构`).not.toContain(".ws-body");
      expect(block.body, `媒体查询 ${block.query} 改动了右半侧`).not.toContain(".ws-right");
    }
  });
});

// ── FE-WS-09:丝滑纵向滚动 + reduce 降级 ─────────────────────────────────────

describe("左半侧滚动容器与丝滑滚动(FE-WS-09)", () => {
  it("`.ws-stack` = 纵向滚动容器(overflow-y: auto + scroll-behavior: smooth)", async () => {
    const workspace = await mountWorkspace();
    const stack = stackOf(workspace);
    const rule = ruleBodyOf(stylesTextOf(), ".ws-stack");

    expect(stack.classList.contains("ws-stack")).toBe(true);
    expect(rule).toContain("overflow-y: auto");
    expect(rule).toContain("scroll-behavior: smooth");
    expect(rule).toContain("overscroll-behavior: contain");
    // 视位纵向堆叠:gap + 上下留白(算式里被扣掉的那部分)。
    expect(rule).toContain("gap: 0.5rem");
    expect(rule).toContain("margin-block: 0.5rem");
    workspace.remove();
  });

  it("`prefers-reduced-motion: reduce` 下 `scroll-behavior: auto`(丝滑滚动降级)", () => {
    const cssText = stylesTextOf();
    const reduceBlocks = mediaBlocksOf(cssText).filter((block) =>
      block.query.includes("prefers-reduced-motion: reduce"),
    );

    expect(reduceBlocks.length).toBeGreaterThan(0);
    // 至少一个 reduce 块把 .ws-stack 的丝滑滚动降级为即时。
    const stackDowngrade = reduceBlocks.filter(
      (block) => block.body.includes(".ws-stack") && block.body.includes("scroll-behavior: auto"),
    );
    expect(stackDowngrade).toHaveLength(1);
    // 回归护栏:动画 / 降级声明不得只存在于 no-preference 分支(那么 reduce 下
    // 就回到浏览器缺省的 smooth 或漏掉降级)。
    const base = ruleBodyOf(cssText, ".ws-stack");
    expect(base).toContain("scroll-behavior: smooth");
  });
});

// ── 视口外降级渲染(保留)────────────────────────────────────────────────────

describe("视口外降级渲染(content-visibility;改版保留面)", () => {
  it("每个可见视图位带语义标记;`.ws-view` 声明 content-visibility: auto + contain-intrinsic-size", async () => {
    const workspace = await mountWorkspace();
    const panels = panelsOf(workspace);

    expect(panels.length).toBeGreaterThan(0);
    for (const panel of panels) {
      expect(panel.getAttribute("data-render-degrade")).toBe("content-visibility");
    }
    const rule = ruleBodyOf(stylesTextOf(), ".ws-view");
    expect(rule).toContain("content-visibility: auto");
    expect(rule).toContain(`contain-intrinsic-size: auto ${VIEW_SLOT_INTRINSIC_PX}px`);
    workspace.remove();
  });

  it("视图类型名在视图内左上角:面板内第一个元素 = span.view-label;无独立标题栏", async () => {
    const workspace = await mountWorkspace();
    const shadow = shadowOf(workspace);

    expect(shadow.querySelectorAll(".tab-bar")).toHaveLength(0);
    for (const panel of panelsOf(workspace)) {
      const first = panel.firstElementChild;
      expect(first?.tagName, `面板 ${panel.getAttribute("data-view-panel")} 首个元素不是类型名标签`).toBe(
        "SPAN",
      );
      expect(first?.classList.contains("view-label")).toBe(true);
      // 类型名与面板地标名同源(D-UI-7 ①:标题栏消失不改地标名)。
      expect(first?.textContent?.trim()).toBe(panel.getAttribute("aria-label"));
    }
    workspace.remove();
  });
});

// ── D-UI-2 / FE-WS-15:视图位确定高度 ────────────────────────────────────────

describe("视图位确定高度(D-UI-2 / FE-WS-15:只滚动、不压缩)", () => {
  it("无布局环境回落视口高:视位高 = viewSlotHeightPx(window.innerHeight) 且内联为像素", async () => {
    const workspace = await mountWorkspace();
    const fallbackHeight = window.innerHeight;
    const expected = viewSlotHeightPx(fallbackHeight);

    expect(Number.isFinite(expected)).toBe(true);
    expect(expected).toBeGreaterThan(0);
    for (const panel of panelsOf(workspace)) {
      expect(panel.style.blockSize).toBe(`${expected}px`);
      expect(panel.getAttribute("style")).toContain("block-size");
    }
    workspace.remove();
  });

  it("左半侧实测高变化 ⇒ 内联高度按同一算式跟随(resize 驱动;同一次测量登记 leftRoleWidth)", async () => {
    const workspace = await mountWorkspace();
    await stubLeftRoleSize(workspace, { width: 500, height: 900 });

    const expected = viewSlotHeightPx(900);
    expect(expected).toBeGreaterThan(viewSlotHeightPx(0));
    for (const panel of panelsOf(workspace)) {
      expect(panel.style.blockSize).toBe(`${expected}px`);
    }
    // 同一次测量登记左半侧实际宽(D-UI-5 的核对面);不夹取到 452.4px。
    expect(workspace.leftRoleWidth).toBe(500);
    workspace.remove();
  });

  it("矮左半侧亦取确定下限:视位高 = chrome + N 行(不塌陷、不压缩到装不下一行)", async () => {
    const workspace = await mountWorkspace();
    await stubLeftRoleSize(workspace, { width: 500, height: 200 });

    const floor = viewSlotHeightPx(0);
    expect(floor).toBeGreaterThan(VIEW_PANEL_CHROME_HEIGHT_PX);
    for (const panel of panelsOf(workspace)) {
      expect(panel.style.blockSize).toBe(`${floor}px`);
      // 每视位 − chrome 后仍容纳 ≥ N 行(可读性判据)。
      const rows = (slotHeightOf(panel) - VIEW_PANEL_CHROME_HEIGHT_PX) / HEX_ROW_HEIGHT_PX;
      expect(rows).toBeGreaterThanOrEqual(VIEW_SLOT_MIN_VISIBLE_HEX_ROWS);
    }
    // 下限生效即「两视位装不下」⇒ 溢出由 .ws-stack 纵向滚动承载(只滚动不压缩)。
    expect(floor * VISIBLE_VIEW_SLOT_COUNT).toBeGreaterThan(200);
    workspace.remove();
  });

  it("渲染数 = 可见视图数 − 1(payload 固定于右半侧,左半侧不再渲染它)", async () => {
    const workspace = await mountWorkspace();
    const shadow = shadowOf(workspace);
    const right = rightRoleOf(workspace);

    const visible = workspace.layoutSnapshot.views
      .filter((view) => view.visible)
      .map((view) => view.type);
    expect(visible).toHaveLength(REGISTERED_TYPES.length);
    expect(visible).toContain(PAYLOAD_TAB_TYPE);

    const rendered = panelsOf(workspace).map((panel) => panel.getAttribute("data-view-panel") ?? "");
    // ① 不做「只渲染两个」的裁剪:除 payload 外,每个可见视图位都渲染面板。
    expect(rendered).toEqual(visible.filter((type) => type !== PAYLOAD_TAB_TYPE));
    expect(rendered).toHaveLength(visible.length - 1);
    // ② payload 的**唯一**呈现位 = 右半侧(左半侧零同名面板 ⇒ 零重名地标、零空面板)。
    expect(panelOf(workspace, PAYLOAD_TAB_TYPE)).toBeNull();
    expect(right.querySelector("sm-payload-tab-host")).not.toBeNull();
    // ③ 无重复,且全部渲染锚都挂在左半侧滚动容器内。
    expect(new Set(rendered).size).toBe(rendered.length);
    expect(shadow.querySelectorAll("[data-view-stack] [data-view-panel]")).toHaveLength(
      rendered.length,
    );
    // ④ 可视区恰两个视位由**定高算式**保证(不是靠裁剪 DOM)。
    expect(VISIBLE_VIEW_SLOT_COUNT).toBe(2);
    workspace.remove();
  });

  it("未勾选者**不渲染**:取消勾选即从 DOM 摘除,且右半侧固定承载不随之消失", async () => {
    const workspace = await mountWorkspace();
    const shadow = shadowOf(workspace);

    expect(workspace.setViewVisible("free", false)).toBe(true);
    await workspace.updateComplete;
    expect(panelOf(workspace, "free")).toBeNull();
    expect(
      workspace.layoutSnapshot.views.filter((view) => view.visible).map((view) => view.type),
    ).not.toContain("free");

    // 全部取消勾选 ⇒ 左半侧零视位;右半侧仍是 payload 搭建窗口(结构不随勾选变化)。
    for (const type of REGISTERED_TYPES) {
      workspace.setViewVisible(type, false);
    }
    await workspace.updateComplete;
    expect(shadow.querySelectorAll("[data-view-panel]")).toHaveLength(0);
    expect(rightRoleOf(workspace)).not.toBeNull();
    expect(workspace.layoutSnapshot.views).toHaveLength(REGISTERED_TYPES.length);
    workspace.remove();
  });
});

// ── 右半侧 = payload 搭建窗口(固定)────────────────────────────────────────

describe("右半侧 = payload 搭建窗口(固定承载同一实例)", () => {
  it("payload 内容元素**同一实例**且落在右半侧(不复制、不随勾选重建)", async () => {
    const workspace = await mountWorkspace();
    const shadow = shadowOf(workspace);
    const right = rightRoleOf(workspace);

    const hosts = shadow.querySelectorAll("sm-payload-tab-host");
    expect(hosts).toHaveLength(1);
    const host = hosts[0] as HTMLElement;
    expect(right.contains(host)).toBe(true);
    expect(host.parentElement).toBe(right);

    // 勾选语义仍由**模型面**承担(payload 在列表按钮里仍可勾选;D-MP-1 不修訂)。
    expect(workspace.setViewVisible(PAYLOAD_TAB_TYPE, false)).toBe(true);
    await workspace.updateComplete;
    expect(
      workspace.layoutSnapshot.views.find((view) => view.type === PAYLOAD_TAB_TYPE)?.visible,
    ).toBe(false);
    // 固定承载:右半侧的 payload 内容元素不因勾选变化而重建 / 消失。
    expect(shadowOf(workspace).querySelectorAll("sm-payload-tab-host")).toHaveLength(1);
    expect(rightRoleOf(workspace).contains(host)).toBe(true);
    expect(rightRoleOf(workspace).getAttribute("aria-label")).toBe("Payload 搭建");
    workspace.remove();
  });
});

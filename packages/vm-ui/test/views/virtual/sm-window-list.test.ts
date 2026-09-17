/**
 * <sm-window-list> 结构样式可达性测试(WP-76 真机发现缺陷的回归护栏)。
 *
 * 缺陷事实:组件以 light DOM 形态渲染(`createRenderRoot()` 返回宿主自身),
 * Lit 的 `adoptStyles` 只对 shadow root 生效 ⇒ `static styles` 是**死代码**:
 * 真机实测列表 `position: static` / `overflow-y: visible`,不构成滚动容器,
 * 行内容被排到 sizer **之后**的流内位置(锚点行 y≈2539px,面板可视区
 * 516~747px)⇒ 虚拟列表既不能滚也不能用,"锚点行落在视口内"不可能成立。
 *
 * jsdom 不做布局计算,故此处断言**交付路径的结构事实**:结构样式随模板落到
 * light DOM(宿主所在 shadow 树内可级联);真机几何由
 * `e2e/breakpoint-linkage.spec.ts` 调试档用例与 `e2e/workspace-*.spec.ts` 覆盖。
 */
import { describe, expect, it } from "vitest";

import { SM_WINDOW_LIST_TAG, SmWindowList } from "../../../src/views/virtual/sm-window-list.js";
import { mount } from "../ed/helpers.js";

async function mountList(items: readonly unknown[]): Promise<SmWindowList> {
  await import("../../../src/views/virtual/sm-window-list.js");
  const element = await mount<SmWindowList>(SM_WINDOW_LIST_TAG);
  element.items = items;
  element.rowHeight = 24;
  element.renderItem = (item) => {
    const row = document.createElement("div");
    row.textContent = String(item);
    return row;
  };
  await element.updateComplete;
  return element;
}

function styleText(element: SmWindowList): string {
  return element.querySelector("style")?.textContent ?? "";
}

describe("light DOM 结构样式(滚动容器与绝对定位窗口)", () => {
  it("渲染根 = 宿主自身(无 shadow root),结构样式以 <style> 随模板落到 light DOM", async () => {
    const list = await mountList([0, 1, 2]);
    expect(list.shadowRoot).toBeNull();

    const cssText = styleText(list);
    // 元素自身即滚动容器(此前缺失 ⇒ 列表不可滚动)。
    expect(cssText).toContain("sm-window-list {");
    expect(cssText).toContain("position: relative");
    expect(cssText).toContain("overflow-y: auto");
    // 可见切片脱离流(否则行被排到 sizer 之后,离视口数千像素)。
    expect(cssText).toContain("sm-window-list > .window {");
    expect(cssText).toContain("position: absolute");
    // sizer 只负责撑高,不占横向空间。
    expect(cssText).toContain("sm-window-list > .sizer {");
  });

  it("选择器以宿主标签收窄:同一 shadow 树内多实例按标签生效(等价 :host 语义)", async () => {
    const list = await mountList([0]);
    const cssText = styleText(list);
    // 不得出现裸类名规则(会泄漏到宿主视图内其它同名类)。
    expect(/\n\s*\.window\s*\{/u.test(cssText)).toBe(false);
    expect(/\n\s*\.sizer\s*\{/u.test(cssText)).toBe(false);
  });

  it("窗口化几何不受样式交付方式影响:sizer 撑出总高,窗口以 translateY 定位", async () => {
    const list = await mountList(Array.from({ length: 100 }, (_, index) => index));
    const sizer = list.querySelector(".sizer") as HTMLElement | null;
    const window = list.querySelector(".window") as HTMLElement | null;
    expect(sizer?.style.height).toBe("2400px");
    expect(window?.style.transform).toContain("translateY(0px)");
    // 有界窗口:100 行不全量渲染(jsdom 无布局 → 回退视口行数上界)。
    expect(list.querySelectorAll(".window > div").length).toBeLessThan(100);
  });
});

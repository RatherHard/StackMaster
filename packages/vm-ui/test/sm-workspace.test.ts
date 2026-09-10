import { describe, expect, it } from "vitest";
// 经包公开入口导入(覆盖 index.ts 装配面;导入即注册自定义元素)。
import { SmWorkspace } from "../src/index.js";

/** 取 shadow DOM 内元素的健壮查询(组件测试统一形态)。 */
function queryShadow(element: SmWorkspace, selector: string): Element | null | undefined {
  return element.shadowRoot?.querySelector(selector);
}

describe("SmWorkspace 工作区空壳", () => {
  it("注册自定义元素并在 shadow DOM 渲染占位结构(标题头 + 空标签页区域)", async () => {
    expect(customElements.get("sm-workspace")).toBe(SmWorkspace);

    const element = document.createElement("sm-workspace");
    document.body.append(element);
    await element.updateComplete;

    expect(queryShadow(element, "header .heading")?.textContent).toBe("StackMaster Workspace");
    const tabArea = queryShadow(element, '[part="tab-area"]');
    expect(tabArea).toBeInstanceOf(HTMLElement);
    expect(tabArea?.getAttribute("aria-label")).toBe("工作区标签页区域");
    expect(queryShadow(element, ".tab-placeholder")?.textContent).toContain("空标签页区域");

    element.remove();
  });

  it("heading 属性经反应式属性链路反映到渲染", async () => {
    const element = document.createElement("sm-workspace") as SmWorkspace;
    document.body.append(element);
    await element.updateComplete;

    element.heading = "Debug Workspace";
    await element.updateComplete;

    expect(queryShadow(element, ".heading")?.textContent).toBe("Debug Workspace");
    element.remove();
  });
});

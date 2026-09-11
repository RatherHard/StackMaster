/**
 * <sm-register-annotation> 行左缘寄存器交叉标注行为测试(WP-F5 / FE-RG-04):
 * 按钮面复用 F4 renderRegisterAnnotationCell;点击展开值列表 / 再点收起。
 */
import { describe, expect, it } from "vitest";

import type { RegisterHit } from "../../src/views/register/cross-annotation.js";
import { SmRegisterAnnotation } from "../../src/workspace/sm-register-annotation.js";

function hitsFixture(): RegisterHit[] {
  return [
    {
      registerName: "RSP",
      valueHex: "0x1004",
      targetAddressHex: "0x1004",
      regionId: "region-stack",
      offset: 4,
    },
  ];
}

/** 模板换行敏感度归一:连续空白折叠为单空格。 */
function textOf(element: SmRegisterAnnotation): string {
  return (element.shadowRoot?.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("<sm-register-annotation> 行左缘交叉标注", () => {
  it("渲染 F4 标注按钮面(data-registers + title 详情),默认收起", async () => {
    const element = new SmRegisterAnnotation();
    element.hits = hitsFixture();
    document.body.append(element);
    await element.updateComplete;

    const button = element.shadowRoot?.querySelector("button.reg-annotation");
    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(button?.getAttribute("data-registers")).toBe("RSP");
    expect(button?.textContent).toContain("RSP");
    expect(element.shadowRoot?.querySelector(".reg-values")).toBeNull();

    element.remove();
  });

  it("点击标注按钮 → 行内展开寄存器值列表;再点收起(FE-RG-04 点击展开)", async () => {
    const element = new SmRegisterAnnotation();
    element.hits = hitsFixture();
    document.body.append(element);
    await element.updateComplete;

    const button = element.shadowRoot?.querySelector("button.reg-annotation") as HTMLButtonElement;
    button.click();
    await element.updateComplete;

    const values = element.shadowRoot?.querySelector(".reg-values");
    expect(values).not.toBeNull();
    expect(textOf(element)).toContain("RSP = 0x1004");
    expect(textOf(element)).toContain("(→ 0x1004)");
    // WP-55 axe 真机修正:展开态语义(aria-expanded)落在真实 button 上
    // (generic 容器不允许 aria-expanded,且不得包装出嵌套可交互元素)。
    expect(element.shadowRoot?.querySelector("button.reg-annotation")?.getAttribute("aria-expanded")).toBe(
      "true",
    );

    button.click();
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector(".reg-values")).toBeNull();

    element.remove();
  });

  it("展开条内的点击不收起(便于选中复制);hits 为空渲染空", async () => {
    const element = new SmRegisterAnnotation();
    element.hits = hitsFixture();
    document.body.append(element);
    await element.updateComplete;

    const button = element.shadowRoot?.querySelector("button.reg-annotation") as HTMLButtonElement;
    button.click();
    await element.updateComplete;

    const row = element.shadowRoot?.querySelector(".reg-value-row");
    row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector(".reg-values")).not.toBeNull();

    element.remove();
  });

  it("空命中集渲染 nothing(标注缺席)", async () => {
    const element = new SmRegisterAnnotation();
    element.hits = [];
    document.body.append(element);
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector("button.reg-annotation")).toBeNull();
    element.remove();
  });
});

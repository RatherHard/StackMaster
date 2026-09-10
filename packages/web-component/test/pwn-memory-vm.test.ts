import { describe, expect, it } from "vitest";
// 经包公开入口导入(覆盖 index.ts 装配面;导入即注册自定义元素)。
import { PwnMemoryVm } from "../src/index.js";

describe("<pwn-memory-vm> 占位桩", () => {
  it("注册自定义元素并在 shadow DOM 渲染占位文案", async () => {
    expect(customElements.get("pwn-memory-vm")).toBe(PwnMemoryVm);

    const element = document.createElement("pwn-memory-vm");
    document.body.append(element);
    await element.updateComplete;

    expect(element.shadowRoot).not.toBeNull();
    const placeholder = element.shadowRoot?.querySelector(".placeholder");
    expect(placeholder?.textContent).toContain("pwn-memory-vm placeholder");
    expect(placeholder?.getAttribute("role")).toBe("status");

    element.remove();
  });
});

/**
 * <sm-structure-view> 组件测试(FE-ED-01):kind 分组、徽标/区域/地址/长度
 * 呈现、highlight-jump 事件 detail、空态、空组不渲染。
 */
import { describe, expect, it } from "vitest";

import type { SemanticHighlight } from "@stackmaster/protocol";

import type { HighlightJumpDetail, SmStructureView } from "../../../src/views/ed/sm-structure-view.js";

import "../../../src/views/ed/sm-structure-view.js";
import { queryAllShadow, queryShadow } from "./helpers.js";

function highlight(overrides: Partial<SemanticHighlight>): SemanticHighlight {
  return {
    kind: "canary_slot",
    targetRegionId: "region-stack",
    startAddressHex: "0x1000",
    byteLength: 8,
    label: "canary 槽(8 字节)",
    ...overrides,
  };
}

const FIXTURE: readonly SemanticHighlight[] = [
  highlight({ kind: "buffer_start", label: "buffer 起点", startAddressHex: "0x1010", byteLength: 64 }),
  highlight({ kind: "return_address_slot", label: "返回地址槽", startAddressHex: "0x1008" }),
  highlight({ kind: "saved_rbp_slot", label: "saved RBP 槽", startAddressHex: "0x1000" }),
  highlight({ kind: "canary_slot", label: "canary 槽" }),
  highlight({ kind: "custom", label: "作者自定义标注", targetRegionId: "region-data" }),
];

async function mounted(highlights: readonly SemanticHighlight[]): Promise<SmStructureView> {
  const element = document.createElement("sm-structure-view") as SmStructureView;
  document.body.append(element);
  element.highlights = highlights;
  await element.updateComplete;
  return element;
}

describe("SmStructureView kind 分组(FE-ED-01)", () => {
  it("按 kind 分组渲染:五组齐备,组标签与嵌套列表结构正确", async () => {
    const element = await mounted(FIXTURE);
    const groupLabels = queryAllShadow(element, ".group > .group-label").map((label) => label.textContent?.trim());
    expect(groupLabels).toEqual(["buffer 起点", "返回地址槽", "saved RBP 槽", "canary 槽", "自定义标注"]);
    const groups = queryAllShadow(element, ".group");
    expect(groups.map((group) => group.querySelectorAll("li button").length)).toEqual([1, 1, 1, 1, 1]);
    element.remove();
  });

  it("条目呈现 label + kind 徽标 + 区域与地址 + 字节长度", async () => {
    const element = await mounted(FIXTURE);
    const firstButton = queryShadow(element, ".group ul li button")!;
    expect(firstButton.querySelector(".entry-label")?.textContent?.trim()).toBe("buffer 起点");
    expect(firstButton.querySelector(".kind-badge")?.textContent?.trim()).toBe("buffer 起点");
    expect(firstButton.querySelector(".entry-meta")?.textContent?.replace(/\s+/g, " ")).toContain(
      "region-stack @ 0x1010 · 64B",
    );
    element.remove();
  });

  it("空 kind 组不渲染(无占位组)", async () => {
    const element = await mounted([highlight({ kind: "custom", label: "仅一条自定义" })]);
    const groupLabels = queryAllShadow(element, ".group > .group-label").map((label) => label.textContent?.trim());
    expect(groupLabels).toEqual(["自定义标注"]);
    element.remove();
  });

  it("点击条目 → highlight-jump 事件(detail = regionId + addressHex,bubbles+composed)", async () => {
    const element = await mounted(FIXTURE);
    let detail: HighlightJumpDetail | null = null;
    let bubbles = false;
    let composed = false;
    element.addEventListener("highlight-jump", (event) => {
      const custom = event as CustomEvent<HighlightJumpDetail>;
      detail = custom.detail;
      bubbles = custom.bubbles;
      composed = custom.composed;
    });
    queryShadow<HTMLButtonElement>(element, ".group ul li button")!.click();
    expect(detail).toEqual({ regionId: "region-stack", addressHex: "0x1010" });
    expect(bubbles).toBe(true);
    expect(composed).toBe(true);
    element.remove();
  });

  it("空/缺省 highlights → 空态说明,不渲染分组列表", async () => {
    for (const highlights of [[], undefined] as const) {
      const element = document.createElement("sm-structure-view") as SmStructureView;
      document.body.append(element);
      if (highlights !== undefined) {
        element.highlights = highlights;
      }
      await element.updateComplete;
      expect(queryShadow(element, "ul")).toBeNull();
      expect(queryShadow(element, "[role='status']")?.textContent).toContain("暂无结构标注");
      element.remove();
    }
  });
});

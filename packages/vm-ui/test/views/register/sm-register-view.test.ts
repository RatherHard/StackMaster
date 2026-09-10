/**
 * <sm-register-view> 组件测试(WP-F4 / FE-RG-01/02/03 + Q8):
 * 全量纵向渲染(M14 白名单口径)、valueHex 大写归一化、特殊显示列(区域引用)、
 * 点击复制成功 / 降级两路径(注入 clipboard stub)、键盘 Enter 复制、反馈自动消隐。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectionStore } from "../../../src/client/projection-store.js";
import { ProjectionDataSource } from "../../../src/datasource/projection-data-source.js";
import type { MemoryDataSource } from "../../../src/datasource/types.js";
import {
  COPY_FALLBACK_TEXT,
  COPY_SUCCESS_TEXT,
  SmRegisterView,
  defaultClipboardWriter,
} from "../../../src/views/register/sm-register-view.js";
import type { PublicStateProjection } from "@stackmaster/protocol";

import "../../../src/views/register/sm-register-view.js";

/** 取 shadow DOM 内元素的健壮查询(组件测试统一形态)。 */
function queryShadow(element: SmRegisterView, selector: string): Element | null | undefined {
  return element.shadowRoot?.querySelector(selector);
}

function queryAllShadow(element: SmRegisterView, selector: string): Element[] {
  return Array.from(element.shadowRoot?.querySelectorAll(selector) ?? []);
}

function projectionFixture(): PublicStateProjection {
  return {
    revision: 0,
    visibleRegions: [
      {
        regionId: "region-stack",
        label: "stack",
        startAddressHex: "0x1000",
        byteLength: 4096,
        permissions: "rw",
        bytesHex: "000102030405060708090a0b0c0d0e0f",
        truncated: true,
      },
    ],
    visibleRegisters: [
      { name: "RSP", valueHex: "0x1004" }, // 命中 region-stack 窗口
      { name: "RBP", valueHex: "0xdeadbeef" }, // 未命中任何区域
    ],
    callStackSummary: [],
    controlFlow: {
      currentInstruction: { addressHex: "0x0040", text: "push rbp" },
      pausedOn: null,
    },
    semanticHighlights: [],
    status: "paused",
  };
}

function dataSourceWith(projection: PublicStateProjection = projectionFixture()): MemoryDataSource {
  const store = new ProjectionStore();
  store.replaceProjection(projection);
  return new ProjectionDataSource(store);
}

async function mountedElement(dataSource: MemoryDataSource | null): Promise<SmRegisterView> {
  const element = document.createElement("sm-register-view") as SmRegisterView;
  document.body.append(element);
  element.dataSource = dataSource;
  await element.updateComplete;
  return element;
}

describe("SmRegisterView 寄存器列表(FE-RG-01/02)", () => {
  it("纵向全量渲染白名单寄存器:表结构三段齐备(名 / 值 / 特殊显示)", async () => {
    const element = await mountedElement(dataSourceWith());
    expect(customElements.get("sm-register-view")).toBe(SmRegisterView);

    const rows = queryAllShadow(element, "tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector("th")?.textContent).toBe("RSP");
    expect(rows[0]?.querySelector(".value-button")?.textContent?.trim()).toBe("0x1004");
    expect(queryShadow(element, "thead th")?.textContent).toBe("寄存器");

    element.remove();
  });

  it("值显示恒 0x + 大写(数据源小写漂移输入归一化)", async () => {
    const projection = projectionFixture();
    projection.visibleRegisters = [{ name: "RBP", valueHex: "0xdeadbeef" }];
    const element = await mountedElement(dataSourceWith(projection));
    expect(queryShadow(element, ".value-button")?.textContent?.trim()).toBe("0xDEADBEEF");

    element.remove();
  });

  it("无数据源或空寄存器 → 空状态提示,不渲染表格(M14:不留占位行)", async () => {
    const emptyElement = await mountedElement(dataSourceWith());
    emptyElement.dataSource = dataSourceWith({
      ...projectionFixture(),
      visibleRegisters: [],
    });
    await emptyElement.updateComplete;
    expect(queryShadow(emptyElement, "table")).toBeNull();
    expect(queryShadow(emptyElement, "[role='status']")?.textContent).toContain("暂无寄存器数据");

    const nullElement = await mountedElement(null);
    expect(queryShadow(nullElement, "table")).toBeNull();
    expect(queryShadow(nullElement, "[role='status']")).not.toBeNull();

    emptyElement.remove();
    nullElement.remove();
  });

  it("特殊显示列:值命中可见区域窗口 → '→ regionId' 引用;未命中 → 无标注", async () => {
    const element = await mountedElement(dataSourceWith());
    const rows = queryAllShadow(element, "tbody tr");

    const firstRowRef = rows[0]?.querySelector(".cell-region-ref");
    expect(firstRowRef?.textContent?.trim()).toBe("→ region-stack");
    expect(firstRowRef?.getAttribute("data-region")).toBe("region-stack");

    expect(rows[1]?.querySelector(".cell-region-ref")).toBeNull();

    element.remove();
  });
});

describe("SmRegisterView 点击复制(FE-RG-03 + Q8 降级)", () => {
  it("点击值单元格 → 注入的剪贴板写入器收到归一化值,成功反馈可见", async () => {
    const writer = vi.fn().mockResolvedValue(undefined);
    const element = await mountedElement(dataSourceWith());
    element.copyToClipboard = writer;
    await element.updateComplete;

    (queryShadow(element, "tbody tr .value-button") as HTMLButtonElement).click();
    // 复制是异步链(写入器 promise → 反馈状态 → 渲染):宏任务边界后收敛。
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;

    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith("0x1004");
    expect(queryShadow(element, ".copy-feedback")?.textContent?.trim()).toBe(COPY_SUCCESS_TEXT);

    element.remove();
  });

  it("剪贴板 rejection → Q8 降级:选中文本节点 + '已就绪手动复制'提示", async () => {
    const writer = vi.fn().mockRejectedValue(new Error("denied"));
    const element = await mountedElement(dataSourceWith());
    element.copyToClipboard = writer;
    await element.updateComplete;

    // jsdom 的 Selection 不支持影子根内选区(rangeCount 恒 0),改以 API 调用
    // 侦察验证降级路径:组件把值文本范围交给选区(浏览器中即选中可 Ctrl+C)。
    const selection = window.getSelection()!;
    const addRangeSpy = vi.spyOn(selection, "addRange");

    (queryShadow(element, "tbody tr .value-button") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;

    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith("0x1004");
    const feedback = queryShadow(element, ".copy-feedback");
    expect(feedback?.textContent?.trim()).toBe(COPY_FALLBACK_TEXT);
    expect(feedback?.classList.contains("copy-fallback")).toBe(true);
    expect(addRangeSpy).toHaveBeenCalledTimes(1);
    const range = addRangeSpy.mock.calls[0]?.[0];
    expect(range?.toString()).toContain("0x1004");
    addRangeSpy.mockRestore();

    element.remove();
  });

  it("复制成功反馈自动消隐(不残留状态)", async () => {
    vi.useFakeTimers();
    try {
      const writer = vi.fn().mockResolvedValue(undefined);
      const element = await mountedElement(dataSourceWith());
      element.copyToClipboard = writer;
      await element.updateComplete;

      (queryShadow(element, "tbody tr .value-button") as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(0);
      await element.updateComplete;
      expect(queryShadow(element, ".copy-feedback")).not.toBeNull();

      await vi.advanceTimersByTimeAsync(2500);
      await element.updateComplete;
      expect(queryShadow(element, ".copy-feedback")).toBeNull();

      element.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("键盘可达:行聚焦后 Enter 触发复制;事件源自值按钮时行级处理器跳过(防双发)", async () => {
    const writer = vi.fn().mockResolvedValue(undefined);
    const element = await mountedElement(dataSourceWith());
    element.copyToClipboard = writer;
    await element.updateComplete;

    const row = queryShadow(element, "tbody tr") as HTMLElement;
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writer).toHaveBeenCalledTimes(1);

    // 事件源自行内值按钮(target ≠ 行)→ 行级处理器跳过:
    // 真实浏览器中按钮自身会派发 click,复制只走按钮路径一次。
    const button = queryShadow(element, "tbody tr .value-button") as HTMLElement;
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writer).toHaveBeenCalledTimes(1);

    // 非 Enter 键不触发复制。
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writer).toHaveBeenCalledTimes(1);

    element.remove();
  });
});

describe("defaultClipboardWriter(navigator.clipboard 默认路径,Q8)", () => {
  function stubNavigatorClipboard(writeText: unknown): void {
    Object.defineProperty(navigator, "clipboard", {
      value: writeText === undefined ? undefined : { writeText },
      configurable: true,
    });
  }

  afterEach(() => {
    stubNavigatorClipboard(undefined);
  });

  it("navigator.clipboard 可用 → 透传 writeText(成功 resolve)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigatorClipboard(writeText);
    await expect(defaultClipboardWriter("0xABCD")).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("0xABCD");
  });

  it("navigator.clipboard.writeText rejection → 透传拒绝(组件走降级)", async () => {
    stubNavigatorClipboard(vi.fn().mockRejectedValue(new Error("not allowed")));
    await expect(defaultClipboardWriter("0xABCD")).rejects.toThrow("not allowed");
  });

  it("navigator.clipboard 不可用(非安全上下文)→ 拒绝(组件走降级)", async () => {
    stubNavigatorClipboard(undefined);
    await expect(defaultClipboardWriter("0xABCD")).rejects.toThrow();
  });
});

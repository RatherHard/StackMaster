/**
 * <sm-register-view> 组件测试(WP-F4 / FE-RG-01/02/03 + Q8;WP-75#5 / D-MP-3):
 * 全量纵向渲染(M14 白名单口径)、valueHex 大写归一化、特殊显示列(区域引用 +
 * 复用 <sm-jump-chain> 只读形态)、点击值 / 点击链上地址复制成功与降级两路径
 * (注入 clipboard stub)、键盘 Enter 复制、反馈自动消隐。
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
import type { SmJumpChain } from "../../../src/views/chain/sm-jump-chain.js";
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

/**
 * 链可解引用夹具(WP-75#5):RSP = 0x1004,该处 8 字节(小端)= 0x1010 →
 * 链 = 0x1004 → 0x1010(第二段地址超出 16 字节已下发窗口 ⇒ outsideWindow 截断)。
 * 两个芯片地址不同 ⇒ 可区分「复制寄存器值」与「复制链上地址」。
 */
function projectionWithChain(): PublicStateProjection {
  const projection = projectionFixture();
  projection.visibleRegions = [
    {
      regionId: "region-stack",
      label: "stack",
      startAddressHex: "0x1000",
      byteLength: 4096,
      permissions: "rw",
      // 偏移 4..11 = 0x1010 的小端形态;其余字节填 0(不可解引用)。
      bytesHex: "00000000101000000000000000000000",
      truncated: true,
    },
  ];
  projection.visibleRegisters = [{ name: "RSP", valueHex: "0x1004" }];
  return projection;
}

/** 取行内链组件并等待其自身首帧渲染完成(链内容在其 shadow 根内)。 */
async function chainOf(element: SmRegisterView, registerName = "RSP"): Promise<SmJumpChain> {
  const chain = queryShadow(
    element,
    `tr[data-register="${registerName}"] sm-jump-chain`,
  ) as SmJumpChain | null;
  expect(chain).not.toBeNull();
  await (chain as SmJumpChain).updateComplete;
  return chain as SmJumpChain;
}

/** 链 shadow 根内的地址芯片查询。 */
function chipOf(chain: SmJumpChain, addressHex: string): HTMLButtonElement {
  const chip = chain.shadowRoot?.querySelector(
    `.chain-address[data-address="${addressHex}"]`,
  ) as HTMLButtonElement | null;
  expect(chip).not.toBeNull();
  return chip as HTMLButtonElement;
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
    expect(rows[1]?.querySelector("sm-jump-chain")).toBeNull();

    element.remove();
  });
});

// ── WP-75#5 / D-MP-3:特殊显示列复用跳转链只读形态 + 点击复制 ────────────────

describe("SmRegisterView 特殊显示列只读跳转链(D-MP-3)", () => {
  it("命中可见区域 → 以寄存器值为锚挂载 <sm-jump-chain>(视觉与栈视图同族)", async () => {
    const element = await mountedElement(dataSourceWith(projectionWithChain()));
    const chain = await chainOf(element);

    // 锚 = 寄存器值(命中地址),与栈视图行右段链同源语义。
    // 绑定形态 = **属性面**(`.startAddressHex`):Lit 的属性名缺省是「全小写、
    // 不加连字符」(startAddressHex → startaddresshex),kebab 属性名
    // (`start-address-hex`)落不进属性、链恒空渲染——本用例即固定该口径。
    expect(chain.startAddressHex).toBe("0x1004");
    expect(chain.dataSource).toBe(element.dataSource);
    // 只读形态:不呈现调试档「延伸」入口(延伸归栈视图链,不在本视图接线)。
    expect(chain.extendable).toBe(false);
    // 链两段芯片齐备(0x1004 → 0x1010)。
    expect(chipOf(chain, "0x1004").textContent?.trim()).toBe("0x1004");
    expect(chipOf(chain, "0x1010").textContent?.trim()).toBe("0x1010");

    element.remove();
  });

  it("链芯片 tooltip 与点击行为一致:只读形态取「点击复制」(M3 遗留-5 ②)", async () => {
    const element = await mountedElement(dataSourceWith(projectionWithChain()));
    const chain = await chainOf(element);

    // M2 核查表登记项:`chain.jumpTitle`(「跳转到 {address}」)在只读形态下与
    // 实际行为(点击 = 复制)不符 ⇒ 本视图须以只读复制形态接线,芯片 tooltip
    // 取 `chain.copyTitle`。窗口内段无后缀,窗口外段保留「(窗口外)」后缀。
    expect(chain.copyMode).toBe(true);
    expect(chipOf(chain, "0x1004").getAttribute("title")).toBe("点击复制 0x1004");
    expect(chipOf(chain, "0x1010").getAttribute("title")).toBe("点击复制 0x1010(窗口外)");
    // 断言锚:不得回潮为跳转文案。
    expect(chipOf(chain, "0x1004").getAttribute("title")).not.toContain("跳转到");

    element.remove();
  });

  it("点击链上地址 → 复制该地址且 viewport-jump 不冒泡(点击不跳转)", async () => {
    const writer = vi.fn().mockResolvedValue(undefined);
    const element = await mountedElement(dataSourceWith(projectionWithChain()));
    element.copyToClipboard = writer;
    await element.updateComplete;
    const chain = await chainOf(element);

    const atChain: Event[] = [];
    const atDocument: Event[] = [];
    const chainListener = (event: Event): void => {
      atChain.push(event);
    };
    const documentListener = (event: Event): void => {
      atDocument.push(event);
    };
    chain.addEventListener("viewport-jump", chainListener);
    document.addEventListener("viewport-jump", documentListener);
    try {
      chipOf(chain, "0x1010").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await element.updateComplete;
    } finally {
      chain.removeEventListener("viewport-jump", chainListener);
      document.removeEventListener("viewport-jump", documentListener);
    }

    // 事件确实由链组件发出(链级可见),但被本视图就地截停 → 工作区跳转处理器收不到。
    expect(atChain).toHaveLength(1);
    expect(atDocument).toHaveLength(0);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith("0x1010");
    const feedback = queryShadow(element, ".copy-feedback");
    expect(feedback?.textContent?.trim()).toBe(COPY_SUCCESS_TEXT);
    expect(feedback?.getAttribute("data-copy-source")).toBe("address");

    element.remove();
  });

  it("地址复制降级:剪贴板 rejection → 选中该地址芯片 + '已就绪手动复制'(不静默失败)", async () => {
    const writer = vi.fn().mockRejectedValue(new Error("denied"));
    const element = await mountedElement(dataSourceWith(projectionWithChain()));
    element.copyToClipboard = writer;
    await element.updateComplete;
    const chain = await chainOf(element);

    const selection = window.getSelection()!;
    const addRangeSpy = vi.spyOn(selection, "addRange");

    chipOf(chain, "0x1010").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;

    expect(writer).toHaveBeenCalledWith("0x1010");
    const feedback = queryShadow(element, ".copy-feedback");
    expect(feedback?.textContent?.trim()).toBe(COPY_FALLBACK_TEXT);
    expect(feedback?.classList.contains("copy-fallback")).toBe(true);
    expect(feedback?.getAttribute("data-copy-source")).toBe("address");
    // 降级选区落在被点击的地址芯片(链 shadow 根内),用户可直接 Ctrl+C。
    expect(addRangeSpy).toHaveBeenCalledTimes(1);
    expect(addRangeSpy.mock.calls[0]?.[0]?.toString()).toContain("0x1010");
    addRangeSpy.mockRestore();

    element.remove();
  });

  it("复制反馈落在来源单元格:值复制在值格、地址复制在特殊显示列(同行至多一条 status)", async () => {
    const writer = vi.fn().mockResolvedValue(undefined);
    const element = await mountedElement(dataSourceWith(projectionWithChain()));
    element.copyToClipboard = writer;
    await element.updateComplete;

    (queryShadow(element, "tbody tr .value-button") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;
    expect(
      queryShadow(element, "tbody tr td.value .copy-feedback")?.getAttribute("data-copy-source"),
    ).toBe("value");
    expect(queryAllShadow(element, "tbody tr .copy-feedback")).toHaveLength(1);

    const chain = await chainOf(element);
    chipOf(chain, "0x1010").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;
    // 来源切换:值格反馈让位给特殊显示列反馈(单条 status,不重复播报)。
    expect(queryShadow(element, "tbody tr td.value .copy-feedback")).toBeNull();
    expect(
      queryShadow(element, "tbody tr td.special .copy-feedback")?.getAttribute("data-copy-source"),
    ).toBe("address");
    expect(queryAllShadow(element, "tbody tr .copy-feedback")).toHaveLength(1);

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

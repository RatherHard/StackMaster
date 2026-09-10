/**
 * <sm-byte-tab> 字节页组合行为测试(WP-F5):vma-select ↔ showRegion ↔
 * selectedRegionId 回路、rowDecorator 透传、refresh() 联动、viewKind 标题。
 */
import { describe, expect, it } from "vitest";

import type { Row } from "../../src/datasource/types.js";
import { SmByteTab } from "../../src/workspace/byte-tab.js";
import type { ByteRowDecoration } from "../../src/views/byte/byte-view.js";
import { FakeMemoryDataSource } from "../views/byte/fake-data-source.js";

const REGIONS = [
  {
    regionId: "region-stack",
    label: "stack",
    startAddressHex: "0x1000",
    byteLength: 4096,
    permissions: "rw",
    windowBytesHex: "000102030405060708090a0b0c0d0e0f",
  },
  {
    regionId: "region-heap",
    label: "heap",
    startAddressHex: "0x2000",
    byteLength: 64,
    permissions: "rw",
    windowBytesHex: "a0a1a2a3a4a5a6a7",
  },
];

const REGISTERS = [
  { name: "RSP", valueHex: "0x1004" },
  { name: "RBP", valueHex: "0x100c" },
];

/** 等待若干渲染帧(虚拟列表重渲染收敛)。 */
async function settleFrames(frames: number): Promise<void> {
  for (let frame = 0; frame < frames; frame += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    await Promise.resolve();
  }
}

async function mountByteTab(viewKind: "stack" | "free" = "stack"): Promise<{ tab: SmByteTab; dataSource: FakeMemoryDataSource }> {
  const dataSource = new FakeMemoryDataSource(REGIONS, REGISTERS);
  const tab = new SmByteTab();
  tab.viewKind = viewKind;
  tab.dataSource = dataSource;
  document.body.append(tab);
  await tab.updateComplete;
  return { tab, dataSource };
}

describe("<sm-byte-tab> 跨视图联动接线", () => {
  it("vma-select → byteView.showRegion(regionId):字节视图切区域", async () => {
    const { tab } = await mountByteTab();
    const list = tab.vmaList;
    expect(list).not.toBeNull();
    const view = tab.byteView;
    expect(view).not.toBeNull();
    expect(view?.activeRegionId).toBeNull(); // 默认区域由选取规则决定,未显式选中。

    const heapButton = [...(list?.shadowRoot?.querySelectorAll("button.region") ?? [])].find(
      (button) => button.textContent?.includes("heap"),
    ) as HTMLButtonElement;
    heapButton.click();
    await tab.updateComplete;

    expect(view?.activeRegionId).toBe("region-heap");
    tab.remove();
  });

  it("region-change → 回写 vmaList.selectedRegionId(选择高亮回路)", async () => {
    const { tab } = await mountByteTab();
    const list = tab.vmaList;

    const heapButton = [...(list?.shadowRoot?.querySelectorAll("button.region") ?? [])].find(
      (button) => button.textContent?.includes("heap"),
    ) as HTMLButtonElement;
    heapButton.click();
    await tab.updateComplete;
    await list?.updateComplete;

    expect(list?.selectedRegionId).toBe("region-heap");
    const heapButtonAfter = [...(list?.shadowRoot?.querySelectorAll("button.region") ?? [])].find(
      (button) => button.textContent?.includes("heap"),
    );
    expect(heapButtonAfter?.classList.contains("selected")).toBe(true);
    tab.remove();
  });

  it("rowDecorator 透传字节视图(宿主层行装饰挂点)", async () => {
    const { tab } = await mountByteTab();
    const decorator = (row: Row): ByteRowDecoration | null =>
      row.addressHex === "0x1000" ? { lead: "L" } : null;
    tab.rowDecorator = decorator;
    await tab.updateComplete;

    expect(tab.byteView?.rowDecorator).toBe(decorator);
    tab.remove();
  });

  it("refresh() 联动字节视图与 VMA 侧栏(投影变更驱动)", async () => {
    const { tab, dataSource } = await mountByteTab();
    const view = tab.byteView;
    if (view === null) {
      throw new Error("字节视图未渲染");
    }
    const before = view.shadowRoot?.textContent ?? "";

    dataSource.setWindowBytes("region-stack", "ffff02030405060708090a0b0c0d0e0f");
    expect(view.shadowRoot?.textContent).toBe(before); // 刷新前内容不变。
    tab.refresh();
    await view.updateComplete;
    await settleFrames(3);

    expect(view.shadowRoot?.textContent).toContain("ffff");
    tab.remove();
  });

  it("viewKind 决定字节视图标题(栈视图 / 自由视图)", async () => {
    const stack = await mountByteTab("stack");
    expect(stack.tab.byteView?.shadowRoot?.textContent).toContain("栈视图");
    stack.tab.remove();

    const free = await mountByteTab("free");
    expect(free.tab.byteView?.shadowRoot?.textContent).toContain("自由视图");
    free.tab.remove();
  });
});

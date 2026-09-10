/**
 * <sm-vma-list> 组件行为测试(WP-F3;FE-FV-06):按地址有序、字段与权限
 * 规范序呈现、截断标记、选择事件、空态与刷新。
 */
import { describe, expect, it } from "vitest";

import { SmVmaList, normalizePermissions, sortRegionsByAddress } from "../../../src/views/byte/vma-list.js";
import type { MemoryDataSource, VmaEntry } from "../../../src/datasource/types.js";
import { FakeMemoryDataSource } from "./fake-data-source.js";

function makeRegion(regionId: string, startAddressHex: string, overrides: Partial<VmaEntry> = {}): VmaEntry {
  return {
    regionId,
    label: regionId,
    startAddressHex,
    byteLength: 64,
    permissions: "rw",
    windowByteLength: 64,
    truncated: false,
    ...overrides,
  };
}

async function mountVmaList(dataSource: MemoryDataSource): Promise<SmVmaList> {
  const element = document.createElement("sm-vma-list");
  element.dataSource = dataSource;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function regionButtons(element: SmVmaList): HTMLButtonElement[] {
  const found = element.shadowRoot?.querySelectorAll("button.region") ?? [];
  return Array.from(found) as HTMLButtonElement[];
}

describe("<sm-vma-list> 渲染(FE-FV-06)", () => {
  it("展示 regionId / label / 起址(8 位)/ 长度 / 权限规范序 / 窗口字节数", async () => {
    const dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-stack",
          label: "stack",
          startAddressHex: "0x1000",
          byteLength: 4096,
          permissions: "xwr",
          windowBytesHex: "00010203",
        },
      ],
      [],
    );
    const element = await mountVmaList(dataSource);
    const button = regionButtons(element)[0];
    const text = button?.textContent ?? "";
    expect(text).toContain("stack");
    expect(text).toContain("region-stack");
    expect(text).toContain("0x00001000");
    expect(text).toContain("4096 B");
    expect(text).toContain("rwx"); // xwr → 规范序 rwx。
    expect(text).toContain("窗口 4 B");
    expect(text).toContain("已截断"); // windowByteLength(4) < byteLength(4096)。
    element.remove();
  });

  it("列表按地址升序排列(输入序无关)", async () => {
    const dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-high",
          label: "high",
          startAddressHex: "0x2000",
          byteLength: 8,
          permissions: "rw",
          windowBytesHex: "aa",
        },
        {
          regionId: "region-low",
          label: "low",
          startAddressHex: "0x1000",
          byteLength: 8,
          permissions: "rw",
          windowBytesHex: "bb",
        },
      ],
      [],
    );
    const element = await mountVmaList(dataSource);
    const ids = regionButtons(element).map(
      (button) => button.querySelector(".region-id")?.textContent,
    );
    expect(ids).toEqual(["region-low", "region-high"]);
    element.remove();
  });

  it("窗口完整时标记「完整」", async () => {
    const dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-full",
          label: "full",
          startAddressHex: "0x1000",
          byteLength: 8,
          permissions: "r",
          windowBytesHex: "0102030405060708",
        },
      ],
      [],
    );
    const element = await mountVmaList(dataSource);
    expect(regionButtons(element)[0]?.textContent).toContain("完整");
    element.remove();
  });

  it("选中区域高亮(aria-pressed + selected 类)", async () => {
    const dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-a",
          label: "a",
          startAddressHex: "0x1000",
          byteLength: 8,
          permissions: "rw",
          windowBytesHex: "00",
        },
        {
          regionId: "region-b",
          label: "b",
          startAddressHex: "0x2000",
          byteLength: 8,
          permissions: "rw",
          windowBytesHex: "00",
        },
      ],
      [],
    );
    const element = await mountVmaList(dataSource);
    element.selectedRegionId = "region-b";
    await element.updateComplete;
    const buttons = regionButtons(element);
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("false");
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1]?.classList.contains("selected")).toBe(true);
    element.remove();
  });
});

describe("<sm-vma-list> 选择事件", () => {
  it("点击条目派发 vma-select(detail.regionId)", async () => {
    const dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-a",
          label: "a",
          startAddressHex: "0x1000",
          byteLength: 8,
          permissions: "rw",
          windowBytesHex: "00",
        },
      ],
      [],
    );
    const element = await mountVmaList(dataSource);
    const received: string[] = [];
    element.addEventListener("vma-select", (event) => {
      received.push((event as CustomEvent<{ regionId: string }>).detail.regionId);
    });
    regionButtons(element)[0]?.click();
    expect(received).toEqual(["region-a"]);
    element.remove();
  });
});

describe("<sm-vma-list> 空态与刷新", () => {
  it("无区域呈现空态", async () => {
    const element = await mountVmaList(new FakeMemoryDataSource([], []));
    expect(element.shadowRoot?.querySelector(".empty")?.textContent).toContain("暂无可见内存区域");
    element.remove();
  });

  it("dataSource 置空回到空态(宿主拆绑口径)", async () => {
    const dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-a",
          label: "a",
          startAddressHex: "0x1000",
          byteLength: 8,
          permissions: "rw",
          windowBytesHex: "00",
        },
      ],
      [],
    );
    const element = await mountVmaList(dataSource);
    expect(regionButtons(element).length).toBe(1);
    element.dataSource = null;
    await element.updateComplete;
    expect(regionButtons(element).length).toBe(0);
    expect(element.shadowRoot?.querySelector(".empty")).not.toBeNull();
    element.remove();
  });

  it("refresh() 重读快照(宿主 onProjectionChanged → refresh 接线)", async () => {
    const dataSource = new FakeMemoryDataSource([], []);
    const element = await mountVmaList(dataSource);
    expect(element.shadowRoot?.querySelector(".empty")).not.toBeNull();
    dataSource.addRegion({
      regionId: "region-new",
      label: "new",
      startAddressHex: "0x3000",
      byteLength: 8,
      permissions: "rw",
      windowBytesHex: "0001020304050607",
    });
    element.refresh();
    await element.updateComplete;
    const buttons = regionButtons(element);
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.textContent).toContain("region-new");
    element.remove();
  });
});

describe("normalizePermissions 权限规范序", () => {
  it("按 r < w < x 规范排序,剔除非法与重复字符", () => {
    expect(normalizePermissions("wr")).toBe("rw");
    expect(normalizePermissions("xwr")).toBe("rwx");
    expect(normalizePermissions("rwz")).toBe("rw");
    expect(normalizePermissions("rr")).toBe("r");
    expect(normalizePermissions("")).toBe("");
    expect(normalizePermissions("xz")).toBe("x");
  });
});

describe("sortRegionsByAddress 地址排序", () => {
  it("按起始地址数值升序(异宽十六进制形态亦正确)", () => {
    const sorted = sortRegionsByAddress([
      makeRegion("b", "0x10000"),
      makeRegion("a", "0x1000"),
      makeRegion("c", "0x20"),
    ]);
    expect(sorted.map((region) => region.regionId)).toEqual(["c", "a", "b"]);
  });

  it("不改输入数组(纯函数)", () => {
    const input = [makeRegion("b", "0x2000"), makeRegion("a", "0x1000")];
    sortRegionsByAddress(input);
    expect(input.map((region) => region.regionId)).toEqual(["b", "a"]);
  });

  it("起始地址相同视为等序(比较器返回 0)", () => {
    const sorted = sortRegionsByAddress([makeRegion("x", "0x1000"), makeRegion("y", "0x1000")]);
    expect(sorted).toHaveLength(2);
  });
});

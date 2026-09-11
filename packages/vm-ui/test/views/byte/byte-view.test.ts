/**
 * <sm-byte-view> 组件行为测试(WP-F3;jsdom + test/setup.ts 桩):
 * 三段布局、高地址在下、窗口外 cell 语义、rsp/rbp 锚点(M13)、对齐偏移、
 * 窗口内导航/检索(M3)、region 切换、虚拟列表首屏有界。
 */
import { SmWindowList } from "../../../src/views/virtual/sm-window-list.js";
import { describe, expect, it, vi } from "vitest";

import { SmByteView } from "../../../src/views/byte/byte-view.js";
import type { ByteViewKind } from "../../../src/views/byte/byte-view.js";
import type { AddrRange, MemoryDataSource, Row } from "../../../src/datasource/types.js";
import { FakeMemoryDataSource } from "./fake-data-source.js";

/** 等待若干渲染帧(ResizeObserver 桩 → 可见范围计算 → 重渲染链路收敛)。 */
async function settleFrames(frames: number): Promise<void> {
  for (let frame = 0; frame < frames; frame += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
    await Promise.resolve();
  }
}

const STACK_WINDOW_HEX = "000102030405060708090a0b0c0d0e0f";
const HEAP_WINDOW_HEX = "a0a1a2a3a4a5a6a7";

/** 标准夹具:双区域(stack 主视图 + heap)+ RSP/RBP 均在 stack 窗口内。 */
function makeDataSource(registers = defaultRegisters()): FakeMemoryDataSource {
  return new FakeMemoryDataSource(
    [
      {
        regionId: "region-stack",
        label: "stack",
        startAddressHex: "0x1000",
        byteLength: 4096,
        permissions: "rw",
        windowBytesHex: STACK_WINDOW_HEX,
      },
      {
        regionId: "region-heap",
        label: "heap",
        startAddressHex: "0x2000",
        byteLength: 64,
        permissions: "rw",
        windowBytesHex: HEAP_WINDOW_HEX,
      },
    ],
    registers,
  );
}

function defaultRegisters() {
  return [
    { name: "RSP", valueHex: "0x1004" },
    { name: "RBP", valueHex: "0x100c" },
  ];
}

interface MountOptions {
  readonly viewKind?: ByteViewKind;
}

async function mountByteView(dataSource: MemoryDataSource, options: MountOptions = {}): Promise<SmByteView> {
  const element = document.createElement("sm-byte-view");
  element.dataSource = dataSource;
  if (options.viewKind !== undefined) {
    element.viewKind = options.viewKind;
  }
  document.body.append(element);
  await element.updateComplete;
  await settleFrames(5);
  return element;
}

/** 渲染帧收敛后再触发一次更新(属性/交互变更后调用)。 */
async function rerender(element: SmByteView): Promise<void> {
  await element.updateComplete;
  await settleFrames(3);
}

function dataRows(element: SmByteView): Element[] {
  return [...(element.shadowRoot?.querySelectorAll("sm-window-list .byte-row") ?? [])];
}

function query(element: SmByteView, selector: string): Element {
  const found = element.shadowRoot?.querySelector(selector);
  if (found === null || found === undefined) {
    throw new Error(`未找到元素:${selector}`);
  }
  return found;
}

function installScrollSpy(element: SmByteView): ReturnType<typeof vi.fn> {
  const list = query(element, "sm-window-list") as unknown as { scrollToIndex: unknown };
  const spy = vi.fn();
  list.scrollToIndex = spy;
  return spy;
}

function submitForm(element: SmByteView, selector: string): void {
  const form = query(element, selector) as HTMLFormElement;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

describe("<sm-byte-view> 三段布局(FE-ST-01/02)", () => {
  it("行 = 地址段(formatAddressHex 8 位)+ 分组十六进制段 + 特殊显示逐 cell", async () => {
    const element = await mountByteView(makeDataSource());
    const rows = dataRows(element);
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const first = rows[0]!;
    expect(first.getAttribute("data-row-address")).toBe("0x1000");
    const addressCell = first.querySelector(".row-address");
    expect(addressCell?.textContent).toContain("0x00001000");
    // 窗口描述行:窗口 16 B / 区域 4096 B,D3 截断标记可见。
    const caption = query(element, ".window-caption").textContent ?? "";
    expect(caption).toContain("16 B / 区域 4096 B");
    expect(caption).toContain("已截断");
    // 中段:8 字节全在窗口内 → formatBytesHexGrouped 分组(4 字节一组)。
    expect(first.querySelector(".hex-grouped")?.textContent).toBe("00010203 04050607");
    // 右段:特殊显示逐 cell(每字节一个 cell-special,带 data-byte)。
    const specialCells = first.querySelectorAll(".row-special .cell-special");
    expect(specialCells.length).toBe(8);
    expect(specialCells[0]?.getAttribute("data-byte")).toBe("00");
    expect(specialCells[7]?.getAttribute("data-byte")).toBe("07");
    element.remove();
  });

  it("高地址在下:渲染序按地址升序(低地址在上)", async () => {
    const element = await mountByteView(makeDataSource());
    const rows = dataRows(element);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const addresses = rows.map((row) => row.getAttribute("data-row-address"));
    expect(addresses[0]).toBe("0x1000");
    expect(addresses[1]).toBe("0x1008");
    // 有序性:逐行地址严格递增。
    for (let index = 1; index < addresses.length; index += 1) {
      expect(BigInt(addresses[index]!)).toBeGreaterThan(BigInt(addresses[index - 1]!));
    }
    element.remove();
  });

  it("view-kind 决定标题(stack = 栈视图,free = 自由视图)", async () => {
    const stack = await mountByteView(makeDataSource());
    expect(query(stack, ".heading").textContent).toContain("栈视图");
    stack.remove();

    const free = await mountByteView(makeDataSource(), { viewKind: "free" });
    expect(query(free, ".heading").textContent).toContain("自由视图");
    free.remove();
  });
});

describe("<sm-byte-view> 窗口外 cell 语义(D3)", () => {
  it("对齐偏移导致行越出窗口:越界 cell 以 cell-outside 呈现(十六进制 ?? + 特殊显示占位)", async () => {
    const element = await mountByteView(makeDataSource());
    element.alignmentOffset = 1; // 行边界平移:首行 0xff9 含 7 个窗口前地址。
    await rerender(element);

    const rows = dataRows(element);
    expect(rows[0]?.getAttribute("data-row-address")).toBe("0xff9");
    // 十六进制段:1 个窗口内字节 + 7 个窗口外(??,data-outside)。
    const insideHex = rows[0]!.querySelectorAll(".cell-hex:not(.cell-outside)");
    const outsideHex = rows[0]!.querySelectorAll(".cell-hex.cell-outside");
    expect(insideHex.length).toBe(1);
    expect(insideHex[0]?.getAttribute("data-byte")).toBe("00");
    expect(outsideHex.length).toBe(7);
    expect(outsideHex[0]?.getAttribute("data-outside")).not.toBeNull();
    expect(outsideHex[0]?.textContent).toBe("??");
    // 特殊显示段:窗口外 cell 同样携带 cell-outside(renderSpecialDisplayCell(null))。
    expect(rows[0]!.querySelectorAll(".row-special .cell-outside").length).toBe(7);
    // 不再有整行分组形态(混合行退化为逐 cell)。
    expect(rows[0]!.querySelector(".hex-grouped")).toBeNull();
    element.remove();
  });
});

describe("<sm-byte-view> rsp/rbp 视角锚点(FE-ST-04 / M13)", () => {
  it("进入视图锚定 rsp 行;锚点行高亮标记 + 回锚按钮", async () => {
    const spy = vi.spyOn(SmWindowList.prototype, "scrollToIndex").mockImplementation(() => {});
    const element = await mountByteView(makeDataSource());
    expect(spy).toHaveBeenCalledWith(0, "center"); // RSP = 0x1004 → 行 0。

    // 锚点行高亮:rsp 标记在首行,rbp(0x100c)标记在第二行。
    const rows = dataRows(element);
    expect(rows[0]?.classList.contains("anchor-row")).toBe(true);
    expect(rows[0]?.querySelector(".anchor-marker")?.textContent).toBe("rsp");
    expect(rows[1]?.querySelector(".anchor-marker")?.textContent).toBe("rbp");
    const bar = query(element, ".anchor-bar").textContent ?? "";
    expect(bar).toContain("0x00001004");
    expect(query(element, ".anchor-rewind").textContent).toContain("回锚");
    spy.mockRestore();
    element.remove();
  });

  it("点击回锚滚动到锚点行", async () => {
    const element = await mountByteView(makeDataSource());
    const spy = installScrollSpy(element);
    const buttons = [...(element.shadowRoot?.querySelectorAll(".anchor-rewind") ?? [])];
    const rbpButton = buttons.find((button) => button.textContent?.includes("rbp"));
    expect(rbpButton, "未找到 rbp 回锚按钮").toBeDefined();
    (rbpButton as HTMLButtonElement).click();
    await rerender(element);
    expect(spy).toHaveBeenCalledWith(1, "center"); // RBP = 0x100c → 行 1。
    element.remove();
  });

  it("回锚点击在无滚动环境下降级:不报错、行内容完整(M13 不报错口径)", async () => {
    const element = await mountByteView(makeDataSource());
    const button = query(element, ".anchor-rewind") as HTMLButtonElement;
    expect(() => button.click()).not.toThrow();
    await rerender(element);
    expect(dataRows(element).length).toBeGreaterThan(0);
    element.remove();
  });

  it("rsp/rbp 在窗口外:明示「内容不在可见窗口」,不渲染空白、无回锚按钮", async () => {
    const dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-stack",
          label: "stack",
          startAddressHex: "0x1000",
          byteLength: 4096,
          permissions: "rw",
          windowBytesHex: STACK_WINDOW_HEX,
        },
      ],
      [
        { name: "RSP", valueHex: "0x1100" }, // 区域内但窗口前缀之外(D3)。
        { name: "RBP", valueHex: "0x9000" }, // 区域外。
      ],
    );
    const element = await mountByteView(dataSource);
    const bar = query(element, ".anchor-bar").textContent ?? "";
    expect(bar).toContain("rsp 内容不在可见窗口(0x00001100)");
    expect(bar).toContain("rbp 内容不在可见窗口(0x00009000)");
    expect(element.shadowRoot?.querySelectorAll(".anchor-rewind").length).toBe(0);
    // 行照常渲染(不渲染空白)。
    expect(dataRows(element).length).toBeGreaterThan(0);
    element.remove();
  });
});

describe("<sm-byte-view> 对齐偏移可调(FE-ST-03 / FE-FV-03)", () => {
  it("步进 + 到上限 7 夹取,行边界按偏移重排,步进 − 可回落", async () => {
    const element = await mountByteView(makeDataSource());
    const increase = query(element, ".offset-increase") as HTMLButtonElement;
    const decrease = query(element, ".offset-decrease") as HTMLButtonElement;

    increase.click(); // offset 1
    await rerender(element);
    expect(query(element, ".offset-value").textContent).toBe("1");
    expect(dataRows(element)[0]?.getAttribute("data-row-address")).toBe("0xff9");

    for (let step = 0; step < 8; step += 1) {
      increase.click(); // 连点越过上限
    }
    await rerender(element);
    expect(element.alignmentOffset).toBe(7);
    expect(query(element, ".offset-value").textContent).toBe("7");
    expect(increase.disabled).toBe(true); // 上限夹取:按钮禁用。

    decrease.click();
    await rerender(element);
    expect(element.alignmentOffset).toBe(6);

    // 减到 0 后按钮禁用。
    for (let step = 0; step < 8; step += 1) {
      decrease.click();
    }
    await rerender(element);
    expect(element.alignmentOffset).toBe(0);
    expect(decrease.disabled).toBe(true);
    element.remove();
  });
});

describe("<sm-byte-view> 窗口内导航(FE-ST-06 公开档 / M3)", () => {
  it("0x 地址与十进制偏移跳转到所在行(仅窗口内可达)", async () => {
    const element = await mountByteView(makeDataSource());
    const spy = installScrollSpy(element);
    const input = query(element, ".jump-input") as HTMLInputElement;

    input.value = "0x1004";
    submitForm(element, ".jump-form");
    await rerender(element);
    expect(spy).toHaveBeenLastCalledWith(0, "center");
    expect(query(element, ".jump-status").textContent).toContain("已跳转到 0x00001004");

    input.value = "12"; // 窗口内偏移 12 → 0x100c → 行 1。
    submitForm(element, ".jump-form");
    await rerender(element);
    expect(spy).toHaveBeenLastCalledWith(1, "center");
    element.remove();
  });

  it("窗口外输入给「窗口外」反馈,不报错、不滚动", async () => {
    const element = await mountByteView(makeDataSource());
    const spy = installScrollSpy(element);
    const input = query(element, ".jump-input") as HTMLInputElement;

    input.value = "0x9000";
    submitForm(element, ".jump-form");
    await rerender(element);
    expect(query(element, ".jump-status").textContent).toContain("在可见窗口之外");
    expect(spy).not.toHaveBeenCalled();

    input.value = "zz";
    submitForm(element, ".jump-form");
    await rerender(element);
    expect(query(element, ".jump-status").textContent).toContain("无法识别");
    element.remove();
  });

  it("调试档(FE-ST-05,WP-F8):数据源声明 prefetchWindow 时窗口外跳转自动请求窗口后重试", async () => {
    const source = new PrefetchableDataSource();
    const element = await mountByteView(source);
    const input = query(element, ".jump-input") as HTMLInputElement;

    input.value = "0x1080";
    submitForm(element, ".jump-form");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await rerender(element);

    expect(source.prefetchRequests).toEqual(["0x1080"]);
    expect(query(element, ".jump-status").textContent).toContain("已跳转到 0x00001080");
    element.remove();
  });

  it("调试档:prefetch 失败(通道不可达)给降级明示文案", async () => {
    const source = new PrefetchableDataSource();
    source.fail = true;
    const element = await mountByteView(source);
    const input = query(element, ".jump-input") as HTMLInputElement;

    input.value = "0x1080";
    submitForm(element, ".jump-form");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await rerender(element);
    expect(query(element, ".jump-status").textContent).toContain("窗口请求失败");
    element.remove();
  });
});

/** 调试档替身(WP-F8):窗口可动态扩(prefetch 入缓存 → regions 覆盖面扩)。 */
class PrefetchableDataSource implements MemoryDataSource {
  windowBytes = 16;
  fail = false;
  readonly prefetchRequests: string[] = [];

  regions() {
    return [
      {
        regionId: "region-stack",
        label: "stack",
        startAddressHex: "0x1000",
        byteLength: 4096,
        permissions: "rw",
        windowByteLength: this.windowBytes,
        truncated: this.windowBytes < 4096,
      },
    ];
  }

  registers() {
    return [
      { name: "RSP", valueHex: "0x1004" },
      { name: "RBP", valueHex: "0x100c" },
    ];
  }

  bytesRows(range: AddrRange): Row[] {
    const rows: Row[] = [];
    const start = BigInt(range.startAddressHex);
    const end = BigInt(range.endAddressHex);
    for (let address = start; address < end; address += 1n) {
      const offset = Number(address - 0x1000n);
      const inWindow = offset >= 0 && offset < this.windowBytes;
      rows.push({
        addressHex: `0x${(address & ~7n).toString(16)}`,
        cells: [
          inWindow
            ? { addressHex: `0x${address.toString(16)}`, regionId: "region-stack", offset, byteHex: "ab", byte: 0xab }
            : { addressHex: `0x${address.toString(16)}`, regionId: "region-stack", offset: null, byteHex: null, byte: null },
        ],
      });
    }
    return rows;
  }

  search() {
    return [];
  }

  async prefetchWindow(addressHex: string): Promise<unknown> {
    if (this.fail) {
      throw new Error("channel unavailable (fake)");
    }
    this.prefetchRequests.push(addressHex);
    this.windowBytes = Number(BigInt(addressHex) - 0x1000n) + 8; // 模拟窗口并入缓存。
    return { addressHex, bytesHex: "ab" };
  }
}

describe("<sm-byte-view> 字节检索(FE-ST-06 公开档 / M3 仅窗口内)", () => {
  it("命中列表点击滚动到命中行", async () => {
    const element = await mountByteView(makeDataSource());
    const spy = installScrollSpy(element);
    const input = query(element, ".search-input") as HTMLInputElement;
    input.value = "0304";
    submitForm(element, ".search-form");
    await rerender(element);

    const hits = [...(element.shadowRoot?.querySelectorAll(".search-hit") ?? [])];
    expect(hits.length).toBe(1);
    expect(hits[0]?.textContent).toContain("0x00001003");
    (hits[0] as HTMLButtonElement).click();
    await rerender(element);
    expect(spy).toHaveBeenCalledWith(0, "center"); // 0x1003 → 行 0。
    element.remove();
  });

  it("跨区域命中先切区域再滚动,并派发 region-change", async () => {
    const element = await mountByteView(makeDataSource());
    const regionEvents: string[] = [];
    element.addEventListener("region-change", (event) => {
      regionEvents.push((event as CustomEvent<{ regionId: string }>).detail.regionId);
    });
    const spy = installScrollSpy(element);
    const input = query(element, ".search-input") as HTMLInputElement;
    input.value = "a2a3"; // 仅 heap 窗口含此字节序列。
    submitForm(element, ".search-form");
    await rerender(element);

    const hit = query(element, ".search-hit") as HTMLButtonElement;
    expect(hit.textContent).toContain("heap(region-heap)");
    hit.click();
    await rerender(element);

    expect(regionEvents).toEqual(["region-heap"]);
    expect(element.activeRegionId).toBe("region-heap");
    expect(spy).toHaveBeenCalledWith(0, "center"); // 0x2002 → heap 行 0。
    element.remove();
  });

  it("非法模式与无命中给状态反馈,不报错", async () => {
    const element = await mountByteView(makeDataSource());
    const input = query(element, ".search-input") as HTMLInputElement;

    input.value = "abc"; // 奇数长度。
    submitForm(element, ".search-form");
    await rerender(element);
    expect(query(element, ".search-status").textContent).toContain("偶数长度");

    input.value = "ffff"; // 窗口内无此序列。
    submitForm(element, ".search-form");
    await rerender(element);
    expect(query(element, ".search-status").textContent).toContain("无命中");
    element.remove();
  });

  it("命中数超上限截断展示并给汇总", async () => {
    // 窗口全 0x00 → 模式 "00" 命中 16 处(窗口 16 字节)。
    const dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-zeros",
          label: "zeros",
          startAddressHex: "0x1000",
          byteLength: 16,
          permissions: "rw",
          windowBytesHex: "00".repeat(16),
        },
      ],
      [],
    );
    const element = await mountByteView(dataSource);
    const input = query(element, ".search-input") as HTMLInputElement;
    input.value = "00";
    submitForm(element, ".search-form");
    await rerender(element);
    expect(element.shadowRoot?.querySelectorAll(".search-hit").length).toBe(8);
    expect(query(element, ".search-summary").textContent).toContain("共 16 处命中");
    element.remove();
  });
});

describe("<sm-byte-view> 区域切换(FE-FV-06 接线面)", () => {
  it("多区域呈现区域选择;切换派发 region-change 并重建行", async () => {
    const element = await mountByteView(makeDataSource());
    const regionEvents: string[] = [];
    element.addEventListener("region-change", (event) => {
      regionEvents.push((event as CustomEvent<{ regionId: string }>).detail.regionId);
    });

    const select = query(element, ".region-select") as HTMLSelectElement;
    select.value = "region-heap";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await rerender(element);

    expect(regionEvents).toEqual(["region-heap"]);
    expect(element.activeRegionId).toBe("region-heap");
    expect(dataRows(element)[0]?.getAttribute("data-row-address")).toBe("0x2000");
    element.remove();
  });

  it("showRegion() 供宿主/VMA 侧栏接线,行为与选择器一致", async () => {
    const element = await mountByteView(makeDataSource());
    const regionEvents: string[] = [];
    element.addEventListener("region-change", (event) => {
      regionEvents.push((event as CustomEvent<{ regionId: string }>).detail.regionId);
    });
    element.showRegion("region-heap");
    await rerender(element);
    expect(regionEvents).toEqual(["region-heap"]);
    expect(dataRows(element)[0]?.getAttribute("data-row-address")).toBe("0x2000");
    element.remove();
  });

  it("单区域不渲染区域选择器", async () => {
    const dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-only",
          label: "only",
          startAddressHex: "0x1000",
          byteLength: 16,
          permissions: "rw",
          windowBytesHex: STACK_WINDOW_HEX,
        },
      ],
      defaultRegisters(),
    );
    const element = await mountByteView(dataSource);
    expect(element.shadowRoot?.querySelector(".region-select")).toBeNull();
    element.remove();
  });
});

describe("<sm-byte-view> 数据纪律与刷新", () => {
  it("默认区域选取:含 rsp 值的区域优先", async () => {
    // RSP 指向 heap → 默认区域为 heap(即使 regions() 首项是 stack)。
    const dataSource = makeDataSource([
      { name: "RSP", valueHex: "0x2004" },
      { name: "RBP", valueHex: "0x100c" },
    ]);
    const element = await mountByteView(dataSource);
    expect(dataRows(element)[0]?.getAttribute("data-row-address")).toBe("0x2000");
    element.remove();
  });

  it("refresh() 重读数据源快照(宿主 onProjectionChanged → refresh 接线)", async () => {
    const dataSource = makeDataSource();
    const element = await mountByteView(dataSource);
    dataSource.setWindowBytes("region-stack", "ff0102030405060708090a0b0c0d0e0f");
    element.refresh();
    await rerender(element);
    expect(dataRows(element)[0]?.querySelector(".hex-grouped")?.textContent).toBe("ff010203 04050607");
    element.remove();
  });

  it("换绑 dataSource 引用即重建(快照引用变化口径)", async () => {
    const element = await mountByteView(makeDataSource());
    element.dataSource = makeDataSource([
      { name: "RSP", valueHex: "0x2004" },
      { name: "RBP", valueHex: "0x200c" },
    ]);
    await rerender(element);
    expect(dataRows(element)[0]?.getAttribute("data-row-address")).toBe("0x2000");
    element.remove();
  });

  it("无区域时呈现空态(不渲染空白、不报错)", async () => {
    const element = await mountByteView(new FakeMemoryDataSource([], []));
    expect(query(element, ".empty").textContent).toContain("暂无可见内存区域");
    element.remove();
  });

  it("dataSource 置空回到空态(宿主拆绑口径)", async () => {
    const element = await mountByteView(makeDataSource());
    element.dataSource = null;
    await rerender(element);
    expect(query(element, ".empty").textContent).toContain("暂无可见内存区域");
    expect(element.shadowRoot?.querySelector("sm-window-list .byte-row")).toBeNull();
    element.remove();
  });

  it("showRegion 重复选同一区域不重复派发 region-change", async () => {
    const element = await mountByteView(makeDataSource());
    const regionEvents: string[] = [];
    element.addEventListener("region-change", (event) => {
      regionEvents.push((event as CustomEvent<{ regionId: string }>).detail.regionId);
    });
    element.showRegion("region-heap");
    element.showRegion("region-heap");
    await rerender(element);
    expect(regionEvents).toEqual(["region-heap"]);
    element.remove();
  });
});

describe("<sm-byte-view> 虚拟列表(硬门槛)", () => {
  it("4096B 窗口(512+ 行)仅渲染首屏有界行数,虚拟化真实生效", async () => {
    const windowHex = Array.from({ length: 4096 }, (_value, index) =>
      (index % 256).toString(16).padStart(2, "0"),
    ).join("");
    const dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-big",
          label: "big",
          startAddressHex: "0x1000",
          byteLength: 4096,
          permissions: "rw",
          windowBytesHex: windowHex,
        },
      ],
      [{ name: "RSP", valueHex: "0x1004" }],
    );
    const element = await mountByteView(dataSource);
    await settleFrames(10);
    const rowCount = dataRows(element).length;
    expect(rowCount, "虚拟列表未渲染任何行").toBeGreaterThan(0);
    expect(rowCount, `渲染了 ${rowCount} 行(512 行全渲染 = 虚拟化未生效)`).toBeLessThan(128);
    element.remove();
  });
});

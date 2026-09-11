/**
 * <sm-jump-chain> 延伸入口测试(WP-F8 / FE-ST-08/10 调试档):链末段窗口外
 * + extendable + extendHandler 注入时呈现「延伸」按钮 → prefetch → 重解析,
 * "已延伸至缓存边界"反馈;解题档(extendable=false)维持窗口外截断现状。
 */
import { describe, expect, it } from "vitest";

import type { AddrRange, ByteCell, MemoryDataSource, Row, VmaEntry } from "../../../src/datasource/types.js";
import { SmJumpChain } from "../../../src/views/chain/sm-jump-chain.js";
import { mount, queryShadow } from "../ed/helpers.js";

/** 内存版数据源:region @0x1000(16 字节窗口,区域全长 4096)——可动态扩窗。 */
class ExtendableSource implements MemoryDataSource {
  windowBytes = 16;
  readonly extended: number[] = [];

  regions(): VmaEntry[] {
    return [
      {
        regionId: "stack",
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
    return [];
  }

  bytesRows(range: AddrRange): Row[] {
    const rows: Row[] = [];
    const start = BigInt(range.startAddressHex);
    const end = BigInt(range.endAddressHex);
    for (let address = start; address < end; address += 1n) {
      const offset = Number(address - 0x1000n);
      const inWindow = address >= 0x1000n && offset < this.windowBytes;
      const cell: ByteCell = inWindow
        ? {
            addressHex: `0x${address.toString(16)}`,
            regionId: "stack",
            offset,
            byteHex: "00",
            byte: 0,
          }
        : {
            addressHex: `0x${address.toString(16)}`,
            regionId: "stack",
            offset: null,
            byteHex: null,
            byte: null,
          };
      rows.push({ addressHex: `0x${(address & ~7n).toString(16)}`, cells: [cell] });
    }
    return rows;
  }

  search() {
    return [];
  }
}

async function mountChain(dataSource: MemoryDataSource | null, options: { extendable?: boolean; extendHandler?: (addressHex: string) => Promise<void> } = {}): Promise<SmJumpChain> {
  const element = await mount<SmJumpChain>("sm-jump-chain");
  element.startAddressHex = "0x1000";
  element.dataSource = dataSource;
  element.extendable = options.extendable ?? false;
  element.extendHandler = options.extendHandler ?? null;
  await element.updateComplete;
  return element;
}

describe("FE-ST-08/10 调试档:跳转链延伸入口(WP-F8 最小骨架)", () => {
  it("解题档(extendable=false):链末窗口外截断,无延伸入口(现状维持)", async () => {
    const view = await mountChain(new ExtendableSource());
    expect(queryShadow(view, ".chain-outside")).toBeNull(); // 横向段以芯片呈现,截断语义在 title。
    expect(queryShadow(view, ".chain-extend-button")).toBeNull();
  });

  it("调试档:链末窗口外呈现「延伸」按钮;点击 prefetch → 重解析 → 缓存边界反馈", async () => {
    const source = new ExtendableSource();
    // 链首段:0x1000 处 8 字节全 0 → 值 0 落空(不是窗口外)。
    // 构造窗口外段:起始地址指向未缓存区域 0x1008(窗口 16 字节内)→
    // 为制造 outsideWindow 段,把窗口缩到 8 字节,起链地址改读 0x1008。
    source.windowBytes = 8;
    const view = await mount<SmJumpChain>("sm-jump-chain");
    view.startAddressHex = "0x1008";
    view.dataSource = source;
    view.extendable = true;
    view.extendHandler = async (addressHex: string) => {
      source.extended.push(Number(BigInt(addressHex)));
      source.windowBytes = 16; // 模拟 prefetch 覆盖至 0x1010。
    };
    await view.updateComplete;

    const button = queryShadow(view, ".chain-extend-button");
    expect(button?.textContent).toContain("延伸");
    button?.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await view.updateComplete;

    expect(source.extended).toEqual([0x1008]);
    // prefetch 后 0x1008 落入窗口 → 链重解析出值段,延伸反馈消隐。
    expect(queryShadow(view, ".chain-extend-status")).toBeNull();
  });

  it("延伸仍不可达:「已延伸至缓存边界」反馈(不伪造链段)", async () => {
    const source = new ExtendableSource();
    source.windowBytes = 8;
    const view = await mount<SmJumpChain>("sm-jump-chain");
    view.startAddressHex = "0x1008";
    view.dataSource = source;
    view.extendable = true;
    view.extendHandler = async () => {
      // prefetch 未覆盖目标(仍窗口 8 字节)。
    };
    await view.updateComplete;
    queryShadow(view, ".chain-extend-button")?.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await view.updateComplete;
    expect(queryShadow(view, ".chain-extend-status")?.textContent).toContain("已延伸至缓存边界");
  });

  it("延伸失败(通道不可达):降级明示文案", async () => {
    const source = new ExtendableSource();
    source.windowBytes = 8;
    const view = await mount<SmJumpChain>("sm-jump-chain");
    view.startAddressHex = "0x1008";
    view.dataSource = source;
    view.extendable = true;
    view.extendHandler = async () => {
      throw new Error("channel unavailable (fake)");
    };
    await view.updateComplete;
    queryShadow(view, ".chain-extend-button")?.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await view.updateComplete;
    expect(queryShadow(view, ".chain-extend-status")?.textContent).toContain("延伸失败");
  });
});

/**
 * 跳转链解析测试(WP-F4 / FE-ST-07 窗口内部分):首段解析、小端端序、
 * 循环回环终止、窗口外截断、值落空终止、≤3 段上限、limitReached 判定。
 *
 * 夹具直接用 WP-F2 的 ProjectionStore + ProjectionDataSource(公开档语义
 * 与生产一致:窗口 = 区域起点前缀,越界 cell 为窗口外标记)。
 */
import { describe, expect, it } from "vitest";

import { ProjectionStore } from "../../../src/client/projection-store.js";
import { ProjectionDataSource } from "../../../src/datasource/projection-data-source.js";
import type { PublicStateProjection } from "@stackmaster/protocol";
import {
  JUMP_CHAIN_HORIZONTAL_LIMIT,
  chainLimitReached,
  resolveJumpChain,
} from "../../../src/views/chain/resolve.js";

/** 字节偏移 → 值的小端字节序列(低字节在前,超出值宽度补 00),拼进区域窗口 bytesHex。 */
function littleEndianHex(value: number, byteLength = 8): string {
  let out = "";
  let remaining = value;
  for (let index = 0; index < byteLength; index += 1) {
    out += (remaining & 0xff).toString(16).padStart(2, "0");
    remaining = Math.floor(remaining / 256);
  }
  return out;
}

/** 稀疏字节布局 → 区域窗口 bytesHex(未指定偏移补 00)。 */
function windowHexFrom(spans: Array<[offset: number, hex: string]>, windowBytes: number): string {
  const bytes = new Uint8Array(windowBytes);
  for (const [offset, hex] of spans) {
    for (let index = 0; index < hex.length / 2; index += 1) {
      bytes[offset + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function projectionWith(regions: PublicStateProjection["visibleRegions"]): PublicStateProjection {
  return {
    revision: 0,
    visibleRegions: regions,
    visibleRegisters: [],
    callStackSummary: [],
    controlFlow: {
      currentInstruction: { addressHex: "0x0040", text: "push rbp" },
      pausedOn: null,
    },
    semanticHighlights: [],
    status: "paused",
  };
}

function dataSourceWith(
  regions: PublicStateProjection["visibleRegions"],
): ProjectionDataSource {
  const store = new ProjectionStore();
  store.replaceProjection(projectionWith(regions));
  return new ProjectionDataSource(store);
}

/** 单区域夹具:region-chain @0x1000,区域 4096 字节,窗口字节由 spans 给出。 */
function singleRegionDataSource(
  spans: Array<[offset: number, hex: string]>,
  windowBytes: number,
): ProjectionDataSource {
  return dataSourceWith([
    {
      regionId: "region-chain",
      label: "chain",
      startAddressHex: "0x1000",
      byteLength: 4096,
      permissions: "rw",
      bytesHex: windowHexFrom(spans, windowBytes),
      truncated: windowBytes < 4096,
    },
  ]);
}

describe("resolveJumpChain 首段解析(窗口内)", () => {
  it("地址 → 该处 8 字节小端解释值 → 值落回窗口继续解引用,值落空即终止", () => {
    // 0x1000 处的值 = 0x1008(窗口内,继续);0x1008 处的值全 ff(不在任何窗口,终止)。
    const dataSource = singleRegionDataSource(
      [
        [0, littleEndianHex(0x1008)],
        [8, "ffffffffffffffff"],
      ],
      16,
    );
    expect(resolveJumpChain("0x1000", dataSource)).toEqual([
      { addressHex: "0x1000", valueHex: "0x1008", targetAddressHex: "0x1008" },
      { addressHex: "0x1008", valueHex: "0xFFFFFFFFFFFFFFFF" },
    ]);
  });

  it("端序定案 = 小端:字节 34 12 … 解释为 0x1234(而非大端 0x3412)", () => {
    const dataSource = singleRegionDataSource([[0, "3412000000000000"]], 16);
    const segments = resolveJumpChain("0x1000", dataSource);
    expect(segments[0]?.valueHex).toBe("0x1234");
    // 值 0x1234 落在窗口内(0x1000..0x1010)→ 继续解引用;0x1234 超出 16 字节窗口。
    expect(segments[0]?.targetAddressHex).toBe("0x1234");
    expect(segments[1]).toEqual({ addressHex: "0x1234", outsideWindow: true });
  });

  it("值十六进制恒 0x + 大写(契约归一化形态)", () => {
    const dataSource = singleRegionDataSource([[0, "ab cd 00 00 00 00 00 00".replaceAll(" ", "")]], 16);
    expect(resolveJumpChain("0x1000", dataSource)[0]?.valueHex).toBe("0xCDAB");
  });

  it("起始地址非 8 对齐时按 [start, start+8) 跨行读取(部分行拼合)", () => {
    // 0x1004 起的 8 字节 = 30 12 00 00 00 00 00 00 → 小端 0x1230。
    const dataSource = singleRegionDataSource([[4, littleEndianHex(0x1230)]], 16);
    const segments = resolveJumpChain("0x1004", dataSource);
    expect(segments[0]?.addressHex).toBe("0x1004");
    expect(segments[0]?.valueHex).toBe("0x1230");
  });
});

describe("resolveJumpChain 循环回环检测", () => {
  it("A → B → A:回环段标记 loopBack 并终止(回环箭头依据)", () => {
    const dataSource = singleRegionDataSource(
      [
        [0, littleEndianHex(0x1008)],
        [8, littleEndianHex(0x1000)],
      ],
      16,
    );
    expect(resolveJumpChain("0x1000", dataSource)).toEqual([
      { addressHex: "0x1000", valueHex: "0x1008", targetAddressHex: "0x1008" },
      { addressHex: "0x1008", valueHex: "0x1000", targetAddressHex: "0x1000", loopBack: true },
    ]);
  });

  it("自环(A 的值 = A):单段即回环终止", () => {
    const dataSource = singleRegionDataSource([[0, littleEndianHex(0x1000)]], 16);
    expect(resolveJumpChain("0x1000", dataSource)).toEqual([
      { addressHex: "0x1000", valueHex: "0x1000", targetAddressHex: "0x1000", loopBack: true },
    ]);
  });
});

describe("resolveJumpChain 窗口外语义(D3 截断不报错)", () => {
  it("起始地址未映射:单段 outsideWindow 截断", () => {
    const dataSource = singleRegionDataSource([[0, littleEndianHex(0x1008)]], 16);
    expect(resolveJumpChain("0x9000", dataSource)).toEqual([
      { addressHex: "0x9000", outsideWindow: true },
    ]);
  });

  it("起始地址在区域内但超出已下发前缀:outsideWindow 截断", () => {
    const dataSource = singleRegionDataSource([], 16);
    // 0x1100 在 region-chain(4096 字节)内,但窗口仅下发前 16 字节。
    expect(resolveJumpChain("0x1100", dataSource)).toEqual([
      { addressHex: "0x1100", outsideWindow: true },
    ]);
  });

  it("值落点在区域范围但窗口外:先给出 target,下一段 outsideWindow 截断", () => {
    const dataSource = singleRegionDataSource([[0, littleEndianHex(0x1100)]], 16);
    expect(resolveJumpChain("0x1000", dataSource)).toEqual([
      { addressHex: "0x1000", valueHex: "0x1100", targetAddressHex: "0x1100" },
      { addressHex: "0x1100", outsideWindow: true },
    ]);
  });

  it("值未落在任何可见区域(未映射):仅记 valueHex,链终止", () => {
    const dataSource = singleRegionDataSource([[0, "ffffffffffffffff"]], 16);
    expect(resolveJumpChain("0x1000", dataSource)).toEqual([
      { addressHex: "0x1000", valueHex: "0xFFFFFFFFFFFFFFFF" },
    ]);
  });

  it("值落在另一个可见区域的窗口内:跨区域继续解引用", () => {
    const dataSource = dataSourceWith([
      {
        regionId: "region-a",
        label: "a",
        startAddressHex: "0x1000",
        byteLength: 4096,
        permissions: "rw",
        bytesHex: littleEndianHex(0x2004),
        truncated: true,
      },
      {
        regionId: "region-b",
        label: "b",
        startAddressHex: "0x2000",
        byteLength: 4096,
        permissions: "rw",
        // 窗口 16 字节,偏移 4 起放置值 0x9999:0x2004 处的 8 字节读取完全落在窗口内。
        bytesHex: windowHexFrom([[4, "9999000000000000"]], 16),
        truncated: true,
      },
    ]);
    expect(resolveJumpChain("0x1000", dataSource)).toEqual([
      { addressHex: "0x1000", valueHex: "0x2004", targetAddressHex: "0x2004" },
      { addressHex: "0x2004", valueHex: "0x9999" }, // 0x9999 不在任何区域 → 终止
    ]);
  });
});

describe("resolveJumpChain 段数上限(FE-ST-07 横向 ≤3 段)", () => {
  it("超过上限的链默认截断为 3 段,limitReached 判定为真", () => {
    // 五连链:0x1000 → 0x1008 → 0x1010 → 0x1018 → 0x1020 → 0x1028(窗口 40 字节在 0x1028 处用尽)。
    const spans: Array<[number, string]> = [];
    for (let index = 0; index < 5; index += 1) {
      spans.push([index * 8, littleEndianHex(0x1000 + (index + 1) * 8)]);
    }
    const dataSource = singleRegionDataSource(spans, 40);
    const segments = resolveJumpChain("0x1000", dataSource);
    expect(segments.map((segment) => segment.addressHex)).toEqual([
      "0x1000",
      "0x1008",
      "0x1010",
    ]);
    expect(segments[2]?.targetAddressHex).toBe("0x1018");
    expect(chainLimitReached(segments, JUMP_CHAIN_HORIZONTAL_LIMIT)).toBe(true);

    // 展开视图用大上限解析同一条链:0x1020 的值 0x1028 恰在窗口尾之外(区域
    // 范围内)→ 仍给出 target;0x1028 处 8 字节已不在下发窗口 → outsideWindow 截断。
    const full = resolveJumpChain("0x1000", dataSource, { maxSegments: 32 });
    expect(full.map((segment) => segment.addressHex)).toEqual([
      "0x1000",
      "0x1008",
      "0x1010",
      "0x1018",
      "0x1020",
      "0x1028",
    ]);
    expect(full[4]?.targetAddressHex).toBe("0x1028");
    expect(full[5]?.outsideWindow).toBe(true);
    expect(chainLimitReached(full, 32)).toBe(false);
  });

  it("链自然终止(无下一跳)时 limitReached 恒为假", () => {
    const dataSource = singleRegionDataSource([[0, "ffffffffffffffff"]], 16);
    const segments = resolveJumpChain("0x1000", dataSource);
    expect(chainLimitReached(segments, JUMP_CHAIN_HORIZONTAL_LIMIT)).toBe(false);
    expect(chainLimitReached([], 3)).toBe(false);
  });

  it("maxSegments 显式覆盖上限;非正整数抛错", () => {
    const spans: Array<[number, string]> = [];
    for (let index = 0; index < 3; index += 1) {
      spans.push([index * 8, littleEndianHex(0x1000 + (index + 1) * 8)]);
    }
    const dataSource = singleRegionDataSource(spans, 32);
    const two = resolveJumpChain("0x1000", dataSource, { maxSegments: 2 });
    expect(two).toHaveLength(2);
    expect(chainLimitReached(two, 2)).toBe(true);

    expect(() => resolveJumpChain("0x1000", dataSource, { maxSegments: 0 })).toThrow();
    expect(() => resolveJumpChain("0x1000", dataSource, { maxSegments: 1.5 })).toThrow();
  });

  it("非法起始地址抛错(渲染层自行捕获为空链)", () => {
    const dataSource = singleRegionDataSource([], 16);
    expect(() => resolveJumpChain("nothex", dataSource)).toThrow();
  });
});

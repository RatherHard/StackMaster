/**
 * ProjectionDataSource(公开档)测试(WP-F2):窗口外语义(D3)、检索边界、
 * regions/registers 映射、valueHex 大写归一化、8 字节行切分对齐。
 */
import { describe, expect, it } from "vitest";

import { ProjectionStore } from "../../src/client/projection-store.js";
import { ProjectionDataSource } from "../../src/datasource/projection-data-source.js";
import type { MemoryDataSource } from "../../src/datasource/types.js";
import type { PublicStateProjection } from "@stackmaster/protocol";

/**
 * 基准投影:
 *  - region-stack @0x1000,4096 字节,窗口下发 16 字节(0102…0e0f),truncated;
 *  - region-guard @0x2000(窗口外检查用),下发 4 字节;
 *  - 0x3000 起为未映射空洞(bytesRows 应给全窗口外 cell)。
 */
function projectionWithWindows(): PublicStateProjection {
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
      {
        regionId: "region-guard",
        label: "guard",
        startAddressHex: "0x2000",
        byteLength: 4096,
        permissions: "r",
        bytesHex: "f0f1f2f3",
        truncated: true,
      },
    ],
    visibleRegisters: [{ name: "RSP", valueHex: "0xBFF8" }],
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
  projection: PublicStateProjection = projectionWithWindows(),
): { store: ProjectionStore; dataSource: ProjectionDataSource } {
  const store = new ProjectionStore();
  store.replaceProjection(projection);
  return { store, dataSource: new ProjectionDataSource(store) };
}

describe("ProjectionDataSource regions/registers 映射", () => {
  it("regions 映射可见区域布局与锚定窗口交付尺寸", () => {
    const { dataSource } = dataSourceWith();
    const regions = dataSource.regions();
    expect(regions).toHaveLength(2);
    expect(regions[0]).toEqual({
      regionId: "region-stack",
      label: "stack",
      startAddressHex: "0x1000",
      byteLength: 4096,
      permissions: "rw",
      windowByteLength: 16,
      truncated: true,
    });
    expect(regions[1]?.windowByteLength).toBe(4);
  });

  it("registers 映射白名单寄存器,valueHex 恒 0x + 大写归一化(渲染层兜底)", () => {
    // 喂入小写漂移形态(绕过契约 Schema,直验数据源归一化兜底)。
    const drifted = projectionWithWindows();
    drifted.visibleRegisters = [
      { name: "RSP", valueHex: "0xdeadbeef" },
      { name: "RBP", valueHex: "0xbff8" },
    ];
    const { dataSource } = dataSourceWith(drifted);
    expect(dataSource.registers()).toEqual([
      { name: "RSP", valueHex: "0xDEADBEEF" },
      { name: "RBP", valueHex: "0xBFF8" },
    ]);
  });

  it("无投影时 regions/registers/search 为空面", () => {
    const store = new ProjectionStore();
    const dataSource = new ProjectionDataSource(store);
    expect(dataSource.regions()).toEqual([]);
    expect(dataSource.registers()).toEqual([]);
    expect(dataSource.search({ patternHex: "00" })).toEqual([]);
  });
});

describe("ProjectionDataSource bytesRows 窗口外语义(D3)", () => {
  it("窗口内字节携带内容与归属,行按 8 字节对齐", () => {
    const { dataSource } = dataSourceWith();
    const rows = dataSource.bytesRows({ startAddressHex: "0x1000", endAddressHex: "0x1010" });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.addressHex).toBe("0x1000");
    const firstRowCells = rows[0]?.cells ?? [];
    expect(firstRowCells).toHaveLength(8);
    expect(firstRowCells[0]).toEqual({
      addressHex: "0x1000",
      regionId: "region-stack",
      offset: 0,
      byteHex: "00",
      byte: 0,
    });
    expect(firstRowCells[7]).toMatchObject({ offset: 7, byteHex: "07", byte: 7 });
    expect(rows[1]?.cells[7]).toMatchObject({ offset: 15, byteHex: "0f", byte: 15 });
  });

  it("窗口尽头的越界查询返回窗口外标记而非报错(区域内窗口外带归属)", () => {
    const { dataSource } = dataSourceWith();
    // 0x1010 起仍在 region-stack(4096 字节)内,但已在下发窗口(16 字节)之外。
    const rows = dataSource.bytesRows({ startAddressHex: "0x1010", endAddressHex: "0x1018" });
    expect(rows).toHaveLength(1);
    const cells = rows[0]?.cells ?? [];
    expect(cells).toHaveLength(8);
    for (const cell of cells) {
      expect(cell).toEqual({
        addressHex: expect.any(String),
        regionId: "region-stack",
        offset: null,
        byteHex: null,
        byte: null,
      });
    }
  });

  it("未映射地址全 null cell;跨窗口边界行混合内容与窗口外标记", () => {
    const { dataSource } = dataSourceWith();
    // 未映射空洞(0x3000 起)。
    const unmapped = dataSource.bytesRows({ startAddressHex: "0x3000", endAddressHex: "0x3008" });
    expect(unmapped[0]?.cells.every((cell) => cell.byteHex === null && cell.regionId === null)).toBe(
      true,
    );

    // 跨界行:0x1ffc…0x2003 横跨 region-stack 尾(未交付)与 region-guard 窗口头。
    const straddle = dataSource.bytesRows({ startAddressHex: "0x1ffc", endAddressHex: "0x2004" });
    expect(straddle.map((row) => row.addressHex)).toEqual(["0x1ff8", "0x2000"]);
    const guardHead = straddle[1]?.cells[0];
    expect(guardHead).toMatchObject({
      addressHex: "0x2000",
      regionId: "region-guard",
      offset: 0,
      byteHex: "f0",
      byte: 0xf0,
    });
  });

  it("查询区间按行对齐切分:非对齐首尾为部分行,空区间返回空数组", () => {
    const { dataSource } = dataSourceWith();
    const partial = dataSource.bytesRows({ startAddressHex: "0x1004", endAddressHex: "0x1014" });
    expect(partial.map((row) => row.addressHex)).toEqual(["0x1000", "0x1008", "0x1010"]);
    expect(partial[0]?.cells).toHaveLength(4); // 0x1004..0x1007
    expect(partial[1]?.cells).toHaveLength(8);
    expect(partial[2]?.cells).toHaveLength(4); // 0x1010..0x1013

    expect(dataSource.bytesRows({ startAddressHex: "0x1010", endAddressHex: "0x1010" })).toEqual([]);
    expect(dataSource.bytesRows({ startAddressHex: "0x1010", endAddressHex: "0x1000" })).toEqual([]);
  });
});

describe("ProjectionDataSource search 边界(仅在已下发窗口字节内)", () => {
  it("命中返回区域 id + 绝对地址 + 回显;模式大小写归一", () => {
    const { dataSource } = dataSourceWith();
    // 0a0b 位于 region-stack 偏移 10 → 0x100a。
    const hits = dataSource.search({ patternHex: "0A0B" });
    expect(hits).toEqual([
      { regionId: "region-stack", addressHex: "0x100a", matchedHex: "0a0b" },
    ]);
  });

  it("检索不越过已下发窗口,也不跨区域拼接字节", () => {
    const store = new ProjectionStore();
    store.replaceProjection({
      ...projectionWithWindows(),
      visibleRegions: [
        {
          regionId: "region-stack",
          label: "stack",
          startAddressHex: "0x1000",
          byteLength: 4096,
          permissions: "rw",
          bytesHex: "aaff",
          truncated: false,
        },
        {
          regionId: "region-guard",
          label: "guard",
          startAddressHex: "0x2000",
          byteLength: 4096,
          permissions: "r",
          bytesHex: "ffbb",
          truncated: false,
        },
      ],
    });
    const dataSource = new ProjectionDataSource(store);
    // 窗口内真实存在:命中。
    expect(dataSource.search({ patternHex: "aaff" })).toEqual([
      { regionId: "region-stack", addressHex: "0x1000", matchedHex: "aaff" },
    ]);
    // "ffff" 只在"跨区域拼接"后存在 → 不得命中(区域独立检索)。
    expect(dataSource.search({ patternHex: "ffff" })).toEqual([]);
    // 窗口之外(region-stack 尾部 0x1002+)不可检索:越界模式不命中。
    expect(dataSource.search({ patternHex: "ff00" })).toEqual([]);
  });

  it("非字节对齐的十六进制匹配被跳过(只在字节边界命中)", () => {
    const store = new ProjectionStore();
    store.replaceProjection({
      ...projectionWithWindows(),
      visibleRegions: [
        {
          regionId: "region-stack",
          label: "stack",
          startAddressHex: "0x1000",
          byteLength: 4096,
          permissions: "rw",
          bytesHex: "0a0b0c",
          truncated: false,
        },
      ],
    });
    const dataSource = new ProjectionDataSource(store);
    // "a0b0" 只以 nibble 错位形态出现(十六进制串奇数位)→ 跳过,零命中。
    expect(dataSource.search({ patternHex: "a0b0" })).toEqual([]);
    expect(dataSource.search({ patternHex: "0a0b" })).toEqual([
      { regionId: "region-stack", addressHex: "0x1000", matchedHex: "0a0b" },
    ]);
  });

  it("空模式返回空命中", () => {
    const { dataSource } = dataSourceWith();
    expect(dataSource.search({ patternHex: "" })).toEqual([]);
  });
});

describe("ProjectionDataSource 公开档约束", () => {
  it("instructionStream 恒 undefined(公开档不存在,调试档独有)", () => {
    const { dataSource } = dataSourceWith();
    expect((dataSource as { instructionStream?: unknown }).instructionStream).toBeUndefined();
    expect("instructionStream" in dataSource).toBe(false);
  });

  it("结构可赋值给 MemoryDataSource 接口面(视图唯一依赖面)", () => {
    const { dataSource } = dataSourceWith();
    const asInterface: MemoryDataSource = dataSource;
    expect(asInterface.regions).toBeTypeOf("function");
    expect(asInterface.bytesRows).toBeTypeOf("function");
    expect(asInterface.search).toBeTypeOf("function");
    expect(asInterface.registers).toBeTypeOf("function");
  });
});

/**
 * render/rows 行切分纯函数测试(WP-F2):8 字节行对齐、区间跨度切分、行内偏移。
 */
import { describe, expect, it } from "vitest";

import {
  ROW_BYTES,
  alignDownToRow,
  enumerateRowSpans,
  offsetInRow,
  rowBaseAddressHex,
} from "../../src/render/rows.js";

describe("8 字节行对齐", () => {
  it("ROW_BYTES 恒为 8(FE-ST-01 行粒度)", () => {
    expect(ROW_BYTES).toBe(8);
  });

  it("alignDownToRow 向下对齐到行基地址", () => {
    expect(alignDownToRow(0x1000n)).toBe(0x1000n);
    expect(alignDownToRow(0x1007n)).toBe(0x1000n);
    expect(alignDownToRow(0x1008n)).toBe(0x1008n);
    expect(alignDownToRow(0n)).toBe(0n);
  });

  it("rowBaseAddressHex / offsetInRow 十六进制形态", () => {
    expect(rowBaseAddressHex("0x1003")).toBe("0x1000");
    expect(offsetInRow("0x1003", "0x1000")).toBe(3);
    expect(offsetInRow("0x1000", "0x1000")).toBe(0);
    expect(offsetInRow("0x1007", "0x1000")).toBe(7);
  });
});

describe("enumerateRowSpans 区间 → 行跨度", () => {
  it("对齐区间切成整行", () => {
    const spans = enumerateRowSpans("0x1000", "0x1010");
    expect(spans).toEqual([
      { addressHex: "0x1000", byteLength: 8 },
      { addressHex: "0x1008", byteLength: 8 },
    ]);
  });

  it("非对齐区间首尾为部分行", () => {
    const spans = enumerateRowSpans("0x1004", "0x1014");
    expect(spans).toEqual([
      { addressHex: "0x1000", byteLength: 4 },
      { addressHex: "0x1008", byteLength: 8 },
      { addressHex: "0x1010", byteLength: 4 },
    ]);
  });

  it("空区间与逆序区间返回空数组(行内无有效交集的行被跳过)", () => {
    expect(enumerateRowSpans("0x1000", "0x1000")).toEqual([]);
    expect(enumerateRowSpans("0x1010", "0x1000")).toEqual([]);
    // 行基地址落在区间之前但行与交集为空(0x1004 > 0x1002)→ 该行不计入。
    expect(enumerateRowSpans("0x1004", "0x1002")).toEqual([]);
  });

  it("自定义行宽(边界参数化)", () => {
    const spans = enumerateRowSpans("0x1000", "0x1006", 4);
    expect(spans).toEqual([
      { addressHex: "0x1000", byteLength: 4 },
      { addressHex: "0x1004", byteLength: 2 },
    ]);
  });
});

/**
 * views/byte/alignment 行切分纯函数测试(WP-F3;FE-ST-03 / FE-FV-03):
 * 对齐偏移 0..7 × 窗口边界 × 奇数长度 × 重切一致性。
 */
import { describe, expect, it } from "vitest";

import {
  byteViewQueryRange,
  clampAlignmentOffset,
  offsetGridRowSpans,
  regroupRows,
} from "../../../src/views/byte/alignment.js";
import { enumerateRowSpans } from "../../../src/render/rows.js";
import { addressToHex, parseAddressHex } from "../../../src/render/hex.js";
import type { ByteCell, Row } from "../../../src/datasource/types.js";

/** 造连续 cell(地址升序;byteHex 递增可辨识)。 */
function makeCells(startHex: string, count: number): ByteCell[] {
  const base = parseAddressHex(startHex);
  return Array.from({ length: count }, (_value, index): ByteCell => {
    const value = (index % 256).toString(16).padStart(2, "0");
    return {
      addressHex: addressToHex(base + BigInt(index)),
      regionId: "region-stack",
      offset: index,
      byteHex: value,
      byte: index % 256,
    };
  });
}

/** 造覆盖 [start, start+count) 的数据源行(8 字节行基址切分,与契约同形)。 */
function makeSourceRows(startHex: string, count: number): Row[] {
  const base = parseAddressHex(startHex);
  const cells = makeCells(startHex, count);
  const rows: Row[] = [];
  for (let cursor = 0; cursor < count; ) {
    const rowAddress = addressToHex(alignDownLocal(base + BigInt(cursor)));
    const take = Math.min(8 - Number((base + BigInt(cursor)) % 8n), count - cursor);
    rows.push({ addressHex: rowAddress, cells: cells.slice(cursor, cursor + take) });
    cursor += take;
  }
  return rows;
}

function alignDownLocal(address: bigint): bigint {
  return address / 8n * 8n;
}

describe("offsetGridRowSpans 对齐偏移行切分", () => {
  it("偏移 0 与 render/rows 的 8 字节行切分一致(FE-ST-01 默认形态)", () => {
    const spans = offsetGridRowSpans("0x1000", "0x1020", 0);
    expect(spans.map((span) => span.addressHex)).toEqual(
      enumerateRowSpans("0x1000", "0x1020").map((span) => span.addressHex),
    );
    expect(spans).toEqual([
      { addressHex: "0x1000", byteLength: 8 },
      { addressHex: "0x1008", byteLength: 8 },
      { addressHex: "0x1010", byteLength: 8 },
      { addressHex: "0x1018", byteLength: 8 },
    ]);
  });

  it("偏移 0..7 各产生覆盖窗口的整行序列,行基址 ≡ offset (mod 8)", () => {
    const windowStart = parseAddressHex("0x1004");
    const windowEnd = parseAddressHex("0x1013");
    for (let offset = 0; offset <= 7; offset += 1) {
      const spans = offsetGridRowSpans("0x1004", "0x1013", offset);
      expect(spans.length, `offset=${offset}`).toBeGreaterThan(0);
      let covered = 0;
      for (const span of spans) {
        expect(span.byteLength).toBe(8);
        expect(parseAddressHex(span.addressHex) % 8n).toBe(BigInt(offset));
        covered += span.byteLength;
      }
      const firstBase = parseAddressHex(spans[0]!.addressHex);
      const lastEnd = parseAddressHex(spans[spans.length - 1]!.addressHex) + 8n;
      // 整行外扩覆盖窗口,且不多出整行以外的覆盖。
      expect(firstBase).toBeLessThanOrEqual(windowStart);
      expect(lastEnd).toBeGreaterThanOrEqual(windowEnd);
      expect(lastEnd - firstBase).toBe(BigInt(covered));
    }
  });

  it("奇数长度窗口两端行越出窗口(窗口边界行,由窗口外 cell 填充)", () => {
    // 窗口 [0x1000, 0x1006):6 字节 → 单个整行 0x1000(2 字节越出窗口尾部)。
    expect(offsetGridRowSpans("0x1000", "0x1006", 0)).toEqual([{ addressHex: "0x1000", byteLength: 8 }]);
    expect(byteViewQueryRange("0x1000", "0x1006", 0)).toEqual({
      startAddressHex: "0x1000",
      endAddressHex: "0x1008",
    });
    // 窗口 [0x1004, 0x100e):两端均不对齐 → 行 0x1000 与 0x1008。
    expect(offsetGridRowSpans("0x1004", "0x100e", 0)).toEqual([
      { addressHex: "0x1000", byteLength: 8 },
      { addressHex: "0x1008", byteLength: 8 },
    ]);
  });

  it("偏移把行边界平移(0x1000 起窗口偏移 1 → 首行 0xff9)", () => {
    expect(offsetGridRowSpans("0x1000", "0x1010", 1).map((span) => span.addressHex)).toEqual([
      "0xff9",
      "0x1001",
      "0x1009",
    ]);
  });

  it("空窗口返回空序列,查询区间为空", () => {
    expect(offsetGridRowSpans("0x1000", "0x1000", 3)).toEqual([]);
    expect(offsetGridRowSpans("0x1010", "0x1000", 0)).toEqual([]);
    const emptyRange = byteViewQueryRange("0x1000", "0x1000", 0);
    expect(parseAddressHex(emptyRange.endAddressHex) <= parseAddressHex(emptyRange.startAddressHex)).toBe(true);
  });

  it("非法偏移(8 / -1 / 2.5)抛错", () => {
    expect(() => offsetGridRowSpans("0x1000", "0x1010", 8)).toThrow();
    expect(() => offsetGridRowSpans("0x1000", "0x1010", -1)).toThrow();
    expect(() => offsetGridRowSpans("0x1000", "0x1010", 2.5)).toThrow();
  });

  it("byteViewQueryRange 恰为 span 序列的覆盖范围(offset 3)", () => {
    const range = byteViewQueryRange("0x1000", "0x1020", 3);
    const spans = offsetGridRowSpans("0x1000", "0x1020", 3);
    expect(range.startAddressHex).toBe(spans[0]!.addressHex);
    const last = spans[spans.length - 1]!;
    expect(range.endAddressHex).toBe(addressToHex(parseAddressHex(last.addressHex) + 8n));
  });
});

describe("clampAlignmentOffset 偏移夹取", () => {
  it("夹取到 0..7(负值→0,超界→7,小数向下取整,非有限→0)", () => {
    expect(clampAlignmentOffset(-3)).toBe(0);
    expect(clampAlignmentOffset(0)).toBe(0);
    expect(clampAlignmentOffset(3.7)).toBe(3);
    expect(clampAlignmentOffset(7)).toBe(7);
    expect(clampAlignmentOffset(9)).toBe(7);
    expect(clampAlignmentOffset(Number.NaN)).toBe(0);
  });
});

describe("regroupRows 按偏移网格重切", () => {
  it("偏移 0 时重切与数据源行一致", () => {
    const sourceRows = makeSourceRows("0x1000", 16);
    const spans = offsetGridRowSpans("0x1000", "0x1010", 0);
    expect(regroupRows(sourceRows, spans)).toEqual(sourceRows);
  });

  it("偏移 3 重切按新网格切分 cell(地址序列守恒)", () => {
    // 窗口 [0x1000, 0x1020) 32 字节;偏移 3 → 网格行 0xffb/0x1003/0x100b/0x1013/0x101b。
    const query = byteViewQueryRange("0x1000", "0x1020", 3);
    const sourceRows = makeSourceRows(query.startAddressHex, 40);
    const spans = offsetGridRowSpans("0x1000", "0x1020", 3);
    const regrouped = regroupRows(sourceRows, spans);
    expect(regrouped.map((row) => row.addressHex)).toEqual([
      "0xffb",
      "0x1003",
      "0x100b",
      "0x1013",
      "0x101b",
    ]);
    // 重切不增删 cell:cell 地址序列与数据源序列一致。
    const sourceAddresses = sourceRows.flatMap((row) => row.cells.map((cell) => cell.addressHex));
    const regroupedAddresses = regrouped.flatMap((row) => row.cells.map((cell) => cell.addressHex));
    expect(regroupedAddresses).toEqual(sourceAddresses);
    // 每行恰 8 cell,行内地址连续。
    for (const row of regrouped) {
      expect(row.cells.length).toBe(8);
      const base = parseAddressHex(row.addressHex);
      row.cells.forEach((cell, index) => {
        expect(cell.addressHex).toBe(addressToHex(base + BigInt(index)));
      });
    }
  });

  it("span 覆盖与数据源 cell 总量不一致(契约漂移)抛错", () => {
    const sourceRows = makeSourceRows("0x1000", 8);
    const spans = offsetGridRowSpans("0x1000", "0x1010", 0); // 16 字节网格 ≠ 8 cell
    expect(() => regroupRows(sourceRows, spans)).toThrow(/不一致/);
  });

  it("空窗口重切为空行", () => {
    expect(regroupRows([], [])).toEqual([]);
  });
});

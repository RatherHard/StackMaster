/**
 * 字节视图行切分(对齐偏移可调,WP-F3;FE-ST-03 / FE-FV-03 纯函数面)。
 *
 * 语义定案(投影语义规约 D3 + FE-ST-01/03):
 *  - 行网格:`ROW_BYTES`(8)字节为一行;对齐偏移 `offset ∈ 0..7` 把网格边界
 *    平移为「地址 ≡ offset (mod 8)」——FE-ST-03 的「对齐基址 + k×8 + offset」;
 *  - 显示行恒为**整行**(8 字节):窗口 [winStart, winEnd) 两端按当前网格
 *    **外扩对齐**,越出窗口的地址经数据源返回「窗口外」cell(契约面:越界
 *    查询返回窗口外标记而非报错,datasource/types.ts ByteCell)——因此行边缘
 *    自然呈现 `cell-outside` 语义,FE-ST-01 的「左段地址 = 该行 8 字节中最低位
 *    字节的地址」恒为网格基址;
 *  - D3 纪律:窗口本身锚定区域起点(前缀 min(区域长, maxBytesPerRange)),
 *    偏移调整只在**已下发窗口内重排**行边界,不产生任何新的数据需求。
 *
 * 全部为 bigint 地址运算纯函数(无 IO、无状态),复用 render/rows 与 render/hex
 * 原语做扩展,不改变其文件。
 */
import type { AddrRange, Row } from "../../datasource/types.js";

import { addressToHex, parseAddressHex } from "../../render/hex.js";
import { ROW_BYTES } from "../../render/rows.js";

/** 单个显示行的跨度:整行网格行(byteLength 恒 rowBytes)。 */
export interface ByteRowSpan {
  /** 行网格基址(0x 前缀小写;= 该行最低位字节的地址,FE-ST-02 左段)。 */
  readonly addressHex: string;
  /** 行覆盖字节数(整行网格恒 rowBytes;保留字段以对齐 render/rows RowSpan 形态)。 */
  readonly byteLength: number;
}

/** 对齐偏移归一:夹取到 0..rowBytes-1(非有限值归 0;防御宿主直接赋值)。 */
export function clampAlignmentOffset(value: number, rowBytes: number = ROW_BYTES): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(rowBytes - 1, Math.max(0, Math.floor(value)));
}

/** 对齐偏移校验:必须是 0..rowBytes-1 的整数,否则抛错(内部计算面用)。 */
function assertAlignmentOffset(offset: number, rowBytes: number): bigint {
  if (!Number.isInteger(offset) || offset < 0 || offset >= rowBytes) {
    throw new Error(`非法对齐偏移(必须为 0..${rowBytes - 1} 的整数):${offset}`);
  }
  return BigInt(offset);
}

/** 网格边界:`b ≡ offset (mod rowBytes)` 的不大于 address 的最大边界。 */
function gridFloor(address: bigint, offset: bigint, rowBytes: number): bigint {
  const row = BigInt(rowBytes);
  // BigInt 取模对负数返回负值,双取模归一到非负(地址可低于 offset 的极小地址)。
  const back = ((address - offset) % row + row) % row;
  return address - back;
}

/**
 * 窗口 → 整行网格行跨度:所有与 [windowStart, windowEnd) 相交的
 * 「地址 ≡ offset (mod rowBytes)」网格行(每行恒 rowBytes 字节,升序)。
 * 窗口端点不对齐时首尾行越出窗口(由数据源以窗口外 cell 填充)。
 * 空窗口(end ≤ start)返回 []。
 */
export function offsetGridRowSpans(
  windowStartHex: string,
  windowEndHex: string,
  offset: number,
  rowBytes: number = ROW_BYTES,
): ByteRowSpan[] {
  const start = parseAddressHex(windowStartHex);
  const end = parseAddressHex(windowEndHex);
  if (end <= start) {
    return [];
  }
  const row = BigInt(rowBytes);
  const gridOffset = assertAlignmentOffset(offset, rowBytes);
  const spans: ByteRowSpan[] = [];
  let rowBase = gridFloor(start, gridOffset, rowBytes);
  while (rowBase < end) {
    spans.push({ addressHex: addressToHex(rowBase), byteLength: rowBytes });
    rowBase += row;
  }
  return spans;
}

/**
 * 窗口 → 对齐外扩查询区间:span 序列的精确覆盖范围(首个网格基址到末行行尾)。
 * 该区间交给 `dataSource.bytesRows()` 查询;越出窗口的地址由数据源按契约返回
 * 窗口外 cell(datasource/types.ts ByteCell:byteHex/byte/offset 为 null)。
 */
export function byteViewQueryRange(
  windowStartHex: string,
  windowEndHex: string,
  offset: number,
  rowBytes: number = ROW_BYTES,
): AddrRange {
  const spans = offsetGridRowSpans(windowStartHex, windowEndHex, offset, rowBytes);
  const first = spans[0];
  if (first === undefined) {
    return { startAddressHex: addressToHex(parseAddressHex(windowStartHex)), endAddressHex: windowStartHex };
  }
  const last = spans[spans.length - 1] as ByteRowSpan;
  return {
    startAddressHex: first.addressHex,
    endAddressHex: addressToHex(parseAddressHex(last.addressHex) + BigInt(last.byteLength)),
  };
}

/**
 * 按偏移网格**重切**数据源行(FE-ST-03「行边界重新划分」):
 *  - `sourceRows` = `dataSource.bytesRows(byteViewQueryRange(...))` 的返回
 *    (cell 按地址升序、每地址恰一 cell——数据源契约面);
 *  - `spans` = `offsetGridRowSpans(...)`(同一窗口同一偏移);
 *  - 重切 = 把 sourceRows 的 cell 序列按 span 字节数顺序切片——两侧覆盖同一
 *    地址区间,总量必相等(漂移即契约破坏,抛错而非静默错位)。
 */
export function regroupRows(sourceRows: readonly Row[], spans: readonly ByteRowSpan[]): Row[] {
  const cells = sourceRows.flatMap((row) => [...row.cells]);
  const totalSpanBytes = spans.reduce((sum, span) => sum + span.byteLength, 0);
  if (totalSpanBytes !== cells.length) {
    throw new Error(
      `行切分与数据源行不一致(网格共 ${totalSpanBytes} 字节,数据源返回 ${cells.length} cell)`,
    );
  }
  const rows: Row[] = [];
  let cursor = 0;
  for (const span of spans) {
    rows.push({ addressHex: span.addressHex, cells: cells.slice(cursor, cursor + span.byteLength) });
    cursor += span.byteLength;
  }
  return rows;
}

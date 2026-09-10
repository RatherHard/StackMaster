/**
 * 8 字节行切分与偏移对齐纯函数(WP-F2 共享渲染层;WP-F3 消费)。
 *
 * 行模型与 datasource/types.ts 的 `Row` 对齐:行基地址按 `ROW_BYTES`(8)
 * 向下对齐;查询区间 [start, end) 切成行序列,首尾可为部分行。
 * 全部为 bigint 地址运算纯函数,不做任何 IO 与状态持有。
 */
import { addressToHex, parseAddressHex } from "./hex.js";

/** 行宽(字节):FE-ST-01 三段布局的行粒度。 */
export const ROW_BYTES = 8;

/** 地址向下对齐到行基地址。 */
export function alignDownToRow(address: bigint, rowBytes: number = ROW_BYTES): bigint {
  return address / BigInt(rowBytes) * BigInt(rowBytes);
}

/** 单地址的行基地址(0x 前缀小写十六进制)。 */
export function rowBaseAddressHex(addressHex: string, rowBytes: number = ROW_BYTES): string {
  return addressToHex(alignDownToRow(parseAddressHex(addressHex), rowBytes));
}

/** 字节在行内的偏移(0..rowBytes-1)。 */
export function offsetInRow(addressHex: string, rowBaseHex: string, rowBytes: number = ROW_BYTES): number {
  return Number((parseAddressHex(addressHex) - parseAddressHex(rowBaseHex)) % BigInt(rowBytes));
}

/** 行跨度:行基地址 + 行覆盖字节数(1–rowBytes;区间首尾可为部分行)。 */
export interface RowSpan {
  readonly addressHex: string;
  readonly byteLength: number;
}

/**
 * 把查询区间 [start, end) 切成 8 字节行跨度(行基地址对齐,首尾为部分行):
 *  - start = 0x1004, end = 0x1014 → [0x1000×4 字节, 0x1008×8 字节, 0x1010×4 字节];
 *  - end ≤ start → 空数组(空区间不产生行)。
 * 返回的 byteLength 是"行与查询区间的交集字节数",不是恒 8——查询范围按行
 * 对齐时恒为 8(FE-ST 虚拟列表按行索引请求,天然对齐)。
 */
export function enumerateRowSpans(
  startAddressHex: string,
  endAddressHex: string,
  rowBytes: number = ROW_BYTES,
): RowSpan[] {
  const start = parseAddressHex(startAddressHex);
  const end = parseAddressHex(endAddressHex);
  const row = BigInt(rowBytes);
  const spans: RowSpan[] = [];
  let rowBase = alignDownToRow(start, rowBytes);
  while (rowBase < end) {
    const rowEnd = rowBase + row;
    const spanStart = rowBase > start ? rowBase : start;
    const spanEnd = rowEnd < end ? rowEnd : end;
    if (spanEnd > spanStart) {
      spans.push({ addressHex: addressToHex(rowBase), byteLength: Number(spanEnd - spanStart) });
    }
    rowBase = rowEnd;
  }
  return spans;
}

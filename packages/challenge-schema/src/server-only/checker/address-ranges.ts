/**
 * 地址区间运算(检查器内部):一律 BigInt(双包Schema语义.md §五),
 * 覆盖 64 位地址空间不丢精度;区间为左闭右开 [start, start + byteLength)。
 *
 * 前置条件:输入已通过 Schema 校验(地址 hex 形态由 Schema 保证);
 * 对前置条件外的畸形输入快速失败,不静默吞掉。
 */

/** 左闭右开地址区间。 */
export interface AddressRange {
  readonly start: bigint;
  readonly endExclusive: bigint;
}

/** 解析 `0x` 前缀十六进制地址(Schema 已保证形态;畸形即抛出)。 */
export function parseAddressHex(hex: string): bigint {
  if (!/^0x[0-9a-fA-F]{1,16}$/.test(hex)) {
    throw new Error(`非法地址十六进制字面量:${hex}`);
  }
  return BigInt(hex.toLowerCase());
}

/** 由起始地址与字节长度构造区间;长度必须为正整数。 */
export function toAddressRange(startAddressHex: string, byteLength: number): AddressRange {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new Error(`非法字节长度:${byteLength}`);
  }
  const start = parseAddressHex(startAddressHex);
  return { start, endExclusive: start + BigInt(byteLength) };
}

/** 两区间交集是否非空(纯区间谓词,任一端点相等不算相交)。 */
export function rangesOverlap(a: AddressRange, b: AddressRange): boolean {
  return a.start < b.endExclusive && b.start < a.endExclusive;
}

/** inner 是否完全落在 outer 之内。 */
export function rangeContains(outer: AddressRange, inner: AddressRange): boolean {
  return inner.start >= outer.start && inner.endExclusive <= outer.endExclusive;
}

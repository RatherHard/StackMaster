/**
 * 字节视图组件测试夹具:内存版 MemoryDataSource(行为命名测试用)。
 *
 * 语义镜像公开档 ProjectionDataSource 的契约面(窗口外 cell、仅窗口内检索、
 * 8 字节行切分),但不依赖 session-client / 投影存储——组件测试只经接口消费,
 * 与"视图只依赖 MemoryDataSource 接口"的数据纪律一致。
 */
import type {
  AddrRange,
  ByteCell,
  ByteQuery,
  Hit,
  MemoryDataSource,
  RegisterRow,
  Row,
  VmaEntry,
  VmaList,
} from "../../../src/datasource/types.js";
import { normalizeBytesHex, addressToHex, parseAddressHex } from "../../../src/render/hex.js";
import { ROW_BYTES, alignDownToRow } from "../../../src/render/rows.js";

/** 区域规格:窗口字节内容长度即 windowByteLength(D3 前缀交付)。 */
export interface FakeRegionSpec {
  readonly regionId: string;
  readonly label: string;
  readonly startAddressHex: string;
  readonly byteLength: number;
  readonly permissions: string;
  /** 已下发窗口字节(偶数长度十六进制,大小写均可)。 */
  readonly windowBytesHex: string;
  readonly truncated?: boolean;
}

export class FakeMemoryDataSource implements MemoryDataSource {
  #specs: readonly FakeRegionSpec[];
  #regions: VmaList;
  readonly #windows: Map<string, string>;
  readonly #registerRows: readonly RegisterRow[];

  constructor(specs: readonly FakeRegionSpec[], registerRows: readonly RegisterRow[] = []) {
    this.#specs = specs;
    this.#regions = FakeMemoryDataSource.#toRegions(specs);
    this.#windows = new Map(specs.map((spec) => [spec.regionId, normalizeBytesHex(spec.windowBytesHex)]));
    this.#registerRows = registerRows;
  }

  static #toRegions(specs: readonly FakeRegionSpec[]): VmaList {
    return specs.map((spec): VmaEntry => {
      const windowByteLength = spec.windowBytesHex.length / 2;
      if (windowByteLength > spec.byteLength) {
        throw new Error(`夹具非法:窗口字节超过区域长(${spec.regionId})`);
      }
      return {
        regionId: spec.regionId,
        label: spec.label,
        startAddressHex: spec.startAddressHex,
        byteLength: spec.byteLength,
        permissions: spec.permissions,
        windowByteLength,
        truncated: spec.truncated ?? windowByteLength < spec.byteLength,
      };
    });
  }

  /** 测试驱动面:替换区域窗口内容(同长度;模拟投影更新,配 refresh() 断言)。 */
  setWindowBytes(regionId: string, windowBytesHex: string): void {
    this.#windows.set(regionId, normalizeBytesHex(windowBytesHex));
  }

  /** 测试驱动面:追加区域(配 refresh() 断言 VMA 列表重建)。 */
  addRegion(spec: FakeRegionSpec): void {
    this.#specs = [...this.#specs, spec];
    this.#regions = FakeMemoryDataSource.#toRegions(this.#specs);
    this.#windows.set(spec.regionId, normalizeBytesHex(spec.windowBytesHex));
  }

  regions(): VmaList {
    return this.#regions;
  }

  registers(): RegisterRow[] {
    return [...this.#registerRows];
  }

  bytesRows(range: AddrRange): Row[] {
    const start = parseAddressHex(range.startAddressHex);
    const end = parseAddressHex(range.endAddressHex);
    if (end <= start) {
      return [];
    }
    const rows: Row[] = [];
    let rowBase = alignDownToRow(start, ROW_BYTES);
    while (rowBase < end) {
      const rowEnd = rowBase + BigInt(ROW_BYTES);
      const spanStart = rowBase > start ? rowBase : start;
      const spanEnd = rowEnd < end ? rowEnd : end;
      const cells: ByteCell[] = [];
      for (let address = spanStart; address < spanEnd; address += 1n) {
        cells.push(this.#cellAt(address));
      }
      rows.push({ addressHex: addressToHex(rowBase), cells });
      rowBase = rowEnd;
    }
    return rows;
  }

  search(query: ByteQuery): Hit[] {
    if (query.patternHex.length === 0) {
      return [];
    }
    const pattern = normalizeBytesHex(query.patternHex);
    const hits: Hit[] = [];
    for (const region of this.#regions) {
      const haystack = this.#windows.get(region.regionId) ?? "";
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(pattern, from);
        if (at < 0) {
          break;
        }
        if (at % 2 === 0) {
          hits.push({
            regionId: region.regionId,
            addressHex: addressToHex(parseAddressHex(region.startAddressHex) + BigInt(at / 2)),
            matchedHex: pattern,
          });
        }
        from = at + 1;
      }
    }
    return hits;
  }

  /** 单地址 cell:区域内窗口内带内容;窗口外/未映射为窗口外标记(契约面)。 */
  #cellAt(address: bigint): ByteCell {
    const addressHex = addressToHex(address);
    for (const region of this.#regions) {
      const base = parseAddressHex(region.startAddressHex);
      if (address < base || address >= base + BigInt(region.byteLength)) {
        continue;
      }
      const windowBytes = (this.#windows.get(region.regionId) ?? "").length / 2;
      const offset = Number(address - base);
      if (offset >= windowBytes) {
        return { addressHex, regionId: region.regionId, offset: null, byteHex: null, byte: null };
      }
      const byteHex = (this.#windows.get(region.regionId) ?? "").slice(offset * 2, offset * 2 + 2);
      return { addressHex, regionId: region.regionId, offset, byteHex, byte: Number.parseInt(byteHex, 16) };
    }
    return { addressHex, regionId: null, offset: null, byteHex: null, byte: null };
  }
}

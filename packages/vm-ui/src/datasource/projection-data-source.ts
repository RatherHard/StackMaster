/**
 * ProjectionDataSource —— 公开档数据源(WP-F2):数据源 = 冻结公开投影。
 *
 * 语义受 D3(窗口锚定区域起点,不支持玩家任选偏移窗口)与 `currentInstruction`
 * 单条约束:
 *  - `regions()` = visibleRegions 直读(附锚定窗口交付尺寸);
 *  - `registers()` = visibleRegisters 直读(valueHex 恒 `0x` + 大写归一化);
 *  - `bytesRows(range)` 按 8 字节行切分,字节内容只来自**已下发窗口**
 *    (区域起点前缀 min(regionByteLength, maxBytesPerRange));越界查询返回
 *    "窗口外"标记 cell 而非报错;
 *  - `search(query)` 仅在已下发窗口字节内检索;
 *  - `instructionStream` 恒 undefined(公开档不存在,调试档独有——WP-F8)。
 *
 * 8 字节行三段布局的数据建模(地址 / 十六进制 / 特殊显示)在本层定稿为
 * `Row{addressHex, cells}`(见 datasource/types.ts);渲染原语见 render/。
 *
 * 视图组件只许依赖 MemoryDataSource 接口消费本类——禁止绕过接口直读
 * session-client 投影存储(前端实施计划 §四;评审解耦的关键约束)。
 */
import type { VisibleMemoryRegion } from "@stackmaster/protocol";

import type { ProjectionStore } from "../client/projection-store.js";
import {
  addressToHex,
  bytesHexToBytes,
  normalizeBytesHex,
  normalizeValueHex,
  parseAddressHex,
} from "../render/hex.js";
import { alignDownToRow, ROW_BYTES } from "../render/rows.js";
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
} from "./types.js";

/** 公开档数据源:包装投影状态存储(同包内装配面;视图经接口消费)。 */
export class ProjectionDataSource implements MemoryDataSource {
  readonly #store: ProjectionStore;

  constructor(store: ProjectionStore) {
    this.#store = store;
  }

  /**
   * 指令流:公开档**不存在**(协议 D5——`currentInstruction` 单条约束,
   * 指令流仅调试通道提供;此处不实现该方法,`"instructionStream" in ds` 为
   * false,视图不得调用)。
   */

  /** VMA 列表(FE-FV-06):可见内存区域公开布局 + 锚定窗口交付尺寸。 */
  regions(): VmaList {
    const projection = this.#store.snapshot;
    if (projection === null) {
      return [];
    }
    return projection.visibleRegions.map((region): VmaEntry => {
      const windowByteLength = region.bytesHex.length / 2;
      return {
        regionId: region.regionId,
        label: region.label,
        startAddressHex: region.startAddressHex,
        byteLength: region.byteLength,
        permissions: region.permissions,
        windowByteLength,
        truncated: region.truncated,
      };
    });
  }

  /** 寄存器行(FE-RG-01/02):valueHex 恒 `0x` + 大写(渲染层归一化兜底)。 */
  registers(): RegisterRow[] {
    const projection = this.#store.snapshot;
    if (projection === null) {
      return [];
    }
    return projection.visibleRegisters.map((register) => ({
      name: register.name,
      valueHex: normalizeValueHex(register.valueHex),
    }));
  }

  /**
   * 8 字节行(半开区间 [start, end)):行基地址按 8 对齐,首尾可为部分行;
   * 每个 cell 要么携带已下发窗口内的字节,要么是"窗口外"标记(D3——越界
   * 查询不报错)。end ≤ start 返回空数组。
   */
  bytesRows(range: AddrRange): Row[] {
    const start = parseAddressHex(range.startAddressHex);
    const end = parseAddressHex(range.endAddressHex);
    if (end <= start) {
      return [];
    }
    const projection = this.#store.snapshot;
    const regions = projection?.visibleRegions ?? [];
    const row = BigInt(ROW_BYTES);
    const rows: Row[] = [];
    let rowBase = alignDownToRow(start, ROW_BYTES);
    while (rowBase < end) {
      const rowEnd = rowBase + row;
      const spanStart = rowBase > start ? rowBase : start;
      const spanEnd = rowEnd < end ? rowEnd : end;
      const cells: ByteCell[] = [];
      for (let address = spanStart; address < spanEnd; address += 1n) {
        cells.push(lookupCell(regions, address));
      }
      rows.push({ addressHex: addressToHex(rowBase), cells });
      rowBase = rowEnd;
    }
    return rows;
  }

  /**
   * 字节检索(公开档边界:仅在已下发窗口字节内):模式为偶数长度十六进制串
 * (大小写均可,内部归一化为小写);命中返回区域 id + 绝对地址 + 回显。
   */
  search(query: ByteQuery): Hit[] {
    if (query.patternHex.length === 0) {
      return [];
    }
    const pattern = normalizeBytesHex(query.patternHex);
    const projection = this.#store.snapshot;
    if (projection === null) {
      return [];
    }
    const hits: Hit[] = [];
    for (const region of projection.visibleRegions) {
      const haystack = normalizeBytesHex(region.bytesHex);
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
}

/** 单地址 → cell:窗口内带内容;可见区域但窗口外带归属;未映射全 null。 */
function lookupCell(regions: readonly VisibleMemoryRegion[], address: bigint): ByteCell {
  const addressHex = addressToHex(address);
  for (const region of regions) {
    const base = parseAddressHex(region.startAddressHex);
    if (address < base || address >= base + BigInt(region.byteLength)) {
      continue;
    }
    // 地址落在可见区域内:窗口(已下发前缀)内有内容,其余为窗口外标记。
    const windowBytes = region.bytesHex.length / 2;
    const offset = Number(address - base);
    if (offset >= windowBytes) {
      return { addressHex, regionId: region.regionId, offset: null, byteHex: null, byte: null };
    }
    const byteHex = region.bytesHex.slice(offset * 2, offset * 2 + 2);
    return {
      addressHex,
      regionId: region.regionId,
      offset,
      byteHex,
      byte: bytesHexToBytes(byteHex)[0] ?? null,
    };
  }
  return { addressHex, regionId: null, offset: null, byteHex: null, byte: null };
}

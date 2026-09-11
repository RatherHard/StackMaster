/**
 * 内存 diff 纯函数(FE-ED-03,WP-F9)。
 *
 * 输入 = 动作前的区域快照(只读面,协议 VisibleMemoryRegion 同形)+ 本动作
 * ProjectionDelta 的 dirtyRanges;输出 = 逐字节变更单元列表(区域 / 地址 /
 * 前值 → 后值)。dirtyRanges 本身就是"动作后权威内存读回"(D-P2 字节同源),
 * 因此 after 值直接取 range.bytesHex,**不需要**动作后快照。
 *
 * 语义锚点(投影语义规约 §3.5 脏范围合并 / §3.4 整体替换):
 *  - delta 是整体替换语义的交付物:组件每次收到新 delta 即整体重算,不做
 *    跨 delta 累积(客户端零本地推导);
 *  - 同地址被多个 dirtyRange 覆盖时,以数组顺序(地址升序承载序)靠后者为准;
 *  - 前值只在前快照的"已下发窗口"(区域起点前缀 bytesHex)内可判定,窗口外
 *    / 未知区域 / 未下发偏移的前值不可知,以 null 表达并在渲染层明示
 *    (I-9 同款纪律:不可知 ≠ 伪造值);
 *  - 前值与后值相同的字节不是"变化",不进变更列表(脏范围覆盖 = 有写入,
 *    不必然 = 内容变化)。
 */
import type { DirtyRange, VisibleMemoryRegion } from "@stackmaster/protocol";

import { addressToHex, normalizeBytesHex, parseAddressHex } from "../render/hex.js";

/** 单字节变更单元(computeByteDiff 输出)。 */
export interface ByteDiffUnit {
  /** 变更所属的可见区域(以 dirtyRange 声明为准,I-2 公开布局)。 */
  readonly regionId: string;
  /** 变更字节地址(0x 前缀小写,渲染层归一化形态)。 */
  readonly addressHex: string;
  /** 前值(小写十六进制字节);null = 前值不可知(窗口外 / 未知区域 / 未下发)。 */
  readonly beforeByteHex: string | null;
  /** 后值(小写十六进制字节,来源 = dirtyRange.bytesHex,D-P2)。 */
  readonly afterByteHex: string;
}

/**
 * 前快照的窗口字节查找表:regionId → 区域对象(含窗口坐标)。
 * 内部按 bigint 地址做偏移换算(区域起点锚定窗口,D3)。
 */
function buildBeforeIndex(beforeRegions: readonly VisibleMemoryRegion[]): Map<string, VisibleMemoryRegion> {
  const index = new Map<string, VisibleMemoryRegion>();
  for (const region of beforeRegions) {
    if (!index.has(region.regionId)) {
      index.set(region.regionId, region);
    }
  }
  return index;
}

/** 取地址在区域已下发窗口内的字节;窗口外返回 undefined(不可知)。 */
function beforeByteAt(region: VisibleMemoryRegion, address: bigint): string | undefined {
  const offset = address - parseAddressHex(region.startAddressHex);
  if (offset < 0n) {
    return undefined;
  }
  const byteIndex = Number(offset);
  if (byteIndex * 2 + 2 > region.bytesHex.length) {
    return undefined; // 越出已下发窗口前缀:前值不可知(不伪造)。
  }
  return region.bytesHex.slice(byteIndex * 2, byteIndex * 2 + 2).toLowerCase();
}

/**
 * computeByteDiff —— 动作前后字节变化对照(FE-ED-03 纯函数)。
 *
 * 归并规则:跨 dirtyRange 以 (regionId, 字节地址) 为键归并;同地址以数组序
 * 靠后为准;输出按地址数值升序排列(同地址同区域唯一)。`beforeRegions`
 * 缺省(如首个动作前无先前快照)时全部前值不可知(null)。
 */
export function computeByteDiff(
  beforeRegions: readonly VisibleMemoryRegion[] | undefined,
  dirtyRanges: readonly DirtyRange[],
): ByteDiffUnit[] {
  // (regionId, 地址) → 归并单元;Map 保插入序,输出前再按地址排序。
  const merged = new Map<string, ByteDiffUnit>();
  const beforeIndex = buildBeforeIndex(beforeRegions ?? []);
  for (const range of dirtyRanges) {
    const region = beforeIndex.get(range.regionId);
    const rangeStart = parseAddressHex(range.startAddressHex);
    // after 值统一小写(契约 bytesHex 大小写均可,渲染层归一化,渲染原语纪律)。
    const rangeBytesHex = normalizeBytesHex(range.bytesHex);
    for (let index = 0; index < rangeBytesHex.length / 2; index += 1) {
      const address = rangeStart + BigInt(index);
      const afterByteHex = rangeBytesHex.slice(index * 2, index * 2 + 2);
      const beforeByteHex =
        region === undefined ? null : (beforeByteAt(region, address) ?? null);
      // 前后相同 = 非可观察变化,不进变更列表(写入 ≠ 内容变化)。
      if (beforeByteHex !== null && beforeByteHex === afterByteHex) {
        merged.delete(`${range.regionId}@${address}`);
        continue;
      }
      merged.set(`${range.regionId}@${address}`, {
        regionId: range.regionId,
        addressHex: addressToHex(address),
        beforeByteHex,
        afterByteHex,
      });
    }
  }
  return [...merged.values()].sort((a, b) => {
    const delta = parseAddressHex(a.addressHex) - parseAddressHex(b.addressHex);
    if (delta < 0n) {
      return -1;
    }
    return delta > 0n ? 1 : 0;
  });
}

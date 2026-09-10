/**
 * 跳转链解析(WP-F4 / FE-ST-07 窗口内部分)——纯函数。
 *
 * 公开视图档口径:链 = "地址 → 该地址处 8 字节按端序解释的值 → 该值落回
 * 可见窗口则继续解引用";至多 `maxSegments` 段(横向上限 3,FE-ST-07)。
 * 全延伸(代码区伪汇编 FE-ST-08 等)归 WP-F8 调试档,不在本模块。
 *
 * **端序定案(本 WP 登记)**:公开投影不携带端序字段——公开描述包
 * `vmProfile.endianness` 已冻结为 "little",且 `MemoryDataSource` 接口无端序
 * 入参,故本模块一律按**小端**解释窗口字节(低地址字节为低位);协议未来
 * 若演进携带端序,在此处接入。
 *
 * 语义细则(与 datasource/types.ts 的 D3 窗口外语义一致,截断不报错):
 *  - 段地址的 8 字节必须**全部**落在某区域的已下发窗口(`windowByteLength`
 *    前缀)内才可解引用;任一字节缺失(未映射 / 超出前缀 / 跨窗口尾)→ 该段
 *    标记 `outsideWindow`(窗口外落点即截断);
 *  - `targetAddressHex` 存在 = 值落回某可见区域的**范围**(`byteLength`,
 *    字节视图可为该地址定位行;字节未必已下发)。落点超出已下发前缀时,由
 *    下一段的 `outsideWindow` 表达"落点不可见"——窗口外落点即截断;值未落在
 *    任何可见区域范围 → 仅记 valueHex 终止(教学语义:这不是指针);
 *  - 目标地址已在本链中出现过 → 该段标记 `loopBack`(回环箭头)并终止
 *    (循环检测,FE-ST-07"循环显示时箭头打回");
 *  - 输出地址恒 `0x` + 小写、值恒 `0x` + 大写无前导零(契约归一化形态)。
 *
 * 全部为纯函数:输入数据源快照切面,不持有状态、不做 IO。
 */
import type { AddrRange, MemoryDataSource, VmaEntry, VmaList } from "../../datasource/types.js";
import { addressToHex, parseAddressHex } from "../../render/hex.js";

/** 横向渲染的段数上限(FE-ST-07:跳转链最长显示三段)。 */
export const JUMP_CHAIN_HORIZONTAL_LIMIT = 3;

/** 展开视图(竖向完整链)的段数上限:防御病态长链;正常链先被回环 / 窗口截断。 */
export const JUMP_CHAIN_EXPANDED_LIMIT = 32;

/** 跳转链单段(FE-ST-07/09/10 窗口内部分的展示与点击依据)。 */
export interface JumpChainSegment {
  /** 本段地址(0x + 小写)。 */
  readonly addressHex: string;
  /** 该地址处 8 字节小端解释值(0x + 大写;`outsideWindow` 时缺席)。 */
  readonly valueHex?: string;
  /** 值落回可见窗口时的下一跳地址(0x + 小写;值落空 / 回环时另有标记)。 */
  readonly targetAddressHex?: string;
  /** 回环标记:目标地址已在本链中出现过(回环箭头,链在此终止)。 */
  readonly loopBack?: boolean;
  /** 窗口外标记:本段地址的 8 字节不在已下发窗口内(链在此截断)。 */
  readonly outsideWindow?: boolean;
}

/** 跳转链解析所需的数据源切面(`MemoryDataSource` 结构子集,便于测试桩)。 */
export type JumpChainDataSource = Pick<MemoryDataSource, "regions" | "bytesRows">;

/** 解析选项。 */
export interface JumpChainOptions {
  /** 段数上限(含首段)。默认 `JUMP_CHAIN_HORIZONTAL_LIMIT`(3)。 */
  readonly maxSegments?: number;
}

/**
 * 解析自 `startAddressHex` 起的跳转链(≤ `maxSegments` 段;端序 = 小端,
 * 见模块头注释)。起始地址非法时抛错(渲染层捕获为空链);窗口外落点
 * 一律以 `outsideWindow` 段表达,不抛错(D3)。
 */
export function resolveJumpChain(
  startAddressHex: string,
  dataSource: JumpChainDataSource,
  options: JumpChainOptions = {},
): JumpChainSegment[] {
  const maxSegments = options.maxSegments ?? JUMP_CHAIN_HORIZONTAL_LIMIT;
  if (!Number.isInteger(maxSegments) || maxSegments < 1) {
    throw new Error(`段数上限必须为正整数:${maxSegments}`);
  }
  const regions = dataSource.regions();
  const segments: JumpChainSegment[] = [];
  const current = parseAddressHex(startAddressHex);
  const visited = new Set<bigint>([current]);
  let cursor = current;
  while (segments.length < maxSegments) {
    const bytes = readWindowBytes(dataSource, cursor);
    if (bytes === null) {
      // 窗口外落点:该段地址不可解引用(未映射 / 超出已下发前缀),截断。
      segments.push({ addressHex: addressToHex(cursor), outsideWindow: true });
      return segments;
    }
    const value = littleEndianValue(bytes);
    const targetRegion = findOwningRegionExtent(value, regions);
    if (targetRegion === null) {
      // 值未落回任何可见区域:仅记值,链终止(教学语义:这不是指针)。
      segments.push({ addressHex: addressToHex(cursor), valueHex: formatValueHex(value) });
      return segments;
    }
    const common = {
      addressHex: addressToHex(cursor),
      valueHex: formatValueHex(value),
      targetAddressHex: addressToHex(value),
    };
    if (visited.has(value)) {
      // 循环检测:目标已在链中出现 → 回环标记并终止(箭头打回)。
      segments.push({ ...common, loopBack: true });
      return segments;
    }
    segments.push(common);
    cursor = value;
    visited.add(value);
  }
  return segments;
}

/**
 * 链是否因段数上限被截断(组件据此给出"展开完整链"入口):
 * 段数打满上限且末段仍有未回环的窗口内目标。
 */
export function chainLimitReached(
  segments: readonly JumpChainSegment[],
  maxSegments: number,
): boolean {
  if (segments.length !== maxSegments) {
    return false;
  }
  const last = segments.at(-1);
  return last !== undefined && last.targetAddressHex !== undefined && last.loopBack !== true;
}

/** 值 → 契约 valueHex 形态:`0x` + 大写、无前导零(0n → "0x0")。 */
function formatValueHex(value: bigint): string {
  return `0x${value.toString(16).toUpperCase()}`;
}

/**
 * 读取某地址处 8 字节(经 `bytesRows`,可能跨 8 字节行边界):8 字节全部
 * 落在已下发窗口内返回字节序列,否则 null(窗口外,不报错)。
 */
function readWindowBytes(dataSource: JumpChainDataSource, address: bigint): Uint8Array | null {
  const range: AddrRange = {
    startAddressHex: addressToHex(address),
    endAddressHex: addressToHex(address + 8n),
  };
  const bytes = new Uint8Array(8);
  let count = 0;
  for (const row of dataSource.bytesRows(range)) {
    for (const cell of row.cells) {
      if (count >= 8) {
        return null; // 防御:数据源契约保证每字节一 cell,越界即视作窗口外。
      }
      if (cell.byte === null) {
        return null;
      }
      bytes[count] = cell.byte;
      count += 1;
    }
  }
  return count === 8 ? bytes : null;
}

/** 小端解释:低地址字节为低位(端序定案见模块头注释)。 */
function littleEndianValue(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index] ?? 0);
  }
  return value;
}

/** 值 → 所属可见区域的范围(`byteLength`)内区域;无则 null(落点未映射)。 */
function findOwningRegionExtent(value: bigint, regions: VmaList): VmaEntry | null {
  for (const region of regions) {
    const base = parseAddressHex(region.startAddressHex);
    if (value >= base && value < base + BigInt(region.byteLength)) {
      return region;
    }
  }
  return null;
}

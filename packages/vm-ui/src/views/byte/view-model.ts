/**
 * 字节视图视图模型纯函数(WP-F3):默认区域选取、rsp/rbp 视角锚点(FE-ST-04
 * 公开档口径)、跳转输入解析(窗口内导航,M3 口径)。
 *
 * 定案规则(同时登记 README):
 *  - **默认区域**:含 rsp 值的区域(rsp 值 ∈ [区域起点, 区域起点 + 区域长)),
 *    否则第一个区域(投影 visibleRegions 序);无区域 → null。栈视图与自由
 *    视图共用同一规则(自由视图 = 同组件默认形态,FE-FV-01/02);
 *  - **锚点**:rsp/rbp 值落在当前区域**已下发窗口** [起点, 起点 + windowByteLength)
 *    内 → 命中行 + 可「回锚」;值在窗口外(含区域内但窗口前缀之外——D3)→
 *    明示「不在可见窗口」,不渲染空白、不报错(M13 口径);寄存器未公开 →
 *    不呈现锚点。
 *
 * 全部为纯函数:输入 = MemoryDataSource 快照读返回值,不做任何 IO。
 */
import type { ByteRowSpan } from "./alignment.js";
import { addressToHex, parseAddressHex } from "../../render/hex.js";
import type { AddrRange, RegisterRow, VmaEntry, VmaList } from "../../datasource/types.js";

/** 视角锚点寄存器名(匹配大小写不敏感:RSP / rsp 均可)。 */
export const ANCHOR_REGISTERS = ["rsp", "rbp"] as const;
export type AnchorRegister = (typeof ANCHOR_REGISTERS)[number];

/** 单个锚点的解析结果。 */
export interface AnchorState {
  readonly register: AnchorRegister;
  /** 寄存器值(0x 前缀;调用方保证已归一化形态)。 */
  readonly valueHex: string;
  /** in-window = 命中窗口内 rowIndex 行;outside-window = M13 明示口径。 */
  readonly placement: "in-window" | "outside-window";
  /** 命中行索引(仅 in-window;否则 null)。 */
  readonly rowIndex: number | null;
}

/** 寄存器值查找(名称大小写不敏感;未公开返回 null)。 */
export function findRegisterValueHex(registers: readonly RegisterRow[], name: string): string | null {
  const lowered = name.toLowerCase();
  const found = registers.find((register) => register.name.toLowerCase() === lowered);
  return found === undefined ? null : found.valueHex;
}

/**
 * 默认区域选取:含 rsp 值的区域(按区域全长 [起点, 起点+byteLength) 判定),
 * 否则第一个区域;无区域返回 null(规则注释见文件头与 README)。
 */
export function pickDefaultRegion(regions: VmaList, registers: readonly RegisterRow[]): VmaEntry | null {
  const first = regions[0];
  if (first === undefined) {
    return null;
  }
  const rspHex = findRegisterValueHex(registers, "rsp");
  if (rspHex === null) {
    return first;
  }
  const rsp = parseAddressHex(rspHex);
  const containing = regions.find((region) => {
    const base = parseAddressHex(region.startAddressHex);
    return rsp >= base && rsp < base + BigInt(region.byteLength);
  });
  return containing ?? first;
}

/**
 * 锚点解析(单寄存器):寄存器未公开 → null;值落在窗口 [start, end) 内 →
 * 命中 spans 中的行(in-window + rowIndex);否则 outside-window(M13)。
 */
export function resolveAnchor(
  registers: readonly RegisterRow[],
  register: AnchorRegister,
  windowRange: AddrRange,
  spans: readonly ByteRowSpan[],
): AnchorState | null {
  const valueHex = findRegisterValueHex(registers, register);
  if (valueHex === null) {
    return null;
  }
  const value = parseAddressHex(valueHex);
  const start = parseAddressHex(windowRange.startAddressHex);
  const end = parseAddressHex(windowRange.endAddressHex);
  if (value < start || value >= end) {
    return { register, valueHex, placement: "outside-window", rowIndex: null };
  }
  return { register, valueHex, placement: "in-window", rowIndex: rowIndexForAddress(spans, valueHex) };
}

/** 地址 → 行索引(线性扫描;窗口 ≤ 513 行)。未命中返回 null。 */
export function rowIndexForAddress(spans: readonly ByteRowSpan[], addressHex: string): number | null {
  const address = parseAddressHex(addressHex);
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index] as ByteRowSpan;
    const base = parseAddressHex(span.addressHex);
    if (address >= base && address < base + BigInt(span.byteLength)) {
      return index;
    }
  }
  return null;
}

/** 跳转输入解析结果。 */
export type JumpResolution =
  | { readonly status: "in-window"; readonly addressHex: string }
  | { readonly status: "outside-window"; readonly addressHex: string }
  | { readonly status: "invalid" };

/**
 * 跳转输入解析(窗口内导航,M3 口径:仅窗口内可达):
 *  - `0x` 前缀十六进制 = 绝对地址;
 *  - 纯十进制数字 = 窗口内字节偏移(自窗口起点);
 *  - 其余(含非法十六进制)= invalid。
 * 窗口外输入返回 outside-window(视图给「窗口外」反馈,不报错)。
 */
export function parseJumpInput(
  raw: string,
  windowRange: AddrRange,
): JumpResolution {
  const input = raw.trim();
  if (input.length === 0) {
    return { status: "invalid" };
  }
  let address: bigint;
  if (/^0[xX][0-9a-fA-F]+$/.test(input)) {
    try {
      address = parseAddressHex(input);
    } catch {
      // 超宽(>16 位)十六进制等非法形态 → invalid 反馈,不抛错。
      return { status: "invalid" };
    }
  } else if (/^\d+$/.test(input)) {
    address = parseAddressHex(windowRange.startAddressHex) + BigInt(input);
  } else {
    return { status: "invalid" };
  }
  const start = parseAddressHex(windowRange.startAddressHex);
  const end = parseAddressHex(windowRange.endAddressHex);
  const addressHex = addressToHex(address);
  return address >= start && address < end
    ? { status: "in-window", addressHex }
    : { status: "outside-window", addressHex };
}

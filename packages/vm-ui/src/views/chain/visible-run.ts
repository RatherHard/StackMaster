/**
 * 可见字符延伸渲染(WP-F4 / FE-ST-10 窗口内部分)——纯函数 + Lit 渲染辅助。
 *
 * 口径:
 *  - 可见字符 = 可见 ASCII 0x20–0x7E(与 render/special-display.ts 的可见
 *    ASCII 口径一致,字符生成复用 `specialDisplayChar`);
 *  - 行内判定(`visibleRunOfRow`):**全部** cell 均为窗口内可见字符才产出
 *    字符串,否则 null(交回调用方的常规特殊显示渲染);
 *  - 链末延伸(`visibleRunAt`):自某地址起读连续可见字符,遇不可见字节、
 *    窗口外字节或字节上限即止——空串表示"无可见字符延伸"(不占位、不报错,
 *    D3 窗口外语义);
 *  - 供字节视图(F5 集成)右段与寄存器特殊显示消费;任意长度全量字符串
 *    延伸归 WP-F8 调试档。
 */
import { html, type TemplateResult } from "lit";
import type { AddrRange, ByteCell, MemoryDataSource } from "../../datasource/types.js";
import { addressToHex, parseAddressHex } from "../../render/hex.js";
import { specialDisplayChar } from "../../render/special-display.js";

/** 链末可见字符延伸的单次读取字节上限(教学展示足够;防病态长串)。 */
export const VISIBLE_RUN_MAX_BYTES = 32;

/** 可见字符延伸读取所需的数据源切面(`MemoryDataSource` 结构子集)。 */
export type VisibleRunDataSource = Pick<MemoryDataSource, "bytesRows">;

/** 可见 ASCII 口径(0x20–0x7E,与 render/special-display.ts 一致)。 */
function isVisibleByte(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e;
}

/**
 * 行内可见字符判定(FE-ST-10 第一句):全部 cell 均为窗口内可见字符时返回
 * 对应字符串;含不可见字节 / 窗口外 cell / 空 cell 序列 → null。
 */
export function visibleRunOfRow(cells: readonly ByteCell[]): string | null {
  if (cells.length === 0) {
    return null;
  }
  let text = "";
  for (const cell of cells) {
    const byte = cell.byte;
    if (byte === null || !isVisibleByte(byte)) {
      return null;
    }
    text += specialDisplayChar(byte);
  }
  return text;
}

/**
 * 链末可见字符延伸(FE-ST-10 第二句):自 `startAddressHex` 起读取连续可见
 * ASCII 字符,至多 `maxBytes` 字节;遇不可见字节 / 窗口外字节即止。
 * 首字节不可见或地址不可读 → 空串。
 */
export function visibleRunAt(
  dataSource: VisibleRunDataSource,
  startAddressHex: string,
  maxBytes: number = VISIBLE_RUN_MAX_BYTES,
): string {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`可见字符延伸读取字节数必须为正整数:${maxBytes}`);
  }
  const start = parseAddressHex(startAddressHex);
  const range: AddrRange = {
    startAddressHex: addressToHex(start),
    endAddressHex: addressToHex(start + BigInt(maxBytes)),
  };
  let text = "";
  for (const row of dataSource.bytesRows(range)) {
    for (const cell of row.cells) {
      const byte = cell.byte;
      if (byte === null || !isVisibleByte(byte)) {
        return text;
      }
      text += specialDisplayChar(byte);
    }
  }
  return text;
}

/**
 * Lit 渲染辅助:可见字符延伸段(引号包裹 + 语义类名,便于字节视图右段 /
 * 链末与普通十六进制形态区分;文本经 Lit 转义,无需额外处理)。
 */
export function renderVisibleRun(text: string): TemplateResult {
  return html`<span class="visible-run" data-visible-run>"${text}"</span>`;
}

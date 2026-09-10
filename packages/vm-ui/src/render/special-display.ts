/**
 * 特殊显示单元格渲染原语(WP-F2 共享渲染层;WP-F3/F4 并行消费)。
 *
 * 8 字节行第三段(特殊显示列)的逐字节展示规则:
 *  - 可见 ASCII(0x20–0x7E)原样展示;
 *  - 不可见字节以统一占位符展示(不用会与真实字节混淆的 "." 占位);
 *  - 字节值 → 语义标注(纯函数),视图按语义类名着色(教学反馈:
 *    null 字节 / 空白 / 控制字符 / 高位字节)。
 *
 * 动画纪律(CLAUDE.md 第十章):本原语不产生动画;样式由视图主题提供。
 */
import { html, type TemplateResult } from "lit";

/** 不可见字节的统一占位符(U+00B7 MIDDLE DOT;区别于真实 "." 字节 0x2E)。 */
export const SPECIAL_DISPLAY_PLACEHOLDER = "\u00B7";

/** 字节值语义标注(视图按 `cell-<semantic>` 类名着色)。 */
export type SpecialDisplaySemantic =
  | "ascii"
  | "null-byte"
  | "whitespace"
  | "control"
  | "high-byte";

/** 单字节的特殊显示字符:可见 ASCII 原样,其余占位符。 */
export function specialDisplayChar(byte: number): string {
  if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
    throw new Error(`非法字节值:${byte}`);
  }
  return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : SPECIAL_DISPLAY_PLACEHOLDER;
}

/** 字节值 → 语义标注(纯函数;FE-ST-07 可见字符渲染的着色依据)。 */
export function specialDisplaySemantic(byte: number): SpecialDisplaySemantic {
  if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
    throw new Error(`非法字节值:${byte}`);
  }
  if (byte === 0x00) return "null-byte";
  if (byte >= 0x20 && byte <= 0x7e) return byte === 0x20 ? "whitespace" : "ascii";
  // 常见空白控制字符(\t \n \r)单列,其余 <0x20 与 0x7F–0x9F 为控制字符。
  if (byte === 0x09 || byte === 0x0a || byte === 0x0d) return "whitespace";
  if (byte <= 0x9f) return "control";
  return "high-byte";
}

/**
 * Lit 渲染辅助:单字节的特殊显示单元格。
 *  - `byte` 为 null(窗口外)→ 统一占位 cell(`cell-outside`,D3 窗口外标记);
 *  - 否则 → 特殊显示字符 + 语义类名 + `data-byte`(2 位小写十六进制,便于
 *    视图层 / 测试按字节定位)。
 */
export function renderSpecialDisplayCell(byte: number | null): TemplateResult {
  if (byte === null) {
    return html`<span class="cell-special cell-outside" data-outside>
      ${SPECIAL_DISPLAY_PLACEHOLDER}</span>`;
  }
  const semantic = specialDisplaySemantic(byte);
  return html`<span
    class="cell-special cell-${semantic}"
    data-byte="${byte.toString(16).padStart(2, "0")}"
  >
    ${specialDisplayChar(byte)}</span>`;
}

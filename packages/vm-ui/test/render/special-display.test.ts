/**
 * render/special-display 特殊显示原语测试(WP-F2):可见 ASCII 原样、不可见
 * 占位、字节值→语义标注、Lit 渲染辅助输出。
 */
import { describe, expect, it } from "vitest";
import { render } from "lit";
import { html } from "lit";

import {
  SPECIAL_DISPLAY_PLACEHOLDER,
  renderSpecialDisplayCell,
  specialDisplayChar,
  specialDisplaySemantic,
} from "../../src/render/special-display.js";

describe("特殊显示字符", () => {
  it("可见 ASCII(0x20–0x7E)原样展示", () => {
    expect(specialDisplayChar(0x41)).toBe("A");
    expect(specialDisplayChar(0x2e)).toBe(".");
    expect(specialDisplayChar(0x20)).toBe(" ");
    expect(specialDisplayChar(0x7e)).toBe("~");
  });

  it("不可见字节以统一占位符展示(区别于真实 '.' 字节)", () => {
    expect(SPECIAL_DISPLAY_PLACEHOLDER).not.toBe(".");
    expect(specialDisplayChar(0x00)).toBe(SPECIAL_DISPLAY_PLACEHOLDER);
    expect(specialDisplayChar(0x0a)).toBe(SPECIAL_DISPLAY_PLACEHOLDER);
    expect(specialDisplayChar(0x7f)).toBe(SPECIAL_DISPLAY_PLACEHOLDER);
    expect(specialDisplayChar(0xff)).toBe(SPECIAL_DISPLAY_PLACEHOLDER);
  });

  it("非字节值抛错", () => {
    expect(() => specialDisplayChar(256)).toThrow();
    expect(() => specialDisplayChar(-1)).toThrow();
    expect(() => specialDisplayChar(1.5)).toThrow();
  });
});

describe("字节值 → 语义标注", () => {
  it("null 字节 / 空白 / 可见 ASCII / 控制字符 / 高位字节分类", () => {
    expect(specialDisplaySemantic(0x00)).toBe("null-byte");
    expect(specialDisplaySemantic(0x20)).toBe("whitespace");
    expect(specialDisplaySemantic(0x09)).toBe("whitespace"); // \t
    expect(specialDisplaySemantic(0x0a)).toBe("whitespace"); // \n
    expect(specialDisplaySemantic(0x0d)).toBe("whitespace"); // \r
    expect(specialDisplaySemantic(0x41)).toBe("ascii");
    expect(specialDisplaySemantic(0x1b)).toBe("control"); // ESC
    expect(specialDisplaySemantic(0x7f)).toBe("control"); // DEL
    expect(specialDisplaySemantic(0x9f)).toBe("control");
    expect(specialDisplaySemantic(0xa0)).toBe("high-byte");
    expect(specialDisplaySemantic(0xff)).toBe("high-byte");
    expect(() => specialDisplaySemantic(0x100)).toThrow();
  });
});

describe("Lit 渲染辅助(renderSpecialDisplayCell)", () => {
  function renderToHtml(byte: number | null): string {
    const container = document.createElement("div");
    render(html`${renderSpecialDisplayCell(byte)}`, container);
    return container.innerHTML;
  }

  it("窗口内字节:特殊显示字符 + 语义类名 + data-byte 标注", () => {
    const markup = renderToHtml(0x41);
    expect(markup).toContain("cell-special");
    expect(markup).toContain("cell-ascii");
    expect(markup).toContain('data-byte="41"');
    expect(markup).toContain("A");
  });

  it("不可见字节渲染占位符与对应语义类名", () => {
    expect(renderToHtml(0x00)).toContain("cell-null-byte");
    expect(renderToHtml(0x0a)).toContain("cell-whitespace");
    expect(renderToHtml(0x1b)).toContain("cell-control");
    expect(renderToHtml(0xfe)).toContain("cell-high-byte");
  });

  it("窗口外(null)渲染统一占位 cell(D3 窗口外标记)", () => {
    const markup = renderToHtml(null);
    expect(markup).toContain("cell-outside");
    expect(markup).toContain("data-outside");
    expect(markup).toContain(SPECIAL_DISPLAY_PLACEHOLDER);
  });
});

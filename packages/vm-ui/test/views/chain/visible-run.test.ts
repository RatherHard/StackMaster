/**
 * 可见字符延伸渲染测试(WP-F4 / FE-ST-10 窗口内部分):行内全可见字符判定、
 * 链末可见字符延伸读取、Lit 渲染辅助。
 */
import { describe, expect, it } from "vitest";
import { render } from "lit";
import { html } from "lit";

import type { ByteCell } from "../../../src/datasource/types.js";
import {
  VISIBLE_RUN_MAX_BYTES,
  renderVisibleRun,
  visibleRunAt,
  visibleRunOfRow,
} from "../../../src/views/chain/visible-run.js";
import { ProjectionStore } from "../../../src/client/projection-store.js";
import { ProjectionDataSource } from "../../../src/datasource/projection-data-source.js";
import type { PublicStateProjection } from "@stackmaster/protocol";

/** 单字节 cell 快捷构造。 */
function cell(byte: number | null): ByteCell {
  return {
    addressHex: "0x1000",
    regionId: byte === null ? null : "region-x",
    offset: byte === null ? null : 0,
    byteHex: byte === null ? null : byte.toString(16).padStart(2, "0"),
    byte,
  };
}

describe("visibleRunOfRow(行内全可见字符 → 字符串)", () => {
  it("8 字节全为可见 ASCII 时返回对应字符串", () => {
    const text = "ABCDEFGH";
    const cells = [...text].map((ch) => cell(ch.charCodeAt(0)));
    expect(visibleRunOfRow(cells)).toBe("ABCDEFGH");
  });

  it("含不可见字节(0x00 / 控制字符 / 高位字节)→ null", () => {
    expect(visibleRunOfRow([cell(0x41), cell(0x00)])).toBeNull();
    expect(visibleRunOfRow([cell(0x41), cell(0x0a)])).toBeNull();
    expect(visibleRunOfRow([cell(0x41), cell(0xff)])).toBeNull();
  });

  it("含窗口外 cell(byte = null)→ null(D3 窗口外语义)", () => {
    expect(visibleRunOfRow([cell(0x41), cell(null)])).toBeNull();
  });

  it("空 cell 序列 → null(无内容可判定)", () => {
    expect(visibleRunOfRow([])).toBeNull();
  });

  it("空格与打印边界字符(0x20 / 0x7E)按可见口径参与", () => {
    expect(visibleRunOfRow([cell(0x20), cell(0x7e)])).toBe(" ~");
  });
});

describe("visibleRunAt(链末可见字符延伸读取)", () => {
  function dataSourceWithWindow(bytesHex: string): ProjectionDataSource {
    const projection: PublicStateProjection = {
      revision: 0,
      visibleRegions: [
        {
          regionId: "region-str",
          label: "str",
          startAddressHex: "0x1000",
          byteLength: 4096,
          permissions: "rw",
          bytesHex,
          truncated: bytesHex.length / 2 < 4096,
        },
      ],
      visibleRegisters: [],
      callStackSummary: [],
      controlFlow: {
        currentInstruction: { addressHex: "0x0040", text: "push rbp" },
        pausedOn: null,
      },
      semanticHighlights: [],
      status: "paused",
    };
    const store = new ProjectionStore();
    store.replaceProjection(projection);
    return new ProjectionDataSource(store);
  }

  it("从起始地址读连续可见 ASCII,遇 0x00 即止", () => {
    // "Hello\0World":0x00 终止,不跨过。
    const dataSource = dataSourceWithWindow("48656c6c6f00576f726c64");
    expect(visibleRunAt(dataSource, "0x1000")).toBe("Hello");
  });

  it("链末地址指向可见字符时从该地址起读(FE-ST-10 链末延伸)", () => {
    // 偏移 0..7 为 "ABCDEFGH",0x1008 起 = "PQRST\0"。
    const dataSource = dataSourceWithWindow("4142434445464748505152535400");
    expect(visibleRunAt(dataSource, "0x1008")).toBe("PQRST");
  });

  it("首字节即不可见 / 窗口外 → 空串(不占位不报错)", () => {
    expect(visibleRunAt(dataSourceWithWindow("004142"), "0x1000")).toBe("");
    // 起始地址在区域范围但窗口(4 字节)外。
    expect(visibleRunAt(dataSourceWithWindow("41424344"), "0x1010")).toBe("");
    // 未映射地址。
    expect(visibleRunAt(dataSourceWithWindow("41424344"), "0x9000")).toBe("");
  });

  it("读取至多 maxBytes 字节(默认上限常量;显式更小上限生效)", () => {
    const sixteenVisible = "4142434445464748494a4b4c4d4e4f50"; // 16 字节可见
    const dataSource = dataSourceWithWindow(sixteenVisible);
    expect(VISIBLE_RUN_MAX_BYTES).toBe(32);
    // 窗口仅 16 字节:16 个可见字符全取(不越过窗口)。
    expect(visibleRunAt(dataSource, "0x1000")).toBe("ABCDEFGHIJKLMNOP");
    // 显式 maxBytes = 4:截断到 4 字符。
    expect(visibleRunAt(dataSource, "0x1000", 4)).toBe("ABCD");
  });

  it("非法 maxBytes 抛错", () => {
    const dataSource = dataSourceWithWindow("4142");
    expect(() => visibleRunAt(dataSource, "0x1000", 0)).toThrow();
    expect(() => visibleRunAt(dataSource, "0x1000", 1.5)).toThrow();
  });
});

describe("renderVisibleRun(Lit 渲染辅助)", () => {
  it("渲染带引号的可见字符段与语义类名(供字节视图右段 / 链末消费)", () => {
    const container = document.createElement("div");
    render(html`${renderVisibleRun("Hello")}`, container);
    const span = container.querySelector("span.visible-run");
    expect(span).not.toBeNull();
    expect(span?.hasAttribute("data-visible-run")).toBe(true);
    expect(span?.textContent).toBe('"Hello"');
  });
});

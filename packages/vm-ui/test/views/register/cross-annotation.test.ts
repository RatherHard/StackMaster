/**
 * 寄存器 × 区域交叉标注测试(WP-F4 / FE-RG-04):命中 / 不命中 / 窗口外缺席、
 * 多寄存器同区域、valueHex 大写归一化、Lit 左缘标注单元格渲染辅助。
 */
import { describe, expect, it } from "vitest";
import { render } from "lit";
import { html } from "lit";

import type { RegisterRow, VmaList } from "../../../src/datasource/types.js";
import {
  crossAnnotateRegisters,
  renderRegisterAnnotationCell,
} from "../../../src/views/register/cross-annotation.js";

/** 夹具区域:region-stack @0x1000(区域 4096 字节,已下发窗口 16 字节)。 */
const REGIONS: VmaList = [
  {
    regionId: "region-stack",
    label: "stack",
    startAddressHex: "0x1000",
    byteLength: 4096,
    permissions: "rw",
    windowByteLength: 16,
    truncated: true,
  },
];

function row(name: string, valueHex: string): RegisterRow {
  return { name, valueHex };
}

describe("crossAnnotateRegisters(值命中行集合)", () => {
  it("值命中已下发窗口 → 输出寄存器名 / 归一化值 / 命中地址 / 区域 id / 偏移", () => {
    expect(crossAnnotateRegisters([row("RSP", "0x1004")], REGIONS)).toEqual([
      {
        registerName: "RSP",
        valueHex: "0x1004",
        targetAddressHex: "0x1004",
        regionId: "region-stack",
        offset: 4,
      },
    ]);
  });

  it("值形态漂移(小写)时输出 valueHex 恒 0x + 大写(渲染层归一化兜底)", () => {
    // 值 0x12ab 落在窗口(0x1000..0x2000)内,小写输入 → 输出大写归一化。
    const hits = crossAnnotateRegisters([row("RAX", "0x12ab")], [
      { ...REGIONS[0]!, windowByteLength: 4096 },
    ]);
    expect(hits[0]?.valueHex).toBe("0x12AB");
    expect(hits[0]?.targetAddressHex).toBe("0x12ab"); // 地址展示面恒小写
    expect(hits[0]?.offset).toBe(0x2ab);
  });

  it("值未落在任何可见区域(未映射)→ 标注缺席", () => {
    expect(crossAnnotateRegisters([row("RSP", "0x9000")], REGIONS)).toEqual([]);
  });

  it("值落在区域范围但超出已下发窗口(窗口外)→ 标注缺席且不报错", () => {
    // 0x1100 在 region-stack(4096 字节)范围内,但窗口仅下发前 16 字节。
    expect(crossAnnotateRegisters([row("RSP", "0x1100")], REGIONS)).toEqual([]);
  });

  it("窗口边界:值恰在窗口起点命中;恰在窗口终点外缺席", () => {
    expect(crossAnnotateRegisters([row("R0", "0x1000")], REGIONS)).toHaveLength(1);
    expect(crossAnnotateRegisters([row("R1", "0x1010")], REGIONS)).toEqual([]);
  });

  it("多寄存器同区域:全部产出且保持输入顺序,偏移各自独立", () => {
    const hits = crossAnnotateRegisters(
      [row("RSP", "0x1000"), row("RBP", "0x1008"), row("RAX", "0x9000")],
      REGIONS,
    );
    expect(hits).toEqual([
      {
        registerName: "RSP",
        valueHex: "0x1000",
        targetAddressHex: "0x1000",
        regionId: "region-stack",
        offset: 0,
      },
      {
        registerName: "RBP",
        valueHex: "0x1008",
        targetAddressHex: "0x1008",
        regionId: "region-stack",
        offset: 8,
      },
    ]);
  });

  it("跨区域:值命中第二个可见区域窗口时按区域归属产出", () => {
    const regions: VmaList = [
      ...REGIONS,
      {
        regionId: "region-heap",
        label: "heap",
        startAddressHex: "0x2000",
        byteLength: 256,
        permissions: "rw",
        windowByteLength: 8,
        truncated: true,
      },
    ];
    expect(crossAnnotateRegisters([row("RDI", "0x2004")], regions)).toEqual([
      {
        registerName: "RDI",
        valueHex: "0x2004",
        targetAddressHex: "0x2004",
        regionId: "region-heap",
        offset: 4,
      },
    ]);
  });

  it("空寄存器 / 空区域 → 空集合", () => {
    expect(crossAnnotateRegisters([], REGIONS)).toEqual([]);
    expect(crossAnnotateRegisters([row("RSP", "0x1000")], [])).toEqual([]);
  });
});

describe("renderRegisterAnnotationCell(字节视图行左缘标注单元格,FE-RG-04)", () => {
  it("命中行渲染寄存器名按钮:data-registers + 值详情(title / aria-label)", () => {
    const hits = crossAnnotateRegisters([row("RSP", "0x1004"), row("RBP", "0x1008")], REGIONS);
    const container = document.createElement("div");
    render(html`${renderRegisterAnnotationCell(hits)}`, container);
    const button = container.querySelector("button.reg-annotation");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("type")).toBe("button");
    expect(button?.getAttribute("data-registers")).toBe("RSP,RBP");
    expect(button?.textContent).toBe("RSP,RBP");
    expect(button?.getAttribute("title")).toBe("RSP=0x1004 RBP=0x1008");
    expect(button?.getAttribute("aria-label")).toContain("RSP=0x1004");
  });

  it("无命中 → 不渲染任何节点(标注缺席)", () => {
    const container = document.createElement("div");
    render(html`${renderRegisterAnnotationCell([])}`, container);
    expect(container.querySelector("button.reg-annotation")).toBeNull();
    expect(container.childElementCount).toBe(0);
  });
});

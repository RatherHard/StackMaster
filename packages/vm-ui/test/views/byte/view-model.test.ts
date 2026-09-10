/**
 * views/byte/view-model 纯函数测试(WP-F3):默认区域选取规则、rsp/rbp
 * 视角锚点(FE-ST-04 公开档 + M13)、跳转输入解析(M3 窗口内导航)。
 */
import { describe, expect, it } from "vitest";

import {
  findRegisterValueHex,
  parseJumpInput,
  pickDefaultRegion,
  resolveAnchor,
  rowIndexForAddress,
} from "../../../src/views/byte/view-model.js";
import { offsetGridRowSpans } from "../../../src/views/byte/alignment.js";
import type { AddrRange, RegisterRow, VmaEntry } from "../../../src/datasource/types.js";

function makeRegion(
  regionId: string,
  startAddressHex: string,
  byteLength: number,
  overrides: Partial<VmaEntry> = {},
): VmaEntry {
  return {
    regionId,
    label: regionId,
    startAddressHex,
    byteLength,
    permissions: "rw",
    windowByteLength: Math.min(byteLength, 256),
    truncated: byteLength > 256,
    ...overrides,
  };
}

describe("pickDefaultRegion 默认区域选取", () => {
  const regions = [makeRegion("region-code", "0x4000", 256), makeRegion("region-stack", "0x1000", 4096)];

  it("rsp 值落在某区域内 → 选取该区域", () => {
    const registers: RegisterRow[] = [{ name: "RSP", valueHex: "0x1FF0" }];
    // 0x1ff0 在 region-stack(0x1000..0x2000)内 → 即便它排第二也选中。
    expect(pickDefaultRegion(regions, registers)?.regionId).toBe("region-stack");
  });

  it("rsp 值不在任何区域 → 第一个区域(投影公开布局序)", () => {
    const registers: RegisterRow[] = [{ name: "RSP", valueHex: "0x9000" }];
    expect(pickDefaultRegion(regions, registers)?.regionId).toBe("region-code");
  });

  it("寄存器名大小写不敏感(rsp 亦可匹配)", () => {
    const registers: RegisterRow[] = [{ name: "rsp", valueHex: "0x1004" }];
    expect(pickDefaultRegion(regions, registers)?.regionId).toBe("region-stack");
  });

  it("rsp 未公开 → 第一个区域", () => {
    const registers: RegisterRow[] = [{ name: "RBP", valueHex: "0x1008" }];
    expect(pickDefaultRegion(regions, registers)?.regionId).toBe("region-code");
  });

  it("无区域 → null", () => {
    expect(pickDefaultRegion([], [{ name: "RSP", valueHex: "0x1000" }])).toBeNull();
  });
});

describe("findRegisterValueHex 寄存器查找", () => {
  it("按名称大小写不敏感匹配,未公开返回 null", () => {
    const registers: RegisterRow[] = [{ name: "RSP", valueHex: "0x1004" }];
    expect(findRegisterValueHex(registers, "rsp")).toBe("0x1004");
    expect(findRegisterValueHex(registers, "RSP")).toBe("0x1004");
    expect(findRegisterValueHex(registers, "rdi")).toBeNull();
  });
});

describe("resolveAnchor rsp/rbp 视角锚点", () => {
  const registers: RegisterRow[] = [
    { name: "RSP", valueHex: "0x1004" },
    { name: "RBP", valueHex: "0x1100" },
  ];
  const windowRange: AddrRange = { startAddressHex: "0x1000", endAddressHex: "0x1010" };
  const spans = offsetGridRowSpans("0x1000", "0x1010", 0);

  it("值在窗口内 → 命中行(in-window + 行索引)", () => {
    expect(resolveAnchor(registers, "rsp", windowRange, spans)).toEqual({
      register: "rsp",
      valueHex: "0x1004",
      placement: "in-window",
      rowIndex: 0,
    });
  });

  it("值在区域内但窗口前缀之外 → 窗口外(D3 前缀语义)", () => {
    // RBP = 0x1100 落在区域(0x1000..0x2000)内,但窗口仅 [0x1000, 0x1010)。
    expect(resolveAnchor(registers, "rbp", windowRange, spans)).toEqual({
      register: "rbp",
      valueHex: "0x1100",
      placement: "outside-window",
      rowIndex: null,
    });
  });

  it("值在窗口之下边界外 → 窗口外", () => {
    const below: RegisterRow[] = [{ name: "RSP", valueHex: "0x0fff" }];
    expect(resolveAnchor(below, "rsp", windowRange, spans)?.placement).toBe("outside-window");
  });

  it("值恰为窗口终点(开区间)→ 窗口外", () => {
    const atEnd: RegisterRow[] = [{ name: "RSP", valueHex: "0x1010" }];
    expect(resolveAnchor(atEnd, "rsp", windowRange, spans)?.placement).toBe("outside-window");
  });

  it("寄存器未公开 → null(不呈现锚点)", () => {
    expect(resolveAnchor([], "rsp", windowRange, spans)).toBeNull();
  });
});

describe("rowIndexForAddress 地址 → 行索引", () => {
  const spans = offsetGridRowSpans("0x1000", "0x1010", 0);

  it("命中行返回索引,行外返回 null", () => {
    expect(rowIndexForAddress(spans, "0x1000")).toBe(0);
    expect(rowIndexForAddress(spans, "0x1007")).toBe(0);
    expect(rowIndexForAddress(spans, "0x1008")).toBe(1);
    expect(rowIndexForAddress(spans, "0x0fff")).toBeNull();
    expect(rowIndexForAddress(spans, "0x1010")).toBeNull();
  });
});

describe("parseJumpInput 跳转输入解析(仅窗口内可达)", () => {
  const windowRange: AddrRange = { startAddressHex: "0x1000", endAddressHex: "0x1010" };

  it("0x 十六进制绝对地址 → 窗口内", () => {
    expect(parseJumpInput("0x1004", windowRange)).toEqual({ status: "in-window", addressHex: "0x1004" });
    expect(parseJumpInput("0x100F", windowRange)).toEqual({ status: "in-window", addressHex: "0x100f" });
  });

  it("十进制数字 → 窗口内字节偏移(自窗口起点)", () => {
    expect(parseJumpInput("0", windowRange)).toEqual({ status: "in-window", addressHex: "0x1000" });
    expect(parseJumpInput("8", windowRange)).toEqual({ status: "in-window", addressHex: "0x1008" });
    expect(parseJumpInput("15", windowRange)).toEqual({ status: "in-window", addressHex: "0x100f" });
  });

  it("窗口外输入 → outside-window(反馈口径,不报错)", () => {
    expect(parseJumpInput("0x9000", windowRange)).toEqual({ status: "outside-window", addressHex: "0x9000" });
    // 偏移 16 = 窗口终点(开区间)→ 窗口外。
    expect(parseJumpInput("16", windowRange)).toEqual({ status: "outside-window", addressHex: "0x1010" });
    expect(parseJumpInput("0xfff", windowRange)).toEqual({ status: "outside-window", addressHex: "0xfff" });
  });

  it("无法识别输入 → invalid", () => {
    expect(parseJumpInput("", windowRange).status).toBe("invalid");
    expect(parseJumpInput("zz", windowRange).status).toBe("invalid");
    expect(parseJumpInput("-4", windowRange).status).toBe("invalid");
    expect(parseJumpInput("0xzz", windowRange).status).toBe("invalid");
    // 超过 16 位十六进制的地址形态 → invalid(不抛错)。
    expect(parseJumpInput("0x12345678901234567890", windowRange).status).toBe("invalid");
  });
});

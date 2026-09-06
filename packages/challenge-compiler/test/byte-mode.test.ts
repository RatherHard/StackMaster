// 字节模式测试(WP-2):入口探测译码产物、操作数内联自证(archBits/8 小端)、
// token 流生成(标签编译期消解为内联地址)与生成面红灯样例。
import { describe, expect, it } from "vitest";

import {
  compileByteProgram,
  compileProgram,
  decodeByteProgram,
  loadChallengePair,
  type AuthorProgram,
} from "../src/index.js";
import type { PublicChallengeDescriptor } from "@stackmaster/challenge-schema";
import {
  buildBytePair,
  loadPairWithEdits,
  violationRuleIds,
} from "./helpers/private-bundle.js";
import { buildPublicDescriptor, CODE_START_HEX, defaultByteEncodingTable } from "./helpers/public-descriptor.js";

const register = (name: string) => ({ kind: "register" as const, name });
const immediate = (valueHex: string) => ({ kind: "immediate" as const, valueHex });
const label = (labelId: string) => ({ kind: "label" as const, labelId });

/** 与缺省 64 位表配套的条件跳转样例程序:push RBP; mov RBP,RSP; je done; pop RBP; done: ret。 */
function conditionalAuthorProgram(): AuthorProgram {
  return {
    entrypoint: { labelId: "entry" },
    instructions: [
      { op: "push", operands: [register("RBP")] },
      {
        op: "mov",
        operands: [register("RBP"), register("RSP")],
      },
      { op: "je", operands: [label("done")] },
      { op: "pop", operands: [register("RBP")] },
      { op: "ret", operands: [] },
    ],
    labels: [
      { labelId: "entry", instructionIndex: 0 },
      { labelId: "done", instructionIndex: 4 },
    ],
  };
}

describe("字节模式装载:译码产物与内联自证", () => {
  it("条件跳转的标签消解为绝对字节地址,内联 8 字节小端", () => {
    // 布局:push(1) + mov(1) + je(1+8) + pop(1) + ret(1) → done 在偏移 12。
    const byteDescriptor = buildPublicDescriptor({
      mode: "byte",
      encodingTable: defaultByteEncodingTable(),
    });
    const compiled = compileByteProgram(conditionalAuthorProgram(), byteDescriptor, {
      codeRegion: { startAddressHex: CODE_START_HEX, byteLength: 4096 },
      padTokenHex: "0x90",
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }
    // je 目标 = 0x400000 + 12 = 0x40000c,小端 8 字节。
    const expectedImmediate = "0c00400000000000";
    expect(compiled.code.contentHex.startsWith(`558974${expectedImmediate}58c3`)).toBe(true);
    expect(compiled.code.entrypointAddressHex).toBe("0x400000");
    expect(compiled.code.programEndOffsetBytes).toBe(13);

    // 消解产物注入双包 → 装载全绿(编译器产物自消费装载管线)。
    const result = loadChallengePair(
      buildBytePair({
        byteProgramHex: compiled.code.contentHex.slice(0, 13 * 2),
        bytePadTokenHex: "0x90",
      }),
    );
    expect(result.ok, JSON.stringify(result.ok ? [] : result.violations)).toBe(true);
    if (result.ok && result.challenge.program.mode === "byte") {
      const je = result.challenge.program.instructions[2];
      expect(je?.op).toBe("je");
      const operand = je?.operands[0];
      expect(operand).toEqual({ kind: "immediate", value: 0x40000cn });
    }
  });

  it("32 位题目内联自证:立即数恰 4 字节小端", () => {
    // mov RAX, 0x2A → b8 + 2a000000;syscall exit(0x3C) → cd + 3c000000。
    const pair = buildBytePair({
      archBits: 32,
      byteProgramHex: "b82a000000cd3c000000",
      bytePadTokenHex: "0x90",
    });
    const result = loadChallengePair(pair);
    expect(result.ok, JSON.stringify(result.ok ? [] : result.violations)).toBe(true);
    if (result.ok && result.challenge.program.mode === "byte") {
      const [mov, syscall] = result.challenge.program.instructions;
      expect(mov?.op).toBe("mov");
      expect(mov?.operands[1]).toEqual({ kind: "immediate", value: 0x2an });
      expect(syscall?.op).toBe("syscall");
      expect(syscall?.operands[0]).toEqual({ kind: "immediate", value: 0x3cn });
    }
  });

  it("译码层防御复核:探测应拒绝的输入不会产出部分程序", () => {
    // 直接调用译码器(绕过管线层次),未知 token → XS-ENC-PROBE 方向违规。
    const pair = buildBytePair();
    const publicDescriptor = pair.publicDescriptor as PublicChallengeDescriptor;
    const privateBundle = pair.privateBundle as { initialState: { memoryRegions: { contentHex: string }[] } };
    privateBundle.initialState.memoryRegions[0]!.contentHex =
      "ff" + "00".repeat(4095);
    const decoded = decodeByteProgram(
      publicDescriptor,
      pair.privateBundle as Parameters<typeof decodeByteProgram>[1],
    );
    expect(decoded.violations.length).toBeGreaterThan(0);
    expect(decoded.violations[0]?.ruleId).toBe("XS-ENC-PROBE");
  });
});

describe("字节模式生成面(XC-ENC-*)红灯样例(必触发)", () => {
  const byteDescriptor = buildPublicDescriptor({
    mode: "byte",
    encodingTable: defaultByteEncodingTable(),
  });
  const baseOptions = {
    codeRegion: { startAddressHex: CODE_START_HEX, byteLength: 4096 },
    padTokenHex: "0x90",
  };

  it("XC-ENC-NO-MATCH:无匹配 token 的指令", () => {
    const result = compileProgram(
      {
        instructions: [{ op: "sub", operands: [register("RAX"), immediate("0x1")] }],
        labels: [],
      },
      byteDescriptor,
      baseOptions,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((item) => item.ruleId === "XC-ENC-NO-MATCH")).toBe(true);
    }
  });

  it("XC-ENC-AMBIGUOUS:同一形态命中多个 token", () => {
    const table = [
      ...defaultByteEncodingTable(),
      { tokenHex: "0x56", op: "push", operands: [{ kind: "register" as const, name: "RBP" }] },
    ];
    const ambiguousDescriptor = buildPublicDescriptor({ mode: "byte", encodingTable: table });
    const result = compileProgram(
      {
        instructions: [{ op: "push", operands: [register("RBP")] }],
        labels: [],
      },
      ambiguousDescriptor,
      baseOptions,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((item) => item.ruleId === "XC-ENC-AMBIGUOUS")).toBe(true);
    }
  });

  it("XC-ENC-VALUE-RANGE:内联立即数越出 archBits 位宽域", () => {
    const result = compileProgram(
      {
        instructions: [
          { op: "mov", operands: [register("RAX"), { kind: "immediate", valueHex: "0x1FFFFFFFFFFFFFFFF" }] },
        ],
        labels: [],
      },
      byteDescriptor,
      baseOptions,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((item) => item.ruleId === "XC-ENC-VALUE-RANGE")).toBe(true);
    }
  });

  it("XC-ENC-OVERFLOW:程序编码越出代码区", () => {
    const result = compileProgram(
      {
        instructions: Array.from({ length: 5000 }, () => ({
          op: "push",
          operands: [register("RBP")],
        })),
        labels: [],
      },
      byteDescriptor,
      baseOptions,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((item) => item.ruleId === "XC-ENC-OVERFLOW")).toBe(true);
    }
  });

  it("XC-ENC-PAD:填充 token 带内联字节 / 未声明填充", () => {
    const withOperandPad = compileProgram(
      { instructions: [{ op: "push", operands: [register("RBP")] }], labels: [] },
      byteDescriptor,
      { ...baseOptions, padTokenHex: "0xb8" },
    );
    expect(withOperandPad.ok).toBe(false);
    if (!withOperandPad.ok) {
      expect(withOperandPad.diagnostics.some((item) => item.ruleId === "XC-ENC-PAD")).toBe(true);
    }
    const missingPad = compileProgram(
      { instructions: [{ op: "push", operands: [register("RBP")] }], labels: [] },
      byteDescriptor,
      { codeRegion: baseOptions.codeRegion },
    );
    expect(missingPad.ok).toBe(false);
    if (!missingPad.ok) {
      expect(missingPad.diagnostics.some((item) => item.ruleId === "XC-ENC-PAD")).toBe(true);
    }
    const missingGeometry = compileProgram(
      { instructions: [{ op: "push", operands: [register("RBP")] }], labels: [] },
      byteDescriptor,
    );
    expect(missingGeometry.ok).toBe(false);
  });

  it("字节模式管线红灯透传:未知 token / W^X / 入口出界(XS-ENC-PROBE / XS-CODE-WRX)", () => {
    const unknownToken = loadPairWithEdits(buildBytePair(), undefined, (privateClone) => {
      const regions = privateClone["initialState"] as { memoryRegions: { contentHex: string }[] };
      regions.memoryRegions[0]!.contentHex = "ff" + "00".repeat(4095);
    });
    expect(unknownToken.ok).toBe(false);
    if (!unknownToken.ok) {
      expect(violationRuleIds(unknownToken)).toContain("XS-ENC-PROBE");
    }

    const writableCode = loadPairWithEdits(buildBytePair(), (publicClone) => {
      const layout = publicClone["memoryLayout"] as { regions: { permissions: string }[] };
      layout.regions[0]!.permissions = "rwx";
    });
    expect(writableCode.ok).toBe(false);
    if (!writableCode.ok) {
      expect(violationRuleIds(writableCode)).toContain("XS-CODE-WRX");
    }
  });
});

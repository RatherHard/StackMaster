// 编译器生成面测试(WP-2):作者程序(带标签)→ 冻结契约产物;
// 标签编译期消解为内联地址(IR = 指令索引,字节 = 绝对字节地址);
// 同一逻辑程序双形态编译产物(跨模式一致性样例,WP-9 消费)。
import { describe, expect, it } from "vitest";

import {
  compileIrProgram,
  compileProgram,
  loadChallengePair,
  type AuthorProgram,
} from "../src/index.js";
import {
  buildBytePair,
  buildIrPair,
  violationRuleIds,
} from "./helpers/private-bundle.js";
import { buildPublicDescriptor, CODE_START_HEX, defaultByteEncodingTable } from "./helpers/public-descriptor.js";

const register = (name: string) => ({ kind: "register" as const, name });
const immediate = (valueHex: string) => ({ kind: "immediate" as const, valueHex });
const label = (labelId: string) => ({ kind: "label" as const, labelId });

/** 栈帧 + 条件分支 + 收尾的样例程序(双模式共用同一逻辑)。 */
function sampleProgram(): AuthorProgram {
  return {
    entrypoint: { labelId: "entry" },
    instructions: [
      { op: "push", operands: [register("RBP")] },
      { op: "mov", operands: [register("RBP"), register("RSP")] },
      { op: "cmp", operands: [register("RAX"), immediate("0x0")] },
      { op: "je", operands: [label("done")] },
      { op: "pop", operands: [register("RBP")] },
      { op: "jmp", operands: [label("exit")] },
      { op: "leave", operands: [] }, // done:
      { op: "ret", operands: [] }, // exit:
    ],
    labels: [
      { labelId: "entry", instructionIndex: 0 },
      { labelId: "done", instructionIndex: 6 },
      { labelId: "exit", instructionIndex: 7 },
    ],
  };
}

describe("IR 模式生成面:标签消解为内联指令索引", () => {
  it("标签 → valueHex 立即数,labels[] 元数据与入口保留", () => {
    const result = compileIrProgram(sampleProgram());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { compiledIr } = result;
    expect(compiledIr.entrypointIndex).toBe(0);
    expect(compiledIr.labels).toHaveLength(3);
    // je done → 目标索引 6;jmp exit → 目标索引 7。
    expect(compiledIr.instructions[3]?.operands).toEqual([{ kind: "immediate", valueHex: "0x6" }]);
    expect(compiledIr.instructions[5]?.operands).toEqual([{ kind: "immediate", valueHex: "0x7" }]);
    // 消解产物注入双包 → 装载全绿(编译器产物自消费装载管线)。
    const loaded = loadChallengePair(
      buildIrPair({
        irProgram: {
          entrypointIndex: compiledIr.entrypointIndex,
          instructions: compiledIr.instructions,
          labels: compiledIr.labels,
        },
      }),
    );
    expect(loaded.ok, JSON.stringify(loaded.ok ? [] : loaded.violations)).toBe(true);
  });

  it("入口缺省:优先标签 entry,否则索引 0", () => {
    const withEntry = compileIrProgram({
      instructions: [{ op: "ret", operands: [] }],
      labels: [{ labelId: "entry", instructionIndex: 0 }],
    });
    expect(withEntry.ok && withEntry.compiledIr.entrypointIndex).toBe(0);
    const withoutEntry = compileIrProgram({
      instructions: [{ op: "ret", operands: [] }],
      labels: [],
    });
    expect(withoutEntry.ok && withoutEntry.compiledIr.entrypointIndex).toBe(0);
  });

  it("XC-LABEL-DUP:标签重复声明", () => {
    const result = compileIrProgram({
      instructions: [{ op: "ret", operands: [] }],
      labels: [
        { labelId: "a", instructionIndex: 0 },
        { labelId: "a", instructionIndex: 0 },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((item) => item.ruleId === "XC-LABEL-DUP")).toBe(true);
    }
  });

  it("XC-LABEL-BOUND:标签索引出界", () => {
    const result = compileIrProgram({
      instructions: [{ op: "ret", operands: [] }],
      labels: [{ labelId: "a", instructionIndex: 9 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((item) => item.ruleId === "XC-LABEL-BOUND")).toBe(true);
    }
  });

  it("XC-LABEL-REF:控制流引用未声明标签", () => {
    const result = compileIrProgram({
      instructions: [{ op: "jmp", operands: [label("nope")] }, { op: "ret", operands: [] }],
      labels: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((item) => item.ruleId === "XC-LABEL-REF")).toBe(true);
    }
  });

  it("XC-ENTRY-BOUND:入口索引出界", () => {
    const result = compileIrProgram({
      entrypoint: { instructionIndex: 9 },
      instructions: [{ op: "ret", operands: [] }],
      labels: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((item) => item.ruleId === "XC-ENTRY-BOUND")).toBe(true);
    }
  });

  it("标签操作数 = 取地址语义:凡立即数合法的槽位均可引用标签", () => {
    // mov RAX, label = 把标签地址(索引)作为架构值装载;控制流槽位同理。
    const result = compileProgram(
      {
        entrypoint: { labelId: "a" },
        instructions: [
          { op: "mov", operands: [register("RAX"), label("a")] },
          { op: "ret", operands: [] },
        ],
        labels: [{ labelId: "a", instructionIndex: 0 }],
      },
      buildPublicDescriptor({ mode: "ir" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.mode === "ir") {
      expect(result.compiledIr.instructions[0]?.operands).toEqual([
        { kind: "register", name: "RAX" },
        { kind: "immediate", valueHex: "0x0" },
      ]);
    }
  });
});

describe("跨模式一致性样例(同一逻辑程序,双形态编译产物)", () => {
  it("IR 产物与字节产物均通过装载管线,跳转目标按各自地址空间消解", () => {
    const program = sampleProgram();

    const irResult = compileProgram(program, buildPublicDescriptor({ mode: "ir" }));
    expect(irResult.ok).toBe(true);

    const byteResult = compileProgram(
      program,
      buildPublicDescriptor({ mode: "byte", encodingTable: defaultByteEncodingTable() }),
      {
        codeRegion: { startAddressHex: CODE_START_HEX, byteLength: 4096 },
        padTokenHex: "0x90",
      },
    );
    expect(byteResult.ok, JSON.stringify(byteResult.ok ? [] : byteResult.diagnostics)).toBe(true);
    if (!byteResult.ok || !irResult.ok || irResult.mode !== "ir" || byteResult.mode !== "byte") {
      return;
    }

    // IR 模式:je → 指令索引 6。
    expect(irResult.compiledIr.instructions[3]?.operands).toEqual([
      { kind: "immediate", valueHex: "0x6" },
    ]);
    // 字节模式布局:push(1)@0 + mov(1)@1 + cmp(1+8)@2 + je(1+8)@11 + pop(1)@20
    // + jmp(1+8)@21 + leave(1)@30 + ret(1)@31 → done 偏移 30、exit 偏移 31。
    expect(byteResult.code.contentHex.startsWith("5589")).toBe(true);
    expect(byteResult.code.programEndOffsetBytes).toBe(32);

    // 双形态产物分别注入双包,均装载全绿(编译器产物自消费)。
    const irLoaded = loadChallengePair(
      buildIrPair({
        irProgram: {
          entrypointIndex: irResult.compiledIr.entrypointIndex,
          instructions: irResult.compiledIr.instructions,
          labels: irResult.compiledIr.labels,
        },
      }),
    );
    expect(irLoaded.ok, JSON.stringify(irLoaded.ok ? [] : irLoaded.violations)).toBe(true);

    const byteLoaded = loadChallengePair(
      buildBytePair({
        byteProgramHex: byteResult.code.contentHex.slice(0, byteResult.code.programEndOffsetBytes * 2),
        bytePadTokenHex: "0x90",
      }),
    );
    expect(byteLoaded.ok, JSON.stringify(byteLoaded.ok ? [] : byteLoaded.violations)).toBe(true);
    if (byteLoaded.ok && byteLoaded.challenge.program.mode === "byte") {
      // jmp exit 的内联立即数 = 绝对地址 0x40001f。
      const jmp = byteLoaded.challenge.program.instructions[5];
      expect(jmp?.operands[0]).toEqual({ kind: "immediate", value: 0x40001fn });
    }
  });
});

describe("字节模式生成面红灯补充(经管线透传校验)", () => {
  it("生成面拒绝的形态不会流入装载(XC-ENC-NO-MATCH 先于管线)", () => {
    const result = compileProgram(
      {
        instructions: [{ op: "jb", operands: [immediate("0x0")] }],
        labels: [],
      },
      buildPublicDescriptor({ mode: "byte", encodingTable: defaultByteEncodingTable() }),
      {
        codeRegion: { startAddressHex: CODE_START_HEX, byteLength: 4096 },
        padTokenHex: "0x90",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((item) => item.ruleId === "XC-ENC-NO-MATCH")).toBe(true);
    }
  });

  it("默认缺省双包装载绿灯(回归守卫)", () => {
    const result = loadChallengePair(buildBytePair());
    expect(result.ok).toBe(true);
  });
});

describe("违规方向一致性", () => {
  it("生成面与装载面失败都指向 challenge_invalid(装载面)", () => {
    const result = loadChallengePair(
      buildIrPair({
        mutate: (pair) => {
          const bundle = pair.privateBundle as { compiledIr?: { instructions: unknown[] } };
          if (bundle.compiledIr !== undefined) {
            bundle.compiledIr.instructions = [{ op: "mov", operands: [] }];
          }
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result).size).toBeGreaterThan(0);
    }
  });
});

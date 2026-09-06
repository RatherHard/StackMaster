// 逐 opcode 操作数形态表测试(WP-2;docs/contracts/最小DSL范围.md §三.1 冻结表)。
// 每条拒绝规则带必触发红灯样例(整改方案 §七回归纪律)。
import { describe, expect, it } from "vitest";

import { loadChallengePair } from "../src/index.js";
import type { IrInstruction } from "@stackmaster/challenge-schema/server-only";
import { buildIrPair, loadPairWithEdits, violationRuleIds } from "./helpers/private-bundle.js";
import { OPCODE_OPERAND_SHAPES } from "../src/ir/opcode-shapes.js";

/** 构造仅含单条指令的最小 IR 配对并装载(目标界内;stages 承接自跳回边)。 */
function loadSingleInstruction(instruction: IrInstruction) {
  // jmp/je/jne/jb/jae/call 的立即数目标 0 = 自跳(回边),统一以 stages 声明
  // 承接回边预算,使本组只测操作数形态。
  const pair = buildIrPair({
    irProgram: {
      entrypointIndex: 0,
      instructions: [instruction],
      labels: [],
    },
    stages: [
      {
        stageId: "s0",
        allowedActions: ["step"],
        preconditions: { all: [] },
        transitions: [],
        sideEffects: [],
        failureConditions: [],
        resourceBudget: { maxInstructionSteps: 1000 },
      },
    ],
  });
  return loadChallengePair(pair);
}

describe("XC-OPCODE-SHAPE:冻结形态表绿灯矩阵", () => {
  const register = (name: string) => ({ kind: "register" as const, name });
  const immediate = (valueHex: string) => ({ kind: "immediate" as const, valueHex });
  const memory = (baseRegister?: string, displacementHex?: string) => ({
    kind: "memory" as const,
    ...(baseRegister !== undefined ? { baseRegister } : {}),
    ...(displacementHex !== undefined ? { displacementHex } : {}),
  });
  const iface = (interfaceId: number) => ({ kind: "interface" as const, interfaceId });

  /** 每 opcode × 每声明形态一个绿灯样例(样例即矩阵,防形态表与实现漂移)。 */
  const shapeSamples: Readonly<Record<string, readonly IrInstruction[]>> = {
    mov: [
      { op: "mov", operands: [register("RAX"), immediate("0x2A")] },
      { op: "mov", operands: [register("RAX"), register("RBP")] },
      { op: "mov", operands: [register("RAX"), memory("RBP", "0x8")] },
      { op: "mov", operands: [memory("RBP", "0x8"), register("RAX")] },
    ],
    push: [{ op: "push", operands: [register("RAX")] }, { op: "push", operands: [immediate("0x1")] }],
    pop: [{ op: "pop", operands: [register("RAX")] }],
    leave: [{ op: "leave", operands: [] }],
    add: [
      { op: "add", operands: [register("RAX"), register("RBP")] },
      { op: "add", operands: [register("RAX"), immediate("0x1")] },
      { op: "add", operands: [register("RAX"), memory("RBP", "0x0")] },
    ],
    sub: [
      { op: "sub", operands: [register("RAX"), register("RBP")] },
      { op: "sub", operands: [register("RAX"), immediate("0x1")] },
      { op: "sub", operands: [register("RAX"), memory("RBP", "0x0")] },
    ],
    cmp: [
      { op: "cmp", operands: [register("RAX"), register("RBP")] },
      { op: "cmp", operands: [register("RAX"), immediate("0x1")] },
      { op: "cmp", operands: [register("RAX"), memory("RBP", "0x0")] },
    ],
    and: [
      { op: "and", operands: [register("RAX"), register("RBP")] },
      { op: "and", operands: [register("RAX"), immediate("0xFF")] },
    ],
    or: [
      { op: "or", operands: [register("RAX"), register("RBP")] },
      { op: "or", operands: [register("RAX"), immediate("0xF")] },
    ],
    xor: [
      { op: "xor", operands: [register("RAX"), register("RAX")] },
      { op: "xor", operands: [register("RAX"), immediate("0xF")] },
    ],
    shl: [
      { op: "shl", operands: [register("RAX"), register("RBP")] },
      { op: "shl", operands: [register("RAX"), immediate("0x3")] },
    ],
    shr: [
      { op: "shr", operands: [register("RAX"), register("RBP")] },
      { op: "shr", operands: [register("RAX"), immediate("0x3")] },
    ],
    jmp: [{ op: "jmp", operands: [immediate("0x0")] }, { op: "jmp", operands: [register("RAX")] }, { op: "jmp", operands: [memory("RBP", "0x0")] }],
    je: [{ op: "je", operands: [immediate("0x0")] }],
    jne: [{ op: "jne", operands: [immediate("0x0")] }],
    jb: [{ op: "jb", operands: [immediate("0x0")] }],
    jae: [{ op: "jae", operands: [immediate("0x0")] }],
    call: [
      { op: "call", operands: [immediate("0x0")] },
      { op: "call", operands: [register("RAX")] },
      { op: "call", operands: [iface(0x100)] },
    ],
    ret: [{ op: "ret", operands: [] }],
    syscall: [{ op: "syscall", operands: [immediate("0x0")] }],
    NOP0: [{ op: "NOP0", operands: [] }],
  };

  it("形态表覆盖 20 基线 opcode(与 DSL 文档 §三.1 一致)", () => {
    expect(Object.keys(OPCODE_OPERAND_SHAPES).sort()).toEqual(
      [
        "mov", "push", "pop", "leave", "add", "sub", "cmp", "and", "or", "xor",
        "shl", "shr", "jmp", "je", "jne", "jb", "jae", "call", "ret", "syscall",
      ].sort(),
    );
  });

  for (const [op, samples] of Object.entries(shapeSamples)) {
    it(`绿灯:${op} 全部声明形态`, () => {
      expect(samples.length).toBeGreaterThanOrEqual(1);
      for (const instruction of samples) {
        const result = loadSingleInstruction(instruction);
        expect(result.ok, `${op} 样例被拒:${JSON.stringify(result.ok ? [] : result.violations)}`).toBe(true);
      }
    });
  }
});

describe("XC-OPCODE-SHAPE:红灯样例(必触发)", () => {
  function editInstruction(instruction: unknown) {
    return loadPairWithEdits(buildIrPair(), undefined, (privateClone) => {
      const ir = privateClone["compiledIr"] as { instructions: unknown[] };
      ir.instructions = [instruction];
    });
  }
  const register = (name: string) => ({ kind: "register", name });
  const immediate = (valueHex: string) => ({ kind: "immediate", valueHex });
  const memory = (baseRegister?: string) => ({
    kind: "memory",
    ...(baseRegister !== undefined ? { baseRegister } : {}),
  });

  const redSamples: readonly [string, unknown][] = [
    ["mov 操作数数量不足", { op: "mov", operands: [register("RAX")] }],
    ["mov 立即数在首位(I,R)", { op: "mov", operands: [immediate("0x1"), register("RAX")] }],
    ["mov 双内存操作数(M,M)", { op: "mov", operands: [memory("RBP"), memory("RBP")] }],
    ["push 双操作数", { op: "push", operands: [register("RAX"), register("RBX")] }],
    ["pop 立即数操作数", { op: "pop", operands: [immediate("0x1")] }],
    ["leave 带操作数", { op: "leave", operands: [register("RAX")] }],
    ["add 单操作数", { op: "add", operands: [register("RAX")] }],
    ["and 内存第二操作数(R,M 不在 and 形态)", { op: "and", operands: [register("RAX"), memory("RBP")] }],
    ["jmp 零操作数", { op: "jmp", operands: [] }],
    ["je 寄存器操作数", { op: "je", operands: [register("RAX")] }],
    ["call 零操作数", { op: "call", operands: [] }],
    ["ret 带操作数", { op: "ret", operands: [immediate("0x0")] }],
    ["syscall 寄存器操作数(封闭单值伪操作;XS-SYSCALL-DECL 前置同拒)", { op: "syscall", operands: [register("RAX")] }],
    ["syscall 双操作数(同上)", { op: "syscall", operands: [immediate("0x0"), immediate("0x1")] }],
    [
      "自定义助记符带操作数(语义由微算子表承载)",
      { op: "NOP0", operands: [register("RAX")] },
    ],
  ];

  for (const [name, instruction] of redSamples) {
    it(`红灯:${name}`, () => {
      const result = editInstruction(instruction);
      expect(result.ok, `${name} 应被拒绝`).toBe(false);
      if (!result.ok) {
        // syscall 形态由 WP-4 检查器(XS-SYSCALL-DECL)前置拦截,其余归编译器层。
        const ids = violationRuleIds(result);
        expect(
          ids.has("XC-OPCODE-SHAPE") || ids.has("XS-SYSCALL-DECL"),
          `实际违规:${[...ids].join(",")}`,
        ).toBe(true);
      }
    });
  }
});

describe("XC-OPERAND-REF:操作数寄存器引用可解析", () => {
  it("红灯:寄存器不在私有初始寄存器集", () => {
    const result = loadPairWithEdits(buildIrPair(), undefined, (privateClone) => {
      const ir = privateClone["compiledIr"] as { instructions: unknown[] };
      ir.instructions = [
        { op: "mov", operands: [{ kind: "register", name: "RNOPE" }, { kind: "immediate", valueHex: "0x1" }] },
      ];
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XC-OPERAND-REF");
    }
  });

  it("红灯:内存基址寄存器不在私有初始寄存器集", () => {
    const result = loadPairWithEdits(buildIrPair(), undefined, (privateClone) => {
      const ir = privateClone["compiledIr"] as { instructions: unknown[] };
      ir.instructions = [
        {
          op: "mov",
          operands: [
            { kind: "register", name: "RAX" },
            { kind: "memory", baseRegister: "RNOPE", displacementHex: "0x0" },
          ],
        },
      ];
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XC-OPERAND-REF");
    }
  });

  it("绿灯:FLAG 寄存器可作只读操作数(值秘密但寄存器存在)", () => {
    const result = loadPairWithEdits(buildIrPair(), undefined, (privateClone) => {
      const ir = privateClone["compiledIr"] as { instructions: unknown[] };
      ir.instructions = [
        {
          op: "mov",
          operands: [{ kind: "register", name: "RAX" }, { kind: "register", name: "FLAG0" }],
        },
        { op: "ret", operands: [] },
      ];
    });
    expect(result.ok).toBe(true);
  });
});

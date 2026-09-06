// CFG 编译期分析测试(WP-2:可达性、终止性、循环回边 vs 预算、静态目标界内)。
import { describe, expect, it } from "vitest";

import { loadChallengePair } from "../src/index.js";
import type { IrInstruction } from "@stackmaster/challenge-schema/server-only";
import {
  buildIrPair,
  loadPairWithEdits,
  violationRuleIds,
} from "./helpers/private-bundle.js";

const register = (name: string) => ({ kind: "register" as const, name });
const immediate = (valueHex: string) => ({ kind: "immediate" as const, valueHex });

const boundedStage = {
  stageId: "s0",
  allowedActions: ["step" as const],
  preconditions: { all: [] },
  transitions: [],
  sideEffects: [],
  failureConditions: [],
  resourceBudget: { maxInstructionSteps: 1000 },
};

function loadProgram(instructions: readonly IrInstruction[], options?: {
  readonly entrypointIndex?: number;
  readonly stages?: readonly unknown[];
}) {
  return loadChallengePair(
    buildIrPair({
      irProgram: {
        entrypointIndex: options?.entrypointIndex ?? 0,
        instructions: [...instructions],
        labels: [],
      },
      ...(options?.stages !== undefined ? { stages: options.stages as never } : {}),
    }),
  );
}

describe("XC-IR-REACH:可达性", () => {
  it("红灯:入口直落的死代码不可达(纯静态程序)", () => {
    const result = loadProgram([
      { op: "jmp", operands: [immediate("0x2")] },
      { op: "mov", operands: [register("RAX"), immediate("0x1")] },
      { op: "syscall", operands: [immediate("0x0")] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XC-IR-REACH");
    }
  });

  it("红灯:exit 终结点之后的直线代码不可达", () => {
    const result = loadProgram([
      { op: "syscall", operands: [immediate("0x0")] },
      { op: "ret", operands: [] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XC-IR-REACH");
    }
  });

  it("绿灯:条件跳转的双分支均可达", () => {
    const result = loadProgram([
      { op: "cmp", operands: [register("RAX"), immediate("0x0")] },
      { op: "je", operands: [immediate("0x3")] },
      { op: "ret", operands: [] },
      { op: "syscall", operands: [immediate("0x0")] },
    ]);
    expect(result.ok).toBe(true);
  });
});

describe("XC-IR-TARGET:静态控制流目标界内", () => {
  it("红灯:跳转目标越出指令数组", () => {
    const result = loadProgram([
      { op: "jmp", operands: [immediate("0x100")] },
      { op: "ret", operands: [] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XC-IR-TARGET");
    }
  });

  it("红灯:目标 = 指令数(恰出界)", () => {
    const result = loadProgram([
      { op: "jmp", operands: [immediate("0x2")] },
      { op: "ret", operands: [] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XC-IR-TARGET");
    }
  });
});

describe("XC-IR-TERMINATE:循环回边 vs 预算(7.2)", () => {
  it("红灯:回边存在但未声明 stages(无预算承接的循环)", () => {
    const result = loadProgram([
      { op: "jmp", operands: [immediate("0x0")] },
      { op: "ret", operands: [] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XC-IR-TERMINATE");
      const terminate = result.violations.find((item) => item.ruleId === "XC-IR-TERMINATE");
      expect(terminate?.path).toBe("/stages");
    }
  });

  it("红灯:自跳(目标 = 来源)同为回边", () => {
    const result = loadProgram([{ op: "jmp", operands: [immediate("0x0")] }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XC-IR-TERMINATE");
    }
  });

  it("红灯:条件跳转回边同样需要预算", () => {
    const result = loadProgram([
      { op: "cmp", operands: [register("RAX"), immediate("0x0")] },
      { op: "je", operands: [immediate("0x0")] },
      { op: "ret", operands: [] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XC-IR-TERMINATE");
    }
  });

  it("绿灯:同一回边在声明 stages(动态指令预算)后通过", () => {
    const result = loadProgram(
      [
        { op: "cmp", operands: [register("RAX"), immediate("0x0")] },
        { op: "je", operands: [immediate("0x0")] },
        { op: "ret", operands: [] },
      ],
      { stages: [boundedStage] },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.challenge.program.mode).toBe("ir");
      if (result.challenge.program.mode === "ir") {
        expect(result.challenge.program.backEdges).toEqual([{ from: 1, to: 0 }]);
        expect(result.challenge.program.reachableInstructionCount).toBe(3);
      }
    }
  });

  it("绿灯:直线程序与动态目标(ret / jmp R)不需要 stages", () => {
    const straight = loadProgram([
      { op: "push", operands: [register("RBP")] },
      { op: "ret", operands: [] },
    ]);
    expect(straight.ok).toBe(true);
    const dynamic = loadProgram([
      { op: "jmp", operands: [register("RAX")] },
      { op: "ret", operands: [] },
    ]);
    // jmp R 为动态目标:静态图汇点,不产生回边断言;index 1 由直线可达。
    expect(dynamic.ok).toBe(true);
  });
});

describe("syscall 派发分类(编译期终结点判定)", () => {
  it("红灯:作者接口效果含 exit 时 syscall 为终结点,其后直线代码不可达", () => {
    const result = loadPairWithEdits(
      buildIrPair({
        interfaces: [
          { interfaceId: 0x100, displayText: "退出接口", effects: [{ effect: "exit" }] },
        ],
      }),
      undefined,
      (privateClone) => {
        const ir = privateClone["compiledIr"] as { instructions: unknown[] };
        ir.instructions = [
          { op: "syscall", operands: [immediate("0x100")] },
          { op: "ret", operands: [] },
        ];
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XC-IR-REACH");
    }
  });

  it("绿灯:作者接口效果不含 exit 时 syscall 取直线后继", () => {
    const result = loadPairWithEdits(
      buildIrPair({
        interfaces: [
          {
            interfaceId: 0x100,
            displayText: "教学接口:授予笔记",
            effects: [{ effect: "grant_virtual_file", fileId: "win-notes" }],
          },
        ],
      }),
      undefined,
      (privateClone) => {
        const ir = privateClone["compiledIr"] as { instructions: unknown[] };
        ir.instructions = [
          { op: "syscall", operands: [immediate("0x100")] },
          { op: "ret", operands: [] },
        ];
      },
    );
    expect(result.ok).toBe(true);
  });
});

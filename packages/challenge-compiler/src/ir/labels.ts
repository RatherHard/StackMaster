/**
 * 标签编译期消解(WP-2;D4.4 字节权威模式与 IR 模式共用的编译器作者形态)。
 *
 * 编译器的**生成面**接受带标签引用的作者程序(AuthorProgram:冻结 IR 形态
 * + 第四种编译器内部操作数 {kind:"label"}),按目标模式把标签消解为内联
 * 目标——IR 模式 = 指令索引(valueHex 立即数,labels[] 元数据保留),
 * 字节模式 = 代码区绝对字节地址(archBits/8 字节小端内联,私有包不存在
 * 标签形态,docs/contracts/最小DSL范围.md §三.4.2)。
 *
 * 规则 ID(生成面;消解产物再经装载管线全量校验):
 *  - XC-LABEL-DUP   labelId 重复;
 *  - XC-LABEL-BOUND 标签指令索引出界;
 *  - XC-LABEL-REF   控制流引用了未声明标签;
 *  - XC-ENTRY-BOUND 入口(标签或索引)出界。
 */

import type { IrInstruction, IrLabel, IrOperand } from "@stackmaster/challenge-schema/server-only";
import { compilerViolation, type CompilerViolation } from "../common/diagnostics.js";

/** 作者形态操作数:冻结四形态 ∪ 标签引用(编译器内部,不进任何 Schema)。 */
export type AuthorOperand = IrOperand | { readonly kind: "label"; readonly labelId: string };

export interface AuthorInstruction {
  readonly op: IrInstruction["op"];
  readonly operands?: readonly AuthorOperand[];
}

export interface AuthorProgram {
  /** 入口:标签或指令索引;缺省时优先取名为 "entry" 的标签,否则索引 0。 */
  readonly entrypoint?: { readonly labelId: string } | { readonly instructionIndex: number };
  readonly instructions: readonly AuthorInstruction[];
  readonly labels?: readonly IrLabel[];
}

/** 标签消解产物:labelId → 指令索引(确定性;重复标签已被拒绝)。 */
export type LabelIndexMap = ReadonlyMap<string, number>;

function isLabelOperand(operand: AuthorOperand): operand is { kind: "label"; labelId: string } {
  return operand.kind === "label";
}

/** 标签表校验与索引映射构建。 */
export function buildLabelIndexMap(program: AuthorProgram): {
  labelIndex: LabelIndexMap;
  violations: CompilerViolation[];
} {
  const violations: CompilerViolation[] = [];
  const labelIndex = new Map<string, number>();
  const seen = new Map<string, number>();
  const instructionCount = program.instructions.length;

  (program.labels ?? []).forEach((label, index) => {
    const first = seen.get(label.labelId);
    if (first !== undefined) {
      violations.push(compilerViolation(
        "XC-LABEL-DUP",
        `标签 "${label.labelId}" 重复声明(第 ${first} 项与第 ${index} 项)`,
        `/labels/${index}/labelId`,
      ));
      return;
    }
    seen.set(label.labelId, index);
    if (!Number.isInteger(label.instructionIndex) || label.instructionIndex < 0 || label.instructionIndex >= instructionCount) {
      violations.push(compilerViolation(
        "XC-LABEL-BOUND",
        `标签 "${label.labelId}" 的指令索引 ${label.instructionIndex} 出界(0 ≤ 索引 < ${instructionCount})`,
        `/labels/${index}/instructionIndex`,
      ));
      return;
    }
    labelIndex.set(label.labelId, label.instructionIndex);
  });

  return { labelIndex, violations };
}

/** 入口指令索引消解(缺省:标签 "entry" → 索引 0)。 */
export function resolveEntrypointIndex(
  program: AuthorProgram,
  labelIndex: LabelIndexMap,
): { entrypointIndex: number; violations: CompilerViolation[] } {
  const violations: CompilerViolation[] = [];
  const instructionCount = program.instructions.length;
  const entrypoint = program.entrypoint;

  let entrypointIndex: number;
  if (entrypoint === undefined) {
    entrypointIndex = labelIndex.get("entry") ?? 0;
  } else if ("labelId" in entrypoint) {
    const resolved = labelIndex.get(entrypoint.labelId);
    if (resolved === undefined) {
      violations.push(compilerViolation(
        "XC-LABEL-REF",
        `入口标签 "${entrypoint.labelId}" 未在 labels 声明`,
        "/entrypoint/labelId",
      ));
      entrypointIndex = 0;
    } else {
      entrypointIndex = resolved;
    }
  } else {
    entrypointIndex = entrypoint.instructionIndex;
  }

  if (!Number.isInteger(entrypointIndex) || entrypointIndex < 0 || entrypointIndex >= instructionCount) {
    violations.push(compilerViolation(
      "XC-ENTRY-BOUND",
      `入口指令索引 ${entrypointIndex} 出界(0 ≤ 索引 < ${instructionCount})`,
      "/entrypoint",
    ));
    entrypointIndex = 0;
  }
  return { entrypointIndex, violations };
}

/**
 * 消解作者指令的标签操作数为目标值。
 * `resolveTarget(labelId)` 返回目标数值(索引或字节地址);未声明标签记 XC-LABEL-REF。
 */
export function resolveInstructionOperands(
  instructions: readonly AuthorInstruction[],
  resolveTarget: (labelId: string) => bigint | undefined,
): { instructions: IrInstruction[]; violations: CompilerViolation[] } {
  const violations: CompilerViolation[] = [];
  const resolved: IrInstruction[] = instructions.map((instruction) => {
    const operands = instruction.operands ?? [];
    if (!operands.some(isLabelOperand)) {
      // 无标签槽位:形态已是冻结四形态之一(数组级收窄 TS 不可达,显式断言)。
      return {
        op: instruction.op,
        operands: instruction.operands as readonly IrOperand[] | undefined,
      };
    }
    return {
      op: instruction.op,
      operands: operands.map((operand): IrOperand => {
        if (operand.kind !== "label") {
          return operand;
        }
        const target = resolveTarget(operand.labelId);
        if (target === undefined) {
          violations.push(compilerViolation(
            "XC-LABEL-REF",
            `指令引用的标签 "${operand.labelId}" 未在 labels 声明`,
            `/instructions/operands/label/${operand.labelId}`,
          ));
          // 消解失败的槽位以 0 占位:整次编译已失败,产物不会被装载。
          return { kind: "immediate", valueHex: "0x0" };
        }
        return { kind: "immediate", valueHex: `0x${target.toString(16)}` };
      }),
    };
  });
  return { instructions: resolved, violations };
}

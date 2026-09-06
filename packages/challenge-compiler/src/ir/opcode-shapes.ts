/**
 * 逐 opcode 操作数形态表与编译期校验(WP-2;docs/contracts/最小DSL范围.md §三.1 冻结表)。
 *
 * WP-4 检查器对 IR 只做结构性约束(op 封闭枚举、引用可解析、索引界);
 * "逐 opcode 操作数合法性与数量"归本模块(双包Schema语义.md 分工表)。
 * 形态类别:R = 寄存器、I = 立即数、M = 内存(base + 位移)、
 * F = 作者接口结构化引用、L = 标签引用(仅编译器作者形态,消解为 I)。
 *
 * 规则 ID:
 *  - XC-OPCODE-SHAPE  操作数数量与形态不符合冻结表;自定义助记符必须零操作数
 *                     (语义由微算子表承载,操作数无语法位置,docs §三.2);
 *  - XC-OPERAND-REF   寄存器 / 内存基址引用必须落在私有初始寄存器集
 *                     (运行时封闭集,与 XS-PRED-REFS 的谓词引用同一基准;
 *                     FLAG 寄存器在初始集内、可作只读操作数)。
 */

import type { ArchBits } from "@stackmaster/challenge-schema";
import type {
  IrInstruction,
  IrOperand,
  PrivateChallengeBundle,
} from "@stackmaster/challenge-schema/server-only";
import { compilerViolation, type CompilerViolation } from "../common/diagnostics.js";

/** 操作数类别(冻结表左列记法)。 */
export type OperandClass = "R" | "I" | "M" | "F";

/** 冻结操作数形态表(docs/contracts/最小DSL范围.md §三.1;每种形态的类序列)。 */
export const OPCODE_OPERAND_SHAPES: Readonly<
  Record<string, readonly (readonly OperandClass[])[]>
> = {
  mov: [["R", "I"], ["R", "R"], ["R", "M"], ["M", "R"]],
  push: [["R"], ["I"]],
  pop: [["R"]],
  leave: [[]],
  add: [["R", "R"], ["R", "I"], ["R", "M"]],
  sub: [["R", "R"], ["R", "I"], ["R", "M"]],
  cmp: [["R", "R"], ["R", "I"], ["R", "M"]],
  and: [["R", "R"], ["R", "I"]],
  or: [["R", "R"], ["R", "I"]],
  xor: [["R", "R"], ["R", "I"]],
  shl: [["R", "R"], ["R", "I"]],
  shr: [["R", "R"], ["R", "I"]],
  jmp: [["I"], ["R"], ["M"]],
  je: [["I"]],
  jne: [["I"]],
  jb: [["I"]],
  jae: [["I"]],
  call: [["I"], ["R"], ["F"]],
  ret: [[]],
  syscall: [["I"]],
};

/** operand kind → 冻结表类别。 */
function operandClass(operand: IrOperand): OperandClass {
  switch (operand.kind) {
    case "register":
      return "R";
    case "immediate":
      return "I";
    case "memory":
      return "M";
    case "interface":
      return "F";
  }
}

function shapeKey(shape: readonly OperandClass[]): string {
  return shape.join(",");
}

/** 人类可读的形态描述(诊断信息用)。 */
export function describeShapes(op: string): string {
  const shapes = OPCODE_OPERAND_SHAPES[op];
  if (shapes === undefined) {
    return "自定义助记符:零操作数";
  }
  return shapes.map((shape) => `[${shape.join(",")}]`).join(" / ");
}

function matchesAnyShape(op: string, classes: readonly OperandClass[]): boolean {
  const shapes = OPCODE_OPERAND_SHAPES[op];
  if (shapes === undefined) {
    // 自定义助记符:封闭集外唯一合法形态 = 零操作数(直线微算子语义承载)。
    return classes.length === 0;
  }
  const key = shapeKey(classes);
  return shapes.some((shape) => shapeKey(shape) === key);
}

/**
 * 单条指令操作数形态校验(仅 XC-OPCODE-SHAPE;生成面无寄存器环境时使用)。
 */
export function validateInstructionShape(
  instruction: IrInstruction,
  instructionIndex: number,
): CompilerViolation[] {
  const violations: CompilerViolation[] = [];
  const operands = instruction.operands ?? [];
  const path = `/compiledIr/instructions/${instructionIndex}`;
  const classes = operands.map(operandClass);

  if (!matchesAnyShape(instruction.op, classes)) {
    violations.push(compilerViolation(
      "XC-OPCODE-SHAPE",
      `指令 ${instructionIndex}(${instruction.op})的操作数形态 [${classes.join(",")}] ` +
        `不符合冻结形态表:${describeShapes(instruction.op)}`,
      `${path}/operands`,
    ));
  }
  return violations;
}

/**
 * 单条指令操作数形态与寄存器引用校验;返回该指令的违规清单。
 * `registerNames` = 私有初始寄存器集(运行时封闭集)。
 */
export function validateInstructionOperands(
  instruction: IrInstruction,
  instructionIndex: number,
  registerNames: ReadonlySet<string>,
): CompilerViolation[] {
  const violations = validateInstructionShape(instruction, instructionIndex);
  const operands = instruction.operands ?? [];
  const path = `/compiledIr/instructions/${instructionIndex}`;

  operands.forEach((operand, operandIndex) => {
    const operandPath = `${path}/operands/${operandIndex}`;
    if (operand.kind === "register") {
      if (!registerNames.has(operand.name)) {
        violations.push(compilerViolation(
          "XC-OPERAND-REF",
          `指令 ${instructionIndex}(${instruction.op})引用的寄存器 "${operand.name}" ` +
            `不在私有初始寄存器集`,
          `${operandPath}/name`,
        ));
      }
    } else if (operand.kind === "memory" && operand.baseRegister !== undefined) {
      if (!registerNames.has(operand.baseRegister)) {
        violations.push(compilerViolation(
          "XC-OPERAND-REF",
          `指令 ${instructionIndex}(${instruction.op})的内存基址寄存器 "${operand.baseRegister}" ` +
            `不在私有初始寄存器集`,
          `${operandPath}/baseRegister`,
        ));
      }
    }
  });

  return violations;
}

/** 20 基线 opcode 封闭判断(大写自定义助记符结构性不相交)。 */
export function isBaselineOpcode(op: string): boolean {
  return Object.prototype.hasOwnProperty.call(OPCODE_OPERAND_SHAPES, op);
}

/** 私有初始寄存器集(键集合;含 FLAG 寄存器——值秘密但名称/寄存器存在)。 */
export function initialRegisterNames(bundle: PrivateChallengeBundle): ReadonlySet<string> {
  return new Set(Object.keys(bundle.initialState.registers));
}

/** archBits 位宽域无符号上界(2^archBits − 1;XC-ENC-VALUE-RANGE 生成面用)。 */
export function unsignedMax(archBits: ArchBits): bigint {
  return (1n << BigInt(archBits)) - 1n;
}

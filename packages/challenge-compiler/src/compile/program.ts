/**
 * 编译器生成面:作者程序(带标签引用)→ 冻结契约产物(WP-2「token 流生成,
 * 标签编译期消解为内联地址」;双包Schema语义.md 分工表)。
 *
 * 目标模式由公开包 vmProfile.encodingTable 决定(XS-PROG-MODE 同一判据):
 *  - **IR 模式**:标签消解为指令索引(valueHex 立即数),产 compiledIr
 *    (labels[] 元数据保留,entrypointIndex 显式);
 *  - **字节模式**:逐指令查编码表取 token,寄存器 / 接口号烘焙进 token,
 *    立即数与位移内联(恰 archBits/8 字节小端,D4.7),跳转 / call 的标签
 *    目标消解为**绝对字节地址**内联(RIP 与 ret 弹出值同为绝对地址形态);
 *    产出代码区完整 contentHex(入口偏移前补零、尾部以零内联 token 填充
 *    ——纯指令流约定,docs/contracts/最小DSL范围.md §三.4.3)+ 入口地址。
 *
 * 编码两遍走:第一遍 token 匹配 + 偏移计算(内联定宽,标签值不影响长度),
 * 第二遍回填标签目标值并组装字节流。消解产物必须再经 `loadChallengePair`
 * 全量校验方可进入私有包(编译器产物自消费装载管线;fail-closed:任何
 * 诊断非空即拒绝产出)。
 *
 * 规则 ID:
 *  - XC-ENC-NO-MATCH     找不到与指令操作数形态匹配的编码表条目;
 *  - XC-ENC-AMBIGUOUS    同一操作数形态命中多个 token(编码不唯一);
 *  - XC-ENC-VALUE-RANGE  内联立即数 / 位移越出 archBits 位宽域;
 *  - XC-ENC-OVERFLOW     程序编码字节越出代码区;
 *  - XC-ENC-PAD          尾部填充 token 未声明、带内联字节,或缺几何参数
 *                        (纯指令流约定,§三.4.3:填充必须落编码表)。
 */

import type { ArchBits, EncodingTableEntry, PublicChallengeDescriptor } from "@stackmaster/challenge-schema";
import { MAX_IR_INSTRUCTIONS } from "@stackmaster/challenge-schema";
import type { CompiledIr } from "@stackmaster/challenge-schema/server-only";
import { compilerViolation, type CompilerViolation } from "../common/diagnostics.js";
import type { AuthorOperand, AuthorProgram } from "../ir/labels.js";
import { buildLabelIndexMap, resolveEntrypointIndex, resolveInstructionOperands } from "../ir/labels.js";
import { validateInstructionOperands, validateInstructionShape } from "../ir/opcode-shapes.js";

/** 字节模式目标几何与填充声明。 */
export interface ByteModeOptions {
  readonly codeRegion: {
    readonly startAddressHex: string;
    readonly byteLength: number;
  };
  /** 程序起始字节偏移(区域相对;缺省 0——入口即 gadget 场景可偏移)。 */
  readonly entryOffsetBytes?: number;
  /** 尾部填充 token(必须存在于编码表且零内联字节;缺省 = 不填充)。 */
  readonly padTokenHex?: string;
}

export interface ByteCodeProduct {
  readonly mode: "byte";
  readonly entrypointAddressHex: string;
  /** 代码区完整内容(前置零 + 程序编码 + 填充 token)。 */
  readonly contentHex: string;
  /** 程序编码结束偏移(区域相对;填充自该偏移开始)。 */
  readonly programEndOffsetBytes: number;
}

export type CompileProgramResult =
  | { readonly ok: true; readonly mode: "ir"; readonly compiledIr: CompiledIr }
  | { readonly ok: true; readonly mode: "byte"; readonly code: ByteCodeProduct }
  | { readonly ok: false; readonly diagnostics: readonly CompilerViolation[] };

/** 定宽小端编码(负位移按补码;越域值由调用方先行拒绝)。 */
function toLittleEndianHex(value: bigint, byteWidth: number): string {
  const modulus = 1n << BigInt(byteWidth * 8);
  const normalized = ((value % modulus) + modulus) % modulus;
  const hex = normalized.toString(16).padStart(byteWidth * 2, "0");
  return (hex.match(/../g) ?? []).reverse().join("");
}

/** IR 模式编译:标签 → 内联指令索引立即数。 */
export function compileIrProgram(
  program: AuthorProgram,
): { ok: true; compiledIr: CompiledIr } | { ok: false; diagnostics: CompilerViolation[] } {
  const diagnostics: CompilerViolation[] = [];
  const labelMap = buildLabelIndexMap(program);
  diagnostics.push(...labelMap.violations);
  const entry = resolveEntrypointIndex(program, labelMap.labelIndex);
  diagnostics.push(...entry.violations);
  const resolved = resolveInstructionOperands(
    program.instructions,
    (labelId) => {
      const index = labelMap.labelIndex.get(labelId);
      return index === undefined ? undefined : BigInt(index);
    },
  );
  diagnostics.push(...resolved.violations);
  // 形态校验(无寄存器环境:引用可解析性由装载管线按私有初始寄存器集复核)。
  resolved.instructions.forEach((instruction, index) => {
    diagnostics.push(...validateInstructionShape(instruction, index));
  });
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  return {
    ok: true,
    compiledIr: {
      irFormatVersion: 2,
      entrypointIndex: entry.entrypointIndex,
      instructions: resolved.instructions,
      labels: program.labels ?? [],
    },
  };
}

/** 编码表候选匹配:op 相同且操作数形态逐位兼容(寄存器 / 接口号烘焙等值)。 */
function matchEncodingEntry(
  op: string,
  authorOperands: readonly AuthorOperand[],
  table: readonly EncodingTableEntry[],
): { entry: EncodingTableEntry | null; ambiguous: boolean } {
  const candidates = table.filter((entry) => {
    if (entry.op !== op) {
      return false;
    }
    const shapes = entry.operands ?? [];
    if (shapes.length !== authorOperands.length) {
      return false;
    }
    return shapes.every((shape, index) => {
      const operand = authorOperands[index];
      if (operand === undefined) {
        return false;
      }
      if (shape.kind === "register") {
        return operand.kind === "register" && operand.name === shape.name;
      }
      if (shape.kind === "immediate") {
        return operand.kind === "immediate" || operand.kind === "label";
      }
      if (shape.kind === "memory") {
        return operand.kind === "memory" && operand.baseRegister === shape.baseRegister;
      }
      return operand.kind === "interface" && operand.interfaceId === shape.interfaceId;
    });
  });
  if (candidates.length === 0) {
    return { entry: null, ambiguous: false };
  }
  if (candidates.length > 1) {
    return { entry: null, ambiguous: true };
  }
  return { entry: candidates[0] ?? null, ambiguous: false };
}

/**
 * 字节模式编译:查表编码 + 标签 → 绝对字节地址内联。
 * 产物为代码区完整 contentHex(前置零 + 程序编码 + 填充 token)。
 */
export function compileByteProgram(
  program: AuthorProgram,
  publicDescriptor: PublicChallengeDescriptor,
  options: ByteModeOptions,
): { ok: true; code: ByteCodeProduct } | { ok: false; diagnostics: CompilerViolation[] } {
  const diagnostics: CompilerViolation[] = [];
  const table = publicDescriptor.vmProfile.encodingTable ?? [];
  const archBits: ArchBits = publicDescriptor.vmProfile.archBits;
  const archBytes = archBits / 8;
  const unsignedMax = (1n << BigInt(archBits)) - 1n;
  const signedMin = -(1n << BigInt(archBits - 1));
  const signedMax = (1n << BigInt(archBits - 1)) - 1n;
  const regionStart = BigInt(options.codeRegion.startAddressHex);
  const entryOffset = options.entryOffsetBytes ?? 0;

  if (!Number.isInteger(entryOffset) || entryOffset < 0 || entryOffset >= options.codeRegion.byteLength) {
    diagnostics.push(compilerViolation(
      "XC-ENC-OVERFLOW",
      `程序入口偏移 ${entryOffset} 出界(0 ≤ 偏移 < ${options.codeRegion.byteLength})`,
      "/options/entryOffsetBytes",
    ));
    return { ok: false, diagnostics };
  }

  const labelMap = buildLabelIndexMap(program);
  diagnostics.push(...labelMap.violations);
  const entry = resolveEntrypointIndex(program, labelMap.labelIndex);
  diagnostics.push(...entry.violations);
  // 形态校验:标签槽位以占位立即数过冻结形态表(值合法性由第二遍按目标检查)。
  const shapeChecked = resolveInstructionOperands(program.instructions, () => 0n);
  diagnostics.push(...shapeChecked.violations);
  if (diagnostics.length === 0) {
    const registerNames = new Set(publicDescriptor.vmProfile.registers.map((register) => register.name));
    shapeChecked.instructions.forEach((instruction, index) => {
      diagnostics.push(...validateInstructionOperands(instruction, index, registerNames));
    });
  }
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  // 第一遍:token 匹配 + 偏移计算(内联定宽,标签值不影响编码长度)。
  interface EncodedInstruction {
    readonly entry: EncodingTableEntry;
    readonly offsetBytes: number;
  }
  const encoded: EncodedInstruction[] = [];
  let cursor = entryOffset;
  for (const instruction of shapeChecked.instructions) {
    if (encoded.length >= MAX_IR_INSTRUCTIONS) {
      diagnostics.push(compilerViolation(
        "XC-ENC-OVERFLOW",
        `程序指令数超过 ${MAX_IR_INSTRUCTIONS} 条上限(MAX_IR_INSTRUCTIONS 同护栏)`,
        "/instructions",
      ));
      break;
    }
    const match = matchEncodingEntry(
      instruction.op,
      program.instructions[encoded.length]?.operands ?? [],
      table,
    );
    if (match.ambiguous) {
      diagnostics.push(compilerViolation(
        "XC-ENC-AMBIGUOUS",
        `指令 ${encoded.length}(${instruction.op})的操作数形态命中多个 token,编码不唯一;` +
          `调整编码表条目使每形态唯一`,
        `/instructions/${encoded.length}`,
      ));
      break;
    }
    const matched = match.entry;
    if (matched === null) {
      diagnostics.push(compilerViolation(
        "XC-ENC-NO-MATCH",
        `指令 ${encoded.length}(${instruction.op})在 encodingTable 无匹配 token ` +
          `(op 与操作数形态——含烘焙寄存器 / 接口号——须逐位声明)`,
        `/instructions/${encoded.length}`,
      ));
      break;
    }
    encoded.push({ entry: matched, offsetBytes: cursor });
    const inlineCount = (matched.operands ?? []).filter(
      (shape) => shape.kind === "immediate" || shape.kind === "memory",
    ).length;
    cursor += 1 + inlineCount * archBytes;
  }
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const programEndOffset = cursor;
  if (programEndOffset > options.codeRegion.byteLength) {
    diagnostics.push(compilerViolation(
      "XC-ENC-OVERFLOW",
      `程序编码 ${programEndOffset} 字节越出代码区(${options.codeRegion.byteLength} 字节)`,
      "/options/codeRegion/byteLength",
    ));
    return { ok: false, diagnostics };
  }

  // 填充 token:必须存在且零内联字节(纯指令流约定;无副作用 NOP 由作者声明)。
  const padToken = options.padTokenHex === undefined
    ? null
    : table.find((candidate) => candidate.tokenHex.toLowerCase() === options.padTokenHex?.toLowerCase()) ?? null;
  if (options.padTokenHex !== undefined && (padToken === null || (padToken?.operands ?? []).length > 0)) {
    diagnostics.push(compilerViolation(
      "XC-ENC-PAD",
      `填充 token ${options.padTokenHex} 必须存在于编码表且零内联字节(纯指令流约定,§三.4.3)`,
      "/options/padTokenHex",
    ));
  } else if (programEndOffset < options.codeRegion.byteLength && padToken === null) {
    diagnostics.push(compilerViolation(
      "XC-ENC-PAD",
      `代码区尾部需 ${options.codeRegion.byteLength - programEndOffset} 字节填充但未声明 ` +
        `padTokenHex(填充必须落编码表,不能用任意字节)`,
      "/options/padTokenHex",
    ));
  }
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  // 第二遍:回填标签目标(绝对字节地址)并逐指令组装字节流。
  const programBytes: string[] = [];
  encoded.forEach((item, instructionIndex) => {
    programBytes.push(item.entry.tokenHex.toLowerCase().slice(2));
    const authorOperands = program.instructions[instructionIndex]?.operands ?? [];
    (item.entry.operands ?? []).forEach((shape, operandIndex) => {
      if (shape.kind !== "immediate" && shape.kind !== "memory") {
        return; // 寄存器 / 接口号烘焙进 token,无内联字节。
      }
      const operand = authorOperands[operandIndex];
      let value = 0n;
      let isDisplacement = false;
      if (operand?.kind === "immediate") {
        value = BigInt(operand.valueHex);
      } else if (operand?.kind === "memory") {
        value = operand.displacementHex !== undefined ? BigInt(operand.displacementHex) : 0n;
        isDisplacement = true;
      } else if (operand?.kind === "label") {
        const targetIndex = labelMap.labelIndex.get(operand.labelId);
        const targetOffset = targetIndex === undefined ? undefined : encoded[targetIndex]?.offsetBytes;
        if (targetOffset === undefined) {
          diagnostics.push(compilerViolation(
            "XC-LABEL-REF",
            `指令 ${instructionIndex} 引用的标签 "${operand.labelId}" 无法消解到编码偏移`,
            `/instructions/${instructionIndex}/operands/${operandIndex}`,
          ));
        }
        value = regionStart + BigInt(targetOffset ?? 0);
      }
      // 值域:立即数 / 地址无符号域;位移有符号域(XS-ARCH-WIDTH 同一域)。
      const inRange = isDisplacement
        ? value >= signedMin && value <= signedMax
        : value >= 0n && value <= unsignedMax;
      if (!inRange) {
        diagnostics.push(compilerViolation(
          "XC-ENC-VALUE-RANGE",
          `指令 ${instructionIndex} 的内联${isDisplacement ? "位移" : "立即数"} ${value} ` +
            `越出 archBits=${archBits} ${isDisplacement ? "有符号" : "无符号"}位宽域`,
          `/instructions/${instructionIndex}/operands/${operandIndex}`,
        ));
      }
      programBytes.push(toLittleEndianHex(value, archBytes));
    });
  });
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const prefixZero = "00".repeat(entryOffset);
  const padHex = padToken !== null && programEndOffset < options.codeRegion.byteLength
    ? padToken.tokenHex.toLowerCase().slice(2).repeat(options.codeRegion.byteLength - programEndOffset)
    : "";
  const contentHex = prefixZero + programBytes.join("") + padHex;

  return {
    ok: true,
    code: {
      mode: "byte",
      entrypointAddressHex: `0x${(regionStart + BigInt(entryOffset)).toString(16)}`,
      contentHex,
      programEndOffsetBytes: programEndOffset,
    },
  };
}

/**
 * 双模式编译入口:按公开包 encodingTable 有无分派(与 XS-PROG-MODE 同判据)。
 * IR 模式忽略字节模式选项;字节模式产物(合入私有包代码区后)必须再走
 * `loadChallengePair` 全量校验。
 */
export function compileProgram(
  program: AuthorProgram,
  publicDescriptor: PublicChallengeDescriptor,
  byteOptions?: ByteModeOptions,
): CompileProgramResult {
  if (publicDescriptor.vmProfile.encodingTable === undefined) {
    const result = compileIrProgram(program);
    return result.ok ? { ok: true, mode: "ir", compiledIr: result.compiledIr } : result;
  }
  if (byteOptions === undefined) {
    return {
      ok: false,
      diagnostics: [compilerViolation(
        "XC-ENC-PAD",
        "字节模式编译必须提供 codeRegion 几何(options.codeRegion)——表层机器码为唯一权威执行空间",
        "/options/codeRegion",
      )],
    };
  }
  const result = compileByteProgram(program, publicDescriptor, byteOptions);
  return result.ok ? { ok: true, mode: "byte", code: result.code } : result;
}

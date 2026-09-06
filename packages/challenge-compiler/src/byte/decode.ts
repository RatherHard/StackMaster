/**
 * 字节模式装载:入口探测译码 → 译码产物(WP-2"编码表装载")。
 *
 * 字节权威执行模式(G5/D6):代码区 contentHex 即可执行空间,地址 = 字节
 * 偏移;装载按公开 encodingTable 自 `entrypointAddressHex` 线性取指译码
 * (≤ 4096 条或区域尾止,D4.6)。前置条件:双包 Schema + WP-4 检查器
 * (XS-ENC-TOKEN / XS-ENC-PROBE / XS-CODE-WRX 等)已全量通过——本模块把
 * 探测译码的**产物**(指令流 + 内联操作数值)构造为装载产物,供会话编排
 * 与 WP-9 跨模式一致性测试消费。
 *
 * 操作数内联自证(D4.6/D4.7):立即数 / 位移恰 archBits/8 字节小端,任意
 * 位型都在掩蔽域内(XS-ARCH-WIDTH 在译码产物上结构性不触发;仅值型检查
 * ——syscall 派发带 / 接口声明 / 助记符 / RBP——由 XS-ENC-PROBE 前置完成)。
 * 防御性声明:检查器全绿后译码不应失败;若失败(探测实现漂移或并发篡改),
 * 按 fail-closed 记 XS-ENC-PROBE 违规,不近似执行。
 */

import type { EncodingTableEntry, PublicChallengeDescriptor } from "@stackmaster/challenge-schema";
import { MAX_IR_INSTRUCTIONS } from "@stackmaster/challenge-schema";
import type { PrivateChallengeBundle } from "@stackmaster/challenge-schema/server-only";
import { compilerViolation, type CompilerViolation } from "../common/diagnostics.js";

/** 译码后的操作数值(内联自证后提取;数值以 BigInt 承载)。 */
export type DecodedOperand =
  | { readonly kind: "register"; readonly name: string }
  | { readonly kind: "immediate"; readonly value: bigint }
  | { readonly kind: "memory"; readonly baseRegister?: string; readonly displacement: bigint }
  | { readonly kind: "interface"; readonly interfaceId: number };

/** 译码产物中的单条指令(地址 = 代码区内字节偏移)。 */
export interface DecodedByteInstruction {
  readonly op: string;
  /** token 在代码区内的字节偏移(区域相对)。 */
  readonly offsetBytes: number;
  readonly tokenHex: string;
  readonly operands: readonly DecodedOperand[];
}

/** 字节模式装载产物(编码表装载;入口地址为绝对地址形态)。 */
export interface ByteLoadedProgram {
  readonly mode: "byte";
  readonly regionId: string;
  readonly entrypointAddressHex: string;
  readonly instructions: readonly DecodedByteInstruction[];
}

function parseHexByte(tokenHex: string): number {
  return Number.parseInt(tokenHex.slice(2), 16);
}

/** 小端读取 width 字节(D4.7:立即数 / 位移定宽 archBits/8、小端)。 */
function readLittleEndian(bytesHex: string, byteOffset: number, width: number): bigint {
  const slice = bytesHex.slice(byteOffset * 2, (byteOffset + width) * 2);
  const bytes = slice.match(/../g) ?? [];
  return BigInt(`0x${bytes.reverse().join("") || "0"}`);
}

function inlineOperandWidths(entry: EncodingTableEntry): readonly ("immediate" | "displacement")[] {
  return (entry.operands ?? []).map((operand) => {
    if (operand.kind === "immediate") {
      return "immediate" as const;
    }
    if (operand.kind === "memory" && operand.displacementWidth === "arch") {
      return "displacement" as const;
    }
    return null;
  }).filter((item): item is "immediate" | "displacement" => item !== null);
}

/**
 * 入口探测译码产物构造。输入须为已通过 Schema + WP-4 检查器的双包;
 * 译码异常一律 fail-closed(返回违规,不产出部分程序)。
 */
export function decodeByteProgram(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): { program: ByteLoadedProgram; violations: CompilerViolation[] } {
  const violations: CompilerViolation[] = [];
  const table = publicDescriptor.vmProfile.encodingTable ?? [];
  const byToken = new Map<number, EncodingTableEntry>(
    table.map((entry) => [parseHexByte(entry.tokenHex), entry]),
  );
  const codeRegionIndex = privateBundle.initialState.memoryRegions.findIndex(
    (region) => region.kind === "code",
  );
  const codeRegion = privateBundle.initialState.memoryRegions[codeRegionIndex];
  const entrypointHex = privateBundle.entrypointAddressHex ?? "0x0";
  const regionStart = BigInt(codeRegion?.startAddressHex ?? "0x0");
  const entryOffset = BigInt(entrypointHex) - regionStart;
  const archBytes = publicDescriptor.vmProfile.archBits / 8;

  const instructions: DecodedByteInstruction[] = [];
  let cursor = Number(entryOffset);
  let guard = 0;
  while (codeRegion !== undefined && cursor < codeRegion.byteLength && guard < MAX_IR_INSTRUCTIONS) {
    guard += 1;
    const tokenHex = codeRegion.contentHex.slice(cursor * 2, cursor * 2 + 2);
    const entry = byToken.get(Number.parseInt(tokenHex, 16));
    if (entry === undefined || tokenHex.length !== 2) {
      violations.push(compilerViolation(
        "XS-ENC-PROBE",
        `代码区偏移 ${cursor} 的 token ${tokenHex || "(截断)"} 未在 encodingTable 声明(译码层复核,探测检查器应已先行拒绝)`,
        `/initialState/memoryRegions/${codeRegionIndex}/contentHex`,
      ));
      break;
    }
    const widths = inlineOperandWidths(entry);
    const inlineBytes = widths.length * archBytes;
    if (cursor + 1 + inlineBytes > codeRegion.byteLength) {
      violations.push(compilerViolation(
        "XS-ENC-PROBE",
        `代码区偏移 ${cursor} 的 ${entry.op} 操作数字节越出区域尾(译码层复核)`,
        `/initialState/memoryRegions/${codeRegionIndex}/contentHex`,
      ));
      break;
    }
    // 内联操作数取值(小端,恰 archBits/8 字节——宽度自证)。
    const operandValues: bigint[] = [];
    let valueCursor = cursor + 1;
    for (const _width of widths) {
      // 内联宽度恒为 archBytes(widths 只承载槽位个数;自证即恒定宽度)。
      void _width;
      operandValues.push(readLittleEndian(codeRegion.contentHex, valueCursor, archBytes));
      valueCursor += archBytes;
    }
    const decodedOperands: DecodedOperand[] = [];
    let valueIndex = 0;
    for (const shape of entry.operands ?? []) {
      if (shape.kind === "register") {
        decodedOperands.push({ kind: "register", name: shape.name });
      } else if (shape.kind === "immediate") {
        decodedOperands.push({ kind: "immediate", value: operandValues[valueIndex] ?? 0n });
        valueIndex += 1;
      } else if (shape.kind === "memory") {
        decodedOperands.push({
          kind: "memory",
          baseRegister: shape.baseRegister,
          displacement: operandValues[valueIndex] ?? 0n,
        });
        valueIndex += 1;
      } else {
        decodedOperands.push({ kind: "interface", interfaceId: shape.interfaceId });
      }
    }
    instructions.push({
      op: entry.op,
      offsetBytes: cursor,
      tokenHex: tokenHex.toLowerCase(),
      operands: decodedOperands,
    });
    cursor += 1 + inlineBytes;
  }

  return {
    program: {
      mode: "byte",
      regionId: codeRegion?.regionId ?? "",
      entrypointAddressHex: entrypointHex,
      instructions,
    },
    violations,
  };
}

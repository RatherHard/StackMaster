/**
 * P5 表层机器码检查规则(G5/D6)。
 *
 * 字节模式以公开 encodingTable 声明 ISA,以私有代码区 contentHex 作为唯一
 * 权威代码空间;本模块只做声明一致性、W^X 与入口线性探测,不执行任何宿主代码。
 * SERVER_ONLY:输入包含私有代码字节与接口声明,仅供后端包消费。
 */

import {
  MAX_ENCODING_TABLE_ENTRIES,
  MAX_IR_INSTRUCTIONS,
} from "../../common/limits.js";
import { CUSTOM_MNEMONIC_PATTERN, GENERAL_REGISTER_NAME_PATTERN } from "../../common/patterns.js";
import { DSL_OPCODES, RESERVED_SYSCALL_BAND_MAX } from "../../common/vocabulary.js";
import type { EncodingTableEntry, PublicChallengeDescriptor } from "../../common/public-types.js";
import type { PrivateChallengeBundle } from "../private-types.js";
import { parseAddressHex, rangeExceedsAddressSpace } from "./address-ranges.js";
import type { CheckerViolation } from "./types.js";

const BASELINE_OP_SET = new Set<string>(DSL_OPCODES);
const ARCH_OPERAND_WIDTH = "arch";

function violation(
  ruleId: string,
  message: string,
  path: string,
): CheckerViolation {
  return { ruleId, message, path };
}

function codeRegions(
  descriptor: PublicChallengeDescriptor,
): ReadonlyArray<{ readonly regionId: string; readonly startAddressHex: string; readonly byteLength: number; readonly permissions: string }> {
  return descriptor.memoryLayout.regions.filter((region) => region.kind === "code");
}

function privateCodeRegions(
  bundle: PrivateChallengeBundle,
): ReadonlyArray<{ readonly regionId: string; readonly startAddressHex: string; readonly byteLength: number; readonly permissions: string; readonly contentHex: string; readonly isHidden: boolean }> {
  return bundle.initialState.memoryRegions.filter((region) => region.kind === "code");
}

function hasEncodingTable(
  descriptor: PublicChallengeDescriptor,
): boolean {
  return descriptor.vmProfile.encodingTable !== undefined;
}

/** XS-PROG-MODE:双程序形态恰一,且字节模式入口存在。 */
export function checkProgramMode(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const byteMode = hasEncodingTable(publicDescriptor);
  const hasIr = privateBundle.compiledIr !== undefined;
  const hasEntrypoint = privateBundle.entrypointAddressHex !== undefined;

  if (byteMode && hasIr) {
    violations.push(violation(
      "XS-PROG-MODE",
      "公开包声明 encodingTable 时必须使用字节模式,私有包不得同时提供 compiledIr",
      "/compiledIr",
    ));
  }
  if (byteMode && !hasEntrypoint) {
    violations.push(violation(
      "XS-PROG-MODE",
      "字节模式必须提供私有入口地址 entrypointAddressHex",
      "/entrypointAddressHex",
    ));
  }
  if (!byteMode && !hasIr) {
    violations.push(violation(
      "XS-PROG-MODE",
      "未声明 encodingTable 时必须提供 IR 程序 compiledIr",
      "/compiledIr",
    ));
  }
  if (!byteMode && hasEntrypoint) {
    violations.push(violation(
      "XS-PROG-MODE",
      "IR 模式不得提供字节模式入口地址 entrypointAddressHex",
      "/entrypointAddressHex",
    ));
  }
  return violations;
}

/** XS-CODE-WRX:字节模式代码区必须为不可写的可执行代码。 */
export function checkCodeRegionWritability(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CheckerViolation[] {
  if (!hasEncodingTable(publicDescriptor)) {
    return [];
  }
  const violations: CheckerViolation[] = [];
  publicDescriptor.memoryLayout.regions.forEach((region, index) => {
    if (region.kind === "code" && (!region.permissions.includes("x") || region.permissions.includes("w"))) {
      violations.push(violation(
        "XS-CODE-WRX",
        `公开代码区域 ${region.regionId} 权限 ${region.permissions} 必须可执行且不可写,字节模式代码区必须实施 W^X`,
        `/memoryLayout/regions/${index}/permissions`,
      ));
    }
  });
  privateBundle.initialState.memoryRegions.forEach((region, index) => {
    if (region.kind === "code" && (!region.permissions.includes("x") || region.permissions.includes("w"))) {
      violations.push(violation(
        "XS-CODE-WRX",
        `私有代码区域 ${region.regionId} 权限 ${region.permissions} 必须可执行且不可写,字节模式代码区必须实施 W^X`,
        `/initialState/memoryRegions/${index}/permissions`,
      ));
    }
  });
  return violations;
}

function checkShapeReferences(
  entry: EncodingTableEntry,
  entryIndex: number,
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
  violations: CheckerViolation[],
): void {
  const registerNames = new Set(publicDescriptor.vmProfile.registers.map((register) => register.name));
  const interfaceIds = new Set((privateBundle.interfaces ?? []).map((entry) => entry.interfaceId));
  (entry.operands ?? []).forEach((operand, operandIndex) => {
    const path = `/vmProfile/encodingTable/${entryIndex}/operands/${operandIndex}`;
    // R12 冻结:immediate.width 与 memory.displacementWidth 必填且恰为 arch
    // ——表层机器码内联字节宽度不得依赖任何执行层的隐式推断;FLAG 寄存器
    // 由 GENERAL_REGISTER_NAME_PATTERN 结构性排除(R11:FLAG 不可编码)。
    if (operand.kind === "register") {
      if (!GENERAL_REGISTER_NAME_PATTERN.test(operand.name) || !registerNames.has(operand.name)) {
        violations.push(violation(
          "XS-ENC-TOKEN",
          `编码表条目 ${entryIndex} 引用的寄存器 "${operand.name}" 未在公开寄存器声明集`,
          `${path}/name`,
        ));
      }
    } else if (operand.kind === "memory") {
      if (!GENERAL_REGISTER_NAME_PATTERN.test(operand.baseRegister) || !registerNames.has(operand.baseRegister)) {
        violations.push(violation(
          "XS-ENC-TOKEN",
          `编码表条目 ${entryIndex} 引用的内存基址寄存器 "${operand.baseRegister}" 未在公开寄存器声明集`,
          `${path}/baseRegister`,
        ));
      }
      if (operand.displacementWidth !== ARCH_OPERAND_WIDTH) {
        violations.push(violation(
          "XS-ENC-TOKEN",
          `编码表条目 ${entryIndex} 的 displacementWidth 必填且必须为 arch(内联位移 = archBits/8 字节,R12)`,
          `${path}/displacementWidth`,
        ));
      }
    } else if (operand.kind === "interface" && !interfaceIds.has(operand.interfaceId)) {
      violations.push(violation(
        "XS-ENC-TOKEN",
        `编码表条目 ${entryIndex} 引用的接口号 ${operand.interfaceId} 未在 interfaces 声明`,
        `${path}/interfaceId`,
      ));
    } else if (operand.kind === "immediate" && operand.width !== ARCH_OPERAND_WIDTH) {
      violations.push(violation(
        "XS-ENC-TOKEN",
        `编码表条目 ${entryIndex} 的 immediate width 必填且必须为 arch(内联立即数 = archBits/8 字节,R12)`,
        `${path}/width`,
      ));
    }
  });
}

function checkOpcodeShape(
  entry: EncodingTableEntry,
  entryIndex: number,
  privateBundle: PrivateChallengeBundle,
  violations: CheckerViolation[],
): void {
  const operands = entry.operands ?? [];
  const path = `/vmProfile/encodingTable/${entryIndex}/operands`;
  if (entry.op === "syscall" && (operands.length !== 1 || operands[0]?.kind !== "immediate")) {
    violations.push(violation("XS-ENC-TOKEN", "syscall 编码必须恰好声明一个 immediate 操作数", path));
  }
  if (entry.op === "call" && (operands.length !== 1 || !["immediate", "register", "interface"].includes(operands[0]?.kind ?? ""))) {
    violations.push(violation("XS-ENC-TOKEN", "call 编码必须恰好声明一个 immediate、register 或 interface 操作数", path));
  }
  if ((entry.op === "ret" || entry.op === "leave") && operands.length !== 0) {
    violations.push(violation("XS-ENC-TOKEN", `${entry.op} 编码不得声明操作数`, path));
  }
  if (entry.op === "leave" && !("RBP" in privateBundle.initialState.registers)) {
    violations.push(violation(
      "XS-IR-LEAVE",
      "字节模式含 leave 指令但私有初始寄存器集不含 RBP",
      `/vmProfile/encodingTable/${entryIndex}/op`,
    ));
  }
  if (!BASELINE_OP_SET.has(entry.op)) {
    const declared = new Set((privateBundle.customInstructions ?? []).map((instruction) => instruction.mnemonic));
    if (!CUSTOM_MNEMONIC_PATTERN.test(entry.op) || !declared.has(entry.op)) {
      violations.push(violation(
        "XS-ENC-TOKEN",
        `编码表条目 ${entryIndex} 的自定义助记符 "${entry.op}" 未在 customInstructions 声明`,
        `/vmProfile/encodingTable/${entryIndex}/op`,
      ));
    }
    if (operands.length !== 0) {
      violations.push(violation("XS-ENC-TOKEN", `自定义助记符 ${entry.op} 的操作数必须烘焙在 token 中`, path));
    }
  }
}

/** XS-ENC-TOKEN:token 唯一、opcode 与烘焙引用可解析、形态符合封闭规则。 */
export function checkEncodingTable(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CheckerViolation[] {
  if (!hasEncodingTable(publicDescriptor)) {
    return [];
  }
  const table = publicDescriptor.vmProfile.encodingTable ?? [];
  const violations: CheckerViolation[] = [];
  // R13 纵深防御:encodingTable 存在即字节模式,空表必须失败关闭,
  // 不得静默退回 IR 模式(Schema minItems = 1 之外的直接调用防线)。
  if (table.length === 0) {
    violations.push(violation(
      "XS-ENC-TOKEN",
      "encodingTable 存在但为空数组:字节模式声明必须是非空有效表(R13 失败关闭,不回退 IR 模式)",
      "/vmProfile/encodingTable",
    ));
    return violations;
  }
  if (table.length > MAX_ENCODING_TABLE_ENTRIES) {
    violations.push(violation("XS-ENC-TOKEN", `encodingTable 条数 ${table.length} 超过上限 ${MAX_ENCODING_TABLE_ENTRIES}`, "/vmProfile/encodingTable"));
  }
  const seen = new Map<string, number>();
  table.forEach((entry, index) => {
    const token = entry.tokenHex.toLowerCase();
    const firstIndex = seen.get(token);
    if (firstIndex !== undefined) {
      violations.push(violation("XS-ENC-TOKEN", `token ${entry.tokenHex} 与第 ${firstIndex} 项重复`, `/vmProfile/encodingTable/${index}/tokenHex`));
    } else {
      seen.set(token, index);
    }
    if (!BASELINE_OP_SET.has(entry.op) && !CUSTOM_MNEMONIC_PATTERN.test(entry.op)) {
      violations.push(violation("XS-ENC-TOKEN", `编码表条目 ${index} 的 op "${entry.op}" 不属于封闭 opcode/助记符词汇`, `/vmProfile/encodingTable/${index}/op`));
    }
    checkShapeReferences(entry, index, publicDescriptor, privateBundle, violations);
    checkOpcodeShape(entry, index, privateBundle, violations);
  });
  return violations;
}

function readLittleEndian(bytesHex: string, byteOffset: number, width: number): bigint {
  const bytes = bytesHex.slice(byteOffset * 2, (byteOffset + width) * 2).match(/../g) ?? [];
  return BigInt(`0x${bytes.reverse().join("") || "0"}`);
}

/** XS-ENC-PROBE:入口在代码区,从入口线性取指至末尾并拒绝未知/截断 token。 */
export function checkEncodingProbe(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CheckerViolation[] {
  if (!hasEncodingTable(publicDescriptor) || privateBundle.entrypointAddressHex === undefined) {
    return [];
  }
  const table = publicDescriptor.vmProfile.encodingTable ?? [];
  const byToken = new Map<number, EncodingTableEntry>(table.map((entry) => [Number.parseInt(entry.tokenHex.slice(2), 16), entry]));
  const startAddress = parseAddressHex(privateBundle.entrypointAddressHex);
  const publicCode = codeRegions(publicDescriptor);
  const code = privateCodeRegions(privateBundle);
  if (publicCode.length !== 1 || code.length !== 1 || code[0]?.isHidden === true) {
    return [violation("XS-ENC-PROBE", "字节模式必须恰有一个公开且非隐藏的代码区", "/initialState/memoryRegions")];
  }
  const publicCodeRegion = publicCode[0];
  const codeRegion = code[0];
  if (publicCodeRegion === undefined || codeRegion === undefined) {
    return [violation("XS-ENC-PROBE", "字节模式必须恰有一个公开且非隐藏的代码区", "/initialState/memoryRegions")];
  }
  if (publicCodeRegion.regionId !== codeRegion.regionId) {
    return [violation("XS-ENC-PROBE", "私有代码区必须与公开代码区按 regionId 对应", "/initialState/memoryRegions")];
  }
  const codeStart = parseAddressHex(codeRegion.startAddressHex);
  const codeEnd = codeStart + BigInt(codeRegion.byteLength);
  // R4:统一经 address-ranges 常量判定 64 位上溢(与 XS-ADDR-SPACE 同一公式)。
  if (rangeExceedsAddressSpace({ start: codeStart, endExclusive: codeEnd })) {
    return [violation("XS-ENC-PROBE", "代码区域地址范围越出 64 位地址空间(结束地址必须 ≤ 2^64,R4)", "/initialState/memoryRegions")];
  }
  if (startAddress < codeStart || startAddress >= codeEnd) {
    return [violation("XS-ENC-PROBE", `入口地址 ${privateBundle.entrypointAddressHex} 不在私有代码区`, "/entrypointAddressHex")];
  }
  // 诊断路径必须锚定区域在 initialState.memoryRegions 全数组中的真实下标
  // (过滤后的 code 数组下标在代码区非首位时指错区域)。
  const codeIndex = privateBundle.initialState.memoryRegions.findIndex(
    (region) => region === codeRegion,
  );
  const codeContentPath = `/initialState/memoryRegions/${codeIndex}/contentHex`;
  const offset = Number(startAddress - codeStart);
  let cursor = offset;
  let instructionCount = 0;
  const archBytes = publicDescriptor.vmProfile.archBits / 8;
  const violations: CheckerViolation[] = [];
  while (cursor < codeRegion.byteLength && instructionCount < MAX_IR_INSTRUCTIONS) {
    const byteHex = codeRegion.contentHex.slice(cursor * 2, cursor * 2 + 2);
    const entry = byToken.get(Number.parseInt(byteHex, 16));
    if (entry === undefined) {
      violations.push(violation("XS-ENC-PROBE", `代码区地址 ${cursor} 的 token ${byteHex} 未在 encodingTable 声明`, codeContentPath));
      break;
    }
    const inlineBytes = (entry.operands ?? []).reduce((total, operand) => {
      if (operand.kind === "immediate" || operand.kind === "memory" && operand.displacementWidth === ARCH_OPERAND_WIDTH) {
        return total + archBytes;
      }
      return total;
    }, 0);
    if (cursor + 1 + inlineBytes > codeRegion.byteLength) {
      violations.push(violation("XS-ENC-PROBE", `入口探测到 ${entry.op} 时操作数字节越出代码区末尾`, codeContentPath));
      break;
    }
    if (entry.op === "syscall") {
      const syscallOperand = (entry.operands ?? [])[0];
      if (syscallOperand?.kind === "immediate") {
        const value = readLittleEndian(codeRegion.contentHex, (cursor + 1), archBytes);
        const interfaceIds = new Set((privateBundle.interfaces ?? []).map((item) => item.interfaceId));
        if (value > BigInt(RESERVED_SYSCALL_BAND_MAX) && !interfaceIds.has(Number(value))) {
          violations.push(violation("XS-ENC-PROBE", `syscall 内联派发号 ${value.toString()} 未在保留带或 interfaces 声明`, codeContentPath));
        }
      }
    }
    cursor += 1 + inlineBytes;
    instructionCount += 1;
  }
  if (cursor < codeRegion.byteLength && instructionCount >= MAX_IR_INSTRUCTIONS) {
    violations.push(violation("XS-ENC-PROBE", `入口可达指令数超过 ${MAX_IR_INSTRUCTIONS} 条上限`, "/entrypointAddressHex"));
  }
  return violations;
}

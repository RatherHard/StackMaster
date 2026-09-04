/**
 * 私有判题包单侧检查规则(WP-1 §12.6 左列规则 ID):
 *  - I2-PRIV-PAIRWISE 私有初始内存区域两两不相交(BigInt 区间);
 *  - I3-SINK-HIDDEN containsSecret 的私有对象必须 hidden(秘密汇面);
 *  - XS-ID-UNIQUE 私有面引用 ID 唯一(区域 / 对象 / 隐藏测试 / 阶段 / 虚拟文件 /
 *    自定义指令助记符 / 作者接口号);
 *  - XS-REG-NAMESPACE 私有初始寄存器键归属双命名空间之一(G2/D3:一般名
 *    ^(?!FLAG)[A-Z][A-Z0-9_]{0,15}$ 或 FLAG 模式;Schema 负向前瞻之外的纵深防御,
 *    随 XS-REG-FROZEN 废止而接替其防线);
 *  - XS-SEED-POLICY seed 策略与固定 seed 互斥(R5:fixed ⇒ seedHex 必填,
 *    server_random_per_session ⇒ seedHex 禁止;Schema if/then/else 之外第二道防线);
 *  - D2-CODE-PUBLIC 私有面 kind=code 区域不得隐藏(R10 冻结:代码区恒公开);
 *  - XS-ADDR-SPACE 私有区域与私有对象地址区间不得越出 2^64(R4 统一半开区间);
 *  - XS-MEM-TOTAL 区域字节总量 / 初始内容字节总量封顶;
 *  - XS-MEM-CONTENT contentHex 长度 = 2 × byteLength;
 *  - XS-IR-LABEL 标签 ID 唯一且索引落在指令范围内;
 *  - XS-CUSTOM-DEF 自定义指令助记符不与基线 opcode 冲突(G4/D4 纵深防御,
 *    大小写模式已结构性不相交;助记符唯一性归 XS-ID-UNIQUE);
 *  - XS-CUSTOM-REF IR 中非基线 op 必须引用已声明的 customInstructions 助记符;
 *  - XS-SYSCALL-DECL syscall 派发号落在保留系统号带(内置 exit)或已声明接口;
 *  - XS-IFACE-REF call 的 interface 操作数与接口效果引用(fileId / FLAG 寄存器)可解析;
 *  - XS-IR-LEAVE leave 要求私有初始寄存器集含 RBP(栈帧基);
 *  - XS-CUSTOM-DISPLAY 自定义指令 / 接口 displayText 的 E-4/E-6 私有标识扫描;
 *  - XS-STAGE-REACH 迁移目标存在且全部阶段自 stages[0] 可达;
 *  - XS-STAGE-BUDGET 每阶段 maxInstructionSteps ≥ 1;
 *  - XS-PRED-REFS 谓词引用的寄存器 / 区域 / 文件必须存在且切片在界内;
 *  - XS-NESTING 判题条件布尔层深度 ≤ 3(对已过 Schema 的输入是纵深防御);
 *  - XS-MEM-PAGE-ALIGN 私有区域 byteLength 均为 4KB 的倍数(G3/D2;纵深防御,见 arch-rules.ts)。
 *
 * 前置条件:输入已通过 private-bundle.schema.json 校验;对部分仅 Schema
 * 可拒的形态(如深度、EAX 键),本模块做第二道防线,红灯样例经类型断言
 * 直测(绕过前置条件属测试预期,不构成生产用法)。
 */

import {
  GENERAL_REGISTER_NAME_PATTERN,
  FLAG_REGISTER_NAME_PATTERN,
} from "../../common/patterns.js";
import {
  MAX_CONDITION_DEPTH,
  MAX_MEMORY_CONTENT_BYTES,
  MAX_MEMORY_TOTAL_BYTES,
} from "../../common/limits.js";
import { DSL_OPCODES, RESERVED_SYSCALL_BAND_MAX } from "../../common/vocabulary.js";
import type {
  ConditionL1,
  PrivateChallengeBundle,
  PrivatePredicate,
} from "../private-types.js";
import { checkPrivatePageAlignment } from "./arch-rules.js";
import { toAddressRange, rangesOverlap, rangeExceedsAddressSpace } from "./address-ranges.js";
import type { AddressRange } from "./address-ranges.js";
import { pushDuplicateViolations } from "./duplicates.js";
import type { CheckerViolation } from "./types.js";

function memoryRegionRange(region: {
  readonly startAddressHex: string;
  readonly byteLength: number;
}): AddressRange {
  return toAddressRange(region.startAddressHex, region.byteLength);
}

/**
 * XS-SEED-POLICY:seed 策略与固定 seed 互斥(R5;Schema seedPolicy if/then/else
 * 之外的第二道防线)。fixed ⇒ seedHex 必填;server_random_per_session ⇒ seedHex
 * 必须省略——同时出现或双缺都会造成实例化与回放策略歧义,失败关闭。
 */
export function checkSeedPolicy(bundle: PrivateChallengeBundle): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const { strategy, seedHex } = bundle.seedPolicy;
  if (strategy === "fixed" && seedHex === undefined) {
    violations.push({
      ruleId: "XS-SEED-POLICY",
      message: "seedPolicy.strategy = fixed 时必须提供固定 seedHex(可回放前提,6.3)",
      path: "/seedPolicy/seedHex",
    });
  }
  if (strategy === "server_random_per_session" && seedHex !== undefined) {
    violations.push({
      ruleId: "XS-SEED-POLICY",
      message:
        "seedPolicy.strategy = server_random_per_session 时禁止携带固定 seedHex(会话随机与固定 seed 互斥,R5;实例化 seed 只由服务端按会话派生)",
      path: "/seedPolicy/seedHex",
    });
  }
  return violations;
}

/** I2-PRIV-PAIRWISE:私有初始内存区域两两不相交。 */
export function checkPrivateRegionsPairwiseDisjoint(
  bundle: PrivateChallengeBundle,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const regions = bundle.initialState.memoryRegions;
  for (let i = 0; i < regions.length; i += 1) {
    const left = regions[i];
    if (left === undefined) {
      continue;
    }
    for (let j = i + 1; j < regions.length; j += 1) {
      const right = regions[j];
      if (right === undefined) {
        continue;
      }
      if (rangesOverlap(memoryRegionRange(left), memoryRegionRange(right))) {
        violations.push({
          ruleId: "I2-PRIV-PAIRWISE",
          message: `私有内存区域 ${left.regionId} 与 ${right.regionId} 地址区间相交`,
          path: `/initialState/memoryRegions/${j}`,
        });
      }
    }
  }
  return violations;
}

/**
 * D2-CODE-PUBLIC 私有面:kind = code 的初始区域不得隐藏(R10 冻结:
 * 代码区域恒公开,公开侧 ≤ 1 个由 public-rules 承接;字节模式恰一公开 +
 * 恰一非隐藏私有代码区由 XS-ENC-PROBE 承接;此处封住 IR 模式下隐藏代码区
 * 的表达位)。
 */
export function checkPrivateCodeRegionVisibility(bundle: PrivateChallengeBundle): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  bundle.initialState.memoryRegions.forEach((region, index) => {
    if (region.kind === "code" && region.isHidden) {
      violations.push({
        ruleId: "D2-CODE-PUBLIC",
        message: `私有代码区域 ${region.regionId} 不得隐藏(代码区域恒公开,D2)`,
        path: `/initialState/memoryRegions/${index}`,
      });
    }
  });
  return violations;
}

/**
 * XS-ADDR-SPACE 私有侧(R4 统一化):私有初始区域与私有对象登记的
 * 起始地址 + byteLength 不得越出 64 位地址空间(与公开侧同一半开区间
 * 约定、同一常量;上溢必须失败关闭,不得接受差异化的校验路径)。
 */
export function checkPrivateAddressSpaceBounds(bundle: PrivateChallengeBundle): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  bundle.initialState.memoryRegions.forEach((region, index) => {
    if (rangeExceedsAddressSpace(memoryRegionRange(region))) {
      violations.push({
        ruleId: "XS-ADDR-SPACE",
        message: `私有内存区域 ${region.regionId} 地址区间 [${region.startAddressHex}, +${region.byteLength} 字节)越出 64 位地址空间(结束地址必须 ≤ 2^64,R4 半开区间统一约定)`,
        path: `/initialState/memoryRegions/${index}`,
      });
    }
  });
  bundle.privateObjects.forEach((object, index) => {
    if (rangeExceedsAddressSpace(toAddressRange(object.addressHex, object.byteLength))) {
      violations.push({
        ruleId: "XS-ADDR-SPACE",
        message: `私有对象 ${object.objectId} 地址区间 [${object.addressHex}, +${object.byteLength} 字节)越出 64 位地址空间(结束地址必须 ≤ 2^64)`,
        path: `/privateObjects/${index}`,
      });
    }
  });
  return violations;
}

/** I3-SINK-HIDDEN:containsSecret 的私有对象必须 hidden。 */
export function checkSecretSinksAreHidden(
  bundle: PrivateChallengeBundle,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  bundle.privateObjects.forEach((object, index) => {
    if (object.containsSecret && object.visibility !== "hidden") {
      violations.push({
        ruleId: "I3-SINK-HIDDEN",
        message: `私有对象 ${object.objectId} 含秘密但 visibility 为 ${object.visibility},必须 hidden`,
        path: `/privateObjects/${index}`,
      });
    }
  });
  return violations;
}

/** XS-ID-UNIQUE:私有面引用 ID 唯一。 */
export function checkPrivateReferenceUniqueness(
  bundle: PrivateChallengeBundle,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  pushDuplicateViolations(
    violations,
    bundle.initialState.memoryRegions.map((region) => region.regionId),
    (index) => `/initialState/memoryRegions/${index}/regionId`,
    (value) => `私有内存区域 regionId "${value}" `,
  );
  pushDuplicateViolations(
    violations,
    bundle.privateObjects.map((object) => object.objectId),
    (index) => `/privateObjects/${index}/objectId`,
    (value) => `私有对象 objectId "${value}" `,
  );
  pushDuplicateViolations(
    violations,
    (bundle.judging.hiddenTests ?? []).map((test) => test.testId),
    (index) => `/judging/hiddenTests/${index}/testId`,
    (value) => `隐藏测试 testId "${value}" `,
  );
  pushDuplicateViolations(
    violations,
    bundle.secrets.virtualFiles.map((file) => file.fileId),
    (index) => `/secrets/virtualFiles/${index}/fileId`,
    (value) => `虚拟文件 fileId "${value}" `,
  );
  pushDuplicateViolations(
    violations,
    (bundle.stages ?? []).map((stage) => stage.stageId),
    (index) => `/stages/${index}/stageId`,
    (value) => `状态机阶段 stageId "${value}" `,
  );
  pushDuplicateViolations(
    violations,
    (bundle.customInstructions ?? []).map((instruction) => instruction.mnemonic),
    (index) => `/customInstructions/${index}/mnemonic`,
    (value) => `自定义指令助记符 "${value}" `,
  );
  pushDuplicateViolations(
    violations,
    (bundle.interfaces ?? []).map((entry) => String(entry.interfaceId)),
    (index) => `/interfaces/${index}/interfaceId`,
    (value) => `作者接口 interfaceId "${value}" `,
  );
  return violations;
}

/**
 * XS-REG-NAMESPACE:私有初始寄存器键归属双命名空间之一(G2/D3,WP-1 §12.5 v1.5)。
 * 一般名(负向前瞻排除 FLAG 保留区)或 FLAG 模式;不属任何命名空间的键拒绝。
 * Schema 已先行拦截,此处是纵深防御第二道防线(秘密汇可静态枚举的依据)。
 */
export function checkPrivateRegisterNamespaces(
  bundle: PrivateChallengeBundle,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  for (const [name] of Object.entries(bundle.initialState.registers)) {
    if (!GENERAL_REGISTER_NAME_PATTERN.test(name) && !FLAG_REGISTER_NAME_PATTERN.test(name)) {
      violations.push({
        ruleId: "XS-REG-NAMESPACE",
        message: `私有初始寄存器 "${name}" 不属任何命名空间(一般名 ^(?!FLAG)[A-Z][A-Z0-9_]{0,15}$ 或 FLAG 保留区 ^FLAG[A-Z0-9_]*$)`,
        path: `/initialState/registers/${name}`,
      });
    }
  }
  return violations;
}

/** XS-MEM-TOTAL / XS-MEM-CONTENT:内存总量与内容长度约束。 */
export function checkPrivateMemoryBudget(
  bundle: PrivateChallengeBundle,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  let totalBytes = 0;
  let totalContentBytes = 0;
  bundle.initialState.memoryRegions.forEach((region, index) => {
    totalBytes += region.byteLength;
    totalContentBytes += region.contentHex.length / 2;
    if (region.contentHex.length !== region.byteLength * 2) {
      violations.push({
        ruleId: "XS-MEM-CONTENT",
        message: `内存区域 ${region.regionId} contentHex 长度(${region.contentHex.length} hex 字符)必须等于 2 × byteLength(${region.byteLength * 2})`,
        path: `/initialState/memoryRegions/${index}/contentHex`,
      });
    }
  });
  if (totalBytes > MAX_MEMORY_TOTAL_BYTES) {
    violations.push({
      ruleId: "XS-MEM-TOTAL",
      message: `区域字节总量 ${totalBytes} 超过上限 ${MAX_MEMORY_TOTAL_BYTES}`,
      path: "/initialState/memoryRegions",
    });
  }
  if (totalContentBytes > MAX_MEMORY_CONTENT_BYTES) {
    violations.push({
      ruleId: "XS-MEM-TOTAL",
      message: `初始内容字节总量 ${totalContentBytes} 超过上限 ${MAX_MEMORY_CONTENT_BYTES}`,
      path: "/initialState/memoryRegions",
    });
  }
  return violations;
}

/** XS-IR-LABEL:标签 ID 唯一;标签与入口索引必须落在指令范围内。 */
export function checkIrLabels(bundle: PrivateChallengeBundle): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const compiledIr = bundle.compiledIr;
  if (compiledIr === undefined) {
    return violations;
  }
  const instructionCount = compiledIr.instructions.length;
  const seen = new Map<string, number>();
  compiledIr.labels.forEach((label, index) => {
    const firstIndex = seen.get(label.labelId);
    if (firstIndex === undefined) {
      seen.set(label.labelId, index);
    } else {
      violations.push({
        ruleId: "XS-IR-LABEL",
        message: `IR 标签 "${label.labelId}" 与第 ${firstIndex} 项重复`,
        path: `/compiledIr/labels/${index}/labelId`,
      });
    }
    if (!Number.isInteger(label.instructionIndex) || label.instructionIndex < 0 || label.instructionIndex >= instructionCount) {
      violations.push({
        ruleId: "XS-IR-LABEL",
        message: `IR 标签 "${label.labelId}" 的 instructionIndex ${label.instructionIndex} 越界(指令数 ${instructionCount})`,
        path: `/compiledIr/labels/${index}/instructionIndex`,
      });
    }
  });
  const entrypoint = compiledIr.entrypointIndex;
  if (entrypoint !== undefined && (entrypoint < 0 || entrypoint >= instructionCount)) {
    violations.push({
      ruleId: "XS-IR-LABEL",
      message: `entrypointIndex ${entrypoint} 越界(指令数 ${instructionCount})`,
      path: "/compiledIr/entrypointIndex",
    });
  }
  return violations;
}

/** 基线 opcode 集合(G4:IR op 双形态中属基线面的判据)。 */
const BASELINE_OP_SET = new Set<string>(DSL_OPCODES);

/**
 * XS-CUSTOM-DEF:自定义指令助记符不得与基线 opcode 冲突(G4/D4 纵深防御:
 * 助记符大写模式与基线小写枚举结构性不相交,此规则拦截被类型断言绕过的
 * 手写包);助记符条目间唯一性由 XS-ID-UNIQUE 承接。
 */
export function checkCustomInstructionDeclarations(
  bundle: PrivateChallengeBundle,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  (bundle.customInstructions ?? []).forEach((instruction, index) => {
    if (BASELINE_OP_SET.has(instruction.mnemonic)) {
      violations.push({
        ruleId: "XS-CUSTOM-DEF",
        message: `自定义指令助记符 "${instruction.mnemonic}" 与基线 opcode 冲突`,
        path: `/customInstructions/${index}/mnemonic`,
      });
    }
  });
  return violations;
}

/** XS-CUSTOM-REF:IR 中非基线 op 必须引用已声明的自定义指令助记符(G4/D4)。 */
export function checkCustomInstructionRefs(bundle: PrivateChallengeBundle): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const compiledIr = bundle.compiledIr;
  if (compiledIr === undefined) {
    return violations;
  }
  const declared = new Set(
    (bundle.customInstructions ?? []).map((instruction) => instruction.mnemonic),
  );
  compiledIr.instructions.forEach((instruction, index) => {
    if (!BASELINE_OP_SET.has(instruction.op) && !declared.has(instruction.op)) {
      violations.push({
        ruleId: "XS-CUSTOM-REF",
        message: `IR 指令 ${index} 的助记符 "${instruction.op}" 既非基线 opcode 也未在 customInstructions 声明`,
        path: `/compiledIr/instructions/${index}/op`,
      });
    }
  });
  return violations;
}

/**
 * XS-SYSCALL-DECL:syscall 派发号必须落在保留系统号带 [0x0, 0xFF]
 * (内置 exit 语义不变)或精确匹配已声明的 interfaces[].interfaceId(G4/D4);
 * 未声明即 invalid_action 的静态防线。syscall 是封闭单值伪操作:
 * 操作数必须为恰好一个立即数。
 */
export function checkSyscallDeclarations(bundle: PrivateChallengeBundle): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const compiledIr = bundle.compiledIr;
  if (compiledIr === undefined) {
    return violations;
  }
  const interfaceIds = new Set((bundle.interfaces ?? []).map((entry) => entry.interfaceId));
  compiledIr.instructions.forEach((instruction, index) => {
    if (instruction.op !== "syscall") {
      return;
    }
    const operands = instruction.operands ?? [];
    const operand = operands[0];
    if (operands.length !== 1 || operand === undefined || operand.kind !== "immediate") {
      violations.push({
        ruleId: "XS-SYSCALL-DECL",
        message: `syscall 指令 ${index} 是封闭单值伪操作,操作数必须为恰好一个立即数`,
        path: `/compiledIr/instructions/${index}/operands`,
      });
      return;
    }
    const value = BigInt(operand.valueHex);
    if (value > BigInt(RESERVED_SYSCALL_BAND_MAX) && !interfaceIds.has(Number(value))) {
      violations.push({
        ruleId: "XS-SYSCALL-DECL",
        message: `syscall 派发号 ${operand.valueHex} 不在保留系统号带(内置 exit)且未匹配任何 interfaces[].interfaceId`,
        path: `/compiledIr/instructions/${index}/operands/0`,
      });
    }
  });
  return violations;
}

/**
 * XS-IFACE-REF:作者接口引用可解析(G4/D4)——call 的 interface 操作数
 * 必须落在 interfaces[];接口效果引用的 fileId 必须在 secrets.virtualFiles,
 * set_flag 的 FLAG 寄存器必须在私有初始寄存器集(经 I-3 污点检查的落位前提)。
 */
export function checkInterfaceRefs(bundle: PrivateChallengeBundle): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const compiledIr = bundle.compiledIr;
  if (compiledIr === undefined) {
    return violations;
  }
  const interfaceIds = new Set((bundle.interfaces ?? []).map((entry) => entry.interfaceId));
  const fileIds = new Set(bundle.secrets.virtualFiles.map((file) => file.fileId));
  const registerNames = new Set(Object.keys(bundle.initialState.registers));
  compiledIr.instructions.forEach((instruction, index) => {
    (instruction.operands ?? []).forEach((operand, operandIndex) => {
      if (operand.kind === "interface" && !interfaceIds.has(operand.interfaceId)) {
        violations.push({
          ruleId: "XS-IFACE-REF",
          message: `interface 操作数引用的接口号 ${operand.interfaceId} 未在 interfaces 声明`,
          path: `/compiledIr/instructions/${index}/operands/${operandIndex}`,
        });
      }
    });
  });
  (bundle.interfaces ?? []).forEach((entry, index) => {
    entry.effects.forEach((effect, effectIndex) => {
      if (
        (effect.effect === "grant_virtual_file" || effect.effect === "virtual_file_read") &&
        !fileIds.has(effect.fileId)
      ) {
        violations.push({
          ruleId: "XS-IFACE-REF",
          message: `接口 ${entry.interfaceId} 的效果 ${effect.effect} 引用的虚拟文件 "${effect.fileId}" 不在 secrets.virtualFiles`,
          path: `/interfaces/${index}/effects/${effectIndex}/fileId`,
        });
      }
      if (effect.effect === "set_flag" && !registerNames.has(effect.flagRegister)) {
        violations.push({
          ruleId: "XS-IFACE-REF",
          message: `接口 ${entry.interfaceId} 的效果 set_flag 引用的 FLAG 寄存器 "${effect.flagRegister}" 不在私有初始寄存器集`,
          path: `/interfaces/${index}/effects/${effectIndex}/flagRegister`,
        });
      }
    });
  });
  return violations;
}

/** XS-IR-LEAVE:leave 要求私有初始寄存器集含 RBP(G4:栈帧基,`RSP ← RBP` 的前提)。 */
export function checkLeaveRequiresRbp(bundle: PrivateChallengeBundle): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const compiledIr = bundle.compiledIr;
  if (compiledIr === undefined) {
    return violations;
  }
  if ("RBP" in bundle.initialState.registers) {
    return violations;
  }
  compiledIr.instructions.forEach((instruction, index) => {
    if (instruction.op === "leave") {
      violations.push({
        ruleId: "XS-IR-LEAVE",
        message: "IR 含 leave 指令但私有初始寄存器集不含必选核心寄存器 RBP(leave 语义为 RSP ← RBP 后 pop RBP)",
        path: `/compiledIr/instructions/${index}/op`,
      });
    }
  });
  return violations;
}

/**
 * XS-CUSTOM-DISPLAY:自定义指令 / 接口的 displayText 私有标识扫描
 * (E-4/E-6,WP-1 §6.3)——展示文本(I-10 静态模板类)不得包含隐藏区域名
 * (E-6)、隐藏测试 testId(E-4 谓词标识载体)与虚拟文件 fileId(E-6
 * capability 关联);判定存在性泄露与值级泄露的静态防线,T-SC1 探针变体承接运行时面。
 */
export function checkAuthorDisplayTexts(bundle: PrivateChallengeBundle): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const forbidden: ReadonlyArray<{ readonly kind: string; readonly value: string }> = [
    ...bundle.initialState.memoryRegions
      .filter((region) => region.isHidden)
      .map((region) => ({ kind: "隐藏区域名", value: region.regionId })),
    ...(bundle.judging.hiddenTests ?? []).map((test) => ({
      kind: "谓词标识(testId)",
      value: test.testId,
    })),
    ...bundle.secrets.virtualFiles.map((file) => ({
      kind: "虚拟文件 fileId",
      value: file.fileId,
    })),
  ];
  const scan = (displayText: string, path: string): void => {
    for (const item of forbidden) {
      if (displayText.includes(item.value)) {
        violations.push({
          ruleId: "XS-CUSTOM-DISPLAY",
          message: `displayText 含${item.kind} "${item.value}"(E-4/E-6:展示文本不得泄露谓词信息或隐藏区域等私有标识)`,
          path,
        });
      }
    }
  };
  (bundle.customInstructions ?? []).forEach((instruction, index) => {
    scan(instruction.displayText, `/customInstructions/${index}/displayText`);
  });
  (bundle.interfaces ?? []).forEach((entry, index) => {
    scan(entry.displayText, `/interfaces/${index}/displayText`);
  });
  return violations;
}

/** XS-STAGE-BUDGET:每阶段 maxInstructionSteps 必须为 ≥ 1 的整数。 */
export function checkStageBudgets(bundle: PrivateChallengeBundle): CheckerViolation[] {  const violations: CheckerViolation[] = [];
  (bundle.stages ?? []).forEach((stage, index) => {
    const steps = stage.resourceBudget.maxInstructionSteps;
    if (!Number.isInteger(steps) || steps < 1) {
      violations.push({
        ruleId: "XS-STAGE-BUDGET",
        message: `阶段 ${stage.stageId} 的 maxInstructionSteps 必须为 ≥ 1 的整数,实际 ${steps}`,
        path: `/stages/${index}/resourceBudget/maxInstructionSteps`,
      });
    }
  });
  return violations;
}

/** XS-STAGE-REACH:迁移目标存在;全部阶段自 stages[0] 可达。 */
export function checkStageReachability(bundle: PrivateChallengeBundle): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const stages = bundle.stages ?? [];
  if (stages.length === 0) {
    return violations;
  }
  const byId = new Map(stages.map((stage) => [stage.stageId, stage]));
  stages.forEach((stage, index) => {
    stage.transitions.forEach((transition, transitionIndex) => {
      if (!byId.has(transition.toStageId)) {
        violations.push({
          ruleId: "XS-STAGE-REACH",
          message: `阶段 ${stage.stageId} 的迁移目标 "${transition.toStageId}" 不存在`,
          path: `/stages/${index}/transitions/${transitionIndex}/toStageId`,
        });
      }
    });
  });
  const entry = stages[0];
  if (entry === undefined) {
    return violations;
  }
  const reachable = new Set<string>([entry.stageId]);
  const queue = [entry.stageId];
  while (queue.length > 0) {
    const currentId = queue.shift();
    const current = currentId === undefined ? undefined : byId.get(currentId);
    for (const transition of current?.transitions ?? []) {
      if (byId.has(transition.toStageId) && !reachable.has(transition.toStageId)) {
        reachable.add(transition.toStageId);
        queue.push(transition.toStageId);
      }
    }
  }
  stages.forEach((stage, index) => {
    if (!reachable.has(stage.stageId)) {
      violations.push({
        ruleId: "XS-STAGE-REACH",
        message: `阶段 ${stage.stageId} 无法从入口阶段 ${entry.stageId} 到达`,
        path: `/stages/${index}`,
      });
    }
  });
  return violations;
}

type PredicateVisitor = (predicate: PrivatePredicate, path: string) => void;

/**
 * 通用条件树遍历:布尔层节点(all / any / not)深度从 1 起算,
 * 超过 MAX_CONDITION_DEPTH 记 XS-NESTING;谓词叶子回调 visit。
 * 读结构键而非类型层级,使被类型断言绕过的深嵌套也能被拦下。
 */
function walkConditionNode(
  node: unknown,
  path: string,
  depth: number,
  visit: PredicateVisitor,
  violations: CheckerViolation[],
): void {
  if (node === null || typeof node !== "object") {
    return;
  }
  const record = node as Record<string, unknown>;
  const isBooleanNode = "all" in record || "any" in record || "not" in record;
  if (!isBooleanNode) {
    if ("predicate" in record) {
      walkConditionNode(record.predicate, `${path}/predicate`, depth, visit, violations);
    } else if ("type" in record && typeof record.type === "string") {
      visit(record as unknown as PrivatePredicate, path);
    }
    return;
  }
  if (depth >= MAX_CONDITION_DEPTH) {
    violations.push({
      ruleId: "XS-NESTING",
      message: `判题条件布尔组合嵌套深度超过 ${MAX_CONDITION_DEPTH}(L1→L2→L3)`,
      path,
    });
    return;
  }
  if (Array.isArray(record.all)) {
    record.all.forEach((child, index) =>
      walkConditionNode(child, `${path}/all/${index}`, depth + 1, visit, violations));
  }
  if (Array.isArray(record.any)) {
    record.any.forEach((child, index) =>
      walkConditionNode(child, `${path}/any/${index}`, depth + 1, visit, violations));
  }
  if ("not" in record) {
    walkConditionNode(record.not, `${path}/not`, depth + 1, visit, violations);
  }
}

function forEachPredicate(
  condition: ConditionL1,
  basePath: string,
  visit: PredicateVisitor,
  violations: CheckerViolation[],
): void {
  walkConditionNode(condition, basePath, 1, visit, violations);
}

/** 谓词引用检查所需的解析上下文(存在性查找表)。 */
interface PredicateRefContext {
  readonly registerNames: ReadonlySet<string>;
  readonly regionById: ReadonlyMap<string, { readonly regionId: string; readonly byteLength: number }>;
  readonly fileIds: ReadonlySet<string>;
}

/** XS-PRED-REFS:谓词引用存在性与切片界内(逐谓词类型检查)。 */
function checkPredicateRefs(
  predicate: PrivatePredicate,
  path: string,
  context: PredicateRefContext,
  violations: CheckerViolation[],
): void {
  switch (predicate.type) {
    case "register_equals":
    case "register_bits_set": {
      if (!context.registerNames.has(predicate.register)) {
        violations.push({
          ruleId: "XS-PRED-REFS",
          message: `谓词 ${predicate.type} 引用的寄存器 "${predicate.register}" 不在私有初始寄存器集`,
          path,
        });
      }
      return;
    }
    case "memory_equals":
    case "memory_contains": {
      const region = context.regionById.get(predicate.regionId);
      if (region === undefined) {
        violations.push({
          ruleId: "XS-PRED-REFS",
          message: `谓词 ${predicate.type} 引用的内存区域 "${predicate.regionId}" 不存在`,
          path,
        });
        return;
      }
      const byteCount = predicate.bytesHex.length / 2;
      if (predicate.type === "memory_equals") {
        const endBytes = predicate.offsetBytes + byteCount;
        if (predicate.offsetBytes < 0 || endBytes > region.byteLength) {
          violations.push({
            ruleId: "XS-PRED-REFS",
            message: `memory_equals 切片 [${predicate.offsetBytes}, ${endBytes}) 超出区域 ${region.regionId} 的 byteLength ${region.byteLength}`,
            path,
          });
        }
      } else if (byteCount > region.byteLength) {
        violations.push({
          ruleId: "XS-PRED-REFS",
          message: `memory_contains 匹配串 ${byteCount} 字节超过区域 ${region.regionId} 的 byteLength ${region.byteLength}`,
          path,
        });
      }
      return;
    }
    case "virtual_file_read": {
      if (!context.fileIds.has(predicate.fileId)) {
        violations.push({
          ruleId: "XS-PRED-REFS",
          message: `谓词 virtual_file_read 引用的虚拟文件 "${predicate.fileId}" 不在 secrets.virtualFiles`,
          path,
        });
      }
      return;
    }
    case "ret_target_equals":
    case "stack_canary_intact":
      return;
  }
}

function collectConditionRefViolations(
  condition: ConditionL1,
  basePath: string,
  context: PredicateRefContext,
  violations: CheckerViolation[],
): void {
  forEachPredicate(
    condition,
    basePath,
    (predicate, path) => checkPredicateRefs(predicate, path, context, violations),
    violations,
  );
}

/** 条件树相关规则聚合(XS-PRED-REFS + XS-NESTING)。 */
export function checkConditionTrees(bundle: PrivateChallengeBundle): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const context = {
    registerNames: new Set(Object.keys(bundle.initialState.registers)),
    regionById: new Map(
      bundle.initialState.memoryRegions.map((region) => [region.regionId, region]),
    ),
    fileIds: new Set(bundle.secrets.virtualFiles.map((file) => file.fileId)),
  };
  collectConditionRefViolations(
    bundle.judging.successCondition,
    "/judging/successCondition",
    context,
    violations,
  );
  (bundle.judging.failureConditions ?? []).forEach((condition, index) => {
    collectConditionRefViolations(
      condition,
      `/judging/failureConditions/${index}`,
      context,
      violations,
    );
  });
  (bundle.stages ?? []).forEach((stage, stageIndex) => {
    collectConditionRefViolations(
      stage.preconditions,
      `/stages/${stageIndex}/preconditions`,
      context,
      violations,
    );
    stage.transitions.forEach((transition, transitionIndex) => {
      collectConditionRefViolations(
        transition.onCondition,
        `/stages/${stageIndex}/transitions/${transitionIndex}/onCondition`,
        context,
        violations,
      );
    });
    stage.failureConditions.forEach((condition, conditionIndex) => {
      collectConditionRefViolations(
        condition,
        `/stages/${stageIndex}/failureConditions/${conditionIndex}`,
        context,
        violations,
      );
    });
  });
  return violations;
}

/** 私有侧单规则聚合(供 checkChallengePair 复用,亦可单测)。 */
export function checkPrivateBundleRules(bundle: PrivateChallengeBundle): CheckerViolation[] {
  return [
    ...checkPrivateRegionsPairwiseDisjoint(bundle),
    ...checkPrivateCodeRegionVisibility(bundle),
    ...checkPrivateAddressSpaceBounds(bundle),
    ...checkSecretSinksAreHidden(bundle),
    ...checkSeedPolicy(bundle),
    ...checkPrivateReferenceUniqueness(bundle),
    ...checkPrivateRegisterNamespaces(bundle),
    ...checkPrivateMemoryBudget(bundle),
    ...checkIrLabels(bundle),
    ...checkCustomInstructionDeclarations(bundle),
    ...checkCustomInstructionRefs(bundle),
    ...checkSyscallDeclarations(bundle),
    ...checkInterfaceRefs(bundle),
    ...checkLeaveRequiresRbp(bundle),
    ...checkAuthorDisplayTexts(bundle),
    ...checkStageBudgets(bundle),
    ...checkStageReachability(bundle),
    ...checkConditionTrees(bundle),
    ...checkPrivatePageAlignment(bundle),
  ];
}

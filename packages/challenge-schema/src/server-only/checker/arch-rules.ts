/**
 * 架构位宽与 VMA 页对齐检查规则(WP-1 v1.4 §12.6;《Vm 模块设计冲突与整改方案》G1/G3):
 *  - XS-ARCH-WIDTH 跨包规则:私有初始寄存器值、IR 立即数(无符号)与内存位移
 *    (有符号)、公开镜像寄存器值均须落在公开包 vmProfile.archBits 声明的位宽域内
 *    ——archBits 位宽的值,以 64 位容器承载,高位按位宽掩蔽(计划书 6.2);
 *  - XS-MEM-PAGE-ALIGN 公开/私有区域 byteLength 与公开 pageSizeBytes 均为
 *    PAGE_SIZE_MULTIPLE_BYTES(4096)的倍数(G3/D2;Schema multipleOf 之外的
 *    纵深防御:checkChallengePair 的聚合输入可被测试以类型断言绕过单包 Schema
 *    直测,对齐在聚合点二次把关;对齐只约束 VMA 边界,区域内对象不受约束)。
 *
 * 前置条件:输入已通过各自 Schema 校验(min/max、hex 形态等单字段形态归
 * Schema;畸形 hex 在此处按前置条件外快速失败,由 BigInt 抛错暴露)。
 *
 * SERVER_ONLY:本模块仅经 @stackmaster/challenge-schema/server-only 导出,
 * 只允许后端包消费。
 */

import { PAGE_SIZE_MULTIPLE_BYTES } from "../../common/limits.js";
import type { ArchBits } from "../../common/vocabulary.js";
import type { PublicChallengeDescriptor } from "../../common/public-types.js";
import type { PrivateChallengeBundle } from "../private-types.js";
import type { CheckerViolation } from "./types.js";

/**
 * 有符号十六进制解析(内存位移为 "-0x…" 形态;运行时 BigInt 构造器
 * 不接受带负号的十六进制字符串,先拆符号再取模)。
 */
function parseSignedHex(valueHex: string): bigint {
  const negative = valueHex.startsWith("-");
  const magnitude = BigInt(negative ? valueHex.slice(1) : valueHex);
  return negative ? -magnitude : magnitude;
}

/** archBits 位宽域的无符号上界:2^archBits − 1。 */
function unsignedMax(archBits: ArchBits): bigint {
  return (1n << BigInt(archBits)) - 1n;
}

/** archBits 位宽域的有符号下界:−2^(archBits−1)(内存位移)。 */
function signedMin(archBits: ArchBits): bigint {
  return -(1n << BigInt(archBits - 1));
}

/** archBits 位宽域的有符号上界:2^(archBits−1) − 1(内存位移)。 */
function signedMax(archBits: ArchBits): bigint {
  return (1n << BigInt(archBits - 1)) - 1n;
}

/**
 * XS-ARCH-WIDTH:双包架构值位宽域(G1/D1)。
 * 位宽从公开包 `vmProfile.archBits` 单点读取——私有包不复制该字段,
 * 防双真相源漂移(WP-1 v1.4 §1.3.1)。
 */
export function checkArchWidth(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const archBits = publicDescriptor.vmProfile.archBits;
  const maxValue = unsignedMax(archBits);
  const displacementMin = signedMin(archBits);
  const displacementMax = signedMax(archBits);

  for (const [name, valueHex] of Object.entries(privateBundle.initialState.registers)) {
    const value = BigInt(valueHex);
    if (value < 0n || value > maxValue) {
      violations.push({
        ruleId: "XS-ARCH-WIDTH",
        message: `私有初始寄存器 ${name} 值 ${valueHex} 超出 archBits=${archBits} 位宽域 [0, 2^${archBits} − 1](高位按位宽掩蔽,计划书 6.2)`,
        path: `/initialState/registers/${name}`,
      });
    }
  }

  privateBundle.compiledIr.instructions.forEach((instruction, instructionIndex) => {
    (instruction.operands ?? []).forEach((operand, operandIndex) => {
      if (operand.kind === "immediate") {
        const value = BigInt(operand.valueHex);
        if (value < 0n || value > maxValue) {
          violations.push({
            ruleId: "XS-ARCH-WIDTH",
            message: `IR 指令 ${instructionIndex}(${instruction.op})立即数 ${operand.valueHex} 超出 archBits=${archBits} 无符号域 [0, 2^${archBits} − 1]`,
            path: `/compiledIr/instructions/${instructionIndex}/operands/${operandIndex}/valueHex`,
          });
        }
      } else if (operand.kind === "memory" && operand.displacementHex !== undefined) {
        const value = parseSignedHex(operand.displacementHex);
        if (value < displacementMin || value > displacementMax) {
          violations.push({
            ruleId: "XS-ARCH-WIDTH",
            message: `IR 指令 ${instructionIndex}(${instruction.op})内存位移 ${operand.displacementHex} 超出 archBits=${archBits} 有符号域 [−2^${archBits - 1}, 2^${archBits - 1} − 1]`,
            path: `/compiledIr/instructions/${instructionIndex}/operands/${operandIndex}/displacementHex`,
          });
        }
      }
    });
  });

  publicDescriptor.initialProjection.visibleRegisters.forEach((register, index) => {
    const value = BigInt(register.valueHex);
    if (value < 0n || value > maxValue) {
      violations.push({
        ruleId: "XS-ARCH-WIDTH",
        message: `公开镜像寄存器 ${register.name} 值 ${register.valueHex} 超出 archBits=${archBits} 位宽域 [0, 2^${archBits} − 1](XS-PROJ-VALUES 同值约束要求私有侧同改)`,
        path: `/initialProjection/visibleRegisters/${index}/valueHex`,
      });
    }
  });

  return violations;
}

/** XS-MEM-PAGE-ALIGN 公开侧:pageSizeBytes 与布局区域 byteLength 均为 4KB 的倍数。 */
export function checkPublicPageAlignment(
  publicDescriptor: PublicChallengeDescriptor,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  if (publicDescriptor.vmProfile.pageSizeBytes % PAGE_SIZE_MULTIPLE_BYTES !== 0) {
    violations.push({
      ruleId: "XS-MEM-PAGE-ALIGN",
      message: `pageSizeBytes ${publicDescriptor.vmProfile.pageSizeBytes} 不是 ${PAGE_SIZE_MULTIPLE_BYTES} 的倍数(VMA 页对齐,G3/D2)`,
      path: "/vmProfile/pageSizeBytes",
    });
  }
  publicDescriptor.memoryLayout.regions.forEach((region, index) => {
    if (region.byteLength % PAGE_SIZE_MULTIPLE_BYTES !== 0) {
      violations.push({
        ruleId: "XS-MEM-PAGE-ALIGN",
        message: `公开区域 ${region.regionId} byteLength ${region.byteLength} 不是 ${PAGE_SIZE_MULTIPLE_BYTES} 的倍数(VMA 页对齐;区域内对象不受约束)`,
        path: `/memoryLayout/regions/${index}/byteLength`,
      });
    }
  });
  return violations;
}

/** XS-MEM-PAGE-ALIGN 私有侧:初始区域 byteLength 均为 4KB 的倍数。 */
export function checkPrivatePageAlignment(
  privateBundle: PrivateChallengeBundle,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  privateBundle.initialState.memoryRegions.forEach((region, index) => {
    if (region.byteLength % PAGE_SIZE_MULTIPLE_BYTES !== 0) {
      violations.push({
        ruleId: "XS-MEM-PAGE-ALIGN",
        message: `私有内存区域 ${region.regionId} byteLength ${region.byteLength} 不是 ${PAGE_SIZE_MULTIPLE_BYTES} 的倍数(VMA 页对齐;区域内对象不受约束)`,
        path: `/initialState/memoryRegions/${index}/byteLength`,
      });
    }
  });
  return violations;
}

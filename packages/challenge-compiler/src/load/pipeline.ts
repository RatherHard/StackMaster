/**
 * 私有判题包装载管线(WP-2 核心交付;引擎进程协议 §5 的装载链上游)。
 *
 *   双包输入 → Schema 校验(Ajv)→ WP-4 检查器全量前置(checkChallengePair)
 *   → 编译器编译期校验(按模式分派)→ 装载产物(编译产物 / 编码表装载)。
 *
 * 层次化 fail-closed:任一层出现违规即整体拒绝,后续层不执行
 * (检查器假定 Schema 合法输入;编译期校验假定检查器全绿)。
 * 装载失败方向恒为 challenge_invalid(LOAD_FAILURE_RESULT_DIRECTION),
 * 不产出部分程序、不近似执行;worker 侧按单包 Schema 复验(引擎进程
 * 协议 §5.1),跨包语义以本管线为把关点。
 *
 * IR 模式产物 = 编译产物(IrCompiledProgram:消解后指令流 + CFG 事实);
 * 字节模式产物 = 编码表装载(ByteLoadedProgram:入口探测译码的指令流,
 * 内联操作数值已按 archBits/8 小端自证提取)。
 */

import type { PublicChallengeDescriptor } from "@stackmaster/challenge-schema";
import {
  parsePrivateBundleText,
  validatePrivateBundle,
  checkChallengePair,
  type IrInstruction,
  type IrLabel,
  type PrivateChallengeBundle,
} from "@stackmaster/challenge-schema/server-only";
import {
  parsePublicDescriptorText,
  validatePublicDescriptor,
  type SchemaViolation,
} from "@stackmaster/challenge-schema";
import type { CompilerViolation } from "../common/diagnostics.js";
import { LOAD_FAILURE_RESULT_DIRECTION, compilerViolation } from "../common/diagnostics.js";
import { analyzeCfg } from "../ir/cfg.js";
import { initialRegisterNames, validateInstructionOperands } from "../ir/opcode-shapes.js";
import { decodeByteProgram, type ByteLoadedProgram } from "../byte/decode.js";
import { validateStages } from "../stages/validate-stages.js";

/** IR 模式装载产物(编译产物:目标已内联消解 + CFG 事实)。 */
export interface IrCompiledProgram {
  readonly mode: "ir";
  readonly entrypointIndex: number;
  readonly instructions: readonly IrInstruction[];
  readonly labels: readonly IrLabel[];
  /** 自入口可达的指令数(CFG 事实;XC-IR-REACH 强制 = 指令总数)。 */
  readonly reachableInstructionCount: number;
  /** 可达回边清单(每条都被阶段预算承接,XC-IR-TERMINATE)。 */
  readonly backEdges: readonly { from: number; to: number }[];
}

/** 装载成功的题目(双包 + 按模式的程序产物)。 */
export interface LoadedChallenge {
  readonly publicDescriptor: PublicChallengeDescriptor;
  readonly privateBundle: PrivateChallengeBundle;
  readonly program: IrCompiledProgram | ByteLoadedProgram;
}

export type ChallengeLoadResult =
  | { readonly ok: true; readonly challenge: LoadedChallenge }
  | {
      readonly ok: false;
      readonly direction: typeof LOAD_FAILURE_RESULT_DIRECTION;
      readonly violations: readonly CompilerViolation[];
    };

function toCompilerViolations(
  violations: readonly SchemaViolation[],
  ruleId: string,
): CompilerViolation[] {
  return violations.map((item) => ({
    ruleId,
    message: item.message,
    path: item.path,
  }));
}

/** IR 模式编译期校验与产物构造(前置:Schema + WP-4 检查器全绿)。 */
function compileLoadedIr(
  privateBundle: PrivateChallengeBundle,
): { program: IrCompiledProgram; violations: CompilerViolation[] } {
  const violations: CompilerViolation[] = [];
  const ir = privateBundle.compiledIr;
  if (ir === undefined) {
    return {
      program: {
        mode: "ir",
        entrypointIndex: 0,
        instructions: [],
        labels: [],
        reachableInstructionCount: 0,
        backEdges: [],
      },
      violations: [compilerViolation(
        "XC-IR-REACH",
        "IR 模式装载要求 compiledIr 存在(XS-PROG-MODE 应已先行拒绝)",
        "/compiledIr",
      )],
    };
  }

  // 逐 opcode 操作数形态 + 寄存器引用可解析。
  const registerNames = initialRegisterNames(privateBundle);
  ir.instructions.forEach((instruction, index) => {
    violations.push(...validateInstructionOperands(instruction, index, registerNames));
  });

  // CFG:可达性、终止性(回边 vs 预算)、静态目标界内。
  const entrypointIndex = ir.entrypointIndex ?? 0;
  const cfg = analyzeCfg(privateBundle, entrypointIndex);
  violations.push(...cfg.violations);

  return {
    program: {
      mode: "ir",
      entrypointIndex,
      instructions: ir.instructions,
      labels: ir.labels,
      reachableInstructionCount: cfg.reachable.size,
      backEdges: cfg.backEdges,
    },
    violations,
  };
}

/**
 * 装载双包(已解析对象形态)。全部违规聚合返回;任何一层拒绝即
 * challenge_invalid,产物永不部分构造。
 */
export function loadChallengePair(input: {
  readonly publicDescriptor: unknown;
  readonly privateBundle: unknown;
}): ChallengeLoadResult {
  // 第一层:Ajv Schema 校验(双包各自)。
  const publicValidated = validatePublicDescriptor(input.publicDescriptor);
  if (!publicValidated.ok) {
    return {
      ok: false,
      direction: LOAD_FAILURE_RESULT_DIRECTION,
      violations: toCompilerViolations(publicValidated.violations, "SCHEMA-VIOLATION"),
    };
  }
  const privateValidated = validatePrivateBundle(input.privateBundle);
  if (!privateValidated.ok) {
    return {
      ok: false,
      direction: LOAD_FAILURE_RESULT_DIRECTION,
      violations: toCompilerViolations(privateValidated.violations, "SCHEMA-VIOLATION"),
    };
  }
  const publicDescriptor = publicValidated.value;
  const privateBundle = privateValidated.value;

  // 第二层:WP-4 检查器全量前置(公开单侧 + 私有单侧 + 跨包一致性)。
  const checkerResult = checkChallengePair(publicDescriptor, privateBundle);
  if (!checkerResult.ok) {
    return {
      ok: false,
      direction: LOAD_FAILURE_RESULT_DIRECTION,
      violations: checkerResult.violations.map((item) => ({
        ruleId: item.ruleId,
        message: item.message,
        path: item.path ?? "",
      })),
    };
  }

  // 第三层:编译器编译期校验(按模式分派)+ 状态机封闭性。
  const violations: CompilerViolation[] = [];
  violations.push(...validateStages(publicDescriptor, privateBundle));

  if (publicDescriptor.vmProfile.encodingTable === undefined) {
    const compiled = compileLoadedIr(privateBundle);
    violations.push(...compiled.violations);
    if (violations.length > 0) {
      return { ok: false, direction: LOAD_FAILURE_RESULT_DIRECTION, violations };
    }
    return {
      ok: true,
      challenge: {
        publicDescriptor,
        privateBundle,
        program: compiled.program,
      },
    };
  }

  const decoded = decodeByteProgram(publicDescriptor, privateBundle);
  violations.push(...decoded.violations);
  if (violations.length > 0) {
    return { ok: false, direction: LOAD_FAILURE_RESULT_DIRECTION, violations };
  }
  return {
    ok: true,
    challenge: {
      publicDescriptor,
      privateBundle,
      program: decoded.program,
    },
  };
}

/**
 * 装载双包(文本形态):严格 JSON 扫描器先行(重复键拒绝,XS-DUP-KEY
 * 纪律;JSON.parse 会静默去重且 reviver 观察不到),通过后走同一管线。
 */
export function loadChallengePairTexts(input: {
  readonly publicDescriptorText: string;
  readonly privateBundleText: string;
}): ChallengeLoadResult {
  const violations: CompilerViolation[] = [];
  const publicParsed = parsePublicDescriptorText(input.publicDescriptorText);
  const privateParsed = parsePrivateBundleText(input.privateBundleText);
  if (!publicParsed.ok) {
    violations.push(...toCompilerViolations(publicParsed.violations, "JSON-PARSE"));
  }
  if (!privateParsed.ok) {
    violations.push(...toCompilerViolations(privateParsed.violations, "JSON-PARSE"));
  }
  if (violations.length > 0) {
    return { ok: false, direction: LOAD_FAILURE_RESULT_DIRECTION, violations };
  }
  if (!publicParsed.ok || !privateParsed.ok) {
    return { ok: false, direction: LOAD_FAILURE_RESULT_DIRECTION, violations };
  }
  return loadChallengePair({
    publicDescriptor: publicParsed.value,
    privateBundle: privateParsed.value,
  });
}

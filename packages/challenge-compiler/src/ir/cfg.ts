/**
 * IR 模式 CFG 编译期分析(WP-2:可达性、终止性、循环回边 vs 预算)。
 *
 * 寻址语义:IR 模式的"地址"是**指令索引**——compiledIr.entrypointIndex 与
 * labels[].instructionIndex 同一空间;控制流立即数操作数的 valueHex 即目标
 * 指令索引(标签在编译期消解为内联索引,docs/contracts/最小DSL范围.md
 * §三.4.5「IR 模式:labels[] 编译期索引」)。字节模式地址 = 代码区字节偏移,
 * 两形态地址空间不同(XS-PROG-MODE 保证不混用)。
 *
 * 静态后继规则(执行语义归 WP-4 引擎;此处只取编译期可判定的控制流面):
 *  - 直线指令(数据传送 / 算术位运算 / 自定义助记符):后继 = i+1;
 *  - 无条件 jmp [I]:后继 = 目标;jmp [R]/[M]、ret、call [R]:**动态目标**
 *    (gadget 语义:控制流可到达任意指令边界)——保守过近似为可达全图,
 *    静态死代码判定仅对纯静态程序(全部控制流为立即数目标)有效;
 *  - 条件跳转 je/jne/jb/jae [I]:后继 = 目标 ∪ {i+1};
 *  - call [I]:后继 = 目标 ∪ {i+1}(调用返回);call [F]:接口派发为
 *    引擎管理调用(D4.2 ①),不占玩家栈、返回下一条 → 后继 = {i+1};
 *  - syscall [I]:派发号 ∈ 保留带 [0x0, 0xFF] → 内置 exit,**终结点**(无后继);
 *    ≥ 0x100 → 作者接口:效果序列含 exit → 终结点,否则后继 = {i+1}
 *    (效果原语封闭集 v1 直线语义);
 *  - 末条指令直线后继 i+1 = instructions.length:**隐式程序结束**(终结点;
 *    WP-4 对齐点——引擎侧落地时须同语义,见包内语义文档 §四)。
 *
 * 终止性:可达静态图中**回边**(目标 ≤ 来源的静态边;直线后继严格递增,
 * 故环 ⟺ 存在回边)必须有动态指令预算承接——7.2「循环必须有静态上限或
 * 动态指令预算」的编译期落点:存在可达回边 ⇒ 题目必须声明 stages[]
 * (每阶段 maxInstructionSteps 为 Schema 必填,XS-STAGE-BUDGET 强制 ≥ 1)。
 * 动态目标(ret / jmp R)的运行期循环不可静态判定,由 worker 资源面
 * (9.1 最大执行步数)与阶段预算兜底,不属编译期断言。
 *
 * 规则 ID:
 *  - XC-IR-TARGET    静态控制流立即数目标 = 指令索引且 0 ≤ 目标 < 指令数;
 *  - XC-IR-REACH     全部指令自入口可达(编译器产物不接受死代码;
 *                    13.2「不可达目标」测试类);
 *  - XC-IR-TERMINATE 可达回边存在但题目未声明 stages[](无预算承接的循环)。
 */

import type { IrInstruction, PrivateChallengeBundle } from "@stackmaster/challenge-schema/server-only";
import { compilerViolation, type CompilerViolation } from "../common/diagnostics.js";
import { isBaselineOpcode } from "./opcode-shapes.js";

/** 保留系统号带上界(G4/D4;与 challenge-schema 词表同值,叶子包内直接复用)。 */
import { RESERVED_SYSCALL_BAND_MAX } from "@stackmaster/challenge-schema";

/** 静态 CFG 节点的后继(指令索引;不含动态目标)。 */
export type StaticSuccessors = readonly number[];

/** 单条指令的静态后继与终结判定。 */
export interface StaticControlFacts {
  readonly successors: StaticSuccessors;
  /** 终结点:控制流不再前进(exit / 隐式程序结束)。 */
  readonly isTerminal: boolean;
  /** 动态目标:后继依赖运行时值(ret / jmp R / jmp M / call R),静态图汇点。 */
  readonly hasDynamicTarget: boolean;
}

/** syscall 派发号 → 作者接口效果序列是否含 exit(接口未声明时返回 undefined)。 */
function interfaceEffectsContainExit(
  interfaceId: number,
  bundle: PrivateChallengeBundle,
): boolean | undefined {
  const declared = (bundle.interfaces ?? []).find((entry) => entry.interfaceId === interfaceId);
  if (declared === undefined) {
    return undefined;
  }
  return declared.effects.some((effect) => effect.effect === "exit");
}

/** 取立即数操作数的无符号值(形态校验归 XC-OPCODE-SHAPE;此处容错返回 undefined)。 */
function immediateValue(instruction: IrInstruction): bigint | undefined {
  const operands = instruction.operands ?? [];
  const operand = operands[0];
  if (operand === undefined || operand.kind !== "immediate") {
    return undefined;
  }
  try {
    return BigInt(operand.valueHex);
  } catch {
    return undefined;
  }
}

/** 单条指令的静态控制流事实(目标界外时 successors 为空并记入违规,由调用方聚合)。 */
export function staticControlFacts(
  instruction: IrInstruction,
  instructionIndex: number,
  instructionCount: number,
  bundle: PrivateChallengeBundle,
): { facts: StaticControlFacts; violations: CompilerViolation[] } {
  const violations: CompilerViolation[] = [];
  const op = instruction.op;
  const operands = instruction.operands ?? [];
  const fallthrough = instructionIndex + 1 < instructionCount ? instructionIndex + 1 : null;
  const path = `/compiledIr/instructions/${instructionIndex}/operands`;

  function staticTarget(): number | null {
    const value = immediateValue(instruction);
    if (value === undefined || value < 0n || value >= BigInt(instructionCount)) {
      violations.push(compilerViolation(
        "XC-IR-TARGET",
        `指令 ${instructionIndex}(${op})的控制流立即数目标 ` +
          `${operands[0]?.kind === "immediate" ? operands[0].valueHex : "(缺立即数)"} ` +
          `不是界内指令索引(0 ≤ 目标 < ${instructionCount})`,
        path,
      ));
      return null;
    }
    return Number(value);
  }

  if (!isBaselineOpcode(op)) {
    // 自定义助记符:直线语义(微算子封闭集 v1 无控制转移)。
    return {
      facts: { successors: fallthrough === null ? [] : [fallthrough], isTerminal: false, hasDynamicTarget: false },
      violations,
    };
  }

  switch (op) {
    case "jmp": {
      const kind = operands[0]?.kind;
      if (kind === "immediate") {
        const target = staticTarget();
        return {
          facts: { successors: target === null ? [] : [target], isTerminal: false, hasDynamicTarget: false },
          violations,
        };
      }
      // jmp R / jmp M:动态目标,静态汇点。
      return { facts: { successors: [], isTerminal: false, hasDynamicTarget: true }, violations };
    }
    case "je":
    case "jne":
    case "jb":
    case "jae": {
      const target = staticTarget();
      const successors = target === null
        ? fallthrough === null ? [] : [fallthrough]
        : fallthrough === null ? [target] : [target, fallthrough];
      return { facts: { successors, isTerminal: false, hasDynamicTarget: false }, violations };
    }
    case "call": {
      const kind = operands[0]?.kind;
      if (kind === "immediate") {
        const target = staticTarget();
        const successors = target === null
          ? fallthrough === null ? [] : [fallthrough]
          : fallthrough === null ? [target] : [target, fallthrough];
        return { facts: { successors, isTerminal: false, hasDynamicTarget: false }, violations };
      }
      if (kind === "interface") {
        // 引擎管理调用(D4.2 ①):执行效果后返回下一条指令。
        return {
          facts: { successors: fallthrough === null ? [] : [fallthrough], isTerminal: false, hasDynamicTarget: false },
          violations,
        };
      }
      // call R:动态目标,静态汇点。
      return { facts: { successors: [], isTerminal: false, hasDynamicTarget: true }, violations };
    }
    case "ret":
      return { facts: { successors: [], isTerminal: false, hasDynamicTarget: true }, violations };
    case "syscall": {
      const value = immediateValue(instruction);
      if (value !== undefined && value <= BigInt(RESERVED_SYSCALL_BAND_MAX)) {
        // 内置 exit(I):终结点。
        return { facts: { successors: [], isTerminal: true, hasDynamicTarget: false }, violations };
      }
      if (value !== undefined) {
        const exits = interfaceEffectsContainExit(Number(value), bundle);
        if (exits === true) {
          return { facts: { successors: [], isTerminal: true, hasDynamicTarget: false }, violations };
        }
      }
      // 未声明接口由 XS-SYSCALL-DECL 拒绝;此处保守取直线后继。
      return {
        facts: { successors: fallthrough === null ? [] : [fallthrough], isTerminal: false, hasDynamicTarget: false },
        violations,
      };
    }
    default: {
      const successors = fallthrough === null ? [] : [fallthrough];
      return { facts: { successors, isTerminal: fallthrough === null, hasDynamicTarget: false }, violations };
    }
  }
}

/** 回边(来源 → 目标,目标 ≤ 来源;环的结构性信号)。 */
export interface BackEdge {
  readonly from: number;
  readonly to: number;
}

/** IR 程序 CFG 分析产物(装载产物附带事实 + 编译期违规)。 */
export interface CfgAnalysis {
  /** 自入口可达的指令索引集合。 */
  readonly reachable: ReadonlySet<number>;
  /** 可达静态边上的回边清单(确定性顺序:按来源索引升序)。 */
  readonly backEdges: readonly BackEdge[];
  readonly violations: readonly CompilerViolation[];
}

/**
 * 全程序 CFG 分析:目标界内检查 → 可达性 → 回边 vs 预算。
 * `entrypointIndex` 为 IR 入口(Schema 缺省时调用方按 0 处理)。
 */
export function analyzeCfg(
  bundle: PrivateChallengeBundle,
  entrypointIndex: number,
): CfgAnalysis {
  const instructions = bundle.compiledIr?.instructions ?? [];
  const instructionCount = instructions.length;
  const violations: CompilerViolation[] = [];

  // 逐指令静态后继(带目标界内检查)。
  const facts: StaticControlFacts[] = [];
  instructions.forEach((instruction, index) => {
    const result = staticControlFacts(instruction, index, instructionCount, bundle);
    facts.push(result.facts);
    violations.push(...result.violations);
  });

  // 可达性:自入口 DFS(确定性:后继按升序入栈)。
  const reachable = new Set<number>();
  if (entrypointIndex >= 0 && entrypointIndex < instructionCount) {
    const stack = [entrypointIndex];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || reachable.has(current)) {
        continue;
      }
      reachable.add(current);
      for (const successor of facts[current]?.successors ?? []) {
        if (!reachable.has(successor)) {
          stack.push(successor);
        }
      }
    }
    // 动态目标节点(ret / jmp R / jmp M / call R)的保守过近似:gadget 语义下
    // 控制流可到达任意指令 → 全图可达,静态死代码判定失效(运行时预算兜底)。
    const hasReachableDynamicTarget = [...reachable].some(
      (index) => facts[index]?.hasDynamicTarget === true,
    );
    if (hasReachableDynamicTarget) {
      for (let index = 0; index < instructionCount; index += 1) {
        reachable.add(index);
      }
    } else {
      const unreachable = instructions.length - reachable.size;
      if (unreachable > 0) {
        const firstUnreachable = instructions.findIndex((_, index) => !reachable.has(index));
        violations.push(compilerViolation(
          "XC-IR-REACH",
          `${unreachable} 条指令自入口不可达(首条位于索引 ${firstUnreachable});` +
            `编译器产物不接受死代码,删除不可达指令或补齐引用`,
          "/compiledIr/instructions",
        ));
      }
    }
  } else {
    violations.push(compilerViolation(
      "XC-IR-REACH",
      `入口指令索引 ${entrypointIndex} 出界(0 ≤ 入口 < ${instructionCount}),无可达分析`,
      "/compiledIr/entrypointIndex",
    ));
  }

  // 回边:可达静态边中目标 ≤ 来源(环 ⟺ 存在回边;直线后继严格递增)。
  const backEdges: BackEdge[] = [];
  for (const source of [...reachable].sort((a, b) => a - b)) {
    for (const target of facts[source]?.successors ?? []) {
      if (target <= source) {
        backEdges.push({ from: source, to: target });
      }
    }
  }

  if (backEdges.length > 0 && (bundle.stages ?? []).length === 0) {
    const first = backEdges[0];
    if (first !== undefined) {
      violations.push(compilerViolation(
        "XC-IR-TERMINATE",
        `程序含 ${backEdges.length} 条回边(首条 ${first.from} → ${first.to},循环)但题目未声明 ` +
          `stages[](7.2:循环必须有静态上限或动态指令预算;每阶段 maxInstructionSteps ` +
          `为必填预算,XS-STAGE-BUDGET 强制 ≥ 1)`,
        "/stages",
      ));
    }
  }

  return { reachable, backEdges, violations };
}

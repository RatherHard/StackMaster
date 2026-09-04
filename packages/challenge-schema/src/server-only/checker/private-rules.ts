/**
 * 私有判题包单侧检查规则(WP-1 §12.6 左列规则 ID):
 *  - I2-PRIV-PAIRWISE 私有初始内存区域两两不相交(BigInt 区间);
 *  - I3-SINK-HIDDEN containsSecret 的私有对象必须 hidden(秘密汇面);
 *  - XS-ID-UNIQUE 私有面引用 ID 唯一(区域 / 对象 / 隐藏测试 / 阶段 / 虚拟文件);
 *  - XS-REG-NAMESPACE 私有初始寄存器键归属双命名空间之一(G2/D3:一般名
 *    ^(?!FLAG)[A-Z][A-Z0-9_]{0,15}$ 或 FLAG 模式;Schema 负向前瞻之外的纵深防御,
 *    随 XS-REG-FROZEN 废止而接替其防线);
 *  - XS-MEM-TOTAL 区域字节总量 / 初始内容字节总量封顶;
 *  - XS-MEM-CONTENT contentHex 长度 = 2 × byteLength;
 *  - XS-IR-LABEL 标签 ID 唯一且索引落在指令范围内;
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
import type {
  ConditionL1,
  PrivateChallengeBundle,
  PrivatePredicate,
} from "../private-types.js";
import { checkPrivatePageAlignment } from "./arch-rules.js";
import { toAddressRange, rangesOverlap } from "./address-ranges.js";
import type { AddressRange } from "./address-ranges.js";
import { pushDuplicateViolations } from "./duplicates.js";
import type { CheckerViolation } from "./types.js";

function memoryRegionRange(region: {
  readonly startAddressHex: string;
  readonly byteLength: number;
}): AddressRange {
  return toAddressRange(region.startAddressHex, region.byteLength);
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
  const instructionCount = bundle.compiledIr.instructions.length;
  const seen = new Map<string, number>();
  bundle.compiledIr.labels.forEach((label, index) => {
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
  const entrypoint = bundle.compiledIr.entrypointIndex;
  if (entrypoint !== undefined && (entrypoint < 0 || entrypoint >= instructionCount)) {
    violations.push({
      ruleId: "XS-IR-LABEL",
      message: `entrypointIndex ${entrypoint} 越界(指令数 ${instructionCount})`,
      path: "/compiledIr/entrypointIndex",
    });
  }
  return violations;
}

/** XS-STAGE-BUDGET:每阶段 maxInstructionSteps 必须为 ≥ 1 的整数。 */
export function checkStageBudgets(bundle: PrivateChallengeBundle): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
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
    ...checkSecretSinksAreHidden(bundle),
    ...checkPrivateReferenceUniqueness(bundle),
    ...checkPrivateRegisterNamespaces(bundle),
    ...checkPrivateMemoryBudget(bundle),
    ...checkIrLabels(bundle),
    ...checkStageBudgets(bundle),
    ...checkStageReachability(bundle),
    ...checkConditionTrees(bundle),
    ...checkPrivatePageAlignment(bundle),
  ];
}

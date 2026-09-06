/**
 * 多阶段状态机静态校验(WP-2;计划书 7.2 六要素的编译期封闭性增量)。
 *
 * WP-4 检查器已覆盖:迁移目标存在且自首阶段可达(XS-STAGE-REACH)、
 * 每阶段 maxInstructionSteps ≥ 1(XS-STAGE-BUDGET)、前置 / 迁移条件 /
 * 失败条件的谓词引用可解析(XS-PRED-REFS)。本模块补齐检查器未覆盖的
 * 两处引用可解析与封闭性:
 *  - XC-STAGE-SIDE-EFFECT  副作用 fileId 必须落在 secrets.virtualFiles
 *                          (结构化引用,拒绝动态拼接,7.3);
 *  - XC-STAGE-ACTIONS      阶段允许动作必须 ⊆ 公开包 allowedActions
 *                          (docs/contracts/最小DSL范围.md §七:「阶段动作
 *                          不得超出题目允许面」;Schema 只封 12 动作枚举,
 *                          与公开允许面的交集语义归实现层)。
 */

import type { PublicChallengeDescriptor } from "@stackmaster/challenge-schema";
import type { PrivateChallengeBundle } from "@stackmaster/challenge-schema/server-only";
import { compilerViolation, type CompilerViolation } from "../common/diagnostics.js";

/** 状态机封闭性校验(两模式通用;无 stages 时为空操作)。 */
export function validateStages(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CompilerViolation[] {
  const violations: CompilerViolation[] = [];
  const stages = privateBundle.stages ?? [];
  if (stages.length === 0) {
    return violations;
  }

  const fileIds = new Set(privateBundle.secrets.virtualFiles.map((file) => file.fileId));
  const publicAllowedActions = new Set(publicDescriptor.allowedActions);

  stages.forEach((stage, stageIndex) => {
    stage.sideEffects.forEach((sideEffect, effectIndex) => {
      if (!fileIds.has(sideEffect.fileId)) {
        violations.push(compilerViolation(
          "XC-STAGE-SIDE-EFFECT",
          `阶段 ${stage.stageId} 的副作用引用的虚拟文件 "${sideEffect.fileId}" ` +
            `不在 secrets.virtualFiles 声明`,
          `/stages/${stageIndex}/sideEffects/${effectIndex}/fileId`,
        ));
      }
    });
    stage.allowedActions.forEach((action, actionIndex) => {
      if (!publicAllowedActions.has(action)) {
        violations.push(compilerViolation(
          "XC-STAGE-ACTIONS",
          `阶段 ${stage.stageId} 允许动作 "${action}" 不在公开包 allowedActions ` +
            `允许面内(阶段动作不得超出题目允许面)`,
          `/stages/${stageIndex}/allowedActions/${actionIndex}`,
        ));
      }
    });
  });

  return violations;
}

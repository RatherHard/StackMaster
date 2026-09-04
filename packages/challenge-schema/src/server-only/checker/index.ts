/**
 * 字段分类检查器聚合入口(双包Schema语义.md §五冻结契约):
 *
 *   checkChallengePair(public, private): { ok, violations }
 *   Violation = { ruleId, message, path? }
 *
 * 前置条件:两输入均已通过各自 Schema 校验(validatePublicDescriptor /
 * validatePrivateBundle);检查器做 Schema 无法表达的跨字段与跨包一致性,
 * 并对少数 Schema 可拒形态做纵深防御。规则 ID 直接引用 WP-1 §12.6 左列;
 * 每条规则的必触发红灯样例见 test/checker.test.ts(扫描器自检纪律)。
 * XS-DUP-KEY 的落点在 json-strict-parse(严格 JSON 扫描器),其红灯样例
 * 见 test/json-strict-parse.test.ts。
 *
 * SERVER_ONLY:本模块仅经 @stackmaster/challenge-schema/server-only 导出,
 * 只允许后端包消费;检查器输入含私有判题包完整状态,永不跨域。
 */

import type { PublicChallengeDescriptor } from "../../common/public-types.js";
import type { PrivateChallengeBundle } from "../private-types.js";
import { checkArchWidth } from "./arch-rules.js";
import {
  checkCodeRegionWritability,
  checkEncodingProbe,
  checkEncodingTable,
  checkProgramMode,
} from "./encoding-rules.js";
import { checkPrivateBundleRules } from "./private-rules.js";
import {
  checkCanaryCorrespondence,
  checkFlagRegisterPolicy,
  checkHiddenObjectsDisjointFromPublic,
  checkHiddenRegionsDisjointFromPublic,
  checkIdentityCorrespondence,
  checkNoCapabilityStringsInPublic,
  checkNoPrivateIdsInPublic,
  checkProjectionGeometry,
  checkProjectionValuesMirrored,
  checkPublicPrivateRegionMirror,
  checkSeedDeclarations,
  checkPrivateRegistersInDeclarationSet,
  checkVisibleRegistersInDeclarationSet,
  checkVisibleRegistersNotSecretSinks,
} from "./pair-rules.js";
import { checkPublicDescriptorRules } from "./public-rules.js";
import type { CheckerResult, CheckerViolation } from "./types.js";

export type { CheckerResult, CheckerViolation } from "./types.js";
export { RULE_ID_ALIASES } from "./types.js";
export { CAPABILITY_SCAN_PREFIXES } from "./pair-rules.js";
export { checkSchemaMeta } from "./schema-meta.js";

/** 跨包一致性规则(公开 × 私有)。 */
export function checkPairRules(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CheckerViolation[] {
  return [
    ...checkIdentityCorrespondence(publicDescriptor, privateBundle),
    ...checkPublicPrivateRegionMirror(publicDescriptor, privateBundle),
    ...checkHiddenRegionsDisjointFromPublic(publicDescriptor, privateBundle),
    ...checkHiddenObjectsDisjointFromPublic(publicDescriptor, privateBundle),
    ...checkVisibleRegistersNotSecretSinks(publicDescriptor, privateBundle),
    ...checkNoCapabilityStringsInPublic(publicDescriptor),
    ...checkNoPrivateIdsInPublic(publicDescriptor, privateBundle),
    ...checkVisibleRegistersInDeclarationSet(publicDescriptor),
    ...checkPrivateRegistersInDeclarationSet(publicDescriptor, privateBundle),
    ...checkFlagRegisterPolicy(publicDescriptor, privateBundle),
    ...checkProjectionGeometry(publicDescriptor),
    ...checkProjectionValuesMirrored(publicDescriptor, privateBundle),
    ...checkCanaryCorrespondence(publicDescriptor, privateBundle),
    ...checkSeedDeclarations(publicDescriptor, privateBundle),
    ...checkArchWidth(publicDescriptor, privateBundle),
    ...checkProgramMode(publicDescriptor, privateBundle),
    ...checkCodeRegionWritability(publicDescriptor, privateBundle),
    ...checkEncodingTable(publicDescriptor, privateBundle),
    ...checkEncodingProbe(publicDescriptor, privateBundle),
  ];
}

/**
 * 双包联合检查:公开单侧 + 私有单侧 + 跨包一致性。
 * ok = 无任何违规;违规按规则聚合,顺序即上述聚合顺序。
 */
export function checkChallengePair(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CheckerResult {
  const violations: CheckerViolation[] = [
    ...checkPublicDescriptorRules(publicDescriptor),
    ...checkPrivateBundleRules(privateBundle),
    ...checkPairRules(publicDescriptor, privateBundle),
  ];
  return { ok: violations.length === 0, violations };
}

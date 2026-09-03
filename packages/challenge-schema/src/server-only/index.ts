/**
 * @stackmaster/challenge-schema server-only 面。
 *
 * **Schema 存在不等于可下发**(WP-1 第五章 ProjectionPolicy 镜像纪律):
 * 本入口导出的私有判题包契约、校验器与字段分类检查器只允许后端包
 * (challenge-compiler、session-api、verifier)导入;浏览器可达包
 * (vm-ui、web-component、embed-runtime、react-wrapper)导入本子路径
 * 即依赖边界违规(dependency-cruiser 强制)。
 *
 * 私有判题包整体 SERVER_ONLY:校验通过的实例只存在于执行域进程内,
 * 任何字段出现在跨域载荷即违规(WP-1 §12.3,与 VmState"无契约只有禁令"同构)。
 */
export type {
  PredicateRegisterEquals,
  PredicateRegisterBitsSet,
  PredicateMemoryEquals,
  PredicateMemoryContains,
  PredicateRetTargetEquals,
  PredicateStackCanaryIntact,
  PredicateVirtualFileRead,
  PrivatePredicate,
  ConditionL3,
  ConditionL2,
  ConditionL1,
  IrOperand,
  IrInstruction,
  IrLabel,
  CompiledIr,
  MemoryRegionSeed,
  PrivateObjectRecord,
  HiddenTest,
  StageTransition,
  StageSideEffect,
  StageResourceBudget,
  Stage,
  SeedPolicy,
  VirtualFileSecret,
  PrivateSecrets,
  PrivateInitialState,
  JudgingConfig,
  PrivateJudging,
  PrivateChallengeBundle,
} from "./private-types.js";
export { validatePrivateBundle, parsePrivateBundleText } from "./private-bundle.js";
export {
  checkChallengePair,
  checkPairRules,
  checkSchemaMeta,
  CAPABILITY_SCAN_PREFIXES,
  RULE_ID_ALIASES,
} from "./checker/index.js";
export type { CheckerResult, CheckerViolation } from "./checker/index.js";

/**
 * @stackmaster/challenge-schema 公开面。
 *
 * 承载(计划书 7.1 双包模型、5.6 契约纪律):
 * - 公开描述包 JSON Schema 2020-12 校验器(Ajv 严格模式)与手工镜像类型;
 * - 字段分类清单常量(≡ schema/classification.json);
 * - 封闭词汇表、共用模式与数值限制(Schema 与检查器单一来源)。
 *
 * 私有判题包 Schema、类型与字段分类检查器**不在此导出**——仅经
 * `@stackmaster/challenge-schema/server-only` 子路径供后端包
 * (challenge-compiler、session-api、verifier)消费;"Schema 存在不等于
 * 可下发"(WP-1 第五章镜像纪律)。
 *
 * 依赖纪律(5.5):本包为叶子包,不依赖任何工作区包或 vm-engine 产物
 * (tooling/dependency-cruiser.cjs 强制);本包只可被后端包依赖。
 */
export { CHALLENGE_PACKAGE_SCHEMA_VERSION, CHALLENGE_SCHEMA_PACKAGE_VERSION } from "./version.js";
export {
  SESSION_ACTION_TYPES,
  PUBLIC_ERROR_CODES,
  ARCH_BITS_VALUES,
  REGION_KINDS,
  SEMANTIC_HIGHLIGHT_KINDS,
  DSL_OPCODES,
  PREDICATE_TYPES,
  REACHABLE_HIDDEN_TEST_RESULTS,
  PRIVATE_OBJECT_KINDS,
  VISIBILITY_LEVELS,
  HIDDEN_TEST_KINDS,
  REVEAL_POLICIES,
  SEED_STRATEGIES,
  STAGE_SIDE_EFFECT_TYPES,
} from "./common/vocabulary.js";
export type {
  SessionActionType,
  PublicErrorCode,
  ArchBits,
  RegionKind,
  SemanticHighlightKind,
  DslOpcode,
  PredicateType,
  ReachableVerdict,
  PrivateObjectKind,
  VisibilityLevel,
  HiddenTestKind,
  RevealPolicy,
  SeedStrategy,
  StageSideEffectType,
} from "./common/vocabulary.js";
export { BASE_REGISTER_NAMES } from "./common/patterns.js";
export {
  CHALLENGE_ID_PATTERN_SOURCE,
  SEMVER_PATTERN_SOURCE,
  OBJECT_ID_PATTERN_SOURCE,
  BASE_REGISTER_NAME_PATTERN_SOURCE,
  FLAG_REGISTER_NAME_PATTERN_SOURCE,
  HEX_VALUE_64_PATTERN_SOURCE,
  PUBLIC_HEX_VALUE_64_PATTERN_SOURCE,
  PERMISSIONS_PATTERN_SOURCE,
  HEX_BYTES_PATTERN_SOURCE,
  SEED_HEX_PATTERN_SOURCE,
  SEED_PATH_SEGMENT_PATTERN_SOURCE,
  SEED_PATH_PATTERN_SOURCE,
  IR_LABEL_ID_PATTERN_SOURCE,
  DISPLACEMENT_HEX_PATTERN_SOURCE,
  CONTROL_CHARS_BAN_PATTERN_SOURCE,
  CHALLENGE_ID_PATTERN,
  BASE_REGISTER_NAME_PATTERN,
  FLAG_REGISTER_NAME_PATTERN,
  CONTROL_CHARS_BAN_PATTERN,
} from "./common/patterns.js";
export {
  MAX_MEMORY_REGIONS,
  MAX_REGION_BYTE_LENGTH,
  PAGE_SIZE_MULTIPLE_BYTES,
  MIN_PAGE_SIZE_BYTES,
  MAX_PAGE_SIZE_BYTES,
  MAX_MEMORY_TOTAL_BYTES,
  MAX_MEMORY_CONTENT_BYTES,
  MAX_BYTES_HEX_PER_RANGE,
  MAX_WRITE_BYTES,
  MAX_VISIBLE_REGISTERS,
  MAX_VM_REGISTERS,
  MAX_IR_INSTRUCTIONS,
  MAX_IR_LABELS,
  MAX_OPERANDS_PER_INSTRUCTION,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_BRANCHES,
  MAX_STAGES,
  MAX_STAGE_TRANSITIONS,
  MAX_STAGE_SIDE_EFFECTS,
  MAX_HIDDEN_TESTS,
  MAX_PRIVATE_OBJECTS,
  MAX_VIRTUAL_FILES,
  MAX_VIRTUAL_FILE_BYTES,
  MAX_HIDDEN_TEST_PAYLOAD_HEX,
  MAX_SEED_BYTES,
  MAX_MEMORY_EQUALS_BYTES,
  MAX_MEMORY_CONTAINS_BYTES,
  MAX_HINTS,
  MAX_PUBLIC_ERROR_MAPPINGS,
  MAX_SEMANTIC_HIGHLIGHTS,
  MAX_DECLARED_SEED_PATHS,
  MAX_SEED_PATH_SEGMENTS,
  MAX_PREDICATE_EVAL_STEPS,
  MAX_STAGE_INSTRUCTION_STEPS,
} from "./common/limits.js";
export type { FieldClass, SchemaClassificationEntry, ClassificationManifest } from "./common/classification.js";
export {
  PUBLIC_DESCRIPTOR_FIELDS,
  PRIVATE_BUNDLE_FIELDS,
  SHARED_IDENTITY_FIELDS,
  FORBIDDEN_PUBLIC_PROPERTIES,
  CHALLENGE_CLASSIFICATIONS,
} from "./common/classification.js";
export type { SchemaViolation, Validated } from "./common/validation.js";
export type {
  PublicBriefing,
  PublicRegisterSpec,
  PublicCanarySpec,
  PublicVmProfile,
  PublicRegionSpec,
  PublicMemoryLayout,
  PublicResourceLimits,
  PublicHint,
  PublicErrorMapping,
  InitialVisibleRegion,
  InitialVisibleRegister,
  InitialSemanticHighlight,
  InitialProjection,
  PublicChallengeDescriptor,
} from "./common/public-types.js";
export { validatePublicDescriptor, parsePublicDescriptorText } from "./internal/public-descriptor.js";

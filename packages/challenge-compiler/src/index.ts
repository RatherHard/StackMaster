/**
 * @stackmaster/challenge-compiler(WP-2):双包装载管线、编译期校验、
 * 编译器生成面与版本迁移工具。
 *
 * **整体 SERVER_ONLY**:本包只可被后端包(session-api / verifier /
 * 会话编排核心)依赖(dependency-cruiser 强制);装载产物含私有判题包
 * 完整状态与完整 IR,任何字段不得进入跨域载荷。浏览器可达包导入本包
 * 即依赖边界违规,且产物中不得出现本包代码(隔离扫描强制,13.5)。
 *
 * 契约消费立场:本包不新增任何契约字段,只消费冻结的
 * `@stackmaster/challenge-schema`(双包 Schema + WP-4 检查器)与
 * `docs/contracts/最小DSL范围.md` 词汇;编译器自有规则使用 XC- 前缀,
 * 与 WP-1 §12.6 冻结的 XS-* 检查器注册表互不侵占。
 */
export {
  CHALLENGE_COMPILER_PACKAGE_VERSION,
} from "./version.js";
export type {
  CompilerViolation,
  LoadFailureDirection,
} from "./common/diagnostics.js";
export {
  COMPILER_RULE_PREFIX,
  LOAD_FAILURE_RESULT_DIRECTION,
  PLAYER_FACING_ERROR_FOR_LOAD_FAILURE,
  RULE_ID_JSON_PARSE,
  RULE_ID_SCHEMA,
} from "./common/diagnostics.js";
export type {
  ByteLoadedProgram,
  DecodedByteInstruction,
  DecodedOperand,
} from "./byte/decode.js";
export { decodeByteProgram } from "./byte/decode.js";
export type { BackEdge, CfgAnalysis, StaticControlFacts } from "./ir/cfg.js";
export { analyzeCfg, staticControlFacts } from "./ir/cfg.js";
export type {
  AuthorInstruction,
  AuthorOperand,
  AuthorProgram,
  LabelIndexMap,
} from "./ir/labels.js";
export {
  buildLabelIndexMap,
  resolveEntrypointIndex,
  resolveInstructionOperands,
} from "./ir/labels.js";
export {
  describeShapes,
  initialRegisterNames,
  isBaselineOpcode,
  OPCODE_OPERAND_SHAPES,
} from "./ir/opcode-shapes.js";
export type { OperandClass } from "./ir/opcode-shapes.js";
export type { ByteCodeProduct, ByteModeOptions, CompileProgramResult } from "./compile/program.js";
export { compileByteProgram, compileIrProgram, compileProgram } from "./compile/program.js";
export type { ChallengeLoadResult, IrCompiledProgram, LoadedChallenge } from "./load/pipeline.js";
export { loadChallengePair, loadChallengePairTexts } from "./load/pipeline.js";
export { validateStages } from "./stages/validate-stages.js";
export { CURRENT_DSL_SCHEMA_VERSION, REGISTERED_MIGRATIONS } from "./migrate/migrate.js";
export type { MigrationResult, RegisteredMigration } from "./migrate/migrate.js";
export { migrateChallengePair } from "./migrate/migrate.js";

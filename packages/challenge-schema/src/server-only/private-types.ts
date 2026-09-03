/**
 * 私有判题包类型(手工镜像 schema/private-bundle.schema.json)。
 *
 * SERVER_ONLY:本文件仅经 @stackmaster/challenge-schema/server-only 子路径
 * 导出,只允许后端包(challenge-compiler、session-api、verifier)消费。
 * Schema 存在不等于可下发——任何字段出现在跨域载荷即违规(WP-1 §12.3)。
 */

import type {
  DslOpcode,
  HiddenTestKind,
  PredicateType,
  PrivateObjectKind,
  ReachableVerdict,
  RegionKind,
  SeedStrategy,
  SessionActionType,
  StageSideEffectType,
  VisibilityLevel,
} from "../common/vocabulary.js";

/** 七项内置谓词封闭集(oneOf 以 type 判别;docs/最小DSL范围.md §四)。 */
export interface PredicateRegisterEquals {
  readonly type: Extract<PredicateType, "register_equals">;
  readonly register: string;
  readonly valueHex: string;
}

export interface PredicateRegisterBitsSet {
  readonly type: Extract<PredicateType, "register_bits_set">;
  readonly register: string;
  readonly maskHex: string;
}

export interface PredicateMemoryEquals {
  readonly type: Extract<PredicateType, "memory_equals">;
  readonly regionId: string;
  readonly offsetBytes: number;
  readonly bytesHex: string;
}

export interface PredicateMemoryContains {
  readonly type: Extract<PredicateType, "memory_contains">;
  readonly regionId: string;
  readonly bytesHex: string;
}

export interface PredicateRetTargetEquals {
  readonly type: Extract<PredicateType, "ret_target_equals">;
  readonly addressHex: string;
}

export interface PredicateStackCanaryIntact {
  readonly type: Extract<PredicateType, "stack_canary_intact">;
}

export interface PredicateVirtualFileRead {
  readonly type: Extract<PredicateType, "virtual_file_read">;
  readonly fileId: string;
}

export type PrivatePredicate =
  | PredicateRegisterEquals
  | PredicateRegisterBitsSet
  | PredicateMemoryEquals
  | PredicateMemoryContains
  | PredicateRetTargetEquals
  | PredicateStackCanaryIntact
  | PredicateVirtualFileRead;

/** 第三级:谓词叶子。 */
export interface ConditionL3 {
  readonly predicate: PrivatePredicate;
}

/** 第二级布尔组合(all / any / not 至少一键)。 */
export interface ConditionL2 {
  readonly all?: readonly ConditionL3[];
  readonly any?: readonly ConditionL3[];
  readonly not?: ConditionL3;
}

/** 判题条件根(L1;深度静态封顶,XS-NESTING)。 */
export interface ConditionL1 {
  readonly all?: readonly ConditionL2[];
  readonly any?: readonly ConditionL2[];
  readonly not?: ConditionL2;
}

/** 类型化操作数槽(结构安全;逐 opcode 合法性归 challenge-compiler)。 */
export type IrOperand =
  | { readonly kind: "register"; readonly name: string }
  | { readonly kind: "immediate"; readonly valueHex: string }
  | { readonly kind: "memory"; readonly baseRegister?: string; readonly displacementHex?: string };

export interface IrInstruction {
  readonly op: DslOpcode;
  readonly operands?: readonly IrOperand[];
}

export interface IrLabel {
  readonly labelId: string;
  readonly instructionIndex: number;
}

/** IR 信封(版本化序列化格式,不是共享代码;ZR-B3:完整 IR 只进后端)。 */
export interface CompiledIr {
  readonly irFormatVersion: number;
  readonly entrypointIndex?: number;
  readonly instructions: readonly IrInstruction[];
  readonly labels: readonly IrLabel[];
}

/** 初始内存区域(含隐藏区域全字节;contentHex 长度 = 2 × byteLength)。 */
export interface MemoryRegionSeed {
  readonly regionId: string;
  readonly kind: RegionKind;
  readonly startAddressHex: string;
  readonly byteLength: number;
  readonly permissions: string;
  readonly contentHex: string;
  readonly isHidden: boolean;
}

/** 私有对象登记(I-2 / I-3 检查器输入)。 */
export interface PrivateObjectRecord {
  readonly objectId: string;
  readonly kind: PrivateObjectKind;
  readonly addressHex: string;
  readonly byteLength: number;
  readonly visibility: VisibilityLevel;
  readonly containsSecret: boolean;
}

/** 隐藏测试:(输入, 预期判定)对,不是条件表达式(ZR-B2)。 */
export interface HiddenTest {
  readonly testId: string;
  readonly kind: HiddenTestKind;
  readonly payloadHex?: string;
  readonly expectedResult: ReachableVerdict;
}

export interface StageTransition {
  readonly toStageId: string;
  readonly onCondition: ConditionL1;
}

/** v1 封闭副作用:仅 grant_virtual_file(结构化 fileId 引用,拒绝动态拼接)。 */
export interface StageSideEffect {
  readonly type: StageSideEffectType;
  readonly fileId: string;
}

export interface StageResourceBudget {
  readonly maxInstructionSteps: number;
  readonly maxActions?: number;
}

/** 多阶段状态机六要素(7.2;docs/最小DSL范围.md §七)。 */
export interface Stage {
  readonly stageId: string;
  readonly allowedActions: readonly SessionActionType[];
  readonly preconditions: ConditionL1;
  readonly transitions: readonly StageTransition[];
  readonly sideEffects: readonly StageSideEffect[];
  readonly failureConditions: readonly ConditionL1[];
  readonly resourceBudget: StageResourceBudget;
}

export interface SeedPolicy {
  readonly strategy: SeedStrategy;
  readonly seedHex?: string;
}

export interface VirtualFileSecret {
  readonly fileId: string;
  readonly content: string;
}

export interface PrivateSecrets {
  readonly flag: string;
  readonly virtualFiles: readonly VirtualFileSecret[];
}

/** VmState 初始形态(可含 FLAG 寄存器值——FLAG 值永不进入公开面)。 */
export interface PrivateInitialState {
  readonly registers: Readonly<Record<string, string>>;
  readonly memoryRegions: readonly MemoryRegionSeed[];
}

export interface JudgingConfig {
  readonly verdictRuleVersion: string;
  readonly maxPredicateEvalSteps: number;
  readonly timeoutMsPerAction?: number;
  readonly maxTotalActionBytes?: number;
}

export interface PrivateJudging {
  readonly successCondition: ConditionL1;
  readonly failureConditions?: readonly ConditionL1[];
  readonly hiddenTests?: readonly HiddenTest[];
}

/** 私有判题包(整体 SERVER_ONLY)。 */
export interface PrivateChallengeBundle {
  readonly schemaVersion: number;
  readonly challengeId: string;
  readonly challengeContentVersion: string;
  readonly vmProfileVersion: string;
  readonly dslSchemaVersion: number;
  readonly vmEngineVersion: string;
  readonly engineBuildId?: string;
  readonly declaredSeedPublicPaths: readonly string[];
  readonly seedPolicy: SeedPolicy;
  readonly initialState: PrivateInitialState;
  readonly secretSinkRegisters?: readonly string[];
  readonly secrets: PrivateSecrets;
  readonly privateObjects: readonly PrivateObjectRecord[];
  readonly judging: PrivateJudging;
  readonly stages?: readonly Stage[];
  readonly compiledIr: CompiledIr;
  readonly judgingConfig: JudgingConfig;
}

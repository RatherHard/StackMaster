/**
 * 私有判题包类型(手工镜像 schema/private-bundle.schema.json)。
 *
 * SERVER_ONLY:本文件仅经 @stackmaster/challenge-schema/server-only 子路径
 * 导出,只允许后端包(challenge-compiler、session-api、verifier)消费。
 * Schema 存在不等于可下发——任何字段出现在跨域载荷即违规(WP-1 §12.3)。
 */

import type {
  BitMaskLogic,
  DslMicroOp,
  DslOpcode,
  EffectPrimitive,
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

/** 七项内置谓词封闭集(oneOf 以 type 判别;docs/contracts/最小DSL范围.md §四)。 */
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
  | { readonly kind: "memory"; readonly baseRegister?: string; readonly displacementHex?: string }
  | { readonly kind: "interface"; readonly interfaceId: number };

/**
 * IR 指令操作码双形态(G4/D4):基线小写 opcode 枚举或大写自定义助记符
 * (两形态按大小写结构性不相交;助记符引用必须落在 customInstructions[],
 * XS-CUSTOM-REF)。
 */
export type IrInstructionOp = DslOpcode | CustomInstructionMnemonic;

/** 作者自定义指令助记符(模式与存在性由 Schema + 检查器强制)。 */
export type CustomInstructionMnemonic = string;

export interface IrInstruction {
  readonly op: IrInstructionOp;
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

/** 微算子:立即数装载(定步数直线原语,G4/D4 封闭集 v1)。 */
export interface MicroOpLoadImm {
  readonly op: Extract<DslMicroOp, "load_imm">;
  readonly dst: string;
  readonly valueHex: string;
}

/** 微算子:寄存器间传送。 */
export interface MicroOpMovReg {
  readonly op: Extract<DslMicroOp, "mov_reg">;
  readonly dst: string;
  readonly src: string;
}

/** 微算子:基址 + 位移内存读(统一权限检查与 I-9 统一拒绝路径)。 */
export interface MicroOpLoadMem {
  readonly op: Extract<DslMicroOp, "load_mem">;
  readonly dst: string;
  readonly baseRegister: string;
  readonly displacementHex: string;
}

/** 微算子:基址 + 位移内存写(同上)。 */
export interface MicroOpStoreMem {
  readonly op: Extract<DslMicroOp, "store_mem">;
  readonly baseRegister: string;
  readonly displacementHex: string;
  readonly src: string;
}

/** 微算子:标志置位(FLAG 写入的唯一微算子,I-3 污点检查落点)。 */
export interface MicroOpSetFlag {
  readonly op: Extract<DslMicroOp, "set_flag">;
  readonly flagRegister: string;
  readonly valueHex: string;
}

/** 微算子:位掩蔽运算。 */
export interface MicroOpBitMask {
  readonly op: Extract<DslMicroOp, "bit_mask">;
  readonly dst: string;
  readonly src: string;
  readonly maskHex: string;
  readonly logic: BitMaskLogic;
}

/** 微算子封闭集 v1(直线语义:集合内无控制转移,CFG 静态分析保持)。 */
export type DslMicroOpInstruction =
  | MicroOpLoadImm
  | MicroOpMovReg
  | MicroOpLoadMem
  | MicroOpStoreMem
  | MicroOpSetFlag
  | MicroOpBitMask;

/** 作者自定义指令 = 声明式映射表条目(数据,非代码;恒定步数 = semantics 长度)。 */
export interface CustomInstruction {
  readonly mnemonic: CustomInstructionMnemonic;
  readonly displayText: string;
  readonly semantics: readonly DslMicroOpInstruction[];
}

/** 效果原语:程序终止(保留内置语义,等效 exit(0))。 */
export interface EffectExit {
  readonly effect: Extract<EffectPrimitive, "exit">;
}

/** 效果原语:授予虚拟文件 capability(结构化 fileId 引用)。 */
export interface EffectGrantVirtualFile {
  readonly effect: Extract<EffectPrimitive, "grant_virtual_file">;
  readonly fileId: string;
}

/** 效果原语:标记虚拟文件已读(衔接谓词 virtual_file_read)。 */
export interface EffectVirtualFileRead {
  readonly effect: Extract<EffectPrimitive, "virtual_file_read">;
  readonly fileId: string;
}

/** 效果原语:置 FLAG 汇寄存器(经 I-3 污点检查)。 */
export interface EffectSetFlag {
  readonly effect: Extract<EffectPrimitive, "set_flag">;
  readonly flagRegister: string;
  readonly valueHex: string;
}

/** 效果原语:无操作。 */
export interface EffectNoop {
  readonly effect: Extract<EffectPrimitive, "noop">;
}

/** 接口效果原语封闭集 v1(无宿主 IO 原语,F-4 保持)。 */
export type InterfaceEffect =
  | EffectExit
  | EffectGrantVirtualFile
  | EffectVirtualFileRead
  | EffectSetFlag
  | EffectNoop;

/** 作者接口 = syscall / call 的可调用封闭操作(恒定步数 = effects 长度)。 */
export interface AuthorInterface {
  readonly interfaceId: number;
  readonly displayText: string;
  readonly effects: readonly InterfaceEffect[];
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

/** 多阶段状态机六要素(7.2;docs/contracts/最小DSL范围.md §七)。 */
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
  /** IR 模式程序信封;字节模式必须省略(G5/D6,XS-PROG-MODE)。 */
  readonly compiledIr?: CompiledIr;
  /** 字节模式入口地址;IR 模式必须省略(G5/D6,XS-PROG-MODE)。 */
  readonly entrypointAddressHex?: string;
  readonly customInstructions?: readonly CustomInstruction[];
  readonly interfaces?: readonly AuthorInterface[];
  readonly judgingConfig: JudgingConfig;
}

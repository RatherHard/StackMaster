/**
 * 题目双包的封闭词汇表(冻结枚举)。
 *
 * 词汇唯一来源是 docs/最小DSL范围.md(指令面 / 谓词面 / 编排面)与
 * WP-1 清单第十二章(会话动作、公开错误码沿用 protocol 冻结面);
 * Schema 内的枚举与本常量严格一致,由 schema-strictness 测试与
 * 跨包一致性测试双向防漂移。变更必须先走契约变更流程(先改
 * challenge-schema Schema 与正反 fixture,再改实现)。
 */

/** 12 会话动作冻结枚举(与 @stackmaster/protocol ActionRequest 判别式一致)。 */
export const SESSION_ACTION_TYPES = [
  "write_bytes",
  "push",
  "pop",
  "call",
  "ret",
  "step",
  "run_to_event",
  "pause",
  "undo",
  "checkout_checkpoint",
  "reset",
  "create_checkpoint",
] as const;
export type SessionActionType = (typeof SESSION_ACTION_TYPES)[number];

/** 16 公开错误码冻结枚举(与 @stackmaster/protocol PublicError 一致)。 */
export const PUBLIC_ERROR_CODES = [
  "invalid_input_format",
  "invalid_payload_length",
  "offset_out_of_range",
  "endianness_mismatch",
  "permission_denied",
  "invalid_rip",
  "canary_violation",
  "invalid_call_argument",
  "objective_not_met",
  "inaccessible_address",
  "budget_exhausted",
  "stale_base_revision",
  "stale_client_seq",
  "idempotency_conflict",
  "session_terminal",
  "internal_error",
] as const;
export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

/** 架构位宽声明冻结枚举(G1/D1:《Vm 模块设计冲突与整改方案》;公开包 vmProfile.archBits)。 */
export const ARCH_BITS_VALUES = [32, 64] as const;
export type ArchBits = (typeof ARCH_BITS_VALUES)[number];

/** 内存区域六类(6.1 MVP 虚拟硬件;docs/最小DSL范围.md §二;custom 为作者自定义类型,publicLabel 承载类型名——G3 整改)。 */
export const REGION_KINDS = ["code", "global", "stack", "heap", "key", "custom"] as const;
export type RegionKind = (typeof REGION_KINDS)[number];

/** 语义高亮五类(协议 PublicStateProjection.semanticHighlights 冻结枚举)。 */
export const SEMANTIC_HIGHLIGHT_KINDS = [
  "buffer_start",
  "return_address_slot",
  "saved_rbp_slot",
  "canary_slot",
  "custom",
] as const;
export type SemanticHighlightKind = (typeof SEMANTIC_HIGHLIGHT_KINDS)[number];

/** 20 基线 opcode 封闭枚举(docs/最小DSL范围.md §三.1 v1.2;G4/D4 重定基:移除教学 IO read/write,新增栈帧 leave;与私有包 Schema 基线枚举一致)。 */
export const DSL_OPCODES = [
  "mov",
  "push",
  "pop",
  "leave",
  "add",
  "sub",
  "cmp",
  "and",
  "or",
  "xor",
  "shl",
  "shr",
  "jmp",
  "je",
  "jne",
  "jb",
  "jae",
  "call",
  "ret",
  "syscall",
] as const;
export type DslOpcode = (typeof DSL_OPCODES)[number];

/** 保留系统号带上限(G4/D4:syscall 立即数 ∈ [0x0000, 0x00FF] 走内置语义,当前仅 exit(I),语义不变;作者接口号带从 0x0100 起,两带结构性不相交)。 */
export const RESERVED_SYSCALL_BAND_MAX = 0xff;

/** 表层机器码操作数形态判别封闭集(G5/D6:编码表条目 operands 的 kind;与 IR 操作数槽同词汇,encoding 专有的 width 字段承载内联宽度声明)。 */
export const ENCODING_OPERAND_KINDS = ["register", "immediate", "memory", "interface"] as const;
export type EncodingOperandKind = (typeof ENCODING_OPERAND_KINDS)[number];

/** 作者接口 interfaceId 下限(G4/D4;与保留系统号带结构性不相交)。 */
export const INTERFACE_ID_MIN = 0x100;

/** 作者接口 interfaceId 上限。 */
export const INTERFACE_ID_MAX = 0xffff;

/**
 * 微算子封闭集 v1(G4/D4 作者自定义指令,docs/最小DSL范围.md §三.2):
 * 全部为定步数直线原语——集合内不存在控制转移,自定义指令的 CFG 静态分析
 * 完全保持;求值步数 = 序列长度,与操作数值无关(T-SC2 逐条可断言)。
 */
export const MICRO_OPS = [
  "load_imm",
  "mov_reg",
  "load_mem",
  "store_mem",
  "set_flag",
  "bit_mask",
] as const;
export type DslMicroOp = (typeof MICRO_OPS)[number];

/** bit_mask 微算子的位逻辑枚举。 */
export const BIT_MASK_LOGIC_OPS = ["and", "or", "xor"] as const;
export type BitMaskLogic = (typeof BIT_MASK_LOGIC_OPS)[number];

/** 接口效果原语封闭集 v1(G4/D4 作者接口面,docs/最小DSL范围.md §三.3;无宿主 IO 原语,F-4 保持)。 */
export const EFFECT_PRIMITIVES = [
  "exit",
  "grant_virtual_file",
  "virtual_file_read",
  "set_flag",
  "noop",
] as const;
export type EffectPrimitive = (typeof EFFECT_PRIMITIVES)[number];

/** 七项内置谓词封闭集(docs/最小DSL范围.md §四)。 */
export const PREDICATE_TYPES = [
  "register_equals",
  "register_bits_set",
  "memory_equals",
  "memory_contains",
  "ret_target_equals",
  "stack_canary_intact",
  "virtual_file_read",
] as const;
export type PredicateType = (typeof PREDICATE_TYPES)[number];

/** 隐藏测试可授权期望判定:7 值可达枚举(D6;challenge_invalid / replay_mismatch / cancelled / engine_error 非可授权期望)。 */
export const REACHABLE_HIDDEN_TEST_RESULTS = [
  "success",
  "wrong_answer",
  "invalid_action",
  "program_crash",
  "memory_fault",
  "resource_limit",
  "timeout",
] as const;
export type ReachableVerdict = (typeof REACHABLE_HIDDEN_TEST_RESULTS)[number];

/** 私有对象类别(I-2 / I-3 检查器输入面)。 */
export const PRIVATE_OBJECT_KINDS = [
  "buffer",
  "canary",
  "saved_rbp",
  "return_address",
  "file",
  "other",
] as const;
export type PrivateObjectKind = (typeof PRIVATE_OBJECT_KINDS)[number];

/** 对象 / 区域可见性。 */
export const VISIBILITY_LEVELS = ["public", "hidden"] as const;
export type VisibilityLevel = (typeof VISIBILITY_LEVELS)[number];

/** 隐藏测试类别。 */
export const HIDDEN_TEST_KINDS = ["reference_payload", "predicate_probe"] as const;
export type HiddenTestKind = (typeof HIDDEN_TEST_KINDS)[number];

/** 提示阶梯展示策略。 */
export const REVEAL_POLICIES = ["on_request", "after_n_failures"] as const;
export type RevealPolicy = (typeof REVEAL_POLICIES)[number];

/** seed 策略(6.3:随机化只用可复现服务端 seed;确定性由 vmEngineVersion 锁定)。 */
export const SEED_STRATEGIES = ["fixed", "server_random_per_session"] as const;
export type SeedStrategy = (typeof SEED_STRATEGIES)[number];

/** 状态机副作用封闭集 v1(docs/最小DSL范围.md §七;拒绝动态拼接 capability)。 */
export const STAGE_SIDE_EFFECT_TYPES = ["grant_virtual_file"] as const;
export type StageSideEffectType = (typeof STAGE_SIDE_EFFECT_TYPES)[number];

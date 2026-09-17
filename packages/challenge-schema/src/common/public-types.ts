/**
 * 公开描述包类型(手工镜像 schema/public-descriptor.schema.json)。
 *
 * TS 类型为手工镜像,防漂移靠完整正反样例测试与 Schema 严格性测试
 * (双包Schema语义.md §六);本包保持叶子包,不依赖 protocol/Zod。
 * 全部只读:公开包一旦通过校验即视为不可变输入。
 */

import type {
  ArchBits,
  PublicErrorCode,
  RegionKind,
  SemanticHighlightKind,
  SessionActionType,
} from "./vocabulary.js";
import type { AuthorBlockSlotKind } from "./author-blocks.js";

export interface PublicBriefing {
  readonly title: string;
  readonly summary: string;
  readonly learningObjectives: readonly string[];
  readonly teachingNotes?: readonly string[];
}

export interface PublicRegisterSpec {
  readonly name: string;
  readonly displayLabel?: string;
}

export interface PublicCanarySpec {
  readonly enabled: boolean;
  readonly sizeBytes?: number;
}

/**
 * 编码表操作数形态(G5/D6;R12 冻结:immediate.width 与
 * memory.displacementWidth 必填且恒为 "arch"——内联字节宽度不得依赖
 * 执行层隐式推断;R11:register / memory.baseRegister 限一般命名空间,
 * FLAG 寄存器结构性不可编码)。
 */
export type EncodingOperandShape =
  | {
      readonly kind: "register";
      readonly name: string;
    }
  | {
      readonly kind: "immediate";
      readonly width: "arch";
    }
  | {
      readonly kind: "memory";
      readonly baseRegister: string;
      readonly displacementWidth: "arch";
    }
  | {
      readonly kind: "interface";
      readonly interfaceId: number;
    };

export interface EncodingTableEntry {
  readonly tokenHex: string;
  readonly op: string;
  readonly operands?: readonly EncodingOperandShape[];
}

export interface PublicVmProfile {
  readonly registers: readonly PublicRegisterSpec[];
  readonly flagRegisterNames?: readonly string[];
  /** 架构位宽声明(G1/D1):双包全部架构值的位宽域(XS-ARCH-WIDTH),私有包不复制本字段。 */
  readonly archBits: ArchBits;
  readonly endianness: "little";
  readonly pageSizeBytes: number;
  readonly canary: PublicCanarySpec;
  /** 表层机器码 token 字典(G5/D6);存在即选择字节权威执行模式。 */
  readonly encodingTable?: readonly EncodingTableEntry[];
}

export interface PublicRegionSpec {
  readonly regionId: string;
  readonly kind: RegionKind;
  readonly startAddressHex: string;
  readonly byteLength: number;
  readonly permissions: string;
  readonly publicLabel: string;
}

export interface PublicMemoryLayout {
  readonly regions: readonly PublicRegionSpec[];
}

export interface PublicResourceLimits {
  readonly predicateEvalBudgetPerSession?: number;
  readonly rollbackBudgetPerSession?: number;
  readonly maxWriteBytesPerAction?: number;
}

export interface PublicHint {
  readonly order: number;
  readonly revealPolicy: "on_request" | "after_n_failures";
  readonly failureThreshold?: number;
  readonly hintText: string;
}

export interface PublicErrorMapping {
  readonly errorCode: PublicErrorCode;
  readonly teachingNote: string;
}

/** 初始投影可见区域(与协议 VisibleMemoryRegion 同形)。 */
export interface InitialVisibleRegion {
  readonly regionId: string;
  readonly label: string;
  readonly startAddressHex: string;
  readonly byteLength: number;
  readonly permissions: string;
  readonly bytesHex: string;
  readonly truncated: boolean;
}

export interface InitialVisibleRegister {
  readonly name: string;
  readonly valueHex: string;
}

export interface InitialSemanticHighlight {
  readonly kind: SemanticHighlightKind;
  readonly targetRegionId: string;
  readonly startAddressHex: string;
  readonly byteLength: number;
  readonly label: string;
}

/**
 * 初始投影(部分镜像):仅作者可声明的三个子形状;
 * revision / callStackSummary / controlFlow / status 结构性排除(WP-1 §12.2.1)。
 */
export interface InitialProjection {
  readonly visibleRegions: readonly InitialVisibleRegion[];
  readonly visibleRegisters: readonly InitialVisibleRegister[];
  readonly semanticHighlights?: readonly InitialSemanticHighlight[];
}

/**
 * 出题者积木参数槽位(M10 / WP-80;D-MP-6 定案形状)。
 * `kind` 决定编译期取值转换:`address` → 地址串;`immediate` / `length` → 数值。
 */
export interface AuthorBlockSlot {
  readonly key: string;
  readonly label: string;
  readonly kind: AuthorBlockSlotKind;
}

/**
 * 积木动作参数位取值:字面量串,或对模板已声明槽位的引用(`{ slot: <key> }`)。
 * 两部分在 Schema 层结构性互斥(`oneOf`),不存在"引用与字面量并存"的第三种形态。
 */
export type AuthorBlockArgValue = string | { readonly slot: string };

/**
 * 积木模板的单条动作(12 公开动作的子集;`type` 由 Schema 封闭枚举冻结)。
 * 参数位名称受 `AUTHOR_BLOCK_ARG_NAMES` 约束,逐动作允许/必填集见
 * `AUTHOR_BLOCK_ACTION_ARGS`(检查器 XS-BLOCK-ARG-ALLOW)。
 */
export interface AuthorBlockAction {
  readonly type: SessionActionType;
  readonly args: Readonly<Record<string, AuthorBlockArgValue>>;
}

/**
 * 出题者积木模板声明(M10 / WP-80;公开描述包可选顶层字段 `authorBlocks`)。
 *
 * `interfaceId` 是公开 ISA 引用(与 `encodingTable[].operands[].kind = "interface"`
 * 同一公开语义):仅揭示接口存在性与公开标识,**不揭示效果语义**;效果原语序列
 * 仍整体留在私有包 `interfaces[].effects`。
 */
export interface AuthorBlockDecl {
  readonly id: string;
  readonly displayText: string;
  readonly interfaceId: number;
  readonly slots: readonly AuthorBlockSlot[];
  readonly actions: readonly AuthorBlockAction[];
}

/** 公开描述包(整体 PUBLIC;可下发浏览器)。 */
export interface PublicChallengeDescriptor {  readonly schemaVersion: number;
  readonly challengeId: string;
  readonly challengeContentVersion: string;
  /** VM Profile Version(7.4 第 3 类);与私有包同值(XS-ID-CORR)。 */
  readonly vmProfileVersion: string;
  readonly locale: string;
  readonly briefing: PublicBriefing;
  readonly vmProfile: PublicVmProfile;
  readonly memoryLayout: PublicMemoryLayout;
  readonly allowedActions: readonly SessionActionType[];
  readonly resourceLimits: PublicResourceLimits;
  readonly hintLadder: readonly PublicHint[];
  readonly publicErrorMapping: readonly PublicErrorMapping[];
  readonly randomizationNotice?: string;
  /**
   * 调试能力开关(WP-43 / ADR-DC1 决议 1):opt-out,缺省 = true(题目默认
   * 启用调试);仅能力声明,零派生值。未启用题目由前端隐藏模式切换项(决议 4)。
   */
  readonly debugMode?: boolean;
  /**
   * ASLR 开关(WP-43 / ADR-DC1 决议 2):缺省 = false;true 时 memoryLayout
   * 为结构描述(镜像内相对布局),真实基址会话期由调试/真实种子各自派生
   * (SeedDeriver 应用面,WP-42),公开投影仍携带会话真实地址。
   */
  readonly aslrEnabled?: boolean;
  readonly initialProjection: InitialProjection;
  /**
   * 出题者积木最小声明面(M10 / WP-80;可选顶层字段,不进 `required`)。
   *
   * 形状 = D-MP-6 定案:每项 `{id, displayText, interfaceId, slots, actions}`。
   * 缺失 = 该题不下发作者积木(工作区工具箱与既有积木集零变化——回归护栏)。
   * **公开面不承载**效果原语序列、隐藏接口存在性、私有谓词或任何 `SERVER_ONLY`
   * 语义(逐字段论证见《数据分类与秘密零驻留清单》§12.2 `authorBlocks` 行)。
   */
  readonly authorBlocks?: readonly AuthorBlockDecl[];
}

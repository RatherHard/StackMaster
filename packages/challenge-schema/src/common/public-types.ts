/**
 * 公开描述包类型(手工镜像 schema/public-descriptor.schema.json)。
 *
 * TS 类型为手工镜像,防漂移靠完整正反样例测试与 Schema 严格性测试
 * (双包Schema语义.md §六);本包保持叶子包,不依赖 protocol/Zod。
 * 全部只读:公开包一旦通过校验即视为不可变输入。
 */

import type { PublicErrorCode, RegionKind, SemanticHighlightKind, SessionActionType } from "./vocabulary.js";

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

export interface PublicVmProfile {
  readonly registers: readonly PublicRegisterSpec[];
  readonly flagRegisterNames?: readonly string[];
  readonly endianness: "little";
  readonly pageSizeBytes: number;
  readonly canary: PublicCanarySpec;
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

/** 公开描述包(整体 PUBLIC;可下发浏览器)。 */
export interface PublicChallengeDescriptor {
  readonly schemaVersion: number;
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
  readonly initialProjection: InitialProjection;
}

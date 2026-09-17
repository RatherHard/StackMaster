/**
 * 公开描述包客户端加载器(阶段五 WP-54;校验清单 M2 / FE-ED-06~07 正式下发
 * 通道消费;§8.3「哈希 + 尺寸护栏双闸」的客户端侧;D-API-76 端点语义)。
 *
 * 获取流程(每步确定性拒绝;失败语义见 DescriptorFailureReason):
 *   1. 定位参数闸:origin 须为可解析 http(s) origin(bootstrap.ts isHttpOrigin
 *      同则),challengeId 走 protocol 冻结标识符字符集,version 客户端路径
 *      卫生(权威字符集闸在服务端 D-API-76 第 1 步,本闸只防构造越轨 URL);
 *   2. `GET {origin}/descriptors/{challengeId}/{version}`(无凭证;网络失败
 *      至多一次显式重试——不重试风暴,登记于 WP-54 决策草稿);
 *   3. 非 200:404 → `not-found`(与未登记 / 参数违规服务端同形,防枚举,
 *      客户端不区分);其余 → `http-status`;
 *   4. **尺寸护栏第一闸**:Content-Length 显式超限或响应体字节超
 *      `maxBodyBytes` → `over-limit`(解析前强制,与服务端
 *      SESSION_API_MAX_DESCRIPTOR_BYTES 成对);
 *   5. **完整性闸**:`ETag`(= 登记摘要,剥引号 / 弱化前缀)缺失 →
 *      `etag-missing`;WebCrypto SHA-256 复算与 ETag 比对不符 →
 *      `digest-mismatch`(篡改红灯);
 *   6. JSON 解析失败 → `invalid-json`;**尺寸护栏第二闸**(嵌套深度 / 数组
 *      长度 / 字符串长度,与服务端 D-API-31 同值装配)越限 → `over-limit`;
 *   7. **结构校验**(轻量形状检查,对齐锚 = challenge-schema 公开描述包
 *      Schema 17 字段;依赖纪律:浏览器包禁 import challenge-schema,形态
 *      对齐由测试锚定——见 test/descriptor/ 与 challenge-schema 包的
 *      fixture 一致性断言)→ 坏形态 `bad-shape`;
 *   8. 产出强类型 `ChallengeDescriptorView`(本地结构类型,沿 ed-types.ts
 *      先例;debugMode / aslrEnabled 按 Schema 语义归一为布尔:opt-out 缺省
 *      true / 缺省 false;M10/WP-80 新增可选 `authorBlocks` 声明面)。
 *
 * 失败呈现纪律(FE-ED 缺席形态):全部失败折叠为布尔结果 + 确定性原因码,
 * 调用方只呈现「描述包缺席」静态明示,失败细节(原因码属于诊断面,不进
 * 玩家可见 DOM 文案)零内部透出;不中断会话、不重试风暴。
 */
import {
  IDENTIFIER_CHARSET_PATTERN,
  OPAQUE_ID_MAX_LENGTH,
  PUBLIC_ERROR_CODES,
  SESSION_ACTION_TYPES,
} from "@stackmaster/protocol";

import type {
  PayloadAuthorBlockAction,
  PayloadAuthorBlockArgValue,
  PayloadAuthorBlockDecl,
  PayloadAuthorBlockSlot,
} from "../payload/compiler/blocks.js";
import type { PublicErrorMapping, PublicHint } from "../ed/ed-types.js";

// ── 客户端尺寸护栏(与 §8.3 服务端护栏成对的双闸;数值登记于 WP-54 决策草稿)──

/**
 * 客户端护栏数值(定案):与服务端同值装配——
 *  - `maxBodyBytes` = 262144(服务端 `SESSION_API_MAX_DESCRIPTOR_BYTES` 默认值,
 *    D-API-76 配置表);
 *  - `maxJsonDepth` = 16、`maxArrayLength` = 256、`maxStringLength` = 4096
 *    (与 D-API-31 请求护栏 / D-API-76 描述包结构巡检同值)。
 */
/** 客户端护栏数值面(可整体注入替身供测试收紧;生产恒用 DESCRIPTOR_CLIENT_GUARDS)。 */
export interface DescriptorGuardLimits {
  /** 响应体字节上限(解析前强制)。 */
  readonly maxBodyBytes: number;
  /** JSON 嵌套深度上限。 */
  readonly maxJsonDepth: number;
  /** 数组长度上限。 */
  readonly maxArrayLength: number;
  /** 字符串长度上限。 */
  readonly maxStringLength: number;
}

/** 客户端护栏数值(定案;类型面 = DescriptorGuardLimits 宽化,注入只收敛不放宽语义)。 */
export const DESCRIPTOR_CLIENT_GUARDS: DescriptorGuardLimits = {
  /** 响应体字节上限(解析前强制)。 */
  maxBodyBytes: 262144,
  /** JSON 嵌套深度上限。 */
  maxJsonDepth: 16,
  /** 数组长度上限。 */
  maxArrayLength: 256,
  /** 字符串长度上限。 */
  maxStringLength: 4096,
};

// ── 失败语义 ─────────────────────────────────────────────────────────────────

/**
 * 确定性失败原因(诊断面;玩家可见呈现恒为「描述包缺席」静态明示,本枚举
 * 不进 DOM 文案)。
 */
export type DescriptorFailureReason =
  /** 定位参数不合法(客户端 URL 卫生闸)。 */
  | "invalid-input"
  /** 网络失败(一次显式重试后仍失败)。 */
  | "network"
  /** 404(未登记 / 参数违规;服务端同形,客户端不区分)。 */
  | "not-found"
  /** 其余非 200 状态。 */
  | "http-status"
  /** 响应体不是合法 JSON。 */
  | "invalid-json"
  /** ETag 缺失或不可读(跨源部署未暴露 ETag 响应头时亦落此态——登记面)。 */
  | "etag-missing"
  /** 响应体 SHA-256 与 ETag 登记摘要不符(篡改红灯)。 */
  | "digest-mismatch"
  /** 尺寸护栏越限(字节 / 深度 / 数组 / 字符串)。 */
  | "over-limit"
  /** 结构坏形态(轻量形状检查拒绝)。 */
  | "bad-shape"
  /** 摘要原语不可用(非浏览器 SecureContext 且无注入;测试需注入 sha256Hex)。 */
  | "digest-unavailable";

/** 加载结果:成功携带强类型视图,失败携带确定性原因(布尔结果面)。 */
export type ChallengeDescriptorOutcome =
  | { readonly ok: true; readonly descriptor: ChallengeDescriptorView }
  | { readonly ok: false; readonly reason: DescriptorFailureReason };

// ── 强类型视图(本地结构类型;对齐锚 = challenge-schema 公开 Schema)──────────

/** briefing 切面(Schema:learningObjectives minItems 1;teachingNotes 可选)。 */
export interface DescriptorBriefingView {
  readonly title: string;
  readonly summary: string;
  readonly learningObjectives: readonly string[];
  readonly teachingNotes?: readonly string[];
}

/** 编码表操作数形态(G5/D6;与 challenge-schema EncodingOperandShape 同形)。 */
export type DescriptorEncodingOperandView =
  | { readonly kind: "register"; readonly name: string }
  | { readonly kind: "immediate"; readonly width: "arch" }
  | { readonly kind: "memory"; readonly baseRegister: string; readonly displacementWidth: "arch" }
  | { readonly kind: "interface"; readonly interfaceId: number };

/** 编码表条目(tokenHex / op / operands 可选)。 */
export interface DescriptorEncodingEntryView {
  readonly tokenHex: string;
  readonly op: string;
  readonly operands?: readonly DescriptorEncodingOperandView[];
}

/** VM Profile 切面(静态面渲染消费;encodingTable 存在 = 字节权威执行模式)。 */
export interface DescriptorVmProfileView {
  readonly registers: readonly { readonly name: string; readonly displayLabel?: string }[];
  readonly flagRegisterNames?: readonly string[];
  readonly archBits: number;
  readonly endianness: "little";
  readonly pageSizeBytes: number;
  readonly canary: { readonly enabled: boolean; readonly sizeBytes?: number };
  readonly encodingTable?: readonly DescriptorEncodingEntryView[];
}

/** 内存布局区域切面。 */
export interface DescriptorRegionView {
  readonly regionId: string;
  readonly kind: string;
  readonly startAddressHex: string;
  readonly byteLength: number;
  readonly permissions: string;
  readonly publicLabel: string;
}

/** 初始投影切面(部分镜像:仅作者可声明的三个子形状)。 */
export interface DescriptorInitialProjectionView {
  readonly visibleRegions: readonly {
    readonly regionId: string;
    readonly label: string;
    readonly startAddressHex: string;
    readonly byteLength: number;
    readonly permissions: string;
    readonly bytesHex: string;
    readonly truncated: boolean;
  }[];
  readonly visibleRegisters: readonly { readonly name: string; readonly valueHex: string }[];
  readonly semanticHighlights?: readonly {
    readonly kind: string;
    readonly targetRegionId: string;
    readonly startAddressHex: string;
    readonly byteLength: number;
    readonly label: string;
  }[];
}

/**
 * 公开描述包强类型视图(17 字段;`hintLadder` / `publicErrorMapping` 直接
 * 复用 ed-types 的结构类型 = ED 组件注入面零转换)。
 *
 * `debugMode` / `aslrEnabled` 已按 Schema 语义归一为布尔(登记):debugMode
 * 为 opt-out(缺省 = true)、aslrEnabled 缺省 = false;消费方不再各自解释缺席。
 *
 * M10/WP-80:`authorBlocks` 为**可选**字段(缺省 = 题目未声明积木模板 ⇒
 * Payload 面板与既有一字不差)。
 */
export interface ChallengeDescriptorView {
  readonly schemaVersion: number;
  readonly challengeId: string;
  readonly challengeContentVersion: string;
  readonly vmProfileVersion: string;
  readonly locale: string;
  readonly briefing: DescriptorBriefingView;
  readonly vmProfile: DescriptorVmProfileView;
  readonly memoryLayout: { readonly regions: readonly DescriptorRegionView[] };
  readonly allowedActions: readonly string[];
  readonly resourceLimits: {
    readonly predicateEvalBudgetPerSession?: number;
    readonly rollbackBudgetPerSession?: number;
    readonly maxWriteBytesPerAction?: number;
  };
  readonly hintLadder: readonly PublicHint[];
  readonly publicErrorMapping: readonly PublicErrorMapping[];
  readonly randomizationNotice?: string;
  readonly debugMode: boolean;
  readonly aslrEnabled: boolean;
  readonly initialProjection: DescriptorInitialProjectionView;
  readonly authorBlocks?: readonly PayloadAuthorBlockDecl[];
}

// ── 工作区静态面投影(标题 / 简介 / VM Profile / encodingTable)───────────────

/**
 * 工作区静态面(WP-54;`<sm-workspace>` 的 `challengeStatic` 注入形状)——
 * 描述包视图的投影切面,只携带静态面渲染所需字段(零视觉重设计的数据面)。
 */
export interface ChallengeStaticFace {
  readonly title: string;
  readonly summary: string;
  readonly archBits: number;
  readonly endianness: string;
  readonly pageSizeBytes: number;
  readonly registerNames: readonly string[];
  readonly canaryEnabled: boolean;
  readonly encodingTable: readonly DescriptorEncodingEntryView[];
}

/** 从描述包视图投影静态面(纯函数;workspace 注入前调用)。 */
export function challengeStaticFace(view: ChallengeDescriptorView): ChallengeStaticFace {
  return {
    title: view.briefing.title,
    summary: view.briefing.summary,
    archBits: view.vmProfile.archBits,
    endianness: view.vmProfile.endianness,
    pageSizeBytes: view.vmProfile.pageSizeBytes,
    registerNames: view.vmProfile.registers.map((register) => register.name),
    canaryEnabled: view.vmProfile.canary.enabled,
    encodingTable: view.vmProfile.encodingTable ?? [],
  };
}

// ── 输入与获取 ───────────────────────────────────────────────────────────────

/** 加载器输入(origin + 题目定位 + 注入缝)。 */
export interface FetchChallengeDescriptorInput {
  /** session-api 浏览器面 origin(绝对 http(s);来自引导配置或 dev 壳显式给定)。 */
  readonly sessionApiOrigin: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
  /** fetch 注入(测试确定性;缺省 globalThis.fetch)。 */
  readonly fetchImpl?: typeof fetch;
  /** SHA-256 摘要注入(返回小写 hex;缺省 WebCrypto,不可用 = digest-unavailable)。 */
  readonly sha256Hex?: (bytes: Uint8Array) => Promise<string>;
  /** 护栏数值注入(测试收紧;生产缺省 = DESCRIPTOR_CLIENT_GUARDS)。 */
  readonly guards?: DescriptorGuardLimits;
}

/** sessionApiOrigin 必须是可解析的 http(s) origin(与 bootstrap.ts 同则)。 */
function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
}

/** version 客户端路径卫生(权威 semver 闸在服务端;此处只禁越轨字符与穿越)。 */
const VERSION_HYGIENE_PATTERN = /^[A-Za-z0-9.+-]{1,128}$/;

/** 定位参数闸(失败 = invalid-input,不发请求)。 */
export function assertDescriptorLocator(
  sessionApiOrigin: string,
  challengeId: string,
  challengeVersion: string,
): void {
  if (!isHttpOrigin(sessionApiOrigin)) {
    throw new TypeError("descriptor sessionApiOrigin 须为可解析的 http(s) origin");
  }
  if (
    challengeId.length === 0 ||
    challengeId.length > OPAQUE_ID_MAX_LENGTH ||
    !IDENTIFIER_CHARSET_PATTERN.test(challengeId)
  ) {
    throw new TypeError("descriptor challengeId 不满足冻结标识符字符集");
  }
  if (
    !VERSION_HYGIENE_PATTERN.test(challengeVersion) ||
    challengeVersion.includes("..")
  ) {
    throw new TypeError("descriptor challengeVersion 不满足路径卫生");
  }
}

/** 缺省摘要实现:WebCrypto SHA-256(浏览器全局;subtle 缺席即抛)。 */
async function webCryptoSha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle === undefined) {
    throw new Error("WebCrypto subtle 不可用(非安全上下文且无注入)");
  }
  const digest = await subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** ETag → 登记摘要(剥弱化前缀与引号;空值 = null)。 */
function registeredDigestFromEtag(etag: string | null): string | null {
  if (etag === null) {
    return null;
  }
  let value = etag.trim();
  if (value.startsWith("W/")) {
    value = value.slice(2);
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  return value === "" ? null : value.toLowerCase();
}

/** 结构护栏越限(维度只进本异常;调用方折叠为 over-limit)。 */
class GuardLimitError extends Error {}

/** 深度优先结构巡检(与 session-api request-guards 同则的客户端镜像)。 */
function assertWithinLimits(value: unknown, limits: DescriptorGuardLimits, depth = 0): void {
  if (depth > limits.maxJsonDepth) {
    throw new GuardLimitError(`嵌套深度超过 ${limits.maxJsonDepth}`);
  }
  if (typeof value === "string") {
    if (value.length > limits.maxStringLength) {
      throw new GuardLimitError(`字符串长度超过 ${limits.maxStringLength}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayLength) {
      throw new GuardLimitError(`数组长度超过 ${limits.maxArrayLength}`);
    }
    for (const item of value) {
      assertWithinLimits(item, limits, depth + 1);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      assertWithinLimits(item, limits, depth + 1);
    }
  }
}

// ── 轻量结构校验(对齐锚 = 公开 Schema 17 字段;测试锚定于本包 + challenge-schema)──

/** Schema 顶层必需 13 字段 + 可选 4 字段(17 字段冻结面;M10/WP-80 新增 authorBlocks)。 */
const REQUIRED_TOP_LEVEL_FIELDS = [
  "schemaVersion",
  "challengeId",
  "challengeContentVersion",
  "vmProfileVersion",
  "locale",
  "briefing",
  "vmProfile",
  "memoryLayout",
  "allowedActions",
  "resourceLimits",
  "hintLadder",
  "publicErrorMapping",
  "initialProjection",
] as const;
const OPTIONAL_TOP_LEVEL_FIELDS = [
  "randomizationNotice",
  "debugMode",
  "aslrEnabled",
  // M10/WP-80:出题者积木声明面(可选顶层字段;D-MP-6 形状)。
  "authorBlocks",
] as const;

/** schemaVersion 冻结值(challenge-schema CHALLENGE_PACKAGE_SCHEMA_VERSION 同值)。 */
const DESCRIPTOR_SCHEMA_VERSION = 1;

/**
 * M10/WP-80 出题者积木声明面的形态锚(本地副本;challenge-schema 的
 * `author-blocks.ts` 为单一来源,浏览器包禁 import 该包 ⇒ 此处重述并在
 * `test/descriptor/` 侧以 fixture 一致性断言锚定漂移)。
 */
const AUTHOR_BLOCK_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const AUTHOR_BLOCK_SLOT_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** 模板 / 槽位 / 动作的**封闭键集**(公开 Schema `additionalProperties: false` 同则)。 */
const AUTHOR_BLOCK_KEYS = ["id", "displayText", "interfaceId", "slots", "actions"] as const;
const AUTHOR_BLOCK_SLOT_KEYS = ["key", "label", "kind"] as const;
const AUTHOR_BLOCK_ACTION_KEYS = ["type", "args"] as const;
/**
 * 效果语义键禁令(公开面不承载效果原语序列;challenge-schema 侧
 * `AUTHOR_BLOCK_FORBIDDEN_PRIVATE_KEYS` + `XS-BLOCK-NO-EFFECT` 的客户端同则)。
 * 客户端闸只做形状拒收,真实效果语义判定仍以服务端校验器为准。
 */
const AUTHOR_BLOCK_FORBIDDEN_ARG_NAMES = ["effects", "semantics", "flagRegister", "fileId"] as const;

/** 未知键拒绝(封闭键集;`undefined` 值同样视为越界存在)。 */
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

const REVEAL_POLICIES = ["on_request", "after_n_failures"] as const;
const REGION_KINDS = ["code", "global", "stack", "heap", "key", "custom"] as const;
const ARCH_BITS_VALUES = [32, 64] as const;
const SEMANTIC_HIGHLIGHT_KINDS = [
  "buffer_start",
  "return_address_slot",
  "saved_rbp_slot",
  "canary_slot",
  "custom",
] as const;

type RecordOf = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordOf =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * 轻量结构校验(对齐锚 = 公开 Schema;不替代登记管线的 Ajv 全量校验——
 * 客户端闸的目标是把坏形态确定性挡在渲染面之外)。合法返回强类型视图,
 * 否则 null(调用方折叠为 bad-shape)。
 */
export function parseDescriptorView(input: unknown): ChallengeDescriptorView | null {
  if (!isRecord(input)) {
    return null;
  }
  // 未知顶层字段拒绝(公开 Schema additionalProperties: false 同则;I-1)。
  const allowed = new Set<string>([...REQUIRED_TOP_LEVEL_FIELDS, ...OPTIONAL_TOP_LEVEL_FIELDS]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      return null;
    }
  }
  for (const key of REQUIRED_TOP_LEVEL_FIELDS) {
    if (!(key in input)) {
      return null;
    }
  }
  if (input["schemaVersion"] !== DESCRIPTOR_SCHEMA_VERSION) {
    return null;
  }
  for (const key of ["challengeId", "challengeContentVersion", "vmProfileVersion", "locale"] as const) {
    if (!isNonEmptyString(input[key])) {
      return null;
    }
  }
  if (!parseBriefing(input["briefing"])) return null;
  if (!parseVmProfile(input["vmProfile"])) return null;
  if (!parseMemoryLayout(input["memoryLayout"])) return null;
  if (!parseAllowedActions(input["allowedActions"])) return null;
  if (!parseResourceLimits(input["resourceLimits"])) return null;
  const hintLadder = parseHintLadder(input["hintLadder"]);
  if (hintLadder === null) return null;
  const publicErrorMapping = parsePublicErrorMapping(input["publicErrorMapping"]);
  if (publicErrorMapping === null) return null;
  const initialProjection = parseInitialProjection(input["initialProjection"]);
  if (initialProjection === null) return null;
  // 可选字段的类型面(存在才检)。
  if (input["randomizationNotice"] !== undefined && !isNonEmptyString(input["randomizationNotice"])) {
    return null;
  }
  const authorBlocks = parseAuthorBlocks(input["authorBlocks"]);
  if (authorBlocks === null) return null;
  for (const key of ["debugMode", "aslrEnabled"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") {
      return null;
    }
  }
  return {
    schemaVersion: DESCRIPTOR_SCHEMA_VERSION,
    challengeId: input["challengeId"] as string,
    challengeContentVersion: input["challengeContentVersion"] as string,
    vmProfileVersion: input["vmProfileVersion"] as string,
    locale: input["locale"] as string,
    briefing: input["briefing"] as DescriptorBriefingView,
    vmProfile: input["vmProfile"] as DescriptorVmProfileView,
    memoryLayout: input["memoryLayout"] as { readonly regions: readonly DescriptorRegionView[] },
    allowedActions: input["allowedActions"] as readonly string[],
    resourceLimits: input["resourceLimits"] as ChallengeDescriptorView["resourceLimits"],
    hintLadder,
    publicErrorMapping,
    ...(isNonEmptyString(input["randomizationNotice"])
      ? { randomizationNotice: input["randomizationNotice"] as string }
      : {}),
    // 归一化(opt-out 语义,登记):debugMode 缺省 true;aslrEnabled 缺省 false。
    debugMode: input["debugMode"] === undefined ? true : (input["debugMode"] as boolean),
    aslrEnabled: input["aslrEnabled"] === undefined ? false : (input["aslrEnabled"] as boolean),
    initialProjection,
    ...(authorBlocks === undefined ? {} : { authorBlocks }),
  };
}

/**
 * M10/WP-80 出题者积木声明面解析(可选字段;缺席 → undefined = 零行为变化)。
 *
 * 轻量结构校验对齐公开 Schema 的 authorBlocks 形状(声明包已在服务端经
 * 登记管线全量校验;此处是客户端闸,坏形态一律 null = 折叠为 bad-shape,
 * **不做修复性归一**)。逐项:
 *  - `authorBlocks` 必须是 1~16 元素数组;
 *  - 模板:`id`(小写标识符形态)/ `displayText`(非空)/ `interfaceId`(256~65535)
 *    + `slots`(0~4)/ `actions`(1~8);
 *  - 槽位:`key` 小写标识符、`label` 非空、`kind` ∈ address / immediate / length;
 *  - 动作:`type` 非空、`args` 每个取值 = 非空字面量串 或 `{ slot }` 单键对象。
 */
function parseAuthorBlocks(value: unknown): readonly PayloadAuthorBlockDecl[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    return null;
  }
  const blocks: PayloadAuthorBlockDecl[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    // 模板封闭键集(未知键 / 效果语义键一律拒:公开 Schema
    // additionalProperties:false 同则;效果序列整体留私有包)。
    if (!hasOnlyKeys(entry, AUTHOR_BLOCK_KEYS)) return null;
    const id = entry["id"];
    const displayText = entry["displayText"];
    const interfaceId = entry["interfaceId"];
    if (typeof id !== "string" || !AUTHOR_BLOCK_ID_PATTERN.test(id)) return null;
    if (!isNonEmptyString(displayText)) return null;
    if (!isNumber(interfaceId) || !Number.isInteger(interfaceId)) return null;
    if (interfaceId < 256 || interfaceId > 65535) return null;

    const rawSlots = entry["slots"];
    if (!Array.isArray(rawSlots) || rawSlots.length > 4) return null;
    const slots: PayloadAuthorBlockSlot[] = [];
    for (const slot of rawSlots) {
      if (!isRecord(slot)) return null;
      if (!hasOnlyKeys(slot, AUTHOR_BLOCK_SLOT_KEYS)) return null;
      const key = slot["key"];
      const label = slot["label"];
      const kind = slot["kind"];
      if (typeof key !== "string" || !AUTHOR_BLOCK_SLOT_KEY_PATTERN.test(key)) return null;
      if (!isNonEmptyString(label)) return null;
      if (kind !== "address" && kind !== "immediate" && kind !== "length") return null;
      slots.push({ key, label, kind });
    }

    const rawActions = entry["actions"];
    if (!Array.isArray(rawActions) || rawActions.length < 1 || rawActions.length > 8) return null;
    const actions: PayloadAuthorBlockAction[] = [];
    for (const action of rawActions) {
      if (!isRecord(action)) return null;
      if (!hasOnlyKeys(action, AUTHOR_BLOCK_ACTION_KEYS)) return null;
      const type = action["type"];
      if (!isNonEmptyString(type)) return null;
      // 动作序列面 = 12 公开动作的子集(公开 Schema 的 type 枚举同则;
      // 效果原语 / 微算子等私有动作名在此一律拒收)。
      if (!(SESSION_ACTION_TYPES as readonly string[]).includes(type)) return null;
      const rawArgs = action["args"];
      if (!isRecord(rawArgs)) return null;
      const args: Record<string, PayloadAuthorBlockArgValue> = {};
      for (const [argName, argValue] of Object.entries(rawArgs)) {
        if ((AUTHOR_BLOCK_FORBIDDEN_ARG_NAMES as readonly string[]).includes(argName)) {
          return null;
        }
        if (isNonEmptyString(argValue)) {
          args[argName] = argValue;
          continue;
        }
        if (isRecord(argValue) && typeof argValue["slot"] === "string") {
          if (!hasOnlyKeys(argValue, ["slot"])) return null;
          args[argName] = { slot: argValue["slot"] as string };
          continue;
        }
        return null;
      }
      actions.push({ type, args });
    }
    blocks.push({ id, displayText, interfaceId, slots, actions });
  }
  return blocks;
}

function parseBriefing(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value["title"]) || !isNonEmptyString(value["summary"])) return false;
  // learningObjectives minItems 1;teachingNotes 可选(minItems 0)。
  if (!isStringArray(value["learningObjectives"]) || value["learningObjectives"].length < 1) {
    return false;
  }
  if (value["teachingNotes"] !== undefined && !isStringArray(value["teachingNotes"])) {
    return false;
  }
  return true;
}

function parseVmProfile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const registers = value["registers"];
  if (!Array.isArray(registers) || registers.length < 1) return false;
  for (const register of registers) {
    if (!isRecord(register) || !isNonEmptyString(register["name"])) return false;
    if (register["displayLabel"] !== undefined && !isNonEmptyString(register["displayLabel"])) {
      return false;
    }
  }
  const flags = value["flagRegisterNames"];
  if (flags !== undefined && (!isStringArray(flags) || flags.length < 1)) return false;
  if (!ARCH_BITS_VALUES.includes(value["archBits"] as 32 | 64)) return false;
  if (value["endianness"] !== "little") return false;
  if (!isNumber(value["pageSizeBytes"]) || value["pageSizeBytes"] <= 0) return false;
  const canary = value["canary"];
  if (!isRecord(canary) || typeof canary["enabled"] !== "boolean") return false;
  if (canary["sizeBytes"] !== undefined && !isNumber(canary["sizeBytes"])) return false;
  const encodingTable = value["encodingTable"];
  if (encodingTable !== undefined) {
    if (!Array.isArray(encodingTable) || encodingTable.length < 1) return false;
    for (const entry of encodingTable) {
      if (!isRecord(entry) || !isNonEmptyString(entry["tokenHex"]) || !isNonEmptyString(entry["op"])) {
        return false;
      }
      const operands = entry["operands"];
      if (operands === undefined) continue;
      if (!Array.isArray(operands)) return false;
      for (const operand of operands) {
        if (!isEncodingOperand(operand)) return false;
      }
    }
  }
  return true;
}

function isEncodingOperand(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value["kind"]) {
    case "register":
      return isNonEmptyString(value["name"]);
    case "immediate":
      return value["width"] === "arch";
    case "memory":
      return isNonEmptyString(value["baseRegister"]) && value["displacementWidth"] === "arch";
    case "interface":
      return isNumber(value["interfaceId"]);
    default:
      return false;
  }
}

function parseMemoryLayout(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const regions = value["regions"];
  if (!Array.isArray(regions) || regions.length < 1) return false;
  for (const region of regions) {
    if (!isRecord(region)) return false;
    if (!isNonEmptyString(region["regionId"])) return false;
    if (!REGION_KINDS.includes(region["kind"] as (typeof REGION_KINDS)[number])) return false;
    if (!isNonEmptyString(region["startAddressHex"])) return false;
    if (!isNumber(region["byteLength"]) || region["byteLength"] <= 0) return false;
    if (!isNonEmptyString(region["permissions"])) return false;
    if (!isNonEmptyString(region["publicLabel"])) return false;
  }
  return true;
}

function parseAllowedActions(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((action) =>
    typeof action === "string" && (SESSION_ACTION_TYPES as readonly string[]).includes(action),
  );
}

function parseResourceLimits(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const key of [
    "predicateEvalBudgetPerSession",
    "rollbackBudgetPerSession",
    "maxWriteBytesPerAction",
  ] as const) {
    if (value[key] !== undefined && !isNumber(value[key])) return false;
  }
  return true;
}

function parseHintLadder(value: unknown): readonly PublicHint[] | null {
  if (!Array.isArray(value)) return null;
  const hints: PublicHint[] = [];
  for (const hint of value) {
    if (!isRecord(hint)) return null;
    if (!isNumber(hint["order"]) || hint["order"] < 1) return null;
    if (!(REVEAL_POLICIES as readonly string[]).includes(hint["revealPolicy"] as string)) return null;
    if (!isNonEmptyString(hint["hintText"])) return null;
    // Schema if/then:after_n_failures ⇒ failureThreshold 必填(数字)。
    if (hint["revealPolicy"] === "after_n_failures") {
      if (!isNumber(hint["failureThreshold"])) return null;
      hints.push({
        order: hint["order"],
        revealPolicy: "after_n_failures",
        failureThreshold: hint["failureThreshold"],
        hintText: hint["hintText"],
      });
    } else {
      hints.push({
        order: hint["order"],
        revealPolicy: "on_request",
        hintText: hint["hintText"],
      });
    }
  }
  return hints;
}

function parsePublicErrorMapping(value: unknown): readonly PublicErrorMapping[] | null {
  if (!Array.isArray(value)) return null;
  const mappings: PublicErrorMapping[] = [];
  for (const mapping of value) {
    if (!isRecord(mapping)) return null;
    const errorCode = mapping["errorCode"];
    if (typeof errorCode !== "string" || !(PUBLIC_ERROR_CODES as readonly string[]).includes(errorCode)) {
      return null;
    }
    if (!isNonEmptyString(mapping["teachingNote"])) return null;
    mappings.push({ errorCode: errorCode as PublicErrorMapping["errorCode"], teachingNote: mapping["teachingNote"] });
  }
  return mappings;
}

function parseInitialProjection(value: unknown): DescriptorInitialProjectionView | null {
  if (!isRecord(value)) return null;
  const visibleRegions = value["visibleRegions"];
  if (!Array.isArray(visibleRegions) || visibleRegions.length < 1) return null;
  for (const region of visibleRegions) {
    if (!isRecord(region)) return null;
    for (const key of ["regionId", "label", "startAddressHex", "permissions", "bytesHex"] as const) {
      if (!isNonEmptyString(region[key])) return null;
    }
    if (!isNumber(region["byteLength"]) || region["byteLength"] <= 0) return null;
    if (typeof region["truncated"] !== "boolean") return null;
  }
  const visibleRegisters = value["visibleRegisters"];
  if (!Array.isArray(visibleRegisters) || visibleRegisters.length < 1) return null;
  for (const register of visibleRegisters) {
    if (!isRecord(register) || !isNonEmptyString(register["name"]) || !isNonEmptyString(register["valueHex"])) {
      return null;
    }
  }
  const highlights = value["semanticHighlights"];
  let semanticHighlights: DescriptorInitialProjectionView["semanticHighlights"] = undefined;
  if (highlights !== undefined) {
    if (!Array.isArray(highlights)) return null;
    const parsed: {
      readonly kind: string;
      readonly targetRegionId: string;
      readonly startAddressHex: string;
      readonly byteLength: number;
      readonly label: string;
    }[] = [];
    for (const highlight of highlights) {
      if (!isRecord(highlight)) return null;
      if (!SEMANTIC_HIGHLIGHT_KINDS.includes(highlight["kind"] as (typeof SEMANTIC_HIGHLIGHT_KINDS)[number])) {
        return null;
      }
      for (const key of ["targetRegionId", "startAddressHex", "label"] as const) {
        if (!isNonEmptyString(highlight[key])) return null;
      }
      if (!isNumber(highlight["byteLength"]) || highlight["byteLength"] <= 0) return null;
      parsed.push({
        kind: highlight["kind"] as string,
        targetRegionId: highlight["targetRegionId"] as string,
        startAddressHex: highlight["startAddressHex"] as string,
        byteLength: highlight["byteLength"] as number,
        label: highlight["label"] as string,
      });
    }
    semanticHighlights = parsed;
  }
  return {
    visibleRegions: visibleRegions as DescriptorInitialProjectionView["visibleRegions"],
    visibleRegisters: visibleRegisters as DescriptorInitialProjectionView["visibleRegisters"],
    ...(semanticHighlights === undefined ? {} : { semanticHighlights }),
  };
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

/**
 * 获取并校验公开描述包(全流程见模块头注释)。任何失败都以确定性原因折叠
 * 为 `{ ok: false, reason }`,不抛错、不中断调用方会话。
 */
export async function fetchChallengeDescriptor(
  input: FetchChallengeDescriptorInput,
): Promise<ChallengeDescriptorOutcome> {
  const doFetch = input.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const guards = input.guards ?? DESCRIPTOR_CLIENT_GUARDS;
  try {
    assertDescriptorLocator(input.sessionApiOrigin, input.challengeId, input.challengeVersion);
  } catch {
    return { ok: false, reason: "invalid-input" };
  }
  const url = `${input.sessionApiOrigin}/descriptors/${input.challengeId}/${input.challengeVersion}`;

  // 网络失败至多一次显式重试(登记:不重试风暴)。
  let response: Response;
  try {
    response = await doFetch(url, { method: "GET" });
  } catch {
    try {
      response = await doFetch(url, { method: "GET" });
    } catch {
      return { ok: false, reason: "network" };
    }
  }
  if (!response.ok) {
    return { ok: false, reason: response.status === 404 ? "not-found" : "http-status" };
  }

  // 尺寸护栏第一闸:Content-Length 显式超限先拒(不读体);读体后再兜底。
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > guards.maxBodyBytes) {
    return { ok: false, reason: "over-limit" };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > guards.maxBodyBytes) {
    return { ok: false, reason: "over-limit" };
  }

  // 完整性闸:ETag = 登记摘要;缺失或复算不符即拒(篡改红灯)。
  const registered = registeredDigestFromEtag(response.headers.get("etag"));
  if (registered === null) {
    return { ok: false, reason: "etag-missing" };
  }
  let computed: string;
  try {
    computed = await (input.sha256Hex ?? webCryptoSha256Hex)(bytes);
  } catch {
    return { ok: false, reason: "digest-unavailable" };
  }
  if (computed.toLowerCase() !== registered) {
    return { ok: false, reason: "digest-mismatch" };
  }

  // JSON 解析 + 尺寸护栏第二闸 + 结构校验。
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  try {
    assertWithinLimits(parsed, guards);
  } catch {
    return { ok: false, reason: "over-limit" };
  }
  const descriptor = parseDescriptorView(parsed);
  if (descriptor === null) {
    return { ok: false, reason: "bad-shape" };
  }
  return { ok: true, descriptor };
}

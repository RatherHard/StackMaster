/**
 * 出题者积木声明面(M10 出题者积木最小声明面 / WP-80;D-MP-6 定案形状)。
 *
 * ## 面定位
 *
 * 公开描述包的可选顶层字段 `authorBlocks` = 出题人向玩家公开的**积木模板清单**。
 * 每个模板 = 「展示文本 + 公开 ISA 引用 + 参数槽位 + 动作序列」:玩家在 Payload
 * 搭建面板里看到的是模板积木,把槽位填上参数后编译成**12 个公开会话动作**的
 * 原子序列。它**不是**图灵完备积木平台:动作序列面的 `type` 必须是
 * `SESSION_ACTION_TYPES` 的子集(枚举即子集闸,Schema 层结构性保证)。
 *
 * ## 公开面承载 / 不承载(WP-1《数据分类与秘密零驻留清单》§12.2 `authorBlocks` 行)
 *
 *  - **承载**:模板标识(`id`)、公开展示文本(`displayText`)、公开 ISA 引用
 *    (`interfaceId`,与 `encodingTable[].operands[].kind = "interface"` 同一
 *    公开语义——只揭示接口的**存在性与公开标识**,不揭示效果语义)、参数槽位
 *    描述(`slots`)、指向 12 个公开动作的动作序列(`actions`)。
 *  - **不承载**:效果原语序列(仍留私有包 `interfaces[].effects`)、隐藏接口
 *    存在性、私有谓词、任何 `SERVER_ONLY` 语义。未在公开面出现的接口不产生
 *    存在性信号(I-9 / T-SC1 探针变体)。
 *
 * ## 单一来源纪律
 *
 * 本模块是「声明面词汇 + 12 公开动作参数位表」的单一来源:公开 JSON Schema 的
 * enum / propertyNames、手工镜像类型与检查器规则共用本文件的常量(严格性测试
 * 对照 Schema 内字面量防漂移)。`AUTHOR_BLOCK_ACTION_ARGS` 是
 * `@stackmaster/protocol` `ActionObjectSchema` 的参数位**公开镜像**——本包是
 * 叶子包(不依赖 protocol),漂移由严格性测试 + 服务端入站二次校验兜底。
 */

import type { SessionActionType } from "./vocabulary.js";

/**
 * 参数槽位形态封闭集(D-MP-6 定案:`kind ∈ {"address","immediate","length"}`)。
 * 槽位形态是**作者声明面**的取值类别,决定编译期从积木取值时的字面量转换:
 *  - `address` → `0x` 前缀 64 位十六进制地址串(`addressHex` / `targetHex`);
 *  - `immediate` / `length` → 无符号整数(小端写回数值类参数位,如 `valueHex`)。
 */
export const AUTHOR_BLOCK_SLOT_KINDS = ["address", "immediate", "length"] as const;
export type AuthorBlockSlotKind = (typeof AUTHOR_BLOCK_SLOT_KINDS)[number];

/** 槽位键模式(小写标识符;与 seed 公开路径段同风格,避免与积木字段名混淆)。 */
export const AUTHOR_BLOCK_SLOT_KEY_PATTERN_SOURCE = "^[a-z][a-z0-9_]{0,31}$";

/** 单个动作的参数位声明(允许集 + 必填集)。 */
export interface AuthorBlockActionArgSpec {
  readonly allowed: readonly string[];
  readonly required: readonly string[];
}

/**
 * 12 公开动作的参数位表(`ActionObjectSchema` 的公开镜像)。
 *
 * 逐动作冻结该动作**允许**出现的参数位名称与**必填**集:公开声明面的动作序列
 * 是公开动作的子集,参数位也不得越出该动作的公开参数面(越界即拒,检查器
 * `XS-BLOCK-ARG-ALLOW`)。无参动作(step / ret / reset / undo / pause)的
 * `args` 必须为空对象——动作协议 `strictObject` 同则。
 */
export const AUTHOR_BLOCK_ACTION_ARGS: Readonly<Record<SessionActionType, AuthorBlockActionArgSpec>> = {
  write_bytes: { allowed: ["addressHex", "bytesHex"], required: ["addressHex", "bytesHex"] },
  push: { allowed: ["valueHex"], required: ["valueHex"] },
  pop: { allowed: [], required: [] },
  call: { allowed: ["targetHex"], required: ["targetHex"] },
  ret: { allowed: [], required: [] },
  step: { allowed: [], required: [] },
  run_to_event: { allowed: ["pauseOn"], required: ["pauseOn"] },
  pause: { allowed: [], required: [] },
  undo: { allowed: [], required: [] },
  checkout_checkpoint: { allowed: ["checkpointId"], required: ["checkpointId"] },
  reset: { allowed: [], required: [] },
  create_checkpoint: { allowed: ["label"], required: [] },
};

/**
 * 参数位取值类别(编译面消费;与 `AUTHOR_BLOCK_SLOT_KINDS` 配对使用):
 *  - `address`:槽位引用必须是 `address` 形态槽位,字面量必须是地址形态串;
 *  - `number`:槽位引用必须是 `immediate` / `length` 形态槽位;
 *  - `literal`:只接受字面量(字节串 / 暂停事件枚举 / 服务端签发标识符 / 标签),
 *    **不接受槽位引用**——这些值不是积木可计算量,接受槽位引用会引入
 *    「客户端自造服务端签发标识符」的语义通道。
 */
export const AUTHOR_BLOCK_ARG_VALUE_KIND: Readonly<Record<string, "address" | "number" | "literal">> = {
  addressHex: "address",
  targetHex: "address",
  valueHex: "number",
  bytesHex: "literal",
  pauseOn: "literal",
  checkpointId: "literal",
  label: "literal",
};

/**
 * 全部参数位名称并集(Schema `propertyNames` enum 与检查器共用;排序保证
 * 确定性,严格性测试按集合比对)。
 */
export const AUTHOR_BLOCK_ARG_NAMES: readonly string[] = [
  ...new Set(Object.values(AUTHOR_BLOCK_ACTION_ARGS).flatMap((spec) => [...spec.allowed])),
].sort();

/**
 * 私有声明面的嵌套字段名(公开声明面**禁入**;检查器 XS-BLOCK-NO-EFFECT)。
 *
 * 这些键不是私有包顶层属性名(故 `FORBIDDEN_PUBLIC_PROPERTIES` 覆盖不到),
 * 而是私有声明面内部的语义承载字段名——公开积木声明面一旦出现它们,即
 * 「效果原语序列 / 微算子语义经公开包走私」的形态:
 *  - `effects`:私有 `interfaces[].effects` 的**效果原语有序列表**字段;
 *  - `semantics`:私有 `customInstructions[].semantics` 的微算子序列字段;
 *  - `flagRegister` / `fileId`:效果原语与 capability 的私有引用字段名
 *    (capability 引用只能走私有结构化字段,ZR-B8 同纪律)。
 */
export const AUTHOR_BLOCK_FORBIDDEN_PRIVATE_KEYS: readonly string[] = [
  "effects",
  "semantics",
  "flagRegister",
  "fileId",
];

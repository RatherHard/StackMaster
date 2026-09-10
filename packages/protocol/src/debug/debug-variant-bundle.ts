/**
 * DebugVariantBundle —— 调试变体初始镜像(编排器 ↔ 调试 worker 进程间契约;
 * 阶段四 WP-40 冻结;ADR-DC1 条款 2 / 5、§六 R2)。
 *
 * challenge-compiler 产出、调试 worker 装载的**变体镜像**:布局与真实镜像
 * 同构、秘密值(canary 期望字节、隐藏区域内容、ASLR 派生基址)由调试种子经
 * 同一 SeedDeriver 派生;真实私有判题包**零装载**。
 *
 * 边界纪律(WP-1 清单 §6.9):本契约是编排器(WP-41 session-api 组装)↔
 * 调试 worker 的进程间内部数据,**浏览器永不可见**;整体分类 server-only,
 * 仅经 @stackmaster/protocol/server-only 子路径导出供后端包(challenge-compiler、
 * session-api)做跨语言一致性校验——"Schema 存在不等于可下发"(落盘 JSON
 * Schema 保持公开供跨语言机检,与 ProjectionPolicy 同机制)。
 *
 * 结构性排除(冻结,strictObject 使出现即拒):无 judgingConfig、无隐藏测试、
 * 无 seed 值字段(seed / seedHex / seedPolicy 均不可表达)——调试实例"无可判
 * 之物"(条款 5:判题能力 = 输入缺失,而非功能开关);种子值本身不进任何
 * 契约字段,只登记算法标识与派生次数(draws,与 DerivationPathSummary 同语义)。
 *
 * 同构义务(WP-42"结构逐字节同构断言"的依赖面):memoryRegions 字段集 =
 * 私有包 initialState.memoryRegions 同款;canarySlots = 私有包 canary 对象
 * 同款(值已派生写入所属区域 contentHex,槽对象不携带值——与真实 canary
 * "期望值引擎初始化时从初始内存截取"同构);ASLR 关 = startAddressHex 与
 * 真实镜像一致,开 = derivation.baseAddresses 携带调试派生基址。
 *
 * 跨字段规则(superRefine 承载,JSON Schema 形态由生成管线以 if/then 注入,
 * 两侧同步修改,语义文档 §六):(1) aslrEnabled = false ⇒ baseAddresses
 * 必须缺席;(2) aslrEnabled = true ⇒ draws ≥ 1(首个 draw 为基址派生);
 * (3) canarySlots[].containsSecret = true ⇒ visibility = "hidden"
 * (I3-SINK-HIDDEN 同构)。
 */
import { z } from "zod";
import { AddressHexSchema, ValueHex64Schema } from "../common/hex.js";
import { OpaqueIdSchema } from "../common/identifiers.js";
import {
  DEBUG_VARIANT_MAX_CANARY_SLOTS,
  DEBUG_VARIANT_MAX_REGIONS,
  DEBUG_VARIANT_MAX_REGISTERS,
  MAX_REGION_BYTE_LENGTH,
} from "../common/limits.js";
import { PermissionsSchema } from "../projection/visible-memory-region.js";
import { RegisterNameSchema } from "../common/register-name.js";
import { ENGINE_PROCESS_PROTOCOL_VERSION } from "../version.js";
import { CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE } from "../embed/embed-token-claims.js";

/**
 * 变体镜像格式信封版本(const 1);扩展走版本演进,无预留字段。
 */
export const DEBUG_VARIANT_BUNDLE_SCHEMA_VERSION = 1;

/**
 * seed 派生算法标识(封闭字面量):与 vm-core seed.rs 的 SEED_ALGORITHM_ID
 * 同一冻结字面量。本包不得依赖 vm-engine 产物(5.5 依赖纪律),故按
 * CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE 先例以同一字面量重复冻结;
 * 双侧一致性由 contract-smoke 机检,变更属破坏性契约变更,两端必须同步。
 */
export const DEBUG_VARIANT_SEED_ALGORITHM_ID = "splitmix64-stream-v1";

/** 变体内存区域类型(与私有包 initialState.memoryRegions 的 kind 枚举同集)。 */
export const DEBUG_VARIANT_REGION_KINDS = [
  "code",
  "global",
  "stack",
  "heap",
  "key",
  "custom",
] as const;

export type DebugVariantRegionKind = (typeof DEBUG_VARIANT_REGION_KINDS)[number];

export const DebugVariantRegionKindSchema = z.enum(DEBUG_VARIANT_REGION_KINDS);

const CHALLENGE_CONTENT_VERSION_PATTERN = new RegExp(CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE);

/** 题目内容版本 / VM Profile 版本:与双包 semver 同一冻结格式(X.Y.Z)。 */
const SemVerSchema = z
  .string()
  .regex(CHALLENGE_CONTENT_VERSION_PATTERN, "版本必须为 X.Y.Z 形式的语义化版本");

/**
 * 变体内存区域(与真实镜像逐字段同构):字段集 = 私有包
 * initialState.memoryRegions 同款(regionId / kind / startAddressHex /
 * byteLength / permissions / contentHex / isHidden)。
 * byteLength 沿用区域粒度约束:1 – 16 MiB 且为 4096 倍数(VMA 页对齐)。
 */
export const DebugVariantMemoryRegionSchema = z.strictObject({
  regionId: OpaqueIdSchema,
  kind: DebugVariantRegionKindSchema,
  startAddressHex: AddressHexSchema,
  byteLength: z
    .number()
    .int()
    .min(1)
    .max(MAX_REGION_BYTE_LENGTH)
    .multipleOf(4096, "区域长度必须为 4096 的倍数(VMA 页对齐)"),
  permissions: PermissionsSchema,
  /** 非空偶长 hex;长度等于 2 × byteLength 由 WP-42 同构断言复核(超 Schema 表达力)。 */
  contentHex: z
    .string()
    .regex(/^([0-9a-fA-F]{2})+$/, "必须是偶数长度的十六进制串(无 0x 前缀)")
    .max(MAX_REGION_BYTE_LENGTH * 2, `区域内容超过协议级上限(${MAX_REGION_BYTE_LENGTH} 字节)`),
  isHidden: z.boolean(),
});

export type DebugVariantMemoryRegion = z.infer<typeof DebugVariantMemoryRegionSchema>;

/** 变体初始寄存器条目(名称模式与题目寄存器声明面同一冻结模式)。 */
export const DebugVariantRegisterSchema = z.strictObject({
  name: RegisterNameSchema,
  valueHex: ValueHex64Schema,
});

export type DebugVariantRegister = z.infer<typeof DebugVariantRegisterSchema>;

/**
 * canary 槽位(照真实私有包 canary 对象结构,值已派生):期望字节已写入
 * 所属区域 contentHex,槽对象不携带值(与真实 canary"期望值引擎初始化时
 * 从初始内存截取"同构)。byteLength 1–8(引擎 CanarySlotSpec 同域)。
 */
export const DebugVariantCanarySlotSchema = z.strictObject({
  objectId: OpaqueIdSchema,
  kind: z.literal("canary"),
  addressHex: AddressHexSchema,
  byteLength: z
    .number()
    .int()
    .min(1)
    .max(8, "canary 槽位长度须为 1–8 字节(引擎 CanarySlotSpec 同域)"),
  visibility: z.enum(["public", "hidden"]),
  containsSecret: z.boolean(),
});

export type DebugVariantCanarySlot = z.infer<typeof DebugVariantCanarySlotSchema>;

/** ASLR 派生基址条目:regionId 引用 memoryRegions 数组成员(可解析性归 WP-42 断言)。 */
export const DebugVariantBaseAddressSchema = z.strictObject({
  regionId: OpaqueIdSchema,
  addressHex: AddressHexSchema,
});

export type DebugVariantBaseAddress = z.infer<typeof DebugVariantBaseAddressSchema>;

/**
 * 派生元数据:**不得包含种子值本身**(只登记算法标识与派生次数)。
 * draws 计数语义(规范槽序,双方照此实现,语义文档 §七):第 1 次 draw =
 * ASLR 基址派生(仅 aslrEnabled = true 时);后续 draw = 各秘密槽按规范序
 * 顺序派生,槽序 = memoryRegions 数组序(isHidden = true 的派生区域)→
 * canarySlots 数组序,每槽消耗 ceil(槽字节长 / 8) 次 draw。
 */
export const DebugVariantDerivationSchema = z.strictObject({
  algorithmId: z.literal(DEBUG_VARIANT_SEED_ALGORITHM_ID),
  draws: z.number().int().min(0),
  /** 仅 aslrEnabled = true 时携带(逐区域派生基址;ASLR 关 = 基址与真实镜像一致)。 */
  baseAddresses: z
    .array(DebugVariantBaseAddressSchema)
    .max(DEBUG_VARIANT_MAX_REGIONS, `基址条目超过区域数上限 ${DEBUG_VARIANT_MAX_REGIONS}`)
    .optional(),
});

export type DebugVariantDerivation = z.infer<typeof DebugVariantDerivationSchema>;

const DebugVariantBundleBaseSchema = z.strictObject({
  schemaVersion: z.literal(DEBUG_VARIANT_BUNDLE_SCHEMA_VERSION),
  /** 引擎进程协议版本(复用既有常量字面量);worker 装载时版本不符即拒绝(fail-closed)。 */
  engineProcessProtocolVersion: z.literal(ENGINE_PROCESS_PROTOCOL_VERSION),
  /** 题目身份绑定:attach 时与本会话锁定的题目身份比对,跨题目装载在契约层可拒。 */
  challengeId: OpaqueIdSchema,
  challengeContentVersion: SemVerSchema,
  vmProfileVersion: SemVerSchema,
  /** ASLR 开关(题面属性):关 = 基址与真实镜像一致,开 = 各实例按各自种子独立派生。 */
  aslrEnabled: z.boolean(),
  derivation: DebugVariantDerivationSchema,
  /** 变体初始内存区域(布局与真实镜像同构;秘密槽值由调试种子派生)。 */
  memoryRegions: z
    .array(DebugVariantMemoryRegionSchema)
    .min(1, "至少携带 1 个内存区域")
    .max(DEBUG_VARIANT_MAX_REGIONS, `区域数超过协议级上限 ${DEBUG_VARIANT_MAX_REGIONS}`),
  /** 变体初始寄存器(名称模式与题目寄存器声明面同一冻结模式)。 */
  registers: z
    .array(DebugVariantRegisterSchema)
    .min(1, "至少携带 1 个寄存器初始值")
    .max(DEBUG_VARIANT_MAX_REGISTERS, `寄存器数超过协议级上限 ${DEBUG_VARIANT_MAX_REGISTERS}`),
  /** canary 槽位清单(可选;值已派生写入所属区域 contentHex)。 */
  canarySlots: z
    .array(DebugVariantCanarySlotSchema)
    .max(DEBUG_VARIANT_MAX_CANARY_SLOTS, `canary 槽数超过协议级上限 ${DEBUG_VARIANT_MAX_CANARY_SLOTS}`)
    .optional(),
});

export type DebugVariantBundleBase = z.infer<typeof DebugVariantBundleBaseSchema>;

/**
 * 跨字段规则机检(规则 1/2/3 见文件头注释;JSON Schema 等价形态由
 * generate.ts 以 if/then 注入 debug-variant-bundle.schema.json,TS 与
 * Rust 校验结论一致,两侧必须同步修改)。
 */
export const DebugVariantBundleSchema = DebugVariantBundleBaseSchema.superRefine(
  (bundle, ctx) => {
    if (!bundle.aslrEnabled && bundle.derivation.baseAddresses !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["derivation", "baseAddresses"],
        message:
          "aslrEnabled = false 时不得携带 derivation.baseAddresses(基址与真实镜像一致)",
      });
    }
    if (bundle.aslrEnabled && bundle.derivation.draws < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["derivation", "draws"],
        message: "aslrEnabled = true 时至少消耗 1 次 draw(基址派生)",
      });
    }
    bundle.canarySlots?.forEach((slot, index) => {
      if (slot.containsSecret && slot.visibility !== "hidden") {
        ctx.addIssue({
          code: "custom",
          path: ["canarySlots", index, "visibility"],
          message: "containsSecret = true 的槽必须 hidden(I3-SINK-HIDDEN 同构)",
        });
      }
    });
  },
);

export type DebugVariantBundle = z.infer<typeof DebugVariantBundleSchema>;

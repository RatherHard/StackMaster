/**
 * VisibleMemoryRegion —— 公开投影中的可见内存区域(WP-1 §4.2 / 决策 D3,WP-3 冻结)。
 *
 * 隐藏区域在本 Schema 的任何实例中都不出现(无占位、无条目、无计数);
 * 可见与隐藏不重叠由题目编译期检查强制(WP-1 I-2)。
 */
import { z } from "zod";
import { AddressHexSchema, NonEmptyBytesHexSchema } from "../common/hex.js";
import { OpaqueIdSchema } from "../common/identifiers.js";
import { MAX_REGION_BYTE_LENGTH } from "../common/limits.js";
import { PublicTextSchema } from "../common/public-text.js";

/**
 * r/w/x 权限子集,非空,规范书写序 r < w < x(r?w?x?)。
 * 权限是公开布局常量(7.1);它同时是错误解释字段 explanation.permissions 的
 * 唯一合法形态(WP-1 §4.4)。
 */
export const PermissionsSchema = z
  .string()
  .min(1, "权限必须是非空子集")
  .regex(/^r?w?x?$/, "权限必须是 r/w/x 的子集,且按 r<w<x 规范序书写");
export type Permissions = z.infer<typeof PermissionsSchema>;

export const VisibleMemoryRegionSchema = z.strictObject({
  /** 白名单可见区域的稳定标识;引用一致性由 I-2 编译期检查。 */
  regionId: OpaqueIdSchema,
  /** 展示标签;值来源 ⊆ 公开描述包符号表 / 服务端静态模板(I-10,禁止私有符号表)。 */
  label: PublicTextSchema(),
  /** 区域起始地址(公开布局)。 */
  startAddressHex: AddressHexSchema,
  /**
   * 区域总长度(公开布局常量,不是运行时秘密的函数)。
   * 协议外圈上限 16 MiB;VMA 粒度(4 KiB 倍数)与题目级内存预算由题目包校验。
   */
  byteLength: z.number().int().min(1).max(MAX_REGION_BYTE_LENGTH),
  permissions: PermissionsSchema,
  /**
   * 字节窗口:锚定区域起点,不支持玩家任选偏移窗口(D3,简化脱敏面;
   * 时间线回看走历史投影)。窗口 ≤ maxBytesPerRange(默认 256,单策略上限 4096);
   * 协议层只卡 NonEmptyBytesHexSchema 的 4096 字节上限,生效上限由服务端收紧。
   */
  bytesHex: NonEmptyBytesHexSchema,
  /** 统一截断标记(D3):true = 窗口被 maxBytesPerRange 截断;不含省略字节数。 */
  truncated: z.boolean(),
});
export type VisibleMemoryRegion = z.infer<typeof VisibleMemoryRegionSchema>;

/**
 * SemanticHighlight —— 语义高亮(WP-1 §4.2,WP-3 冻结)。
 *
 * 教学视图的标注层:把"buffer 起点 / 返回地址槽 / saved RBP 槽 / canary 槽"
 * 等教学概念锚定到可见内存的具体字节区间。高亮位置是公开布局与玩家写入的
 * 函数,不是隐藏判定结果的函数;目标区域必须可见(WP-1 I-2)。
 */
import { z } from "zod";
import { AddressHexSchema } from "../common/hex.js";
import { OpaqueIdSchema } from "../common/identifiers.js";
import { MAX_REGION_BYTE_LENGTH } from "../common/limits.js";
import { PublicTextSchema } from "../common/public-text.js";

/** 高亮语义类别(WP-1 §4.2 冻结枚举;扩展走协议版本演进,不靠预留值)。 */
export const SemanticHighlightKindSchema = z.enum([
  "buffer_start",
  "return_address_slot",
  "saved_rbp_slot",
  "canary_slot",
  "custom",
]);
export type SemanticHighlightKind = z.infer<typeof SemanticHighlightKindSchema>;

export const SemanticHighlightSchema = z.strictObject({
  kind: SemanticHighlightKindSchema,
  /** 目标区域必须可见(I-2);隐藏区域不得被高亮。 */
  targetRegionId: OpaqueIdSchema,
  startAddressHex: AddressHexSchema,
  /** 高亮跨度字节数(如 canary 槽 8 字节);不与区域边界重叠由服务端组装保证。 */
  byteLength: z.number().int().min(1).max(MAX_REGION_BYTE_LENGTH),
  /** 展示标签(值来源同 I-10:公开描述包或服务端静态模板)。 */
  label: PublicTextSchema(),
});
export type SemanticHighlight = z.infer<typeof SemanticHighlightSchema>;

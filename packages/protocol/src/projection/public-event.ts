/**
 * PublicEvent —— 公开事件(WP-1 §4.2 / 决策 D4,WP-3 冻结)。
 *
 * 公开事件是私有事件日志经白名单过滤后的子集;私有事件被丢弃时不留占位。
 * seq 采用公开事件流独立稠密编号(D4):禁止沿用私有日志序号,否则序号空洞
 * 可被用于计数隐藏事件。每动作公开事件数上限 256,超限按确定性规则聚合——
 * 聚合只读取公开事件列表自身,不读取任何私有状态(WP-1 v1.2)。
 */
import { z } from "zod";
import { AddressHexSchema, NonEmptyBytesHexSchema } from "../common/hex.js";
import { MAX_PUBLIC_EVENTS_PER_ACTION } from "../common/limits.js";

/** 公开事件类别(WP-1 §4.2 冻结枚举;比暂停事件枚举多教学伪 syscall)。 */
export const PublicEventKindSchema = z.enum([
  "read",
  "write",
  "call",
  "ret",
  "syscall",
  "exception",
]);
export type PublicEventKind = z.infer<typeof PublicEventKindSchema>;

const PublicEventBaseSchema = z.strictObject({
  /**
   * 本动作 publicEvents 数组内的稠密序号,从 0 起(D4);跨动作连续性不承担
   * 语义,避免与 undo / 回退产生序号耦合。上限随每动作事件数上限。
   */
  seq: z.number().int().min(0).max(MAX_PUBLIC_EVENTS_PER_ACTION - 1),
  kind: PublicEventKindSchema,
  /**
   * 事件地址。省略规则是 (kind, 可见状态, errorDetailLevel) 的确定性函数
   * (WP-1 I-8);对不可见地址的访问不产生事件,其结果由 I-9 统一,
   * 杜绝以"有无事件"探测隐藏区域存在性。
   */
  addressHex: AddressHexSchema.optional(),
  /** 访问宽度(字节);省略规则同 I-8。 */
  byteLength: z.number().int().min(1).optional(),
  /** 事件载荷字节;值来源受 I-10 约束(玩家输入字节或可见区域字节)。 */
  payloadHex: NonEmptyBytesHexSchema.optional(),
  /**
   * presence-only 聚合标记(WP-1 v1.2):仅出现在超限聚合产生的聚合事件上,
   * 不含被聚合事件的计数(D4:计数是隐藏活动量的信号);存在性由聚合规则
   * 决定,聚合规则只读公开事件列表,无隐藏信息。
   */
  truncated: z.literal(true).optional(),
});

/**
 * 一致性守卫:携带 payloadHex 时其字节长度必须与 byteLength 一致
 * (两者都是访问宽度的公开表面,不一致即生成端缺陷)。
 * 注:superRefine 对 z.toJSONSchema 透明,该规则不进 JSON Schema——
 * 跨语言一致性由 golden fixture 承接(含违规反例),见语义文档 §六。
 */
export const PublicEventSchema = PublicEventBaseSchema.superRefine((event, ctx) => {
  if (event.payloadHex !== undefined && event.byteLength !== undefined) {
    const payloadBytes = event.payloadHex.length / 2;
    if (payloadBytes !== event.byteLength) {
      ctx.addIssue({
        code: "custom",
        path: ["payloadHex"],
        message: `payloadHex 字节长度(${payloadBytes})必须与 byteLength(${event.byteLength})一致`,
      });
    }
  }
});
export type PublicEvent = z.infer<typeof PublicEventSchema>;

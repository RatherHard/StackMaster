/**
 * WP-3 前置声明(临时 Schema,**非冻结**)。
 *
 * ActionResponse 的三个载荷字段(projectionDelta / publicEvents / userVisibleError)
 * 的完整 Schema 归 WP-3(投影与错误契约)冻结。本文件给出最小结构占位,使 WP-2 的
 * 响应信封可端到端校验并生成完整 JSON Schema;占位结构严格按 WP-1 已冻结的边界收紧
 * (§4.2 子类型字段集合、E-1 / E-2),不引入任何 WP-1 未分类的字段。
 *
 * 纪律(WP-1 §1.3):WP-3 冻结这些类型时直接替换本文件并同步 golden fixture;
 * 替换不得改变 ActionResponse 信封本身。禁止实现侧把本文件当作最终契约。
 */
import { z } from "zod";
import { BytesHexSchema } from "../common/hex.js";
import { MAX_PUBLIC_EVENTS_PER_ACTION } from "../common/limits.js";

/** 公开事件类别(WP-1 §4.2 冻结的枚举;比暂停事件枚举多教学伪 `syscall`)。 */
export const PublicEventKindSchema = z.enum([
  "read",
  "write",
  "call",
  "ret",
  "syscall",
  "exception",
]);

/**
 * PublicEvent 占位(WP-1 §4.2 字段集合)。
 * `seq` 是本动作 publicEvents 数组内的稠密序号,从 0 起(D4:独立稠密编号,
 * 不沿用私有日志序号);跨动作连续性不承担语义,避免与 undo / 回退产生序号耦合。
 */
export const PublicEventProvisionalSchema = z.strictObject({
  seq: z.number().int().min(0),
  kind: PublicEventKindSchema,
  /** 省略 / 占位规则(I-8)由 WP-3 冻结:必须是 (kind, 可见状态, errorDetailLevel) 的确定性函数。 */
  addressHex: z.string().max(18).optional(),
  byteLength: z.number().int().min(1).optional(),
  /** 值来源受 I-10 约束:只允许玩家输入字节或可见区域字节。 */
  payloadHex: BytesHexSchema.optional(),
});

/**
 * PublicError 占位(结构示意;code 枚举、解释字段与占位符形态归 WP-3 冻结,E-1–E-6)。
 * WP-2 阶段语义文档中出现的错误码名称(如 stale_base_revision)均为占位名,
 * 以 WP-3 冻结枚举为准。
 */
export const PublicErrorProvisionalSchema = z.strictObject({
  code: z.string().min(1).max(64),
  /** 按 code 参数化的静态最小文案(E-5);教学展开解释归 WP-3 的错误格式。 */
  message: z.string().min(1).max(512),
  /** 仅当落在可见区域时为真实地址,否则统一占位符或 null(E-2)。 */
  addressHex: z.string().max(18).nullable().optional(),
});

/**
 * ProjectionDelta 占位(增量形态与 dirty range 表达归 WP-3 冻结)。
 * revision 字段表示该增量所描述的目标 revision,供增量应用侧对齐。
 */
export const ProjectionDeltaProvisionalSchema = z.strictObject({
  revision: z.number().int().min(0),
});

/** 便捷导出:单动作 publicEvents 上限(与 ActionResponse 的数组上限同一来源)。 */
export const MAX_PUBLIC_EVENTS = MAX_PUBLIC_EVENTS_PER_ACTION;

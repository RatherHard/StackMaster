/**
 * ProjectionDelta —— 公开投影增量(WP-1 §4.3,WP-3 冻结)。
 *
 * 按"教学动作或关键事件"粒度描述公开投影的变化,不逐条指令发完整投影
 * (第十章);所有可选字段遵循存在性确定性(WP-1 I-4):字段出现当且仅当
 * 该字段在本次动作中发生了可观察变化,是 (动作, 执行前可见状态) 的确定性
 * 函数,禁止按隐藏状态分支选择形态。可选字段为整体替换语义:存在即整体
 * 替换客户端缓存中的对应部分。
 */
import { z } from "zod";
import { AddressHexSchema, NonEmptyBytesHexSchema } from "../common/hex.js";
import { OpaqueIdSchema } from "../common/identifiers.js";
import {
  CALL_STACK_MAX_DEPTH,
  MAX_DIRTY_RANGES_PER_DELTA,
  MAX_PROJECTION_BYTES_PER_REVISION,
  MAX_SEMANTIC_HIGHLIGHTS,
  MAX_VISIBLE_REGISTERS,
} from "../common/limits.js";
import { PublicCallFrameSchema } from "./public-call-frame.js";
import { PublicControlFlowSchema } from "./public-control-flow.js";
import { PublicRegisterSchema } from "./public-register.js";
import { PublicStatusSchema } from "./public-status.js";
import { SemanticHighlightSchema } from "./semantic-highlight.js";

/**
 * DirtyRange —— 单个可见区域内的连续写入(WP-1 §4.3 冻结)。
 *
 * 范围集合是"本次动作可见写入列表"经合并规则(相邻 / 重叠归并为极大连续
 * 区间)得到的确定性函数;对不可见地址的写入被 I-9 统一拒绝,永不产生
 * dirty range——探测扫描无法借 dirty range 绘制隐藏区域边界。
 */
export const DirtyRangeSchema = z.strictObject({
  /** 必须引用白名单可见区域(I-2,公开布局)。 */
  regionId: OpaqueIdSchema,
  /** 合并后写入的起始地址(可见区域内:公开布局或玩家写入位置)。 */
  startAddressHex: AddressHexSchema,
  /** 合并后的连续新字节;单 range 生效上限 maxBytesPerRange 由服务端收紧(D3)。 */
  bytesHex: NonEmptyBytesHexSchema,
  /**
   * presence-only 截断标记(WP-1 v1.2):合并后写入总字节超出单 revision
   * 预算(MAX_PROJECTION_BYTES_PER_REVISION)时,服务端按地址升序承载至
   * 预算耗尽、对最后一个 range 打标记,不含省略字节数;客户端收到带标记的
   * 增量后应以 sync-projection 重新对齐(9.1 sanctioned 路径)。
   */
  truncated: z.literal(true).optional(),
});
export type DirtyRange = z.infer<typeof DirtyRangeSchema>;

const ProjectionDeltaBaseSchema = z.strictObject({
  /** 该增量描述的目标 revision;必须等于信封 revision(见 ActionResponse 的跨字段校验)。 */
  revision: z.number().int().min(0),
  /** 可见区域内的连续写入合并结果;无内存写入的动作携带空数组(字段恒在,I-8)。 */
  dirtyRanges: z.array(DirtyRangeSchema).max(MAX_DIRTY_RANGES_PER_DELTA),
  /** 白名单寄存器中值发生变化者的新值子集;无寄存器变化携带空数组(I-8)。 */
  changedRegisters: z.array(PublicRegisterSchema).max(MAX_VISIBLE_REGISTERS),
  controlFlow: PublicControlFlowSchema.optional(),
  status: PublicStatusSchema.optional(),
  callStackSummary: z.array(PublicCallFrameSchema).max(CALL_STACK_MAX_DEPTH).optional(),
  semanticHighlights: z.array(SemanticHighlightSchema).max(MAX_SEMANTIC_HIGHLIGHTS).optional(),
});

/**
 * 协议级字节总预算守卫(D3):单增量 dirtyRanges 携带的字节总数 ≤ 8192。
 * 超预算的真实写入由服务端按地址升序承载 + truncated 标记表达(D3),
 * 本校验拒绝的是"生成端未按预算裁剪"的缺陷增量。
 *
 * 注:跨字段求和超出 JSON Schema 表达能力,该规则不进落盘 Schema——
 * Rust 侧一致性由 golden fixture 承接(含超预算反例),见语义文档 §六。
 */
export const ProjectionDeltaSchema = ProjectionDeltaBaseSchema.superRefine((delta, ctx) => {
  const totalBytes = delta.dirtyRanges.reduce((sum, range) => sum + range.bytesHex.length / 2, 0);
  if (totalBytes > MAX_PROJECTION_BYTES_PER_REVISION) {
    ctx.addIssue({
      code: "custom",
      path: ["dirtyRanges"],
      message: `单 revision 投影字节总预算超限(${totalBytes} > ${MAX_PROJECTION_BYTES_PER_REVISION} 字节,WP-1 D3)`,
    });
  }
});
export type ProjectionDelta = z.infer<typeof ProjectionDeltaSchema>;

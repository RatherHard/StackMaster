/**
 * PublicStateProjection —— 服务端权威状态的公开投影(WP-1 §4.1,WP-3 冻结)。
 *
 * 字段集合冻结为 7 个;新增字段须先按 WP-1 §1.3 完成分类与硬门槛论证。
 * strictObject 使投影同样按 I-1 白名单校验(ZR-P1):未知字段在契约层即拒绝。
 *
 * 消费形态:动作响应携带 ProjectionDelta(增量,按"教学动作或关键事件"粒度);
 * 断线重连的 sync-projection 重发最近一次完整投影(9.1 sanctioned 路径),
 * 复用本 Schema。服务端维护 dirty range 合并连续写入,不逐条指令发完整投影。
 */
import { z } from "zod";
import {
  CALL_STACK_MAX_DEPTH,
  MAX_SEMANTIC_HIGHLIGHTS,
  MAX_VISIBLE_REGISTERS,
  MAX_VISIBLE_REGIONS,
} from "../common/limits.js";
import { PublicCallFrameSchema } from "./public-call-frame.js";
import { PublicControlFlowSchema } from "./public-control-flow.js";
import { PublicRegisterSchema } from "./public-register.js";
import { PublicStatusSchema } from "./public-status.js";
import { SemanticHighlightSchema } from "./semantic-highlight.js";
import { VisibleMemoryRegionSchema } from "./visible-memory-region.js";

export const PublicStateProjectionSchema = z.strictObject({
  /**
   * 服务端权威 revision:已执行(非拒绝)动作数(WP-1 I-5 / v1.1)。
   * 公开投影的版本锚点——sync-projection、幂等缓存与断线同步都以它对齐。
   */
  revision: z.number().int().min(0),
  /** 仅 ProjectionPolicy 白名单区域;隐藏区域无占位、无条目、无计数(D3)。 */
  visibleRegions: z.array(VisibleMemoryRegionSchema).max(MAX_VISIBLE_REGIONS),
  /** 仅白名单寄存器(WP-1 I-3);值是教学观察对象。 */
  visibleRegisters: z.array(PublicRegisterSchema).max(MAX_VISIBLE_REGISTERS),
  /** 调用栈摘要(D2 裁剪形态);截断规则见 PublicCallFrame.truncated。 */
  callStackSummary: z.array(PublicCallFrameSchema).max(CALL_STACK_MAX_DEPTH),
  controlFlow: PublicControlFlowSchema,
  semanticHighlights: z.array(SemanticHighlightSchema).max(MAX_SEMANTIC_HIGHLIGHTS),
  /** 权威状态的公开形态(D1);`rejected` 不属于投影,只属于 ActionResponse.status。 */
  status: PublicStatusSchema,
});
export type PublicStateProjection = z.infer<typeof PublicStateProjectionSchema>;

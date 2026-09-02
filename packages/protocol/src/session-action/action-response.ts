/**
 * ActionResponse —— 编排器 → 浏览器的动作响应(计划书 6.2)。
 *
 * 字段集合冻结(WP-1 §6.2,全部 `PUBLIC`;`requestId` 为服务端生成,非客户端回显)。
 * 本信封不得新增字段:新增字段须先按 WP-1 §1.3 完成分类与硬门槛论证。
 * strictObject 使响应在测试与 CI 中同样按 I-1 白名单校验(ZR-P1)。
 */
import { z } from "zod";
import { OpaqueIdSchema } from "../common/identifiers.js";
import { MAX_PUBLIC_EVENTS_PER_ACTION } from "../common/limits.js";
import {
  ProjectionDeltaProvisionalSchema,
  PublicErrorProvisionalSchema,
  PublicEventProvisionalSchema,
} from "./provisional.js";

/**
 * 权威 VM 状态在动作响应边界上的值 + 拒绝标记(计划书 6.2)。
 * 注意区别于 WP-3 的 `PublicStatus`(无 `rejected`):`rejected` 只出现在动作响应,
 * 不进入公开投影(WP-1 §4.2)。
 */
export const ActionResponseStatusSchema = z.enum([
  "running",
  "paused",
  "won",
  "failed",
  "rejected",
]);
export type ActionResponseStatus = z.infer<typeof ActionResponseStatusSchema>;

export const ActionResponseSchema = z.strictObject({
  /** 服务端生成的请求关联 ID;客户端以传输层关联与本地 idempotencyKey 账目对应(语义文档 §四)。 */
  requestId: OpaqueIdSchema,
  /**
   * 服务端权威 revision;已执行(非拒绝)动作 +1——包括失败但已执行的动作
   * (如可见但不可写的写入 → memory_fault 教学反馈)与 undo / checkout / reset;
   * 进入执行前被拒绝的动作不前进(I-5,语义文档 §4.1)。
   */
  revision: z.number().int().min(0),
  status: ActionResponseStatusSchema,
  /** 本动作产生的公开投影增量;无投影变化(拒绝 / create_checkpoint 等)为 null。 */
  projectionDelta: ProjectionDeltaProvisionalSchema.nullable(),
  /** 本动作产生的公开事件(经白名单过滤,WP-1 D4);上限 MAX_PUBLIC_EVENTS_PER_ACTION。 */
  publicEvents: z.array(PublicEventProvisionalSchema).max(MAX_PUBLIC_EVENTS_PER_ACTION),
  /** 脱敏后的用户可见错误(结构归 WP-3);仅拒绝与可解释失败时出现。 */
  userVisibleError: PublicErrorProvisionalSchema.optional(),
});

export type ActionResponse = z.infer<typeof ActionResponseSchema>;

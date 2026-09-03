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
import { ProjectionDeltaSchema } from "../projection/projection-delta.js";
import { PublicErrorSchema } from "../error/public-error.js";
import { PublicEventSchema } from "../projection/public-event.js";

/**
 * 权威 VM 状态在动作响应边界上的值 + 拒绝标记(计划书 6.2)。
 * 注意区别于 `PublicStatus`(无 `rejected`):`rejected` 只出现在动作响应,
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

const ActionResponseBaseSchema = z.strictObject({
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
  projectionDelta: ProjectionDeltaSchema.nullable(),
  /** 本动作产生的公开事件(经白名单过滤,WP-1 D4);上限 MAX_PUBLIC_EVENTS_PER_ACTION。 */
  publicEvents: z.array(PublicEventSchema).max(MAX_PUBLIC_EVENTS_PER_ACTION),
  /** 脱敏后的用户可见错误(WP-1 §4.4);仅拒绝与可解释失败时出现。 */
  userVisibleError: PublicErrorSchema.optional(),
});

/**
 * 跨字段一致性(WP-2 移交事项,WP-3 落地):
 * 1. status === "rejected" 时:projectionDelta 恒 null、publicEvents 恒空、
 *    userVisibleError 必有(拒绝必须可解释);JSON Schema 侧由生成管线注入
 *    等价 if/then(见 schema/generate.ts),TS 侧在此 superRefine 同步——
 *    两侧规则文本须保持一致(语义文档 §六);
 * 2. 非 null 增量的 revision 必须等于信封 revision(WP-1 §4.3:增量应用侧
 *    以 revision 对齐,错位即生成端缺陷)。
 *
 * 注:两条规则均超出 JSON Schema 结构表达能力(第 2 条为跨 Schema 比较),
 * 落盘产物只携带第 1 条的 if/then;Rust 侧一致性由 golden fixture 承接
 * (违规形态各带反例),见语义文档 §六。
 */
export const ActionResponseSchema = ActionResponseBaseSchema.superRefine((response, ctx) => {
  if (response.status === "rejected") {
    if (response.projectionDelta !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["projectionDelta"],
        message: "status 为 rejected 时 projectionDelta 必须为 null(拒绝动作不产生投影)",
      });
    }
    if (response.publicEvents.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["publicEvents"],
        message: "status 为 rejected 时 publicEvents 必须为空(拒绝动作不产生事件)",
      });
    }
    if (response.userVisibleError === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["userVisibleError"],
        message: "status 为 rejected 时 userVisibleError 必有(拒绝必须可解释)",
      });
    }
  }
  if (
    response.projectionDelta !== null &&
    response.projectionDelta.revision !== response.revision
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["projectionDelta", "revision"],
      message: `增量 revision(${response.projectionDelta.revision})必须等于信封 revision(${response.revision})`,
    });
  }
});

export type ActionResponse = z.infer<typeof ActionResponseSchema>;

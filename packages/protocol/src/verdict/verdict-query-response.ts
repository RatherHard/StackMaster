/**
 * VerdictQueryResponse —— 裁决呈现通道的查询响应(阶段六 WP-60 冻结)。
 *
 * 正式裁决呈现通道(阶段六边界裁决 2 候选新契约面 (a),权威 API 语义规约
 * D-API-83)的载荷契约:`GET /verdicts/:submissionId` 的响应体。端点形态
 * (路由、认证、限流)为实现面登记(D-API-83),不作 JSON Schema 契约——
 * 与 D-API-76 公开描述包端点同款先例:GET 无请求体,路径参数走冻结标识符
 * 字符集校验,契约面只有响应体。
 *
 * 字段分类与硬门槛论证:docs/contracts/数据分类与秘密零驻留清单.md §6.10。
 * 整体 `PUBLIC`——本契约是清单 §七 D6 与 D1 约束 1 / 4 的直接兑现面:浏览器
 * 从本载荷获得正式裁决的**全部**公开信息,即 11 值结果类型(冻结契约
 * `VerdictResultSchema`,WP-2,零新增字面)加契约定位字段;零部分匹配信息
 * (D1 约束 1 / 3、I-7:无进度字段、无谓词标识、无隐藏测试命中详情)、零
 * 隐藏测试内容、零重放中间态——裁决明细(verdicts.detail 列)与提交引用
 * (submissions.reference)整体 SERVER_ONLY,在本载荷无 sanctioned 表达位。
 *
 * 跨字段一致性(pending / verdicted 状态机,D-API-84):
 * - `status === "pending"` ⇒ `verdict` 与 `decidedAt` 必须整体缺席(未决期
 *   确定性形态:载荷零信息增量,不携带队列位置 / 预计等待 / 进度);
 * - `status === "verdicted"` ⇒ `verdict` 与 `decidedAt` 必须存在(11 值结果
 *   类型 + 裁决落库时刻;verdicted 为终态,不可逆)。
 * TS 侧等价规则在 superRefine;JSON Schema 形态由生成管线以等价 if/then
 * 显式注入(schema/generate.ts 的 VERDICT_QUERY_STATUS_COUPLINGS,先例
 * ACTION_RESPONSE_REJECTED_COUPLING)——两侧必须同步修改。
 *
 * 版本面(D-API-86):本契约族携带独立版本号 `VERDICT_CHANNEL_PROTOCOL_VERSION`
 * (= 1),$id 命名空间 `…/schemas/verdict/v1`;响应载荷本身不携带版本字段
 * (沿 SessionCommandResponse 先例:N-1 受理是路由级事实,回显版本判定细节
 * 即扩大探测面;契约版本由 $id 命名空间承载)。
 */
import { z } from "zod";
import { OpaqueIdSchema } from "../common/identifiers.js";
import { VerdictResultSchema } from "../session-action/verdict-result.js";

/**
 * 裁决查询状态(D-API-84 异步裁决状态机的两个载荷态):
 * - `pending`:裁决未决(submit 已受理、verifier 重放裁决尚未落库);
 * - `verdicted`:裁决已落库(终态;含成绩方向 success / wrong_answer 与
 *   非成绩方向 engine_error / challenge_invalid / replay_mismatch / cancelled
 *   等——非成绩结果是**已产生**的裁决,不是"未决")。
 */
export const VerdictQueryStatusSchema = z.enum(["pending", "verdicted"]);

export type VerdictQueryStatus = z.infer<typeof VerdictQueryStatusSchema>;

/** 服务端签发 revision 的公共形态(I-5:权威单调计数器;与 submit 响应同源)。 */
const RevisionSchema = z.number().int().min(0);

/**
 * 裁决查询响应(五字段上限面,D-API-83):载荷携带的公开信息恰为本表,
 * strictObject 使任何扩展字段(SERVER_ONLY 明细、队列位置、进度、谓词
 * 形态载荷)在契约层不可表达。
 */
export const VerdictQueryResponseSchema = z
  .strictObject({
    /** 服务端签发的提交引用 ID(submit 响应同源回显;归属校验在服务端)。 */
    submissionId: OpaqueIdSchema,
    /** 提交时的会话权威 revision(submit 响应 `{submissionId, revision}` 的回显)。 */
    revision: RevisionSchema,
    /** 异步裁决状态机两态(pending → verdicted,单向不可逆;D-API-84)。 */
    status: VerdictQueryStatusSchema,
    /** 正式裁决:冻结 11 值结果类型(唯一公开承载;verdicted 态必有)。 */
    verdict: VerdictResultSchema.optional(),
    /** 裁决落库时刻:Unix epoch 秒(UTC;verdicted 态必有,pending 态缺席)。 */
    decidedAt: z.number().int().min(0).optional(),
  })
  .superRefine((response, ctx) => {
    if (response.status === "pending") {
      if (response.verdict !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["verdict"],
          message:
            "pending 未决态不得携带 verdict(裁决尚未产生;11 值结果类型仅在 verdicted 态下发,D1 约束 1)",
        });
      }
      if (response.decidedAt !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["decidedAt"],
          message: "pending 未决态不得携带 decidedAt(裁决落库时刻尚未存在)",
        });
      }
    } else {
      if (response.verdict === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["verdict"],
          message: "verdicted 态必须携带 11 值结果类型 verdict(裁决已落库)",
        });
      }
      if (response.decidedAt === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["decidedAt"],
          message: "verdicted 态必须携带裁决落库时刻 decidedAt",
        });
      }
    }
  });

export type VerdictQueryResponse = z.infer<typeof VerdictQueryResponseSchema>;

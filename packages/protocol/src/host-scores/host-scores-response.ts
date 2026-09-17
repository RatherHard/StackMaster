/**
 * HostScoresResponse —— 宿主成绩同步只读接口的响应载荷(中期 M3 WP-78 冻结)。
 *
 * 契约定案(D-API-122 ~ D-API-126;docs/develop/decisions-m3/WP-78.md)的
 * 契约层落位:`GET /host/scores` 的响应体。端点形态(路由、宿主凭证、查询
 * 参数闸、租户白名单、限流与批量上限)为实现面登记,不作 JSON Schema 契约
 * ——与 VerdictQueryResponse(D-API-83)/ D-API-76 公开描述包端点同款先例:
 * GET 无请求体,路径 / 查询参数走冻结字符集与白名单校验,契约面只有响应体。
 *
 * 字段分类与硬门槛论证:docs/contracts/数据分类与秘密零驻留清单.md §6.11。
 * 整体 `PUBLIC`——本契约是**成绩批量只读导出面**,逐字段值来源均为公开面:
 *
 *  - `verdict` = 冻结 11 值结果类型(`VerdictResultSchema`,WP-2,零新增字面),
 *    与单条裁决呈现通道(VerdictQueryResponse)同源同值域;
 *  - `id` = `verdicts.id` 的公开投影,**仅作 keyset 游标**(无业务语义);
 *  - `submissionId` / `sessionId` / `challengeId` / `challengeVersion` =
 *    契约定位字段(会话归属与题目标识;challengeId / challengeVersion 本就是
 *    公开描述包的可 CDN 分发定位符,7.1);
 *  - `decidedAt` = 裁决落库时刻(Unix epoch 秒,UTC;VerdictQueryResponse 同口径)。
 *
 * **零**私有面:`verdicts.detail`(谓词 / 命中 / 测试索引 / 判题中间态)、
 * `submissions.reference`(完整 IR / 原始快照 / 完整事件日志)、隐藏测试与
 * 隐藏 flag 在本载荷**无表达位**(strictObject 拒绝一切扩展字段);
 * **零 `tenantId` 回显**——租户由宿主凭证绑定推导(认证上下文),回显即扩大
 * 探测面且为客户端提供无用途的相关性锚(O-MP-6 / 6.2「不接受自报身份」)。
 *
 * 游标语义(D-API-123):
 *  - 排序键 = `id`(服务端裁决行主键,全序;keyset 分页 `id > afterId`
 *    ORDER BY id ASC),**禁止以时刻为游标**(D-API-92 的毫秒截断教训:
 *    库内微秒时刻经 JS `Date` 截断会回退、末行被重复选中);
 *  - `nextCursor` = 本页之后仍有数据时的**末行 `id`**,否则恒为 `null`
 *    (无更多数据的确定性形态:键恒在、值恒 `null`,不省略——省略会让
 *    "字段缺席"与"无更多数据"两种语义在客户端侧混淆);
 *  - 终态确定性由跨字段耦合锁定:空页(`items` 为空)⇒ `nextCursor` 必为
 *    `null`(空页 + 非空游标会构成客户端无限翻页回路)。TS 侧等价规则在
 *    superRefine;JSON Schema 形态由生成管线以等价 if/then 显式注入
 *    (schema/generate.ts 的 HOST_SCORES_TERMINAL_COUPLING,先例
 *    VERDICT_QUERY_STATUS_COUPLINGS)——两侧必须同步修改。
 *
 * 版本面(D-API-123):本契约族携带独立版本号 `HOST_SCORES_PROTOCOL_VERSION`
 * (= 1),$id 命名空间 `…/schemas/host-scores/v1`;响应载荷本身不携带版本字段
 * (沿 SessionCommandResponse / VerdictQueryResponse 先例:回显版本判定细节即
 * 扩大探测面;契约版本由 $id 命名空间承载)。
 */
import { z } from "zod";
import { OpaqueIdSchema } from "../common/identifiers.js";
import { CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE } from "../embed/embed-token-claims.js";
import { VerdictResultSchema } from "../session-action/verdict-result.js";

/**
 * 单条成绩记录(公开上限面,七字段,D-API-123):载荷携带的公开信息恰为本表,
 * 严格对象使任何扩展字段(SERVER_ONLY 判题明细、隐藏测试命中、判题中间态、
 * 租户回显)在契约层不可表达。
 */
export const HostScoreRecordSchema = z.strictObject({
  /**
   * 本行游标值(服务端裁决行主键 `verdicts.id` 的公开投影;不透明标识符,
   * 零业务语义——下一批的 `cursor` 参数取上一批末行的本字段值)。
   */
  id: OpaqueIdSchema,
  /** 服务端签发的提交引用 ID(submit 响应与裁决呈现载荷同源回显)。 */
  submissionId: OpaqueIdSchema,
  /** 会话归属(服务端签发的会话标识;成绩的会话维度定位符)。 */
  sessionId: OpaqueIdSchema,
  /** 题目标识(公开描述包的可分发定位符,7.1)。 */
  challengeId: OpaqueIdSchema,
  /** 题目内容版本(语义化版本 X.Y.Z;与公开描述包 / create_session 同源格式)。 */
  challengeVersion: z
    .string()
    .regex(
      new RegExp(CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE),
      "题目内容版本必须为 X.Y.Z 形式的语义化版本",
    ),
  /** 正式裁决:冻结 11 值结果类型(唯一公开承载;零新增字面,D6)。 */
  verdict: VerdictResultSchema,
  /** 裁决落库时刻:Unix epoch 秒(UTC;与非成绩方向同构呈现)。 */
  decidedAt: z.number().int().min(0),
});

export type HostScoreRecord = z.infer<typeof HostScoreRecordSchema>;

/**
 * 宿主成绩同步响应(两字段信封:批量记录 + 游标)。
 *
 * `items` 允许为空数组(租户尚无已裁决提交,或游标已到末尾)——空批是
 * **合法终态**而非错误:空批与"租户不存在"在载荷面不可混淆,因为后者在
 * 路由面以 404 同形拒绝(D-API-124 防枚举),永不呈现为空批。
 */
export const HostScoresResponseSchema = z
  .strictObject({
    /** 本页成绩记录(按 `id` 升序;条数 ≤ 宿主面批量上限,D-API-125)。 */
    items: z.array(HostScoreRecordSchema),
    /**
     * 下一页游标:仍有数据 = 本页末行 `id`;无更多数据 = `null`(确定性形态,
     * 键恒在)。空页 ⇒ 必为 `null`(下列跨字段耦合)。
     */
    nextCursor: OpaqueIdSchema.nullable(),
  })
  .superRefine((response, ctx) => {
    if (response.items.length === 0 && response.nextCursor !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message:
          "空批是终态:items 为空时 nextCursor 必须为 null(空页 + 非空游标会构成无限翻页回路)",
      });
    }
  });

export type HostScoresResponse = z.infer<typeof HostScoresResponseSchema>;

/**
 * LaunchTicketRequest —— 启动票据签发请求载荷(WP-90 冻结;D-LT-1)。
 *
 * `POST /auth/launch-tickets` 的请求体,**恰两键**(strictObject:任何扩展字段
 * 在契约层不可表达)。契约定案 = D-LT-1 ~ D-LT-4(主控),设计全文 =
 * `docs/develop/启动票据契约设计草案.md` §二 / §六,字段分类论证 =
 * `docs/contracts/数据分类与秘密零驻留清单.md` §6.12。
 *
 * 两条硬性语义(逐字遵守 D-LT-1 / §六):
 *
 *  1. **租户不在请求体**。租户**只**由宿主凭证 × `SESSION_API_HOST_TENANTS`
 *     白名单在服务端派生(6.2「不接受请求体或 postMessage 自报身份」);
 *     请求体 / 查询参数**永不派生租户**。故本 Schema 无 `tenantId` 位 ——
 *     不是「有但不用」,而是**结构性不可表达**:企图自报租户的请求体在契约
 *     校验层即被 strictObject 拒绝(`test/fixtures/launch-ticket-request/invalid/
 *     01-extra-tenant-id-tamper.json` 即该形态的红灯样例)。
 *  2. `challengeId` / `version` 属**公开导航信息**(一题一址;与公开描述包
 *     `challengeId` / `challengeContentVersion` 同源,WP-1 清单 §12.2 已分类
 *     `PUBLIC`)——它们决定「打开哪一题」,不决定「以谁的身份」。
 *
 * 分类 = `BOUNDARY`(整体):载荷是**跨边界**形态(平台后端 → 服务端),
 * 且内容属「玩家 / 集成方自报的导航参数」——服务端按其重新校验(题目存在性
 * 与已发布状态、白名单租户),绝不采信其内容为授权。
 *
 * 版本面(D-LT-1):本契约族携带独立版本号 `LAUNCH_TICKET_PROTOCOL_VERSION`,
 * `$id` 命名空间 `…/schemas/launch-ticket/v1`;**请求体不携带 `protocolVersion`
 * 字段** —— N-1 受理是**路由级事实**,回显版本判定细节即扩大探测面(沿
 * `HostScoresResponse` / `VerdictQueryResponse` / `SessionCommandResponse` 先例;
 * 契约版本由 `$id` 命名空间承载)。
 */
import { z } from "zod";
import { OpaqueIdSchema } from "../common/identifiers.js";
import { CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE } from "../embed/embed-token-claims.js";

/**
 * 签发请求体(恰两键:`challengeId` / `version`;D-LT-1)。
 */
export const LaunchTicketRequestSchema = z.strictObject({
  /**
   * 题目标识(公开描述包的可分发定位符,7.1;§12.2 已分类 `PUBLIC`)。
   * 不透明标识符字符集(见 `common/identifiers.ts`):非空、≤
   * `OPAQUE_ID_MAX_LENGTH`、仅 `A-Za-z0-9_-`。
   */
  challengeId: OpaqueIdSchema,
  /**
   * 题目内容版本(`X.Y.Z` 语义化版本字面,**复用** `embed-token-claims.ts` 的
   * `CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE`,不复制第二份正则字面量 ——
   * 该常量是题目内容版本格式的单一来源,格式变更属契约变更,两端必须同步)。
   */
  version: z
    .string()
    .regex(
      new RegExp(CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE),
      "题目内容版本必须为 X.Y.Z 形式的语义化版本",
    ),
});

export type LaunchTicketRequest = z.infer<typeof LaunchTicketRequestSchema>;

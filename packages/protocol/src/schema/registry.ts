/**
 * 根 Schema 注册表:需要落盘为 JSON Schema 文件的契约清单。
 *
 * 每个根 Schema 生成一个自包含文件(无跨文件 $ref),并在
 * SCHEMA_CLASSIFICATIONS(common/classification.ts)中登记字段分类——
 * 注册表条目缺分类时生成管线直接失败,防止未分类契约进入落盘产物。
 *
 * 每个条目声明其契约族的 $id 命名空间(baseId):每类契约携带独立版本号
 * (5.6),破坏性变更递增版本常量时命名空间随版本段切换。
 *
 * 边界纪律(WP-1 §五):本模块(经包入口导出,浏览器可达)登记的 Schema
 * 对浏览器可达代码**可见可用**;两类例外登记在 server-only/schema-registry.ts:
 * server-only 分类根 Schema(ProjectionPolicy,"Schema 存在不等于可下发"),
 * 以及"载荷可穿越浏览器、但解析器不给浏览器"的凭证类 Schema
 * (SessionCredentialClaims / LaunchGrantClaims —— 浏览器对凭证不解析,claims
 * 解析器仅供后端签发 / 校验消费;~~EmbedTokenClaims~~ 已随嵌入协议面
 * 2026-09-19 物理删除)。两者都仅由生成管线(node:fs,不进浏览器构建图)与
 * 后端包消费。
 */
import type { ZodType } from "zod";
import { SCHEMA_CLASSIFICATIONS, type SchemaClassification } from "../common/classification.js";
import { PublicErrorSchema } from "../error/public-error.js";
import { ProjectionDeltaSchema } from "../projection/projection-delta.js";
import { PublicStateProjectionSchema } from "../projection/public-state-projection.js";
import { SessionCommandRequestSchema } from "../session-command/session-command-request.js";
import { SessionCommandResponseSchema } from "../session-command/session-command-response.js";
import { ActionRequestSchema } from "../session-action/action-request.js";
import { ActionResponseSchema } from "../session-action/action-response.js";
import { VerdictResultSchema } from "../session-action/verdict-result.js";
import { DebugFrameSchema } from "../transport/debug-frame.js";
import { WssFrameSchema } from "../transport/wss-frame.js";
import {
  DEBUG_SCHEMA_BASE_ID,
  HOST_SCORES_SCHEMA_BASE_ID,
  LAUNCH_TICKET_SCHEMA_BASE_ID,
  SESSION_ACTION_SCHEMA_BASE_ID,
  VERDICT_SCHEMA_BASE_ID,
} from "../version.js";
import { HostScoresResponseSchema } from "../host-scores/host-scores-response.js";
import { LaunchTicketRequestSchema } from "../launch-ticket/launch-ticket-request.js";
import { LaunchTicketResponseSchema } from "../launch-ticket/launch-ticket-response.js";
import { VerdictQueryResponseSchema } from "../verdict/verdict-query-response.js";

/** 已登记字段分类的 Schema 名(与 SCHEMA_CLASSIFICATIONS 键严格对齐)。 */
export type SchemaName = keyof typeof SCHEMA_CLASSIFICATIONS;

export interface SchemaEntry {
  /** 生成文件名与 $id 片段(kebab-case);必须是已登记分类的 Schema 名。 */
  readonly name: SchemaName;
  /** JSON Schema 的 title(类型名)。 */
  readonly title: string;
  /** 契约族的 $id 命名空间(版本化,5.6)。 */
  readonly baseId: string;
  readonly schema: ZodType;
}

/** 公开 / 边界根 Schema(浏览器可达包可导入的注册表面)。 */
export const SCHEMA_REGISTRY: readonly SchemaEntry[] = [
  {
    name: "action-request",
    title: "ActionRequest",
    baseId: SESSION_ACTION_SCHEMA_BASE_ID,
    schema: ActionRequestSchema,
  },
  {
    name: "action-response",
    title: "ActionResponse",
    baseId: SESSION_ACTION_SCHEMA_BASE_ID,
    schema: ActionResponseSchema,
  },
  {
    name: "verdict-result",
    title: "VerdictResult",
    baseId: SESSION_ACTION_SCHEMA_BASE_ID,
    schema: VerdictResultSchema,
  },
  {
    name: "public-state-projection",
    title: "PublicStateProjection",
    baseId: SESSION_ACTION_SCHEMA_BASE_ID,
    schema: PublicStateProjectionSchema,
  },
  {
    name: "projection-delta",
    title: "ProjectionDelta",
    baseId: SESSION_ACTION_SCHEMA_BASE_ID,
    schema: ProjectionDeltaSchema,
  },
  {
    name: "public-error",
    title: "PublicError",
    baseId: SESSION_ACTION_SCHEMA_BASE_ID,
    schema: PublicErrorSchema,
  },
  {
    // 「embed-message」条目已随嵌入协议面 2026-09-19 物理删除(WP-96):
    // 该 Schema、其 `$id` 命名空间 `…/schemas/embed/v1` 与落盘产物
    // `schema/embed-message.schema.json` 同批移除(退役登记见
    // docs/contracts/数据分类与秘密零驻留清单.md §6.4)。
    name: "session-command-request",
    title: "SessionCommandRequest",
    baseId: SESSION_ACTION_SCHEMA_BASE_ID,
    schema: SessionCommandRequestSchema,
  },
  {
    name: "session-command-response",
    title: "SessionCommandResponse",
    baseId: SESSION_ACTION_SCHEMA_BASE_ID,
    schema: SessionCommandResponseSchema,
  },
  {
    name: "wss-frame",
    title: "WssFrame",
    baseId: SESSION_ACTION_SCHEMA_BASE_ID,
    schema: WssFrameSchema,
  },
  {
    name: "debug-frame",
    title: "DebugFrame",
    baseId: DEBUG_SCHEMA_BASE_ID,
    schema: DebugFrameSchema,
  },
  {
    // 裁决呈现通道查询响应(阶段六 WP-60,D-API-83 / D-API-86):正式裁决的
    // 唯一公开承载面(11 值结果类型 + 契约定位字段),独立版本命名空间。
    name: "verdict-query-response",
    title: "VerdictQueryResponse",
    baseId: VERDICT_SCHEMA_BASE_ID,
    schema: VerdictQueryResponseSchema,
  },
  {
    // 宿主成绩同步只读接口响应(中期 M3 WP-78,D-API-122 ~ D-API-126):
    // 宿主后端批量拉取本租户成绩的公开上限面(11 值裁决字面 + 契约定位字段
    // + keyset 游标),独立版本命名空间。
    name: "host-scores-response",
    title: "HostScoresResponse",
    baseId: HOST_SCORES_SCHEMA_BASE_ID,
    schema: HostScoresResponseSchema,
  },
  {
    // 启动票据签发请求(分发改版 WP-90,D-LT-1 ~ D-LT-3):
    // `POST /auth/launch-tickets` 的请求体,恰两键(公开导航信息 challengeId /
    // version;租户不在请求体,只由凭证 × 白名单派生),独立版本命名空间。
    // 分类 = BOUNDARY(跨到宿主后端的形态),故登记**公开注册表**:
    // 两份载荷本就是跨到平台后端 / 页面的形态,不进 server-only 注册表。
    name: "launch-ticket-request",
    title: "LaunchTicketRequest",
    baseId: LAUNCH_TICKET_SCHEMA_BASE_ID,
    schema: LaunchTicketRequestSchema,
  },
  {
    // 启动票据签发响应(分发改版 WP-90,D-LT-1 ~ D-LT-3):
    // 恰两键(launchUrl / expiresAt);票据值只在 launchUrl 内,不另回字段;
    // 不携带 protocolVersion(路由级 N-1 事实)。同属公开注册表(见上条理由)。
    name: "launch-ticket-response",
    title: "LaunchTicketResponse",
    baseId: LAUNCH_TICKET_SCHEMA_BASE_ID,
    schema: LaunchTicketResponseSchema,
  },
];

/** 取条目的字段分类;缺失即抛错(未分类契约不得落盘)。 */
export function classificationOf(name: SchemaName): SchemaClassification {
  return SCHEMA_CLASSIFICATIONS[name];
}

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
 * 以及"载荷可穿越浏览器、但解析器不给浏览器"的凭证类 Schema(EmbedTokenClaims
 * ——浏览器对 token 不解析,claims 解析器仅供后端签发 / 校验消费)。
 * 两者都仅由生成管线(node:fs,不进浏览器构建图)与后端包消费。
 */
import type { ZodType } from "zod";
import { SCHEMA_CLASSIFICATIONS, type SchemaClassification } from "../common/classification.js";
import { EmbedMessageSchema } from "../embed/embed-message.js";
import { PublicErrorSchema } from "../error/public-error.js";
import { ProjectionDeltaSchema } from "../projection/projection-delta.js";
import { PublicStateProjectionSchema } from "../projection/public-state-projection.js";
import { ActionRequestSchema } from "../session-action/action-request.js";
import { ActionResponseSchema } from "../session-action/action-response.js";
import { VerdictResultSchema } from "../session-action/verdict-result.js";
import { EMBED_SCHEMA_BASE_ID, SESSION_ACTION_SCHEMA_BASE_ID } from "../version.js";

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
    name: "embed-message",
    title: "EmbedMessage",
    baseId: EMBED_SCHEMA_BASE_ID,
    schema: EmbedMessageSchema,
  },
];

/** 取条目的字段分类;缺失即抛错(未分类契约不得落盘)。 */
export function classificationOf(name: SchemaName): SchemaClassification {
  return SCHEMA_CLASSIFICATIONS[name];
}

/**
 * 根 Schema 注册表:需要落盘为 JSON Schema 文件的契约清单。
 *
 * 每个根 Schema 生成一个自包含文件(无跨文件 $ref),并在
 * SCHEMA_CLASSIFICATIONS(common/classification.ts)中登记字段分类——
 * 注册表条目缺分类时生成管线直接失败,防止未分类契约进入落盘产物。
 *
 * 边界纪律(WP-1 §五):本模块(经包入口导出,浏览器可达)只登记 PUBLIC /
 * BOUNDARY 根 Schema;server-only 根 Schema(ProjectionPolicy)登记在
 * server-only/schema-registry.ts,仅由生成管线(node:fs,不进浏览器构建图)
 * 与后端包消费——防止 server-only Zod Schema 经注册表泄漏进浏览器模块图。
 */
import type { ZodType } from "zod";
import { SCHEMA_CLASSIFICATIONS, type SchemaClassification } from "../common/classification.js";
import { PublicErrorSchema } from "../error/public-error.js";
import { ProjectionDeltaSchema } from "../projection/projection-delta.js";
import { PublicStateProjectionSchema } from "../projection/public-state-projection.js";
import { ActionRequestSchema } from "../session-action/action-request.js";
import { ActionResponseSchema } from "../session-action/action-response.js";
import { VerdictResultSchema } from "../session-action/verdict-result.js";

/** 已登记字段分类的 Schema 名(与 SCHEMA_CLASSIFICATIONS 键严格对齐)。 */
export type SchemaName = keyof typeof SCHEMA_CLASSIFICATIONS;

export interface SchemaEntry {
  /** 生成文件名与 $id 片段(kebab-case);必须是已登记分类的 Schema 名。 */
  readonly name: SchemaName;
  /** JSON Schema 的 title(类型名)。 */
  readonly title: string;
  readonly schema: ZodType;
}

/** 公开 / 边界根 Schema(浏览器可达包可导入的注册表面)。 */
export const SCHEMA_REGISTRY: readonly SchemaEntry[] = [
  { name: "action-request", title: "ActionRequest", schema: ActionRequestSchema },
  { name: "action-response", title: "ActionResponse", schema: ActionResponseSchema },
  { name: "verdict-result", title: "VerdictResult", schema: VerdictResultSchema },
  {
    name: "public-state-projection",
    title: "PublicStateProjection",
    schema: PublicStateProjectionSchema,
  },
  { name: "projection-delta", title: "ProjectionDelta", schema: ProjectionDeltaSchema },
  { name: "public-error", title: "PublicError", schema: PublicErrorSchema },
];

/** 取条目的字段分类;缺失即抛错(未分类契约不得落盘)。 */
export function classificationOf(name: SchemaName): SchemaClassification {
  return SCHEMA_CLASSIFICATIONS[name];
}

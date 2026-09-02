/**
 * 根 Schema 注册表:需要落盘为 JSON Schema 文件的契约清单。
 *
 * 每个根 Schema 生成一个自包含文件(无跨文件 $ref),并在
 * SCHEMA_CLASSIFICATIONS(common/classification.ts)中登记字段分类——
 * 注册表条目缺分类时生成管线直接失败,防止未分类契约进入落盘产物。
 */
import type { ZodType } from "zod";
import { SCHEMA_CLASSIFICATIONS, type SchemaClassification } from "../common/classification.js";
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

export const SCHEMA_REGISTRY: readonly SchemaEntry[] = [
  { name: "action-request", title: "ActionRequest", schema: ActionRequestSchema },
  { name: "action-response", title: "ActionResponse", schema: ActionResponseSchema },
  { name: "verdict-result", title: "VerdictResult", schema: VerdictResultSchema },
];

/** 取条目的字段分类;缺失即抛错(未分类契约不得落盘)。 */
export function classificationOf(name: SchemaName): SchemaClassification {
  return SCHEMA_CLASSIFICATIONS[name];
}

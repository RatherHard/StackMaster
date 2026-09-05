/**
 * server-only 根 Schema 注册表(WP-1 §五)。
 *
 * 与公开注册表(schema/registry.ts)分离的原因:注册表持有 Zod Schema 对象,
 * 若经包入口导出会进入浏览器模块图。两类 Schema 登记于此:
 * - server-only 分类根 Schema(ProjectionPolicy):整体 SERVER_ONLY,永不进入
 *   跨域载荷,"Schema 存在不等于可下发";
 * - 凭证类 BOUNDARY Schema(EmbedTokenClaims):载荷可穿越浏览器,但浏览器对
 *   token 不解析——claims 解析器只供后端签发 / 校验消费,防"解析 token 做
 *   条件渲染"反模式。其落盘产物 x-sm-class 仍为 boundary(分类随
 *   SCHEMA_CLASSIFICATIONS,与本注册表位置无关)。
 *
 * 本表仅由两处消费:
 * - 生成管线(schema/generate.ts,node:fs,不进浏览器构建图)落盘 JSON Schema;
 * - 后端包经 @stackmaster/protocol/server-only 子路径做跨语言一致性校验。
 */
import { SCHEMA_CLASSIFICATIONS } from "../common/classification.js";
import { EmbedTokenClaimsSchema } from "../embed/embed-token-claims.js";
import {
  SCHEMA_REGISTRY,
  type SchemaEntry,
  type SchemaName,
} from "../schema/registry.js";
import { EMBED_SCHEMA_BASE_ID, SESSION_ACTION_SCHEMA_BASE_ID } from "../version.js";
import { ProjectionPolicySchema } from "./projection-policy.js";

/** 不向浏览器可达代码暴露解析器的根 Schema(server-only 类型 + 凭证类)。 */
export const SERVER_ONLY_SCHEMA_REGISTRY: readonly SchemaEntry[] = [
  {
    name: "projection-policy",
    title: "ProjectionPolicy",
    baseId: SESSION_ACTION_SCHEMA_BASE_ID,
    schema: ProjectionPolicySchema,
  },
  {
    name: "embed-token-claims",
    title: "EmbedTokenClaims",
    baseId: EMBED_SCHEMA_BASE_ID,
    schema: EmbedTokenClaimsSchema,
  },
];

/** 生成管线的完整消费面:公开注册表 + server-only 注册表。 */
export function allSchemaEntries(): readonly SchemaEntry[] {
  const entries = [...SCHEMA_REGISTRY, ...SERVER_ONLY_SCHEMA_REGISTRY];
  const seen = new Set<SchemaName>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new Error(`Schema 注册表出现重复名称:${entry.name}`);
    }
    seen.add(entry.name);
  }
  return entries;
}

/** 注册表覆盖面必须与分类清单完全一致(有分类无注册 = 契约漂移,生成前失败)。 */
export function assertRegistriesMatchClassifications(): void {
  const registered = new Set(allSchemaEntries().map((entry) => entry.name));
  for (const name of Object.keys(SCHEMA_CLASSIFICATIONS) as SchemaName[]) {
    if (!registered.has(name)) {
      throw new Error(`Schema ${name} 已登记分类但未注册,无法落盘 JSON Schema`);
    }
  }
  for (const name of registered) {
    if (!(name in SCHEMA_CLASSIFICATIONS)) {
      throw new Error(`Schema ${name} 已注册但未登记分类(未分类契约不得落盘)`);
    }
  }
}

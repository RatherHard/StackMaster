/**
 * 版本 → Schema 受理注册表(V-3 / V-4 的实现面)。
 *
 * 每个宿主声明支持的协议版本必须在此注册对应版本的 EmbedMessageSchema——
 * "声明了但无法按其版本 Schema 校验的版本"在装配期即拒绝(fail-closed)。
 * 冻结期只有 v1;破坏性变更递增版本后在 SUPPORTED_EMBED_PROTOCOL_VERSIONS
 * 追加 N-1,并在此注册 v2 Schema(N-1 双受理窗口)。
 */
import { EMBED_PROTOCOL_VERSION, EmbedMessageSchema, type EmbedMessage } from "@stackmaster/protocol";
import { EmbedInvalidOptionError } from "./errors.js";

/** 版本 Schema 最小结构面(只依赖 safeParse;避免把 zod 类型引入本包公开面)。 */
export interface VersionedEmbedSchema {
  safeParse(data: unknown): { success: true; data: EmbedMessage } | { success: false };
}

/** 版本受理注册表(冻结期:v1 → EmbedMessageSchema)。 */
export const EMBED_MESSAGE_SCHEMAS: ReadonlyMap<number, VersionedEmbedSchema> = new Map([
  [EMBED_PROTOCOL_VERSION, EmbedMessageSchema],
]);

/** 断言全部声明版本均已注册 Schema(装配期 fail-closed)。 */
export function assertAllVersionsHaveSchema(versions: readonly number[]): void {
  for (const version of versions) {
    if (!EMBED_MESSAGE_SCHEMAS.has(version)) {
      throw new EmbedInvalidOptionError(
        `声明支持的嵌入协议版本 ${String(version)} 未注册对应版本 Schema:宿主不得声明无法校验的版本(V-3/V-4 fail-closed)`,
      );
    }
  }
}

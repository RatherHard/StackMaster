/**
 * server-only 子路径入口(@stackmaster/protocol/server-only)。
 *
 * 本入口承载三类后端专用契约:
 * - "Schema 可存在、载荷禁下发"的 server-only 类型(ProjectionPolicy,WP-1 第五章);
 * - "载荷可穿越浏览器、解析器只给后端"的凭证类 Schema(EmbedTokenClaims,WP-5:
 *   浏览器对 embed token 不解析,claims 解析器仅供签发 / 校验消费;
 *   SessionCredentialClaims,阶段三 WP-0:浏览器对会话凭证同样不解析);
 * - 调试变体镜像(DebugVariantBundle,阶段四 WP-40):编排器 ↔ 调试 worker 的
 *   进程间内部契约,整体 SERVER_ONLY,浏览器永不可见(WP-1 清单 §6.9)。
 *
 * 仅后端包(challenge-compiler、session-api、verifier)可导入;浏览器可达包
 * 导入即违规,由 tooling/dependency-cruiser.cjs 的
 * `protocol-server-only-backend-consumers-only` 规则强制(WP-1 §五 / ZR-P1)。
 *
 * 包入口(index.ts)刻意不 re-export 本目录:TS 构建图中凡是只从包入口导入的
 * 浏览器包天然不可达本子路径。
 */
export * from "./projection-policy.js";
export {
  CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE,
  EmbedTokenClaimsSchema,
} from "../embed/embed-token-claims.js";
export type { EmbedTokenClaims } from "../embed/embed-token-claims.js";
export { SessionCredentialClaimsSchema } from "../credential/session-credential-claims.js";
export type { SessionCredentialClaims } from "../credential/session-credential-claims.js";
export {
  DEBUG_VARIANT_BUNDLE_SCHEMA_VERSION,
  DEBUG_VARIANT_SEED_ALGORITHM_ID,
  DebugVariantBundleSchema,
} from "../debug/debug-variant-bundle.js";
export type {
  DebugVariantBundle,
  DebugVariantBaseAddress,
  DebugVariantCanarySlot,
  DebugVariantDerivation,
  DebugVariantMemoryRegion,
  DebugVariantRegionKind,
  DebugVariantRegister,
} from "../debug/debug-variant-bundle.js";

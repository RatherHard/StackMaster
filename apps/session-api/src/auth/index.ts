/**
 * 认证与凭证面导出 barrel(WP-2;WP-96 退役 embed 面)。
 *
 * 装配面(最终装配归 WP-4):
 *  - `buildAuthPlugin(options)`:Cookie / CORS 装配(skip-override 插件,
 *    注册即落入调用方上下文;`/auth/embed-tokens` 端点本体已退役);
 *  - `buildCredentialPreHandler(deps, options)`:凭证校验 preHandler 工厂
 *    (REST 路由复用;WSS 由 WP-5 直接调用 `authenticateSessionCredential`);
 *  - `consumeLaunchGrant` / `issueLaunchGrant` / `issueSessionCredential` /
 *    `revokeSessionCredential`:签发链路服务(WP-4 的 create-session 路由
 *    按"签名 → 记录 → payload"三方比对顺序组合消费与凭证签发);
 *  - `createSessionAuthContext`:session-core AuthContext 真实实现(结构
 *    等价镜像,见 auth-context.ts);
 *  - `setSessionCredentialCookie`:会话凭证交付(D-API-12);
 *  - 端口与内存实现:`LaunchGrantStore` / `CredentialRevocationStore` /
 *    `AuditSink` + InMemory 默认实现(WP-4 以 WP-3 KeyValueStore 接 Redis)。
 *
 * ~~`consumeEmbedToken` / `revokeEmbedToken` / `TokenIssuanceStore`~~ 已随
 * 嵌入协议面 **2026-09-19 物理删除**(WP-96;见各文件头的退役登记)。
 */
export * from "./auth-context.js";
export * from "./consumption.js";
export * from "./cookie.js";
export * from "./errors.js";
export * from "./keys.js";
export * from "./memory.js";
export * from "./middleware.js";
export * from "./plugin.js";
export * from "./ports.js";

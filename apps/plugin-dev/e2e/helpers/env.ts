/**
 * E2E 共享环境解析(WP-F7)。
 *
 * 全部配置走环境变量(凭证纪律:SESSION_API_HOST_BACKEND_TOKEN 只经环境变量,
 * 不入库、无缺省值);缺省值仅覆盖 compose:app:up 拓扑的本地开发端口与合成
 * 题目上下文(与 global-setup 的 seed 步骤共用同一常量面)。
 */

/** E2E 运行环境(解析一次,测试与 global-setup 共用同一形状)。 */
export interface E2EEnv {
  /** session-api 直连源(compose:app:up 发布端口;服务端间签发 embed token 用)。 */
  readonly sessionApiOrigin: string;
  /** compose 拓扑登记的开发来源(CSRF 闸改写目标;与 compose/app.yaml 一致)。 */
  readonly allowedOrigin: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
  /** E2E_KEEP_COMPOSE=1:teardown 保留拓扑(复跑调试用)。 */
  readonly keepCompose: boolean;
  /** E2E_SKIP_COMPOSE=1:setup / teardown 均不触碰 compose(假设拓扑已在跑)。 */
  readonly skipCompose: boolean;
}

function flag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/** 从环境变量解析 E2E 环境;host 凭证缺失仅在签发 token 时报错(见 scripts/issue-embed-token.mjs)。 */
export function e2eEnv(env = process.env): E2EEnv {
  return {
    sessionApiOrigin: env["SESSION_API_ORIGIN"] ?? "http://127.0.0.1:13000",
    // compose/app.yaml 的 SESSION_API_ALLOWED_ORIGINS 开发合成值(CSRF 闸白名单)。
    allowedOrigin: env["E2E_ALLOWED_ORIGIN"] ?? "http://localhost:13000",
    tenantId: env["E2E_TENANT_ID"] ?? "e2e-tenant",
    userId: env["E2E_USER_ID"] ?? "e2e-user",
    challengeId: env["E2E_CHALLENGE_ID"] ?? "chal-e2e-plugin-dev",
    challengeVersion: env["E2E_CHALLENGE_VERSION"] ?? "1.0.0",
    keepCompose: flag(env["E2E_KEEP_COMPOSE"]),
    skipCompose: flag(env["E2E_SKIP_COMPOSE"]),
  };
}

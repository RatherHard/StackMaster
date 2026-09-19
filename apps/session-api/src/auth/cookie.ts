/**
 * 会话凭证的 Cookie 交付面(D-API-12 / D-API-13;WP-2 传输卫生)。
 *
 * 交付决策:会话凭证经 `Set-Cookie` 交付(浏览器 WebSocket 无法自定义请求
 * 头,WSS 升级沿 Cookie 呈递——D-API-3 候选落定);create-session 的 JSON
 * 响应体零凭证字段(WP-0 冻结纪律)。Cookie 属性:
 *  - HttpOnly:浏览器脚本不可读(插件 iframe 在选手控制域内,9.2);
 *  - Secure:仅 HTTPS 传输(NODE_ENV=test 豁免以便 http 注入测试,D-API-13);
 *  - SameSite=Strict:跨站请求不携带(CSRF 防护第一层,与 Origin 白名单闸
 *    双层防护,D-API-17);
 *  - Path=/sessions(精确 Path):仅会话生命周期路由族携带,签发端点与其他
 *    路径不可见(最小暴露面)。不采用 `__Host-` 前缀:该前缀浏览器强制
 *    Path=/,与精确 Path 的最小暴露面诉求冲突(登记 D-API-12)。
 *
 * WP-5 注意:WSS 升级路由必须位于 Cookie Path 覆盖之下(或经装配参数
 * `credentialCookiePath` 调宽),否则升级请求读不到凭证。
 */

import type { FastifyReply } from "fastify";

/** 会话凭证 Cookie 名(不含 `__Host-` 前缀的理由见文件头;非秘密)。 */
export const SESSION_CREDENTIAL_COOKIE_NAME = "sm_session_credential";

/** 会话凭证 Cookie 精确路径:覆盖五个会话命令路由族(D-API-1 路由表)。 */
export const SESSION_CREDENTIAL_COOKIE_PATH = "/sessions";

/**
 * 设置会话凭证 Cookie。token 只经此通道进入响应头;调用方不得以任何其他
 * 形态(body / query / 日志)输出凭证。
 */
export function setSessionCredentialCookie(
  reply: FastifyReply,
  token: string,
  ttlSeconds: number,
  nodeEnv: "development" | "test" | "production",
  cookiePath: string = SESSION_CREDENTIAL_COOKIE_PATH,
): void {
  void reply.setCookie(SESSION_CREDENTIAL_COOKIE_NAME, token, {
    path: cookiePath,
    httpOnly: true,
    // D-API-13:NODE_ENV=test 豁免 Secure,允许 http 注入测试;生产恒 Secure。
    secure: nodeEnv !== "test",
    sameSite: "strict",
    maxAge: ttlSeconds,
  });
}

/** 从 Cookie 头取会话凭证值(供 WSS 升级路径复用;REST 走 request.cookies)。 */
export function sessionCredentialFromCookieHeader(
  cookieHeader: string | undefined,
): string | undefined {
  if (cookieHeader === undefined) {
    return undefined;
  }
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const name = pair.slice(0, separator).trim();
    if (name === SESSION_CREDENTIAL_COOKIE_NAME) {
      const value = pair.slice(separator + 1).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

// ── 启动授权凭证的 Cookie 交付面(WP-91;D-LT-5 实施细化 5a / 5b)─────────

/**
 * 启动授权凭证 Cookie 名(非秘密;**独立于会话凭证名**)。
 *
 * 为什么不复用 `sm_session_credential`:两者**授权的东西不同** —— 会话凭证授权
 * "这一条已建立的会话",启动授权凭证授权"这个浏览器可以就 (tenant, challenge,
 * version) 建一次会话"。同名会让服务端无法区分"这是会话凭证还是授权凭证",
 * 也会让浏览器侧出现"同一个 Cookie 两种语义"的混淆面。
 */
export const LAUNCH_GRANT_COOKIE_NAME = "sm_launch_grant";

/**
 * 设置启动授权凭证 Cookie。
 *
 * **Path 取与会话凭证同一条** `/sessions`:它的**唯一消费点**就是
 * `POST /sessions`(create_session,v2),按最小暴露面纪律没有理由让它在别的
 * 路径上被携带。签发它的响应来自换票路由(`/app/c/...`)—— `Set-Cookie` 的
 * Path 与产生它的请求路径无关,浏览器按 Path 决定**后续**是否携带,故这里
 * 不受换票路径影响。
 *
 * 属性与会话凭证逐项同款(HttpOnly / Secure(测试豁免)/ SameSite=Strict /
 * maxAge),因为它们服务同一个威胁模型(9.2 浏览器不可信 + CSRF 第一层防护)。
 */
export function setLaunchGrantCookie(
  reply: FastifyReply,
  token: string,
  ttlSeconds: number,
  nodeEnv: "development" | "test" | "production",
  cookiePath: string = SESSION_CREDENTIAL_COOKIE_PATH,
): void {
  void reply.setCookie(LAUNCH_GRANT_COOKIE_NAME, token, {
    path: cookiePath,
    httpOnly: true,
    secure: nodeEnv !== "test",
    sameSite: "strict",
    maxAge: ttlSeconds,
  });
}

/** 从 Cookie 头取启动授权凭证值(与 `sessionCredentialFromCookieHeader` 同形)。 */
export function launchGrantFromCookieHeader(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) {
    return undefined;
  }
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const name = pair.slice(0, separator).trim();
    if (name === LAUNCH_GRANT_COOKIE_NAME) {
      const value = pair.slice(separator + 1).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

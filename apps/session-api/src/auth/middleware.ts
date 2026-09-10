/**
 * 会话凭证校验中间件:REST 与 WSS 的统一认证入口(WP-2;D-API-12 / 13 / 17)。
 *
 * 统一入口是 [`authenticateSessionCredential`]:Cookie 或 Bearer 呈递 →
 * 签名验证(含过期)→ 吊销键检查 → 派生 AuthContext。REST 侧以
 * [`buildCredentialPreHandler`] 工厂把它挂成 Fastify preHandler(供 WP-4
 * 路由复用);WSS 侧(WP-5)在升级握手时直接调用同一函数读 Cookie
 * (D-API-3 候选落定:浏览器 WebSocket 无法自定义请求头)。
 *
 * 传输卫生(任务分解 WP-2 第 4 条):
 *  - 凭证只从 Cookie / Authorization 头呈递,禁入 URL query;
 *  - 凭证与 Set-Cookie 头绝不入日志(req 序列化器白名单 + 调用纪律:本模块
 *    只记录 reason / jti 等非秘密标量);
 *  - 凭证不进错误响应:一切拒绝 = AUTH_FAILED_ERROR 统一形态(D-API-14);
 *  - Cookie 属性:HttpOnly + Secure(NODE_ENV=test 豁免,D-API-13)+
 *    SameSite=Strict + 精确 Path(D-API-12);
 *  - CSRF 防护:Cookie 呈递 + 变更方法时,Origin 必须命中精确白名单
 *    (SESSION_API_ALLOWED_ORIGINS;缺失 / 不符即统一 401,D-API-17);
 *    Bearer 呈递非浏览器向量,不走 CSRF 闸。
 */

import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { SessionCredentialClaims } from "@stackmaster/protocol/server-only";

import { SessionBindingError, createSessionAuthContext, type AuthContext } from "./auth-context.js";
import {
  AUTH_FAILED_ERROR,
  AUTH_FAILED_HTTP_STATUS,
} from "./consumption.js";
import { CredentialVerificationError, type CredentialFailureKind } from "./errors.js";
import type { TokenSigner } from "./keys.js";
import { SESSION_CREDENTIAL_COOKIE_NAME } from "./cookie.js";
import type { CredentialRevocationStore } from "./ports.js";

/** 凭证校验通过后挂在请求上的身份面(REST 路由的身份唯一来源,基线 #1)。 */
export interface SessionAuthInfo {
  readonly context: AuthContext;
  readonly claims: SessionCredentialClaims;
  /** 呈递通道(审计 / 诊断判别用;非秘密)。 */
  readonly via: "cookie" | "bearer";
}

declare module "fastify" {
  interface FastifyRequest {
    /**
     * 凭证中间件产出;仅在 credential preHandler 之后可读(之前恒为 null)。
     * 身份派生的唯一来源:路由逻辑禁止从请求体 / 查询串取身份(基线 #1)。
     */
    sessionAuth: SessionAuthInfo | null;
  }
}

/** 凭证校验拒绝的封闭原因集(仅进受控日志;响应面恒为统一形态)。 */
export type SessionCredentialRejectionReason =
  | CredentialFailureKind
  /** 未呈递任何凭证。 */
  | "absent"
  /** jti 命中吊销键域。 */
  | "revoked"
  /** CSRF 闸:Cookie 呈递 + 变更方法 + Origin 缺失或不在白名单。 */
  | "csrf_origin"
  /** 会话绑定不匹配(凭证跨会话呈递)。 */
  | "session_binding";

/** 凭证校验拒绝(确定性;reason 只进受控日志与审计)。 */
export class SessionCredentialRejected extends Error {
  readonly reason: SessionCredentialRejectionReason;

  constructor(reason: SessionCredentialRejectionReason, detail: string) {
    super(`session credential rejected (${reason}): ${detail}`);
    this.name = "SessionCredentialRejected";
    this.reason = reason;
  }
}

export interface SessionCredentialAuthenticationDeps {
  readonly signer: TokenSigner;
  readonly revocationStore: CredentialRevocationStore;
  readonly now?: () => number;
}

export interface SessionCredentialPresentation {
  /** Cookie 值(浏览器面;完整 Cookie 头由调用方拆键)。 */
  readonly cookie?: string | undefined;
  /** Bearer 值(不含 "Bearer " 前缀;服务端间 / 非浏览器面)。 */
  readonly bearer?: string | undefined;
}

export interface AuthenticatedSessionCredential {
  readonly claims: SessionCredentialClaims;
  readonly via: "cookie" | "bearer";
}

/**
 * REST 与 WSS 的统一凭证认证入口(WP-2 交付;WP-5 升级握手复用)。
 * 顺序:呈递解析 → 签名 + 过期 → 吊销键。任一不过抛
 * SessionCredentialRejected(reason 封闭)。
 */
export async function authenticateSessionCredential(
  deps: SessionCredentialAuthenticationDeps,
  presentation: SessionCredentialPresentation,
): Promise<AuthenticatedSessionCredential> {
  const bearer = presentation.bearer ?? "";
  const cookie = presentation.cookie ?? "";
  const via = bearer.length > 0 ? ("bearer" as const) : cookie.length > 0 ? ("cookie" as const) : null;
  if (via === null) {
    throw new SessionCredentialRejected("absent", "未呈递任何会话凭证");
  }
  const token = via === "bearer" ? bearer : cookie;

  let claims: SessionCredentialClaims;
  try {
    claims = await deps.signer.verifySessionCredential(token, {
      now: new Date((deps.now ?? Date.now)()),
    });
  } catch (err) {
    const kind: CredentialFailureKind =
      err instanceof CredentialVerificationError ? err.kind : "malformed";
    throw new SessionCredentialRejected(kind, err instanceof Error ? err.message : "verify failed");
  }

  if (await deps.revocationStore.isRevoked(claims.jti)) {
    throw new SessionCredentialRejected("revoked", `jti ${claims.jti} 已吊销`);
  }
  return { claims, via };
}

export interface CredentialPreHandlerOptions {
  /**
   * 会话锚提取器(REST:请求体 payload.sessionId 为权威锚,D-API-1)。
   * 返回 undefined = 本路由不做绑定校验(如面向会话集合的端点)。
   */
  readonly getSessionAnchor?: (request: FastifyRequest) => string | undefined;
}

export interface CredentialPreHandlerDeps extends SessionCredentialAuthenticationDeps {
  /** CORS 精确来源白名单(同一配置键;CSRF 闸共用,D-API-16 / 17)。 */
  readonly allowedOrigins: readonly string[];
}

/** 变更方法集(CSRF 闸的适用范围;GET / HEAD / OPTIONS 不适用)。 */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/** CSRF 闸:Origin 必须命中精确白名单(缺失 / 空 / 不符一律拒绝,fail-closed)。 */
function originAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (origin === undefined || origin.length === 0) {
    return false;
  }
  return allowedOrigins.includes(origin);
}

/** 从请求提取呈递材料(Cookie 键 + Authorization Bearer;无 query 通道)。 */
function extractPresentation(request: FastifyRequest): SessionCredentialPresentation {
  const cookies = (request as { cookies?: Record<string, string> }).cookies;
  const authorization = request.headers.authorization;
  return {
    cookie: cookies?.[SESSION_CREDENTIAL_COOKIE_NAME],
    bearer:
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : undefined,
  };
}

/**
 * 凭证校验 preHandler 工厂(REST 统一认证入口的装配形态)。
 * 通过后 `request.sessionAuth` 承载身份(context + claims);拒绝即以统一
 * 401 形态短路响应(冻结 PublicError,零原因差异,D-API-14)。
 */
export function buildCredentialPreHandler(
  deps: CredentialPreHandlerDeps,
  options: CredentialPreHandlerOptions = {},
): preHandlerHookHandler {
  return async function credentialPreHandler(request, reply) {
    const presentation = extractPresentation(request);

    // CSRF 闸(D-API-17):只对 Cookie 呈递的变更请求生效;Bearer 是服务端间
    // 呈递,不受浏览器 CSRF 向量影响。
    if (
      presentation.bearer === undefined &&
      presentation.cookie !== undefined &&
      isMutatingMethod(request.method) &&
      !originAllowed(request.headers.origin, deps.allowedOrigins)
    ) {
      return rejectCredential(reply, request, "csrf_origin");
    }

    try {
      const { claims, via } = await authenticateSessionCredential(deps, presentation);
      const context = createSessionAuthContext(claims);
      const anchor = options.getSessionAnchor?.(request);
      if (anchor !== undefined) {
        // 会话绑定(基线 #2):凭证跨会话呈递在此确定性拒绝。
        context.assertSessionAllowed({ sessionId: anchor });
      }
      request.sessionAuth = { context, claims, via };
    } catch (err) {
      const reason: SessionCredentialRejectionReason =
        err instanceof SessionCredentialRejected
          ? err.reason
          : err instanceof SessionBindingError
            ? "session_binding"
            : err instanceof CredentialVerificationError
              ? err.kind
              : "malformed";
      return rejectCredential(reply, request, reason);
    }
  };
}

/** 统一拒绝出口:reason 只进受控日志,响应面恒为冻结形态(零原因差异)。 */
function rejectCredential(
  reply: FastifyReply,
  request: FastifyRequest,
  reason: SessionCredentialRejectionReason,
): FastifyReply {
  request.log.warn({ reason }, "session credential rejected");
  return reply.code(AUTH_FAILED_HTTP_STATUS).send(AUTH_FAILED_ERROR);
}

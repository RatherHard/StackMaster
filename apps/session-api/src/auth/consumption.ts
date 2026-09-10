/**
 * create-session 的 embed token 三方比对消费、会话凭证签发与吊销(WP-2;
 * 嵌入协议 §六校验序;D-API-11 / D-API-14 / D-API-18)。
 *
 * 三方比对(任一不一致 fail-closed,拒绝面不区分具体原因):
 *  1. 签名 claims(域 2 密钥验证后的七字段)×
 *  2. 签发存储记录(token:{jti} 载荷——签发时宿主凭证担保的身份锚)×
 *  3. 请求上下文(create_session 载荷的 challengeId / challengeVersion /
 *     embedSessionId;会话动作协议:请求体零身份字段,身份锚是记录)。
 *
 * jti 单次原子消费:签发记录以 consume(存在即删除并返回)取出——未签发 /
 * 已消费 / 已吊销 / 记录过期四种"无有效记录"形态在端口面上同形(返回
 * null),拒绝面因此天然统一(防枚举)。
 *
 * 拒绝路径的细节(reject reason)只进受控日志与审计 detail;响应面恒为
 * AUTH_FAILED_ERROR(401 + 冻结 `invalid_input_format` 单码 + 静态文案,
 * D-API-14)。
 */

import { randomUUID } from "node:crypto";
import { PublicErrorSchema, type PublicError } from "@stackmaster/protocol";
import {
  SessionCredentialClaimsSchema,
  type SessionCredentialClaims,
} from "@stackmaster/protocol/server-only";
import type { Logger } from "pino";

import { CredentialVerificationError } from "./errors.js";
import {
  SESSION_CREDENTIAL_MAX_LENGTH,
  type TokenSigner,
} from "./keys.js";
import type { AuditSink, CredentialRevocationStore, TokenIssuanceStore } from "./ports.js";

/**
 * 统一凭证拒绝响应面(D-API-14):401 + 冻结 PublicError 单一错误码 +
 * 静态文案。选码理由:16 个冻结码中 `permission_denied` 的能力矩阵强制
 * addressHex = required-real(教学解释锚点),认证场景无地址语境不可用;
 * `invalid_input_format` 是唯一 coarse 级、无地址、可无解释的协议级拒绝码,
 * 与 server.ts 骨架错误面同码。所有拒绝路径同状态、同码、同文案——
 * 过期 / 已消费 / 绑定不符 / 伪造彼此零差异(防枚举)。
 */
export const AUTH_FAILED_HTTP_STATUS = 401;
export const AUTH_FAILED_ERROR: PublicError = PublicErrorSchema.parse({
  code: "invalid_input_format",
  message: "authentication failed",
});

/** 签发端点请求体校验失败(已过宿主认证之后才区分):400 + 冻结形态。 */
export const INVALID_REQUEST_HTTP_STATUS = 400;
export const INVALID_REQUEST_ERROR: PublicError = PublicErrorSchema.parse({
  code: "invalid_input_format",
  message: "invalid request",
});

/** embed token 消费拒绝的封闭原因集(仅进受控日志与审计,非秘密)。 */
export type EmbedTokenRejectionReason =
  | "signature_invalid"
  | "expired"
  | "malformed"
  /** 签发记录不存在:未签发 / 已消费 / 已吊销 / 记录过期(同面拒绝)。 */
  | "unknown_jti"
  /** 签名 claims × 签发记录不一致(含跨租户 / 跨用户 / 字段漂移)。 */
  | "record_mismatch"
  /** 请求上下文 × claims 不一致(题目身份对 / embedSessionId 绑定)。 */
  | "context_mismatch";

/** 消费拒绝(调用方捕获后以 AUTH_FAILED_ERROR 统一响应,reason 只进日志)。 */
export class EmbedTokenConsumptionRejected extends Error {
  readonly reason: EmbedTokenRejectionReason;

  constructor(reason: EmbedTokenRejectionReason, detail: string) {
    super(`embed token consumption rejected (${reason}): ${detail}`);
    this.name = "EmbedTokenConsumptionRejected";
    this.reason = reason;
  }
}

/** create-session 请求上下文(载荷中的题目上下文与 embedSessionId 绑定)。 */
export interface CreateSessionContext {
  readonly challengeId: string;
  readonly challengeVersion: string;
  readonly embedSessionId: string;
}

/** 三方比对通过后派生的会话身份(会话凭证签发与 create_session 审计的输入)。 */
export interface VerifiedEmbedTokenIdentity {
  readonly tenantId: string;
  readonly userId: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
  readonly embedSessionId: string;
  /** 已消费的 embed token 实例标识(签发链路可追溯锚;非秘密)。 */
  readonly embedTokenJti: string;
}

export interface EmbedTokenConsumerDeps {
  readonly signer: TokenSigner;
  readonly issuanceStore: TokenIssuanceStore;
  readonly audit: AuditSink;
  readonly logger: Logger;
  readonly now?: () => number;
}

export interface ConsumeEmbedTokenInput {
  /** create_session 载荷携带的 embed token(bearer 材料,禁入日志 / URL)。 */
  readonly embedToken: string;
  readonly context: CreateSessionContext;
}

/** 审计占位主体(签名验证失败时身份不可得;"unknown" 合法标识符形态)。 */
const UNKNOWN_ACTOR = { tenantId: "unknown", userId: "unknown" } as const;

/**
 * embed token 三方比对消费(嵌入协议 §六:签名 → 记录 → 上下文 → 单次消费)。
 * 成功返回派生身份并写入 embed_token_consumed 审计;拒绝一律抛
 * EmbedTokenConsumptionRejected(reason 封闭枚举,只进日志与审计)。
 */
export async function consumeEmbedToken(
  deps: EmbedTokenConsumerDeps,
  input: ConsumeEmbedTokenInput,
): Promise<VerifiedEmbedTokenIdentity> {
  const now = deps.now ?? Date.now;
  const auditRejected = async (reason: EmbedTokenRejectionReason, jti?: string): Promise<void> => {
    deps.logger.warn({ reason, jti }, "embed token consumption rejected");
    await deps.audit.append({
      kind: "embed_token_consumed",
      at: now(),
      actor: UNKNOWN_ACTOR,
      detail: { outcome: "rejected", reason, ...(jti === undefined ? {} : { jti }) },
    });
  };

  // 1. 签名验证(域 2 密钥;alg 锁定 EdDSA)与 exp 断言。
  let claims;
  try {
    claims = await deps.signer.verifyEmbedToken(input.embedToken, { now: new Date(now()) });
  } catch (err) {
    const kind = err instanceof CredentialVerificationError ? err.kind : "malformed";
    await auditRejected(kind);
    throw new EmbedTokenConsumptionRejected(
      kind,
      err instanceof Error ? err.message : "verify failed",
    );
  }

  // 2. jti 单次原子消费(记录存在即删除并返回;四种"无有效记录"同形)。
  const record = await deps.issuanceStore.consume(claims.jti);
  if (record === null) {
    await auditRejected("unknown_jti", claims.jti);
    throw new EmbedTokenConsumptionRejected(
      "unknown_jti",
      `jti ${claims.jti} 无有效签发记录(单次消费语义)`,
    );
  }

  // 3. 三方比对第 1 × 2 方:签名 claims × 签发记录(租户 / 用户以签发时
  //    宿主凭证担保的记录为锚——token 内字段不作为自报身份采信)。
  if (
    record.tenantId !== claims.tenantId ||
    record.userId !== claims.userId ||
    record.challengeId !== claims.challengeId ||
    record.challengeVersion !== claims.challengeVersion ||
    record.embedSessionId !== claims.embedSessionId ||
    record.expiresAt !== claims.expiresAt * 1000
  ) {
    await auditRejected("record_mismatch", claims.jti);
    throw new EmbedTokenConsumptionRejected(
      "record_mismatch",
      `jti ${claims.jti} 的签发记录与签名 claims 不一致`,
    );
  }

  // 4. 三方比对第 3 方:请求上下文(题目身份对 + embedSessionId 绑定)。
  if (
    input.context.challengeId !== claims.challengeId ||
    input.context.challengeVersion !== claims.challengeVersion ||
    input.context.embedSessionId !== claims.embedSessionId
  ) {
    await auditRejected("context_mismatch", claims.jti);
    throw new EmbedTokenConsumptionRejected(
      "context_mismatch",
      `jti ${claims.jti} 与请求上下文绑定不一致`,
    );
  }

  const identity: VerifiedEmbedTokenIdentity = {
    tenantId: claims.tenantId,
    userId: claims.userId,
    challengeId: claims.challengeId,
    challengeVersion: claims.challengeVersion,
    embedSessionId: claims.embedSessionId,
    embedTokenJti: claims.jti,
  };
  deps.logger.info({ jti: claims.jti }, "embed token consumed");
  await deps.audit.append({
    kind: "embed_token_consumed",
    at: now(),
    actor: { tenantId: identity.tenantId, userId: identity.userId },
    detail: {
      outcome: "accepted",
      jti: claims.jti,
      challengeId: claims.challengeId,
      challengeVersion: claims.challengeVersion,
      embedSessionId: claims.embedSessionId,
    },
  });
  return identity;
}

export interface SessionCredentialIssuerDeps {
  readonly signer: TokenSigner;
  readonly audit: AuditSink;
  /** 签发 TTL(秒;≤ MAX_SESSION_CREDENTIAL_TTL_SECONDS,由配置闸保证)。 */
  readonly ttlSeconds: number;
  readonly now?: () => number;
}

export interface SessionCredentialIssuanceInput {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
}

export interface IssuedSessionCredential {
  readonly claims: SessionCredentialClaims;
  readonly token: string;
  readonly ttlSeconds: number;
}

/**
 * 签发会话凭证:七字段 claims(SessionCredentialClaimsSchema 冻结面)→
 * 域 2 密钥 EdDSA 签名(D-API-10);交付面 = Set-Cookie(D-API-12,由
 * 调用方 / 路由层执行,见 middleware.ts 的 setSessionCredentialCookie)。
 * 会话绑定即 claims.sessionId——6.2 第 2 条的绑定在此建立。
 */
export async function issueSessionCredential(
  deps: SessionCredentialIssuerDeps,
  input: SessionCredentialIssuanceInput,
): Promise<IssuedSessionCredential> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  // 冻结 Schema 自检:签发面与契约漂移即抛错(与 server.ts 装配期自检同纪律)。
  const claims: SessionCredentialClaims = SessionCredentialClaimsSchema.parse({
    sessionId: input.sessionId,
    tenantId: input.tenantId,
    userId: input.userId,
    challengeId: input.challengeId,
    challengeVersion: input.challengeVersion,
    jti: randomUUID(),
    expiresAt: Math.floor(nowMs / 1000) + deps.ttlSeconds,
  });
  const token = await deps.signer.signSessionCredential(claims);
  if (token.length > SESSION_CREDENTIAL_MAX_LENGTH) {
    throw new Error(`签发的会话凭证载体超过长度上限(${SESSION_CREDENTIAL_MAX_LENGTH})`);
  }
  await deps.audit.append({
    kind: "session_credential_issued",
    at: nowMs,
    actor: { tenantId: claims.tenantId, userId: claims.userId },
    sessionId: claims.sessionId,
    detail: { jti: claims.jti, ttlSeconds: deps.ttlSeconds, challengeVersion: claims.challengeVersion },
  });
  return { claims, token, ttlSeconds: deps.ttlSeconds };
}

export interface SessionCredentialRevokerDeps {
  readonly revocationStore: CredentialRevocationStore;
}

/**
 * 吊销会话凭证:写入 jti 吊销键(TTL 必须 ≥ 凭证剩余有效期,由调用方按
 * claims.expiresAt 与当前时刻之差计算)。运行期吊销由强制终止流程触发
 * (session_force_closed 审计归 WP-4 / WP-6 的编排路径)。
 */
export async function revokeSessionCredential(
  deps: SessionCredentialRevokerDeps,
  jti: string,
  ttlSeconds: number,
): Promise<void> {
  await deps.revocationStore.revoke(jti, ttlSeconds);
}

export interface EmbedTokenRevokerDeps {
  readonly issuanceStore: TokenIssuanceStore;
  readonly audit: AuditSink;
  readonly now?: () => number;
}

/**
 * 吊销 embed token:删除 token:{jti} 即吊销(嵌入协议 §六;管理干预路径,
 * TTL 到期自然失效)。返回是否确有记录被删除(幂等)。
 */
export async function revokeEmbedToken(
  deps: EmbedTokenRevokerDeps,
  input: { jti: string; tenantId: string; userId: string },
): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const removed = await deps.issuanceStore.revoke(input.jti);
  await deps.audit.append({
    kind: "embed_token_revoked",
    at: now(),
    actor: { tenantId: input.tenantId, userId: input.userId },
    detail: { jti: input.jti, removed },
  });
  return removed;
}

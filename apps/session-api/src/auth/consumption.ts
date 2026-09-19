/**
 * create-session 的启动授权凭证三方比对消费、会话凭证签发与吊销(WP-91 / WP-2;
 * D-LT-5 实施细化 5a / 5c;D-API-11 / D-API-14 / D-API-18)。
 *
 * **退役登记(2026-09-19,分发改版 WP-96)**:embed token 消费面
 * (`consumeEmbedToken` / `EmbedTokenConsumptionRejected` /
 * `EmbedTokenRejectionReason` / `VerifiedEmbedTokenIdentity` /
 * `EmbedTokenConsumerDeps` / `ConsumeEmbedTokenInput` / `CreateSessionContext` /
 * `revokeEmbedToken`)随嵌入协议面与 create_session 的 v1 分支**同批物理删除**;
 * 其审计 kind(`embed_token_issued` / `embed_token_consumed` /
 * `embed_token_revoked`)按 D-API-90 的十值封闭集**原样保留**
 * (见 auth/ports.ts 的登记;三个 kind 现无写入方)。
 *
 * 本文件保留两族:
 *  - **启动授权凭证**(换票产物,create_session v2 的授权来源)的签发 / 消费;
 *  - **会话凭证**的签发 / 吊销。
 *
 * 三方比对(任一不一致 fail-closed,拒绝面不区分具体原因):
 *  1. 签名 claims(域 2 密钥验证后的六字段)×
 *  2. 签发存储记录(`launchGrant:{jti}` 载荷——签发时宿主凭证担保的身份锚)×
 *  3. 请求上下文(`create_session` payload 的题目身份对;会话动作协议:请求体
 *     零身份字段,身份锚是记录与签名 claims)。
 *
 * jti 单次原子消费:签发记录以 consume(存在即删除并返回)取出——未签发 /
 * 已消费 / 已过期三种"无有效记录"形态在端口面上同形(返回 null),拒绝面因此
 * 天然统一(防枚举)。
 *
 * 拒绝路径的细节(reject reason)只进受控日志;响应面恒为
 * AUTH_FAILED_ERROR(401 + 冻结 `invalid_input_format` 单码 + 静态文案,
 * D-API-14)。
 */

import { randomUUID } from "node:crypto";
import { PublicErrorSchema, type PublicError } from "@stackmaster/protocol";
import {
  LaunchGrantClaimsSchema,
  SessionCredentialClaimsSchema,
  type LaunchGrantClaims,
  type SessionCredentialClaims,
} from "@stackmaster/protocol/server-only";
import type { Logger } from "pino";

import { CredentialVerificationError } from "./errors.js";
import {
  SESSION_CREDENTIAL_MAX_LENGTH,
  type TokenSigner,
} from "./keys.js";
import type {
  AuditSink,
  CredentialRevocationStore,
  IssuedLaunchGrantRecord,
  LaunchGrantStore,
} from "./ports.js";

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

// ── 启动授权凭证的签发与消费(WP-91;D-LT-5 实施细化 5a / 5c)─────────────
//
// **为什么本段没有 AuditSink**:D-LT-5 第 7 条裁定「启动票据的签发 / 换票不新增
// `audit_log` kind」(审计十值封闭集不变,机检锚 `test/audit/audit-kinds.test.ts`)。
// 可审计性由**受控日志 + 指标**承载 ⇒ 这里只注入 Logger。这不是遗漏:一旦给它
// 注入 audit,就必然要么用既有 kind 表达新语义(污染既有语义),要么扩封闭集
// (被裁定排除)—— 两条路都被堵死,所以本段的形状就是裁定的直接后果。

/** 启动授权凭证消费拒绝的封闭原因集(仅进受控日志,非秘密)。 */
export type LaunchGrantRejectionReason =
  | "signature_invalid"
  | "expired"
  | "malformed"
  /** 签发记录不存在:未签发 / 已消费 / 已过期(三态同面拒绝)。 */
  | "unknown_jti"
  /** 签名 claims × 签发记录不一致(含跨租户 / 跨用户 / 字段漂移)。 */
  | "record_mismatch"
  /** `create_session` payload 的导航信息与凭证绑定**不逐字一致**。 */
  | "payload_mismatch";

/** 消费拒绝(调用方捕获后以 AUTH_FAILED_ERROR 统一响应,reason 只进日志)。 */
export class LaunchGrantConsumptionRejected extends Error {
  readonly reason: LaunchGrantRejectionReason;

  constructor(reason: LaunchGrantRejectionReason, detail: string) {
    super(`launch grant consumption rejected (${reason}): ${detail}`);
    this.name = "LaunchGrantConsumptionRejected";
    this.reason = reason;
  }
}

export interface LaunchGrantConsumerDeps {
  readonly signer: TokenSigner;
  readonly grantStore: LaunchGrantStore;
  readonly logger: Logger;
  readonly now?: () => number;
}

export interface ConsumeLaunchGrantInput {
  /**
   * 请求方呈递的启动授权凭证(Cookie 值;bearer 材料 —— 禁入日志 / URL /
   * 错误响应)。
   */
  readonly grantToken: string;
  /**
   * `create_session` payload 提供的**导航信息**(恰两键,v2)。
   * 它是**待校验的输入**,不是授权来源 —— 不一致即拒绝,绝不"以 payload 为准"。
   */
  readonly payload: {
    readonly challengeId: string;
    readonly challengeVersion: string;
  };
}

/**
 * 三方比对通过后派生的会话身份。
 *
 * **形状刻意与 `VerifiedCreateIdentity`(manager.createSession 的入参)一致**
 * (`{tenantId, userId, challengeId, challengeVersion}` 四字段):授权凭证恰好
 * 携带这四个身份 / 题目字段 ⇒ 换票链**不需要**任何形状适配层。`launchGrantJti`
 * 是签发链路可追溯锚(非秘密,只进受控日志)。
 */
export interface VerifiedLaunchGrantIdentity {
  readonly tenantId: string;
  readonly userId: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
  readonly launchGrantJti: string;
}

/**
 * 启动授权凭证三方比对消费(D-LT-5 5c 的校验序:签名 → 记录 → payload)。
 *
 *  - 第 1 方 = 签名 claims(域 2 密钥验证后的六字段);
 *  - 第 2 方 = 签发记录(`launchGrant:{jti}`;jti **单次原子消费**,取删一体);
 *  - 第 3 方 = **`create_session` payload 的导航信息**(`challengeId` /
 *    `challengeVersion`),必须与 claims 逐字一致。
 *
 * **身份零自报**:三方里没有一方来自"客户端说自己是谁" —— 租户与用户来自
 * 记录的派生链(签发时宿主凭证 × `SESSION_API_HOST_TENANTS` 白名单 ×
 * `SESSION_API_LAUNCH_USER_ID` 配置),payload 只提供"哪一题"。
 *
 * 拒绝一律抛 `LaunchGrantConsumptionRejected`,响应面由调用方统一为
 * **401 `AUTH_FAILED_ERROR`**(与会话凭证同一条冻结形态,零新增错误码)。
 */
export async function consumeLaunchGrant(
  deps: LaunchGrantConsumerDeps,
  input: ConsumeLaunchGrantInput,
): Promise<VerifiedLaunchGrantIdentity> {
  const now = deps.now ?? Date.now;
  const reject = (reason: LaunchGrantRejectionReason, jti?: string): void => {
    deps.logger.warn(
      { reason, ...(jti === undefined ? {} : { jti }) },
      "launch grant consumption rejected",
    );
  };

  // 1. 签名验证(域 2 密钥;alg 锁定 EdDSA)与 exp 断言。
  let claims: LaunchGrantClaims;
  try {
    claims = await deps.signer.verifyLaunchGrant(input.grantToken, { now: new Date(now()) });
  } catch (err) {
    const kind: LaunchGrantRejectionReason =
      err instanceof CredentialVerificationError ? err.kind : "malformed";
    reject(kind);
    throw new LaunchGrantConsumptionRejected(
      kind,
      err instanceof Error ? err.message : "verify failed",
    );
  }

  // 2. jti 单次原子消费(记录存在即删除并返回;未签发 / 已消费 / 已过期同形)。
  //    ⇒ **重放一枚授权凭证不可能建第二次会话**:第二次拿到的 record 是 null。
  const record = await deps.grantStore.consume(claims.jti);
  if (record === null) {
    reject("unknown_jti", claims.jti);
    throw new LaunchGrantConsumptionRejected(
      "unknown_jti",
      `jti ${claims.jti} 无有效签发记录(单次消费语义)`,
    );
  }

  // 3. 第 1 × 2 方:签名 claims × 签发记录(租户 / 用户以签发时宿主凭证担保的
  //    记录为锚 —— 凭证内字段不作为自报身份采信)。
  if (
    record.tenantId !== claims.tenantId ||
    record.userId !== claims.userId ||
    record.challengeId !== claims.challengeId ||
    record.challengeVersion !== claims.challengeVersion ||
    record.expiresAt !== claims.expiresAt * 1000
  ) {
    reject("record_mismatch", claims.jti);
    throw new LaunchGrantConsumptionRejected(
      "record_mismatch",
      `jti ${claims.jti} 的签发记录与签名 claims 不一致`,
    );
  }

  // 4. 第 3 方:payload 导航信息 × claims(**逐字一致**)。不一致 ⇒ 拒绝,
  //    **不得**降级为"以 payload 为准"(D-LT-5 第 2 条明示)。
  if (
    input.payload.challengeId !== claims.challengeId ||
    input.payload.challengeVersion !== claims.challengeVersion
  ) {
    reject("payload_mismatch", claims.jti);
    throw new LaunchGrantConsumptionRejected(
      "payload_mismatch",
      `jti ${claims.jti} 与 create_session payload 的题目绑定不一致`,
    );
  }

  deps.logger.info(
    { jti: claims.jti, challengeId: claims.challengeId },
    "launch grant consumed",
  );
  return {
    tenantId: claims.tenantId,
    userId: claims.userId,
    challengeId: claims.challengeId,
    challengeVersion: claims.challengeVersion,
    launchGrantJti: claims.jti,
  };
}

export interface LaunchGrantIssuerDeps {
  readonly signer: TokenSigner;
  readonly grantStore: LaunchGrantStore;
  /** 签发 TTL(秒;与启动票据同一配置族,由配置闸保证 ≤ 契约天花板)。 */
  readonly ttlSeconds: number;
  readonly now?: () => number;
}

export interface LaunchGrantIssuanceInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
}

export interface IssuedLaunchGrant {
  readonly claims: LaunchGrantClaims;
  readonly token: string;
  readonly ttlSeconds: number;
}

/**
 * 签发起动授权凭证(换票成功后由页面服务端调用;D-LT-5 5a / 5b)。
 *
 * 与 `issueSessionCredential` 的**关键差异**:本函数**不要求**任何已存在的
 * 会话行(授权凭证在会话建立**之前**签发),因此它的入参里**没有** `sessionId`
 * —— 这不是"忘了写",而是「授权凭证 ≠ 会话凭证」的结构性表达(候选 C
 * 「换票即建会话」已被 D-LT-5 否决)。
 *
 * claims 先过冻结 Schema 自检(签发面与契约漂移即抛错,与既有签发面同纪律),
 * 再签名,再写签发记录(TTL 与 claims.expiresAt 同源同值)。
 */
export async function issueLaunchGrant(
  deps: LaunchGrantIssuerDeps,
  input: LaunchGrantIssuanceInput,
): Promise<IssuedLaunchGrant> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const claims: LaunchGrantClaims = LaunchGrantClaimsSchema.parse({
    tenantId: input.tenantId,
    userId: input.userId,
    challengeId: input.challengeId,
    challengeVersion: input.challengeVersion,
    jti: randomUUID(),
    expiresAt: Math.floor(nowMs / 1000) + deps.ttlSeconds,
  });
  const token = await deps.signer.signLaunchGrant(claims);
  if (token.length > SESSION_CREDENTIAL_MAX_LENGTH) {
    throw new Error(`签发的启动授权凭证载体超过长度上限(${SESSION_CREDENTIAL_MAX_LENGTH})`);
  }
  const record: IssuedLaunchGrantRecord = {
    jti: claims.jti,
    tenantId: claims.tenantId,
    userId: claims.userId,
    challengeId: claims.challengeId,
    challengeVersion: claims.challengeVersion,
    issuedAt: nowMs,
    expiresAt: claims.expiresAt * 1000,
  };
  await deps.grantStore.put(record, deps.ttlSeconds);
  return { claims, token, ttlSeconds: deps.ttlSeconds };
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

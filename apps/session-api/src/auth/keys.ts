/**
 * 域 2 签名密钥载体:embed token 与会话凭证的签发 / 校验(WP-2;D-API-10)。
 *
 * 载体决策:JWT + EdDSA(Ed25519,jose 库,Node WebCrypto 实现)。PASETO
 * 无同等维护度;密钥仅信任域 2,签发 / 校验只经 `@stackmaster/protocol/
 * server-only` 的 claims 解析器消费。JWT 载荷 = 七字段冻结 claims + 标准保留
 * 字段 `exp`(与 claims.expiresAt 同值,epoch 秒)——除 exp 外不引入任何
 * 额外保留字段(iat / iss / aud 均不签发),使"签名前 claims 字段集合"与
 * 冻结 Schema 逐字段对应,载体可严格校验(多余字段即 malformed)。
 *
 * 密钥处理:config 启动期已按 createPrivateKey 校验过 Ed25519 PEM(三道闸
 * 取值闸);本模块在装配时再次解析(fail-closed 纵深)并同时导入私钥(签发)
 * 与公钥(校验)——校验永远只持公钥,verify 路径无签名能力(密钥用途分离)。
 *
 * 校验失败的确定性异常:CredentialVerificationError(kind = expired /
 * signature_invalid / malformed);alg 锁定 EdDSA + 显式公钥注入,结构性排除
 * alg 混淆(HS256 换算法)与算法降级。
 */

import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  EMBED_TOKEN_MAX_LENGTH,
} from "@stackmaster/protocol";
import {
  EmbedTokenClaimsSchema,
  SessionCredentialClaimsSchema,
  type EmbedTokenClaims,
  type SessionCredentialClaims,
} from "@stackmaster/protocol/server-only";
import { SignJWT, errors as joseErrors, importPKCS8, importSPKI, jwtVerify } from "jose";
import { z } from "zod";

import { CredentialVerificationError, type CredentialKind } from "./errors.js";

/** 会话凭证载体长度外圈护栏(与 embed token 同值;D-API-19)。 */
export const SESSION_CREDENTIAL_MAX_LENGTH = EMBED_TOKEN_MAX_LENGTH;

/** 校验时钟注入点(默认当前时刻;测试注入以确定性覆盖过期路径)。 */
export interface VerifyClockOptions {
  readonly now?: Date;
}

type SignKey = Parameters<SignJWT["sign"]>[0];
type VerifyKey = Parameters<typeof jwtVerify>[1];

/** JWT 载荷形态 = 七字段冻结 claims + exp(jose 校验后仍留在载荷内)。 */
const EmbedTokenJwtPayloadSchema = z.strictObject({
  ...EmbedTokenClaimsSchema.shape,
  exp: z.number().int().min(0),
});

const SessionCredentialJwtPayloadSchema = z.strictObject({
  ...SessionCredentialClaimsSchema.shape,
  exp: z.number().int().min(0),
});

/**
 * 签发 / 校验器(域 2 密钥装配后的冻结形态)。
 * verify 失败恒抛 CredentialVerificationError——kind 是日志 / 审计的唯一
 * 判别面,响应面不消费它(D-API-14 统一形态)。
 */
export interface TokenSigner {
  signEmbedToken(claims: EmbedTokenClaims): Promise<string>;
  verifyEmbedToken(token: string, clock?: VerifyClockOptions): Promise<EmbedTokenClaims>;
  signSessionCredential(claims: SessionCredentialClaims): Promise<string>;
  verifySessionCredential(token: string, clock?: VerifyClockOptions): Promise<SessionCredentialClaims>;
}

/**
 * 以 Ed25519 PKCS#8 PEM 装配签发 / 校验器。
 * 私钥 PEM 非法或非 Ed25519 即抛错(装配期 fail-closed,与配置闸双保险)。
 */
export async function createTokenSigner(signingKeyPem: string): Promise<TokenSigner> {
  const privateKeyObject = createPrivateKey(signingKeyPem);
  if (privateKeyObject.asymmetricKeyType !== "ed25519") {
    throw new TypeError("签发密钥必须是 Ed25519 私钥(EdDSA)");
  }
  const publicPem = createPublicKey(privateKeyObject)
    .export({ type: "spki", format: "pem" })
    .toString();
  const [privateKey, publicKey] = await Promise.all([
    importPKCS8(signingKeyPem, "EdDSA"),
    importSPKI(publicPem, "EdDSA"),
  ]);

  return {
    async signEmbedToken(claims: EmbedTokenClaims): Promise<string> {
      return signClaims(claims, privateKey, "embed token");
    },
    async verifyEmbedToken(token: string, clock?: VerifyClockOptions): Promise<EmbedTokenClaims> {
      return verifyEmbedTokenClaims(token, publicKey, clock);
    },
    async signSessionCredential(claims: SessionCredentialClaims): Promise<string> {
      return signClaims(claims, privateKey, "session credential");
    },
    async verifySessionCredential(
      token: string,
      clock?: VerifyClockOptions,
    ): Promise<SessionCredentialClaims> {
      return verifySessionCredentialClaims(token, publicKey, clock);
    },
  };
}

/** 签名:七字段 claims 原样进载荷,exp = expiresAt(同一值,双重表达合一)。 */
function signClaims(
  claims: EmbedTokenClaims | SessionCredentialClaims,
  key: SignKey,
  label: string,
): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "EdDSA" })
    .setExpirationTime(claims.expiresAt)
    .sign(key)
    .then((token) => {
      // 签发面后置护栏:超限载体永不外发(七字段 claims 的紧凑 JWS 远低于
      // 协议外圈护栏;触限即实现漂移,抛错而非静默发出)。
      if (token.length > SESSION_CREDENTIAL_MAX_LENGTH) {
        throw new Error(`签发的 ${label} 载体超过长度上限(${SESSION_CREDENTIAL_MAX_LENGTH})`);
      }
      return token;
    });
}

async function verifyEmbedTokenClaims(
  token: string,
  key: VerifyKey,
  clock?: VerifyClockOptions,
): Promise<EmbedTokenClaims> {
  const payload = await verifyPayload(token, key, "embed_token", clock);
  const parsed = EmbedTokenJwtPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CredentialVerificationError(
      "embed_token",
      "malformed",
      `claims 形态非法(${parsed.error.issues.length} 处)`,
    );
  }
  // 白名单装配(exp 已由 jose 断言;七字段逐一显式取值,零保留字段残留)。
  return {
    tenantId: parsed.data.tenantId,
    userId: parsed.data.userId,
    challengeId: parsed.data.challengeId,
    challengeVersion: parsed.data.challengeVersion,
    embedSessionId: parsed.data.embedSessionId,
    jti: parsed.data.jti,
    expiresAt: parsed.data.expiresAt,
  };
}

async function verifySessionCredentialClaims(
  token: string,
  key: VerifyKey,
  clock?: VerifyClockOptions,
): Promise<SessionCredentialClaims> {
  const payload = await verifyPayload(token, key, "session_credential", clock);
  const parsed = SessionCredentialJwtPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CredentialVerificationError(
      "session_credential",
      "malformed",
      `claims 形态非法(${parsed.error.issues.length} 处)`,
    );
  }
  return {
    sessionId: parsed.data.sessionId,
    tenantId: parsed.data.tenantId,
    userId: parsed.data.userId,
    challengeId: parsed.data.challengeId,
    challengeVersion: parsed.data.challengeVersion,
    jti: parsed.data.jti,
    expiresAt: parsed.data.expiresAt,
  };
}

/** 载体护栏 + alg 锁定的签名验证;jose 异常映射为确定性三值 kind。 */
async function verifyPayload(
  token: string,
  key: VerifyKey,
  credential: CredentialKind,
  clock?: VerifyClockOptions,
): Promise<unknown> {
  if (token.length === 0 || token.length > SESSION_CREDENTIAL_MAX_LENGTH) {
    throw new CredentialVerificationError(
      credential,
      "malformed",
      `载体长度越界(${token.length})`,
    );
  }
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["EdDSA"],
      currentDate: clock?.now,
    });
    return payload;
  } catch (err) {
    throw mapJoseError(credential, err);
  }
}

/** jose 异常 → 确定性 kind(细节进 message,只允许入受控日志)。 */
function mapJoseError(credential: CredentialKind, err: unknown): CredentialVerificationError {
  if (err instanceof joseErrors.JWTExpired) {
    return new CredentialVerificationError(credential, "expired", "exp 断言失败(已过期)");
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    return new CredentialVerificationError(credential, "signature_invalid", "签名验证不匹配");
  }
  return new CredentialVerificationError(
    credential,
    "malformed",
    err instanceof Error ? `${err.name}: ${err.message}` : "未知校验失败",
  );
}

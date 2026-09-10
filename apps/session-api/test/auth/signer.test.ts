/**
 * 签发 / 校验器矩阵(keys.ts;D-API-10 载体决策的确定性异常测试)。
 * 红灯逐条映射完成标准:伪造签名 / 过期 / 形态非法(含多余字段)全部
 * 确定性拒绝,kind 封闭三值。
 */

import { randomUUID } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
import {
  CredentialVerificationError,
  SESSION_CREDENTIAL_MAX_LENGTH,
  createTokenSigner,
  type TokenSigner,
} from "../../src/auth/index.js";
import type { SessionCredentialClaims } from "@stackmaster/protocol/server-only";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  TEST_SIGNING_KEY_PEM,
  TEST_TENANT_ID,
  TEST_USER_ID,
  makeEmbedSessionId,
} from "../helpers/auth-rig.js";

async function otherKeySigner(): Promise<TokenSigner> {
  const { privateKey } = generateKeyPairSync("ed25519");
  return createTokenSigner(privateKey.export({ type: "pkcs8", format: "pem" }).toString());
}

/** 断言 verify 拒绝并取回确定性异常(未拒绝即失败)。 */
async function verifyFailure(promise: Promise<unknown>): Promise<CredentialVerificationError> {
  try {
    await promise;
  } catch (err) {
    return err as CredentialVerificationError;
  }
  throw new Error("verify 应当拒绝,但返回了成功结果");
}

function embedClaims(overrides?: Partial<Parameters<TokenSigner["signEmbedToken"]>[0]>) {
  return {
    tenantId: TEST_TENANT_ID,
    userId: TEST_USER_ID,
    challengeId: TEST_CHALLENGE_ID,
    challengeVersion: TEST_CHALLENGE_VERSION,
    embedSessionId: makeEmbedSessionId(),
    jti: randomUUID(),
    expiresAt: 4_102_444_800, // 2100-01-01,未来时刻
    ...overrides,
  };
}

function sessionClaims(): SessionCredentialClaims {
  return {
    sessionId: `sess-${randomUUID()}`,
    tenantId: TEST_TENANT_ID,
    userId: TEST_USER_ID,
    challengeId: TEST_CHALLENGE_ID,
    challengeVersion: TEST_CHALLENGE_VERSION,
    jti: randomUUID(),
    expiresAt: 4_102_444_800,
  };
}

describe("TokenSigner(EdDSA / Ed25519,域 2 密钥)", () => {
  it("embed token 签发后校验返回逐字段一致的七字段 claims", async () => {
    const signer = await createTokenSigner(TEST_SIGNING_KEY_PEM);
    const claims = embedClaims();
    const token = await signer.signEmbedToken(claims);
    expect(token.length).toBeLessThanOrEqual(SESSION_CREDENTIAL_MAX_LENGTH);
    await expect(signer.verifyEmbedToken(token)).resolves.toEqual(claims);
  });

  it("会话凭证签发后校验返回逐字段一致的七字段 claims", async () => {
    const signer = await createTokenSigner(TEST_SIGNING_KEY_PEM);
    const claims = sessionClaims();
    const token = await signer.signSessionCredential(claims);
    await expect(signer.verifySessionCredential(token)).resolves.toEqual(claims);
  });

  it("伪造签名(其他密钥签发)确定性拒绝:kind = signature_invalid", async () => {
    const signer = await createTokenSigner(TEST_SIGNING_KEY_PEM);
    const forger = await otherKeySigner();
    const forged = await forger.signEmbedToken(embedClaims());
    const failure = await verifyFailure(signer.verifyEmbedToken(forged));
    expect(failure).toBeInstanceOf(CredentialVerificationError);
    expect(failure.kind).toBe("signature_invalid");
  });

  it("载荷篡改确定性拒绝:kind = signature_invalid", async () => {
    const signer = await createTokenSigner(TEST_SIGNING_KEY_PEM);
    const token = await signer.signEmbedToken(embedClaims());
    const tampered = `${token.slice(0, -4)}AAAA`;
    const failure = await verifyFailure(signer.verifyEmbedToken(tampered));
    expect(failure).toBeInstanceOf(CredentialVerificationError);
    expect(failure.kind).toBe("signature_invalid");
  });

  it("过期(exp 注入时钟越过)确定性拒绝:kind = expired;未越过则通过", async () => {
    const signer = await createTokenSigner(TEST_SIGNING_KEY_PEM);
    const expiresAt = 1_900_000_000;
    const token = await signer.signEmbedToken(embedClaims({ expiresAt }));
    const justBefore = new Date((expiresAt - 1) * 1000);
    await expect(signer.verifyEmbedToken(token, { now: justBefore })).resolves.toBeDefined();
    const justAfter = new Date((expiresAt + 1) * 1000);
    const failure = await verifyFailure(signer.verifyEmbedToken(token, { now: justAfter }));
    expect(failure).toBeInstanceOf(CredentialVerificationError);
    expect(failure.kind).toBe("expired");
  });

  it("载体形态非法(垃圾 / 截断 / 超长)确定性拒绝:kind = malformed", async () => {
    const signer = await createTokenSigner(TEST_SIGNING_KEY_PEM);
    for (const garbage of ["", "not-a-jwt", "a.b.c"]) {
      const failure = await verifyFailure(signer.verifyEmbedToken(garbage));
      expect(failure).toBeInstanceOf(CredentialVerificationError);
      expect(failure.kind).toBe("malformed");
    }
    const oversized = `x${"y".repeat(SESSION_CREDENTIAL_MAX_LENGTH)}`;
    const failure = await verifyFailure(signer.verifyEmbedToken(oversized));
    expect(failure.kind).toBe("malformed");
  });

  it("claims 形态非法(多余字段 / 缺字段 / 字段类型漂移)确定性拒绝:kind = malformed", async () => {
    const signer = await createTokenSigner(TEST_SIGNING_KEY_PEM);
    const key = (await importPKCS8(TEST_SIGNING_KEY_PEM, "EdDSA")) as Awaited<
      ReturnType<typeof importPKCS8>
    >;

    const shapeInjections: ReadonlyArray<Record<string, unknown>> = [
      // 七字段 + 自报身份复述(tenantId 双写为自报形态;strictObject 即拒)。
      { ...embedClaims(), injectedTenantId: "tenant-attacker" },
      // 缺失字段(无 jti)。
      (() => {
        const withoutJti: Record<string, unknown> = { ...embedClaims() };
        delete withoutJti.jti;
        return withoutJti;
      })(),
      // 字段类型漂移(expiresAt 非整数)。
      { ...embedClaims(), expiresAt: "not-a-number" },
    ];
    for (const payload of shapeInjections) {
      const token = await new SignJWT({ ...payload })
        .setProtectedHeader({ alg: "EdDSA" })
        .setExpirationTime(4_102_444_800)
        .sign(key);
      const failure = await verifyFailure(signer.verifyEmbedToken(token));
      expect(failure).toBeInstanceOf(CredentialVerificationError);
      expect(failure.kind).toBe("malformed");
    }
  });

  it("非法签发密钥(非 PEM / 非 Ed25519)在装配期即抛错(fail-closed)", async () => {
    await expect(createTokenSigner("definitely-not-a-pem")).rejects.toThrow();
  });
});

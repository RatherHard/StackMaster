/**
 * 签发 / 校验器矩阵(keys.ts;D-API-10 载体决策的确定性异常测试)。
 * 红灯逐条映射完成标准:伪造签名 / 过期 / 形态非法(含多余字段)全部
 * 确定性拒绝,kind 封闭三值。
 *
 * **2026-09-19(WP-96)**:embed token 一族(`signEmbedToken` /
 * `verifyEmbedToken` / `EmbedTokenJwtPayloadSchema`)已随嵌入协议面物理删除。
 * 原"embed token 七字段"矩阵**逐条改为启动授权凭证六字段(换票产物,
 * D-LT-5 5a)** —— 被测机制(sign / verify / 伪造 / 篡改 / 过期 / 载体与
 * claims 形态护栏 / 确定性 kind)逐条不变,只是载体族换了;会话凭证族
 * 用例原样保留。**没有任何用例被删除或放宽**。
 */

import { randomUUID } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
import {
  CredentialVerificationError,
  SESSION_CREDENTIAL_MAX_LENGTH,
  createTokenSigner,
  type TokenSigner,
} from "../../src/auth/index.js";
import type { LaunchGrantClaims, SessionCredentialClaims } from "@stackmaster/protocol/server-only";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  TEST_SIGNING_KEY_PEM,
  TEST_TENANT_ID,
  TEST_USER_ID,
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

/** 启动授权凭证六字段(D-LT-5 5a;**无 sessionId / embedSessionId**)。 */
function launchGrantClaims(overrides?: Partial<LaunchGrantClaims>): LaunchGrantClaims {
  return {
    tenantId: TEST_TENANT_ID,
    userId: TEST_USER_ID,
    challengeId: TEST_CHALLENGE_ID,
    challengeVersion: TEST_CHALLENGE_VERSION,
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
  it("启动授权凭证签发后校验返回逐字段一致的六字段 claims", async () => {
    const signer = await createTokenSigner(TEST_SIGNING_KEY_PEM);
    const claims = launchGrantClaims();
    const token = await signer.signLaunchGrant(claims);
    expect(token.length).toBeLessThanOrEqual(SESSION_CREDENTIAL_MAX_LENGTH);
    await expect(signer.verifyLaunchGrant(token)).resolves.toEqual(claims);
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
    const forged = await forger.signLaunchGrant(launchGrantClaims());
    const failure = await verifyFailure(signer.verifyLaunchGrant(forged));
    expect(failure).toBeInstanceOf(CredentialVerificationError);
    expect(failure.kind).toBe("signature_invalid");
  });

  it("载荷篡改确定性拒绝:kind = signature_invalid", async () => {
    const signer = await createTokenSigner(TEST_SIGNING_KEY_PEM);
    const token = await signer.signLaunchGrant(launchGrantClaims());
    const tampered = `${token.slice(0, -4)}AAAA`;
    const failure = await verifyFailure(signer.verifyLaunchGrant(tampered));
    expect(failure).toBeInstanceOf(CredentialVerificationError);
    expect(failure.kind).toBe("signature_invalid");
  });

  it("过期(exp 注入时钟越过)确定性拒绝:kind = expired;未越过则通过", async () => {
    const signer = await createTokenSigner(TEST_SIGNING_KEY_PEM);
    const expiresAt = 1_900_000_000;
    const token = await signer.signLaunchGrant(launchGrantClaims({ expiresAt }));
    const justBefore = new Date((expiresAt - 1) * 1000);
    await expect(signer.verifyLaunchGrant(token, { now: justBefore })).resolves.toBeDefined();
    const justAfter = new Date((expiresAt + 1) * 1000);
    const failure = await verifyFailure(signer.verifyLaunchGrant(token, { now: justAfter }));
    expect(failure).toBeInstanceOf(CredentialVerificationError);
    expect(failure.kind).toBe("expired");
  });

  it("载体形态非法(垃圾 / 截断 / 超长)确定性拒绝:kind = malformed", async () => {
    const signer = await createTokenSigner(TEST_SIGNING_KEY_PEM);
    for (const garbage of ["", "not-a-jwt", "a.b.c"]) {
      const failure = await verifyFailure(signer.verifyLaunchGrant(garbage));
      expect(failure).toBeInstanceOf(CredentialVerificationError);
      expect(failure.kind).toBe("malformed");
    }
    const oversized = `x${"y".repeat(SESSION_CREDENTIAL_MAX_LENGTH)}`;
    const failure = await verifyFailure(signer.verifyLaunchGrant(oversized));
    expect(failure.kind).toBe("malformed");
  });

  it("claims 形态非法(多余字段 / 缺字段 / 字段类型漂移)确定性拒绝:kind = malformed", async () => {
    const signer = await createTokenSigner(TEST_SIGNING_KEY_PEM);
    const key = (await importPKCS8(TEST_SIGNING_KEY_PEM, "EdDSA")) as Awaited<
      ReturnType<typeof importPKCS8>
    >;

    const shapeInjections: ReadonlyArray<Record<string, unknown>> = [
      // 六字段 + 自报身份复述(tenantId 双写为自报形态;strictObject 即拒)。
      { ...launchGrantClaims(), injectedTenantId: "tenant-attacker" },
      // 退役面的字段不再有表达位:embedSessionId 进载荷即 malformed。
      { ...launchGrantClaims(), embedSessionId: "3xK9mQ7pL2vN8wRtY5uB1a" },
      // 缺失字段(无 jti)。
      (() => {
        const withoutJti: Record<string, unknown> = { ...launchGrantClaims() };
        delete withoutJti.jti;
        return withoutJti;
      })(),
      // 字段类型漂移(expiresAt 非整数)。
      { ...launchGrantClaims(), expiresAt: "not-a-number" },
    ];
    for (const payload of shapeInjections) {
      const token = await new SignJWT({ ...payload })
        .setProtectedHeader({ alg: "EdDSA" })
        .setExpirationTime(4_102_444_800)
        .sign(key);
      const failure = await verifyFailure(signer.verifyLaunchGrant(token));
      expect(failure).toBeInstanceOf(CredentialVerificationError);
      expect(failure.kind).toBe("malformed");
    }
  });

  it("非法签发密钥(非 PEM / 非 Ed25519)在装配期即抛错(fail-closed)", async () => {
    await expect(createTokenSigner("definitely-not-a-pem")).rejects.toThrow();
  });
});

/**
 * 题目登记路径测试(内存实现;WP-3,D-API-23)。
 * 哈希与签名校验、fail-closed(无验签公钥 / 验签失败 / 版本冲突)。
 * MinIO 真实桶行为见 minio.integration.test.ts(容器门控)。
 */

import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ChallengeRegistrar,
  MemoryChallengeBundleStore,
  MemoryChallengeRegistry,
  registrationSignatureBasis,
  sha256Hex,
} from "../../src/persistence/index.js";

const PRIVATE_BUNDLE = Buffer.from(JSON.stringify({ seedPolicy: { strategy: "fixed" }, secrets: { flag: "FLAG{reg-test}" } }), "utf8");
const PUBLIC_DESCRIPTOR = Buffer.from(JSON.stringify({ challengeId: "ch-reg", vmProfile: {} }), "utf8");
const PRIVATE_SHA = sha256Hex(PRIVATE_BUNDLE);
const PUBLIC_SHA = sha256Hex(PUBLIC_DESCRIPTOR);

function makeSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey, privateKey };
}

function signInput(
  privateKey: KeyObject,
  input: {
    challengeId: string;
    contentVersion: string;
    vmProfileVersion: string;
  },
): string {
  const basis = registrationSignatureBasis({
    ...input,
    privateBundleSha256: PRIVATE_SHA,
    publicDescriptorSha256: PUBLIC_SHA,
  });
  return cryptoSign(null, Buffer.from(basis, "utf8"), privateKey).toString("base64");
}

describe("ChallengeRegistrar(登记路径最小实现)", () => {
  it("哈希与签名校验通过 → 双包入桶 + 版本行落库(摘要同源)", async () => {
    const signer = makeSigner();
    const bundles = new MemoryChallengeBundleStore();
    const registry = new MemoryChallengeRegistry();
    const registrar = new ChallengeRegistrar({
      bundles,
      registry,
      signingPublicKey: signer.publicKey,
    });
    const input = {
      tenantId: "tenant-a",
      challengeId: "ch-reg",
      contentVersion: "1.0.0",
      vmProfileVersion: "1.0.0",
      privateBundle: PRIVATE_BUNDLE,
      publicDescriptor: PUBLIC_DESCRIPTOR,
      signature: signInput(signer.privateKey, {
        challengeId: "ch-reg",
        contentVersion: "1.0.0",
        vmProfileVersion: "1.0.0",
      }),
    };
    const { version } = await registrar.register(input);
    expect(version.privateBundleSha256).toBe(PRIVATE_SHA);
    expect(version.publicDescriptorSha256).toBe(PUBLIC_SHA);
    expect(version.privateBundleObject).toBe("ch-reg/1.0.0/bundle.json");
    // 包本体可取回且逐字节一致。
    expect(Buffer.from((await bundles.getPrivate("ch-reg", "1.0.0")) ?? []).equals(PRIVATE_BUNDLE)).toBe(true);
    expect(Buffer.from((await bundles.getPublic("ch-reg", "1.0.0")) ?? []).equals(PUBLIC_DESCRIPTOR)).toBe(true);
  });

  it("签名被篡改 → registration_unverifiable(红灯)", async () => {
    const signer = makeSigner();
    const registrar = new ChallengeRegistrar({
      bundles: new MemoryChallengeBundleStore(),
      registry: new MemoryChallengeRegistry(),
      signingPublicKey: signer.publicKey,
    });
    const signature = signInput(signer.privateKey, {
      challengeId: "ch-reg",
      contentVersion: "1.0.0",
      vmProfileVersion: "1.0.0",
    });
    const tampered = Buffer.from(signature, "base64");
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    await expect(
      registrar.register({
        tenantId: "tenant-a",
        challengeId: "ch-reg",
        contentVersion: "1.0.0",
        vmProfileVersion: "1.0.0",
        privateBundle: PRIVATE_BUNDLE,
        publicDescriptor: PUBLIC_DESCRIPTOR,
        signature: tampered.toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "registration_unverifiable" });
  });

  it("包内容被替换 → 摘要漂移导致签名失效(fail-closed)", async () => {
    const signer = makeSigner();
    const registrar = new ChallengeRegistrar({
      bundles: new MemoryChallengeBundleStore(),
      registry: new MemoryChallengeRegistry(),
      signingPublicKey: signer.publicKey,
    });
    const signature = signInput(signer.privateKey, {
      challengeId: "ch-reg",
      contentVersion: "1.0.0",
      vmProfileVersion: "1.0.0",
    });
    await expect(
      registrar.register({
        tenantId: "tenant-a",
        challengeId: "ch-reg",
        contentVersion: "1.0.0",
        vmProfileVersion: "1.0.0",
        privateBundle: Buffer.from('{"seedPolicy":{"strategy":"fixed"},"secrets":{"flag":"FLAG{swapped}"}}'),
        publicDescriptor: PUBLIC_DESCRIPTOR,
        signature,
      }),
    ).rejects.toMatchObject({ code: "registration_unverifiable" });
  });

  it("未配置验签公钥 → 登记一律拒绝(fail-closed)", async () => {
    const registrar = new ChallengeRegistrar({
      bundles: new MemoryChallengeBundleStore(),
      registry: new MemoryChallengeRegistry(),
      signingPublicKey: null,
    });
    await expect(
      registrar.register({
        tenantId: "tenant-a",
        challengeId: "ch-reg",
        contentVersion: "1.0.0",
        vmProfileVersion: "1.0.0",
        privateBundle: PRIVATE_BUNDLE,
        publicDescriptor: PUBLIC_DESCRIPTOR,
        signature: "whatever",
      }),
    ).rejects.toMatchObject({ code: "registration_unverifiable" });
  });

  it("同版本重复登记 → challenge_version_conflict(版本不可变)", async () => {
    const signer = makeSigner();
    const bundles = new MemoryChallengeBundleStore();
    const registry = new MemoryChallengeRegistry();
    const registrar = new ChallengeRegistrar({ bundles, registry, signingPublicKey: signer.publicKey });
    const input = {
      tenantId: "tenant-a",
      challengeId: "ch-reg",
      contentVersion: "1.0.0",
      vmProfileVersion: "1.0.0",
      privateBundle: PRIVATE_BUNDLE,
      publicDescriptor: PUBLIC_DESCRIPTOR,
      signature: signInput(signer.privateKey, {
        challengeId: "ch-reg",
        contentVersion: "1.0.0",
        vmProfileVersion: "1.0.0",
      }),
    };
    await registrar.register(input);
    await expect(registrar.register(input)).rejects.toMatchObject({
      code: "challenge_version_conflict",
    });
  });
});

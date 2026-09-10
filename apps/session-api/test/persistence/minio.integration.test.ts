/**
 * 容器门控集成测试:MinIO 对象存储(private-bundles / public-descriptors 桶)
 * 与题目登记路径端到端(哈希与签名校验 → 双包入桶 → 版本行落 PostgreSQL)。
 */

import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  ChallengeRegistrar,
  MinioChallengeBundleStore,
  PostgresChallengeRegistry,
  createMinioClient,
  createPostgresPool,
  registrationSignatureBasis,
  sha256Hex,
} from "../../src/persistence/index.js";
import { IT_ENABLED, IT_CONFIG, ensureMigrated, uniqueIds } from "./helpers/it.js";

const PRIVATE_BUNDLE = Buffer.from(
  JSON.stringify({ schemaVersion: 1, challengeId: "ch-it-minio", secrets: { flag: "FLAG{it-minio}" } }),
  "utf8",
);
const PUBLIC_DESCRIPTOR = Buffer.from(JSON.stringify({ schemaVersion: 1, vmProfile: {} }), "utf8");

describe.skipIf(!IT_ENABLED)("MinIO 对象存储与题目登记路径(容器门控)", () => {
  const ids = uniqueIds("minio");
  let bundles: MinioChallengeBundleStore;
  let registry: PostgresChallengeRegistry;
  let pool: Pool;

  beforeAll(async () => {
    const client = await createMinioClient({
      endpoint: IT_CONFIG.minioEndpoint,
      port: IT_CONFIG.minioPort,
      accessKey: IT_CONFIG.minioAccessKey,
      secretKey: IT_CONFIG.minioSecretKey,
    });
    bundles = new MinioChallengeBundleStore(client, {
      bucketPrivate: IT_CONFIG.minioBucketPrivate,
      bucketPublic: IT_CONFIG.minioBucketPublic,
    });
    await bundles.ensureBuckets();
    pool = await createPostgresPool(IT_CONFIG.postgresUrl, 3);
    await ensureMigrated(pool);
    registry = new PostgresChallengeRegistry(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("双包入桶往返:私有判题包与公开描述包逐字节一致", async () => {
    const privateName = await bundles.putPrivate("ch-it-minio", ids.sessionId, PRIVATE_BUNDLE);
    const publicName = await bundles.putPublic("ch-it-minio", ids.sessionId, PUBLIC_DESCRIPTOR);
    expect(privateName).toBe(`ch-it-minio/${ids.sessionId}/bundle.json`);
    expect(publicName).toBe(`ch-it-minio/${ids.sessionId}/descriptor.json`);
    expect(Buffer.from((await bundles.getPrivate("ch-it-minio", ids.sessionId)) ?? []).equals(PRIVATE_BUNDLE)).toBe(true);
    expect(Buffer.from((await bundles.getPublic("ch-it-minio", ids.sessionId)) ?? []).equals(PUBLIC_DESCRIPTOR)).toBe(true);
    expect(await bundles.getPrivate("ch-it-minio", "absent-version")).toBeNull();
  });

  it("登记路径端到端:签名校验通过 → 双包落桶 + 版本行(摘要同源)可读回", async () => {
    const challengeId = `ch-reg-${ids.sessionId.slice(-8)}`; // 每次运行唯一(版本不可变,防跨运行残留)
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const registrar = new ChallengeRegistrar({ bundles, registry, signingPublicKey: publicKey });
    const input = {
      tenantId: ids.tenantId,
      challengeId,
      contentVersion: "2.0.0",
      vmProfileVersion: "1.0.0",
      privateBundle: PRIVATE_BUNDLE,
      publicDescriptor: PUBLIC_DESCRIPTOR,
    };
    const basis = registrationSignatureBasis({
      ...input,
      privateBundleSha256: sha256Hex(PRIVATE_BUNDLE),
      publicDescriptorSha256: sha256Hex(PUBLIC_DESCRIPTOR),
    });
    const { version } = await registrar.register({
      ...input,
      signature: cryptoSign(null, Buffer.from(basis, "utf8"), privateKey).toString("base64"),
    });
    expect(version.privateBundleSha256).toBe(sha256Hex(PRIVATE_BUNDLE));
    const readBack = await registry.findChallengeVersion(challengeId, "2.0.0", ids.tenantId);
    expect(readBack?.signerKeyId).toBe("default");
    expect(readBack?.privateBundleObject).toBe(`${challengeId}/2.0.0/bundle.json`);
  });

  it("标识符越界拒绝(对象存储路径注入防线)", async () => {
    await expect(bundles.putPrivate("../escape", "1.0.0", PRIVATE_BUNDLE)).rejects.toMatchObject({
      code: "invalid_identifier",
    });
    await expect(bundles.putPrivate("ok-id", "bad/version", PRIVATE_BUNDLE)).rejects.toMatchObject({
      code: "invalid_identifier",
    });
    await expect(bundles.putPrivate("ok-id", "..%2f..", PRIVATE_BUNDLE)).rejects.toMatchObject({
      code: "invalid_identifier",
    });
    // semver 点号合法(版本策略)。
    await expect(bundles.putPrivate("ok-id", "1.0.0", PRIVATE_BUNDLE)).resolves.toBe("ok-id/1.0.0/bundle.json");
  });
});

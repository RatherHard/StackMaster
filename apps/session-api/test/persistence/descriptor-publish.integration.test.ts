/**
 * 容器门控集成测试:公开描述包下发通道的 PG / MinIO 真实端口路径
 * (阶段五 WP-50,D-API-76)。
 *
 * 覆盖面:PostgresChallengeRegistry.findPublishedChallengeVersion(公开面
 * 跨租户读取:行可达、未登记 null、跨租户数据免疫)+ MinIOChallengeBundleStore
 * getPublic(公开桶逐字节往返)。单测(memory 同构栈)已覆盖路由 / 护栏 /
 * 摘要比对全部分支;本套件证明双实现在真实容器上的同构性。
 *
 * 门控:SESSION_API_IT=1 才运行,缺省跳过(与既有持久化集成测试同纪律)。
 */

import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  MinioChallengeBundleStore,
  PostgresChallengeRegistry,
  createMinioClient,
  createPostgresPool,
} from "../../src/persistence/index.js";
import { IT_CONFIG, IT_ENABLED, ensureMigrated, uniqueIds } from "./helpers/it.js";

const PUBLIC_DESCRIPTOR = Buffer.from(
  JSON.stringify({ schemaVersion: 1, challengeId: "ch-it-descriptor", vmProfile: {} }),
  "utf8",
);

describe.skipIf(!IT_ENABLED)("公开描述包下发通道端口(真实 PG / MinIO;SESSION_API_IT 门控)", () => {
  const ids = uniqueIds("descriptor");
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

  it("公开面版本行读取:跨租户可达(无租户过滤)+ 未登记 null(与 memory 实现同构)", async () => {
    await registry.upsertChallenge({ challengeId: "ch-it-descriptor", tenantId: ids.tenantId });
    await registry.insertChallengeVersion({
      challengeId: "ch-it-descriptor",
      contentVersion: "1.0.0",
      tenantId: ids.tenantId,
      vmProfileVersion: "1.0.0",
      privateBundleSha256: "00",
      publicDescriptorSha256: "00",
      privateBundleObject: "ch-it-descriptor/1.0.0/bundle.json",
      publicDescriptorObject: "ch-it-descriptor/1.0.0/descriptor.json",
      signature: "it-signature",
      signerKeyId: "it-key",
    });

    // 公开面读取:无租户条件,异租户前缀的登记行直接可达。
    const row = await registry.findPublishedChallengeVersion("ch-it-descriptor", "1.0.0");
    expect(row).not.toBeNull();
    expect(row?.tenantId).toBe(ids.tenantId);
    expect(row?.publicDescriptorObject).toBe("ch-it-descriptor/1.0.0/descriptor.json");

    // 未登记版本:确定性 null(路由层翻译为 404 同形)。
    expect(await registry.findPublishedChallengeVersion("ch-it-descriptor", "9.9.9")).toBeNull();
    expect(await registry.findPublishedChallengeVersion("ch-it-absent", "1.0.0")).toBeNull();
  });

  it("公开桶取回:对象逐字节一致 + 缺失 null(与 memory 实现同构)", async () => {
    await bundles.putPublic("ch-it-descriptor", ids.sessionId, PUBLIC_DESCRIPTOR);
    const fetched = await bundles.getPublic("ch-it-descriptor", ids.sessionId);
    expect(fetched).not.toBeNull();
    expect(Buffer.from(fetched!).equals(PUBLIC_DESCRIPTOR)).toBe(true);
    expect(await bundles.getPublic("ch-it-descriptor", "0.0.0-nope")).toBeNull();
  });
});

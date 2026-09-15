/**
 * 扩展题目集登记(浏览器联调面;D-API-23 登记发布链路)。
 *
 * 用途:把 EXT_CHALLENGES 三道题经真实 ChallengeRegistrar 链路(双包规范化
 * JSON 落桶 + Ed25519 验签 + PG 登记)登记进**运行中的联调拓扑**,使
 * plugin-dev 开发壳可以创建会话游玩。与 MVP 题目集的 compose 全拓扑测试
 * (test/compose/mvp-challenge-set.compose.integration.test.ts §一)同一
 * 登记形态;差异:本文件不拉起进程拓扑(依赖服务与 session-api/verifier 由
 * `pnpm --filter @stackmaster/session-api dev:host` 之外的方式自备),只做
 * 直连 PG / MinIO 的登记与登记行核验。
 *
 * 运行(cwd 任意;依赖服务须已 compose:deps:up):
 *   SESSION_API_COMPOSE=1 pnpm --filter @stackmaster/session-api exec \
 *     vitest run test/extended-challenges/register-extended.compose.integration.test.ts
 *
 * 租户纪律:登记租户(EXT_DEV_TENANT_ID,缺省 tenant-dev-0001)必须与后续
 * 签发 embed token 的 E2E_TENANT_ID 一致——题目版本按 (租户, 题目, 版本)
 * 三键定位,token 租户不一致即会话创建失败。
 *
 * 复跑卫生:版本不可变(D-API-23 重复登记确定性拒绝),重跑前清残留登记行
 * 与旧桶对象;题目内容确定性使清后重登记字节与历史登记逐字节相同。
 */
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { canonicalize } from "@stackmaster/protocol";

import { EXT_CHALLENGES, canonicalDigests } from "./corpus.js";
import {
  ChallengeRegistrar,
  MinioChallengeBundleStore,
  PostgresChallengeRegistry,
  createMinioClient,
  createPostgresPool,
  registrationSignatureBasis,
  sha256Hex,
} from "../../src/persistence/index.js";
import { ensureMigrated, IT_CONFIG } from "../persistence/helpers/it.js";

const COMPOSE_ENABLED = process.env["SESSION_API_COMPOSE"] === "1";
const SKIP_REASON = "跳过原因:SESSION_API_COMPOSE != 1(先 compose:deps:up 起依赖服务)";

const DEV_TENANT_ID = process.env["EXT_DEV_TENANT_ID"] ?? "tenant-dev-0001";
const CONTENT_VERSION = "1.0.0";
const VM_PROFILE_VERSION = "1.0.0";

describe.skipIf(!COMPOSE_ENABLED)(`扩展题目集登记(联调租户 ${DEV_TENANT_ID};${SKIP_REASON})`, () => {
  let pool: Pool | null = null;
  let bundles: MinioChallengeBundleStore | null = null;

  beforeAll(async () => {
    pool = await createPostgresPool(IT_CONFIG.postgresUrl, 3);
    await ensureMigrated(pool);
    const registry = new PostgresChallengeRegistry(pool);
    const minio = await createMinioClient({
      endpoint: IT_CONFIG.minioEndpoint,
      port: IT_CONFIG.minioPort,
      accessKey: IT_CONFIG.minioAccessKey,
      secretKey: IT_CONFIG.minioSecretKey,
    });
    bundles = new MinioChallengeBundleStore(minio, {
      bucketPrivate: IT_CONFIG.minioBucketPrivate,
      bucketPublic: IT_CONFIG.minioBucketPublic,
    });
    await bundles.ensureBuckets();

    const challengeIds = EXT_CHALLENGES.map((challenge) => challenge.meta.challengeId);
    await pool.query(`DELETE FROM challenge_versions WHERE challenge_id = ANY($1::text[])`, [challengeIds]);
    // MinioLike 类型面不携带 removeObject(登记路径只需 put/get);清理用底层
    // 客户端的同名方法(真实 minio Client 具备),缺失即豁免(MVP 套件同纪律)。
    const cleanup = minio as unknown as {
      removeObject(bucket: string, objectName: string): Promise<void>;
    };
    for (const challengeId of challengeIds) {
      for (const objectName of [
        `${challengeId}/${CONTENT_VERSION}/bundle.json`,
        `${challengeId}/${CONTENT_VERSION}/descriptor.json`,
      ]) {
        await cleanup.removeObject(IT_CONFIG.minioBucketPrivate, objectName).catch(() => undefined);
        await cleanup.removeObject(IT_CONFIG.minioBucketPublic, objectName).catch(() => undefined);
      }
    }
    for (const challenge of EXT_CHALLENGES) {
      const pair = challenge.buildPair();
      const digests = canonicalDigests(pair);
      const privateBundle = Buffer.from(canonicalize(pair.privateBundle), "utf8");
      const publicDescriptor = Buffer.from(canonicalize(pair.publicDescriptor), "utf8");
      // 摘要自证:登记哈希 = 落桶字节的 SHA-256(规范化 JSON 即所存字节)。
      expect(sha256Hex(privateBundle)).toBe(digests.privateBundleSha256);
      expect(sha256Hex(publicDescriptor)).toBe(digests.publicDescriptorSha256);
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const signature = cryptoSign(
        null,
        Buffer.from(
          registrationSignatureBasis({
            challengeId: challenge.meta.challengeId,
            contentVersion: CONTENT_VERSION,
            vmProfileVersion: VM_PROFILE_VERSION,
            privateBundleSha256: digests.privateBundleSha256,
            publicDescriptorSha256: digests.publicDescriptorSha256,
          }),
          "utf8",
        ),
        privateKey,
      ).toString("base64");
      await new ChallengeRegistrar({ bundles, registry, signingPublicKey: publicKey }).register({
        tenantId: DEV_TENANT_ID,
        challengeId: challenge.meta.challengeId,
        contentVersion: CONTENT_VERSION,
        vmProfileVersion: VM_PROFILE_VERSION,
        privateBundle,
        publicDescriptor,
        signature,
      });
    }
  }, 120_000);

  afterAll(async () => {
    if (pool !== null) {
      await pool.end().catch(() => undefined);
    }
  }, 30_000);

  it("三道题登记行可查且哈希与构造摘要一致", async () => {
    const registered = await pool!.query<{
      challenge_id: string;
      private_bundle_sha256: string;
      public_descriptor_sha256: string;
    }>(
      `SELECT challenge_id, private_bundle_sha256, public_descriptor_sha256
       FROM challenge_versions WHERE tenant_id = $1 AND content_version = $2`,
      [DEV_TENANT_ID, CONTENT_VERSION],
    );
    expect(registered.rows).toHaveLength(EXT_CHALLENGES.length);
    for (const challenge of EXT_CHALLENGES) {
      const row = registered.rows.find((entry) => entry.challenge_id === challenge.meta.challengeId);
      expect(row, `${challenge.meta.challengeId} 登记行缺失`).toBeDefined();
      const digests = canonicalDigests(challenge.buildPair());
      expect(row!.private_bundle_sha256).toBe(digests.privateBundleSha256);
      expect(row!.public_descriptor_sha256).toBe(digests.publicDescriptorSha256);
    }
  });
});

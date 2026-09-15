/**
 * 我的题目登记(联调拓扑;T5 配套。与 extended-challenges/register-extended 同构,单题版)。
 *
 * 运行(依赖容器须已 compose:deps:up;拓扑见 extended-challenges/README.md):
 *   SESSION_API_COMPOSE=1 pnpm --filter @stackmaster/session-api exec vitest run test/my-challenges/register-my-challenge.compose.integration.test.ts
 *
 * 登记链路:规范化 JSON 落桶 → 摘要自证 → Ed25519 签名验签 → PG 建档(版本不可变,
 * 重跑前清理旧行/旧对象)。登记租户必须与后续 embed token 的租户一致。
 */
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { canonicalize } from "@stackmaster/protocol";

import { MY_CHALLENGE, canonicalDigests } from "./corpus.js";
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

describe.skipIf(!COMPOSE_ENABLED)(`我的题目登记(联调租户 ${DEV_TENANT_ID};${SKIP_REASON})`, () => {
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

    const challengeId = MY_CHALLENGE.meta.challengeId;
    await pool.query(`DELETE FROM challenge_versions WHERE challenge_id = ANY($1::text[])`, [[challengeId]]);
    const cleanup = minio as unknown as {
      removeObject(bucket: string, objectName: string): Promise<void>;
    };
    for (const objectName of [
      `${challengeId}/${CONTENT_VERSION}/bundle.json`,
      `${challengeId}/${CONTENT_VERSION}/descriptor.json`,
    ]) {
      await cleanup.removeObject(IT_CONFIG.minioBucketPrivate, objectName).catch(() => undefined);
      await cleanup.removeObject(IT_CONFIG.minioBucketPublic, objectName).catch(() => undefined);
    }

    const pair = MY_CHALLENGE.buildPair();
    const digests = canonicalDigests(pair);
    const privateBundle = Buffer.from(canonicalize(pair.privateBundle), "utf8");
    const publicDescriptor = Buffer.from(canonicalize(pair.publicDescriptor), "utf8");
    expect(sha256Hex(privateBundle)).toBe(digests.privateBundleSha256);
    expect(sha256Hex(publicDescriptor)).toBe(digests.publicDescriptorSha256);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signature = cryptoSign(
      null,
      Buffer.from(
        registrationSignatureBasis({
          challengeId,
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
      challengeId,
      contentVersion: CONTENT_VERSION,
      vmProfileVersion: VM_PROFILE_VERSION,
      privateBundle,
      publicDescriptor,
      signature,
    });
  }, 120_000);

  afterAll(async () => {
    if (pool !== null) await pool.end().catch(() => undefined);
  }, 30_000);

  it("登记行可查且哈希与构造摘要一致", async () => {
    const registered = await pool!.query<{ challenge_id: string }>(
      `SELECT challenge_id FROM challenge_versions WHERE tenant_id = $1 AND content_version = $2`,
      [DEV_TENANT_ID, CONTENT_VERSION],
    );
    expect(registered.rows.map((row) => row.challenge_id)).toContain(MY_CHALLENGE.meta.challengeId);
  });
});

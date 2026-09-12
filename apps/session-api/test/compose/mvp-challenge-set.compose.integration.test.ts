/**
 * MVP 题目集 compose 全拓扑集成(WP-68;D-API-23 登记发布链路 + 裁决闭环
 * 生产形态演示)。
 *
 * 拓扑与门控沿既有 compose 套件先例(test/compose/helpers/topology.ts;
 * container = CI 完整 linux 拓扑 / host = 本机降级形态,语义一致):
 *   ① **登记全集**:8 道题目经 ChallengeRegistrar(双包哈希 + Ed25519
 *      签发验签 + PG 登记 + MinIO 双桶落桶)真实登记——题目集发布面
 *      (D-API-107);
 *   ② **公开描述包下发**:GET /descriptors/:challengeId/:version 200 +
 *      登记摘要逐字节一致(既有描述包路由消费题目集公开面);
 *   ③ **裁决闭环生产形态(至少一组)**:CH-07 参考解(会话 → WSS 动作 →
 *      submit → verifier 独立重放 → verdicts = **success**,题目集前生产
 *      链路的裁决只产出过 wrong_answer)与 CH-04 crash 语料(program_crash)
 *      经 GET /verdicts 呈现契约逐字段核验。
 *
 * 机检:全部 HTTP 响应体 + WSS 入站帧经 scanCrossDomainPayloads 零命中。
 */
import { generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WssFrame } from "@stackmaster/protocol";
import { canonicalize } from "@stackmaster/protocol";

import { MVP_CHALLENGES, canonicalDigests } from "../mvp-challenges/corpus.js";
import { SESSION_CREDENTIAL_COOKIE_NAME } from "../../src/auth/cookie.js";
import {
  ChallengeRegistrar,
  MinioChallengeBundleStore,
  PostgresChallengeRegistry,
  createMinioClient,
  createPostgresPool,
  registrationSignatureBasis,
  sha256Hex,
} from "../../src/persistence/index.js";
import {
  scanCrossDomainPayloads,
  formatCrossDomainHits,
} from "../../src/scan/cross-domain-payload-scanner.js";
import { WssChannelClient } from "./helpers/ws-client.js";
import {
  BASE_HOST,
  BASE_PORT,
  BASE_URL,
  COMPOSE_ENABLED,
  HOST_BACKEND_TOKEN,
  IT_CONFIG,
  SKIP_REASON,
  TOPOLOGY,
  TrafficRecorder,
  HostProcess,
  VerifierProcess,
  credentialFromSetCookie,
  postJson,
} from "./helpers/topology.js";

/** 题目集内按 challengeId 取语料条目。 */
function corpusOf(challengeId: string, name: string) {
  const challenge = MVP_CHALLENGES.find((entry) => entry.meta.challengeId === challengeId);
  if (challenge === undefined) {
    throw new Error(`题目 ${challengeId} 不在题目集内`);
  }
  const entry = challenge.corpora.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    throw new Error(`语料 ${name} 不在 ${challengeId} 内`);
  }
  return { challenge, entry };
}

describe.skipIf(!COMPOSE_ENABLED)(
  `MVP 题目集 compose 全拓扑(${TOPOLOGY} 形态;${SKIP_REASON})`,
  () => {
    const runSuffix = Math.random().toString(16).slice(2, 10);
    const tenantId = `mvp-set-${runSuffix}`;
    const userId = "user-mvp-set";
    const embedSessionId = () => randomBytes(16).toString("base64url");

    const recorder = new TrafficRecorder();
    const host = new HostProcess();
    const verifier = new VerifierProcess();
    const clients: WssChannelClient[] = [];
    let pool: Pool | null = null;
    let bundles: MinioChallengeBundleStore | null = null;

    async function connectChannel(cookie: string): Promise<WssChannelClient> {
      const client = await WssChannelClient.connect({
        url: `ws://${BASE_HOST}:${BASE_PORT}/sessions/channel`,
        cookie: `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookie}`,
      });
      clients.push(client);
      return client;
    }

    async function createSession(challengeId: string, contentVersion: string): Promise<{
      sessionId: string;
      cookie: string;
    }> {
      const embedSessionIdValue = embedSessionId();
      const embed = await postJson(recorder, "/auth/embed-tokens", {
        tenantId,
        userId,
        challengeId,
        challengeVersion: contentVersion,
        embedSessionId: embedSessionIdValue,
      }, { bearer: HOST_BACKEND_TOKEN });
      expect(embed.status).toBe(201);
      const embedToken = (embed.body as { embedToken: string }).embedToken;
      const created = await postJson(recorder, "/sessions", {
        command: "create_session",
        protocolVersion: 1,
        payload: { challengeId, challengeVersion: contentVersion, embedSessionId: embedSessionIdValue, embedToken },
      });
      expect(created.status).toBe(201);
      return {
        sessionId: (created.body as { payload: { sessionId: string } }).payload.sessionId,
        cookie: credentialFromSetCookie(created.setCookie),
      };
    }

    async function runScript(
      sessionId: string,
      cookie: string,
      actions: readonly { readonly type: string; readonly args: Record<string, unknown> }[],
    ): Promise<void> {
      const client = await connectChannel(cookie);
      let seq = 0;
      for (const action of actions) {
        seq += 1;
        client.sendText(JSON.stringify({
          protocolVersion: 1,
          type: "action",
          sessionId,
          seq,
          payload: {
            protocolVersion: 1,
            sessionId,
            clientSeq: seq,
            baseRevision: seq - 1,
            idempotencyKey: `mvp-${runSuffix}-${seq}-${Math.random().toString(16).slice(2, 6)}`,
            action,
          },
        }));
        await client.waitFor((messages) => messages.length >= seq);
        const frame = JSON.parse(client.messages[seq - 1]!) as WssFrame;
        expect(frame.type).toBe("action_response");
      }
      client.close();
    }

    async function submitFor(sessionId: string, cookie: string): Promise<string> {
      const submitted = await postJson(recorder, "/sessions/submissions", {
        command: "submit",
        protocolVersion: 1,
        payload: { sessionId },
      }, { cookie: `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookie}` });
      expect(submitted.status).toBe(200);
      return (submitted.body as { payload: { submissionId: string } }).payload.submissionId;
    }

    async function pollVerdict(submissionId: string, cookie: string, timeoutMs: number): Promise<{
      status: string;
      bodyText: string;
      body: Record<string, unknown>;
    } | null> {
      const deadline = Date.now() + timeoutMs;
      let attempts = 0;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        const response = await fetch(`${BASE_URL}/verdicts/${submissionId}`, {
          headers: { cookie: `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookie}` },
        });
        const bodyText = await response.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(bodyText) as unknown;
        } catch {
          parsed = bodyText;
        }
        recorder.recordHttp(parsed);
        if (response.status === 429) {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          continue;
        }
        expect(response.status).toBe(200);
        const body = parsed as Record<string, unknown>;
        if (body["status"] === "verdicted") {
          return { status: "verdicted", bodyText, body };
        }
        expect(body).toEqual({ submissionId, revision: expect.any(Number), status: "pending" });
        attempts += 1;
      }
      expect(attempts, "裁决轮询超时").toBeGreaterThanOrEqual(0);
      return null;
    }

    beforeAll(async () => {
      await host.start();

      pool = await createPostgresPool(IT_CONFIG.postgresUrl, 3);
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

      // ── 登记全集:8 道题目经真实 D-API-23 链路(哈希 + Ed25519 验签)──
      // 登记版本不可变(D-API-23:重复登记确定性拒绝),而题目集 ID 固定、
      // 内容确定性(同输入逐字节同源):重跑前清残留行与旧对象,清后重登记
      // 的字节与历史登记逐字节相同(幂等语义由内容确定性承载,测试库卫生面)。
      const challengeIds = MVP_CHALLENGES.map((challenge) => challenge.meta.challengeId);
      await pool!.query(`DELETE FROM challenge_versions WHERE challenge_id = ANY($1::text[])`, [challengeIds]);
      // MinioLike 类型面不携带 removeObject(登记路径只需 put/get);清理用
      // 底层客户端的同名方法(真实 minio Client 具备),缺失即豁免。
      const cleanup = minio as unknown as {
        removeObject(bucket: string, objectName: string): Promise<void>;
      };
      for (const challengeId of challengeIds) {
        for (const objectName of [
          `${challengeId}/1.0.0/bundle.json`,
          `${challengeId}/1.0.0/descriptor.json`,
        ]) {
          await cleanup.removeObject(IT_CONFIG.minioBucketPrivate, objectName).catch(() => undefined);
          await cleanup.removeObject(IT_CONFIG.minioBucketPublic, objectName).catch(() => undefined);
        }
      }
      for (const challenge of MVP_CHALLENGES) {
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
              contentVersion: "1.0.0",
              vmProfileVersion: "1.0.0",
              privateBundleSha256: digests.privateBundleSha256,
              publicDescriptorSha256: digests.publicDescriptorSha256,
            }),
            "utf8",
          ),
          privateKey,
        ).toString("base64");
        await new ChallengeRegistrar({ bundles, registry, signingPublicKey: publicKey }).register({
          tenantId,
          challengeId: challenge.meta.challengeId,
          contentVersion: "1.0.0",
          vmProfileVersion: "1.0.0",
          privateBundle,
          publicDescriptor,
          signature,
        });
      }
    }, 120_000);

    afterAll(async () => {
      for (const client of clients.splice(0)) {
        client.close();
      }
      await host.stop();
      if (pool !== null) {
        await pool.end().catch(() => undefined);
      }
    }, 30_000);

    it("拓扑就绪:liveness 与 readiness 探针全绿", async () => {
      expect((await fetch(`${BASE_URL}/healthz`)).status).toBe(200);
      expect((await fetch(`${BASE_URL}/readyz`)).status).toBe(200);
    });

    it("题目集登记全集:8 道题目注册行可查且哈希与构造摘要一致", async () => {
      const registered = await pool!.query<{ challenge_id: string; private_bundle_sha256: string; public_descriptor_sha256: string }>(
        `SELECT challenge_id, private_bundle_sha256, public_descriptor_sha256
         FROM challenge_versions WHERE tenant_id = $1 AND content_version = '1.0.0'`,
        [tenantId],
      );
      expect(registered.rows).toHaveLength(MVP_CHALLENGES.length);
      for (const challenge of MVP_CHALLENGES) {
        const row = registered.rows.find((entry) => entry.challenge_id === challenge.meta.challengeId);
        expect(row, `${challenge.meta.challengeId} 登记行缺失`).toBeDefined();
        const digests = canonicalDigests(challenge.buildPair());
        expect(row!.private_bundle_sha256).toBe(digests.privateBundleSha256);
        expect(row!.public_descriptor_sha256).toBe(digests.publicDescriptorSha256);
      }
    });

    it("公开描述包下发:GET /descriptors 携登记摘要与公开面字段", async () => {
      const digests = canonicalDigests(MVP_CHALLENGES[4]!.buildPair());
      const response = await fetch(`${BASE_URL}/descriptors/sm-ch05-canary-guard/1.0.0`);
      const bodyText = await response.text();
      recorder.recordHttp(JSON.parse(bodyText));
      expect(response.status).toBe(200);
      expect(sha256Hex(Buffer.from(bodyText, "utf8"))).toBe(digests.publicDescriptorSha256);
      const descriptor = JSON.parse(bodyText) as { briefing: { title: string }; locale: string };
      expect(descriptor.locale).toBe("zh-CN");
      expect(descriptor.briefing.title).toBe("金丝雀哨兵:守护标记与精准绕过");
    });

    it("CH-07 参考解全链路:会话 → 动作 → submit → verdicts = success(生产裁决闭环)", async () => {
      const { challenge, entry } = corpusOf(
        "sm-ch07-hidden-vault",
        "ret hijack into win gadget reads vault file",
      );
      const { sessionId, cookie } = await createSession(challenge.meta.challengeId, "1.0.0");
      await runScript(sessionId, cookie, entry.actions);
      const submissionId = await submitFor(sessionId, cookie);

      await verifier.start();
      const final = await pollVerdict(submissionId, cookie, 120_000);
      expect(final).not.toBeNull();
      expect(final!.body["verdict"]).toBe(entry.expectedVerdict);
      expect(entry.expectedVerdict).toBe("success");
      // 五字段呈现契约(D-API-83)。
      expect(Object.keys(final!.body).sort()).toEqual(
        ["decidedAt", "revision", "status", "submissionId", "verdict"],
      );
      // 裁决载荷机检(呈现响应面零命中)。
      const hits = scanCrossDomainPayloads([final!.body]);
      expect(hits, `裁决载荷机检命中:\n${formatCrossDomainHits(hits).join("\n")}`).toEqual([]);
    }, 180_000);

    it("CH-04 crash 语料全链路:verdicts = program_crash(失败方向裁决)", async () => {
      const { challenge, entry } = corpusOf(
        "sm-ch04-buffer-overflow",
        "data address as index crashes on program return",
      );
      const { sessionId, cookie } = await createSession(challenge.meta.challengeId, "1.0.0");
      await runScript(sessionId, cookie, entry.actions);
      const submissionId = await submitFor(sessionId, cookie);

      const final = await pollVerdict(submissionId, cookie, 120_000);
      expect(final).not.toBeNull();
      expect(final!.body["verdict"]).toBe("program_crash");
      expect(final!.body["status"]).toBe("verdicted");
    }, 180_000);

    it("跨域载荷机检:全捕获(HTTP 响应体 + WSS 帧)扫描零命中", () => {
      const hits = scanCrossDomainPayloads([...recorder.wssFrames, ...recorder.httpBodies]);
      expect(hits, `跨域载荷机检命中:\n${formatCrossDomainHits(hits).join("\n")}`).toEqual([]);
    });
  },
);

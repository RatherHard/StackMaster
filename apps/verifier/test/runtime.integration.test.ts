/**
 * 运行时装配集成测试(WP-61;容器门控,SESSION_API_IT=1)。
 *
 * 承载面:buildVerifierRuntime 全装配(真实 PostgreSQL 连接池 + 真实 MinIO
 * 只读客户端 + 注入的假 verify worker)+ 裁决闭环端到端(进程内形态):
 * 登记 → 双包入桶 → submission + pending run 落库 → 消费循环认领 →
 * 裁决 → verdicts 落库 → closeHandles 优雅收口。单元矩阵用内存端口表达
 * 语义;本套件证明装配产物在真实存储上驱动同一条管线。
 */
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Logger } from "pino";
import { Client as MinioClient } from "minio";

import { buildVerifierRuntime, type VerifierRuntime } from "../src/runtime.js";
import { sha256Hex, validReference } from "./helpers/memory-ports.js";
import {
  IT_CONFIG,
  IT_ENABLED,
  ensureMigrated,
  insertRun,
  insertSubmission,
  purgeSubmissions,
  registerChallengeVersion,
} from "./helpers/it.js";

const FAKE_WORKER = fileURLToPath(new URL("./helpers/fake-verify-worker.mjs", import.meta.url));

const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

describe.skipIf(!IT_ENABLED)("buildVerifierRuntime 全装配与裁决闭环(容器门控)", () => {
  const BUNDLE_JSON = '{"vmEngineVersion":"0.1.0","engineBuildId":"dev"}';
  const DESCRIPTOR_JSON = '{"schemaVersion":1,"vmProfile":{}}';
  const CHALLENGE_ID = "chal-runtime-it";
  // 假 worker report 摘要与引用随行日志同源(引擎 / TS 双侧 digest 一致性路径)。
  const REFERENCE = validReference({ challengeId: CHALLENGE_ID });
  const ACTION_LOG_DIGEST = sha256Hex(
    (REFERENCE.replay as { actionLog: string }).actionLog,
  );
  let runtime: VerifierRuntime;
  let admin: MinioClient;
  let tenantId: string;
  let sessionId: string;
  let port = 0;

  beforeAll(async () => {
    admin = new MinioClient({
      endPoint: IT_CONFIG.minioEndpoint,
      port: IT_CONFIG.minioPort,
      useSSL: false,
      accessKey: IT_CONFIG.minioAccessKey,
      secretKey: IT_CONFIG.minioSecretKey,
    });
    if (!(await admin.bucketExists(IT_CONFIG.minioBucketPrivate))) {
      await admin.makeBucket(IT_CONFIG.minioBucketPrivate);
    }
    if (!(await admin.bucketExists(IT_CONFIG.minioBucketPublic))) {
      await admin.makeBucket(IT_CONFIG.minioBucketPublic);
    }
    // 双包各归其桶(生产布局):私有判题包 → private-bundles,公开描述包 →
    // public-descriptors(登记行对象名语义,001 迁移)。
    await admin.putObject(
      IT_CONFIG.minioBucketPrivate,
      `${CHALLENGE_ID}/1.0.0/bundle.json`,
      Buffer.from(BUNDLE_JSON, "utf8"),
      Buffer.byteLength(BUNDLE_JSON),
    );
    await admin.putObject(
      IT_CONFIG.minioBucketPublic,
      `${CHALLENGE_ID}/1.0.0/descriptor.json`,
      Buffer.from(DESCRIPTOR_JSON, "utf8"),
      Buffer.byteLength(DESCRIPTOR_JSON),
    );

    runtime = await buildVerifierRuntime(
      {
        nodeEnv: "test",
        host: "127.0.0.1",
        port: 0,
        logLevel: "info",
        logErrorStacks: false,
        gracefulShutdownTimeoutSeconds: 5,
        postgresUrl: IT_CONFIG.postgresUrl,
        minioEndpoint: IT_CONFIG.minioEndpoint,
        minioPort: IT_CONFIG.minioPort,
        minioAccessKey: IT_CONFIG.minioAccessKey,
        minioSecretKey: IT_CONFIG.minioSecretKey,
        minioBucketPrivate: IT_CONFIG.minioBucketPrivate,
        minioBucketPublic: IT_CONFIG.minioBucketPublic,
        pollIntervalMs: 50,
        claimBatchSize: 4,
        maxRunAttempts: 3,
        maxActionLogBytes: 1_048_576,
        verifyTimeoutMs: 10_000,
      },
      logger,
      {
        workerSpec: {
          command: process.execPath,
          args: [FAKE_WORKER],
          env: [["FAKE_LOG_DIGEST", ACTION_LOG_DIGEST]],
        },
      },
    );
    port = await runtime.startServer();
  });

  afterAll(async () => {
    await purgeSubmissions(runtime.pool, tenantId);
    await admin.removeObject(
      IT_CONFIG.minioBucketPrivate,
      `${CHALLENGE_ID}/1.0.0/bundle.json`,
    );
    await admin.removeObject(
      IT_CONFIG.minioBucketPublic,
      `${CHALLENGE_ID}/1.0.0/descriptor.json`,
    );
    // closeHandles 收口(停循环 → 关运维面 → 关连接池;顺序即装配逆序)。
    for (const handle of runtime.closeHandles) {
      await handle.run();
    }
  });

  it("运维面:临时端口监听;healthz 200;readyz 真实探针(PG + MinIO)200", async () => {
    expect(port).toBeGreaterThan(0);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(ready.status).toBe(200);
  });

  it("裁决闭环:登记 → 入桶 → pending run → 消费循环 → verdicts 落库(真实存储)", async () => {
    const suffix = Date.now().toString(36);
    tenantId = `it-runtime-${suffix}`;
    sessionId = `sess-runtime-${suffix}`;
    await ensureMigrated(runtime.pool);
    await registerChallengeVersion(runtime.pool, {
      tenantId,
      challengeId: CHALLENGE_ID,
      contentVersion: "1.0.0",
      privateBundleSha256: sha256Hex(BUNDLE_JSON),
      publicDescriptorSha256: sha256Hex(DESCRIPTOR_JSON),
      privateBundleObject: `${CHALLENGE_ID}/1.0.0/bundle.json`,
      publicDescriptorObject: `${CHALLENGE_ID}/1.0.0/descriptor.json`,
    });
    const reference = REFERENCE;
    const submissionId = await insertSubmission(runtime.pool, {
      tenantId,
      sessionId,
      reference,
    });
    await insertRun(runtime.pool, {
      tenantId,
      submissionId,
      logDigest: sha256Hex((reference.replay as { actionLog: string }).actionLog),
    });

    const running = runtime.loop.run();
    let verdict: string | undefined;
    for (let i = 0; i < 200 && verdict === undefined; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const rows = await runtime.pool.query<{ verdict: string }>(
        `SELECT verdict FROM verdicts WHERE submission_id = $1`,
        [submissionId],
      );
      verdict = rows.rows[0]?.["verdict"];
    }
    runtime.loop.stop();
    await running;

    expect(verdict).toBe("success");
    const runs = await runtime.pool.query<{ status: string }>(
      `SELECT status FROM verifier_runs WHERE submission_id = $1`,
      [submissionId],
    );
    expect(runs.rows[0]?.["status"]).toBe("completed");
  });

  it("跨部署同日志同判(WP-67 裁决可复现):双 verifier 实例并发消费孪生提交行,裁决与明细逐字面一致", async () => {
    // 跨部署形态 = 第二个独立 buildVerifierRuntime 装配(独立 PG 连接池 +
    // 独立 MinIO 客户端 + 独立消费循环与 worker spawn——同镜像同锁,两份
    // 服务实例)。孪生提交行 = 同 reference 同 log_digest(同规范化动作日志);
    // 两实例并发认领(SKIP LOCKED 分单),裁决结论与 verdicts.detail 逐字面
    // 一致 = 同日志同裁决跨部署(阶段六退出条件 2 的多实例形态)。
    // 孪生语料先行声明(worker spawn 环境与提交行共用同一 digest)。
    // 独立题目版本(challenge_versions 主键 = (challenge_id, content_version)
    // 全局唯一,复用 CHALLENGE_ID 会撞已登记行):同字节双包换题目标识,
    // 引用随行携带 twin 题目标识,对象按 twin 题目名落桶,finally 收尾移除。
    const TWIN_CHALLENGE_ID = "chal-runtime-it-twin";
    const reference = validReference({ challengeId: TWIN_CHALLENGE_ID });
    const twinDigest = sha256Hex((reference.replay as { actionLog: string }).actionLog);
    const second = await buildVerifierRuntime(
      {
        nodeEnv: "test",
        host: "127.0.0.1",
        port: 0,
        logLevel: "info",
        logErrorStacks: false,
        gracefulShutdownTimeoutSeconds: 5,
        postgresUrl: IT_CONFIG.postgresUrl,
        minioEndpoint: IT_CONFIG.minioEndpoint,
        minioPort: IT_CONFIG.minioPort,
        minioAccessKey: IT_CONFIG.minioAccessKey,
        minioSecretKey: IT_CONFIG.minioSecretKey,
        minioBucketPrivate: IT_CONFIG.minioBucketPrivate,
        minioBucketPublic: IT_CONFIG.minioBucketPublic,
        pollIntervalMs: 50,
        claimBatchSize: 4,
        maxRunAttempts: 3,
        maxActionLogBytes: 1_048_576,
        verifyTimeoutMs: 10_000,
      },
      logger,
      {
        workerSpec: {
          command: process.execPath,
          args: [FAKE_WORKER],
          env: [["FAKE_LOG_DIGEST", twinDigest]],
        },
      },
    );
    const twinTenant = `it-twin-${Date.now().toString(36)}`;
    try {
      await admin.putObject(
        IT_CONFIG.minioBucketPrivate,
        `${TWIN_CHALLENGE_ID}/1.0.0/bundle.json`,
        Buffer.from(BUNDLE_JSON, "utf8"),
        Buffer.byteLength(BUNDLE_JSON),
      );
      await admin.putObject(
        IT_CONFIG.minioBucketPublic,
        `${TWIN_CHALLENGE_ID}/1.0.0/descriptor.json`,
        Buffer.from(DESCRIPTOR_JSON, "utf8"),
        Buffer.byteLength(DESCRIPTOR_JSON),
      );
      await ensureMigrated(second.pool);
      await registerChallengeVersion(second.pool, {
        tenantId: twinTenant,
        challengeId: TWIN_CHALLENGE_ID,
        contentVersion: "1.0.0",
        privateBundleSha256: sha256Hex(BUNDLE_JSON),
        publicDescriptorSha256: sha256Hex(DESCRIPTOR_JSON),
        privateBundleObject: `${TWIN_CHALLENGE_ID}/1.0.0/bundle.json`,
        publicDescriptorObject: `${TWIN_CHALLENGE_ID}/1.0.0/descriptor.json`,
      });
      const digest = twinDigest;
      const twins: string[] = [];
      for (let index = 0; index < 2; index += 1) {
        const id = await insertSubmission(second.pool, {
          tenantId: twinTenant,
          sessionId: `sess-twin-${index}`,
          reference,
        });
        await insertRun(second.pool, { tenantId: twinTenant, submissionId: id, logDigest: digest });
        twins.push(id);
      }

      // 双实例并发消费(runtime = 部署 A,second = 部署 B)。
      const loops = [runtime.loop.run(), second.loop.run()];
      const verdicts = new Map<string, { verdict: string; detail: unknown }>();
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && verdicts.size < twins.length) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const rows = await second.pool.query<{ submission_id: string; verdict: string; detail: unknown }>(
          `SELECT v.submission_id, v.verdict, v.detail FROM verdicts v
           WHERE v.submission_id = ANY($1::uuid[])`,
          [twins],
        );
        for (const row of rows.rows) {
          verdicts.set(row.submission_id, { verdict: row.verdict, detail: row.detail });
        }
      }
      runtime.loop.stop();
      second.loop.stop();
      await Promise.all(loops);

      expect(verdicts.size).toBe(twins.length);
      const [alpha, beta] = twins.map((id) => verdicts.get(id));
      expect(alpha?.verdict).toBe("success");
      expect(beta?.verdict).toBe(alpha?.verdict);
      // 明细逐字面一致(裁决可复现的强形态:detail = {replay, logDigest,
      // hiddenTests} 整体序列化比对,非子集断言)。
      expect(JSON.stringify(beta?.detail)).toBe(JSON.stringify(alpha?.detail));
      // 两行各被恰一实例认领(无重复裁决、无丢裁决;每 run 单一 completed)。
      const runs = await second.pool.query<{ submission_id: string; status: string }>(
        `SELECT submission_id, status FROM verifier_runs WHERE submission_id = ANY($1::uuid[])`,
        [twins],
      );
      expect(runs.rows.map((row) => row.status)).toEqual(["completed", "completed"]);
    } finally {
      await purgeSubmissions(second.pool, twinTenant);
      await admin.removeObject(
        IT_CONFIG.minioBucketPrivate,
        `${TWIN_CHALLENGE_ID}/1.0.0/bundle.json`,
      );
      await admin.removeObject(
        IT_CONFIG.minioBucketPublic,
        `${TWIN_CHALLENGE_ID}/1.0.0/descriptor.json`,
      );
      for (const handle of second.closeHandles) {
        await handle.run();
      }
    }
  });

  it("生产 worker 解析路径:未注入 workerSpec 时经 STACKMASTER_WORKER_BIN 解析(env 优先)", async () => {
    const previous = process.env["STACKMASTER_WORKER_BIN"];
    process.env["STACKMASTER_WORKER_BIN"] = FAKE_WORKER;
    let assembled: VerifierRuntime | null = null;
    try {
      assembled = await buildVerifierRuntime(
        {
          nodeEnv: "test",
          host: "127.0.0.1",
          port: 0,
          logLevel: "info",
          logErrorStacks: false,
          gracefulShutdownTimeoutSeconds: 5,
          postgresUrl: IT_CONFIG.postgresUrl,
          minioEndpoint: IT_CONFIG.minioEndpoint,
          minioPort: IT_CONFIG.minioPort,
          minioAccessKey: IT_CONFIG.minioAccessKey,
          minioSecretKey: IT_CONFIG.minioSecretKey,
          minioBucketPrivate: IT_CONFIG.minioBucketPrivate,
          minioBucketPublic: IT_CONFIG.minioBucketPublic,
          pollIntervalMs: 50,
          claimBatchSize: 4,
          maxRunAttempts: 3,
          maxActionLogBytes: 1_048_576,
          verifyTimeoutMs: 10_000,
        },
        logger,
      );
      expect(assembled.loop).toBeDefined();
    } finally {
      delete process.env["STACKMASTER_WORKER_BIN"];
      if (previous !== undefined) {
        process.env["STACKMASTER_WORKER_BIN"] = previous;
      }
      if (assembled !== null) {
        for (const handle of assembled.closeHandles) {
          await handle.run();
        }
      }
    }
  });
});

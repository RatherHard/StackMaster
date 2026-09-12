/**
 * verifier 裁决域持久化集成测试(WP-61;容器门控,SESSION_API_IT=1)。
 *
 * 承载面:PostgresVerdictQueue / PostgresChallengeSource / MinIO 只读源——
 * 单元矩阵(内存端口)之外的 SQL 语义与对象存储真实路径:
 *  - 认领:SKIP LOCKED 行锁推进 running;已有 verdicts 的 submission 不再认领;
 *  - 完成:verdicts `submission_id` 唯一幂等(ON CONFLICT DO NOTHING);
 *  - 失败:重试以新 pending run 行承载;耗尽后残留 pending 行收口;
 *  - 题目登记:租户作用域查询(跨租户与未登记同形 null,D-API-20 延伸);
 *  - MinIO:getPrivate 往返 / 缺失 null / readiness 探针(NotFound = 健康)。
 *
 * WP-62 增补:审计发射同事务面(verdict_completed / verdict_replay_failed
 * 行落库、审计 append 失败整体回滚的 fail-closed 红灯;audit_log 行为
 * append-only 账,测试数据按套件唯一租户隔离、不清理)。
 */
import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Client as MinioClient } from "minio";

import {
  PostgresChallengeSource,
  PostgresVerdictQueue,
  createPostgresPool,
  VerifierStoreError,
} from "../src/persistence/pg-stores.js";
import {
  MinioRegisteredBundleSource,
  createMinioReadonlyClient,
} from "../src/persistence/minio-bundle-source.js";
import { sha256Hex, validReference } from "./helpers/memory-ports.js";
import {
  IT_CONFIG,
  IT_ENABLED,
  ensureMigrated,
  insertRun,
  insertSubmission,
  purgeSubmissions,
  registerChallengeVersion,
  uniqueIds,
} from "./helpers/it.js";

describe.skipIf(!IT_ENABLED)("PostgreSQL 裁决域(容器门控)", () => {
  const ids = uniqueIds("queue");
  let pool: Pool;
  let queue: PostgresVerdictQueue;
  let challenges: PostgresChallengeSource;

  beforeAll(async () => {
    pool = await createPostgresPool(IT_CONFIG.postgresUrl);
    await ensureMigrated(pool);
    queue = new PostgresVerdictQueue(pool);
    challenges = new PostgresChallengeSource(pool);
  });

  afterAll(async () => {
    await purgeSubmissions(pool, ids.tenantId);
    await pool.end();
  });

  it("认领:pending 行推进 running,引用与 log_digest 随行;running 行不再认领", async () => {
    const submissionId = await insertSubmission(pool, {
      tenantId: ids.tenantId,
      sessionId: ids.sessionId,
      reference: validReference({ challengeId: "chal-claim" }),
    });
    const runId = await insertRun(pool, {
      tenantId: ids.tenantId,
      submissionId,
      logDigest: "a".repeat(64),
    });
    expect(await queue.pendingCount()).toBeGreaterThanOrEqual(1);

    const claimed = await queue.claim(10, 3);
    const mine = claimed.find((run) => run.runId === runId);
    expect(mine).toBeDefined();
    expect(mine?.tenantId).toBe(ids.tenantId);
    expect(mine?.sessionId).toBe(ids.sessionId);
    expect(mine?.logDigest).toBe("a".repeat(64));
    expect(mine?.attemptCount).toBe(1);
    expect((mine?.reference as { form?: string })["form"]).toBe("stackmaster-session-submit/1");

    const status = await pool.query<{ status: string }>(
      `SELECT status FROM verifier_runs WHERE id = $1`,
      [runId],
    );
    expect(status.rows[0]?.["status"]).toBe("running");

    // running 行不再入队(其余 submission 为零)。
    const again = await queue.claim(10, 3);
    expect(again.find((run) => run.runId === runId)).toBeUndefined();
  });

  it("认领排除已有 verdicts 的 submission(裁决幂等的队列侧表达)", async () => {
    const submissionId = await insertSubmission(pool, {
      tenantId: ids.tenantId,
      sessionId: ids.sessionId,
      reference: validReference({ challengeId: "chal-claimed" }),
    });
    await insertRun(pool, { tenantId: ids.tenantId, submissionId, logDigest: null });
    await pool.query(
      `INSERT INTO verdicts (tenant_id, submission_id, verdict, detail) VALUES ($1, $2, 'success', 'null'::jsonb)`,
      [ids.tenantId, submissionId],
    );

    const claimed = await queue.claim(100, 3);
    expect(claimed.find((run) => run.submissionId === submissionId)).toBeUndefined();
  });

  it("完成:run → completed 且 verdicts 幂等(重复裁决不重复写入)", async () => {
    const submissionId = await insertSubmission(pool, {
      tenantId: ids.tenantId,
      sessionId: ids.sessionId,
      reference: validReference({ challengeId: "chal-complete" }),
    });
    const runId = await insertRun(pool, {
      tenantId: ids.tenantId,
      submissionId,
      logDigest: null,
    });

    const audit = {
      kind: "verdict_completed",
      at: Date.now(),
      detail: { submissionId, verdict: "success" },
    } as const;
    await queue.complete({
      runId,
      submissionId,
      tenantId: ids.tenantId,
      sessionId: ids.sessionId,
      verdict: "success",
      detail: { replay: { kind: "matched" } },
      audit,
    });
    // 幂等:同 submission 的重复 complete(并发 / 重放形态)不产生第二行
    //(审计事件同事务追加,幂等路径下也不改写既有裁决)。
    await queue.complete({
      runId,
      submissionId,
      tenantId: ids.tenantId,
      sessionId: ids.sessionId,
      verdict: "success",
      detail: { replay: { kind: "matched" } },
      audit,
    });

    // 审计发射(WP-62 / D-API-95):verdict_completed 与处置同事务落库,
    // user_id = verifier 系统主体,session_id = 提交会话锚,detail 零秘密。
    const auditRows = await pool.query<{
      kind: string;
      user_id: string;
      session_id: string | null;
      detail: Record<string, unknown>;
    }>(
      `SELECT kind, user_id, session_id, detail FROM audit_log WHERE tenant_id = $1 ORDER BY id`,
      [ids.tenantId],
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0]).toMatchObject({
      kind: "verdict_completed",
      user_id: "verifier",
      session_id: ids.sessionId,
    });
    expect(auditRows.rows[0]?.["detail"]).toEqual({
      submissionId,
      verdict: "success",
    });

    const runs = await pool.query<{ status: string }>(
      `SELECT status FROM verifier_runs WHERE id = $1`,
      [runId],
    );
    expect(runs.rows[0]?.["status"]).toBe("completed");
    const verdicts = await pool.query<{ verdict: string; detail: unknown }>(
      `SELECT verdict, detail FROM verdicts WHERE submission_id = $1`,
      [submissionId],
    );
    expect(verdicts.rows).toHaveLength(1);
    expect(verdicts.rows[0]?.["verdict"]).toBe("success");
    expect(verdicts.rows[0]?.["detail"]).toEqual({ replay: { kind: "matched" } });
  });

  it("失败:未耗尽重试以新 pending 行承载;耗尽后残留 pending 行收口(查询面恒 pending)", async () => {
    const submissionId = await insertSubmission(pool, {
      tenantId: ids.tenantId,
      sessionId: ids.sessionId,
      reference: validReference({ challengeId: "chal-fail" }),
    });
    const runId = await insertRun(pool, { tenantId: ids.tenantId, submissionId });

    await queue.fail({
      runId,
      tenantId: ids.tenantId,
      submissionId,
      sessionId: ids.sessionId,
      attemptCount: 1,
      reason: "bundle_unavailable",
      maxAttempts: 3,
      audit: {
        kind: "verdict_replay_failed",
        at: Date.now(),
        detail: { submissionId, direction: "bundle_unavailable" },
      },
    });
    const afterFirst = await pool.query<{ status: string }>(
      `SELECT status FROM verifier_runs WHERE submission_id = $1 ORDER BY created_at`,
      [submissionId],
    );
    expect(afterFirst.rows.map((row) => row["status"])).toEqual(["failed", "pending"]);

    // 第二次失败后耗尽(attemptCount == maxAttempts):新行不再插入,
    // 残留 pending 行收口为 failed(查询面恒 pending,不再空转认领)。
    const secondRun = await pool.query<{ id: string }>(
      `SELECT id FROM verifier_runs WHERE submission_id = $1 AND status = 'pending'`,
      [submissionId],
    );
    await queue.fail({
      runId: secondRun.rows[0]?.["id"] ?? "",
      tenantId: ids.tenantId,
      submissionId,
      sessionId: ids.sessionId,
      attemptCount: 3,
      reason: "bundle_unavailable",
      maxAttempts: 3,
      audit: {
        kind: "verdict_replay_failed",
        at: Date.now(),
        detail: { submissionId, direction: "bundle_unavailable" },
      },
    });

    // 失败态的审计发射:verdict_replay_failed 行随失败态同事务落库。
    const failAudit = await pool.query<{ kind: string; detail: Record<string, unknown> }>(
      `SELECT kind, detail FROM audit_log WHERE tenant_id = $1 AND kind = 'verdict_replay_failed'`,
      [ids.tenantId],
    );
    expect(failAudit.rows.length).toBeGreaterThanOrEqual(2);
    expect(failAudit.rows[0]?.["detail"]).toMatchObject({
      submissionId,
      direction: "bundle_unavailable",
    });
    const afterExhaust = await pool.query<{ status: string }>(
      `SELECT status FROM verifier_runs WHERE submission_id = $1 ORDER BY created_at`,
      [submissionId],
    );
    expect(afterExhaust.rows.map((row) => row["status"])).toEqual(["failed", "failed"]);
    const residual = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM verifier_runs
       WHERE submission_id = $1 AND status = 'pending'`,
      [submissionId],
    );
    expect(residual.rows[0]?.["count"]).toBe("0");
  });

  it("题目登记行:登记可读回;跨租户与未登记同形 null(防枚举)", async () => {
    const bundleJson = '{"vmEngineVersion":"0.1.0"}';
    await registerChallengeVersion(pool, {
      tenantId: ids.tenantId,
      challengeId: `chal-it-${ids.sessionId.slice(-8)}`,
      contentVersion: "1.0.0",
      privateBundleSha256: sha256Hex(bundleJson),
      publicDescriptorSha256: sha256Hex("descriptor"),
      privateBundleObject: `${ids.sessionId}/bundle.json`,
      publicDescriptorObject: `${ids.sessionId}/descriptor.json`,
    });
    const challengeId = `chal-it-${ids.sessionId.slice(-8)}`;

    const registered = await challenges.findVersion(ids.tenantId, challengeId, "1.0.0");
    expect(registered?.privateBundleObject).toBe(`${ids.sessionId}/bundle.json`);
    expect(registered?.privateBundleSha256).toBe(sha256Hex(bundleJson));

    expect(await challenges.findVersion("it-other-tenant", challengeId, "1.0.0")).toBeNull();
    expect(await challenges.findVersion(ids.tenantId, challengeId, "9.9.9")).toBeNull();
  });

  it("存储故障翻译:不可达连接串 → VerifierStoreError(fail-closed)", async () => {
    await expect(
      createPostgresPool("postgres://stackmaster:wrong@127.0.0.1:1/unreachable"),
    ).rejects.toBeInstanceOf(VerifierStoreError);
  });

  it("SQL 故障收敛:非法参数 → ROLLBACK + VerifierStoreError(不外泄原始细节)", async () => {
    // LIMIT 参数非法 → 认领事务整体回滚。
    await expect(
      queue.claim("not-a-number" as unknown as number, 3),
    ).rejects.toBeInstanceOf(VerifierStoreError);
    // run id 非法形态 → 失败态事务整体回滚。
    await expect(
      queue.fail({
        runId: "not-a-uuid",
        tenantId: ids.tenantId,
        submissionId: "00000000-0000-0000-0000-000000000000",
        sessionId: ids.sessionId,
        attemptCount: 1,
        reason: "bundle_unavailable",
        maxAttempts: 3,
        audit: {
          kind: "verdict_replay_failed",
          at: Date.now(),
          detail: { submissionId: "00000000-0000-0000-0000-000000000000", direction: "bundle_unavailable" },
        },
      }),
    ).rejects.toBeInstanceOf(VerifierStoreError);
    // 回滚后连接可用(池未污染)。
    expect(await queue.pendingCount()).toBeGreaterThanOrEqual(0);
  });

  it("完成事务故障:verdicts 写入失败 → ROLLBACK,run 不推进(complete 原子性)", async () => {
    // 不存在的 submission → verdicts FK 违约 → 整个 complete 事务回滚。
    await expect(
      queue.complete({
        runId: "00000000-0000-0000-0000-00000000000f",
        submissionId: "00000000-0000-0000-0000-000000000000",
        tenantId: ids.tenantId,
        sessionId: ids.sessionId,
        verdict: "success",
        detail: null,
        audit: {
          kind: "verdict_completed",
          at: Date.now(),
          detail: { submissionId: "00000000-0000-0000-0000-000000000000", verdict: "success" },
        },
      }),
    ).rejects.toBeInstanceOf(VerifierStoreError);
  });

  it("审计 append 失败 → complete 整体回滚(审计与处置不可分,fail-closed)", async () => {
    const submissionId = await insertSubmission(pool, {
      tenantId: ids.tenantId,
      sessionId: ids.sessionId,
      reference: validReference({ challengeId: "chal-audit-fail" }),
    });
    const runId = await insertRun(pool, { tenantId: ids.tenantId, submissionId });
    // kind 封闭集合违例(CHECK,D-API-90)→ 审计 INSERT 失败 → 整个
    // complete 事务回滚:verdicts 不落、run 不推进(裁决完成事实与审计账
    // 不可分,D-API-95)。
    await expect(
      queue.complete({
        runId,
        submissionId,
        tenantId: ids.tenantId,
        sessionId: ids.sessionId,
        verdict: "success",
        detail: null,
        audit: {
          kind: "bogus_kind" as "verdict_completed",
          at: Date.now(),
          detail: { submissionId },
        },
      }),
    ).rejects.toBeInstanceOf(VerifierStoreError);
    const runs = await pool.query<{ status: string }>(
      `SELECT status FROM verifier_runs WHERE id = $1`,
      [runId],
    );
    expect(runs.rows[0]?.["status"]).toBe("pending");
    const verdicts = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM verdicts WHERE submission_id = $1`,
      [submissionId],
    );
    expect(verdicts.rows[0]?.["count"]).toBe("0");
    // 回滚后连接可用(池未污染)。
    expect(await queue.pendingCount()).toBeGreaterThanOrEqual(0);
  });

  it("查询面故障:连接池关闭后 pendingCount / findVersion → VerifierStoreError", async () => {
    const dying = await createPostgresPool(IT_CONFIG.postgresUrl);
    const deadQueue = new PostgresVerdictQueue(dying);
    const deadChallenges = new PostgresChallengeSource(dying);
    await dying.end();
    await expect(deadQueue.pendingCount()).rejects.toBeInstanceOf(VerifierStoreError);
    await expect(
      deadChallenges.findVersion(ids.tenantId, "chal-x", "1.0.0"),
    ).rejects.toBeInstanceOf(VerifierStoreError);
  });
});

describe.skipIf(!IT_ENABLED)("MinIO 登记双包只读源(容器门控)", () => {
  const ids = uniqueIds("minio");
  const BUNDLE = Buffer.from('{"vmEngineVersion":"0.1.0","engineBuildId":"dev"}', "utf8");
  const DESCRIPTOR = Buffer.from('{"schemaVersion":1,"vmProfile":{}}', "utf8");
  const OBJECT = `${ids.sessionId}/bundle.json`;
  const PUBLIC_OBJECT = `${ids.sessionId}/descriptor.json`;
  let admin: MinioClient;
  let source: MinioRegisteredBundleSource;

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
    await admin.putObject(IT_CONFIG.minioBucketPrivate, OBJECT, BUNDLE, BUNDLE.length);
    await admin.putObject(IT_CONFIG.minioBucketPublic, PUBLIC_OBJECT, DESCRIPTOR, DESCRIPTOR.length);
    source = new MinioRegisteredBundleSource(
      await createMinioReadonlyClient({
        endpoint: IT_CONFIG.minioEndpoint,
        port: IT_CONFIG.minioPort,
        accessKey: IT_CONFIG.minioAccessKey,
        secretKey: IT_CONFIG.minioSecretKey,
      }),
      IT_CONFIG.minioBucketPrivate,
      IT_CONFIG.minioBucketPublic,
    );
  });

  afterAll(async () => {
    await admin.removeObject(IT_CONFIG.minioBucketPrivate, OBJECT);
    await admin.removeObject(IT_CONFIG.minioBucketPublic, PUBLIC_OBJECT);
  });

  it("getPrivate / getPublic:双桶各归其位,逐字节一致;缺失对象 = null(NotFound 收敛)", async () => {
    const bytes = await source.getPrivate(OBJECT);
    expect(Buffer.from(bytes ?? []).equals(BUNDLE)).toBe(true);
    const publicBytes = await source.getPublic(PUBLIC_OBJECT);
    expect(Buffer.from(publicBytes ?? []).equals(DESCRIPTOR)).toBe(true);
    expect(await source.getPrivate(`${ids.sessionId}/absent.json`)).toBeNull();
    expect(await source.getPublic(`${ids.sessionId}/absent.json`)).toBeNull();
  });

  it("probe:探测键缺失(NotFound)= 授权可达且健康", async () => {
    await expect(source.probe()).resolves.toBeUndefined();
  });

  it("非 NotFound 取回故障(桶不存在)→ 确定性抛出(拒裁方向,不静默为 null)", async () => {
    const absent = new MinioRegisteredBundleSource(
      await createMinioReadonlyClient({
        endpoint: IT_CONFIG.minioEndpoint,
        port: IT_CONFIG.minioPort,
        accessKey: IT_CONFIG.minioAccessKey,
        secretKey: IT_CONFIG.minioSecretKey,
      }),
      "definitely-absent-bucket-xyz",
      "definitely-absent-bucket-xyz",
    );
    await expect(absent.getPrivate(`${ids.sessionId}/bundle.json`)).rejects.toThrow();
    // 桶级缺失对 readiness 探针 = 健康(权限可达语义)。
    await expect(absent.probe()).resolves.toBeUndefined();
  });
});

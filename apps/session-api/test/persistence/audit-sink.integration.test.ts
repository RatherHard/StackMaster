/**
 * 容器门控集成测试:审计 PG 落库与归档(WP-64;D-API-90 ~ 92)。
 *
 *  - audit_log append-only 库层强制红灯三连(D-API-22 action_log 同款形态:
 *    UPDATE 拒 / DELETE 拒 / TRUNCATE 拒);
 *  - kind 封闭集合库层 CHECK(D-API-90):十值受理、未知 kind 拒;
 *  - PgAuditSink 与 InMemoryAuditSink 行为同构(append → 库行读回一致);
 *  - 归档往返(落库 → 归档 → 校验):PgAuditSink 落库 → AuditArchiveJob
 *    切片上传(数据 + SHA-256 清单)→ 对象取回复算校验 → 批 ID 幂等
 *    (重复归档零双份)→ 台账游标推进。
 *
 * 门控:SESSION_API_IT=1 才运行(globalSetup 负责 compose up --wait / down);
 * 否则整组跳过并输出跳过原因。compose 全拓扑(会话链路 → 真实进程落库 →
 * 归档)与角色治理红灯由 test/compose 套件另行承接。
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  AuditArchiveJob,
  PgAuditSink,
  createMinioClient,
  createPostgresPool,
} from "../../src/persistence/index.js";
import { InMemoryAuditSink } from "../../src/auth/index.js";
import type { MinioLike } from "../../src/persistence/minio/challenge-bundle-store.js";
import type { AuditEvent } from "../../src/auth/ports.js";
import {
  IT_CONFIG,
  IT_ENABLED,
  SKIP_REASON,
  ensureMigrated,
  uniqueIds,
} from "./helpers/it.js";

describe.skipIf(!IT_ENABLED)("审计 PG 落库与归档(容器门控;D-API-90 ~ 92)", () => {
  const ids = uniqueIds("audit");
  let pool: Pool;
  let minio: MinioLike;
  const bucket = `audit-archive-it-${ids.tenantId.slice(-8).toLowerCase()}`;

  beforeAll(async () => {
    pool = await createPostgresPool(IT_CONFIG.postgresUrl, 5);
    await ensureMigrated(pool);
    minio = await createMinioClient({
      endpoint: IT_CONFIG.minioEndpoint,
      port: IT_CONFIG.minioPort,
      accessKey: IT_CONFIG.minioAccessKey,
      secretKey: IT_CONFIG.minioSecretKey,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  function event(kind: AuditEvent["kind"], at: number, sessionId?: string): AuditEvent {
    return {
      kind,
      at,
      actor: { tenantId: ids.tenantId, userId: "user-audit" },
      ...(sessionId === undefined ? {} : { sessionId }),
      detail: { note: "it-audit", sequence: at },
    };
  }

  it("PgAuditSink 落库与 InMemoryAuditSink 行为同构:append → 库行读回一致", async () => {
    const sink = new PgAuditSink(pool);
    const memory = new InMemoryAuditSink();
    const events = [
      event("embed_token_issued", 1_000, "sess-1"),
      event("submit", 2_000, "sess-1"),
      event("session_force_closed", 3_000),
    ];
    for (const item of events) {
      await sink.append(item);
      await memory.append(item);
    }
    const stored = await pool.query(
      `SELECT kind, at, tenant_id, user_id, session_id, detail
       FROM audit_log WHERE tenant_id = $1 ORDER BY id`,
      [ids.tenantId],
    );
    expect(stored.rows.map((row) => row.kind)).toEqual(memory.snapshot().map((item) => item.kind));
    expect(stored.rows.map((row) => row.session_id)).toEqual(["sess-1", "sess-1", null]);
    // 事件时刻往返一致(epoch 毫秒)。
    expect(stored.rows.map((row) => (row.at as Date).getTime())).toEqual([1000, 2000, 3000]);
    // detail 往返一致(仅非秘密标量字典)。
    expect(stored.rows[0]!.detail).toEqual({ note: "it-audit", sequence: 1000 });
  });

  it("audit_log UPDATE 被数据库层拒绝(append-only 红灯反例,D-API-22 同款)", async () => {
    await expect(
      pool.query(`UPDATE audit_log SET user_id = 'tampered' WHERE tenant_id = $1`, [ids.tenantId]),
    ).rejects.toThrow(/append-only/);
  });

  it("audit_log DELETE 被数据库层拒绝(append-only 红灯反例)", async () => {
    await expect(
      pool.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [ids.tenantId]),
    ).rejects.toThrow(/append-only/);
  });

  it("audit_log TRUNCATE 被数据库层拒绝(append-only 红灯反例)", async () => {
    await expect(pool.query(`TRUNCATE audit_log`)).rejects.toThrow(/append-only/);
  });

  it("kind 十值封闭集合库层 CHECK:裁决域三值受理;未知 kind 被拒(D-API-90 冻结锚)", async () => {
    // 裁决域三值(WP-62 发射面的库层预留)受理。
    for (const kind of ["verdict_completed", "verdict_replay_failed", "verdict_rejected"]) {
      await pool.query(
        `INSERT INTO audit_log (kind, at, tenant_id, user_id, session_id, detail)
         VALUES ($1, now(), $2, 'verifier', null, $3::jsonb)`,
        [kind, `verifier-${ids.tenantId}`, JSON.stringify({ submissionId: "sub-it", verdict: "success" })],
      );
    }
    // 集合外 kind 一律拒(库层即冻结:任何逐次漂移不经迁移不可落库)。
    await expect(
      pool.query(
        `INSERT INTO audit_log (kind, at, tenant_id, user_id) VALUES ('audit_archived', now(), $1, 'ops')`,
        [ids.tenantId],
      ),
    ).rejects.toThrow(/audit_log_kind_closed_set/);
  });

  it("归档往返:落库 → 切片上传双对象 → SHA-256 清单复算一致 → 批 ID 幂等零双份", async () => {
    // 1. 落库:专用租户 + 已过保留窗口的事件(时钟前推使切片窗口覆盖)。
    const archiveTenant = `arc-${ids.tenantId}`;
    const sink = new PgAuditSink(pool);
    for (let index = 0; index < 5; index += 1) {
      await sink.append({
        kind: index % 2 === 0 ? "create_session" : "submit",
        at: Date.now(),
        actor: { tenantId: archiveTenant, userId: "user-arc" },
        sessionId: `sess-arc-${index}`,
        detail: { sequence: index },
      });
    }
    const counted = await pool.query(
      `SELECT count(*)::text AS count FROM audit_log WHERE tenant_id = $1`,
      [archiveTenant],
    );
    expect(Number(counted.rows[0]!.count)).toBe(5);

    // 2. 归档:时钟前推 40 天(窗口 = now - 30 天 → 覆盖刚落库行)。
    const job = new AuditArchiveJob({
      pool,
      minio,
      bucket,
      batchSize: 100,
      retentionDays: 30,
      now: () => Date.now() + 40 * 86_400_000,
    });
    await job.ensureBucket();
    const first = await job.runOnce();
    expect(first.status).toBe("completed");
    const completed = first as {
      batchId: string;
      rowCount: number;
      dataObjectName: string;
      manifestObjectName: string;
      dataSha256: string;
      windowStart: string;
      windowEnd: string;
    };
    // 批是全局切片(台账为全局游标):持久卷可能含其他租户的历史行。
    expect(completed.rowCount).toBeGreaterThanOrEqual(5);

    // 3. 校验:双对象在场;数据字节 SHA-256 复算 = 清单摘要 = 台账摘要。
    const dataStream = await minio.getObject(bucket, completed.dataObjectName);
    const manifestStream = await minio.getObject(bucket, completed.manifestObjectName);
    const dataBytes = Buffer.from(await toArray(dataStream));
    const manifest = JSON.parse(
      Buffer.from(await toArray(manifestStream)).toString("utf8"),
    ) as { dataSha256: string; batchId: string; rowCount: number };
    expect(sha256(dataBytes)).toBe(completed.dataSha256);
    expect(manifest.dataSha256).toBe(completed.dataSha256);
    expect(manifest.batchId).toBe(completed.batchId);
    expect(manifest.rowCount).toBe(completed.rowCount);
    const ledger = await pool.query(
      `SELECT data_sha256, row_count FROM audit_archive_batches WHERE batch_id = $1`,
      [completed.batchId],
    );
    expect(ledger.rows[0]!.data_sha256).toBe(completed.dataSha256);
    expect(Number(ledger.rows[0]!.row_count)).toBe(completed.rowCount);

    // 4. 行内容读回:归档行 = 审计事件同构投影(落库内容零失真);本租户 5 行
    //    全部在批内,顺序与库序一致。
    const lines = dataBytes.toString("utf8").split("\n");
    expect(lines).toHaveLength(completed.rowCount);
    const parsed = lines.map((line) => JSON.parse(line) as {
      actor: { tenantId: string; userId: string };
      kind: string;
      sessionId: string | null;
      detail: unknown;
    });
    const ownLines = parsed.filter((row) => row.actor.tenantId === archiveTenant);
    expect(ownLines).toHaveLength(5);
    expect(ownLines.map((row) => row.sessionId)).toEqual([
      "sess-arc-0",
      "sess-arc-1",
      "sess-arc-2",
      "sess-arc-3",
      "sess-arc-4",
    ]);
    expect(ownLines[0]!.detail).toEqual({ sequence: 0 });
    const dbOwn = await pool.query<{ kind: string }>(
      `SELECT kind FROM audit_log WHERE tenant_id = $1 ORDER BY id`,
      [archiveTenant],
    );
    expect(ownLines.map((row) => row.kind)).toEqual(dbOwn.rows.map((row) => row.kind));

    // 5. 批 ID 幂等:游标已推进 → 重跑 idle;本批对象字节与台账行零变化
    //    (重复归档不产生双份;alreadyArchived 跳过路径由单元测试承载)。
    expect(await job.runOnce()).toEqual({ status: "idle" });
    const objectAgain = await minio.getObject(bucket, completed.dataObjectName);
    expect(sha256(Buffer.from(await toArray(objectAgain)))).toBe(completed.dataSha256);
    const ledgerCount = await pool.query(
      `SELECT count(*)::text AS count FROM audit_archive_batches WHERE batch_id = $1`,
      [completed.batchId],
    );
    expect(Number(ledgerCount.rows[0]!.count)).toBe(1);
  }, 60_000);
});

async function toArray(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// 静态断言:跳过原因文案存在(未门控运行时输出可解释信息)。
describe.skipIf(IT_ENABLED)("容器门控未开启", () => {
  it(`集成测试整体跳过:${SKIP_REASON}`, () => {
    expect(IT_ENABLED).toBe(false);
    expect(IT_CONFIG.minioPort).toBeGreaterThan(0);
  });
});

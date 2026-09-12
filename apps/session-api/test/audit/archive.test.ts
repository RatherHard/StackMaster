/**
 * 审计归档任务单元测试(WP-64;D-API-92)。
 *
 * 归档形态定案(主控预决策):定期归档任务(进程内定时)→ audit_log 按
 * 时间窗切片 → MinIO 审计桶(对象名含批窗口,SHA-256 manifest 清单)→
 * 归档后完整性校验(manifest 摘要复算)→ **副本形态:在线表不删行**
 * (删除 / 裁剪归 T2 演进登记,与 append-only 纪律零冲突)。
 * 批 ID 由行集合边界确定性派生:批 ID 幂等,重复归档不产生双份。
 * 归档动作是运维事件账:不上审计(D-API-90),走受控日志 + /metrics 计数器
 * (outcome ∈ {completed, failed};idle 稳态不计数)。
 *
 * 本文件以假池(脚本化 SQL 路由)+ 内存 MinioLike 覆盖纯函数与任务行为;
 * 真实 PG / MinIO 的往返(落库 → 归档 → 校验)由容器门控测试与 compose
 * 集成套件承接(audit-sink.integration.test.ts / compose 套件)。
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { sha256Hex } from "../../src/persistence/challenges/register-challenge.js";
import {
  AuditArchiveJob,
  buildAuditArchiveManifest,
  deriveAuditArchiveBatchId,
  serializeAuditArchiveRows,
  type ArchivedAuditRow,
  type AuditArchiveManifest,
} from "../../src/persistence/audit-archive.js";
import type { MinioLike } from "../../src/persistence/minio/challenge-bundle-store.js";

function row(id: number, createdAtIso: string, kind = "create_session"): Record<string, unknown> {
  return {
    id,
    kind,
    at: createdAtIso,
    tenant_id: `tenant-${id}`,
    user_id: "user-1",
    session_id: id % 2 === 0 ? null : `sess-${id}`,
    detail: id % 2 === 0 ? null : { challengeVersion: "1.0.0" },
    created_at: new Date(createdAtIso),
  };
}

/** 脚本化假池:按 SQL 形态路由(游标 / 批切片 / 批存在性 / 台账写入)。 */
class ScriptedPool {
  readonly calls: { sql: string; values: unknown[] }[] = [];
  /** 批切片 SELECT(FROM audit_log)的应答队列;耗尽后按空集应答(idle)。 */
  batchResponses: Record<string, unknown>[][] = [];
  /** 游标 SELECT 应答(缺省空 = 首批;推进语义由真实台账行承载)。 */
  cursorRows: Record<string, unknown>[] = [];
  /** 已登记批号(批存在性 SELECT 命中集;仅在台账写入成功后登记)。 */
  existingBatchIds = new Set<string>();
  readonly ledgerInserts: unknown[][] = [];
  /** 一次性失败注入(批切片 / 台账写入)。 */
  failNextBatchSelect: Error | null = null;
  failNextLedgerInsert: Error | null = null;

  async query(sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, values });
    if (sql.includes("FROM audit_archive_batches") && sql.includes("ORDER BY")) {
      return { rows: this.cursorRows };
    }
    if (sql.includes("FROM audit_log")) {
      if (this.failNextBatchSelect !== null) {
        const error = this.failNextBatchSelect;
        this.failNextBatchSelect = null;
        throw error;
      }
      return { rows: this.batchResponses.shift() ?? [] };
    }
    if (sql.includes("WHERE batch_id")) {
      return {
        rows: this.existingBatchIds.has(String(values[0])) ? [{ exists: 1 }] : [],
      };
    }
    if (sql.includes("INSERT INTO audit_archive_batches")) {
      if (this.failNextLedgerInsert !== null) {
        const error = this.failNextLedgerInsert;
        this.failNextLedgerInsert = null;
        throw error;
      }
      this.ledgerInserts.push(values);
      this.existingBatchIds.add(String(values[0]));
      // 台账写入成功 → 游标推进(游标锚 = last_id,values[7])。
      this.cursorRows = [{ last_id: values[7] }];
      return { rows: [] };
    }
    throw new Error(`脚本未覆盖的 SQL:${sql}`);
  }
}

/** 内存 MinioLike(putObject / getObject 字节往返;完整性红灯注入点)。 */
class MemoryArchiveMinio implements Pick<MinioLike, "bucketExists" | "makeBucket" | "putObject" | "getObject"> {
  readonly buckets = new Set<string>();
  readonly objects = new Map<string, Buffer>();
  readonly putCalls: string[] = [];
  /** getObject 篡改谓词:返回 true 时向取回字节追加噪声(摘要复算必不一致)。 */
  tamperGetObject: ((objectName: string) => boolean) | null = null;

  async bucketExists(bucket: string): Promise<boolean> {
    return this.buckets.has(bucket);
  }

  async makeBucket(bucket: string): Promise<void> {
    this.buckets.add(bucket);
  }

  async putObject(
    _bucket: string,
    objectName: string,
    content: Uint8Array | Buffer | string,
  ): Promise<unknown> {
    const buffer = Buffer.from(content);
    this.putCalls.push(objectName);
    this.objects.set(objectName, buffer);
    return {};
  }

  async getObject(_bucket: string, objectName: string): Promise<NodeJS.ReadableStream> {
    const stored = this.objects.get(objectName);
    if (stored === undefined) {
      const error = new Error("NotFound") as Error & { code: string };
      error.code = "NotFound";
      throw error;
    }
    const tampered = this.tamperGetObject?.(objectName) === true;
    const bytes = tampered ? Buffer.concat([stored, Buffer.from("tampered")]) : stored;
    return Readable.from(bytes);
  }
}

function buildJob(options: {
  pool: ScriptedPool;
  minio: MemoryArchiveMinio;
  batchSize?: number;
  retentionDays?: number;
  metrics?: { observeAuditArchiveBatch(outcome: string): void };
  intervalSeconds?: number;
}): AuditArchiveJob {
  return new AuditArchiveJob({
    pool: options.pool as unknown as Pool,
    minio: options.minio as unknown as MinioLike,
    bucket: "audit-archive-test",
    batchSize: options.batchSize ?? 100,
    retentionDays: options.retentionDays ?? 30,
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    ...(options.intervalSeconds === undefined ? {} : { intervalSeconds: options.intervalSeconds }),
  });
}

const T0 = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-01T00:01:00.000Z";
const T2 = "2026-09-01T00:02:00.000Z";

describe("归档序列化与批身份(纯函数;D-API-92)", () => {
  const rows: ArchivedAuditRow[] = [
    { id: 1, kind: "create_session", at: T0, tenantId: "t1", userId: "u1", sessionId: "sess-1", detail: { k: "v" } },
    { id: 2, kind: "verdict_completed", at: T1, tenantId: "t2", userId: "u2", sessionId: null, detail: null },
  ];

  it("归档行序列化确定性:同事件集合字节相同,行内键序冻结", () => {
    const first = serializeAuditArchiveRows(rows);
    const second = serializeAuditArchiveRows([...rows]);
    expect(first.equals(second)).toBe(true);
    const lines = first.toString("utf8").split("\n");
    expect(lines).toHaveLength(2);
    // 键序冻结:id → kind → at → actor(tenantId → userId)→ sessionId → detail。
    expect(lines[0]!.startsWith('{"id":1,"kind":"create_session","at":')).toBe(true);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["id", "kind", "at", "actor", "sessionId", "detail"]);
    expect(parsed["actor"]).toEqual({ tenantId: "t1", userId: "u1" });
  });

  it("归档行 = 审计事件同构投影:at 为 ISO 时刻,detail 仅非秘密标量载体原样嵌入", () => {
    const line = JSON.parse(serializeAuditArchiveRows(rows).toString("utf8").split("\n")[0]!) as {
      kind: string;
      at: string;
      detail: unknown;
    };
    expect(line.kind).toBe("create_session");
    expect(line.at).toBe(T0);
    expect(line.detail).toEqual({ k: "v" });
  });

  it("批 ID 由窗口与游标确定性派生:同集合同 ID;任一变元漂移即不同 ID(批 ID 幂等的前提)", () => {
    const batchId = deriveAuditArchiveBatchId(T0, T1, 2);
    expect(batchId).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveAuditArchiveBatchId(T0, T1, 2)).toBe(batchId);
    expect(deriveAuditArchiveBatchId(T1, T1, 2)).not.toBe(batchId);
    expect(deriveAuditArchiveBatchId(T0, T2, 2)).not.toBe(batchId);
    expect(deriveAuditArchiveBatchId(T0, T1, 3)).not.toBe(batchId);
  });

  it("manifest 携带 SHA-256 清单:数据摘要 / 行数 / 对象名 / 窗口 / 格式版本,键序冻结", () => {
    const dataSha256 = createHash("sha256").update("data").digest("hex");
    const manifest = buildAuditArchiveManifest({
      batchId: "b".repeat(64),
      windowStart: T0,
      windowEnd: T1,
      lastId: 2,
      rowCount: 2,
      dataObjectName: "audit-archive/x/y.jsonl",
      dataSha256,
      dataBytes: 4,
      archivedAt: T2,
    }) as unknown as Record<string, unknown>;
    expect(manifest["format"]).toBe("stackmaster-audit-archive-manifest/1");
    expect(manifest["batchId"]).toBe("b".repeat(64));
    expect(manifest["dataSha256"]).toBe(dataSha256);
    expect(manifest["rowCount"]).toBe(2);
    expect(manifest["dataObjectName"]).toBe("audit-archive/x/y.jsonl");
    expect(Object.keys(manifest)).toEqual([
      "format",
      "batchId",
      "windowStart",
      "windowEnd",
      "lastId",
      "rowCount",
      "dataObjectName",
      "dataSha256",
      "dataBytes",
      "archivedAt",
    ]);
  });
});

describe("AuditArchiveJob 行为(假池 + 内存对象存储;D-API-92)", () => {
  it("无超窗行时归档为 idle:零上传、零台账写入", async () => {
    const pool = new ScriptedPool();
    const minio = new MemoryArchiveMinio();
    const job = buildJob({ pool, minio });
    const result = await job.runOnce();
    expect(result).toEqual({ status: "idle" });
    expect(minio.putCalls).toEqual([]);
    expect(pool.ledgerInserts).toEqual([]);
  });

  it("归档批完成:数据 + 清单双对象上传,manifest SHA-256 复算与数据字节一致,台账落一行", async () => {
    const pool = new ScriptedPool();
    pool.batchResponses.push([row(1, T0), row(2, T1)]);
    const minio = new MemoryArchiveMinio();
    await minio.makeBucket("audit-archive-test");
    const job = buildJob({ pool, minio });
    const result = await job.runOnce();
    expect(result.status).toBe("completed");
    const completed = result as {
      status: "completed";
      batchId: string;
      rowCount: number;
      windowStart: string;
      windowEnd: string;
      dataObjectName: string;
      manifestObjectName: string;
      dataSha256: string;
    };
    expect(completed.rowCount).toBe(2);
    expect(completed.windowStart).toBe(T0);
    expect(completed.windowEnd).toBe(T1);
    // 双对象:数据(jsonl)+ SHA-256 清单(manifest.json)。
    expect(minio.putCalls).toHaveLength(2);
    expect(completed.dataObjectName.endsWith(`${completed.batchId}.jsonl`)).toBe(true);
    expect(completed.manifestObjectName.endsWith(`${completed.batchId}.manifest.json`)).toBe(true);
    // 对象名含批窗口(窗口段为路径前缀,compact 时间戳形态)。
    expect(completed.dataObjectName).toMatch(/^audit-archive\/\d{8}T\d{6}(\d{3})?Z-[^/]+\//);
    // 归档后完整性:清单内摘要与数据对象字节复算一致。
    const dataBytes = minio.objects.get(completed.dataObjectName)!;
    expect(sha256Hex(dataBytes)).toBe(completed.dataSha256);
    const manifest = JSON.parse(minio.objects.get(completed.manifestObjectName)!.toString("utf8")) as AuditArchiveManifest;
    expect(manifest.dataSha256).toBe(completed.dataSha256);
    expect(manifest.rowCount).toBe(2);
    // 台账一行,批号与数据摘要齐备。
    expect(pool.ledgerInserts).toHaveLength(1);
    expect(pool.ledgerInserts[0]![0]).toBe(completed.batchId);
    expect(pool.ledgerInserts[0]![3]).toBe(completed.dataSha256);
  });

  it("重复归档幂等:台账已有同批 ID → 跳过上传,零双份(alreadyArchived)", async () => {
    const pool = new ScriptedPool();
    pool.batchResponses.push([row(1, T0), row(2, T1)]);
    const minio = new MemoryArchiveMinio();
    await minio.makeBucket("audit-archive-test");
    const job = buildJob({ pool, minio });
    const first = (await job.runOnce()) as { status: "completed"; batchId: string };
    const putsAfterFirst = minio.putCalls.length;
    const ledgerAfterFirst = pool.ledgerInserts.length;
    // 重放同一批(游标回退的运维态):台账命中 → 零重复上传、零重复登记。
    pool.batchResponses.unshift([row(1, T0), row(2, T1)]);
    const second = (await job.runOnce()) as {
      status: "completed";
      batchId: string;
      alreadyArchived: boolean;
    };
    expect(second.status).toBe("completed");
    expect(second.alreadyArchived).toBe(true);
    expect(second.batchId).toBe(first.batchId);
    expect(minio.putCalls.length).toBe(putsAfterFirst);
    expect(pool.ledgerInserts.length).toBe(ledgerAfterFirst);
  });

  it("崩溃恢复幂等:上传成功而台账写入失败 → 重跑同批 ID、对象字节相同,不产生双份", async () => {
    const pool = new ScriptedPool();
    pool.batchResponses.push([row(1, T0), row(2, T1)]);
    const minio = new MemoryArchiveMinio();
    await minio.makeBucket("audit-archive-test");
    const job = buildJob({ pool, minio });
    pool.failNextLedgerInsert = new Error("connection terminated");
    await expect(job.runOnce()).rejects.toThrow();
    const dataObjectName = minio.putCalls.find((name) => name.endsWith(".jsonl"))!;
    const bytesAfterCrash = minio.objects.get(dataObjectName)!.toString("utf8");
    expect(minio.putCalls).toHaveLength(2);
    // 重跑:同游标 → 同批 ID → 覆盖写同字节 → 台账补账。
    pool.batchResponses.unshift([row(1, T0), row(2, T1)]);
    const second = (await job.runOnce()) as { status: "completed"; dataObjectName: string };
    expect(second.dataObjectName).toBe(dataObjectName);
    expect(minio.objects.get(dataObjectName)!.toString("utf8")).toBe(bytesAfterCrash);
    expect(minio.putCalls.filter((name) => name === dataObjectName)).toHaveLength(2); // 覆盖写,非双份
    expect(minio.objects.size).toBe(2);
    expect(pool.ledgerInserts).toHaveLength(1);
  });

  it("归档后完整性校验失败 → fail-closed:确定性抛错且台账不落行(重试锚保留)", async () => {
    const pool = new ScriptedPool();
    pool.batchResponses.push([row(1, T0), row(2, T1)]);
    const minio = new MemoryArchiveMinio();
    await minio.makeBucket("audit-archive-test");
    // 数据对象取回阶段注入噪声字节 → manifest 摘要复算必不一致。
    minio.tamperGetObject = (objectName) => objectName.endsWith(".jsonl");
    const job = buildJob({ pool, minio });
    await expect(job.runOnce()).rejects.toThrow(/完整性/);
    // 台账在完整性失败后不推进(下次重试同一批)。
    expect(pool.ledgerInserts).toHaveLength(0);
  });

  it("游标推进:第二批切片只取上一批最后行之后的行(id 单调游标,零重叠零漏批)", async () => {
    const pool = new ScriptedPool();
    const minio = new MemoryArchiveMinio();
    await minio.makeBucket("audit-archive-test");
    const job = buildJob({ pool, minio, batchSize: 2 });
    pool.batchResponses.push([row(1, T0), row(2, T1)]);
    await job.runOnce();
    pool.batchResponses.push([row(3, T1), row(4, T2)]);
    await job.runOnce();
    const batchSelects = pool.calls.filter((call) => call.sql.includes("FROM audit_log"));
    expect(batchSelects).toHaveLength(2);
    // 第二批游标 = 第一批最后行 id(id 严格单调;不用 created_at——库内时刻
    // 是微秒精度,JS Date 毫秒截断会使游标回退、末行重复入批)。
    expect(batchSelects[1]!.values[0]).toBe(2);
    // 台账两行,批 ID 互异。
    expect(pool.ledgerInserts).toHaveLength(2);
    expect(pool.ledgerInserts[0]![0]).not.toBe(pool.ledgerInserts[1]![0]);
  });

  it("批切片受 batchSize 约束:单批至多 batchSize 行,余量留给下一拍", async () => {
    const pool = new ScriptedPool();
    const minio = new MemoryArchiveMinio();
    await minio.makeBucket("audit-archive-test");
    const job = buildJob({ pool, minio, batchSize: 3 });
    pool.batchResponses.push([row(1, T0), row(2, T1), row(3, T2)]);
    const result = (await job.runOnce()) as { status: "completed"; rowCount: number };
    expect(result.rowCount).toBe(3);
    const batchSelect = pool.calls.find((call) => call.sql.includes("FROM audit_log"))!;
    expect(batchSelect.values[2]).toBe(3); // LIMIT = batchSize
  });

  it("失败重试与计数:tick 吞错不外抛并按 failed 计数;恢复后归档完成按 completed 计数", async () => {
    const pool = new ScriptedPool();
    const minio = new MemoryArchiveMinio();
    await minio.makeBucket("audit-archive-test");
    const outcomes: string[] = [];
    const job = buildJob({
      pool,
      minio,
      metrics: { observeAuditArchiveBatch: (outcome) => outcomes.push(outcome) },
    });
    pool.failNextBatchSelect = new Error("store unavailable");
    await expect(job.tick()).resolves.toBeUndefined(); // 定时面吞错(fail-closed 可见性走日志与计数)
    expect(outcomes).toEqual(["failed"]);
    // 恢复:无超窗行 → idle(稳态不计数);有批 → completed 计数。
    await job.tick();
    expect(outcomes).toEqual(["failed"]);
    pool.batchResponses.push([row(1, T0), row(2, T1)]);
    await job.tick();
    expect(outcomes).toEqual(["failed", "completed"]);
  });

  it("定时面:start 即执行首拍,此后按节拍重跑;stop 后不再调度", async () => {
    const pool = new ScriptedPool();
    const minio = new MemoryArchiveMinio();
    const outcomes: string[] = [];
    const job = buildJob({
      pool,
      minio,
      intervalSeconds: 0.02,
      metrics: { observeAuditArchiveBatch: (outcome) => outcomes.push(outcome) },
    });
    pool.batchResponses.push([row(1, T0), row(2, T1)]);
    job.start();
    expect(job.scheduled).toBe(true);
    const deadline = Date.now() + 5_000;
    while (outcomes.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      pool.batchResponses.push([row(1, T0), row(2, T1)]); // 每拍都有可归档批(窗口回退形态)
    }
    expect(outcomes.length).toBeGreaterThanOrEqual(2);
    job.stop();
    expect(job.scheduled).toBe(false);
    const stable = outcomes.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(outcomes.length).toBe(stable);
  });

  it("ensureBucket 幂等建桶:缺失即建,已存在不重复建", async () => {
    const pool = new ScriptedPool();
    const minio = new MemoryArchiveMinio();
    const job = buildJob({ pool, minio });
    await job.ensureBucket();
    expect(minio.buckets.has("audit-archive-test")).toBe(true);
    await job.ensureBucket();
    expect(minio.buckets.size).toBe(1);
  });
});

/**
 * 审计归档任务(WP-64;计划书 5.7"审计日志……定期归档对象存储",D-API-92)。
 *
 * 形态定案(主控预决策):
 *  - **进程内定时**(不引入外部调度设施;T2 多实例演进再议):按
 *    `SESSION_API_AUDIT_ARCHIVE_INTERVAL_SECONDS` 节拍执行 runOnce;
 *  - **切片**:audit_log 以 `created_at`(落库时刻)为窗口轴,键序游标
 *    `(window_end, last_id)` 推进(台账即游标,零重叠零漏批),只取超出
 *    在线保留窗口(`SESSION_API_AUDIT_RETENTION_DAYS`)的行,单批上限
 *    `SESSION_API_AUDIT_ARCHIVE_BATCH`;
 *  - **对象存储**:归档批 → MinIO 审计桶(缺省 `audit-archive`);数据
 *    对象(JSONL,`audit-archive/{窗口起}-{窗口止}/{批ID}.jsonl`,对象名
 *    含批窗口)+ SHA-256 清单对象(`{批ID}.manifest.json`)——清单携带
 *    数据对象 SHA-256 / 行数 / 窗口 / 格式版本;
 *  - **归档后完整性校验**:对象写回后立即取回复算 SHA-256 与清单比对,
 *    不符即 fail-closed 抛错、台账不推进(下次重试同批);
 *  - **批 ID 幂等**:批 ID 由行集合边界(窗口 + 游标)确定性派生——同批
 *    重跑同 ID,台账命中即跳过上传;崩溃恢复(上传成功而台账未写)重跑
 *    覆盖写同字节,重复归档不产生双份;
 *  - **副本形态**:归档是在线表的副本,在线行**不删除**(append-only
 *    纪律零冲突;在线删除 / 裁剪归 T2 演进登记)。
 *
 * 审计面边界:归档动作是**运维事件账,不上审计**(D-API-59 / D-API-90)——
 * 运行事实走受控日志(Pino,零载荷细节)+ `/metrics` 计数器
 * `session_api_audit_archive_batches_total{outcome ∈ {completed, failed}}`
 * (idle 稳态不计数;D-API-71 标签纪律)。
 */

import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { Logger } from "pino";

import { PersistenceError } from "./errors.js";
import type { MinioLike } from "./minio/challenge-bundle-store.js";

/** 归档数据对象格式版本(JSONL;每行一个审计事件同构投影)。 */
export const AUDIT_ARCHIVE_FORMAT = "stackmaster-audit-archive/1";
/** 归档清单(manifest)格式版本。 */
export const AUDIT_ARCHIVE_MANIFEST_FORMAT = "stackmaster-audit-archive-manifest/1";
/** 批 ID 派生基线前缀(与序列化格式版本各自独立,基线变更即新批族)。 */
export const AUDIT_ARCHIVE_BATCH_BASIS_PREFIX = "stackmaster-audit-archive-batch/1";
/** 归档对象名前缀(桶内键自描述;桶名可配置,前缀不变)。 */
export const AUDIT_ARCHIVE_OBJECT_PREFIX = "audit-archive";

/** 归档行 = 审计事件的同构投影(仅非秘密标量 detail;行序即库序)。 */
export interface ArchivedAuditRow {
  readonly id: number;
  readonly kind: string;
  /** 事件时刻(Unix epoch 毫秒)的 ISO 形态。 */
  readonly at: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string | null;
  /** 审计 detail(仅非秘密标量字典;缺席归一为 null)。 */
  readonly detail: unknown;
}

/** 归档清单(SHA-256 清单;键序冻结,序列化确定性)。 */
export interface AuditArchiveManifest {
  readonly format: typeof AUDIT_ARCHIVE_MANIFEST_FORMAT;
  readonly batchId: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly lastId: number;
  readonly rowCount: number;
  readonly dataObjectName: string;
  readonly dataSha256: string;
  readonly dataBytes: number;
  readonly archivedAt: string;
}

/**
 * 归档行序列化(确定性):JSONL,行内键序冻结
 * (id → kind → at → actor{tenantId, userId} → sessionId → detail),
 * 可选字段归一为 null——同事件集合恒同字节(批 SHA-256 复算的前提)。
 */
export function serializeAuditArchiveRows(rows: readonly ArchivedAuditRow[]): Buffer {
  const lines = rows.map((row) =>
    JSON.stringify({
      id: row.id,
      kind: row.kind,
      at: row.at,
      actor: { tenantId: row.tenantId, userId: row.userId },
      sessionId: row.sessionId ?? null,
      detail: row.detail ?? null,
    }),
  );
  return Buffer.from(lines.join("\n"), "utf8");
}

/**
 * 批 ID(确定性):由行集合边界(窗口起止 + 游标行 id)派生的 SHA-256 hex。
 * 同一行集合恒同 ID;游标单调推进下批与批互异——重复归档不产生双份的锚。
 */
export function deriveAuditArchiveBatchId(
  windowStartIso: string,
  windowEndIso: string,
  lastId: number,
): string {
  const basis = [
    AUDIT_ARCHIVE_BATCH_BASIS_PREFIX,
    `windowStart=${windowStartIso}`,
    `windowEnd=${windowEndIso}`,
    `lastId=${lastId}`,
  ].join("\n");
  return createHash("sha256").update(basis, "utf8").digest("hex");
}

/** 构造归档清单(键序冻结;D-API-92 清单形态)。 */
export function buildAuditArchiveManifest(input: {
  batchId: string;
  windowStart: string;
  windowEnd: string;
  lastId: number;
  rowCount: number;
  dataObjectName: string;
  dataSha256: string;
  dataBytes: number;
  archivedAt: string;
}): AuditArchiveManifest {
  return {
    format: AUDIT_ARCHIVE_MANIFEST_FORMAT,
    batchId: input.batchId,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    lastId: input.lastId,
    rowCount: input.rowCount,
    dataObjectName: input.dataObjectName,
    dataSha256: input.dataSha256,
    dataBytes: input.dataBytes,
    archivedAt: input.archivedAt,
  };
}

/** compact 时间戳(对象名窗口段;ISO 去 `-` `:` `.`)。 */
function compactTimestamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\./g, "");
}

function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", (error) => reject(error));
  });
}

/** 时刻列归一(pg 返回 Date;ISO 字符串同形接受)。 */
function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

/** 归档计数结果(outcome 有界二值;idle 稳态不计数,D-API-71 标签纪律)。 */
export type AuditArchiveOutcome = "completed" | "failed";

export interface AuditArchiveMetrics {
  observeAuditArchiveBatch(outcome: AuditArchiveOutcome): void;
}

export type AuditArchiveRunResult =
  | { readonly status: "idle" }
  | {
      readonly status: "completed";
      readonly batchId: string;
      readonly rowCount: number;
      readonly windowStart: string;
      readonly windowEnd: string;
      readonly dataObjectName: string;
      readonly manifestObjectName: string;
      readonly dataSha256: string;
      /** true = 台账命中(同批已归档),本次跳过上传(批 ID 幂等)。 */
      readonly alreadyArchived: boolean;
    };

export interface AuditArchiveJobOptions {
  readonly pool: Pool;
  readonly minio: MinioLike;
  /** 审计桶(SESSION_API_AUDIT_BUCKET;缺省 audit-archive,装配传入)。 */
  readonly bucket: string;
  /** 单批行数上限(SESSION_API_AUDIT_ARCHIVE_BATCH)。 */
  readonly batchSize: number;
  /** 在线保留窗口天数(SESSION_API_AUDIT_RETENTION_DAYS;切片上界 = now - 天数)。 */
  readonly retentionDays: number;
  /** 定时节拍秒(SESSION_API_AUDIT_ARCHIVE_INTERVAL_SECONDS;start() 必需)。 */
  readonly intervalSeconds?: number;
  readonly metrics?: AuditArchiveMetrics;
  readonly logger?: Logger;
  /** 时钟注入(测试把 now 前推以使刚落库行进入切片窗口;缺省 Date.now)。 */
  readonly now?: () => number;
}

/** 单批归档任务(PG 切片 → MinIO 副本 → 完整性校验 → 台账;见模块头)。 */
export class AuditArchiveJob {
  readonly #pool: Pool;
  readonly #minio: MinioLike;
  readonly #bucket: string;
  readonly #batchSize: number;
  readonly #retentionDays: number;
  readonly #intervalSeconds?: number;
  readonly #metrics?: AuditArchiveMetrics;
  readonly #logger?: Logger;
  readonly #now: () => number;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: AuditArchiveJobOptions) {
    this.#pool = options.pool;
    this.#minio = options.minio;
    this.#bucket = options.bucket;
    this.#batchSize = options.batchSize;
    this.#retentionDays = options.retentionDays;
    this.#intervalSeconds = options.intervalSeconds;
    this.#metrics = options.metrics;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  /** 幂等建桶(装配期;缺失即建,失败 fail-closed 上抛)。 */
  async ensureBucket(): Promise<void> {
    try {
      if (await this.#minio.bucketExists(this.#bucket)) {
        return;
      }
      await this.#minio.makeBucket(this.#bucket, "us-east-1");
    } catch (error) {
      throw new PersistenceError("store_unavailable", "审计归档桶初始化失败(fail-closed)", { cause: error });
    }
  }

  /**
   * 执行一批归档(可调用入口,亦是定时面的拍体):无超窗行 → idle;
   * 有批 → 切片 → 上传双对象 → 完整性校验 → 台账落行 → completed。
   * 失败一律上抛(定时面 tick 吞错转 failed 计数与受控日志)。
   */
  async runOnce(): Promise<AuditArchiveRunResult> {
    // ── 1. 游标(台账即游标):最近一批的最后行 id(id 严格单调,作切片
    //    锚——不用 created_at:库内时刻是微秒精度,JS Date 只到毫秒,以
    //    时刻为游标会因截断回退、末行被重复选中)──
    const cursor = await this.#pool.query<{ last_id: string | number }>(
      `SELECT last_id FROM audit_archive_batches ORDER BY last_id DESC LIMIT 1`,
    );
    const cursorRow = cursor.rows[0];
    const cursorLastId = cursorRow !== undefined ? Number(cursorRow.last_id) : 0;

    // ── 2. 批切片:游标行之后、在线保留窗口之前的行(按 id 序)──
    const horizon = new Date(this.#now() - this.#retentionDays * 86_400_000);
    let batchRows: Record<string, unknown>[];
    try {
      const batch = await this.#pool.query(
        `SELECT id, kind, at, tenant_id, user_id, session_id, detail, created_at
         FROM audit_log
         WHERE id > $1 AND created_at <= $2
         ORDER BY id ASC
         LIMIT $3`,
        [cursorLastId, horizon, this.#batchSize],
      );
      batchRows = batch.rows;
    } catch (error) {
      throw new PersistenceError("store_unavailable", "审计归档切片失败(store_unavailable)", { cause: error });
    }
    if (batchRows.length === 0) {
      return { status: "idle" };
    }

    const rows: ArchivedAuditRow[] = batchRows.map((raw) => ({
      id: Number(raw["id"]),
      kind: String(raw["kind"]),
      at: toIso(raw["at"]),
      tenantId: String(raw["tenant_id"]),
      userId: String(raw["user_id"]),
      sessionId: raw["session_id"] === null ? null : String(raw["session_id"]),
      detail: raw["detail"] ?? null,
    }));
    const windowStart = toIso(batchRows[0]!["created_at"]);
    const windowEnd = toIso(batchRows.at(-1)!["created_at"]);
    const lastId = rows.at(-1)!.id;
    const batchId = deriveAuditArchiveBatchId(windowStart, windowEnd, lastId);
    const windowSegment = `${compactTimestamp(windowStart)}-${compactTimestamp(windowEnd)}`;
    const dataObjectName = `${AUDIT_ARCHIVE_OBJECT_PREFIX}/${windowSegment}/${batchId}.jsonl`;
    const manifestObjectName = `${AUDIT_ARCHIVE_OBJECT_PREFIX}/${windowSegment}/${batchId}.manifest.json`;

    // ── 3. 批 ID 幂等:台账命中即跳过上传(重复归档不产生双份)──
    const existing = await this.#pool.query(
      `SELECT 1 AS exists FROM audit_archive_batches WHERE batch_id = $1`,
      [batchId],
    );
    const alreadyArchived = existing.rows.length > 0;
    const dataBytes = serializeAuditArchiveRows(rows);
    if (alreadyArchived) {
      this.#metrics?.observeAuditArchiveBatch("completed");
      return {
        status: "completed",
        batchId,
        rowCount: rows.length,
        windowStart,
        windowEnd,
        dataObjectName,
        manifestObjectName,
        dataSha256: createHash("sha256").update(dataBytes).digest("hex"),
        alreadyArchived: true,
      };
    }
    const dataSha256 = createHash("sha256").update(dataBytes).digest("hex");

    // ── 4. 上传双对象(数据 + SHA-256 清单;putObject 覆盖写 = 幂等)──
    const manifest = buildAuditArchiveManifest({
      batchId,
      windowStart,
      windowEnd,
      lastId,
      rowCount: rows.length,
      dataObjectName,
      dataSha256,
      dataBytes: dataBytes.byteLength,
      archivedAt: new Date(this.#now()).toISOString(),
    });
    try {
      await this.#minio.putObject(this.#bucket, dataObjectName, dataBytes, dataBytes.byteLength);
      await this.#minio.putObject(
        this.#bucket,
        manifestObjectName,
        Buffer.from(JSON.stringify(manifest), "utf8"),
      );
    } catch (error) {
      throw new PersistenceError("store_unavailable", "审计归档对象写入失败(store_unavailable)", { cause: error });
    }

    // ── 5. 归档后完整性校验:取回复算 SHA-256 与清单比对(不符即 fail-closed)──
    let archivedData: Buffer;
    let archivedManifest: Buffer;
    try {
      archivedData = await collect(await this.#minio.getObject(this.#bucket, dataObjectName));
      archivedManifest = await collect(await this.#minio.getObject(this.#bucket, manifestObjectName));
    } catch (error) {
      throw new PersistenceError("store_unavailable", "审计归档完整性校验失败(取回不可达)", { cause: error });
    }
    const recomputed = createHash("sha256").update(archivedData).digest("hex");
    let manifestParsed: AuditArchiveManifest;
    try {
      manifestParsed = JSON.parse(archivedManifest.toString("utf8")) as AuditArchiveManifest;
    } catch (error) {
      throw new PersistenceError("store_unavailable", "审计归档完整性校验失败(清单不可解析)", { cause: error });
    }
    if (
      recomputed !== dataSha256 ||
      manifestParsed.dataSha256 !== dataSha256 ||
      manifestParsed.batchId !== batchId ||
      manifestParsed.rowCount !== rows.length
    ) {
      // 台账不推进:下次节拍重试同批(同批 ID → 覆盖写同字节)。
      throw new PersistenceError("store_unavailable", "审计归档完整性校验失败(SHA-256 清单复算不符)");
    }

    // ── 6. 台账落行(游标随之推进)──
    try {
      await this.#pool.query(
        `INSERT INTO audit_archive_batches
           (batch_id, object_name, manifest_name, data_sha256, row_count, window_start, window_end, last_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [batchId, dataObjectName, manifestObjectName, dataSha256, rows.length, windowStart, windowEnd, lastId],
      );
    } catch (error) {
      throw new PersistenceError("store_unavailable", "审计归档台账写入失败(store_unavailable)", { cause: error });
    }
    this.#metrics?.observeAuditArchiveBatch("completed");
    return {
      status: "completed",
      batchId,
      rowCount: rows.length,
      windowStart,
      windowEnd,
      dataObjectName,
      manifestObjectName,
      dataSha256,
      alreadyArchived: false,
    };
  }

  /**
   * 定时面拍体:runOnce 失败吞错(fail-closed 可见性 = failed 计数 + 受控
   * 日志),不中断后续节拍——归档失败重试以节拍自然重入承载。
   */
  async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.#metrics?.observeAuditArchiveBatch("failed");
      this.#logger?.warn(
        { reason: error instanceof Error ? error.message : "audit archive failed" },
        "audit archive run failed; retry on next interval",
      );
    }
  }

  /** 启动定时面(立即执行首拍,此后按 intervalSeconds 节拍;幂等)。 */
  start(): void {
    if (this.#timer !== null) {
      return;
    }
    if (this.#intervalSeconds === undefined) {
      throw new PersistenceError("store_unavailable", "审计归档定时面未配置(intervalSeconds 缺席)");
    }
    this.#timer = setTimeout(() => void this.#loop(), 0);
  }

  async #loop(): Promise<void> {
    await this.tick();
    if (this.#timer === null) {
      return; // tick 期间被 stop
    }
    this.#timer = setTimeout(() => void this.#loop(), (this.#intervalSeconds ?? 0) * 1000);
  }

  /** 停止定时面(优雅停机步骤;幂等)。 */
  stop(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /** 定时面是否在调度(装配 / 测试断言用)。 */
  get scheduled(): boolean {
    return this.#timer !== null;
  }
}

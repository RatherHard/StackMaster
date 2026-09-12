/**
 * PostgreSQL 快照仓储(checkpoints 表;WP-3,D-W8-11)。
 * 适配器对快照载荷只存取不解析:进出都是密文字节(save 前不检查内容,
 * latest 返回密文;解密由调用方用密钥经 SnapshotCipher 做)。
 */

import type { Pool } from "pg";
import { RETENTION_PURGE_GUC, TenantScope } from "./connection.js";
import { PersistenceError } from "../errors.js";
import type { SaveSnapshotInput, SnapshotOrigin, SnapshotRecord, SnapshotStore } from "../ports.js";

interface SnapshotRowRaw {
  id: string;
  tenant_id: string;
  session_id: string;
  checkpoint_id: string | null;
  origin: SnapshotOrigin;
  revision: string | number;
  ciphertext: Buffer;
  byte_size: string | number;
  created_at: Date;
}

function mapRow(raw: SnapshotRowRaw): SnapshotRecord {
  return {
    id: raw.id,
    tenantId: raw.tenant_id,
    sessionId: raw.session_id,
    checkpointId: raw.checkpoint_id,
    origin: raw.origin,
    revision: Number(raw.revision),
    ciphertext: new Uint8Array(raw.ciphertext),
    byteSize: Number(raw.byte_size),
    createdAt: raw.created_at.toISOString(),
  };
}

export class PostgresSnapshotStore implements SnapshotStore {
  readonly #scope: TenantScope;

  constructor(pool: Pool) {
    // 行级租户策略第二道结构闸的注入点(007 迁移 / D-API-101):逐事务
    // SET LOCAL app.tenant_id,RLS 下跨租户访问折叠为"不存在"(零行)。
    this.#scope = new TenantScope(pool);
  }

  async save(input: SaveSnapshotInput): Promise<SnapshotRecord> {
    try {
      const result = await this.#scope.query<SnapshotRowRaw>(
        input.tenantId,
        `INSERT INTO checkpoints
           (tenant_id, session_id, checkpoint_id, origin, revision, ciphertext, byte_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          input.tenantId,
          input.sessionId,
          input.checkpointId ?? null,
          input.origin,
          input.revision,
          Buffer.from(input.ciphertext),
          input.ciphertext.byteLength,
        ],
      );
      return mapRow(result.rows[0] as SnapshotRowRaw);
    } catch (error) {
      throw new PersistenceError("store_unavailable", "快照写入失败", { cause: error });
    }
  }

  async latest(sessionId: string, tenantId: string): Promise<SnapshotRecord | null> {
    const result = await this.#scope.query<SnapshotRowRaw>(
      tenantId,
      `SELECT * FROM checkpoints
       WHERE session_id = $1 AND tenant_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [sessionId, tenantId],
    );
    const raw = result.rows[0];
    return raw === undefined ? null : mapRow(raw);
  }

  async listBySession(sessionId: string, tenantId: string): Promise<SnapshotRecord[]> {
    const result = await this.#scope.query<SnapshotRowRaw>(
      tenantId,
      `SELECT * FROM checkpoints
       WHERE session_id = $1 AND tenant_id = $2
       ORDER BY created_at ASC, id ASC`,
      [sessionId, tenantId],
    );
    return result.rows.map(mapRow);
  }

  async purgeExpired(retentionDays: number): Promise<number> {
    // 保留期清理是 checkpoints 表被 sanction 的唯一删除路径(保留期配置,
    // 计划书 5.7);action_log 的 append-only 纪律不适用于快照恢复点。
    // 行级政策形态(sessions 保留期清理同构,007 / D-API-101):RLS 下
    // DELETE 永不跨租户——两段式:枚举待清理租户(app.retention_purge GUC
    // 唯一跨租户读面)→ 逐租户删除(租户上下文注入)。
    const tenants = await this.#scope.lifecycleQuery<{ tenant_id: string }>(
      RETENTION_PURGE_GUC,
      `SELECT DISTINCT tenant_id FROM checkpoints WHERE created_at < now() - make_interval(days => $1)`,
      [retentionDays],
    );
    let purged = 0;
    for (const row of tenants.rows) {
      const result = await this.#scope.query(
        row.tenant_id,
        `DELETE FROM checkpoints
         WHERE created_at < now() - make_interval(days => $1) AND tenant_id = $2`,
        [retentionDays, row.tenant_id],
      );
      purged += result.rowCount ?? 0;
    }
    return purged;
  }
}

/**
 * PostgreSQL 快照仓储(checkpoints 表;WP-3,D-W8-11)。
 * 适配器对快照载荷只存取不解析:进出都是密文字节(save 前不检查内容,
 * latest 返回密文;解密由调用方用密钥经 SnapshotCipher 做)。
 */

import type { Pool } from "pg";
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
  constructor(private readonly pool: Pool) {}

  async save(input: SaveSnapshotInput): Promise<SnapshotRecord> {
    try {
      const result = await this.pool.query<SnapshotRowRaw>(
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
    const result = await this.pool.query<SnapshotRowRaw>(
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
    const result = await this.pool.query<SnapshotRowRaw>(
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
    const result = await this.pool.query(
      `DELETE FROM checkpoints WHERE created_at < now() - make_interval(days => $1)`,
      [retentionDays],
    );
    return result.rowCount ?? 0;
  }
}

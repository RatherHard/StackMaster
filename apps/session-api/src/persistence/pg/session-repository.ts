/**
 * PostgreSQL 会话仓储(sessions 表;WP-3)。
 * 一切查询强制 tenantId 过滤(查询层租户校验;行级策略归阶段六完善)。
 * 跨租户查询与"会话不存在"同形态返回 null(防枚举)。
 */

import type { Pool } from "pg";
import { PersistenceError } from "../errors.js";
import type {
  CreateSessionRowInput,
  SessionPhaseRow,
  SessionRepository,
  SessionRow,
} from "../ports.js";

interface SessionRowRaw {
  session_id: string;
  tenant_id: string;
  user_id: string;
  challenge_id: string;
  challenge_version: string;
  phase: SessionPhaseRow;
  seed_strategy: string;
  latest_revision: string | number;
  latest_snapshot_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(raw: SessionRowRaw): SessionRow {
  return {
    sessionId: raw.session_id,
    tenantId: raw.tenant_id,
    userId: raw.user_id,
    challengeId: raw.challenge_id,
    challengeVersion: raw.challenge_version,
    phase: raw.phase,
    seedStrategy: raw.seed_strategy,
    latestRevision: Number(raw.latest_revision),
    latestSnapshotId: raw.latest_snapshot_id,
    createdAt: raw.created_at.toISOString(),
    updatedAt: raw.updated_at.toISOString(),
  };
}

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly pool: Pool) {}

  async insertSession(input: CreateSessionRowInput): Promise<SessionRow> {
    try {
      const result = await this.pool.query<SessionRowRaw>(
        `INSERT INTO sessions
           (session_id, tenant_id, user_id, challenge_id, challenge_version, phase, seed_strategy)
         VALUES ($1, $2, $3, $4, $5, 'active', $6)
         RETURNING *`,
        [
          input.sessionId,
          input.tenantId,
          input.userId,
          input.challengeId,
          input.challengeVersion,
          input.seedStrategy,
        ],
      );
      return mapRow(result.rows[0] as SessionRowRaw);
    } catch (error) {
      throw new PersistenceError("store_unavailable", "会话写入失败", { cause: error });
    }
  }

  async findSession(sessionId: string, tenantId: string): Promise<SessionRow | null> {
    // 租户过滤在 WHERE 强制:跨租户定位 = 查不到(与不存在同形态)。
    const result = await this.pool.query<SessionRowRaw>(
      `SELECT * FROM sessions WHERE session_id = $1 AND tenant_id = $2`,
      [sessionId, tenantId],
    );
    const raw = result.rows[0];
    return raw === undefined ? null : mapRow(raw);
  }

  async listSessionsByTenant(tenantId: string): Promise<SessionRow[]> {
    const result = await this.pool.query<SessionRowRaw>(
      `SELECT * FROM sessions WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [tenantId],
    );
    return result.rows.map(mapRow);
  }

  /** 重启恢复枚举(D-API-63):active 行,按创建序恢复(快照锚序与之一致)。 */
  async listActiveSessions(): Promise<SessionRow[]> {
    const result = await this.pool.query<SessionRowRaw>(
      `SELECT * FROM sessions WHERE phase = 'active' ORDER BY created_at ASC`,
    );
    return result.rows.map(mapRow);
  }

  async updateSessionPhase(sessionId: string, tenantId: string, phase: SessionPhaseRow): Promise<void> {
    const result = await this.pool.query(
      `UPDATE sessions SET phase = $3, updated_at = now()
       WHERE session_id = $1 AND tenant_id = $2`,
      [sessionId, tenantId, phase],
    );
    if (result.rowCount === 0) {
      throw new PersistenceError("session_not_found", "会话不存在或租户不匹配");
    }
  }

  async updateSessionSnapshotAnchor(
    sessionId: string,
    tenantId: string,
    snapshotId: string,
    latestRevision: number,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE sessions
       SET latest_snapshot_id = $3, latest_revision = $4, updated_at = now()
       WHERE session_id = $1 AND tenant_id = $2`,
      [sessionId, tenantId, snapshotId, latestRevision],
    );
    if (result.rowCount === 0) {
      throw new PersistenceError("session_not_found", "会话不存在或租户不匹配");
    }
  }

  /** 终态会话保留窗口清理(D-API-55):只清除 closed / crashed 且过期的行。 */
  async purgeTerminalSessionsBefore(cutoffIso: string): Promise<number> {
    try {
      const result = await this.pool.query(
        `DELETE FROM sessions
         WHERE phase IN ('closed', 'crashed') AND updated_at <= $1`,
        [cutoffIso],
      );
      return result.rowCount ?? 0;
    } catch (error) {
      throw new PersistenceError("store_unavailable", "终态会话清理失败", { cause: error });
    }
  }
}

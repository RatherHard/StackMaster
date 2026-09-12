/**
 * PostgreSQL 会话仓储(sessions 表;WP-3)。
 * 一切查询强制 tenantId 过滤(查询层租户校验第一层;行级租户策略为第二道
 * 结构闸,连接层经 TenantScope 逐事务 SET LOCAL 注入,D-API-101)。
 * 跨租户查询与"会话不存在"同形态返回 null(防枚举)。
 */

import type { Pool } from "pg";
import { BOOT_RECOVERY_GUC, RETENTION_PURGE_GUC, TenantScope } from "./connection.js";
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
  readonly #scope: TenantScope;

  constructor(pool: Pool) {
    this.#scope = new TenantScope(pool);
  }

  async insertSession(input: CreateSessionRowInput): Promise<SessionRow> {
    try {
      const result = await this.#scope.query<SessionRowRaw>(
        input.tenantId,
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
    // 租户过滤在 WHERE 强制(第一层);跨租户定位 = 查不到(与不存在同形态)。
    const result = await this.#scope.query<SessionRowRaw>(
      tenantId,
      `SELECT * FROM sessions WHERE session_id = $1 AND tenant_id = $2`,
      [sessionId, tenantId],
    );
    const raw = result.rows[0];
    return raw === undefined ? null : mapRow(raw);
  }

  async listSessionsByTenant(tenantId: string): Promise<SessionRow[]> {
    const result = await this.#scope.query<SessionRowRaw>(
      tenantId,
      `SELECT * FROM sessions WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [tenantId],
    );
    return result.rows.map(mapRow);
  }

  /**
   * 重启恢复枚举(D-API-63):active 行,按创建序恢复(快照锚序与之一致)。
   * 查询层租户过滤的唯一读例外(进程生命周期操作)——行级政策经
   * app.boot_recovery GUC 同构承载(007 迁移窄面政策行:仅 SELECT 放行)。
   */
  async listActiveSessions(): Promise<SessionRow[]> {
    const result = await this.#scope.lifecycleQuery<SessionRowRaw>(
      BOOT_RECOVERY_GUC,
      `SELECT * FROM sessions WHERE phase = 'active' ORDER BY created_at ASC`,
    );
    return result.rows.map(mapRow);
  }

  async updateSessionPhase(sessionId: string, tenantId: string, phase: SessionPhaseRow): Promise<void> {
    const result = await this.#scope.query(
      tenantId,
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
    const result = await this.#scope.query(
      tenantId,
      `UPDATE sessions
       SET latest_snapshot_id = $3, latest_revision = $4, updated_at = now()
       WHERE session_id = $1 AND tenant_id = $2`,
      [sessionId, tenantId, snapshotId, latestRevision],
    );
    if (result.rowCount === 0) {
      throw new PersistenceError("session_not_found", "会话不存在或租户不匹配");
    }
  }

  /**
   * 终态会话保留窗口清理(D-API-55):只清除 closed / crashed 且过期的行。
   * 行级政策形态(007 / D-API-101):RLS 下 DELETE 永不跨租户(PG 对 DELETE
   * 施加 SELECT 可见 + DELETE 政策双重谓词;零跨租户 DELETE 政策行)——
   * 清理为两段式:①app.retention_purge GUC 下枚举待清理租户(唯一跨租户
   * 读面,政策行 *_retention_tenant_scan);②逐租户删除(租户上下文注入,
   * sessions_tenant_isolation 承载)。枚举与删除间的到达行由下一清理周期
   * 收敛(保留期语义容忍)。
   */
  async purgeTerminalSessionsBefore(cutoffIso: string): Promise<number> {
    try {
      const tenants = await this.#scope.lifecycleQuery<{ tenant_id: string }>(
        RETENTION_PURGE_GUC,
        `SELECT DISTINCT tenant_id FROM sessions
         WHERE phase IN ('closed', 'crashed') AND updated_at <= $1`,
        [cutoffIso],
      );
      let purged = 0;
      for (const row of tenants.rows) {
        const result = await this.#scope.query(
          row.tenant_id,
          `DELETE FROM sessions
           WHERE phase IN ('closed', 'crashed') AND updated_at <= $1 AND tenant_id = $2`,
          [cutoffIso, row.tenant_id],
        );
        purged += result.rowCount ?? 0;
      }
      return purged;
    } catch (error) {
      throw new PersistenceError("store_unavailable", "终态会话清理失败", { cause: error });
    }
  }
}

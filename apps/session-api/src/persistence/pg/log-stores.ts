/**
 * PostgreSQL 动作日志与提交引用仓储(WP-3)。
 *
 * append-only:PostgresActionLogStore 只暴露 append 与查询接口(应用层
 * 无变更面);数据库层由触发器强制拒绝 UPDATE / DELETE / TRUNCATE
 * (D-API-22,红灯反例:append-only.integration.test.ts)。
 * 落库纪律:仅已接受动作(拒绝不入账,D-W8-9);调用方(WP-4 编排装配)
 * 保证 entries 与编排器账本同源。
 */

import type { Pool } from "pg";
import { PersistenceError } from "../errors.js";
import type {
  ActionLogEntryInput,
  ActionLogStore,
  StoredActionLogEntry,
  SubmissionRecord,
  SubmissionStore,
} from "../ports.js";

interface ActionLogRowRaw {
  id: string | number;
  session_id: string;
  client_seq: string | number;
  revision_after: string | number;
  action: unknown;
  submission_ref: string | null;
  created_at: Date;
}

export class PostgresActionLogStore implements ActionLogStore {
  constructor(private readonly pool: Pool) {}

  async append(entries: readonly ActionLogEntryInput[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    try {
      // 单语句多行插入:落库原子性与编排器账本批次同源。
      const values: unknown[] = [];
      const placeholders = entries
        .map((entry, index) => {
          const base = index * 6;
          values.push(
            entry.sessionId,
            entry.tenantId,
            entry.clientSeq,
            entry.revisionAfter,
            JSON.stringify(entry.action),
            entry.submissionRef ?? null,
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6})`;
        })
        .join(", ");
      await this.pool.query(
        `INSERT INTO action_log
           (session_id, tenant_id, client_seq, revision_after, action, submission_ref)
         VALUES ${placeholders}`,
        values,
      );
    } catch (error) {
      throw new PersistenceError("store_unavailable", "动作日志落库失败(append-only)", { cause: error });
    }
  }

  async listBySession(sessionId: string, tenantId: string): Promise<StoredActionLogEntry[]> {
    const result = await this.pool.query<ActionLogRowRaw>(
      `SELECT id, session_id, client_seq, revision_after, action, submission_ref, created_at
       FROM action_log
       WHERE session_id = $1 AND tenant_id = $2
       ORDER BY id ASC`,
      [sessionId, tenantId],
    );
    return result.rows.map((raw) => ({
      id: Number(raw.id),
      sessionId: raw.session_id,
      clientSeq: Number(raw.client_seq),
      revisionAfter: Number(raw.revision_after),
      action: raw.action,
      submissionRef: raw.submission_ref,
      createdAt: raw.created_at.toISOString(),
    }));
  }

  async countBySession(sessionId: string, tenantId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM action_log WHERE session_id = $1 AND tenant_id = $2`,
      [sessionId, tenantId],
    );
    return Number(result.rows[0]?.count ?? "0");
  }
}

interface SubmissionRowRaw {
  id: string;
  tenant_id: string;
  session_id: string;
  revision: string | number;
  public_status: string;
  reference: unknown;
  created_at: Date;
}

export class PostgresSubmissionStore implements SubmissionStore {
  constructor(private readonly pool: Pool) {}

  async record(input: {
    tenantId: string;
    sessionId: string;
    revision: number;
    publicStatus: string;
    reference: unknown;
  }): Promise<SubmissionRecord> {
    try {
      const result = await this.pool.query<SubmissionRowRaw>(
        `INSERT INTO submissions (tenant_id, session_id, revision, public_status, reference)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING *`,
        [input.tenantId, input.sessionId, input.revision, input.publicStatus, JSON.stringify(input.reference)],
      );
      const raw = result.rows[0] as SubmissionRowRaw;
      return {
        id: raw.id,
        sessionId: raw.session_id,
        revision: Number(raw.revision),
        publicStatus: raw.public_status,
        reference: raw.reference,
        createdAt: raw.created_at.toISOString(),
      };
    } catch (error) {
      throw new PersistenceError("store_unavailable", "提交引用落库失败", { cause: error });
    }
  }

  async findBySession(sessionId: string, tenantId: string): Promise<SubmissionRecord[]> {
    const result = await this.pool.query<SubmissionRowRaw>(
      `SELECT * FROM submissions WHERE session_id = $1 AND tenant_id = $2 ORDER BY created_at ASC`,
      [sessionId, tenantId],
    );
    return result.rows.map((raw) => ({
      id: raw.id,
      tenantId: raw.tenant_id,
      sessionId: raw.session_id,
      revision: Number(raw.revision),
      publicStatus: raw.public_status,
      reference: raw.reference,
      createdAt: raw.created_at.toISOString(),
    }));
  }
}

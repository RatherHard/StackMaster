/**
 * PostgreSQL 动作日志与提交引用仓储(WP-3)。
 *
 * append-only:PostgresActionLogStore 只暴露 append 与查询接口(应用层
 * 无变更面);数据库层由触发器强制拒绝 UPDATE / DELETE / TRUNCATE
 * (D-API-22,红灯反例:append-only.integration.test.ts);行级租户策略为
 * 第二道结构闸(007 迁移;连接层经 TenantScope 逐事务注入,D-API-101)。
 * 落库纪律:仅已接受动作(拒绝不入账,D-W8-9);调用方(WP-4 编排装配)
 * 保证 entries 与编排器账本同源。
 */

import type { Pool } from "pg";
import { TenantScope } from "./connection.js";
import { PersistenceError } from "../errors.js";
import type {
  ActionLogEntryInput,
  ActionLogStore,
  StoredActionLogEntry,
  SubmissionRecord,
  SubmissionStore,
  VerdictQueryStore,
  VerdictRecordPublic,
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
  readonly #scope: TenantScope;

  constructor(pool: Pool) {
    this.#scope = new TenantScope(pool);
  }

  async append(entries: readonly ActionLogEntryInput[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    try {
      // 单语句多行插入:落库原子性与编排器账本批次同源。批次同会话同源
      // (submit 引用投影),租户上下文取批次锚租户;行级政策 WITH CHECK
      // 使跨租户混批在库层确定性拒绝(fail-closed,结构上不可混写)。
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
      await this.#scope.query(
        entries[0]!.tenantId,
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
    const result = await this.#scope.query<ActionLogRowRaw>(
      tenantId,
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
    const result = await this.#scope.query<{ count: string }>(
      tenantId,
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

export class PostgresSubmissionStore implements SubmissionStore, VerdictQueryStore {
  readonly #scope: TenantScope;

  constructor(pool: Pool) {
    this.#scope = new TenantScope(pool);
  }

  async record(input: {
    tenantId: string;
    sessionId: string;
    revision: number;
    publicStatus: string;
    reference: unknown;
    logDigest: string;
  }): Promise<SubmissionRecord> {
    // 入队与提交引用同锚(D-API-85):同一事务插入 submissions 行与
    // verifier_runs pending 行(队列本体;多实例 SKIP LOCKED 认领天然安全);
    // 租户上下文经 TenantScope 事务注入(行级政策第二道闸,D-API-101)。
    return this.#scope.transaction<SubmissionRecord>(input.tenantId, async (client) => {
      try {
        const result = await client.query<SubmissionRowRaw>(
          `INSERT INTO submissions (tenant_id, session_id, revision, public_status, reference)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           RETURNING *`,
          [input.tenantId, input.sessionId, input.revision, input.publicStatus, JSON.stringify(input.reference)],
        );
        const raw: SubmissionRowRaw | undefined = result.rows[0];
        if (raw === undefined) {
          throw new PersistenceError("store_unavailable", "提交引用落库失败(无返回行)");
        }
        await client.query(
          `INSERT INTO verifier_runs (tenant_id, submission_id, status, log_digest)
           VALUES ($1, $2, 'pending', $3)`,
          [input.tenantId, raw.id, input.logDigest],
        );
        return {
          id: raw.id,
          sessionId: raw.session_id,
          revision: Number(raw.revision),
          publicStatus: raw.public_status,
          reference: raw.reference,
          createdAt: raw.created_at.toISOString(),
        };
      } catch (error) {
        // 事务回滚在 TenantScope 边界执行;此处维持既有稳定语义翻译
        // (PersistenceError 原样透传,不二次包装)。
        if (error instanceof PersistenceError) {
          throw error;
        }
        throw new PersistenceError("store_unavailable", "提交引用落库失败", { cause: error });
      }
    });
  }

  async findBySession(sessionId: string, tenantId: string): Promise<SubmissionRecord[]> {
    const result = await this.#scope.query<SubmissionRowRaw>(
      tenantId,
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

  // ── 裁决呈现面读取(阶段六 WP-63,D-API-83;只读,零写入面)──────────────

  async findSubmissionForVerdict(
    submissionId: string,
    tenantId: string,
    sessionId: string,
  ): Promise<SubmissionRecord | null> {
    // 定位链第一环(D-API-83):tenantId 与 sessionId 双条件强制(查询层
    // 租户校验,D-API-20),任一环不符 = 空集(与不存在同形,防枚举);
    // 行级政策(submissions_tenant_isolation)为同形第二道闸。
    try {
      const result = await this.#scope.query<SubmissionRowRaw>(
        tenantId,
        `SELECT * FROM submissions
         WHERE id = $1::uuid AND tenant_id = $2 AND session_id = $3`,
        [submissionId, tenantId, sessionId],
      );
      const raw = result.rows[0];
      if (raw === undefined) {
        return null;
      }
      return {
        id: raw.id,
        sessionId: raw.session_id,
        revision: Number(raw.revision),
        publicStatus: raw.public_status,
        reference: raw.reference,
        createdAt: raw.created_at.toISOString(),
      };
    } catch (error) {
      // 非法 UUID 字面等输入形态问题在路由字符集闸已被拒;到达此处的查询
      // 失败 = 存储不可用面(fail-closed 呈现 503,不静默降级)。
      throw new PersistenceError("store_unavailable", "裁决查询定位失败", { cause: error });
    }
  }

  async findVerdictBySubmissionId(
    submissionId: string,
    tenantId: string,
  ): Promise<VerdictRecordPublic | null> {
    // 定位链第二环(D-API-96):只取 11 值 verdict 与落库时刻,detail 列
    // 零读取(呈现面结构性无明细表达位)。租户绑定(查询层 WHERE + 行级
    // 政策双层):跨租户 verdict 与"未落库"同形态(恒定 pending 防枚举,
    // WP-65 微扩 tenantId 形参,D-API-101)。
    try {
      const result = await this.#scope.query<{ verdict: string; created_at: Date }>(
        tenantId,
        `SELECT verdict, created_at FROM verdicts WHERE submission_id = $1::uuid AND tenant_id = $2`,
        [submissionId, tenantId],
      );
      const raw = result.rows[0];
      if (raw === undefined) {
        return null;
      }
      return {
        verdict: raw.verdict,
        decidedAtEpochSeconds: Math.floor(raw.created_at.getTime() / 1000),
      };
    } catch (error) {
      throw new PersistenceError("store_unavailable", "裁决查询读取失败", { cause: error });
    }
  }
}

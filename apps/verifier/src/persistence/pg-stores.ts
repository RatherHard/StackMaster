/**
 * PostgreSQL 裁决域实现(WP-61;信任域 4 独立角色,最小授权)。
 *
 * - 认领:`FOR UPDATE SKIP LOCKED` 批量认领 pending 行(D-API-85;行锁
 *   认领即互斥,多 verifier 实例天然安全),同事务推进 running;
 *   已有 verdicts 行的 submission 与 run 次数耗尽的 submission 不再认领
 *   (幂等 + 重试上限的结构性表达);
 * - 完成:run → completed + verdicts 幂等写入(同一事务;ON CONFLICT
 *   DO NOTHING——同 submission 重复裁决确定性同判、不重复写入);
 * - 失败:run → failed;未达重试上限时插入新 pending run 行(重试以新
 *   run 行承载,失败细节只进受控日志,不进公开面)。
 *
 * 存储故障统一翻译 `store_unavailable`(fail-closed,不静默放行)。
 */
import { Pool } from "pg";
import type { PoolClient } from "pg";

import {
  type ClaimedRun,
  type ChallengeSource,
  type ChallengeVersionRegistration,
  type VerdictQueue,
} from "./ports.js";

/** 存储不可用(确定性错误码;细节只进受控日志)。 */
export class VerifierStoreError extends Error {
  constructor(message: string, readonly causeError?: unknown) {
    super(message);
    this.name = "VerifierStoreError";
  }
}

/** PostgreSQL 连接池(裁决域独立角色;连接失败即拒绝启动)。 */
export async function createPostgresPool(connectionString: string): Promise<Pool> {
  const pool = new Pool({ connectionString });
  try {
    await pool.query("SELECT 1");
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw new VerifierStoreError("PostgreSQL 不可达(fail-closed)", error);
  }
  return pool;
}

interface RunRowRaw {
  id: string;
  tenant_id: string;
  submission_id: string;
  log_digest: string | null;
  attempt_count: string | number;
  reference: unknown;
}

export class PostgresVerdictQueue implements VerdictQueue {
  constructor(private readonly pool: Pool) {}

  async claim(batchSize: number, maxAttempts: number): Promise<ClaimedRun[]> {
    const client = await this.withClient();
    try {
      const result = await client.query<RunRowRaw>(
        `WITH claimed AS (
           -- 每 submission 至多一条 pending 行入队(正常流程下失败重试以新行
           -- 承载、旧行已 failed,恒 ≤ 1;此处的尝试上限守卫是结构性表达)。
           -- 注意:PG 禁止 DISTINCT ON 与 FOR UPDATE 同用,故不加 DISTINCT——
           -- 认领粒度按行锁,同 submission 的残留 pending 行由 fail 收口路径
           -- 归拢(D-API-85 状态机)。
           SELECT r.id
           FROM verifier_runs r
           WHERE r.status = 'pending'
             AND NOT EXISTS (
               SELECT 1 FROM verdicts v WHERE v.submission_id = r.submission_id
             )
             AND (
               SELECT count(*) FROM verifier_runs r2
               WHERE r2.submission_id = r.submission_id
             ) <= $2
           ORDER BY r.created_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE verifier_runs r
         SET status = 'running', started_at = now()
         FROM claimed c
         WHERE r.id = c.id
         RETURNING r.id, r.tenant_id, r.submission_id, r.log_digest,
           (SELECT count(*) FROM verifier_runs r2
            WHERE r2.submission_id = r.submission_id) AS attempt_count,
           (SELECT s.reference FROM submissions s WHERE s.id = r.submission_id) AS reference`,
        [batchSize, maxAttempts],
      );
      await client.query("COMMIT");
      return result.rows.map((raw) => ({
        runId: raw.id,
        tenantId: raw.tenant_id,
        submissionId: raw.submission_id,
        logDigest: raw.log_digest,
        attemptCount: Number(raw.attempt_count),
        reference: raw.reference,
      }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new VerifierStoreError("裁决队列认领失败", error);
    } finally {
      client.release();
    }
  }

  async complete(input: {
    runId: string;
    submissionId: string;
    tenantId: string;
    verdict: string;
    detail: unknown;
  }): Promise<void> {
    const client = await this.withClient();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO verdicts (tenant_id, submission_id, verdict, detail)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (submission_id) DO NOTHING`,
        [input.tenantId, input.submissionId, input.verdict, JSON.stringify(input.detail ?? null)],
      );
      await client.query(
        `UPDATE verifier_runs SET status = 'completed', finished_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [input.runId, input.tenantId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new VerifierStoreError("裁决落库失败", error);
    } finally {
      client.release();
    }
  }

  async fail(input: {
    runId: string;
    tenantId: string;
    submissionId: string;
    attemptCount: number;
    reason: string;
    maxAttempts: number;
  }): Promise<void> {
    const client = await this.withClient();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE verifier_runs
         SET status = 'failed', finished_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [input.runId, input.tenantId],
      );
      // 重试以新 pending run 行承载;耗尽后不再入队(查询面恒为 pending),
      // 并取消同 submission 的残留 pending 行(防空转认领)。
      if (input.attemptCount < input.maxAttempts) {
        await client.query(
          `INSERT INTO verifier_runs (tenant_id, submission_id, status, log_digest)
           SELECT tenant_id, submission_id, 'pending', log_digest
           FROM verifier_runs WHERE id = $1`,
          [input.runId],
        );
      } else {
        await client.query(
          `UPDATE verifier_runs SET status = 'failed', finished_at = now()
           WHERE submission_id = $1 AND status = 'pending' AND id <> $2`,
          [input.submissionId, input.runId],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new VerifierStoreError("裁决失败态落库异常", error);
    } finally {
      client.release();
    }
  }

  async pendingCount(): Promise<number> {
    try {
      const result = await this.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM verifier_runs WHERE status = 'pending'`,
      );
      return Number(result.rows[0]?.count ?? "0");
    } catch (error) {
      throw new VerifierStoreError("队列深度查询失败", error);
    }
  }

  private async withClient(): Promise<PoolClient> {
    const client = await this.pool.connect();
    await client.query("BEGIN");
    return client;
  }
}

export class PostgresChallengeSource implements ChallengeSource {
  constructor(private readonly pool: Pool) {}

  async findVersion(
    tenantId: string,
    challengeId: string,
    contentVersion: string,
  ): Promise<ChallengeVersionRegistration | null> {
    try {
      // 查询层租户校验强制(D-API-20 延伸):跨租户与"未登记"同形态 null。
      const result = await this.pool.query<{
        private_bundle_sha256: string;
        public_descriptor_sha256: string;
        private_bundle_object: string;
        public_descriptor_object: string;
      }>(
        `SELECT private_bundle_sha256, public_descriptor_sha256,
                private_bundle_object, public_descriptor_object
         FROM challenge_versions
         WHERE challenge_id = $1 AND content_version = $2 AND tenant_id = $3`,
        [challengeId, contentVersion, tenantId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        privateBundleSha256: row.private_bundle_sha256,
        publicDescriptorSha256: row.public_descriptor_sha256,
        privateBundleObject: row.private_bundle_object,
        publicDescriptorObject: row.public_descriptor_object,
      };
    } catch (error) {
      throw new VerifierStoreError("题目登记行查询失败", error);
    }
  }
}

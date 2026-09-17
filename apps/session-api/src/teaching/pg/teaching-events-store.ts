/**
 * PostgreSQL 教学事件仓储(WP-82;D-API-149 ~ D-API-151)。
 *
 * 形态纪律:
 *  - **幂等追加**:`INSERT ... ON CONFLICT (tenant_id, kind, source_ref) DO NOTHING`
 *    ——源权威行不可变(`sessions.created_at` 创建即定、`verdicts` 单行幂等、
 *    `action_log` append-only),故冲突即同源既有行,跳过不产生漂移;
 *  - **零标识符读面**:本适配器**没有**任何返回行级数据的方法。聚合查询
 *    只在 `GROUP BY` 里消费 `subject_digest`,SELECT 列表**不含**该列
 *    (逐会话分组在库内完成,摘要不出库);返回面 = 冻结九键聚合行
 *    (`assembleAggregates` 是本仓唯一组装点,与内存实现同一数学);
 *  - **保留期两段式**(007 / D-API-101):`app.retention_purge` GUC 下枚举
 *    待清理租户 → 逐租户 `DELETE`(租户上下文注入;RLS 下 DELETE 永不跨租户);
 *  - **租户作用域**:一切语句经 `TenantScope` 逐事务 `SET LOCAL app.tenant_id`;
 *  - **口径字面单源**:kind 字面以绑定参数注入(`COLLECTIBLE_TEACHING_EVENT_KINDS`),
 *    SQL 文本内不出现 `'challenge_started'` / `'passed'` / `'undo'` 字面。
 */

import type { Pool } from "pg";

import { PersistenceError } from "../../persistence/errors.js";
import { RETENTION_PURGE_GUC, TenantScope } from "../../persistence/pg/connection.js";
import {
  assembleAggregates,
} from "../aggregate.js";
import type { ChallengeEventCounts, ChallengeFirstPassSample, ChallengeTeachingAggregate } from "../aggregate.js";
import { COLLECTIBLE_TEACHING_EVENT_KINDS } from "../kinds.js";
import type { DerivedTeachingEvent } from "../derive.js";
import type { TeachingAggregateStore, TeachingEventStore } from "../ports.js";

const [STARTED_KIND, PASSED_KIND, UNDO_KIND] = COLLECTIBLE_TEACHING_EVENT_KINDS;

/** 单语句多行插入的行数上界(9 参数 / 行 ⇒ 参数个数远低于 PG 上限)。 */
const INSERT_BATCH_ROWS = 500;

const AGGREGATE_COUNTS_SQL = `
  SELECT challenge_id,
         challenge_version,
         count(DISTINCT subject_digest) FILTER (WHERE kind = $2) AS started_sessions,
         count(DISTINCT subject_digest) FILTER (WHERE kind = $3) AS passed_sessions,
         coalesce(sum(event_count) FILTER (WHERE kind = $4), 0) AS undone_actions
  FROM teaching_events
  WHERE tenant_id = $1
  GROUP BY challenge_id, challenge_version
  ORDER BY challenge_id ASC, challenge_version ASC
`;

const AGGREGATE_FIRST_PASS_SQL = `
  SELECT grouped.challenge_id      AS challenge_id,
         grouped.challenge_version AS challenge_version,
         greatest(0, floor(extract(epoch FROM (grouped.first_passed - grouped.started_at))))::int
           AS first_pass_seconds
  FROM (
    SELECT challenge_id,
           challenge_version,
           subject_digest,
           min(occurred_at) FILTER (WHERE kind = $2) AS started_at,
           min(occurred_at) FILTER (WHERE kind = $3) AS first_passed
    FROM teaching_events
    WHERE tenant_id = $1
    GROUP BY challenge_id, challenge_version, subject_digest
  ) grouped
  WHERE grouped.started_at IS NOT NULL AND grouped.first_passed IS NOT NULL
  ORDER BY grouped.challenge_id ASC, grouped.challenge_version ASC
`;

interface AggregateCountRowRaw {
  challenge_id: string;
  challenge_version: string;
  started_sessions: string | number;
  passed_sessions: string | number;
  undone_actions: string | number;
}

interface FirstPassRowRaw {
  challenge_id: string;
  challenge_version: string;
  first_pass_seconds: string | number;
}

/** 保留期清理的租户枚举(唯一跨租户读面;GUC 由 TenantScope 注入)。 */
const RETENTION_TENANT_SCAN_SQL = `
  SELECT DISTINCT tenant_id FROM teaching_events
  WHERE occurred_at < now() - make_interval(days => $1)
`;

export class PostgresTeachingEventStore implements TeachingEventStore, TeachingAggregateStore {
  readonly #scope: TenantScope;

  constructor(pool: Pool) {
    this.#scope = new TenantScope(pool);
  }

  async appendDerived(tenantId: string, events: readonly DerivedTeachingEvent[]): Promise<number> {
    if (events.length === 0) {
      return 0;
    }
    try {
      let appended = 0;
      for (let offset = 0; offset < events.length; offset += INSERT_BATCH_ROWS) {
        const batch = events.slice(offset, offset + INSERT_BATCH_ROWS);
        const values: unknown[] = [];
        const placeholders = batch
          .map((event, index) => {
            const base = index * 9;
            values.push(
              tenantId,
              event.kind,
              new Date(event.occurredAt),
              event.challengeId,
              event.challengeVersion,
              event.subjectDigest,
              event.sourceRef,
              event.eventCount,
              event.derivation,
            );
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
          })
          .join(", ");
        const result = await this.#scope.query(
          tenantId,
          `INSERT INTO teaching_events
             (tenant_id, kind, occurred_at, challenge_id, challenge_version,
              subject_digest, source_ref, event_count, derivation)
           VALUES ${placeholders}
           ON CONFLICT (tenant_id, kind, source_ref) DO NOTHING`,
          values,
        );
        appended += result.rowCount ?? 0;
      }
      return appended;
    } catch (error) {
      throw new PersistenceError("store_unavailable", "教学事件落库失败(幂等追加)", {
        cause: error,
      });
    }
  }

  async purgeExpired(retentionDays: number): Promise<number> {
    try {
      const tenants = await this.#scope.lifecycleQuery<{ tenant_id: string }>(
        RETENTION_PURGE_GUC,
        RETENTION_TENANT_SCAN_SQL,
        [retentionDays],
      );
      let purged = 0;
      for (const row of tenants.rows) {
        const result = await this.#scope.query(
          row.tenant_id,
          `DELETE FROM teaching_events
           WHERE occurred_at < now() - make_interval(days => $1) AND tenant_id = $2`,
          [retentionDays, row.tenant_id],
        );
        purged += result.rowCount ?? 0;
      }
      return purged;
    } catch (error) {
      throw new PersistenceError("store_unavailable", "教学事件保留期清理失败", { cause: error });
    }
  }

  async aggregateByChallenge(tenantId: string): Promise<readonly ChallengeTeachingAggregate[]> {
    try {
      const { counts, samples } = await this.#scope.transaction(tenantId, async (client) => {
        const countRows = await client.query<AggregateCountRowRaw>(AGGREGATE_COUNTS_SQL, [
          tenantId,
          STARTED_KIND,
          PASSED_KIND,
          UNDO_KIND,
        ]);
        const sampleRows = await client.query<FirstPassRowRaw>(AGGREGATE_FIRST_PASS_SQL, [
          tenantId,
          STARTED_KIND,
          PASSED_KIND,
        ]);
        return { counts: countRows, samples: sampleRows };
      });

      const countAggregates: ChallengeEventCounts[] = counts.rows.map((raw) => ({
        challengeId: raw.challenge_id,
        challengeVersion: raw.challenge_version,
        startedSessions: Number(raw.started_sessions),
        passedSessions: Number(raw.passed_sessions),
        undoneActions: Number(raw.undone_actions),
      }));
      const firstPassSamples: ChallengeFirstPassSample[] = samples.rows.map((raw) => ({
        challengeId: raw.challenge_id,
        challengeVersion: raw.challenge_version,
        seconds: Number(raw.first_pass_seconds),
      }));
      // 组装点与内存实现同一函数(单一口径来源;聚合数学零第二实现)。
      return assembleAggregates(countAggregates, firstPassSamples);
    } catch (error) {
      throw new PersistenceError("store_unavailable", "教学事件聚合查询失败", { cause: error });
    }
  }
}

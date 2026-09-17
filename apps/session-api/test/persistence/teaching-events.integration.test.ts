/**
 * 容器门控集成测试:教学事件采集载体(迁移 008)、行级租户政策、保留期与
 * 采集→聚合全链路(WP-82;D-API-149 ~ D-API-151)。
 *
 * 承载面(单元测试不可及的真实库行为):
 *  - 迁移 008 结构断言:RLS ENABLE / FORCE、两段式保留期政策、kind 封闭
 *    CHECK、幂等唯一索引、append-only 触发器、序列授权;
 *  - session_app 直连红灯矩阵:跨租户 SELECT 零行、GUC 缺失零行(fail-closed)、
 *    跨租户 INSERT 拒(WITH CHECK)、跨租户 DELETE 零行、UPDATE 拒(触发器);
 *  - 采集 → 聚合全链路经 `buildTeachingCollection` **生产装配点**(不绕过);
 *  - 口径等价:载体面聚合 ≡ 权威面直接派生聚合(同一数学,两条路径);
 *  - 幂等:重放采集零新增;
 *  - 零学习者标识落库:表无 `user_id` / `session_id` 列,原始会话标识不出现在
 *    任何列拼接文本中,subject_digest 恒为 64 位 hex 且 ≠ 会话标识;
 *  - 保留期两段式:枚举读放行(政策)+ 逐租户删除;过期行被清、窗口内保留。
 *
 * 门控:SESSION_API_IT=1 才运行(globalSetup 负责 compose up --wait / down);
 * 否则整组跳过并输出跳过原因。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";

import {
  PostgresAuthoritativeTeachingSource,
  PostgresTeachingEventStore,
  TEACHING_EVENT_RETENTION_DAYS,
  aggregateFromEventRows,
  buildTeachingCollection,
  deriveTeachingEvents,
  renderTeachingAggregateReport,
  assertTeachingAggregateDiscipline,
} from "../../src/teaching/index.js";
import { createPostgresPool } from "../../src/persistence/index.js";
import {
  IT_CONFIG,
  IT_ENABLED,
  SKIP_REASON,
  ensureMigrated,
  uniqueIds,
} from "./helpers/it.js";

const SESSION_APP_URL = withRole(IT_CONFIG.postgresUrl, "session_app", "session-app-dev");

function withRole(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}

/** 租户作用域探针(镜像连接层注入语义;测试 probe 形态)。 */
async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** 播种权威行(会话 + 提交 + 通过裁决 + 一条 undo / 一条 step 动作)。 */
async function seedAuthoritative(
  pool: Pool,
  tenantId: string,
  sessionId: string,
  challengeId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO sessions
       (session_id, tenant_id, user_id, challenge_id, challenge_version, phase, seed_strategy, latest_revision)
     VALUES ($1, $2, 'user-teach-probe', $3, '1.0.0', 'active', 'fixed', 0)`,
    [sessionId, tenantId, challengeId],
  );
  const submission = await pool.query<{ id: string }>(
    `INSERT INTO submissions (tenant_id, session_id, revision, public_status, reference)
     VALUES ($1, $2, 1, 'won', '{}'::jsonb) RETURNING id`,
    [tenantId, sessionId],
  );
  await pool.query(`INSERT INTO verdicts (tenant_id, submission_id, verdict) VALUES ($1, $2, 'success')`, [
    tenantId,
    submission.rows[0]?.id,
  ]);
  await pool.query(
    `INSERT INTO action_log (tenant_id, session_id, client_seq, revision_after, action)
     VALUES ($1, $2, 1, 1, '{"type":"undo","args":{}}'::jsonb),
            ($1, $2, 2, 2, '{"type":"step","args":{}}'::jsonb)`,
    [tenantId, sessionId],
  );
}

describe.skipIf(!IT_ENABLED)("教学事件采集载体与 RLS(容器门控;WP-82)", () => {
  const tenantA = uniqueIds("teachA");
  const tenantB = uniqueIds("teachB");
  // 采集 / 聚合口径断言专用租户:**只有**由权威行派生的行(零手工探针行),
  // 使计数可逐值断言(探针行会污染同一租户的聚合,见下 RLS 红灯组)。
  const tenantC = uniqueIds("teachC");
  let pool: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    pool = await createPostgresPool(IT_CONFIG.postgresUrl, 5);
    await ensureMigrated(pool);
    appPool = await createPostgresPool(SESSION_APP_URL, 3);
    await seedAuthoritative(pool, tenantA.tenantId, tenantA.sessionId, "sm-ch01-write-basics");
    await seedAuthoritative(pool, tenantB.tenantId, tenantB.sessionId, "sm-ch03-frame-layout");
    await seedAuthoritative(pool, tenantC.tenantId, tenantC.sessionId, "sm-ch01-write-basics");
  });

  afterAll(async () => {
    await appPool.end();
    await pool.end();
  });

  it("迁移 008 已记账(采集载体落地证据)", async () => {
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM _session_api_migrations WHERE id = '008_teaching_events'`,
    );
    expect(result.rows.map((row) => row.id)).toEqual(["008_teaching_events"]);
  });

  it("RLS ENABLE + FORCE 全真(表属主同受约束;零旁路角色)", async () => {
    const result = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'teaching_events'`,
    );
    expect(result.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("政策恰两条:租户绑定 + 保留期枚举读;零全放行政策", async () => {
    const result = await pool.query<{ policyname: string; cmd: string; qual: string | null }>(
      `SELECT policyname, cmd, qual FROM pg_policies WHERE tablename = 'teaching_events' ORDER BY policyname`,
    );
    expect(result.rows.map((row) => row.policyname)).toEqual([
      "teaching_events_retention_tenant_scan",
      "teaching_events_tenant_isolation",
    ]);
    for (const row of result.rows) {
      expect(row.qual ?? "").not.toBe("true");
      expect(row.qual ?? "").toMatch(
        /current_setting\('app\.(tenant_id|retention_purge)'(::text)?, true\)/,
      );
    }
    const isolation = result.rows.find((row) => row.policyname === "teaching_events_tenant_isolation");
    expect(isolation?.cmd).toBe("ALL");
  });

  it("kind 封闭集库层强制:提示使用(不可采集类)插入被拒", async () => {
    await expect(
      pool.query(
        `INSERT INTO teaching_events
           (tenant_id, kind, occurred_at, challenge_id, challenge_version, subject_digest, source_ref, event_count, derivation)
         VALUES ($1, 'hint_used', now(), 'sm-ch01-write-basics', '1.0.0', repeat('a', 64), 'client:1', 1, 'v1')`,
        [tenantA.tenantId],
      ),
    ).rejects.toThrow(/teaching_events_kind_closed_set/);
  });

  it("count 域强制:event_count < 1 插入被拒(零 / 负计数不可表达)", async () => {
    await expect(
      pool.query(
        `INSERT INTO teaching_events
           (tenant_id, kind, occurred_at, challenge_id, challenge_version, subject_digest, source_ref, event_count, derivation)
         VALUES ($1, 'undo', now(), 'sm-ch01-write-basics', '1.0.0', repeat('b', 64), 'action:-1', 0, 'v1')`,
        [tenantA.tenantId],
      ),
    ).rejects.toThrow(/event_count/);
  });

  it("append-only:INSERT 后 UPDATE 被库层拒(改账不可能)", async () => {
    await pool.query(
      `INSERT INTO teaching_events
         (tenant_id, kind, occurred_at, challenge_id, challenge_version, subject_digest, source_ref, event_count, derivation)
       VALUES ($1, 'undo', now(), 'sm-ch01-write-basics', '1.0.0', repeat('c', 64), 'action:append-only-probe', 1, 'v1')`,
      [tenantA.tenantId],
    );
    await expect(
      pool.query(`UPDATE teaching_events SET event_count = 99 WHERE source_ref = 'action:append-only-probe'`),
    ).rejects.toThrow(/append-only/);
  });

  it("append-only:TRUNCATE 被库层拒(毁账不可能)", async () => {
    await expect(pool.query(`TRUNCATE teaching_events`)).rejects.toThrow(/append-only/);
  });

  it("fail-closed:GUC 缺失(无租户上下文)⇒ 零行", async () => {
    const result = await appPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM teaching_events`,
    );
    expect(result.rows[0]?.count).toBe("0");
  });

  it("跨租户读同形不存在:租户 A 上下文读租户 B 行 = 零行", async () => {
    const cross = await withTenant(appPool, tenantA.tenantId, (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM teaching_events WHERE tenant_id = $1`,
        [tenantB.tenantId],
      ),
    );
    expect(cross.rows[0]?.count).toBe("0");
  });

  it("跨租户写拒(WITH CHECK):租户 A 上下文写租户 B 行 = 确定性失败", async () => {
    await expect(
      withTenant(appPool, tenantA.tenantId, (client) =>
        client.query(
          `INSERT INTO teaching_events
             (tenant_id, kind, occurred_at, challenge_id, challenge_version, subject_digest, source_ref, event_count, derivation)
           VALUES ($1, 'undo', now(), 'sm-ch01-write-basics', '1.0.0', repeat('d', 64), 'action:cross-tenant', 1, 'v1')`,
          [tenantB.tenantId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("授权面:session_app 可写本租户行(SELECT / INSERT / 序列 USAGE 齐备)", async () => {
    const inserted = await withTenant(appPool, tenantA.tenantId, (client) =>
      client.query<{ count: string }>(
        `WITH ins AS (
           INSERT INTO teaching_events
             (tenant_id, kind, occurred_at, challenge_id, challenge_version, subject_digest, source_ref, event_count, derivation)
           VALUES ($1, 'undo', now(), 'sm-ch01-write-basics', '1.0.0', repeat('e', 64), 'action:grant-probe', 1, 'v1')
           RETURNING id
         ) SELECT count(*)::text AS count FROM ins`,
        [tenantA.tenantId],
      ),
    );
    expect(inserted.rows[0]?.count).toBe("1");
  });

  it("跨租户删除零行(RLS 下 DELETE 永不跨租户)", async () => {
    const deleted = await withTenant(appPool, tenantA.tenantId, (client) =>
      client.query(`DELETE FROM teaching_events WHERE tenant_id = $1`, [tenantB.tenantId]),
    );
    expect(deleted.rowCount).toBe(0);
  });

  it("采集 → 落库 → 聚合全链路(经生产装配点 buildTeachingCollection)", async () => {
    const assembly = buildTeachingCollection(pool);
    const outcome = await assembly.collector.collect(tenantC.tenantId);
    expect(outcome.failed).toBe(false);
    expect(outcome.derivedEvents).toBe(3); // 题目开始 + 通过 + 回退
    expect(outcome.appendedRows).toBe(3);

    const aggregates = await assembly.aggregates.aggregateByChallenge(tenantC.tenantId);
    const [row] = aggregates;
    expect(row).toMatchObject({
      challengeId: "sm-ch01-write-basics",
      challengeVersion: "1.0.0",
      startedSessions: 1,
      passedSessions: 1,
      completionRatio: 1,
      undoneActions: 1,
      firstPassSamples: 1,
    });
    expect(row?.firstPassSecondsP50).not.toBeNull();
    expect(row?.firstPassSecondsP95).not.toBeNull();
  });

  it("重放采集零新增(幂等锚 = 源权威行)", async () => {
    const assembly = buildTeachingCollection(pool);
    await assembly.collector.collect(tenantC.tenantId);
    const outcome = await assembly.collector.collect(tenantC.tenantId);
    expect(outcome.appendedRows).toBe(0);
    expect(outcome.derivedEvents).toBe(3);
  });

  it("口径等价:载体面聚合 ≡ 权威面直接派生聚合(同一数学两条路径)", async () => {
    const assembly = buildTeachingCollection(pool);
    await assembly.collector.collect(tenantC.tenantId);
    const source = new PostgresAuthoritativeTeachingSource(pool);
    const direct = aggregateFromEventRows(
      deriveTeachingEvents(tenantC.tenantId, await source.readAuthoritativeRows(tenantC.tenantId, null)),
    );
    expect(await assembly.aggregates.aggregateByChallenge(tenantC.tenantId)).toEqual(direct);
  });

  it("租户隔离:租户 A 聚合不含租户 B 的题目", async () => {
    const store = new PostgresTeachingEventStore(pool);
    await store.appendDerived(
      tenantB.tenantId,
      deriveTeachingEvents(tenantB.tenantId, {
        sessions: [
          {
            sessionId: tenantB.sessionId,
            challengeId: "sm-ch03-frame-layout",
            challengeVersion: "1.0.0",
            createdAt: "2026-09-17T10:00:00.000Z",
          },
        ],
        passedVerdicts: [],
        undos: [],
        truncated: false,
      }),
    );
    const rows = await store.aggregateByChallenge(tenantA.tenantId);
    expect(rows.map((row) => row.challengeId)).not.toContain("sm-ch03-frame-layout");
    expect(rows.map((row) => row.challengeId)).toEqual(["sm-ch01-write-basics"]);
  });

  it("聚合输出的纪律机检零违例(标识符 / 秘密语料 / 越界域)", async () => {
    const store = new PostgresTeachingEventStore(pool);
    const rows = await store.aggregateByChallenge(tenantA.tenantId);
    const rendered = renderTeachingAggregateReport(rows);
    expect(assertTeachingAggregateDiscipline(JSON.parse(rendered))).toEqual([]);
    expect(rows[0] === undefined ? [] : Object.keys(rows[0]).sort()).toEqual(
      [
        "challengeId",
        "challengeVersion",
        "completionRatio",
        "firstPassSamples",
        "firstPassSecondsP50",
        "firstPassSecondsP95",
        "passedSessions",
        "startedSessions",
        "undoneActions",
      ].sort(),
    );
  });

  it("零学习者标识落库:表无 user_id / session_id 列", async () => {
    const result = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'teaching_events'`,
    );
    const columns = result.rows.map((row) => row.column_name);
    expect(columns).not.toContain("user_id");
    expect(columns).not.toContain("session_id");
    expect(columns).toContain("subject_digest");
  });

  it("零学习者标识落库:原始会话标识不出现在任何列的拼接文本中", async () => {
    const result = await pool.query<{ blob: string; subject_digest: string }>(
      `SELECT (tenant_id || '|' || kind || '|' || challenge_id || '|' || challenge_version || '|' ||
               subject_digest || '|' || source_ref || '|' || derivation) AS blob,
              subject_digest
       FROM teaching_events WHERE tenant_id = $1`,
      [tenantA.tenantId],
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.blob).not.toContain(tenantA.sessionId);
      expect(row.subject_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(row.subject_digest).not.toBe(tenantA.sessionId);
    }
  });

  it("保留期:两段式第一段(枚举读)在 retention_purge GUC 下放行", async () => {
    await pool.query(
      `INSERT INTO teaching_events
         (tenant_id, kind, occurred_at, challenge_id, challenge_version, subject_digest, source_ref, event_count, derivation)
       VALUES ($1, 'undo', now() - interval '400 days', 'sm-ch01-write-basics', '1.0.0', repeat('f', 64), 'action:stale-probe', 1, 'v1')`,
      [tenantA.tenantId],
    );
    const enumerated = await withTenant(appPool, tenantA.tenantId, async (client) => {
      await client.query(`SELECT set_config('app.retention_purge', 'on', true)`);
      return client.query<{ tenant_id: string }>(
        `SELECT DISTINCT tenant_id FROM teaching_events WHERE occurred_at < now() - interval '180 days'`,
      );
    });
    expect(enumerated.rows.map((row) => row.tenant_id)).toContain(tenantA.tenantId);
  });

  it("保留期:purgeExpired(180) 清掉过期行、窗口内行保留", async () => {
    const store = new PostgresTeachingEventStore(pool);
    const purged = await store.purgeExpired(TEACHING_EVENT_RETENTION_DAYS);
    expect(purged).toBeGreaterThanOrEqual(1);
    const stale = await pool.query(
      `SELECT id FROM teaching_events WHERE source_ref = 'action:stale-probe'`,
    );
    expect(stale.rowCount).toBe(0);
    const fresh = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM teaching_events WHERE tenant_id = $1`,
      [tenantA.tenantId],
    );
    expect(Number(fresh.rows[0]?.count ?? "0")).toBeGreaterThan(0);
  });
});

// 静态断言:跳过原因文案存在(未门控运行时输出可解释信息)。
describe.skipIf(IT_ENABLED)("容器门控未开启", () => {
  it(`教学采集面集成测试整体跳过:${SKIP_REASON}`, () => {
    expect(IT_ENABLED).toBe(false);
    expect(IT_CONFIG.postgresUrl).toContain("15432");
  });
});

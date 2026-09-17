/**
 * PostgreSQL 只读实现(管理面;独立只读角色 `admin_ro`;D-API-135)。
 *
 * 纪律:
 *  - **零写面**:本文件只出现 SELECT 与事务控制;每条 SELECT 运行时仍过
 *    `assertReadOnlySql`(语句护栏)。写 / DDL / 授权关键字在本文件的 SQL
 *    文本里一次都不出现——零写由源码机检与语句护栏双重锚定。
 *  - **零私有列**:`verdicts.detail`、`submissions.reference`、
 *    `sessions.*`(除题目定位外)一律不选;字段面 = 公开登记值 + 公开裁决面。
 *  - **零租户自报**:租户来自调用方(凭证据点解析),SQL 里 `tenant_id = $1`
 *    与连接层 `SET LOCAL app.tenant_id` 双层;请求体不参与(路由全 GET)。
 *  - 存储故障统一翻译 `AdminStoreError`(fail-closed,不静默返回空页——
 *    "查不到"与"库坏了"必须可区分,后者不得伪装成"该租户没有数据")。
 */
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { VerdictResult } from "@stackmaster/protocol";

import { assertReadOnlySql, ReadOnlyViolationError } from "./read-only-guard.js";
import { AdminTenantScope } from "./pg-connection.js";
import {
  AdminStoreError,
  type AdminReadStore,
  type ChallengeRegistryEntry,
  type ChallengeVersionSummary,
  type ScoresPageQuery,
  type ScoresPageRow,
  type VerdictPageQuery,
  type VerdictPageRow,
} from "./ports.js";

/** 租户作用域内执行只读语句(语句先过护栏,返回值即被执行的那份)。 */
async function read<Row extends QueryResultRow>(
  client: PoolClient,
  sql: string,
  values: readonly unknown[],
): Promise<Row[]> {
  const guarded = assertReadOnlySql(sql);
  const result = await client.query<Row>(guarded, [...values]);
  return result.rows;
}

interface ChallengeRowRaw {
  challenge_id: string;
  title: string | null;
}

interface ChallengeVersionRowRaw {
  challenge_id: string;
  content_version: string;
  vm_profile_version: string;
  registered_at: number | string | null;
}

interface VerdictRowRaw {
  submission_id: string;
  revision: string | number;
  verdict: string | null;
  decided_at: number | string | null;
}

interface ScoreRowRaw {
  id: string;
  submission_id: string;
  session_id: string;
  challenge_id: string;
  challenge_version: string;
  verdict: string;
  decided_at: number | string | null;
}

function epochSeconds(value: number | string | null): number | null {
  if (value === null) {
    return null;
  }
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

/**
 * 题目登记列表 SQL:两条只读语句(登记行 → 版本行),`limit` 计数是
 * **题目条数**(不是行数)——按行 LIMIT 会在"某题版本多"时静默截断其它题。
 */
const CHALLENGE_PAGE_SQL = `SELECT c.challenge_id, c.title
   FROM challenges c
   WHERE c.tenant_id = $1
   ORDER BY c.challenge_id ASC
   LIMIT $2`;

const CHALLENGE_VERSIONS_SQL = `SELECT v.challenge_id, v.content_version, v.vm_profile_version,
          EXTRACT(EPOCH FROM v.registered_at)::bigint AS registered_at
   FROM challenge_versions v
   WHERE v.tenant_id = $1 AND v.challenge_id = ANY($2::text[])
   ORDER BY v.challenge_id ASC, v.content_version ASC`;

/**
 * 裁决查询 SQL:时间窗有界 + 可选精确定位。`LEFT JOIN verdicts` 使未裁决
 * 提交以 `pending` 呈现(D-API-84:裁决不可用 ≠ 判负;绝不兜底伪造裁决)。
 */
const VERDICT_PAGE_SQL = `SELECT s.id AS submission_id, s.revision::text AS revision,
          v.verdict AS verdict,
          EXTRACT(EPOCH FROM v.created_at)::bigint AS decided_at
   FROM submissions s
   LEFT JOIN verdicts v ON v.submission_id = s.id
   LEFT JOIN sessions ss ON ss.session_id = s.session_id
   WHERE s.tenant_id = $1
     AND ($2::uuid IS NULL OR s.id = $2::uuid)
     AND ($3::text IS NULL OR ss.challenge_id = $3)
     AND ($4::timestamptz IS NULL OR s.created_at >= $4::timestamptz)
     AND ($5::timestamptz IS NULL OR s.created_at <= $5::timestamptz)
   ORDER BY s.created_at DESC, s.id DESC
   LIMIT $6`;

/**
 * 成绩页 SQL:仅已裁决行(`verdicts` 内连接),keyset 游标 = `verdicts.id`
 * 升序(D-API-123:单调主键,禁以时刻为游标——毫秒截断会回退)。
 * `detail` 列结构性未选(SERVER_ONLY 面零下发)。
 */
const SCORES_PAGE_SQL = `SELECT v.id AS id, v.submission_id AS submission_id, s.session_id AS session_id,
          ss.challenge_id AS challenge_id, ss.challenge_version AS challenge_version,
          v.verdict AS verdict,
          EXTRACT(EPOCH FROM v.created_at)::bigint AS decided_at
   FROM verdicts v
   JOIN submissions s ON s.id = v.submission_id
   JOIN sessions ss ON ss.session_id = s.session_id
   WHERE v.tenant_id = $1
     AND ($2::uuid IS NULL OR v.id > $2::uuid)
   ORDER BY v.id ASC
   LIMIT $3`;

export class PostgresAdminReadStore implements AdminReadStore {
  readonly implementation = "postgres" as const;
  readonly #scope: AdminTenantScope;

  constructor(pool: Pool) {
    this.#scope = new AdminTenantScope(pool);
  }

  /** readiness 探针载体(只读 ping)。 */
  async ping(): Promise<void> {
    await this.#scope.ping();
  }

  async listChallenges(input: {
    readonly tenantId: string;
    readonly limit: number;
  }): Promise<readonly ChallengeRegistryEntry[]> {
    try {
      return await this.#scope.transaction(input.tenantId, async (client) => {
        const rows = await read<ChallengeRowRaw>(client, CHALLENGE_PAGE_SQL, [
          input.tenantId,
          input.limit,
        ]);
        if (rows.length === 0) {
          return [];
        }
        const ids = rows.map((row) => row.challenge_id);
        const versionRows = await read<ChallengeVersionRowRaw>(
          client,
          CHALLENGE_VERSIONS_SQL,
          [input.tenantId, ids],
        );
        const byChallenge = new Map<string, ChallengeVersionSummary[]>();
        for (const version of versionRows) {
          const registeredAt = epochSeconds(version.registered_at);
          if (registeredAt === null) {
            // 登记时刻不可解析 = 数据面异常,不得伪装成 0(伪造时刻会污染
            // 运营判断);fail-closed 上抛。
            throw new AdminStoreError("challenge_versions.registered_at 不可解析");
          }
          const bucket = byChallenge.get(version.challenge_id) ?? [];
          bucket.push({
            contentVersion: version.content_version,
            vmProfileVersion: version.vm_profile_version,
            registeredAtEpochSeconds: registeredAt,
          });
          byChallenge.set(version.challenge_id, bucket);
        }
        return rows.map((row) => ({
          challengeId: row.challenge_id,
          title: row.title,
          versions: byChallenge.get(row.challenge_id) ?? [],
        }));
      });
    } catch (error) {
      throw translate(error);
    }
  }

  async queryVerdicts(input: VerdictPageQuery): Promise<readonly VerdictPageRow[]> {
    try {
      return await this.#scope.transaction(input.tenantId, async (client) => {
        const rows = await read<VerdictRowRaw>(client, VERDICT_PAGE_SQL, [
          input.tenantId,
          input.submissionId ?? null,
          input.challengeId ?? null,
          input.sinceEpochSeconds === undefined
            ? null
            : new Date(input.sinceEpochSeconds * 1_000).toISOString(),
          input.untilEpochSeconds === undefined
            ? null
            : new Date(input.untilEpochSeconds * 1_000).toISOString(),
          input.limit,
        ]);
        return rows.map((row) => {
          const decidedAt = epochSeconds(row.decided_at);
          const revision = Number(row.revision);
          if (!Number.isFinite(revision)) {
            throw new AdminStoreError("submissions.revision 不可解析");
          }
          if (row.verdict === null || decidedAt === null) {
            return { submissionId: row.submission_id, revision, status: "pending", verdict: null, decidedAtEpochSeconds: null };
          }
          return {
            submissionId: row.submission_id,
            revision,
            status: "verdicted",
            verdict: row.verdict as VerdictResult,
            decidedAtEpochSeconds: decidedAt,
          };
        });
      });
    } catch (error) {
      throw translate(error);
    }
  }

  async readScoresPage(input: ScoresPageQuery): Promise<readonly ScoresPageRow[]> {
    try {
      return await this.#scope.transaction(input.tenantId, async (client) => {
        const rows = await read<ScoreRowRaw>(client, SCORES_PAGE_SQL, [
          input.tenantId,
          input.afterId ?? null,
          input.limit,
        ]);
        return rows.map((row) => {
          const decidedAt = epochSeconds(row.decided_at);
          if (decidedAt === null) {
            throw new AdminStoreError("verdicts.created_at 不可解析");
          }
          return {
            id: row.id,
            submissionId: row.submission_id,
            sessionId: row.session_id,
            challengeId: row.challenge_id,
            challengeVersion: row.challenge_version,
            verdict: row.verdict as VerdictResult,
            decidedAtEpochSeconds: decidedAt,
          };
        });
      });
    } catch (error) {
      throw translate(error);
    }
  }
}

/** 存储故障翻译:只读违规原样透出(编程错误必须响亮),其余折成 store 不可用。 */
function translate(error: unknown): unknown {
  if (error instanceof AdminStoreError || error instanceof ReadOnlyViolationError) {
    return error;
  }
  return new AdminStoreError("管理面只读存储不可用(fail-closed)", error);
}

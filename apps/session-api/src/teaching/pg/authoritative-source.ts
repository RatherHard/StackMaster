/**
 * 教学采集的权威行受控查询(WP-82;D-API-150)。
 *
 * 三条查询 = 服务端可派生三类的**唯一输入面**(口径原文见 `derive.ts`):
 *  1. 题目开始:`sessions`(会话创建事件);
 *  2. 通过:`verdicts` ⋈ `submissions` ⋈ `sessions`(成绩方向 = `success`)——
 *     经提交引用定位会话、经会话定位题目身份(会话创建时锚定的版本);
 *  3. 回退:`action_log` ⋈ `sessions`(`action->>'type' = 'undo'`;仅已接受
 *     动作入账,故口径 = 已接受回退动作数)。
 *
 * 形态纪律:
 *  - **租户作用域**:`TenantScope` 逐事务 `SET LOCAL app.tenant_id`
 *    (D-API-101),查询层 `WHERE tenant_id = $1` 与行级政策双层;
 *  - **零多余列**:三查询的 SELECT 列表只含派生所需列 —— **不读**
 *    `sessions.user_id`、`verdicts.detail`、`submissions.reference`、
 *    `action_log.action`(只取 `type` 判别字面,不经 SELECT 列表返回整对象)、
 *    以及任何私有判题面列;
 *  - **口径字面单源**:`PASSING_VERDICT` / `UNDO_ACTION_TYPE` 以绑定参数注入,
 *    SQL 文本内**不出现** `'success'` / `'undo'` 字面(机检:
 *    `test/teaching/surface-discipline.test.ts`);
 *  - **三查询同一读事务**:同一快照下读三类源行,避免跨语句的窗口漂移;
 *  - **上界不静默**:逐类 `LIMIT AUTHORITATIVE_READ_LIMIT`,命中上限置
 *    `truncated = true`(由采集结果如实透出)。
 */

import type { Pool } from "pg";

import { PersistenceError } from "../../persistence/errors.js";
import { TenantScope } from "../../persistence/pg/connection.js";
import { PASSING_VERDICT, UNDO_ACTION_TYPE } from "../kinds.js";
import { AUTHORITATIVE_READ_LIMIT } from "../ports.js";
import type {
  AuthoritativeTeachingRows,
  AuthoritativeUndoActionRow,
  AuthoritativeVerdictRow,
} from "../derive.js";
import type { AuthoritativeTeachingSource } from "../ports.js";

interface SessionRowRaw {
  session_id: string;
  challenge_id: string;
  challenge_version: string;
  created_at: Date;
}

interface VerdictRowRaw {
  verdict_id: string;
  session_id: string;
  verdict: string;
  challenge_id: string;
  challenge_version: string;
  created_at: Date;
}

interface UndoRowRaw {
  action_log_id: string;
  session_id: string;
  challenge_id: string;
  challenge_version: string;
  created_at: Date;
}

const SESSIONS_SQL = `
  SELECT session_id, challenge_id, challenge_version, created_at
  FROM sessions
  WHERE tenant_id = $1
    AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz)
  ORDER BY created_at ASC, session_id ASC
  LIMIT $3
`;

const PASSED_SQL = `
  SELECT v.id::text          AS verdict_id,
         sub.session_id      AS session_id,
         v.verdict           AS verdict,
         s.challenge_id      AS challenge_id,
         s.challenge_version AS challenge_version,
         v.created_at        AS created_at
  FROM verdicts v
  JOIN submissions sub
    ON sub.id = v.submission_id AND sub.tenant_id = v.tenant_id
  JOIN sessions s
    ON s.session_id = sub.session_id AND s.tenant_id = v.tenant_id
  WHERE v.tenant_id = $1
    AND v.verdict = $3
    AND ($2::timestamptz IS NULL OR v.created_at > $2::timestamptz)
  ORDER BY v.created_at ASC, v.id ASC
  LIMIT $4
`;

const UNDO_SQL = `
  SELECT a.id::text          AS action_log_id,
         a.session_id        AS session_id,
         s.challenge_id      AS challenge_id,
         s.challenge_version AS challenge_version,
         a.created_at        AS created_at
  FROM action_log a
  JOIN sessions s
    ON s.session_id = a.session_id AND s.tenant_id = a.tenant_id
  WHERE a.tenant_id = $1
    AND a.action->>'type' = $3
    AND ($2::timestamptz IS NULL OR a.created_at > $2::timestamptz)
  ORDER BY a.id ASC
  LIMIT $4
`;

export class PostgresAuthoritativeTeachingSource implements AuthoritativeTeachingSource {
  readonly #scope: TenantScope;

  constructor(pool: Pool) {
    this.#scope = new TenantScope(pool);
  }

  async readAuthoritativeRows(
    tenantId: string,
    sinceIso: string | null,
  ): Promise<AuthoritativeTeachingRows> {
    try {
      const { sessions, passed, undos } = await this.#scope.transaction(tenantId, async (client) => ({
        sessions: await client.query<SessionRowRaw>(SESSIONS_SQL, [
          tenantId,
          sinceIso,
          AUTHORITATIVE_READ_LIMIT,
        ]),
        passed: await client.query<VerdictRowRaw>(PASSED_SQL, [
          tenantId,
          sinceIso,
          PASSING_VERDICT,
          AUTHORITATIVE_READ_LIMIT,
        ]),
        undos: await client.query<UndoRowRaw>(UNDO_SQL, [
          tenantId,
          sinceIso,
          UNDO_ACTION_TYPE,
          AUTHORITATIVE_READ_LIMIT,
        ]),
      }));

      const passedVerdicts: AuthoritativeVerdictRow[] = passed.rows.map((raw) => ({
        verdictId: raw.verdict_id,
        sessionId: raw.session_id,
        verdict: raw.verdict,
        challengeId: raw.challenge_id,
        challengeVersion: raw.challenge_version,
        createdAt: raw.created_at.toISOString(),
      }));
      const undoRows: AuthoritativeUndoActionRow[] = undos.rows.map((raw) => ({
        actionLogId: raw.action_log_id,
        sessionId: raw.session_id,
        challengeId: raw.challenge_id,
        challengeVersion: raw.challenge_version,
        createdAt: raw.created_at.toISOString(),
      }));

      return {
        sessions: sessions.rows.map((raw) => ({
          sessionId: raw.session_id,
          challengeId: raw.challenge_id,
          challengeVersion: raw.challenge_version,
          createdAt: raw.created_at.toISOString(),
        })),
        passedVerdicts,
        undos: undoRows,
        truncated:
          sessions.rows.length >= AUTHORITATIVE_READ_LIMIT ||
          passed.rows.length >= AUTHORITATIVE_READ_LIMIT ||
          undos.rows.length >= AUTHORITATIVE_READ_LIMIT,
      };
    } catch (error) {
      throw new PersistenceError("store_unavailable", "教学事件权威行读取失败", { cause: error });
    }
  }
}

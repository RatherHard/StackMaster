/**
 * PostgreSQL 宿主成绩同步读取适配器(中期 M3 WP-78;D-API-122 ~ D-API-126)。
 *
 * 形态纪律:
 *  - **只读**:本适配器只有 `listScores` 一个方法——零 INSERT / UPDATE /
 *    DELETE,零 DDL(表结构与迁移零改动:既有 `verdicts` / `submissions` /
 *    `sessions` 三表 + 既有 GRANT 面 `session_app` 足够承载本查询);
 *  - **租户作用域**:自有 `TenantScope` 实例,逐租户事务内 `SET LOCAL
 *    app.tenant_id`(D-API-101)——租户集合由**认证上下文**派生(凭证绑定
 *    白名单,O-MP-6),查询层 WHERE 与行级政策双层强制,集合外租户结构性
 *    不可达(跨租户与"不存在"同形态);
 *  - **私有列零读取**:SELECT 列表不含 `verdicts.detail`、不含
 *    `submissions.reference`、不含 `verifier_runs` 任何列——SERVER_ONLY
 *    面在 SQL 层即不出现(不是"读了再脱敏");
 *  - **游标 = `verdicts.id`(UUID 全序)keyset**:`id > $cursor ORDER BY id
 *    ASC`,不使用 `created_at`(D-API-92 教训:库内微秒时刻经 JS Date 截断
 *    会回退、末行被重复选中);`verdicts.id` 为 `gen_random_uuid()` 生成,
 *    故本 keyset 保证的是「键全序确定 + 游标严格前进 + 分页零重复」,
 *    **不承诺并发插入下零遗漏**(新行 id 随机落位,可能落在游标之前)——
 *    该限制如实登记于 D-API-123,契约为不透明游标,后续增列单调序列属
 *    additive 演进;
 *  - **多租户合并**:绑定集合含 N 个租户时逐租户 fan-out 取前 limit+1 行,
 *    再按 id 全局归并取前 limit+1 行(正确性:某租户第 limit+2 行不可能
 *    进入全局前 limit+1)。集合规模按 O-MP-6 是「单宿主 / 单租户或少量
 *    租户」,顺序 fan-out 的往返成本可接受;UUID 规范文本的字典序与 PG
 *    的 `uuid` 字节序一致(hyphen 位置固定、十六进制小写),故 TS 侧归并
 *    与库内 ORDER BY 同序。
 */
import type { Pool } from "pg";
import { TenantScope } from "./connection.js";
import { PersistenceError } from "../errors.js";
import type {
  HostScorePageQuery,
  HostScoreRecordRow,
  HostScoresQueryStore,
} from "../ports.js";

interface HostScoreRowRaw {
  id: string;
  submission_id: string;
  session_id: string;
  challenge_id: string;
  challenge_version: string;
  verdict: string;
  created_at: Date;
}

/**
 * 单租户一页查询。三表内连接:裁决行 → 提交引用(`session_id`)→ 会话行
 * (题目标识)。连接条件全部带 `tenant_id` 全等(即使 RLS 已强制,查询层
 * 仍独立成立——D-API-20 双层纪律)。
 */
const HOST_SCORES_PAGE_SQL = `
  SELECT v.id::text             AS id,
         v.submission_id::text  AS submission_id,
         sub.session_id         AS session_id,
         s.challenge_id         AS challenge_id,
         s.challenge_version    AS challenge_version,
         v.verdict              AS verdict,
         v.created_at           AS created_at
  FROM verdicts v
  JOIN submissions sub
    ON sub.id = v.submission_id AND sub.tenant_id = v.tenant_id
  JOIN sessions s
    ON s.session_id = sub.session_id AND s.tenant_id = v.tenant_id
  WHERE v.tenant_id = $1
    AND ($2::uuid IS NULL OR v.id > $2::uuid)
  ORDER BY v.id ASC
  LIMIT $3
`;

export class PostgresHostScoresStore implements HostScoresQueryStore {
  readonly #scope: TenantScope;

  constructor(pool: Pool) {
    this.#scope = new TenantScope(pool);
  }

  async listScores(query: HostScorePageQuery): Promise<readonly HostScoreRecordRow[]> {
    // 多取一行 = "是否还有下一页"的探测(调用方裁掉探测行并据此定 nextCursor)。
    const probe = query.limit + 1;
    try {
      const merged: HostScoreRecordRow[] = [];
      for (const tenantId of query.tenantIds) {
        const result = await this.#scope.query<HostScoreRowRaw>(tenantId, HOST_SCORES_PAGE_SQL, [
          tenantId,
          query.afterId,
          probe,
        ]);
        for (const raw of result.rows) {
          merged.push({
            id: raw.id,
            submissionId: raw.submission_id,
            sessionId: raw.session_id,
            challengeId: raw.challenge_id,
            challengeVersion: raw.challenge_version,
            verdict: raw.verdict,
            decidedAtEpochSeconds: Math.floor(raw.created_at.getTime() / 1000),
          });
        }
      }
      // 跨租户全局 keyset 序归并(与库内 UUID 字节序同序,见文件头说明)。
      merged.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      return merged.slice(0, probe);
    } catch (error) {
      throw new PersistenceError("store_unavailable", "宿主成绩读取失败", { cause: error });
    }
  }
}

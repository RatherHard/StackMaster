/**
 * 成绩导出装配(管理面;复用 WP-78 冻结契约,禁写第二套实现;D-API-135)。
 *
 * ── 唯一出口 ─────────────────────────────────────────────────────────
 * 本模块是管理面产出成绩载荷的**唯一**位置,出口必经
 * `HostScoresResponseSchema.parse()`(WP-78 / D-API-122 ~ D-API-126 冻结的
 * 契约,`packages/protocol/src/host-scores/host-scores-response.ts`):
 *  - 顶层信封恒为 `{ items, nextCursor }` 两个键(strictObject:多一个键即拒);
 *  - 逐条记录恒为七字段(同 strictObject);字段集由契约 schema 决定,
 *    管理面**不手写第二份字段清单**;
 *  - 空页 ⇒ `nextCursor` 必为 `null`(跨字段耦合由 schema 的 `superRefine`
 *    机器强制:空页 + 非空游标会构成无限翻页回路)。
 * 换言之:管理面的成绩导出与 WP-78 宿主面**同契约、同语义**,差别只在
 * 认证面(管理面凭证 vs 宿主后端凭证)与租户绑定来源——服务语义(keyset
 * 游标 / 批量上限 / 终态形态)逐字同源。
 *
 * ── 游标语义 ─────────────────────────────────────────────────────────
 * 排序键 = `verdicts.id`(服务端裁决行主键,全序),`id > afterId` 升序
 * keyset;**禁止以时刻为游标**(D-API-123:毫秒截断会让末行被重复选中)。
 * 探测写法:向存储多要一行(`limit + 1`),多出来的那行不进入载荷,只用于
 * 判定"还有数据"——`nextCursor` = 本页末行 `id`,无更多数据恒为 `null`
 * (键恒在,不省略)。空页 ⇒ 本页无末行 ⇒ `nextCursor = null`,与上面的
 * 跨字段耦合天然一致(不是巧合,是同一条件的两侧)。
 */
import {
  HostScoreRecordSchema,
  HostScoresResponseSchema,
  type HostScoresResponse,
} from "@stackmaster/protocol";

import type { AdminReadStore, ScoresPageRow } from "../persistence/ports.js";

/**
 * 单条成绩记录字段集(由**契约 schema** 派生,不是第二份手写清单:
 * 契约增删字段时本常量随之变化,漂移不可能静默)。
 */
export const HOST_SCORE_RECORD_FIELDS: readonly string[] = Object.keys(
  HostScoreRecordSchema.shape,
);

/** 单条成绩原始行 → 契约记录(逐字段显式映射:没有 `...row` 扩散,故不可能带入契约外列)。 */
function toRecord(row: ScoresPageRow): Record<string, unknown> {
  return {
    id: row.id,
    submissionId: row.submissionId,
    sessionId: row.sessionId,
    challengeId: row.challengeId,
    challengeVersion: row.challengeVersion,
    verdict: row.verdict,
    decidedAt: row.decidedAtEpochSeconds,
  };
}

export interface ExportHostScoresInput {
  readonly store: AdminReadStore;
  /** 凭证绑定解析后的租户(绝不来自请求体)。 */
  readonly tenantId: string;
  /** 单页条数(调用方已过天花板闸)。 */
  readonly limit: number;
  /** 上一页末行 `id`(`id > afterId` 升序 keyset)。 */
  readonly afterId?: string;
}

/**
 * 导出单页成绩(契约出口 = `HostScoresResponseSchema.parse`)。
 *
 * 存储异常原样上抛(不吞成空页):"该租户没有成绩"与"存储不可用"必须
 * 可区分——后者伪装成空批会让运营误判为"没有数据"。
 */
export async function exportHostScores(input: ExportHostScoresInput): Promise<HostScoresResponse> {
  const probe = await input.store.readScoresPage({
    tenantId: input.tenantId,
    limit: input.limit + 1,
    ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
  });
  const page = probe.slice(0, input.limit);
  const hasMore = probe.length > input.limit;
  const last = page.length > 0 ? page[page.length - 1] : undefined;
  const payload = {
    items: page.map(toRecord),
    nextCursor: hasMore && last !== undefined ? last.id : null,
  };
  // 唯一出口:契约不通过即抛(500 兜底:绝不下发非契约形态)。
  return HostScoresResponseSchema.parse(payload);
}

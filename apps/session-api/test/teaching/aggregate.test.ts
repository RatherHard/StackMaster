/**
 * 教学事件聚合与 D-API-107 每题观察点对齐(单元测试;WP-82;D-API-151)。
 *
 * 断言面:聚合数值口径(会话去重 / 回退计数 / 完成率 / 首次通过耗时分位)、
 * 输出面零学习者标识(键集冻结)、以及 8 题 × 3 项观察点登记与题目集的
 * 逐字同源与可得性归类计数(12 / 2 / 7 / 2 / 1,与首轮试用报告模板 §三 结论
 * 表逐数一致)。
 */

import { describe, expect, it } from "vitest";

import { MVP_CHALLENGES, MVP_CHALLENGE_IDS } from "../mvp-challenges/corpus.js";
import {
  D_API_107_OBSERVATION_ALIGNMENT,
  TEACHING_AGGREGATE_FIELDS,
  aggregateFromEventRows,
  availabilityOf,
  availabilityTally,
  observationAlignmentOf,
  quantileNearestRank,
  renderTeachingAggregateReport,
} from "../../src/teaching/index.js";
import type { ObservationSource, TeachingEventRow } from "../../src/teaching/index.js";

/** 摘要按序号构造(测试内形态;长度 64 hex 与生产派生同形)。 */
function digest(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function event(partial: Partial<TeachingEventRow> & Pick<TeachingEventRow, "kind">): TeachingEventRow {
  return {
    occurredAt: "2026-09-17T10:00:00.000Z",
    challengeId: "sm-ch01-write-basics",
    challengeVersion: "1.0.0",
    subjectDigest: digest(1),
    eventCount: 1,
    ...partial,
  };
}

describe("聚合数值口径", () => {
  const rows: TeachingEventRow[] = [
    // 会话 1:开始 10:00:00 → 通过 10:01:00(60s)
    event({ kind: "challenge_started", subjectDigest: digest(1), occurredAt: "2026-09-17T10:00:00.000Z" }),
    event({ kind: "passed", subjectDigest: digest(1), occurredAt: "2026-09-17T10:01:00.000Z" }),
    // 会话 2:开始 → 通过 10:04:00(240s)
    event({ kind: "challenge_started", subjectDigest: digest(2), occurredAt: "2026-09-17T10:00:00.000Z" }),
    event({ kind: "passed", subjectDigest: digest(2), occurredAt: "2026-09-17T10:04:00.000Z" }),
    // 会话 2 二次通过(更晚;不改变首次通过耗时,不重复计入通过会话数)
    event({ kind: "passed", subjectDigest: digest(2), occurredAt: "2026-09-17T10:09:00.000Z" }),
    // 会话 3:开始未通过
    event({ kind: "challenge_started", subjectDigest: digest(3), occurredAt: "2026-09-17T10:00:00.000Z" }),
    // 回退:会话 1 两次 + 会话 3 一次
    event({ kind: "undo", subjectDigest: digest(1), occurredAt: "2026-09-17T10:00:10.000Z" }),
    event({ kind: "undo", subjectDigest: digest(1), occurredAt: "2026-09-17T10:00:20.000Z" }),
    event({ kind: "undo", subjectDigest: digest(3), occurredAt: "2026-09-17T10:00:30.000Z" }),
  ];

  it("按会话去重计数 + 回退动作求和 + 首次通过耗时分位", () => {
    const [row] = aggregateFromEventRows(rows);
    expect(row).toMatchObject({
      challengeId: "sm-ch01-write-basics",
      challengeVersion: "1.0.0",
      startedSessions: 3,
      passedSessions: 2,
      undoneActions: 3,
      firstPassSamples: 2,
      // nearest-rank:p50(n=2) = ceil(0.5×2)=1 ⇒ 60;p95 = ceil(0.95×2)=2 ⇒ 240
      firstPassSecondsP50: 60,
      firstPassSecondsP95: 240,
      completionRatio: 0.6667,
    });
  });

  it("完成率四位小数;分母为 0 ⇒ null(不伪造 0)", () => {
    const [row] = aggregateFromEventRows([
      event({ kind: "passed", subjectDigest: digest(1) }),
      event({ kind: "passed", subjectDigest: digest(2) }),
    ]);
    expect(row).toMatchObject({
      startedSessions: 0,
      passedSessions: 2,
      completionRatio: null,
      firstPassSamples: 0,
      firstPassSecondsP50: null,
      firstPassSecondsP95: null,
    });
  });

  it("缺题目开始的通过事件计入通过会话数,但不产生耗时样本(不凑分位)", () => {
    const [row] = aggregateFromEventRows([
      event({ kind: "challenge_started", subjectDigest: digest(1) }),
      event({ kind: "passed", subjectDigest: digest(2), occurredAt: "2026-09-17T10:05:00.000Z" }),
    ]);
    expect(row).toMatchObject({ startedSessions: 1, passedSessions: 1, firstPassSamples: 0 });
  });

  it("同题不同版本分组成独立行,输出按题目 + 版本升序", () => {
    const rows2: TeachingEventRow[] = [
      event({ kind: "challenge_started", challengeId: "sm-ch02-little-endian", challengeVersion: "2.0.0" }),
      event({ kind: "challenge_started", challengeId: "sm-ch01-write-basics", challengeVersion: "1.0.0" }),
      event({ kind: "challenge_started", challengeId: "sm-ch01-write-basics", challengeVersion: "2.0.0" }),
    ];
    const result = aggregateFromEventRows(rows2);
    expect(result.map((row) => `${row.challengeId}@${row.challengeVersion}`)).toEqual([
      "sm-ch01-write-basics@1.0.0",
      "sm-ch01-write-basics@2.0.0",
      "sm-ch02-little-endian@2.0.0",
    ]);
  });

  it("负耗时(时钟回退形态)夹取为 0;分位规则逐档可验", () => {
    const [row] = aggregateFromEventRows([
      event({ kind: "challenge_started", occurredAt: "2026-09-17T10:05:00.000Z" }),
      event({ kind: "passed", occurredAt: "2026-09-17T10:00:00.000Z" }),
    ]);
    expect(row?.firstPassSecondsP50).toBe(0);
    expect(quantileNearestRank([], 0.5)).toBeNull();
    expect(quantileNearestRank([5], 0.95)).toBe(5);
    expect(quantileNearestRank([5, 9], 0.5)).toBe(5);
    expect(quantileNearestRank([5, 9, 12, 40], 0.5)).toBe(9);
    expect(quantileNearestRank([5, 9, 12, 40], 0.95)).toBe(40);
  });

  it("空输入 ⇒ 空输出(无占位聚合行)", () => {
    expect(aggregateFromEventRows([])).toEqual([]);
  });
});

describe("聚合输出面零学习者标识", () => {
  it("键集恒等冻结九键,输出不含会话摘要 / 源锚 / 租户", () => {
    const rows = [
      event({ kind: "challenge_started", subjectDigest: digest(7) }),
      event({ kind: "passed", subjectDigest: digest(7) }),
    ];
    const rendered = renderTeachingAggregateReport(aggregateFromEventRows(rows));
    const parsed = JSON.parse(rendered) as { aggregates: Record<string, unknown>[] };
    for (const row of parsed.aggregates) {
      expect(Object.keys(row).sort()).toEqual([...TEACHING_AGGREGATE_FIELDS].sort());
    }
    expect(rendered).not.toContain(digest(7));
    expect(rendered).not.toContain("subjectDigest");
    expect(rendered).not.toContain("sourceRef");
    expect(rendered).not.toContain("tenantId");
  });
});

describe("D-API-107 八题 × 三项观察点对齐", () => {
  it("登记 8 题,challengeId 集与题目集单一来源恒等", () => {
    expect(D_API_107_OBSERVATION_ALIGNMENT).toHaveLength(8);
    expect(D_API_107_OBSERVATION_ALIGNMENT.map((entry) => entry.challengeId)).toEqual([
      ...MVP_CHALLENGE_IDS,
    ]);
  });

  it("每题恰 3 项;标签逐字等于题目集 observationPoints(漂移即红)", () => {
    for (const alignment of D_API_107_OBSERVATION_ALIGNMENT) {
      const challenge = MVP_CHALLENGES.find(
        (candidate) => candidate.meta.challengeId === alignment.challengeId,
      );
      expect(challenge).toBeDefined();
      expect(challenge?.meta.observationPoints).toEqual([...alignment.corpusPoints]);
      expect(alignment.points).toHaveLength(3);
      expect(alignment.points.every((point) => point.point !== "")).toBe(true);
    }
  });

  it("可得性归类计数 = 12 可采集 / 2 部分 / 7 暂不可采集 / 2 人工抽样 / 1 待补取证", () => {
    const tally = availabilityTally();
    expect(tally).toEqual({
      collectible: 12,
      partial: 2,
      not_collectible_v1: 7,
      manual_sampling: 2,
      pending_evidence: 1,
    });
    expect(Object.values(tally).reduce((sum, count) => sum + count, 0)).toBe(24);
  });

  it("「提示使用等级」三格(CH-01 / 02 / 06)逐格登记为暂不可采集", () => {
    const hintCells = D_API_107_OBSERVATION_ALIGNMENT.flatMap((entry) =>
      entry.points.filter((point) => point.point === "提示使用等级"),
    );
    expect(hintCells).toHaveLength(3);
    for (const cell of hintCells) {
      expect(availabilityOf(cell.source)).toBe("not_collectible_v1");
      expect(cell.source.via).toBe("not_collectible_v1");
      if (cell.source.via === "not_collectible_v1") {
        expect(cell.source.reason).toContain("不得靠客户端自报");
        expect(cell.source.trigger).not.toBe("");
      }
    }
  });

  it("回退次数与完成率 / 首次成功时间的聚合格指向冻结字段", () => {
    const aggregateFields = D_API_107_OBSERVATION_ALIGNMENT.flatMap((entry) =>
      entry.points.flatMap((point) =>
        point.source.via === "teaching_aggregate" ? [point.source.aggregateField] : [],
      ),
    );
    for (const field of aggregateFields) {
      expect(TEACHING_AGGREGATE_FIELDS as readonly string[]).toContain(field);
    }
    expect(aggregateFields.filter((field) => field === "undoneActions")).toHaveLength(2);
    expect(aggregateFields.filter((field) => field === "completionRatio")).toHaveLength(3);
    expect(aggregateFields.filter((field) => field === "firstPassSecondsP50")).toHaveLength(4);
  });

  it("来源面 → 可得性归类映射封闭(六种来源各有归类,无落空)", () => {
    const sources: ObservationSource[] = [
      { via: "teaching_aggregate", aggregateField: "completionRatio" },
      { via: "metrics_family", family: "session_api_action_rtt_seconds" },
      { via: "controlled_query", table: "verdicts" },
      { via: "partial", collected: "a", missing: "b" },
      { via: "manual_interview" },
      { via: "pending_evidence", reason: "r" },
      { via: "not_collectible_v1", reason: "r", trigger: "t" },
    ];
    expect(sources.map(availabilityOf)).toEqual([
      "collectible",
      "collectible",
      "collectible",
      "partial",
      "manual_sampling",
      "pending_evidence",
      "not_collectible_v1",
    ]);
  });

  it("未登记题查表返回 null(不猜测、不默认)", () => {
    expect(observationAlignmentOf("sm-ch01-write-basics")).not.toBeNull();
    expect(observationAlignmentOf("sm-ch99-absent")).toBeNull();
  });
});

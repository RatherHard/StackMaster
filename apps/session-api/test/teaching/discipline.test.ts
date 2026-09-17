/**
 * 教学聚合输出的纪律机检(单元测试;WP-82;D-API-151)。
 *
 * 纪律:与 `/metrics` 面的 `assertMetricsTextDiscipline` 同款(越名 / 越标签 /
 * 标识符形态值 / 秘密语料),但教学采集面**不经 `/metrics` 通道**,故此处
 * 是它的独立机检落点。本文件按「扫描器自检纪律」(数据分类清单 §九:每条
 * 规则必须有红灯反例)为八类违例逐条给出可检出反例。
 */

import { describe, expect, it } from "vitest";

import {
  TEACHING_AGGREGATE_FIELDS,
  aggregateFromEventRows,
  assertTeachingAggregateDiscipline,
  renderTeachingAggregateReport,
} from "../../src/teaching/index.js";
import type { ChallengeTeachingAggregate, TeachingEventRow } from "../../src/teaching/index.js";

const DIGEST = "a".repeat(64);

function eventRows(): TeachingEventRow[] {
  return [
    {
      kind: "challenge_started",
      occurredAt: "2026-09-17T10:00:00.000Z",
      challengeId: "sm-ch01-write-basics",
      challengeVersion: "1.0.0",
      subjectDigest: DIGEST,
      eventCount: 1,
    },
    {
      kind: "passed",
      occurredAt: "2026-09-17T10:01:00.000Z",
      challengeId: "sm-ch01-write-basics",
      challengeVersion: "1.0.0",
      subjectDigest: DIGEST,
      eventCount: 1,
    },
  ];
}

function greenRow(): ChallengeTeachingAggregate {
  const rows = aggregateFromEventRows(eventRows());
  expect(rows).toHaveLength(1);
  return rows[0] as ChallengeTeachingAggregate;
}

/** 构造 `{aggregates: [row]}` 形态(含越面字段注入)。 */
function report(row: Record<string, unknown>): unknown {
  return { aggregates: [row] };
}

describe("合法输出零违例(绿线)", () => {
  it("真实聚合输出经机检零违例", () => {
    const rendered = renderTeachingAggregateReport(aggregateFromEventRows(eventRows()));
    expect(assertTeachingAggregateDiscipline(JSON.parse(rendered))).toEqual([]);
  });

  it("聚合行键集恒等冻结九键(零标识符字段在场)", () => {
    const row = greenRow();
    expect(Object.keys(row).sort()).toEqual([...TEACHING_AGGREGATE_FIELDS].sort());
    // 逐会话摘要与源锚不在输出面(结构性无表达位)。
    expect(JSON.stringify(row)).not.toContain(DIGEST);
  });
});

describe("违例检出(红灯反例;八类逐条)", () => {
  it("malformed-aggregate-report:顶层形态非法", () => {
    for (const bad of [null, 42, "x", [], { rows: [] }]) {
      const violations = assertTeachingAggregateDiscipline(bad);
      expect(violations.some((v) => v.id === "malformed-aggregate-report")).toBe(true);
    }
  });

  it("unknown-aggregate-field:出现冻结九键之外的字段(含顶层越面键)", () => {
    const violations = assertTeachingAggregateDiscipline(
      report({ ...greenRow(), subjectDigest: DIGEST }),
    );
    expect(violations.map((v) => v.id)).toContain("unknown-aggregate-field");
    const topLevel = assertTeachingAggregateDiscipline({
      aggregates: [greenRow()],
      tenantId: "tenant-1",
    });
    expect(topLevel.map((v) => v.id)).toContain("unknown-aggregate-field");
  });

  it("missing-aggregate-field:缺冻结字段", () => {
    const row = { ...greenRow() } as Record<string, unknown>;
    delete row["completionRatio"];
    const violations = assertTeachingAggregateDiscipline(report(row));
    expect(violations.map((v) => v.id)).toContain("missing-aggregate-field");
  });

  it("non-scalar-aggregate-value:对象 / 数组值(行级载荷走私无表达位)", () => {
    for (const value of [{ userId: "u1" }, ["u1"], [{ sessionId: "sess-abcdefgh" }]]) {
      const violations = assertTeachingAggregateDiscipline(
        report({ ...greenRow(), startedSessions: value }),
      );
      expect(violations.map((v) => v.id)).toContain("non-scalar-aggregate-value");
    }
  });

  it("out-of-domain-value:域违规与计数不自洽", () => {
    const negative = assertTeachingAggregateDiscipline(report({ ...greenRow(), undoneActions: -1 }));
    expect(negative.map((v) => v.id)).toContain("out-of-domain-value");

    const ratio = assertTeachingAggregateDiscipline(report({ ...greenRow(), completionRatio: 1.5 }));
    expect(ratio.map((v) => v.id)).toContain("out-of-domain-value");

    const inconsistent = assertTeachingAggregateDiscipline(
      report({ ...greenRow(), startedSessions: 1, passedSessions: 2 }),
    );
    expect(inconsistent.map((v) => v.id)).toContain("out-of-domain-value");

    const samples = assertTeachingAggregateDiscipline(
      report({ ...greenRow(), firstPassSamples: 99 }),
    );
    expect(samples.map((v) => v.id)).toContain("out-of-domain-value");
  });

  it("unbounded-enum-value:题目标识 / 版本越出有界字符集", () => {
    const idViolations = assertTeachingAggregateDiscipline(
      report({ ...greenRow(), challengeId: "SM-CH01/UPPER" }),
    );
    expect(idViolations.map((v) => v.id)).toContain("unbounded-enum-value");

    const versionViolations = assertTeachingAggregateDiscipline(
      report({ ...greenRow(), challengeVersion: "v1" }),
    );
    expect(versionViolations.map((v) => v.id)).toContain("unbounded-enum-value");
  });

  it("identifier-shaped-value:服务端签发标识符 / UUID / 摘要形态值", () => {
    const sessionShaped = assertTeachingAggregateDiscipline(
      report({ ...greenRow(), challengeVersion: "1.0.0" }),
    );
    expect(sessionShaped).toEqual([]); // 绿线对照:合法版本图案不误报

    // 会话标识形态藏在字符串值里(哪怕字段形态合法)。
    const row = { ...greenRow(), challengeId: "sm-ch01-write-basics" } as Record<string, unknown>;
    row["challengeVersion"] = "1.0.0"; // 版本合法 ⇒ 违例只能来自文本扫描
    const injected = JSON.parse(
      JSON.stringify({ aggregates: [row] }).replace("sm-ch01-write-basics", "sess-abcdefgh1234"),
    );
    expect(assertTeachingAggregateDiscipline(injected).map((v) => v.id)).toContain(
      "identifier-shaped-value",
    );
  });

  it("identifier-shaped-value:UUID 形态与 SHA-256 摘要形态分别可检出", () => {
    const uuidShaped = assertTeachingAggregateDiscipline({
      aggregates: [
        {
          ...greenRow(),
          challengeId: "8f14e45f-ceea-4a1e-9c1e-2b0b0a1b2c3d",
        },
      ],
    });
    expect(uuidShaped.map((v) => v.id)).toContain("identifier-shaped-value");

    const digestShaped = assertTeachingAggregateDiscipline({
      aggregates: [{ ...greenRow(), challengeId: DIGEST }],
    });
    expect(digestShaped.map((v) => v.id)).toContain("identifier-shaped-value");
  });

  it("secret-corpus-hit:ZR-B1 flag 语料命中可检出", () => {
    const violations = assertTeachingAggregateDiscipline({
      aggregates: [{ ...greenRow(), challengeId: "FLAG{red-light-corpus}" }],
    });
    expect(violations.map((v) => v.id)).toContain("secret-corpus-hit");
  });

  it("秘密语料:seed 样式(32~128 hex)命中可检出", () => {
    const violations = assertTeachingAggregateDiscipline({
      aggregates: [{ ...greenRow(), challengeVersion: "0".repeat(32) }],
    });
    expect(violations.map((v) => v.id)).toContain("secret-corpus-hit");
  });
});

describe("规范化渲染确定性", () => {
  it("两次渲染逐字节相同(键序 = 冻结字段序、行序 = 题目 + 版本序)", () => {
    const rows = aggregateFromEventRows(eventRows());
    expect(renderTeachingAggregateReport(rows)).toBe(renderTeachingAggregateReport([...rows]));
    const first = renderTeachingAggregateReport(rows);
    expect(first.startsWith('{"aggregates":[{"challengeId":')).toBe(true);
  });
});

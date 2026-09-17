/**
 * 教学事件聚合与受控查询的**输出面**(WP-82;D-API-151)。
 *
 * 输出面 = **聚合数值 + 有界枚举**,零学习者标识外泄(结构性,不是"读了再
 * 脱敏"):聚合行类型 `ChallengeTeachingAggregate` 的字段集是冻结的九键
 * (`TEACHING_AGGREGATE_FIELDS`),其中不含会话摘要、不含源行标识、不含租户
 * ——`subjectDigest` 只在**分组**里被消费,不在任何返回值里出现
 * (SQL 侧同理:`GROUP BY subject_digest` 而 SELECT 列表不含该列)。字段面
 * 由 `discipline.ts` 的 `assertTeachingAggregateDiscipline` 机检(未知字段 /
 * 非标量 / 越界域 / 越界枚举 / 标识符形态值 / 秘密语料六类违例)。
 *
 * 同一份聚合数学由两条路径共用(单一口径来源):
 *  - 路径 A(载体面,生产主路径):`teaching_events` 表按题目分组(受控查询);
 *  - 路径 B(权威面):直接对权威行派生结果聚合(`aggregateFromEventRows`),
 *    与首轮试用报告模板的「受控查询既有表」口径逐字一致——两条路径的输出
 *    深度相等是**口径等价机检**的断言面(容器门控集成测试)。
 *
 * 不在公开契约新增面:本面没有任何路由 / Schema 落点(权威 API 语义规约
 * D-API-151 登记;首轮试用报告模板 §二 的「受控查询」承载)。
 */

import type { TeachingEventRow } from "./derive.js";

/**
 * 聚合行字段集(冻结九键;顺序即规范化渲染的键序)。
 * 机检锚点:`discipline.ts` 的未知字段 / 缺字段违例以此为准。
 */
export const TEACHING_AGGREGATE_FIELDS = [
  "challengeId",
  "challengeVersion",
  "startedSessions",
  "passedSessions",
  "completionRatio",
  "undoneActions",
  "firstPassSamples",
  "firstPassSecondsP50",
  "firstPassSecondsP95",
] as const;

export type TeachingAggregateField = (typeof TEACHING_AGGREGATE_FIELDS)[number];

/** 首次通过耗时分位档(冻结两档;试点规模下的稳健观察面)。 */
export const FIRST_PASS_QUANTILES = [0.5, 0.95] as const;

/** 单题计数聚合(SQL 面 / 内存面共用的中间形态;零标识)。 */
export interface ChallengeEventCounts {
  readonly challengeId: string;
  readonly challengeVersion: string;
  /** 题目开始(会话数:按会话摘要去重)。 */
  readonly startedSessions: number;
  /** 通过(会话数:按会话摘要去重)。 */
  readonly passedSessions: number;
  /** 回退次数(已接受 `undo` 动作数;`event_count` 求和)。 */
  readonly undoneActions: number;
}

/** 单题首次通过耗时样本(逐会话一条;只承载秒数,不承载会话摘要)。 */
export interface ChallengeFirstPassSample {
  readonly challengeId: string;
  readonly challengeVersion: string;
  /** 首次通过耗时(秒;整数,取自源行时刻差,负差夹取为 0)。 */
  readonly seconds: number;
}

/** 聚合行(受控查询的**唯一**输出形态;冻结九键)。 */
export interface ChallengeTeachingAggregate {
  readonly challengeId: string;
  readonly challengeVersion: string;
  readonly startedSessions: number;
  readonly passedSessions: number;
  /** 完成率 = 通过会话数 / 开始会话数(四位小数);分母为 0 ⇒ `null`(不伪造 0)。 */
  readonly completionRatio: number | null;
  readonly undoneActions: number;
  /** 首次通过耗时样本数(分位数的样本量;0 ⇒ 两档分位为 `null`)。 */
  readonly firstPassSamples: number;
  readonly firstPassSecondsP50: number | null;
  readonly firstPassSecondsP95: number | null;
}

/** 定标舍入(确定性;避免浮点尾差进入聚合输出)。 */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function groupKey(challengeId: string, challengeVersion: string): string {
  return `${challengeId}\u0000${challengeVersion}`;
}

/**
 * 分位数(nearest-rank 规则,确定性):升序样本 `n` 条、分位 `p ∈ (0,1]`,
 * 取 1-based 下标 `max(1, ceil(p × n))` 的值;空样本 ⇒ `null`。
 * 规则写死在此处(而非依赖库实现),使两条聚合路径与跨环境结果逐值相同。
 */
export function quantileNearestRank(sorted: readonly number[], percentile: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  const value = sorted[Math.min(rank, sorted.length) - 1];
  return value === undefined ? null : value;
}

/** 由采集行计算计数聚合(按题目 / 版本分组;按会话摘要去重)。 */
export function countsFromEventRows(rows: readonly TeachingEventRow[]): ChallengeEventCounts[] {
  const started = new Map<string, Set<string>>();
  const passed = new Map<string, Set<string>>();
  const undone = new Map<string, number>();
  const identity = new Map<string, { challengeId: string; challengeVersion: string }>();

  for (const row of rows) {
    const key = groupKey(row.challengeId, row.challengeVersion);
    identity.set(key, { challengeId: row.challengeId, challengeVersion: row.challengeVersion });
    if (row.kind === "challenge_started") {
      const bucket = started.get(key) ?? new Set<string>();
      bucket.add(row.subjectDigest);
      started.set(key, bucket);
    } else if (row.kind === "passed") {
      const bucket = passed.get(key) ?? new Set<string>();
      bucket.add(row.subjectDigest);
      passed.set(key, bucket);
    } else {
      undone.set(key, (undone.get(key) ?? 0) + row.eventCount);
    }
  }

  return [...identity.entries()]
    .map(([key, ids]) => ({
      challengeId: ids.challengeId,
      challengeVersion: ids.challengeVersion,
      startedSessions: started.get(key)?.size ?? 0,
      passedSessions: passed.get(key)?.size ?? 0,
      undoneActions: undone.get(key) ?? 0,
    }))
    .sort(compareByIdentity);
}

/**
 * 由采集行计算首次通过耗时样本(逐会话一条;需要该会话的题目开始事件)。
 * 题目开始事件缺席的会话(单批读取截断等)不产生样本 —— 样本量如实计数,
 * 不以不完整数据凑分位。
 */
export function firstPassSamplesFromEventRows(
  rows: readonly TeachingEventRow[],
): ChallengeFirstPassSample[] {
  interface Timeline {
    readonly challengeId: string;
    readonly challengeVersion: string;
    startedAt: number | null;
    firstPassedAt: number | null;
  }
  const timelines = new Map<string, Timeline>();

  for (const row of rows) {
    const key = `${groupKey(row.challengeId, row.challengeVersion)}\u0000${row.subjectDigest}`;
    const existing = timelines.get(key) ?? {
      challengeId: row.challengeId,
      challengeVersion: row.challengeVersion,
      startedAt: null,
      firstPassedAt: null,
    };
    const at = new Date(row.occurredAt).getTime();
    if (row.kind === "challenge_started" && (existing.startedAt === null || at < existing.startedAt)) {
      existing.startedAt = at;
    }
    if (row.kind === "passed" && (existing.firstPassedAt === null || at < existing.firstPassedAt)) {
      existing.firstPassedAt = at;
    }
    timelines.set(key, existing);
  }

  const samples: ChallengeFirstPassSample[] = [];
  for (const timeline of timelines.values()) {
    if (timeline.startedAt === null || timeline.firstPassedAt === null) {
      continue;
    }
    samples.push({
      challengeId: timeline.challengeId,
      challengeVersion: timeline.challengeVersion,
      seconds: Math.max(0, Math.round((timeline.firstPassedAt - timeline.startedAt) / 1000)),
    });
  }
  return samples.sort(compareByIdentity);
}

/** 计数 + 样本 → 聚合行(两条聚合路径共用的**唯一**组装点)。 */
export function assembleAggregates(
  counts: readonly ChallengeEventCounts[],
  samples: readonly ChallengeFirstPassSample[],
): ChallengeTeachingAggregate[] {
  const byKey = new Map<string, number[]>();
  for (const sample of samples) {
    const key = groupKey(sample.challengeId, sample.challengeVersion);
    const bucket = byKey.get(key) ?? [];
    bucket.push(sample.seconds);
    byKey.set(key, bucket);
  }

  return [...counts]
    .sort(compareByIdentity)
    .map((count) => {
      const durations = (byKey.get(groupKey(count.challengeId, count.challengeVersion)) ?? [])
        .slice()
        .sort((left, right) => left - right);
      return {
        challengeId: count.challengeId,
        challengeVersion: count.challengeVersion,
        startedSessions: count.startedSessions,
        passedSessions: count.passedSessions,
        completionRatio:
          count.startedSessions === 0
            ? null
            : round(count.passedSessions / count.startedSessions, 4),
        undoneActions: count.undoneActions,
        firstPassSamples: durations.length,
        firstPassSecondsP50: quantileNearestRank(durations, FIRST_PASS_QUANTILES[0]),
        firstPassSecondsP95: quantileNearestRank(durations, FIRST_PASS_QUANTILES[1]),
      };
    });
}

/** 采集行 → 聚合行(路径 B:权威面直接聚合;与载体面同一数学)。 */
export function aggregateFromEventRows(
  rows: readonly TeachingEventRow[],
): ChallengeTeachingAggregate[] {
  return assembleAggregates(countsFromEventRows(rows), firstPassSamplesFromEventRows(rows));
}

function compareByIdentity(
  left: { challengeId: string; challengeVersion: string },
  right: { challengeId: string; challengeVersion: string },
): number {
  if (left.challengeId !== right.challengeId) {
    return left.challengeId < right.challengeId ? -1 : 1;
  }
  if (left.challengeVersion === right.challengeVersion) {
    return 0;
  }
  return left.challengeVersion < right.challengeVersion ? -1 : 1;
}

/**
 * 规范化渲染(纪律机检的输入面 / 报告归档面):键序 = 冻结字段序、行序 =
 * 题目 + 版本升序、无空白 ⇒ 同一聚合结果逐字节相同(确定性可断言)。
 */
export function renderTeachingAggregateReport(rows: readonly ChallengeTeachingAggregate[]): string {
  const ordered = [...rows].sort(compareByIdentity).map((row) => {
    const record: Record<string, unknown> = {};
    for (const field of TEACHING_AGGREGATE_FIELDS) {
      record[field] = row[field];
    }
    return record;
  });
  return JSON.stringify({ aggregates: ordered });
}

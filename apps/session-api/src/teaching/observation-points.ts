/**
 * D-API-107 每题观察点 × 采集面来源的**对齐登记**(WP-82;D-API-151)。
 *
 * 依据:`docs/develop/权威API语义规约.md:1070-1079`(D-API-107 八题清单表末列
 * 的 3 项观察点)+ `docs/phases/中期试用报告模板.md` §三 的对齐表(24 格可得性
 * 归类)。本模块把该表变成**可机检的代码登记**:8 题 × 3 项 = 24 格逐格标注
 * 「来源面 + 可得性」,由 `test/teaching/aggregate.test.ts` 断言:
 *  - 键集 = `MVP_CHALLENGES[].meta.challengeId`(8 题,与题目集单一来源对齐);
 *  - 逐格标签与题目集 `observationPoints` 文本同源(前缀一致);
 *  - 可得性归类计数 = 12 可采集 / 2 部分 / 7 v1 暂不可采集 / 2 人工抽样 /
 *    1 待补取证(与模板结论表逐数一致);
 *  - 凡标「教学聚合面」的格,其 `aggregateField` ∈ 冻结九键
 *    (`TEACHING_AGGREGATE_FIELDS`)。
 *
 * 「提示使用等级」在本表内**逐格登记为 v1 暂不可采集**(原因 / 触发条件与
 * `kinds.ts` 的可得性登记同源):不填数、不以代理指标顶替。
 */

import type { TeachingAggregateField } from "./aggregate.js";

/** 观察点的数据来源面(D-API-140 的三分类 + 不可采集 / 待补取证两态)。 */
export type ObservationSource =
  /** 教学事件聚合面(本工作包的受控查询输出)。 */
  | { readonly via: "teaching_aggregate"; readonly aggregateField: TeachingAggregateField }
  /** 既有指标族(/metrics;非教学事件通道)。 */
  | { readonly via: "metrics_family"; readonly family: string }
  /** 既有权威表的受控查询(非教学聚合面;模板 §二 口径)。 */
  | { readonly via: "controlled_query"; readonly table: string }
  /** 部分可采集:裁决方向 / 结果类得,错误码分类不得。 */
  | { readonly via: "partial"; readonly collected: string; readonly missing: string }
  /** 人工抽样(访谈 / 前测后测)。 */
  | { readonly via: "manual_interview" }
  /** 待补取证(可得性待复核)。 */
  | { readonly via: "pending_evidence"; readonly reason: string }
  /** v1 暂不可采集(服务端无记录入口 / 无落点)。 */
  | { readonly via: "not_collectible_v1"; readonly reason: string; readonly trigger: string };

/** 可得性归类(与首轮试用报告模板 §三 结论表同词表)。 */
export type ObservationAvailability =
  | "collectible"
  | "partial"
  | "not_collectible_v1"
  | "manual_sampling"
  | "pending_evidence";

/** 单格观察点登记。 */
export interface ObservationPointEntry {
  /** 观察点标签(D-API-107 清单表措辞的规范化形态)。 */
  readonly point: string;
  readonly source: ObservationSource;
}

/** 单题三格(恰三项;D-API-107 每题登记 3 项)。 */
export interface ChallengeObservationAlignment {
  readonly challengeId: string;
  /**
   * 题目集 `meta.observationPoints` 的**逐字引用**(8 题 × 3 项;
   * 机检断言与 `test/mvp-challenges/corpus.ts` 恒等 —— 两侧任一漂移即红)。
   */
  readonly corpusPoints: readonly [string, string, string];
  readonly points: readonly [ObservationPointEntry, ObservationPointEntry, ObservationPointEntry];
}

/** 来源面 → 可得性归类(唯一映射;`partial` 等三态自成一类)。 */
export function availabilityOf(source: ObservationSource): ObservationAvailability {
  switch (source.via) {
    case "teaching_aggregate":
    case "metrics_family":
    case "controlled_query":
      return "collectible";
    case "partial":
      return "partial";
    case "manual_interview":
      return "manual_sampling";
    case "pending_evidence":
      return "pending_evidence";
    case "not_collectible_v1":
      return "not_collectible_v1";
  }
}

/** 「提示使用」两处文案的同源常量(不可采集原因 / 触发条件)。 */
const HINT_REASON =
  "hintLadder 只存在于公开描述包,服务端无记录入口;不得靠客户端自报(6.2)";
const HINT_TRIGGER = "采集面扩展(additive 上报契约或服务端记录入口;新工作包承接)";

/**
 * 八题 × 三项对齐登记(逐格与 `docs/phases/中期试用报告模板.md` §三 表一致)。
 */
export const D_API_107_OBSERVATION_ALIGNMENT: readonly ChallengeObservationAlignment[] = [
  {
    challengeId: "sm-ch01-write-basics",
    corpusPoints: [
      "首次成功时间(十五章:打开题目到首次成功)",
      "错误类型分布(permission_denied 重复率)",
      "提示使用等级",
    ],
    points: [
      { point: "首次成功时间", source: { via: "teaching_aggregate", aggregateField: "firstPassSecondsP50" } },
      {
        point: "错误类型分布",
        source: {
          via: "partial",
          collected: "裁决方向(verdicts 11 值)与动作结果类(/metrics outcome)",
          missing: "动作级 16 错误码分类(被拒动作不入 action_log,无落点)",
        },
      },
      {
        point: "提示使用等级",
        source: { via: "not_collectible_v1", reason: HINT_REASON, trigger: HINT_TRIGGER },
      },
    ],
  },
  {
    challengeId: "sm-ch02-little-endian",
    corpusPoints: [
      "完成率与放弃率(首次接触端序概念的一格)",
      "重复错误比例(端序方向写反的复现率)",
      "提示使用等级",
    ],
    points: [
      { point: "完成率", source: { via: "teaching_aggregate", aggregateField: "completionRatio" } },
      {
        point: "端序错误重复率",
        source: {
          via: "not_collectible_v1",
          reason: "重复错误率需动作级错误码分类,而被拒动作不入 action_log",
          trigger: "动作级错误分类采集面(新工作包)",
        },
      },
      {
        point: "提示使用等级",
        source: { via: "not_collectible_v1", reason: HINT_REASON, trigger: HINT_TRIGGER },
      },
    ],
  },
  {
    challengeId: "sm-ch03-frame-layout",
    corpusPoints: [
      "首次成功时间(帧布局概念格)",
      "错误类型分布(槽位错写率)",
      "回退次数(undo 使用)",
    ],
    points: [
      { point: "首次成功时间", source: { via: "teaching_aggregate", aggregateField: "firstPassSecondsP50" } },
      {
        point: "槽位错写率",
        source: {
          via: "not_collectible_v1",
          reason: "需动作级错误分类(槽位错写 = 写入被拒 / 判负细分),v1 无落点",
          trigger: "动作级错误分类采集面(新工作包)",
        },
      },
      { point: "回退次数", source: { via: "teaching_aggregate", aggregateField: "undoneActions" } },
    ],
  },
  {
    challengeId: "sm-ch04-buffer-overflow",
    corpusPoints: [
      "首次成功时间(溢出因果链格)",
      "错误类型分布(端序 / 填充长度错误)",
      "学习前后端序概念理解变化(前测题)",
    ],
    points: [
      {
        point: "溢出因果链首次成功",
        source: { via: "teaching_aggregate", aggregateField: "firstPassSecondsP50" },
      },
      {
        point: "端序错误",
        source: {
          via: "partial",
          collected: "裁决方向(verdicts 11 值)与动作结果类(/metrics outcome)",
          missing: "端序错误细分(错误码分类不可采集)",
        },
      },
      { point: "概念前测", source: { via: "manual_interview" } },
    ],
  },
  {
    challengeId: "sm-ch05-canary-guard",
    corpusPoints: [
      "错误类型分布(溢出越界长度)",
      "概念理解变化(防护机制前测 / 后测)",
      "回退次数",
    ],
    points: [
      {
        point: "溢出越界长度",
        source: {
          via: "pending_evidence",
          reason:
            "需 action_log 的 write_bytes 参数 × 题目布局登记面联表,布局元数据可得性待复核",
        },
      },
      { point: "防护机制概念前后测", source: { via: "manual_interview" } },
      { point: "回退次数", source: { via: "teaching_aggregate", aggregateField: "undoneActions" } },
    ],
  },
  {
    challengeId: "sm-ch06-ret2win-byte",
    corpusPoints: [
      "首次成功时间(字节模式过渡格)",
      "提示使用等级",
      "投影传输量(字节视图交互增量)",
    ],
    points: [
      {
        point: "字节模式过渡首次成功",
        source: { via: "teaching_aggregate", aggregateField: "firstPassSecondsP50" },
      },
      {
        point: "提示使用等级",
        source: { via: "not_collectible_v1", reason: HINT_REASON, trigger: HINT_TRIGGER },
      },
      {
        point: "投影传输量",
        source: { via: "metrics_family", family: "session_api_projection_delta_bytes" },
      },
    ],
  },
  {
    challengeId: "sm-ch07-hidden-vault",
    corpusPoints: [
      "完成率(隐藏区域概念格)",
      "探针尝试与统一拒绝的观察面(不可探测性)",
      "错误类型分布(inaccessible_address)",
    ],
    points: [
      {
        point: "隐藏区域概念完成率",
        source: { via: "teaching_aggregate", aggregateField: "completionRatio" },
      },
      {
        point: "探针行为",
        source: {
          via: "not_collectible_v1",
          reason: "自发越界读取属被拒动作,不入 action_log ⇒ 无落点",
          trigger: "被拒动作采集面(须先过 6.2 与错误精度粗化评审)",
        },
      },
      {
        point: "inaccessible_address 分布",
        source: {
          via: "not_collectible_v1",
          reason: "同上(被拒动作不入 action_log,错误码分布无落点)",
          trigger: "被拒动作错误码采集面(新工作包)",
        },
      },
    ],
  },
  {
    challengeId: "sm-ch08-full-chain",
    corpusPoints: [
      "各题完成率(收官格)",
      "阶段闸门拒绝后的重试行为(编排理解)",
      "动作请求 p50 / p95(教学规模基线)",
    ],
    points: [
      { point: "收官完成率", source: { via: "teaching_aggregate", aggregateField: "completionRatio" } },
      {
        point: "阶段闸门重试",
        source: { via: "controlled_query", table: "verdicts(按题 / 会话方向的重复计数)" },
      },
      { point: "动作 p50/p95", source: { via: "metrics_family", family: "session_api_action_rtt_seconds" } },
    ],
  },
];

/** 某题的观察点登记(未登记题 = `null`;不猜测、不默认)。 */
export function observationAlignmentOf(
  challengeId: string,
): ChallengeObservationAlignment | null {
  return D_API_107_OBSERVATION_ALIGNMENT.find((entry) => entry.challengeId === challengeId) ?? null;
}

/** 可得性归类计数(D-API-140 结论表的可机检形态)。 */
export function availabilityTally(): Record<ObservationAvailability, number> {
  const tally: Record<ObservationAvailability, number> = {
    collectible: 0,
    partial: 0,
    not_collectible_v1: 0,
    manual_sampling: 0,
    pending_evidence: 0,
  };
  for (const entry of D_API_107_OBSERVATION_ALIGNMENT) {
    for (const point of entry.points) {
      tally[availabilityOf(point.source)] += 1;
    }
  }
  return tally;
}

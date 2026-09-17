/**
 * 教学事件面:种类封闭集与 v1 采集可得性登记(中期 M3 WP-82;载体定案
 * O-MP-1 = 权威 API 语义规约 D-API-139,登记片段
 * `docs/develop/decisions-m3/WP-82.md`)。
 *
 * 纪律(两账边界的机检锚点):
 *  - **两账分离**:教学事件账(本模块 + `teaching_events` 表)与安全事件账
 *    `audit_log`(`AUDIT_EVENT_KINDS` 十值封闭集,`src/auth/ports.ts` 与
 *    migrations/006 库层 CHECK 同锚)是两张账;本模块的种类集与审计 kind
 *    **逐值不相交**,教学事件**零新增审计 kind**(不重开 D-API-59 的
 *    「安全事件账 vs 数据事件账」论证;机检:`test/teaching/kinds.test.ts`);
 *  - **v1 采集面 = 服务端可派生三值**(题目开始 / 通过 / 回退次数):服务端
 *    从 `sessions` / `verdicts` / `action_log` **自行派生**,不接受任何来自
 *    客户端的事件自报(6.2「不接受自报身份」基线;本模块**不存在**上报入口);
 *  - **「提示使用」v1 如实登记「暂不可采集」**:`hintLadder` 只存在于公开
 *    描述包,服务端无 hint 使用记录面 ⇒ 不采集、不估算、不伪造计数(库层
 *    CHECK 结构性拒绝该 kind 写入,见 migrations/008)。
 *
 * 零学习者标识 / 零秘密:采集载荷只有单向会话摘要(`derive.ts`)、公开描述包
 * 已分类公开常量(题目身份)、服务端时刻与聚合数值 / 有界枚举。
 */

/** 教学事件种类语义集(四值;D-API-107 / 计划书第十五章的观察面口径)。 */
export const TEACHING_EVENT_KINDS = [
  /** 题目开始(源:会话创建事件)。 */
  "challenge_started",
  /** 通过(源:成绩方向的裁决)。 */
  "passed",
  /** 回退次数(源:动作日志中的 `undo` 动作)。 */
  "undo",
  /** 提示使用(**v1 暂不可采集**;语义位在场、采集位结构性缺席)。 */
  "hint_used",
] as const;

export type TeachingEventKind = (typeof TEACHING_EVENT_KINDS)[number];

/**
 * v1 可采集子集(三值;**库层 CHECK 字面同锚**,`migrations/008_teaching_events.sql`)。
 * 采集器只可能产出这三个值(机检:`derive.ts` 的派生面 + 本集恒等),
 * 故「提示使用」不存在伪造计数的表达位。
 */
export const COLLECTIBLE_TEACHING_EVENT_KINDS = [
  "challenge_started",
  "passed",
  "undo",
] as const;

export type CollectibleTeachingEventKind = (typeof COLLECTIBLE_TEACHING_EVENT_KINDS)[number];

/** 采集可得性归类(与首轮试用报告模板的可得性列同词表,D-API-140)。 */
export type TeachingCollectability = "collectible" | "not_collectible_v1";

/** 单类教学事件的采集登记(四值全覆盖;可得性 / 来源 / 不可采集原因与触发条件)。 */
export interface TeachingEventCollectabilityEntry {
  readonly kind: TeachingEventKind;
  readonly collectability: TeachingCollectability;
  /** 权威来源口径(可采集项必填;服务端面,非客户端面)。 */
  readonly source: string;
  /** 不可采集原因(仅 not_collectible_v1;如实登记,零占位数字)。 */
  readonly reason?: string;
  /** 解除不可采集的触发条件(仅 not_collectible_v1)。 */
  readonly trigger?: string;
}

/**
 * 采集可得性登记表(机检:键集恒等 `TEACHING_EVENT_KINDS` 且无重)。
 * 本表是「提示使用 = 暂不可采集」的**结构性落点**:任何消费方读到的
 * 都是 `not_collectible_v1` + 原因 + 触发条件,而不是一个 0。
 */
export const TEACHING_EVENT_COLLECTABILITY: readonly TeachingEventCollectabilityEntry[] = [
  {
    kind: "challenge_started",
    collectability: "collectible",
    source: "sessions 创建事件(sessions.created_at;服务端权威行)",
  },
  {
    kind: "passed",
    collectability: "collectible",
    source: "verdicts 成绩方向(verdict = 'success';经 submissions × sessions 定位题目身份)",
  },
  {
    kind: "undo",
    collectability: "collectible",
    source: "action_log 动作计数(action->>'type' = 'undo';仅已接受动作入账)",
  },
  {
    kind: "hint_used",
    collectability: "not_collectible_v1",
    source: "无(服务端零记录入口)",
    reason:
      "hintLadder 只存在于公开描述包,服务端无 hint 使用记录面;不得靠客户端自报(6.2 不接受自报身份 / 自报事件)⇒ 无权威来源可派生",
    trigger:
      "采集面扩展:服务端记录入口,或 additive 上报契约(须过 6.2 与数据分类清单变更流程;新工作包承接)",
  },
];

/**
 * 客户端自报种类集 = **空集**(结构性口径):采集面只从服务端权威行派生,
 * 不存在任何接受外部事件载荷的方法;本常量把该口径变成可断言的机检锚点。
 */
export const CLIENT_REPORTED_TEACHING_KINDS: readonly TeachingEventKind[] = [];

/** 通过方向 = 冻结 11 值结果类型中的 `success`(成绩方向;其余 10 值不是通过)。 */
export const PASSING_VERDICT = "success";

/** 回退动作类型字面(12 冻结动作类型之一;`action_log.action->>'type'`)。 */
export const UNDO_ACTION_TYPE = "undo";

/** 派生口径版本(写入 `teaching_events.derivation`;重放 / 复算锚)。 */
export const TEACHING_DERIVATION_VERSION = "teaching-derive-v1";

/**
 * 教学事件在线保留期默认值(天):**一个教学学期 + 缓冲**(试点数据在学期
 * 内可复核,学期结束后按保留期收敛;数据用途边界见首轮试用报告模板 §五)。
 * 值随部署面配置传入(端口方法保留期形参),本常量是缺省锚;快照 / 终态
 * 会话 / 审计的在线保留窗口仍按各自部署配置执行(D-API-55 面不变)。
 */
export const TEACHING_EVENT_RETENTION_DAYS = 180;

/** 是否为 v1 可采集种类(采集器与聚合面的白名单判据)。 */
export function isCollectibleTeachingEventKind(kind: string): kind is CollectibleTeachingEventKind {
  return (COLLECTIBLE_TEACHING_EVENT_KINDS as readonly string[]).includes(kind);
}

/** 采集可得性查表(四值全覆盖;未知种类返回 `null`——不猜测、不默认)。 */
export function collectabilityOf(kind: TeachingEventKind): TeachingCollectability {
  const entry = TEACHING_EVENT_COLLECTABILITY.find((candidate) => candidate.kind === kind);
  if (entry === undefined) {
    // 键集恒等由机检保证;运行期兜底取最保守归类(不得把未知当成可采集)。
    return "not_collectible_v1";
  }
  return entry.collectability;
}

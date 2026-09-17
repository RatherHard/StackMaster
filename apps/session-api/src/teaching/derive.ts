/**
 * 服务端可派生三类的**派生口径**(WP-82;D-API-139 / D-API-150)。
 *
 * 输入 = 服务端权威行的受控查询结果(`AuthoritativeTeachingRows`,由
 * `teaching/pg/authoritative-source.ts` 按租户作用域读出);输出 = 可直接落
 * `teaching_events` 的采集行。**不接受任何客户端事件载荷** —— 本模块的入参
 * 类型里不存在「事件上报」形态,采集面结构上只有服务端权威行一个入口。
 *
 * 三类口径(逐条与服务端权威面同源):
 *  1. 题目开始:每个 `sessions` 行恰一个事件(会话创建 = 题目开始);
 *  2. 通过:每个 `verdicts` 行中 `verdict = 'success'`(成绩方向)恰一个事件
 *     —— 其余 10 值不是通过(拒绝方向 / 崩溃 / 超时等各自有观察面,本采集面
 *     不合并、不估算);题目身份经 `submissions` × `sessions` 定位(会话创建
 *     时锚定的版本才是「该次会话用的版本」);
 *  3. 回退次数:每个 `action_log` 行中 `action->>'type' = 'undo'` 恰一个事件
 *     (被拒动作不入 `action_log` ⇒ 本口径 = **已接受回退动作数**,如实口径)。
 *
 * 「提示使用」不在派生面(登记为 v1 暂不可采集,见 `kinds.ts`):本模块不含
 * 任何 hint 相关输入字段与分支。
 *
 * 零学习者标识:采集行只承载**单向会话摘要** `subjectDigest`
 * (SHA-256(tenantId ‖ 0x00 ‖ sessionId) 的 hex;不可反解、租户作用域绑定、
 * 不离开服务端,且聚合端口面无返回位)与**源权威行派生锚** `sourceRef`
 * (`session:<摘要>` / `verdict:<uuid>` / `action:<id>`,不含原始会话标识文本)。
 */

import { createHash } from "node:crypto";

import { PASSING_VERDICT, TEACHING_DERIVATION_VERSION } from "./kinds.js";
import type { CollectibleTeachingEventKind } from "./kinds.js";

/** 权威面:会话行(题目开始事件源;最小充分集,零 user_id 读取)。 */
export interface AuthoritativeSessionRow {
  readonly sessionId: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
  /** 会话创建时刻(ISO 8601;`sessions.created_at`)。 */
  readonly createdAt: string;
}

/** 权威面:裁决行(通过事件源;只取成绩方向所需列)。 */
export interface AuthoritativeVerdictRow {
  /** `verdicts.id`(UUID 文本;幂等锚)。 */
  readonly verdictId: string;
  readonly sessionId: string;
  /** 11 值结果类型字面(`verdicts.verdict`)。 */
  readonly verdict: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
  readonly createdAt: string;
}

/** 权威面:回退动作行(回退事件源)。 */
export interface AuthoritativeUndoActionRow {
  /** `action_log.id`(BIGINT 文本;幂等锚)。 */
  readonly actionLogId: string;
  readonly sessionId: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
  readonly createdAt: string;
}

/** 单个租户的权威行集合(受控查询结果;`truncated` = 单批上限命中,如实传出)。 */
export interface AuthoritativeTeachingRows {
  readonly sessions: readonly AuthoritativeSessionRow[];
  readonly passedVerdicts: readonly AuthoritativeVerdictRow[];
  readonly undos: readonly AuthoritativeUndoActionRow[];
  /** 任一类命中单批读取上限 ⇒ true(采集器如实透出,不静默截断)。 */
  readonly truncated: boolean;
}

/** 派生出的采集行(落库形态;`subjectDigest` 只用于内部分组,端口面不返回)。 */
export interface DerivedTeachingEvent {
  readonly kind: CollectibleTeachingEventKind;
  readonly occurredAt: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
  readonly subjectDigest: string;
  readonly sourceRef: string;
  readonly eventCount: number;
  readonly derivation: string;
}

/** 采集行中不参与聚合的最小面(聚合与口径等价断言的输入类型)。 */
export type TeachingEventRow = Omit<DerivedTeachingEvent, "sourceRef" | "derivation">;

/**
 * 会话摘要(SHA-256 hex;单向 + 租户作用域绑定)。用于两处**服务端内部**
 * 用途:①聚合的逐会话去重 / 分组;②题目开始事件的幂等锚(源行主键的
 * 非可读形态)。**不得**作为标识符进入任何对外载荷或端口返回面。
 */
export function digestSessionSubject(tenantId: string, sessionId: string): string {
  return createHash("sha256").update(`${tenantId}\u0000${sessionId}`, "utf8").digest("hex");
}

/** 时刻规范化(ISO 8601 往返;非法输入 = 服务端面缺陷,确定性失败不静默)。 */
function requireInstant(tenantId: string, value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`权威行时刻非法(租户 ${tenantId}):期望 ISO 8601`);
  }
  return parsed.toISOString();
}

/** 题目开始事件(每 `sessions` 行恰一条)。 */
export function deriveChallengeStartedEvents(
  tenantId: string,
  rows: readonly AuthoritativeSessionRow[],
): DerivedTeachingEvent[] {
  return rows.map((row) => {
    const subjectDigest = digestSessionSubject(tenantId, row.sessionId);
    return {
      kind: "challenge_started",
      occurredAt: requireInstant(tenantId, row.createdAt),
      challengeId: row.challengeId,
      challengeVersion: row.challengeVersion,
      subjectDigest,
      sourceRef: `session:${subjectDigest}`,
      eventCount: 1,
      derivation: TEACHING_DERIVATION_VERSION,
    };
  });
}

/**
 * 通过事件(每 `verdict = 'success'` 行恰一条)。
 *
 * 双层口径:受控查询 SQL 已按 `verdict = 'success'` 过滤,本函数**再次**
 * 按同一字面过滤(查询层与派生层双层同形,任一层缺席都不产出非通过事件)。
 */
export function derivePassedEvents(
  tenantId: string,
  rows: readonly AuthoritativeVerdictRow[],
): DerivedTeachingEvent[] {
  return rows
    .filter((row) => row.verdict === PASSING_VERDICT)
    .map((row) => ({
      kind: "passed",
      occurredAt: requireInstant(tenantId, row.createdAt),
      challengeId: row.challengeId,
      challengeVersion: row.challengeVersion,
      subjectDigest: digestSessionSubject(tenantId, row.sessionId),
      sourceRef: `verdict:${row.verdictId}`,
      eventCount: 1,
      derivation: TEACHING_DERIVATION_VERSION,
    }));
}

/** 回退事件(每 `undo` 动作行恰一条;口径 = 已接受回退动作计数)。 */
export function deriveUndoEvents(
  tenantId: string,
  rows: readonly AuthoritativeUndoActionRow[],
): DerivedTeachingEvent[] {
  return rows.map((row) => ({
    kind: "undo",
    occurredAt: requireInstant(tenantId, row.createdAt),
    challengeId: row.challengeId,
    challengeVersion: row.challengeVersion,
    subjectDigest: digestSessionSubject(tenantId, row.sessionId),
    sourceRef: `action:${row.actionLogId}`,
    eventCount: 1,
    derivation: TEACHING_DERIVATION_VERSION,
  }));
}

/**
 * 三类一体派生(采集器唯一入口)。
 *
 * 输出顺序是**确定性**的(题目开始 → 通过 → 回退,各类内保持权威行的排序),
 * 使「同输入两次派生逐字段相同」可机检(I-4 确定性纪律);落库顺序不影响
 * 聚合结果(聚合按题目分组后排序)。
 */
export function deriveTeachingEvents(
  tenantId: string,
  rows: AuthoritativeTeachingRows,
): DerivedTeachingEvent[] {
  return [
    ...deriveChallengeStartedEvents(tenantId, rows.sessions),
    ...derivePassedEvents(tenantId, rows.passedVerdicts),
    ...deriveUndoEvents(tenantId, rows.undos),
  ];
}

/**
 * 教学采集面端口(WP-82;D-API-149 ~ D-API-151)。
 *
 * 端口形状即纪律:
 *  - `AuthoritativeTeachingSource`:**唯一**采集输入面 —— 服务端权威行
 *    (`sessions` / `verdicts` / `action_log`)的受控查询;**不存在**接受
 *    客户端事件载荷的方法(6.2 不接受自报事件的结构性兑现);
 *  - `TeachingEventStore`:写入面只有 `appendDerived`(幂等追加)与
 *    `purgeExpired`(保留期);**没有任何返回行级数据的方法** ⇒ 采集行里的
 *    会话摘要 / 源锚在端口面上没有出场位;
 *  - `TeachingAggregateStore`:读取面只有聚合(聚合数值 + 有界枚举),
 *    返回类型 `ChallengeTeachingAggregate` 不含标识符字段;
 *  - 三者都按**租户**作用域工作(查询层 WHERE + 行级政策双层,D-API-20 /
 *    D-API-101)。
 */

import type { ChallengeTeachingAggregate } from "./aggregate.js";
import type { AuthoritativeTeachingRows, DerivedTeachingEvent } from "./derive.js";

/**
 * 单批权威行读取上限(适配器**逐类**截断并置 `truncated = true`)。
 * 存在的理由:受控查询是服务端全量读面,无上界即无护栏;超过上限的窗口
 * 由采集调用方以 `sinceIso` 分批(watermark)推进。v1 的采集入口是运维
 * 可调用入口(T0 无 cron,先例 D-API-55 的清理入口同形态),分批推进由
 * 调用方编排——**超限不静默**(`truncated` 如实透出到采集结果)。
 */
export const AUTHORITATIVE_READ_LIMIT = 5000;

/** 权威面读取端口(服务端派生三类的唯一输入面)。 */
export interface AuthoritativeTeachingSource {
  /**
   * 按租户读出权威行。
   * @param tenantId 租户(租户作用域注入面)
   * @param sinceIso 采集窗口左界(事件时刻严格大于;`null` = 全量窗口)
   */
  readAuthoritativeRows(
    tenantId: string,
    sinceIso: string | null,
  ): Promise<AuthoritativeTeachingRows>;
}

/** 采集写入 / 保留期端口(append-only;零行级读面)。 */
export interface TeachingEventStore {
  /**
   * 幂等追加采集行(库层唯一键 `(tenant_id, kind, source_ref)` +
   * `ON CONFLICT DO NOTHING`):重放同一权威行零重复、零改写。
   * @returns 实际新落库行数(去重后的增量)
   */
  appendDerived(tenantId: string, events: readonly DerivedTeachingEvent[]): Promise<number>;
  /**
   * 保留期清理(唯一 sanctioned 删除路径):删掉 `occurred_at` 早于
   * `retentionDays` 的行。RLS 下 DELETE 永不跨租户(两段式:枚举 + 逐租户
   * 删除,D-API-101 / migrations/008)。
   * @returns 清除行数
   */
  purgeExpired(retentionDays: number): Promise<number>;
}

/** 聚合读取端口(受控查询;聚合数值 + 有界枚举,零标识符返回面)。 */
export interface TeachingAggregateStore {
  /** 按题目 / 版本分组聚合本租户教学事件(输出面 = 冻结九键聚合行)。 */
  aggregateByChallenge(tenantId: string): Promise<readonly ChallengeTeachingAggregate[]>;
}

/**
 * 教学采集面**单点装配**(WP-82;D-API-149 ~ D-API-151)。
 *
 * 本工作包交付可装配的采集面(源 / 仓储 / 聚合 / 采集器),装配点收敛为本
 * 一个函数 —— 生产运行时的注入(在 `src/runtime/runtime.ts` 增一行持有
 * 本装配结果,与 `TerminalSessionCleaner` 的运维可调用入口同形态)不在本
 * 工作包的允许改动面内,如实登记为遗留(D-API-151 影响面):
 *  - **不接入会话主链路**:采集是旁路账,绝不在动作 / 裁决路径内联调用
 *    (失败语义见 `collector.ts`);
 *  - **不接入 `/metrics`**:教学事件不经指标通道(定案原文);
 *  - **不新增路由 / 契约面**:聚合读取只经进程内端口(受控查询)。
 *
 * 装配路径与测试接缝的一致性:单元测试与容器门控集成测试都经本函数装配
 * (不各自 new 适配器),使「测试接缝绕开生产装配」这一既有缺陷族在本包
 * 不成立(本仓纪律启示,CLAUDE.md「调试档缺陷两类」)。
 */

import type { Pool } from "pg";

import { TeachingEventCollector } from "./collector.js";
import type { TeachingCollectionOutcome } from "./collector.js";
import { PostgresAuthoritativeTeachingSource } from "./pg/authoritative-source.js";
import { PostgresTeachingEventStore } from "./pg/teaching-events-store.js";
import type {
  AuthoritativeTeachingSource,
  TeachingAggregateStore,
  TeachingEventStore,
} from "./ports.js";

export interface TeachingCollectionAssembly {
  /** 权威行受控查询(服务端派生三类的唯一输入面)。 */
  readonly source: AuthoritativeTeachingSource;
  /** 采集写入 + 保留期(append-only;零行级读面)。 */
  readonly store: TeachingEventStore;
  /** 聚合读取(聚合数值 + 有界枚举;零标识符返回面)。 */
  readonly aggregates: TeachingAggregateStore;
  /** 采集器(旁路;失败不外抛)。 */
  readonly collector: TeachingEventCollector;
}

/**
 * 由 PG 池装配教学采集面(采集器 / 仓储共用同一 `TenantScope` 形态的适配器)。
 * @param onFailure 失败观察回调(受控日志面;原始错误不进采集结果)
 */
export function buildTeachingCollection(
  pool: Pool,
  onFailure?: (outcome: TeachingCollectionOutcome, error: unknown) => void,
): TeachingCollectionAssembly {
  const source = new PostgresAuthoritativeTeachingSource(pool);
  const store = new PostgresTeachingEventStore(pool);
  const collector = new TeachingEventCollector(
    onFailure === undefined ? { source, store } : { source, store, onFailure },
  );
  return { source, store, aggregates: store, collector };
}

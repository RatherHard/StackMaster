/**
 * 教学事件采集器(旁路;WP-82;D-API-150)。
 *
 * **失败语义(本工作包的显式定案)**:教学采集是**旁路账**,与安全审计账
 * (`PgAuditSink`,append-only + fail-closed:落库失败即调用方同步失败)的
 * 失败语义**不同** —— 采集失败**不得**让动作 / 裁决 / 会话主链路失败,
 * 故本模块**从不外抛**:任何源读失败 / 派生失败 / 落库失败都折叠为
 * `failed = true` 的采集结果(稳定文案,零载荷细节),原始错误只交给可选的
 * `onFailure` 观察回调(受控日志面)。理由:
 *  - 教学事件是**观察数据**,不是玩家可见状态,也不是安全事实;它的缺失
 *    不改变任何权威状态,而"让采集失败打断学习者的动作"直接违反「编排器
 *    串行执行不因观测面失败而中断」的可用性口径;
 *  - 反过来,**审计面维持 append-only 与 fail-closed 不动**(两张账的失败
 *    语义差异是设计,不是不一致;D-API-150 登记);
 *  - 「不静默」由两处保证:采集结果如实带 `failed` / `failureReason`
 *    (调用方可判定),以及 `onFailure` 回调可接受控日志。
 *
 * 调用形态沿既有 T0 先例(D-API-55 的保留期清理同款):**运维可调用入口**,
 * 不在会话主链路内联调用;`sinceIso` 是分批窗口(watermark)左界。
 */

import type { AuthoritativeTeachingSource, TeachingEventStore } from "./ports.js";
import { deriveTeachingEvents } from "./derive.js";

/** 采集失败文案(稳定语义;零载荷细节 —— 与持久化面错误纪律同源)。 */
export const TEACHING_COLLECTION_FAILURE_REASON =
  "教学事件采集旁路失败(不影响会话主链路与裁决面)";

/** 单租户单次采集结果(如实携带截断与失败信号,不静默)。 */
export interface TeachingCollectionOutcome {
  readonly tenantId: string;
  /** 派生事件数(服务端权威行派生所得)。 */
  readonly derivedEvents: number;
  /** 实际新落库行数(幂等去重后的增量;重放为 0)。 */
  readonly appendedRows: number;
  /** 任一类权威行读取命中单批上限 ⇒ true(需以 `sinceIso` 分批推进)。 */
  readonly truncated: boolean;
  readonly failed: boolean;
  /** 失败文案(稳定;成功为 `null`)。 */
  readonly failureReason: string | null;
}

export interface TeachingEventCollectorOptions {
  readonly source: AuthoritativeTeachingSource;
  readonly store: TeachingEventStore;
  /** 失败观察回调(受控日志面;原始错误只在此处出现,不进采集结果)。 */
  readonly onFailure?: (outcome: TeachingCollectionOutcome, error: unknown) => void;
}

export class TeachingEventCollector {
  readonly #source: AuthoritativeTeachingSource;
  readonly #store: TeachingEventStore;
  readonly #onFailure: ((outcome: TeachingCollectionOutcome, error: unknown) => void) | undefined;

  constructor(options: TeachingEventCollectorOptions) {
    this.#source = options.source;
    this.#store = options.store;
    this.#onFailure = options.onFailure;
  }

  /**
   * 采集一个租户(服务端派生三类 → 幂等落库)。**永不抛错**:失败折叠为
   * `failed = true` 的结果(旁路账语义,见文件头)。
   */
  async collect(
    tenantId: string,
    options: { readonly sinceIso?: string | null } = {},
  ): Promise<TeachingCollectionOutcome> {
    const sinceIso = options.sinceIso ?? null;
    try {
      const rows = await this.#source.readAuthoritativeRows(tenantId, sinceIso);
      const derived = deriveTeachingEvents(tenantId, rows);
      const appended = derived.length === 0 ? 0 : await this.#store.appendDerived(tenantId, derived);
      return {
        tenantId,
        derivedEvents: derived.length,
        appendedRows: appended,
        truncated: rows.truncated,
        failed: false,
        failureReason: null,
      };
    } catch (error) {
      const outcome: TeachingCollectionOutcome = {
        tenantId,
        derivedEvents: 0,
        appendedRows: 0,
        truncated: false,
        failed: true,
        failureReason: TEACHING_COLLECTION_FAILURE_REASON,
      };
      this.#onFailure?.(outcome, error);
      return outcome;
    }
  }
}

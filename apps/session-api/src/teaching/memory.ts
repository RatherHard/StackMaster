/**
 * 教学采集面的**内存同构实现**(WP-82;单元测试与未接线期形态)。
 *
 * 与 PG 适配器逐条对齐:
 *  - 幂等:同一 `(tenantId, kind, sourceRef)` 二次追加零新增(等价
 *    `ON CONFLICT DO NOTHING`);
 *  - 保留期:按 `occurredAt` 窗口清除(等价逐租户 DELETE;内存面无跨租户
 *    删除路径 —— 清理对全表按时间窗口进行,与 PG 侧"两段式后逐租户删除"
 *    的**结果**同形);
 *  - 聚合:与 `aggregateFromEventRows` 同一数学(生产路径的 SQL 面组装点
 *    也是这一个函数,见 `aggregate.ts#assembleAggregates`)。
 *
 * 端口面纪律同生产适配器:**不返回任何行级数据**。测试需要的可见性由
 * `inspect()` 承载 —— 只有计数与种类集合,零标识符(这不是端口方法)。
 */

import type { ChallengeTeachingAggregate } from "./aggregate.js";
import { aggregateFromEventRows } from "./aggregate.js";
import type {
  AuthoritativeSessionRow,
  AuthoritativeTeachingRows,
  AuthoritativeUndoActionRow,
  AuthoritativeVerdictRow,
  DerivedTeachingEvent,
  TeachingEventRow,
} from "./derive.js";
import { AUTHORITATIVE_READ_LIMIT } from "./ports.js";
import type {
  AuthoritativeTeachingSource,
  TeachingAggregateStore,
  TeachingEventStore,
} from "./ports.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface SeededRows {
  readonly tenantId: string;
  readonly sessions: readonly AuthoritativeSessionRow[];
  readonly passedVerdicts: readonly AuthoritativeVerdictRow[];
  readonly undos: readonly AuthoritativeUndoActionRow[];
}

/** 权威行内存源(测试 seed 形态;生产形态 = PG 受控查询)。 */
export class MemoryAuthoritativeTeachingSource implements AuthoritativeTeachingSource {
  readonly #seeded: SeededRows[] = [];

  /** 测试 / 未接线期 seed(生产形态无此入口:权威行唯一出处 = 权威表)。 */
  seed(rows: SeededRows): void {
    this.#seeded.push({
      tenantId: rows.tenantId,
      sessions: [...rows.sessions],
      passedVerdicts: [...rows.passedVerdicts],
      undos: [...rows.undos],
    });
  }

  async readAuthoritativeRows(
    tenantId: string,
    sinceIso: string | null,
  ): Promise<AuthoritativeTeachingRows> {
    const own = this.#seeded.filter((entry) => entry.tenantId === tenantId);
    const sessions = own.flatMap((entry) => entry.sessions).filter((row) => after(row.createdAt, sinceIso));
    const passedVerdicts = own
      .flatMap((entry) => entry.passedVerdicts)
      .filter((row) => after(row.createdAt, sinceIso));
    const undos = own.flatMap((entry) => entry.undos).filter((row) => after(row.createdAt, sinceIso));
    return {
      sessions: sessions.slice(0, AUTHORITATIVE_READ_LIMIT),
      passedVerdicts: passedVerdicts.slice(0, AUTHORITATIVE_READ_LIMIT),
      undos: undos.slice(0, AUTHORITATIVE_READ_LIMIT),
      truncated:
        sessions.length > AUTHORITATIVE_READ_LIMIT ||
        passedVerdicts.length > AUTHORITATIVE_READ_LIMIT ||
        undos.length > AUTHORITATIVE_READ_LIMIT,
    };
  }
}

function after(value: string, sinceIso: string | null): boolean {
  if (sinceIso === null) {
    return true;
  }
  return new Date(value).getTime() > new Date(sinceIso).getTime();
}

interface MemoryTeachingRow extends TeachingEventRow {
  readonly tenantId: string;
  readonly sourceRef: string;
  readonly derivation: string;
}

/** 教学事件内存仓储(写入 + 保留期 + 聚合;零行级返回面)。 */
export class MemoryTeachingEventStore implements TeachingEventStore, TeachingAggregateStore {
  readonly #rows: MemoryTeachingRow[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  async appendDerived(tenantId: string, events: readonly DerivedTeachingEvent[]): Promise<number> {
    let appended = 0;
    for (const event of events) {
      const duplicate = this.#rows.some(
        (row) => row.tenantId === tenantId && row.kind === event.kind && row.sourceRef === event.sourceRef,
      );
      if (duplicate) {
        continue;
      }
      this.#rows.push({ ...event, tenantId });
      appended += 1;
    }
    return appended;
  }

  async purgeExpired(retentionDays: number): Promise<number> {
    const cutoff = this.now() - retentionDays * MS_PER_DAY;
    const kept = this.#rows.filter((row) => new Date(row.occurredAt).getTime() >= cutoff);
    const purged = this.#rows.length - kept.length;
    this.#rows.length = 0;
    this.#rows.push(...kept);
    return purged;
  }

  async aggregateByChallenge(tenantId: string): Promise<readonly ChallengeTeachingAggregate[]> {
    const rows: TeachingEventRow[] = this.#rows
      .filter((row) => row.tenantId === tenantId)
      .map((row) => ({
        kind: row.kind,
        occurredAt: row.occurredAt,
        challengeId: row.challengeId,
        challengeVersion: row.challengeVersion,
        subjectDigest: row.subjectDigest,
        eventCount: row.eventCount,
      }));
    return aggregateFromEventRows(rows);
  }

  /** 测试探针(仅计数与种类集合;零标识符;不是端口方法)。 */
  inspect(): { readonly rowCount: number; readonly kinds: readonly string[] } {
    return {
      rowCount: this.#rows.length,
      kinds: [...new Set(this.#rows.map((row) => row.kind))].sort(),
    };
  }
}

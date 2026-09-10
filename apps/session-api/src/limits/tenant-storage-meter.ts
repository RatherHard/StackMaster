/**
 * 租户存储配额计量(任务分解 WP-6 第 2 条;D-API-54)。
 *
 * T0 形态:已持久化快照密文行字节数 = SessionRepository.listSessionsByTenant ×
 * SnapshotStore.listBySession 的组合查询(端口零新增;教学规模会话数下成本
 * 可接受,且只在 create_checkpoint 预执行判定时调用)。阶段六全面租户隔离
 * 时复核为反规范化计数列(权威 API 语义规约 D-API-54 遗留项注记)。
 */
import type { SessionRepository, SnapshotStore } from "../persistence/ports.js";

export class TenantStorageQuotaMeter {
  readonly #sessions: SessionRepository;
  readonly #snapshots: SnapshotStore;

  constructor(sessions: SessionRepository, snapshots: SnapshotStore) {
    this.#sessions = sessions;
    this.#snapshots = snapshots;
  }

  /** 该租户已持久化快照的密文字节合计(checkpoints 行;不含对象存储双包)。 */
  async usedBytes(tenantId: string): Promise<number> {
    const sessionRows = await this.#sessions.listSessionsByTenant(tenantId);
    let total = 0;
    for (const row of sessionRows) {
      const records = await this.#snapshots.listBySession(row.sessionId, tenantId);
      for (const record of records) {
        total += record.byteSize;
      }
    }
    return total;
  }
}

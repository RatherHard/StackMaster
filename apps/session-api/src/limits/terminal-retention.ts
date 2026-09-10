/**
 * 终态会话保留窗口清理(任务分解 WP-6 第 3 条;D-API-55)。
 *
 * 终态(closed / crashed)会话行在保留窗口
 * (`SESSION_API_TERMINAL_SESSION_RETENTION_DAYS`,默认 30 天)期满后清除;
 * 清除前先按快照保留期(`SESSION_API_SNAPSHOT_RETENTION_DAYS`,D-API-25)清理
 * checkpoints 行,避免会话行清除后残留无主快照行。
 *
 * **T0 无 cron**:本类是可调用的清理入口(运维定时调用,与快照 purgeExpired
 * 同形态——D-API-25"由 purgeExpired 执行(运维定时调用)");Compose 面的
 * 定时编排归 WP-7 接线。清理是幂等的:重复调用对已清除行零效果。
 */
import type { SessionRepository, SnapshotStore } from "../persistence/ports.js";

/** 保留期(天)到毫秒的换算。 */
const DAY_MS = 86_400_000;

export interface TerminalRetentionPurgeSummary {
  /** 清除的终态会话行数。 */
  readonly purgedSessions: number;
  /** 清除的过期快照行数(checkpoints 表;先于会话行清除执行)。 */
  readonly purgedSnapshots: number;
}

export interface TerminalSessionCleanerOptions {
  readonly sessions: SessionRepository;
  readonly snapshots: SnapshotStore;
  /** 注入时钟(默认 Date.now;测试可注入验证窗口边界)。 */
  readonly now?: () => number;
}

export interface TerminalRetentionPurgeInput {
  /** 终态会话保留窗口(天;config.terminalSessionRetentionDays)。 */
  readonly terminalRetentionDays: number;
  /** 快照保留期(天;config.snapshotRetentionDays,D-API-25)。 */
  readonly snapshotRetentionDays: number;
}

export class TerminalSessionCleaner {
  readonly #sessions: SessionRepository;
  readonly #snapshots: SnapshotStore;
  readonly #now: () => number;

  constructor(options: TerminalSessionCleanerOptions) {
    this.#sessions = options.sessions;
    this.#snapshots = options.snapshots;
    this.#now = options.now ?? Date.now;
  }

  /**
   * 执行一轮过期清理(幂等;快照先行,会话行随后)。active 会话不受影响
   * (只清除终态行)。
   */
  async purgeExpired(input: TerminalRetentionPurgeInput): Promise<TerminalRetentionPurgeSummary> {
    const purgedSnapshots = await this.#snapshots.purgeExpired(input.snapshotRetentionDays);
    const cutoffIso = new Date(this.#now() - input.terminalRetentionDays * DAY_MS).toISOString();
    const purgedSessions = await this.#sessions.purgeTerminalSessionsBefore(cutoffIso);
    return { purgedSessions, purgedSnapshots };
  }
}

/**
 * 周期快照策略(WP-3;计划书 6.3"周期性 COW 快照",D-API-25)。
 *
 * 恢复点三触发点(纯策略,WP-4 装配到编排动作管线):
 *  - 显式 checkpoint(create_checkpoint 回执即快照);
 *  - 周期性自动快照:每 N revision 触发(N = config.autoSnapshotEveryRevisions,
 *    默认 50);
 *  - 会话关闭(close-session 前落终快照)。
 * 保留期:SESSION_API_SNAPSHOT_RETENTION_DAYS(默认 30 天),由
 * SnapshotStore.purgeExpired 执行(运维面定时调用)。
 */

import type { SnapshotOrigin } from "../ports.js";

/** 快照触发点 → checkpoints.origin 列值(一一对应)。 */
export type SnapshotTrigger = "explicit_checkpoint" | "periodic" | "session_close";

export interface AutoSnapshotPolicyOptions {
  /** 每 N revision 自动快照(≥ 1;config.autoSnapshotEveryRevisions)。 */
  readonly everyNRevisions: number;
}

export class AutoSnapshotPolicy {
  constructor(private readonly options: AutoSnapshotPolicyOptions) {
    if (!Number.isInteger(options.everyNRevisions) || options.everyNRevisions < 1) {
      throw new Error("AutoSnapshotPolicy:everyNRevisions 必须为正整数(config 启动校验已拦截)");
    }
  }

  originOf(trigger: SnapshotTrigger): SnapshotOrigin {
    return trigger === "periodic" ? "auto_periodic" : trigger;
  }

  /**
   * revision 推进后的自动快照判定(显式 checkpoint 与会话关闭不在此判定,
   * 由各自触发点直接落快照)。
   * @param revisionsSinceLastSnapshot 距最近快照(任意来源)推进的 revision 数
   */
  shouldAutoSnapshot(revisionsSinceLastSnapshot: number): boolean {
    return revisionsSinceLastSnapshot >= this.options.everyNRevisions;
  }

  /** 下一自动快照点前还需推进的 revision 数(可观测 / 配额面)。 */
  revisionsUntilNextSnapshot(revisionsSinceLastSnapshot: number): number {
    return Math.max(0, this.options.everyNRevisions - revisionsSinceLastSnapshot);
  }
}

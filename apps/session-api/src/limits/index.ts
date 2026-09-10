/**
 * 限流、配额与会话资源回收(WP-6;barrel)。
 *
 * 模块清单:
 *  - errors:触顶确定性异常(呈现面 = error-mapping 429 冻结形态);
 *  - rate-gate:固定窗口频率闸(WP-3 RateLimitCounter 载体);
 *  - create-session-guard:D-API-35 接入点的执行面(频率 + 并发预算快检);
 *  - session-action-rate-limiter:每会话动作频率(与每连接令牌桶同源叠加);
 *  - checkpoint-quota / tenant-storage-meter:存储与快照配额;
 *  - terminal-retention:终态会话保留窗口清理入口(T0 无 cron,可调用);
 *  - session-recycling:断线保持到期回收的钩子接线。
 */
export { RateLimitExceeded, ConcurrentSessionBudgetExhausted } from "./errors.js";
export type { RateLimitDimension } from "./errors.js";
export { FixedWindowRateGate, RATE_LIMIT_WINDOW_SECONDS } from "./rate-gate.js";export { RateLimitedCreateSessionGuard, tenantUserRateKey } from "./create-session-guard.js";
export { SessionActionRateLimiter } from "./session-action-rate-limiter.js";
export {
  evaluateCheckpointQuota,
  envelopeByteLength,
  CHECKPOINT_QUOTA_MESSAGES,
} from "./checkpoint-quota.js";
export type { CheckpointQuotaLimits, CheckpointQuotaVerdict } from "./checkpoint-quota.js";
export { TenantStorageQuotaMeter } from "./tenant-storage-meter.js";
export { TerminalSessionCleaner } from "./terminal-retention.js";
export type {
  TerminalRetentionPurgeSummary,
  TerminalRetentionPurgeInput,
} from "./terminal-retention.js";
export { keepaliveExpiryReaper } from "./session-recycling.js";
export type { KeepaliveExpiryHook } from "./session-recycling.js";

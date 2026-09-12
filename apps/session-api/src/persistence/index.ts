/**
 * 持久化面 barrel(WP-3;导出可装配的适配器工厂与端口)。
 *
 * 装配面(给 WP-4;权威 API 语义规约 §四"登记中的决策"):
 *  - 连接生命周期:configurePersistence(config) 一次性建立 PG 池 / Redis
 *    连接 / MinIO 客户端并装配全部端口实现;closePersistence(pool/redis)
 *    在优雅停机步骤中调用(index.ts 停机序列的"在途会话状态落盘"之后);
 *  - 迁移时机:启动装配后、监听前调用 runMigrations(pool, migrations)(见
 *    loadMigrationsFromDir;失败即拒绝启动,fail-closed);
 *  - 本模块**不做** src/index.ts / src/server.ts 装配(最终装配归 WP-4);
 *  - 未接线期与单元测试使用 memory-stores 的内存实现。
 */

export { PersistenceError } from "./errors.js";
export type { PersistenceErrorCode } from "./errors.js";
export * from "./ports.js";
export { SnapshotCipher, decodeSnapshotEncryptionKey, SNAPSHOT_KEY_BYTES, SNAPSHOT_CIPHER_ENVELOPE_VERSION } from "./snapshot-cipher.js";
export { scanSecretCorpus, SECRET_CORPUS_PATTERNS } from "./secret-scanner.js";
export type { SecretCorpusHit } from "./secret-scanner.js";
export {
  MemoryKeyValueStore,
  MemoryRouteStore,
  MemoryRateLimitCounter,
  MemorySessionRepository,
  MemorySnapshotStore,
  MemoryActionLogStore,
  MemorySubmissionStore,
  MemoryChallengeBundleStore,
  MemoryChallengeRegistry,
  MemoryIdempotencyWindow,
} from "./memory-stores.js";
export type { Clock, ChallengeObjectKey } from "./memory-stores.js";
export {
  REDIS_DEGRADE_POLICY,
  RedisIdempotencyWindow,
  ResilientIdempotencyWindow,
} from "./idempotency-window.js";
export type { RedisDependency, RedisLike, DegradeClass, DegradeListener } from "./idempotency-window.js";
export {
  RedisKeyValueStore,
  RedisRouteStore,
  RedisRateLimitCounter,
  createRedisConnection,
} from "./redis/redis-stores.js";
export { createPostgresPool, closePostgresPool } from "./pg/connection.js";
export { loadMigrationsFromDir, runMigrations, createActionLogPartition } from "./pg/run-migrations.js";
export type { Migration, MigrationRunResult } from "./pg/run-migrations.js";
export { PostgresSessionRepository } from "./pg/session-repository.js";
export { PostgresSnapshotStore } from "./pg/snapshot-store.js";
export { PostgresActionLogStore, PostgresSubmissionStore } from "./pg/log-stores.js";
export { PostgresChallengeRegistry } from "./pg/challenge-registry.js";
export { PgAuditSink } from "./pg/audit-sink.js";
export {
  AUDIT_ARCHIVE_FORMAT,
  AUDIT_ARCHIVE_MANIFEST_FORMAT,
  AUDIT_ARCHIVE_OBJECT_PREFIX,
  AuditArchiveJob,
  buildAuditArchiveManifest,
  deriveAuditArchiveBatchId,
  serializeAuditArchiveRows,
} from "./audit-archive.js";
export type {
  AuditArchiveJobOptions,
  AuditArchiveManifest,
  AuditArchiveOutcome,
  AuditArchiveRunResult,
  ArchivedAuditRow,
} from "./audit-archive.js";
export { MinioChallengeBundleStore, createMinioClient } from "./minio/challenge-bundle-store.js";
export type { MinioLike, MinioBundleStoreOptions } from "./minio/challenge-bundle-store.js";
export {
  ChallengeRegistrar,
  registrationSignatureBasis,
  sha256Hex,
} from "./challenges/register-challenge.js";
export type { RegisterChallengeInput, RegisteredChallenge, SigningPublicKey } from "./challenges/register-challenge.js";
export { SnapshotPersistence } from "./recovery/snapshot-persistence.js";
export type { PersistSnapshotInput, LoadedSnapshot } from "./recovery/snapshot-persistence.js";
export { SessionRecoveryService } from "./recovery/recovery-plan.js";
export type { RecoveryPlan, SessionRecoveryDeps } from "./recovery/recovery-plan.js";
export { AutoSnapshotPolicy } from "./recovery/auto-snapshot-policy.js";
export type { SnapshotTrigger, AutoSnapshotPolicyOptions } from "./recovery/auto-snapshot-policy.js";

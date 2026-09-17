/**
 * 教学采集面 barrel(中期 M3 WP-82;采集载体重建 + 服务端可派生三类 + 聚合
 * 受控查询)。口径与决策见 `docs/develop/decisions-m3/WP-82.md`(D-API-149 ~
 * D-API-151)与 `migrations/008_teaching_events.sql`。
 */

export {
  CLIENT_REPORTED_TEACHING_KINDS,
  COLLECTIBLE_TEACHING_EVENT_KINDS,
  PASSING_VERDICT,
  TEACHING_DERIVATION_VERSION,
  TEACHING_EVENT_COLLECTABILITY,
  TEACHING_EVENT_KINDS,
  TEACHING_EVENT_RETENTION_DAYS,
  UNDO_ACTION_TYPE,
  collectabilityOf,
  isCollectibleTeachingEventKind,
} from "./kinds.js";
export type {
  CollectibleTeachingEventKind,
  TeachingCollectability,
  TeachingEventCollectabilityEntry,
  TeachingEventKind,
} from "./kinds.js";
export {
  deriveChallengeStartedEvents,
  derivePassedEvents,
  deriveTeachingEvents,
  deriveUndoEvents,
  digestSessionSubject,
} from "./derive.js";
export type {
  AuthoritativeSessionRow,
  AuthoritativeTeachingRows,
  AuthoritativeUndoActionRow,
  AuthoritativeVerdictRow,
  DerivedTeachingEvent,
  TeachingEventRow,
} from "./derive.js";
export {
  FIRST_PASS_QUANTILES,
  TEACHING_AGGREGATE_FIELDS,
  aggregateFromEventRows,
  assembleAggregates,
  countsFromEventRows,
  firstPassSamplesFromEventRows,
  quantileNearestRank,
  renderTeachingAggregateReport,
} from "./aggregate.js";
export type {
  ChallengeEventCounts,
  ChallengeFirstPassSample,
  ChallengeTeachingAggregate,
  TeachingAggregateField,
} from "./aggregate.js";
export {
  D_API_107_OBSERVATION_ALIGNMENT,
  availabilityOf,
  availabilityTally,
  observationAlignmentOf,
} from "./observation-points.js";
export type {
  ChallengeObservationAlignment,
  ObservationAvailability,
  ObservationPointEntry,
  ObservationSource,
} from "./observation-points.js";
export { assertTeachingAggregateDiscipline } from "./discipline.js";
export type { TeachingDisciplineViolation } from "./discipline.js";
export { AUTHORITATIVE_READ_LIMIT } from "./ports.js";
export type {
  AuthoritativeTeachingSource,
  TeachingAggregateStore,
  TeachingEventStore,
} from "./ports.js";
export { TEACHING_COLLECTION_FAILURE_REASON, TeachingEventCollector } from "./collector.js";
export type { TeachingCollectionOutcome, TeachingEventCollectorOptions } from "./collector.js";
export { MemoryAuthoritativeTeachingSource, MemoryTeachingEventStore } from "./memory.js";
export { PostgresAuthoritativeTeachingSource } from "./pg/authoritative-source.js";
export { PostgresTeachingEventStore } from "./pg/teaching-events-store.js";
export { buildTeachingCollection } from "./assembly.js";
export type { TeachingCollectionAssembly } from "./assembly.js";

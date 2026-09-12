/**
 * 裁决管线(WP-61 / WP-62):单个已认领 run 的端到端处置。
 *
 * 服务序(每步确定性,失败方向登记于 D-API-87 / ADR-9):
 *
 * ```text
 * 引用受理(结构 + 六记录项完备性;缺项 = 裁决无效 → challenge_invalid)
 *   → log_digest 复算比对(不符 = 拒裁 → run failed,D-API-85)
 *   → 登记行取回(未登记 → challenge_invalid,D-API-32 同形)
 *   → 双包取回(缺失 → challenge_invalid;越权 / 存储故障 → run failed)
 *   → 双包哈希与 challenge_versions 登记值比对(不符 = 拒裁 → run failed)
 *   → seed 策略边界(server_random_per_session → challenge_invalid;v1
 *     seed 零驻留,边界裁决 3)
 *   → bundle lock(包声明引擎版本 vs worker 自报;不一致 = replay_mismatch
 *     方向拒裁,版本策略 §四.4)
 *   → verify(spawn 一次性 worker;ADR-8 同一份 replay,隐藏测试汇总由
 *     引擎侧在重放终态上合成,判题语义规约 §八·一)
 *   → 裁决落库 + 审计发射(completed + verdicts 幂等 + audit_log 追加,
 *     同事务;或 run failed + 审计,重试新 run 行)
 * ```
 *
 * 裁决幂等:已有 verdicts 行的 submission 不再认领(队列侧)+ verdicts
 * `submission_id` 唯一 ON CONFLICT DO NOTHING(库侧),同 submission 重复
 * 裁决确定性同判、不重复写入。
 *
 * 审计发射(D-API-95,一 run 一事件;kind 记录安全事实而非 run 状态):
 * 引擎合成裁决 ⇒ `verdict_completed`;拒裁方向 ⇒ `verdict_rejected`(detail
 * 携方向码);执行面故障 ⇒ `verdict_replay_failed`。发射与 run 处置同事务
 * 落库——append 失败即处置整体回滚(fail-closed,D-API-91 同构)。
 */
import { createHash } from "node:crypto";
import type { Logger } from "pino";

import { parseSubmitReference, type ReplayMaterial } from "./reference.js";
import { parseVerdict } from "./verdict.js";
import { VerifyWorkerClient, type VerifyOutcome, type WorkerCommandSpec } from "./worker/verify-client.js";
import type {
  BundleSource,
  ChallengeSource,
  ClaimedRun,
  VerdictAuditEvent,
  VerdictQueue,
} from "./persistence/ports.js";
import { VerifierStoreError } from "./persistence/pg-stores.js";

/** 裁决完成面(run completed + verdicts 幂等行)。 */
interface Completed {
  readonly kind: "completed";
  readonly verdict: string;
  readonly detail: unknown;
  /** 拒裁方向码(裁决面结论中的拒裁路径;引擎合成裁决为 undefined)。 */
  readonly rejection?: string;
}

/** 裁决不可用面(run failed;重试新 run 行;查询面恒为 pending)。 */
interface Failed {
  readonly kind: "failed";
  readonly reason: string;
}

/** 单 run 处置的收敛面。 */
type Adjudication = Completed | Failed;

/**
 * 拒裁方向码封闭集(D-API-95;verdict_rejected 的 detail.direction 域):
 * 输入完整性 / 授权完整性 / 形态完备性事实导致裁决请求被拒的方向。落于
 * completed 处置的拒裁方向(verdicts 行照常落库,D-API-87 主从关系)与
 * failed 处置的拒裁方向共用同一封闭集。
 */
const REJECTED_DIRECTIONS: ReadonlySet<string> = new Set([
  "six_records_incomplete",
  "challenge_version_unregistered",
  "challenge_bundle_missing",
  "seed_policy_unverifiable",
  "bundle_lock_mismatch",
  "worker_rejected",
  "log_digest_mismatch",
  "bundle_hash_mismatch",
  "bundle_access_denied",
  "bundle_json_unparseable",
  "action_log_over_frame_budget",
]);

export interface AdjudicatorOptions {
  readonly queue: VerdictQueue;
  readonly challenges: ChallengeSource;
  readonly bundles: BundleSource;
  readonly maxAttempts: number;
  readonly maxActionLogBytes: number;
  readonly verifyTimeoutMs: number;
  readonly workerSpec: WorkerCommandSpec;
  readonly logger: Logger;
  readonly onVerdict?: (verdict: string) => void;
  readonly onOutcome?: (outcome: "completed" | "failed") => void;
}

/** 处置一个已认领 run(管线内任何异常都收敛为 run failed,不外抛)。 */
export async function adjudicateRun(
  run: ClaimedRun,
  options: AdjudicatorOptions,
): Promise<Adjudication> {
  try {
    const outcome = await adjudicateRunInner(run, options);
    if (outcome.kind === "completed") {
      const audit: VerdictAuditEvent = {
        kind: outcome.rejection === undefined ? "verdict_completed" : "verdict_rejected",
        at: Date.now(),
        detail:
          outcome.rejection === undefined
            ? { submissionId: run.submissionId, verdict: outcome.verdict }
            : { submissionId: run.submissionId, direction: outcome.rejection },
      };
      await options.queue.complete({
        runId: run.runId,
        submissionId: run.submissionId,
        tenantId: run.tenantId,
        sessionId: run.sessionId,
        verdict: outcome.verdict,
        detail: outcome.detail,
        audit,
      });
      options.onVerdict?.(outcome.verdict);
      options.onOutcome?.("completed");
      options.logger.info(
        { runId: run.runId, submissionId: run.submissionId, verdict: outcome.verdict, audit: audit.kind },
        "verdict recorded",
      );
    } else {
      const audit: VerdictAuditEvent = {
        kind: REJECTED_DIRECTIONS.has(outcome.reason) ? "verdict_rejected" : "verdict_replay_failed",
        at: Date.now(),
        detail: { submissionId: run.submissionId, direction: outcome.reason },
      };
      await options.queue.fail({
        runId: run.runId,
        tenantId: run.tenantId,
        submissionId: run.submissionId,
        sessionId: run.sessionId,
        attemptCount: run.attemptCount,
        reason: outcome.reason,
        maxAttempts: options.maxAttempts,
        audit,
      });
      options.onOutcome?.("failed");
      options.logger.warn(
        {
          runId: run.runId,
          submissionId: run.submissionId,
          reason: outcome.reason,
          attempt: run.attemptCount,
          willRetry: run.attemptCount < options.maxAttempts,
          audit: audit.kind,
        },
        "verifier run failed",
      );
    }
    return outcome;
  } catch (error) {
    // 管线异常(存储故障等):收敛为 run failed(fail-closed,不静默放行);
    // fail 自身失败时只进受控日志,行由下一轮认领语义兜底。审计与处置同
    // 事务——存储不可达时处置与审计一同缺席(受控日志留痕,重试链承接)。
    const reason = error instanceof VerifierStoreError ? "store_unavailable" : "internal_error";
    options.logger.error(
      { runId: run.runId, err: error instanceof Error ? error.message : String(error) },
      "adjudication pipeline error",
    );
    try {
      await options.queue.fail({
        runId: run.runId,
        tenantId: run.tenantId,
        submissionId: run.submissionId,
        sessionId: run.sessionId,
        attemptCount: run.attemptCount,
        reason,
        maxAttempts: options.maxAttempts,
        audit: { kind: "verdict_replay_failed", at: Date.now(), detail: { submissionId: run.submissionId, direction: reason } },
      });
    } catch (failError) {
      options.logger.error(
        { runId: run.runId, err: failError instanceof Error ? failError.message : String(failError) },
        "verifier run failure persistence failed",
      );
    }
    options.onOutcome?.("failed");
    return { kind: "failed", reason };
  }
}

async function adjudicateRunInner(
  run: ClaimedRun,
  options: AdjudicatorOptions,
): Promise<Adjudication> {
  // ── 1. 引用受理:结构 + 六记录项完备性(缺项 = 裁决无效)──
  const reference = parseSubmitReference(run.reference);
  if (reference === null) {
    return completed("challenge_invalid", { reason: "six_records_incomplete" }, "six_records_incomplete");
  }
  const material: ReplayMaterial = reference.replay;

  // ── 2. log_digest 复算比对(篡改检测锚;不符 = 拒裁方向,D-API-85)──
  const digest = createHash("sha256").update(material.actionLog, "utf8").digest("hex");
  if (run.logDigest !== null && run.logDigest !== digest) {
    return failed("log_digest_mismatch");
  }
  if (material.actionLog.length > options.maxActionLogBytes) {
    return failed("action_log_over_frame_budget");
  }

  // ── 3. 登记行取回(未登记 = challenge_invalid,D-API-32 同形防枚举)──
  const registration = await options.challenges.findVersion(
    run.tenantId,
    reference.challenge.challengeId,
    reference.challenge.challengeContentVersion,
  );
  if (registration === null) {
    return completed("challenge_invalid", { reason: "challenge_version_unregistered" }, "challenge_version_unregistered");
  }

  // ── 4. 双包取回(各归其桶:私有判题包 private-bundles、公开描述包
  //       public-descriptors,对象名取登记行;缺失 = challenge_invalid
  //       同形;越权 / 故障 = 拒裁)──
  let bundleBytes: Uint8Array | null;
  let descriptorBytes: Uint8Array | null;
  try {
    bundleBytes = await options.bundles.getPrivate(registration.privateBundleObject);
    descriptorBytes = await options.bundles.getPublic(registration.publicDescriptorObject);
  } catch (error) {
    const code = (error as { code?: string }).code;
    options.logger.warn(
      { runId: run.runId, code: code ?? "unknown" },
      "private bundle retrieval denied or failed",
    );
    return failed(code === "AccessDenied" ? "bundle_access_denied" : "bundle_unavailable");
  }
  if (bundleBytes === null || descriptorBytes === null) {
    return completed("challenge_invalid", { reason: "challenge_bundle_missing" }, "challenge_bundle_missing");
  }

  // ── 5. 双包哈希与 challenge_versions 登记值比对(不符 = 拒裁)──
  if (
    sha256Hex(bundleBytes) !== registration.privateBundleSha256 ||
    sha256Hex(descriptorBytes) !== registration.publicDescriptorSha256
  ) {
    return failed("bundle_hash_mismatch");
  }

  // ── 6. seed 策略边界(v1 seed 零驻留:server_random 裁决面不摄入 seed,
  //       边界裁决 3;重放自零起始不可达 → challenge_invalid 方向)──
  if (material.replayContext.seedPolicy.strategy === "server_random_per_session") {
    return completed("challenge_invalid", { reason: "seed_policy_unverifiable" }, "seed_policy_unverifiable");
  }

  // ── 7~8. bundle lock + verify(一次性 worker 进程)──
  let bundleJson: unknown;
  let descriptorJson: unknown;
  try {
    bundleJson = JSON.parse(new TextDecoder().decode(bundleBytes)) as unknown;
    descriptorJson = JSON.parse(new TextDecoder().decode(descriptorBytes)) as unknown;
  } catch {
    return failed("bundle_json_unparseable");
  }
  // 廉价结构闸(TS 侧;权威校验在 worker 装载管线)。vmEngineVersion 是
  // bundle lock 的必需面(private-bundle.schema required);engineBuildId 为
  // schema 可选字段(Rust 镜像 Option<String>,作者包可不声明)——缺席按
  // 无构建级声明处置(跳过比对,与下方 bundle lock 容忍语义一致),不在
  // 此拒裁。
  if (typeof bundleJson !== "object" || bundleJson === null) {
    return failed("bundle_json_unparseable");
  }
  const declared = bundleJson as {
    vmEngineVersion?: unknown;
    engineBuildId?: unknown;
  };
  if (typeof declared.vmEngineVersion !== "string") {
    return completed("challenge_invalid", { reason: "six_records_incomplete" }, "six_records_incomplete");
  }

  let worker: VerifyWorkerClient;
  try {
    worker = await VerifyWorkerClient.spawn(options.workerSpec);
  } catch (error) {
    return failed(
      error instanceof Error && error.name === "VerifyClientError"
        ? (error as unknown as { reason?: string }).reason ?? "spawn_failed"
        : "spawn_failed",
    );
  }
  try {
    // bundle lock(版本策略 §四.4):包声明引擎构建 vs worker 自报;
    // 不一致 = replay_mismatch 方向拒裁(Q1 定案;worker 自身的同锁校验
    // 是第二道防线,方向 challenge_invalid)。构建 ID 为包内可选声明:
    // 缺席 / 空串 = 无构建级声明,仅比版本(与 worker 侧 Option 语义同构)。
    const declaredBuildId =
      typeof declared.engineBuildId === "string" ? declared.engineBuildId : "";
    if (
      declared.vmEngineVersion !== worker.ready.vmEngineVersion ||
      (declaredBuildId !== "" && declaredBuildId !== worker.ready.engineBuildId)
    ) {
      return completed("replay_mismatch", { reason: "bundle_lock_mismatch" }, "bundle_lock_mismatch");
    }
    const outcome: VerifyOutcome = await worker.verify(
      {
        privateBundle: bundleJson,
        publicDescriptor: descriptorJson,
        replayContext: material.replayContext,
        actionLog: material.actionLog,
      },
      options.verifyTimeoutMs,
    );
    // 引擎 logDigest 复算值与提交时登记锚的一致性(TS / 引擎双侧同源校验)。
    if (outcome.kind === "report") {
      if (outcome.report.logDigest !== "" && outcome.report.logDigest !== digest) {
        return failed("log_digest_mismatch");
      }
      const verdict = parseVerdict(outcome.report.verdict);
      if (verdict === null) {
        return failed("invalid_verdict_literal");
      }
      // 隐藏测试汇总面随裁决入 SERVER_ONLY 明细列(D-API-96;仅索引与
      // 判定值,谓词内容 / testId 零公开面)。
      return completed(verdict, {
        replay: outcome.report.replay,
        logDigest: digest,
        hiddenTests: outcome.report.hiddenTests,
      });
    }
    if (outcome.kind === "command_error") {
      if (outcome.code === "challenge_invalid") {
        return completed("challenge_invalid", { reason: "worker_rejected" }, "worker_rejected");
      }
      return failed(`worker_command_error:${outcome.code}`);
    }
    return failed(outcome.reason);
  } finally {
    await worker.dispose();
  }
}

function completed(verdict: string, detail: unknown, rejection?: string): Completed {
  return { kind: "completed", verdict, detail, rejection };
}

function failed(reason: string): Failed {
  return { kind: "failed", reason };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

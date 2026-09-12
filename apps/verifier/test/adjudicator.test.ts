/**
 * 裁决管线矩阵测试(WP-61):每条完成标准红灯逐项可测(内存端口 + 假
 * verify worker;判定面 = queue 落库结论)。
 *
 * 形态:run 一律经 `queue.claim` 产出(与生产认领路径同构;内存队列与
 * PG 语义一致:attempts 守卫 / verdicts 幂等 / 重试新行)。
 *
 * 完成标准承接:
 *  - 篡改动作日志(log_digest 复算不符)→ 拒裁方向(run failed);
 *  - 六记录项缺项 → 裁决无效(challenge_invalid 落 verdicts);
 *  - 私有包取回越权 / 哈希不符 → 拒裁红灯(run failed);
 *  - verify_bundle_lock 不一致 → replay_mismatch 方向拒裁;
 *  - 同 submission 重复裁决确定性同判、不重复写入(幂等);
 *  - 重试以新 run 行承载,耗尽后查询面恒为 pending。
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Logger } from "pino";

import { adjudicateRun, type AdjudicatorOptions } from "../src/adjudicator.js";
import {
  MemoryBundleSource,
  MemoryChallengeSource,
  MemoryVerdictQueue,
  sha256Hex,
  validReference,
} from "./helpers/memory-ports.js";

// 路径锚:本文件位置(根级覆盖率 projects 形态下 cwd 是仓库根,不得用
// process.cwd();import.meta.url 形态与会话编排 boot 集成测试同款)。
const FAKE_WORKER = fileURLToPath(new URL("./helpers/fake-verify-worker.mjs", import.meta.url));

/** 私有包 / 公开描述包(合法 JSON;声明引擎与假 worker 同版本)。 */
const BUNDLE_JSON = '{"vmEngineVersion":"0.1.0","engineBuildId":"dev"}';
const DESCRIPTOR_JSON = '{"schemaVersion":1}';

const REGISTRATION = {
  privateBundleSha256: sha256Hex(BUNDLE_JSON),
  publicDescriptorSha256: sha256Hex(DESCRIPTOR_JSON),
  privateBundleObject: "chal-1/1.0.0/bundle.json",
  publicDescriptorObject: "chal-1/1.0.0/descriptor.json",
};

const BUNDLES = new Map<string, Uint8Array>([
  ["chal-1/1.0.0/bundle.json", new TextEncoder().encode(BUNDLE_JSON)],
  ["chal-1/1.0.0/descriptor.json", new TextEncoder().encode(DESCRIPTOR_JSON)],
]);

const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

const SUBMISSION_ID = "11111111-1111-1111-1111-111111111111";

/** 假 worker 的 report 摘要与 TS 复算同源(引擎 / TS 双侧一致性路径)。 */
const DIGEST_OF_REFERENCE = sha256Hex(
  (validReference() as { replay: { actionLog: string } }).replay.actionLog,
);

function options(
  queue: MemoryVerdictQueue,
  overrides: Partial<AdjudicatorOptions> = {},
): AdjudicatorOptions {
  return {
    queue,
    challenges: new MemoryChallengeSource(
      new Map([["tenant-1|chal-1|1.0.0", REGISTRATION]]),
    ),
    bundles: new MemoryBundleSource(BUNDLES),
    maxAttempts: 3,
    maxActionLogBytes: 4_194_304,
    verifyTimeoutMs: 5_000,
    workerSpec: {
      command: process.execPath,
      args: [FAKE_WORKER],
      env: [["FAKE_LOG_DIGEST", DIGEST_OF_REFERENCE]],
    },
    logger,
    ...overrides,
  };
}

/** 认领第一个 pending run(生产认领路径;run 一律来自真实入队行)。 */
async function claimFirst(queue: MemoryVerdictQueue, opts: AdjudicatorOptions) {
  const claimed = await queue.claim(10, opts.maxAttempts);
  return claimed[0] ?? null;
}

describe("adjudicateRun(裁决管线矩阵)", () => {
  it("正常路径:合法引用 + 假 worker 报告 → completed + verdicts 落库", async () => {
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: DIGEST_OF_REFERENCE, reference: validReference() },
    ]);
    const opts = options(queue);
    const run = await claimFirst(queue, opts);
    expect(run).not.toBeNull();
    const outcome = await adjudicateRun(run!, opts);
    expect(outcome).toMatchObject({ kind: "completed", verdict: "success" });
    const verdict = queue.verdicts.get(SUBMISSION_ID);
    expect(verdict?.verdict).toBe("success");
    expect(verdict?.detail).toHaveProperty("logDigest", DIGEST_OF_REFERENCE);
  }, 15_000);

  it("篡改检测锚:log_digest 复算不符 → run failed(拒裁方向,不落 verdicts)", async () => {
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: "f".repeat(64), reference: validReference() },
    ]);
    const opts = options(queue);
    const outcome = await adjudicateRun((await claimFirst(queue, opts))!, opts);
    expect(outcome).toEqual({ kind: "failed", reason: "log_digest_mismatch" });
    expect(queue.verdicts.size).toBe(0);
    // 重试以新 pending run 行承载(D-API-85)。
    expect(queue.runs.filter((candidate) => candidate.status === "pending")).toHaveLength(1);
  }, 15_000);

  it("六记录项缺项(replay 整体缺席的旧引用)→ challenge_invalid 裁决无效面", async () => {
    const reference = validReference() as Record<string, unknown>;
    delete reference["replay"];
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: null, reference },
    ]);
    const opts = options(queue);
    const outcome = await adjudicateRun((await claimFirst(queue, opts))!, opts);
    expect(outcome).toMatchObject({ kind: "completed", verdict: "challenge_invalid" });
    expect(queue.verdicts.get(SUBMISSION_ID)?.detail).toEqual({
      reason: "six_records_incomplete",
    });
  });

  it("版本未登记 → challenge_invalid(D-API-32 同形)", async () => {
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: null, reference: validReference({ challengeId: "chal-other" }) },
    ]);
    const opts = options(queue);
    const outcome = await adjudicateRun((await claimFirst(queue, opts))!, opts);
    expect(outcome).toMatchObject({ kind: "completed", verdict: "challenge_invalid" });
  });

  it("双包缺失(登记行在、桶内无对象)→ challenge_invalid 同形", async () => {
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: null, reference: validReference() },
    ]);
    const opts = options(queue, { bundles: new MemoryBundleSource(new Map()) });
    const outcome = await adjudicateRun((await claimFirst(queue, opts))!, opts);
    expect(outcome).toMatchObject({ kind: "completed", verdict: "challenge_invalid" });
  });

  it("私有包取回越权(AccessDenied)→ run failed 红灯", async () => {
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: null, reference: validReference() },
    ]);
    const opts = options(queue, { bundles: new MemoryBundleSource(BUNDLES, { denied: true }) });
    const outcome = await adjudicateRun((await claimFirst(queue, opts))!, opts);
    expect(outcome).toEqual({ kind: "failed", reason: "bundle_access_denied" });
    expect(queue.verdicts.size).toBe(0);
  });

  it("双包哈希与登记值不符 → run failed 红灯(拒裁,重试)", async () => {
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: null, reference: validReference() },
    ]);
    const bundles = new Map([
      ["chal-1/1.0.0/bundle.json", new TextEncoder().encode("tampered-bundle")],
      ["chal-1/1.0.0/descriptor.json", new TextEncoder().encode(DESCRIPTOR_JSON)],
    ]);
    const opts = options(queue, { bundles: new MemoryBundleSource(bundles) });
    const outcome = await adjudicateRun((await claimFirst(queue, opts))!, opts);
    expect(outcome).toEqual({ kind: "failed", reason: "bundle_hash_mismatch" });
    expect(queue.verdicts.size).toBe(0);
  });

  it("verify_bundle_lock 不一致(包声明引擎版本 ≠ worker 自报)→ replay_mismatch 方向拒裁", async () => {
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: null, reference: validReference() },
    ]);
    const opts = options(queue, {
      workerSpec: {
        command: process.execPath,
        args: [FAKE_WORKER],
        env: [["FAKE_WORKER_VERSION", "9.9.9"]],
      },
    });
    const outcome = await adjudicateRun((await claimFirst(queue, opts))!, opts);
    expect(outcome).toMatchObject({ kind: "completed", verdict: "replay_mismatch" });
    expect(queue.verdicts.get(SUBMISSION_ID)?.detail).toEqual({
      reason: "bundle_lock_mismatch",
    });
  }, 15_000);

  it("worker 命令级 challenge_invalid → challenge_invalid 裁决(装载拒绝面)", async () => {
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: null, reference: validReference() },
    ]);
    const opts = options(queue, {
      workerSpec: {
        command: process.execPath,
        args: [FAKE_WORKER],
        env: [
          ["FAKE_MODE", "command_error_challenge_invalid"],
          ["FAKE_LOG_DIGEST", DIGEST_OF_REFERENCE],
        ],
      },
    });
    const outcome = await adjudicateRun((await claimFirst(queue, opts))!, opts);
    expect(outcome).toMatchObject({ kind: "completed", verdict: "challenge_invalid" });
  }, 15_000);

  it("server_random_per_session(v1 seed 零驻留边界)→ challenge_invalid,零 worker 往返", async () => {
    const reference = validReference() as {
      replay: { replayContext: { seedPolicy: { strategy: string } } };
    };
    reference.replay.replayContext.seedPolicy.strategy = "server_random_per_session";
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: null, reference },
    ]);
    // 零 worker 往返:workerSpec 指向不存在的二进制也不可触发 spawn。
    const opts = options(queue, { workerSpec: { command: "definitely-not-a-binary-xyz" } });
    const outcome = await adjudicateRun((await claimFirst(queue, opts))!, opts);
    expect(outcome).toMatchObject({ kind: "completed", verdict: "challenge_invalid" });
  });

  it("重试耗尽(maxAttempts)→ 不再入队新 pending 行(查询面恒为 pending)", async () => {
    const reference = validReference();
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: "f".repeat(64), reference },
      { submissionId: SUBMISSION_ID, logDigest: "f".repeat(64), reference },
      { submissionId: SUBMISSION_ID, logDigest: "f".repeat(64), reference },
    ]);
    const opts = options(queue);
    const claimed = await queue.claim(10, 3);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.attemptCount).toBe(3);
    const outcome = await adjudicateRun(claimed[0]!, opts);
    expect(outcome.kind).toBe("failed");
    expect(queue.runs.filter((candidate) => candidate.status === "pending")).toHaveLength(0);
    expect(queue.verdicts.size).toBe(0);
  });

  it("裁决幂等:已有 verdicts 行的 submission 不再认领(不重复写入)", async () => {
    const queue = new MemoryVerdictQueue();
    await queue.complete({
      runId: "run-0",
      submissionId: SUBMISSION_ID,
      tenantId: "tenant-1",
      verdict: "success",
      detail: null,
    });
    // 同 submission 重复入队(pending 行在场)也不被认领。
    queue.runs.push({
      runId: "run-9",
      tenantId: "tenant-1",
      submissionId: SUBMISSION_ID,
      status: "pending",
      logDigest: null,
      attemptCount: 2,
      reference: validReference(),
    });
    const claimed = await queue.claim(10, 3);
    expect(claimed).toHaveLength(0);
    // 重复 complete 不改写既有裁决(确定性同判)。
    await queue.complete({
      runId: "run-0",
      submissionId: SUBMISSION_ID,
      tenantId: "tenant-1",
      verdict: "wrong_answer",
      detail: null,
    });
    expect(queue.verdicts.get(SUBMISSION_ID)?.verdict).toBe("success");
  });

  it("worker 侧 log_digest 复算不符(引擎响应 ≠ TS 复算)→ run failed(双侧同源校验)", async () => {
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: null, reference: validReference() },
    ]);
    const opts = options(queue, {
      workerSpec: {
        command: process.execPath,
        args: [FAKE_WORKER],
        env: [["FAKE_LOG_DIGEST", "d".repeat(64)]],
      },
    });
    const outcome = await adjudicateRun((await claimFirst(queue, opts))!, opts);
    expect(outcome).toEqual({ kind: "failed", reason: "log_digest_mismatch" });
    expect(queue.verdicts.size).toBe(0);
  }, 15_000);

  it("worker 报告非 11 值裁决字面 → run failed(引擎契约漂移,不落 verdicts)", async () => {
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: null, reference: validReference() },
    ]);
    const opts = options(queue, {
      workerSpec: {
        command: process.execPath,
        args: [FAKE_WORKER],
        env: [
          ["FAKE_VERDICT", "bogus"],
          ["FAKE_LOG_DIGEST", DIGEST_OF_REFERENCE],
        ],
      },
    });
    const outcome = await adjudicateRun((await claimFirst(queue, opts))!, opts);
    expect(outcome).toEqual({ kind: "failed", reason: "invalid_verdict_literal" });
    expect(queue.verdicts.size).toBe(0);
  }, 15_000);

  it("worker 命令级 internal_error → run failed(非 challenge_invalid 方向)", async () => {
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: null, reference: validReference() },
    ]);
    const opts = options(queue, {
      workerSpec: {
        command: process.execPath,
        args: [FAKE_WORKER],
        env: [
          ["FAKE_MODE", "command_error_internal"],
          ["FAKE_LOG_DIGEST", DIGEST_OF_REFERENCE],
        ],
      },
    });
    const outcome = await adjudicateRun((await claimFirst(queue, opts))!, opts);
    expect(outcome).toEqual({
      kind: "failed",
      reason: "worker_command_error:internal_error",
    });
    expect(queue.verdicts.size).toBe(0);
  }, 15_000);

  it("verify 中进程崩溃 → run failed(process_failure 收敛;进程不复用)", async () => {
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: null, reference: validReference() },
    ]);
    const opts = options(queue, {
      workerSpec: {
        command: process.execPath,
        args: [FAKE_WORKER],
        env: [
          ["FAKE_MODE", "crash_on_verify"],
          ["FAKE_LOG_DIGEST", DIGEST_OF_REFERENCE],
        ],
      },
    });
    const outcome = await adjudicateRun((await claimFirst(queue, opts))!, opts);
    expect(outcome.kind).toBe("failed");
    expect(queue.verdicts.size).toBe(0);
  }, 20_000);

  it("动作日志超帧内预算 → run failed(spawn 之前确定性拒裁,ADR-9 §三)", async () => {
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: null, reference: validReference() },
    ]);
    const opts = options(queue, { maxActionLogBytes: 1 });
    const outcome = await adjudicateRun((await claimFirst(queue, opts))!, opts);
    expect(outcome).toEqual({ kind: "failed", reason: "action_log_over_frame_budget" });
    expect(queue.verdicts.size).toBe(0);
  });

  it("双包非合法 JSON → run failed(bundle_json_unparseable)", async () => {
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: null, reference: validReference() },
    ]);
    const bundles = new Map([
      ["chal-1/1.0.0/bundle.json", new TextEncoder().encode("not-json")],
      ["chal-1/1.0.0/descriptor.json", new TextEncoder().encode(DESCRIPTOR_JSON)],
    ]);
    const opts = options(queue, {
      bundles: new MemoryBundleSource(bundles, {}),
      challenges: new MemoryChallengeSource(
        new Map([
          ["tenant-1|chal-1|1.0.0", {
            ...REGISTRATION,
            privateBundleSha256: sha256Hex("not-json"),
          }],
        ]),
      ),
    });
    const outcome = await adjudicateRun((await claimFirst(queue, opts))!, opts);
    expect(outcome).toEqual({ kind: "failed", reason: "bundle_json_unparseable" });
  });

  it("包声明缺 vmEngineVersion(必需声明面)→ 裁决无效(六记录项不完备同向)", async () => {
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: null, reference: validReference() },
    ]);
    const bundles = new Map([
      ["chal-1/1.0.0/bundle.json", new TextEncoder().encode('{"schemaVersion":1}')],
      ["chal-1/1.0.0/descriptor.json", new TextEncoder().encode(DESCRIPTOR_JSON)],
    ]);
    const opts = options(queue, {
      bundles: new MemoryBundleSource(bundles),
      challenges: new MemoryChallengeSource(
        new Map([
          ["tenant-1|chal-1|1.0.0", {
            ...REGISTRATION,
            privateBundleSha256: sha256Hex('{"schemaVersion":1}'),
          }],
        ]),
      ),
    });
    const outcome = await adjudicateRun((await claimFirst(queue, opts))!, opts);
    expect(outcome).toMatchObject({ kind: "completed", verdict: "challenge_invalid" });
    expect(queue.verdicts.get(SUBMISSION_ID)?.detail).toEqual({
      reason: "six_records_incomplete",
    });
  });

  it("包声明缺 engineBuildId(schema 可选构建 ID)→ 不在结构闸拒裁,bundle lock 仅比版本", async () => {
    // private-bundle.schema 的 engineBuildId 非必需(Rust 镜像 Option<String>;
    // compose 生命周期题目即不声明)——缺席 = 无构建级声明,版本比对通过即
    // 正常进入 verify(回归锚:过严结构闸曾把合法包误判 challenge_invalid)。
    const bundleJson = '{"vmEngineVersion":"0.1.0"}';
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: DIGEST_OF_REFERENCE, reference: validReference() },
    ]);
    const bundles = new Map([
      ["chal-1/1.0.0/bundle.json", new TextEncoder().encode(bundleJson)],
      ["chal-1/1.0.0/descriptor.json", new TextEncoder().encode(DESCRIPTOR_JSON)],
    ]);
    const opts = options(queue, {
      bundles: new MemoryBundleSource(bundles),
      challenges: new MemoryChallengeSource(
        new Map([
          ["tenant-1|chal-1|1.0.0", {
            ...REGISTRATION,
            privateBundleSha256: sha256Hex(bundleJson),
          }],
        ]),
      ),
    });
    const outcome = await adjudicateRun((await claimFirst(queue, opts))!, opts);
    expect(outcome).toMatchObject({ kind: "completed", verdict: "success" });
  }, 15_000);

  it("worker 进程 spawn 失败 → run failed(确定性拒绝方向)", async () => {
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: null, reference: validReference() },
    ]);
    const opts = options(queue, { workerSpec: { command: "definitely-not-a-binary-xyz" } });
    const outcome = await adjudicateRun((await claimFirst(queue, opts))!, opts);
    expect(outcome.kind).toBe("failed");
    expect(queue.verdicts.size).toBe(0);
  }, 15_000);

  it("管线异常收敛:落库故障 → run failed(internal_error;不外抛不静默放行)", async () => {
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: null, reference: validReference() },
    ]);
    const failing: MemoryVerdictQueue["complete"] = async () => {
      throw new Error("connection terminated");
    };
    const opts = {
      ...options(queue),
      queue: {
        claim: (batch: number, max: number) => queue.claim(batch, max),
        complete: failing,
        fail: (input: Parameters<MemoryVerdictQueue["fail"]>[0]) => queue.fail(input),
        pendingCount: () => queue.pendingCount(),
      },
    };
    const outcome = await adjudicateRun((await queue.claim(10, 3))[0]!, opts);
    expect(outcome).toEqual({ kind: "failed", reason: "internal_error" });
    // fail 收口:重试新 pending 行在场(重试语义不因管线异常丢失)。
    expect(queue.runs.filter((candidate) => candidate.status === "pending")).toHaveLength(1);
  });

  it("管线异常 + 失败态落库故障 → 双重故障仅受控日志,行由下一轮认领兜底", async () => {
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: null, reference: validReference() },
    ]);
    const boom = async () => {
      throw new Error("store unavailable");
    };
    const opts = {
      ...options(queue),
      queue: {
        claim: (batch: number, max: number) => queue.claim(batch, max),
        complete: boom as MemoryVerdictQueue["complete"],
        fail: boom as MemoryVerdictQueue["fail"],
        pendingCount: () => queue.pendingCount(),
      },
    };
    const outcome = await adjudicateRun((await queue.claim(10, 3))[0]!, opts);
    expect(outcome).toEqual({ kind: "failed", reason: "internal_error" });
  });
});

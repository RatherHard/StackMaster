/**
 * 测试共用:内存端口替身(queue / challenges / bundles)与引用工厂。
 *
 * 形态沿 session-api 测试 rig 纪律:内存同构实现(与 PG 语义一致),
 * 裁决矩阵的每条红灯都可用注入表达。
 */
import { createHash } from "node:crypto";

import type {
  BundleSource,
  ChallengeSource,
  ChallengeVersionRegistration,
  ClaimedRun,
  VerdictQueue,
} from "../../src/persistence/ports.js";

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 合法引用(六记录项完备;challengeId / 版本可注入)。 */
export function validReference(overrides: {
  readonly challengeId?: string;
  readonly contentVersion?: string;
  readonly actionLog?: string;
} = {}): Record<string, unknown> {
  const actionLog =
    overrides.actionLog ??
    `{"context":{"archBits":32,"challengeBundleHash":"${"a".repeat(64)}","challengeContentVersion":"1.0.0","challengeId":"${overrides.challengeId ?? "chal-1"}","engineBuildId":"dev","seedPolicy":{"derivation":null,"strategy":"fixed"},"vmEngineVersion":"0.1.0","vmProfileHash":"${"b".repeat(64)}","vmProfileVersion":"1.0.0","verdictRuleVersion":"1.0.0"},"entries":[],"format":"stackmaster-action-log/1"}`;
  return {
    form: "stackmaster-session-submit/1",
    sessionId: "sess-test-1",
    challenge: {
      challengeId: overrides.challengeId ?? "chal-1",
      challengeContentVersion: overrides.contentVersion ?? "1.0.0",
      vmProfileVersion: "1.0.0",
    },
    engine: { vmEngineVersion: "0.1.0", engineBuildId: "dev" },
    seedPolicy: { strategy: "fixed" },
    revision: 3,
    publicStatus: "won",
    actionLog: [],
    replay: {
      replayContext: {
        challengeId: overrides.challengeId ?? "chal-1",
        challengeContentVersion: overrides.contentVersion ?? "1.0.0",
        vmProfileVersion: "1.0.0",
        vmEngineVersion: "0.1.0",
        engineBuildId: "dev",
        verdictRuleVersion: "1.0.0",
        challengeBundleHash: sha256Hex("bundle-bytes"),
        vmProfileHash: sha256Hex("descriptor-vmProfile"),
        archBits: 32,
        seedPolicy: { strategy: "fixed", derivation: null },
      },
      actionLog,
    },
  };
}

/** 内存裁决队列(claim / complete / fail 与 PG 同构;verdicts 幂等)。 */
export class MemoryVerdictQueue implements VerdictQueue {
  readonly runs: {
    runId: string;
    tenantId: string;
    submissionId: string;
    status: "pending" | "running" | "completed" | "failed";
    logDigest: string | null;
    attemptCount: number;
    reference: unknown;
  }[] = [];
  readonly verdicts = new Map<string, { verdict: string; detail: unknown }>();
  private nextId = 1;

  constructor(runs: readonly { submissionId: string; tenantId?: string; logDigest: string | null; reference: unknown }[] = []) {
    for (const run of runs) {
      this.push(run.submissionId, run.tenantId ?? "tenant-1", run.logDigest, run.reference);
    }
  }

  private push(
    submissionId: string,
    tenantId: string,
    logDigest: string | null,
    reference: unknown,
  ): void {
    const existing = this.runs.filter((run) => run.submissionId === submissionId);
    this.runs.push({
      runId: `run-${this.nextId++}`,
      tenantId,
      submissionId,
      status: "pending",
      logDigest,
      attemptCount: existing.length + 1,
      reference,
    });
  }

  async claim(batchSize: number, maxAttempts: number): Promise<ClaimedRun[]> {
    const claimed: ClaimedRun[] = [];
    const claimedSubmissions = new Set<string>();
    for (const run of this.runs) {
      if (claimed.length >= batchSize) {
        break;
      }
      const attemptCount = this.runs.filter(
        (candidate) => candidate.submissionId === run.submissionId,
      ).length;
      // 与 PG 认领守卫同构:认领守卫 = attempts ≤ 上限(pending 行本身
      // 计入尝试次数——第 N 次 run 是第 N 次也是最后一次合法尝试)。
      if (
        run.status !== "pending" ||
        this.verdicts.has(run.submissionId) ||
        claimedSubmissions.has(run.submissionId) ||
        attemptCount > maxAttempts
      ) {
        continue;
      }
      claimedSubmissions.add(run.submissionId);
      run.status = "running";
      claimed.push({
        runId: run.runId,
        tenantId: run.tenantId,
        submissionId: run.submissionId,
        logDigest: run.logDigest,
        attemptCount,
        reference: run.reference,
      });
    }
    return claimed;
  }

  async complete(input: {
    runId: string;
    submissionId: string;
    tenantId: string;
    verdict: string;
    detail: unknown;
  }): Promise<void> {
    if (!this.verdicts.has(input.submissionId)) {
      this.verdicts.set(input.submissionId, {
        verdict: input.verdict,
        detail: input.detail,
      });
    }
    const run = this.runs.find((candidate) => candidate.runId === input.runId);
    if (run !== undefined) {
      run.status = "completed";
    }
  }

  async fail(input: {
    runId: string;
    tenantId: string;
    submissionId: string;
    attemptCount: number;
    reason: string;
    maxAttempts: number;
  }): Promise<void> {
    const run = this.runs.find((candidate) => candidate.runId === input.runId);
    if (run === undefined) {
      return;
    }
    run.status = "failed";
    this.failures.push(input.reason);
    if (input.attemptCount < input.maxAttempts) {
      this.push(run.submissionId, run.tenantId, run.logDigest, run.reference);
    } else {
      // 耗尽:取消同 submission 残留 pending 行(与 PG fail 同构,防空转)。
      for (const candidate of this.runs) {
        if (candidate.submissionId === run.submissionId && candidate.status === "pending") {
          candidate.status = "failed";
        }
      }
    }
  }

  readonly failures: string[] = [];

  async pendingCount(): Promise<number> {
    return this.runs.filter(
      (run) => run.status === "pending" && !this.verdicts.has(run.submissionId),
    ).length;
  }
}

/** 内存登记源。 */
export class MemoryChallengeSource implements ChallengeSource {
  constructor(
    private readonly rows: ReadonlyMap<string, ChallengeVersionRegistration>,
  ) {}

  async findVersion(
    tenantId: string,
    challengeId: string,
    contentVersion: string,
  ): Promise<ChallengeVersionRegistration | null> {
    return this.rows.get(`${tenantId}|${challengeId}|${contentVersion}`) ?? null;
  }
}

/** 内存登记双包源(可注入越权异常;私有 / 公开桶测试共用同一对象表)。 */
export class MemoryBundleSource implements BundleSource {
  constructor(
    private readonly objects: ReadonlyMap<string, Uint8Array>,
    private readonly options: { denied?: boolean } = {},
  ) {}

  async getPrivate(objectName: string): Promise<Uint8Array | null> {
    return this.get(objectName);
  }

  async getPublic(objectName: string): Promise<Uint8Array | null> {
    return this.get(objectName);
  }

  private async get(objectName: string): Promise<Uint8Array | null> {
    if (this.options.denied === true) {
      throw Object.assign(new Error("access denied"), { code: "AccessDenied" });
    }
    return this.objects.get(objectName) ?? null;
  }

  async probe(): Promise<void> {
    if (this.options.denied === true) {
      throw Object.assign(new Error("access denied"), { code: "AccessDenied" });
    }
  }
}

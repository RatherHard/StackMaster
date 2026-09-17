/**
 * 内存只读实现(管理面;单元测试与服务级用例的默认装配面)。
 *
 * 与 PG 实现**同语义**:租户过滤、裁决时间窗、成绩 keyset 游标、仅已裁决
 * 行进入成绩页——服务级用例因此可以在不依赖容器的前提下把租户隔离、
 * 游标推进与契约一致性全部跑成红灯/绿灯。
 *
 * 零写面同样是类型面事实:本类不实现任何写方法;`readCalls` 只记录被调用
 * 的**读方法名**,供用例断言"管理面一次都没有走过写路径"。数据装配走构造
 * 期的 `seed*` 方法(测试夹具,fail-closed:重复 id 即抛错,不静默覆盖)。
 */
import type { VerdictResult } from "@stackmaster/protocol";

import {
  type AdminReadStore,
  type ChallengeRegistryEntry,
  type ChallengeVersionSummary,
  type ScoresPageQuery,
  type ScoresPageRow,
  type VerdictPageQuery,
  type VerdictPageRow,
} from "./ports.js";

interface SeededChallenge {
  readonly tenantId: string;
  readonly challengeId: string;
  readonly title: string | null;
  readonly versions: ChallengeVersionSummary[];
}

interface SeededSubmission {
  readonly tenantId: string;
  readonly submissionId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly challengeId: string;
  readonly challengeVersion: string;
  /** 提交时刻(Unix epoch 秒;裁决时间窗过滤按此列)。 */
  readonly createdAtEpochSeconds: number;
  /** 裁决(未裁决 = null;成绩页只含非 null 行)。 */
  readonly verdict: VerdictResult | null;
  readonly decidedAtEpochSeconds: number | null;
  /** 成绩游标值(`verdicts.id`;缺省由夹具给出,测试可显式指定顺序)。 */
  readonly scoreRowId: string | null;
}

export class MemoryAdminReadStore implements AdminReadStore {
  readonly implementation = "memory" as const;
  /** 读方法调用轨迹(零写证明的服务级锚点)。 */
  readonly readCalls: string[] = [];
  readonly #challenges: SeededChallenge[] = [];
  readonly #submissions: SeededSubmission[] = [];

  seedChallenge(input: {
    tenantId: string;
    challengeId: string;
    title: string | null;
    versions: readonly ChallengeVersionSummary[];
  }): void {
    if (this.#challenges.some((entry) => entry.challengeId === input.challengeId)) {
      throw new Error(`夹具重复:challengeId=${input.challengeId}`);
    }
    this.#challenges.push({
      tenantId: input.tenantId,
      challengeId: input.challengeId,
      title: input.title,
      versions: [...input.versions],
    });
  }

  seedSubmission(input: {
    tenantId: string;
    submissionId: string;
    sessionId: string;
    revision: number;
    challengeId: string;
    challengeVersion: string;
    createdAtEpochSeconds?: number;
    verdict?: VerdictResult | null;
    decidedAtEpochSeconds?: number | null;
    scoreRowId?: string | null;
  }): void {
    if (this.#submissions.some((entry) => entry.submissionId === input.submissionId)) {
      throw new Error(`夹具重复:submissionId=${input.submissionId}`);
    }
    this.#submissions.push({
      tenantId: input.tenantId,
      submissionId: input.submissionId,
      sessionId: input.sessionId,
      revision: input.revision,
      challengeId: input.challengeId,
      challengeVersion: input.challengeVersion,
      createdAtEpochSeconds: input.createdAtEpochSeconds ?? 0,
      verdict: input.verdict ?? null,
      decidedAtEpochSeconds: input.decidedAtEpochSeconds ?? null,
      scoreRowId: input.scoreRowId ?? null,
    });
  }

  async listChallenges(input: {
    readonly tenantId: string;
    readonly limit: number;
  }): Promise<readonly ChallengeRegistryEntry[]> {
    this.readCalls.push("listChallenges");
    return this.#challenges
      .filter((entry) => entry.tenantId === input.tenantId)
      .sort((a, b) => (a.challengeId < b.challengeId ? -1 : a.challengeId > b.challengeId ? 1 : 0))
      .slice(0, input.limit)
      .map((entry) => ({
        challengeId: entry.challengeId,
        title: entry.title,
        versions: entry.versions.map((version) => ({ ...version })),
      }));
  }

  async queryVerdicts(input: VerdictPageQuery): Promise<readonly VerdictPageRow[]> {
    this.readCalls.push("queryVerdicts");
    return this.#submissions
      .filter((entry) => entry.tenantId === input.tenantId)
      .filter((entry) => input.submissionId === undefined || entry.submissionId === input.submissionId)
      .filter((entry) => input.challengeId === undefined || entry.challengeId === input.challengeId)
      .filter(
        (entry) =>
          input.sinceEpochSeconds === undefined ||
          entry.createdAtEpochSeconds >= input.sinceEpochSeconds,
      )
      .filter(
        (entry) =>
          input.untilEpochSeconds === undefined ||
          entry.createdAtEpochSeconds <= input.untilEpochSeconds,
      )
      .sort((a, b) =>
        b.createdAtEpochSeconds === a.createdAtEpochSeconds
          ? b.submissionId.localeCompare(a.submissionId)
          : b.createdAtEpochSeconds - a.createdAtEpochSeconds,
      )
      .slice(0, input.limit)
      .map((entry) =>
        entry.verdict === null || entry.decidedAtEpochSeconds === null
          ? {
              submissionId: entry.submissionId,
              revision: entry.revision,
              status: "pending" as const,
              verdict: null,
              decidedAtEpochSeconds: null,
            }
          : {
              submissionId: entry.submissionId,
              revision: entry.revision,
              status: "verdicted" as const,
              verdict: entry.verdict,
              decidedAtEpochSeconds: entry.decidedAtEpochSeconds,
            },
      );
  }

  async readScoresPage(input: ScoresPageQuery): Promise<readonly ScoresPageRow[]> {
    this.readCalls.push("readScoresPage");
    return this.#submissions
      .filter((entry) => entry.tenantId === input.tenantId)
      .filter(
        (entry): entry is SeededSubmission & { verdict: VerdictResult; scoreRowId: string; decidedAtEpochSeconds: number } =>
          entry.verdict !== null && entry.scoreRowId !== null && entry.decidedAtEpochSeconds !== null,
      )
      .filter((entry) => input.afterId === undefined || entry.scoreRowId > input.afterId)
      .sort((a, b) => (a.scoreRowId < b.scoreRowId ? -1 : a.scoreRowId > b.scoreRowId ? 1 : 0))
      .slice(0, input.limit)
      .map((entry) => ({
        id: entry.scoreRowId,
        submissionId: entry.submissionId,
        sessionId: entry.sessionId,
        challengeId: entry.challengeId,
        challengeVersion: entry.challengeVersion,
        verdict: entry.verdict,
        decidedAtEpochSeconds: entry.decidedAtEpochSeconds,
      }));
  }
}

/**
 * 扩展题目集逐题裁决闭环回归(镜像 mvp-challenges/verdict-closed-loop.test.ts)。
 *
 * 每道题目 × 每条语料(参考解 + 边界)在**真实 vm-worker 引擎**上走完整
 * 裁决链路:
 *
 *   SessionOrchestrator.create(双包装载)→ 逐动作回放语料脚本(交互终态 /
 *   拒绝形态 / 可解释错误断言)→ exportReplayMaterial(引擎权威重放材料)
 *   → 一次性 verify 进程(§4.9,ADR-8 同一回放实现)→ 11 值裁决
 *   = 语料预期(verifier 汇总语义,ADR-9 §四)。
 *
 * 跨目录复用 MVP 的 verify 驱动(同一 WorkerConnection / resolveWorkerLauncher
 * 协议粘合;零第二实现)。
 */
import { describe, expect, it } from "vitest";
import type { ActionResponse } from "@stackmaster/protocol";
import { SessionOrchestrator } from "@stackmaster/session-core";

import { EXT_CHALLENGES, type ExtChallenge, type ExtCorpusEntry } from "./corpus.js";
import { verifyWithWorker } from "../mvp-challenges/helpers/verify-driver.js";

interface CorpusRunResult {
  readonly responses: readonly ActionResponse[];
  readonly publicStatus: string;
  readonly verdict: string;
  readonly replayKind: string;
  readonly hiddenTests?: {
    readonly allPassed?: boolean;
    readonly kind?: string;
  };
}

/** 单条语料的完整裁决闭环(会话 → 动作 → export → verify)。 */
async function runCorpus(
  challenge: ExtChallenge,
  entry: ExtCorpusEntry,
): Promise<CorpusRunResult> {
  const pair = challenge.buildPair();
  const session = await SessionOrchestrator.create({
    privateBundle: pair.privateBundle,
    publicDescriptor: pair.publicDescriptor,
  });
  try {
    const responses: ActionResponse[] = [];
    for (const action of entry.actions) {
      responses.push(await session.applyAction(action));
    }
    const material = await session.exportReplayMaterial();
    const submit = session.submit();
    const outcome = await verifyWithWorker({
      privateBundle: pair.privateBundle,
      publicDescriptor: pair.publicDescriptor,
      replayContext: material.replayContext,
      actionLog: material.actionLog,
    });
    if (outcome.kind !== "report") {
      throw new Error(
        `verify 未产出报告(${outcome.kind});裁决闭环断裂`,
      );
    }
    return {
      responses,
      publicStatus: submit.publicStatus,
      verdict: outcome.report.verdict,
      replayKind: outcome.report.replay.kind,
      hiddenTests: outcome.report.hiddenTests,
    };
  } finally {
    await session.closeSession();
  }
}

describe("扩展题目集:逐题裁决闭环(真实 vm-worker;参考解与边界语料)", () => {
  for (const challenge of EXT_CHALLENGES) {
    describe(`题目 ${challenge.meta.challengeId}(${challenge.meta.mode} 模式)`, () => {
      it.each(challenge.corpora.map((entry) => [entry.name, entry] as const))(
        "%s",
        async (_name, entry) => {
          const result = await runCorpus(challenge, entry);

          // ① 交互终态 = 语料预期(submit 引用 publicStatus;清单 §五:交互
          //    与正式裁决相互独立,两者分别断言)。
          expect(result.publicStatus).toBe(entry.expectedFinalStatus);

          // ② 拒绝形态:revision 不前进 + 拒绝可解释。
          const first = result.responses[0];
          expect(first).toBeDefined();
          if (entry.expectedFirstRejected === true) {
            expect(first?.status).toBe("rejected");
            expect(first?.userVisibleError).toBeDefined();
          } else {
            expect(first?.status).not.toBe("rejected");
          }

          // ③ 教学错误可解释面(末动作错误码)。
          const last = result.responses.at(-1);
          if (entry.expectedLastError !== undefined) {
            expect(last?.userVisibleError?.code).toBe(entry.expectedLastError);
          }

          // ④ 正式裁决 = 语料预期(verifier 独立重放 + 隐藏测试汇总)。
          expect(result.replayKind).toBe("matched");
          expect(result.verdict).toBe(entry.expectedVerdict);

          // ⑤ 隐藏测试汇总:参考解 = 全过;非 success 方向 = 探针不过或
          //    引擎终态粗化优先(WP-62 合成规则)。
          if (entry.expectedVerdict === "success") {
            expect(result.hiddenTests?.kind).toBe("executed");
            expect(result.hiddenTests?.allPassed).toBe(true);
          }
        },
        60_000,
      );
    });
  }

  it("裁决矩阵覆盖面:3 题 × 语料全部执行(门禁承载面之外的裁决回归矩阵)", () => {
    const total = EXT_CHALLENGES.reduce((sum, challenge) => sum + challenge.corpora.length, 0);
    expect(EXT_CHALLENGES).toHaveLength(3);
    expect(total).toBeGreaterThanOrEqual(12);
  });
});

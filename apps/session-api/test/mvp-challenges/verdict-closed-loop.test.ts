/**
 * MVP 题目集逐题裁决闭环回归(WP-68;13.2「题目发布前运行参考解、边界输入
 * 和回归测试」的裁决承载面)。
 *
 * 每道题目 × 每条语料(参考解 + 边界)在**真实 vm-worker 引擎**上走完整
 * 裁决链路:
 *
 *   SessionOrchestrator.create(双包装载)→ 逐动作回放语料脚本(交互终态 /
 *   拒绝形态 / 可解释错误断言)→ export_action_log(引擎权威重放材料)
 *   → 一次性 verify 进程(§4.9,ADR-8 同一回放实现)→ 11 值裁决
 *   = 语料预期(verifier 汇总语义,ADR-9 §四)。
 *
 * 生产全链路(登记 → 队列 → verifier 服务 → verdicts 落库 → 呈现路由)由
 * compose 套件(mvp-challenge-set.compose.integration.test.ts)以 CH-07 /
 * CH-04 两组语料实跑;本套件覆盖 8 题 × 全部语料的裁决矩阵。
 *
 * 红灯纪律:本测试先于语料成文(语料缺位 / 裁决方向不符即红)。
 */
import { describe, expect, it } from "vitest";
import type { ActionResponse } from "@stackmaster/protocol";
import { SessionOrchestrator } from "@stackmaster/session-core";

import { MVP_CHALLENGES, type MvpChallenge, type MvpCorpusEntry } from "./corpus.js";
import { verifyWithWorker } from "./helpers/verify-driver.js";

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
  challenge: MvpChallenge,
  entry: MvpCorpusEntry,
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

describe("MVP 题目集:逐题裁决闭环(真实 vm-worker;参考解与边界语料)", () => {
  for (const challenge of MVP_CHALLENGES) {
    describe(`题目 ${challenge.meta.challengeId}(${challenge.meta.mode} 模式)`, () => {
      it.each(challenge.corpora.map((entry) => [entry.name, entry] as const))(
        "%s",
        async (_name, entry) => {
          const result = await runCorpus(challenge, entry);

          // ① 交互终态 = 语料预期(submit 引用 publicStatus;清单 §五:交互
          //    与正式裁决相互独立,两者分别断言)。
          expect(result.publicStatus).toBe(entry.expectedFinalStatus);

          // ② 拒绝形态(阶段闸门等):revision 不前进 + 拒绝可解释。
          const first = result.responses[0];
          expect(first).toBeDefined();
          if (entry.expectedFirstRejected === true) {
            expect(first?.status).toBe("rejected");
            expect(first?.userVisibleError).toBeDefined();
          } else {
            expect(first?.status).not.toBe("rejected");
          }

          // ③ 教学错误可解释面(末动作错误码;13.6"失败结果能够解释")。
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

  it("裁决矩阵覆盖面:8 题 × 语料全部执行(compose 承载面之外的完整矩阵)", () => {
    const total = MVP_CHALLENGES.reduce((sum, challenge) => sum + challenge.corpora.length, 0);
    expect(MVP_CHALLENGES).toHaveLength(8);
    expect(total).toBeGreaterThanOrEqual(24);
  });
});

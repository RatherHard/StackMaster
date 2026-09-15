/**
 * 我的第一道题:逐条语料裁决闭环(T1 配套;镜像 extended-challenges/verdict-closed-loop.test.ts)。
 * 每条语料在真实 vm-worker 上走完整链路:建会话 → 逐动作 → 导出重放材料
 * → 一次性 verify 进程 → 断言五元组。
 */
import { describe, expect, it } from "vitest";
import type { ActionResponse } from "@stackmaster/protocol";
import { SessionOrchestrator } from "@stackmaster/session-core";

import { MY_CHALLENGE, type MyChallenge, type MyCorpusEntry } from "./corpus.js";
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

async function runCorpus(challenge: MyChallenge, entry: MyCorpusEntry): Promise<CorpusRunResult> {
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
      throw new Error(`verify 未产出报告(${outcome.kind});裁决闭环断裂`);
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

describe("我的第一道题:裁决闭环(真实 vm-worker)", () => {
  it.each(MY_CHALLENGE.corpora.map((entry) => [entry.name, entry] as const))(
    "%s",
    async (_name, entry) => {
      const result = await runCorpus(MY_CHALLENGE, entry);

      // ① 交互终态 = 语料预期。
      expect(result.publicStatus).toBe(entry.expectedFinalStatus);

      // ② 首动作未预期拒绝时,不得出现 rejected。
      const first = result.responses[0];
      expect(first).toBeDefined();
      expect(first?.status).not.toBe("rejected");

      // ③ 教学错误可解释面(末动作错误码)。
      const last = result.responses.at(-1);
      if (entry.expectedLastError !== undefined) {
        expect(last?.userVisibleError?.code).toBe(entry.expectedLastError);
      }

      // ④ 正式裁决 = 语料预期(重放一致 + 11 值)。
      expect(result.replayKind).toBe("matched");
      expect(result.verdict).toBe(entry.expectedVerdict);

      // ⑤ success 方向:隐藏测试全过。
      if (entry.expectedVerdict === "success") {
        expect(result.hiddenTests?.kind).toBe("executed");
        expect(result.hiddenTests?.allPassed).toBe(true);
      }
    },
    60_000,
  );

  it("语料覆盖面:≥3 条(参考解 + wrong_answer + 非平凡失败)", () => {
    expect(MY_CHALLENGE.corpora.length).toBeGreaterThanOrEqual(3);
  });
});

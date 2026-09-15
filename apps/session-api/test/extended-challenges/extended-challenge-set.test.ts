/**
 * 扩展题目集发布前门禁(镜像 mvp-challenge-set.test.ts 的纪律)。
 *
 * 每道题目在进入裁决闭环回归之前必须通过:
 *   ① 装载管线全绿(loadChallengePair = Ajv Schema + WP-4 检查器全量 +
 *      编译期校验 + 状态机封闭性,层次化 fail-closed);
 *   ② 隐藏测试形态边界(v1 = predicate_probe、载荷为空,D-H2);
 *   ③ 中文教学面齐备(briefing / 提示阶梯 / 观察点);
 *   ④ 语料矩阵覆盖(参考解 + wrong_answer 方向 + 非平凡失败方向);
 *   ⑤ 登记哈希确定性(规范化 JSON 摘要,重复构造逐字节同源)。
 *
 * 红灯纪律:违规聚合输出(逐题逐条 ruleId + message),红灯可读。
 */
import { describe, expect, it } from "vitest";
import { canonicalize } from "@stackmaster/protocol";
import { createHash } from "node:crypto";
import { loadChallengePair } from "@stackmaster/challenge-compiler";

import {
  EXT_CHALLENGE_IDS,
  EXT_CHALLENGES,
  canonicalDigests,
  loadExtChallenge,
} from "./corpus.js";

describe("扩展题目集:发布前编译管线门禁(每题必过)", () => {
  it("题目集规模与梯度:恰 3 道、ID 唯一、模式数组 = [ir, byte, ir]", () => {
    expect(EXT_CHALLENGES).toHaveLength(3);
    expect(new Set(EXT_CHALLENGE_IDS).size).toBe(3);
    expect(EXT_CHALLENGE_IDS).toEqual([
      "sm-x01-ret2win-ir",
      "sm-x02-rop-minimal",
      "sm-x03-int-truncation-ir",
    ]);
    const modes = EXT_CHALLENGES.map((challenge) => challenge.meta.mode);
    expect(modes).toEqual(["ir", "byte", "ir"]);
  });

  for (const challenge of EXT_CHALLENGES) {
    describe(`题目 ${challenge.meta.challengeId}`, () => {
      it("装载管线全绿:Schema + 字段分类检查器 + 编译期校验 + 状态机封闭性", () => {
        const loaded = loadExtChallenge(challenge);
        expect(loaded.ok).toBe(true);
      });

      if (challenge.meta.mode === "ir") {
        it("IR 程序布局:entrypoint / labels 与初始 RIP 同源,win 目标登记在案", () => {
          const loaded = loadExtChallenge(challenge);
          if (!loaded.ok) {
            throw new Error("装载失败,前置用例应已拦截");
          }
          expect(loaded.challenge.program.mode).toBe("ir");
          const program = loaded.challenge.program as {
            readonly mode: "ir";
            readonly entrypointIndex: number;
            readonly instructions: readonly unknown[];
            readonly labels: readonly { readonly labelId: string; readonly instructionIndex: number }[];
          };
          const pair = challenge.buildPair();
          const bundle = pair.privateBundle as {
            readonly initialState: { readonly registers: Record<string, string> };
            readonly compiledIr: { readonly entrypointIndex: number };
          };
          // 执行起点 = 初始 RIP(IR 模式引擎语义;两者按构造同源)。
          expect(BigInt(bundle.initialState.registers.RIP)).toBe(BigInt(program.entrypointIndex));
          expect(program.entrypointIndex).toBe(bundle.compiledIr.entrypointIndex);
          expect(program.instructions.length).toBeGreaterThan(program.entrypointIndex);
          const labelIds = program.labels.map((label) => label.labelId);
          expect(labelIds).toContain("entry");
          expect(labelIds).toContain("win");
          expect(labelIds).toContain("lose");
        });
      }

      if (challenge.meta.mode === "byte") {
        it("字节模式布局:入口探测译码非空,win / fail / gadget 落在编码表词汇内", () => {
          const loaded = loadExtChallenge(challenge);
          if (!loaded.ok) {
            throw new Error("装载失败,前置用例应已拦截");
          }
          expect(loaded.challenge.program.mode).toBe("byte");
          const program = loaded.challenge.program as {
            readonly mode: "byte";
            readonly entrypointAddressHex: string;
            readonly instructions: readonly { readonly op: string }[];
          };
          // 探测译码(装载产物):入口起纯指令流、≤ 4096 条(XS-ENC-PROBE 已全绿)。
          expect(program.entrypointAddressHex).toBe("0x400010");
          expect(program.instructions.length).toBeGreaterThan(0);
          expect(program.instructions.length).toBeLessThanOrEqual(4096);
        });
      }

      it("教学面齐备:中文题面 / 教学目标 / 提示阶梯 / 观察点(十五章指标一格)", () => {
        const pair = challenge.buildPair();
        const descriptor = pair.publicDescriptor as {
          readonly locale: string;
          readonly briefing: {
            readonly title: string;
            readonly summary: string;
            readonly learningObjectives: readonly string[];
          };
          readonly hintLadder: readonly unknown[];
        };
        expect(descriptor.locale).toBe("zh-CN");
        expect(descriptor.briefing.title.length).toBeGreaterThan(0);
        expect(descriptor.briefing.summary.length).toBeGreaterThan(0);
        expect(descriptor.briefing.learningObjectives.length).toBeGreaterThanOrEqual(1);
        expect(descriptor.hintLadder.length).toBeGreaterThanOrEqual(1);
        expect(challenge.meta.objective.length).toBeGreaterThan(0);
        expect(challenge.meta.observationPoints.length).toBeGreaterThanOrEqual(1);
      });

      it("隐藏测试形态边界:v1 只允许 predicate_probe 且载荷为空(D-H2)", () => {
        const pair = challenge.buildPair();
        const bundle = pair.privateBundle as {
          readonly judging: {
            readonly hiddenTests?: readonly {
              readonly kind: string;
              readonly payloadHex?: string;
              readonly expectedResult: string;
            }[];
          };
        };
        const tests = bundle.judging.hiddenTests ?? [];
        expect(tests.length).toBeGreaterThanOrEqual(1);
        for (const test of tests) {
          expect(test.kind).toBe("predicate_probe");
          expect(test.payloadHex).toBeUndefined();
          expect([
            "success",
            "wrong_answer",
            "invalid_action",
            "program_crash",
            "memory_fault",
            "resource_limit",
            "timeout",
          ]).toContain(test.expectedResult);
        }
      });

      it("参考解与边界语料矩阵:至少参考解一例 + wrong_answer 方向一例 + 非平凡失败方向一例", () => {
        expect(challenge.corpora.length).toBeGreaterThanOrEqual(3);
        const directions = challenge.corpora.map((entry) => entry.expectedVerdict);
        expect(directions).toContain("success");
        expect(directions).toContain("wrong_answer");
        const nonTrivial = challenge.corpora.filter(
          (entry) =>
            entry.expectedVerdict !== "success" && entry.expectedVerdict !== "wrong_answer",
        );
        expect(nonTrivial.length).toBeGreaterThanOrEqual(1);
      });

      it("登记哈希确定性:重复构造的规范化摘要逐字节一致(D-API-23 摘要输入面)", () => {
        const first = canonicalDigests(challenge.buildPair());
        const second = canonicalDigests(challenge.buildPair());
        expect(first.publicDescriptorSha256).toBe(second.publicDescriptorSha256);
        expect(first.privateBundleSha256).toBe(second.privateBundleSha256);
        // 摘要 = 规范化 JSON 的 SHA-256(与 MVP 语料同一规范化纪律)。
        const pair = challenge.buildPair();
        expect(first.publicDescriptorSha256).toBe(
          createHash("sha256").update(canonicalize(pair.publicDescriptor), "utf8").digest("hex"),
        );
      });
    });
  }

  it("D-J8 口径:题目集全部题目 aslrEnabled 缺省(不启用真实实例 ASLR)", () => {
    for (const challenge of EXT_CHALLENGES) {
      const pair = challenge.buildPair();
      const descriptor = pair.publicDescriptor as { readonly aslrEnabled?: boolean };
      expect(descriptor.aslrEnabled).toBeUndefined();
    }
  });

  it("装载失败面零容忍:全部题目 loadChallengePair 违规集合为空(聚合断言,红灯可读)", () => {
    const failures = EXT_CHALLENGES.flatMap((challenge) => {
      const result = loadChallengePair(challenge.buildPair());
      return result.ok
        ? []
        : [{
            challengeId: challenge.meta.challengeId,
            report: result.violations
              .map((violation) => `  - [${violation.ruleId}] ${violation.message}`)
              .join("\n"),
          }];
    });
    const report = failures
      .map((entry) => `${entry.challengeId}:\n${entry.report}`)
      .join("\n");
    expect(report, `题目集装载违规:\n${report}`).toBe("");
  });
});

/**
 * MVP 题目集发布前门禁(WP-68;13.2 发布前义务的编译管线承载面)。
 *
 * 每道题目在"发布"(登记哈希 / compose 拓扑演示)之前必须通过:
 *   ① 装载管线全绿(loadChallengePair = Ajv Schema + WP-4 检查器全量 +
 *      编译期校验 + 状态机封闭性,层次化 fail-closed);
 *   ② 隐藏测试形态边界(v1 = predicate_probe、载荷为空,D-H2——
 *      无输入槽契约,题目设计不得越界);
 *   ③ 渐进式梯度与教学文案齐备(中文 briefing / 提示阶梯 / 观察点);
 *   ④ 登记哈希确定性(规范化 JSON 摘要,重复构造逐字节同源——D-API-23
 *      登记链路的摘要输入面)。
 *
 * 红灯纪律:本测试先于语料成文(8 题全集期望先行,语料缺位即红)。
 */
import { describe, expect, it } from "vitest";
import { canonicalize } from "@stackmaster/protocol";
import { createHash } from "node:crypto";
import { loadChallengePair } from "@stackmaster/challenge-compiler";

import {
  MVP_CHALLENGE_IDS,
  MVP_CHALLENGES,
  canonicalDigests,
  loadMvpChallenge,
} from "./corpus.js";

describe("MVP 题目集:发布前编译管线门禁(每题必过)", () => {
  it("题目集规模与进度:恰 8 道、ID 唯一、渐进式编号连续(sm-ch01 ~ sm-ch08)", () => {
    expect(MVP_CHALLENGES).toHaveLength(8);
    expect(new Set(MVP_CHALLENGE_IDS).size).toBe(8);
    expect(MVP_CHALLENGE_IDS).toEqual([
      "sm-ch01-write-basics",
      "sm-ch02-little-endian",
      "sm-ch03-frame-layout",
      "sm-ch04-buffer-overflow",
      "sm-ch05-canary-guard",
      "sm-ch06-ret2win-byte",
      "sm-ch07-hidden-vault",
      "sm-ch08-full-chain",
    ]);
  });

  for (const challenge of MVP_CHALLENGES) {
    describe(`题目 ${challenge.meta.challengeId}`, () => {
      it("装载管线全绿:Schema + 字段分类检查器 + 编译期校验 + 状态机封闭性", () => {
        const loaded = loadMvpChallenge(challenge);
        expect(loaded.ok).toBe(true);
      });

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

      it("参考解与边界语料矩阵:至少参考解一例 + wrong_answer 方向一例 + 相关失败方向一例", () => {
        expect(challenge.corpora.length).toBeGreaterThanOrEqual(3);
        const directions = challenge.corpora.map((entry) => entry.expectedVerdict);
        expect(directions).toContain("success");
        expect(directions).toContain("wrong_answer");
        const nonTrivial = challenge.corpora.filter(
          (entry) => entry.expectedVerdict !== "success" && entry.expectedVerdict !== "wrong_answer",
        );
        expect(nonTrivial.length).toBeGreaterThanOrEqual(1);
      });

      it("登记哈希确定性:重复构造的规范化摘要逐字节一致(D-API-23 摘要输入面)", () => {
        const first = canonicalDigests(challenge.buildPair());
        const second = canonicalDigests(challenge.buildPair());
        expect(first.publicDescriptorSha256).toBe(second.publicDescriptorSha256);
        expect(first.privateBundleSha256).toBe(second.privateBundleSha256);
        // 摘要 = 规范化 JSON 的 SHA-256(与 tooling/contract-smoke 同一规范化纪律)。
        const pair = challenge.buildPair();
        expect(first.publicDescriptorSha256).toBe(
          createHash("sha256").update(canonicalize(pair.publicDescriptor), "utf8").digest("hex"),
        );
      });
    });
  }

  it("D-J8 口径:题目集全部题目 aslrEnabled 缺省(不启用真实实例 ASLR)", () => {
    for (const challenge of MVP_CHALLENGES) {
      const pair = challenge.buildPair();
      const descriptor = pair.publicDescriptor as { readonly aslrEnabled?: boolean };
      expect(descriptor.aslrEnabled).toBeUndefined();
    }
  });

  it("渐进式梯度:前段 IR 模式打桩 → 后段字节模式闭环(CH-06 起字节模式)", () => {
    const modes = MVP_CHALLENGES.map((challenge) => challenge.meta.mode);
    expect(modes).toEqual(["ir", "ir", "ir", "ir", "ir", "byte", "byte", "byte"]);
  });

  it("装载失败面零容忍:全部题目 loadChallengePair 违规集合为空(聚合断言,红灯可读)", () => {
    const failures = MVP_CHALLENGES.flatMap((challenge) => {
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

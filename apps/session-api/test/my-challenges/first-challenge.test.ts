/**
 * 我的第一道题:发布前门禁(T1 配套;镜像 extended-challenge-set.test.ts 的纪律)。
 */
import { describe, expect, it } from "vitest";
import { canonicalize } from "@stackmaster/protocol";
import { createHash } from "node:crypto";

import { MY_CHALLENGE, MY_CHALLENGE_IDS, canonicalDigests, loadMyChallenge } from "./corpus.js";

describe("我的第一道题:发布前门禁(必过)", () => {
  it("题目集规模:恰 1 道,ID 正确", () => {
    expect(MY_CHALLENGE_IDS).toEqual(["sm-t01-write-marker"]);
  });

  it("装载管线全绿:Schema + 检查器 + 编译期校验(违规聚合输出,红灯可读)", () => {
    const loaded = loadMyChallenge(MY_CHALLENGE);
    if (!loaded.ok) {
      const report = loaded.violations
        .map((violation) => `  - [${violation.ruleId}] ${violation.message}`)
        .join("\n");
      throw new Error(`装载违规:\n${report}`);
    }
    expect(loaded.ok).toBe(true);
  });

  it("IR 程序布局:执行起点 = 初始 RIP,入口标签登记在案", () => {
    const loaded = loadMyChallenge(MY_CHALLENGE);
    if (!loaded.ok) throw new Error("装载失败,前置用例应已拦截");
    expect(loaded.challenge.program.mode).toBe("ir");
    const program = loaded.challenge.program as {
      readonly entrypointIndex: number;
      readonly instructions: readonly unknown[];
      readonly labels: readonly { readonly labelId: string }[];
    };
    expect(program.entrypointIndex).toBe(0);
    expect(program.instructions.length).toBeGreaterThan(0);
    expect(program.labels.map((label) => label.labelId)).toContain("entry");
  });

  it("教学面齐备:中文题面 / 学习目标 / 提示阶梯", () => {
    const pair = MY_CHALLENGE.buildPair();
    const descriptor = pair.publicDescriptor as {
      readonly locale: string;
      readonly briefing: { readonly title: string; readonly learningObjectives: readonly string[] };
      readonly hintLadder: readonly unknown[];
    };
    expect(descriptor.locale).toBe("zh-CN");
    expect(descriptor.briefing.title.length).toBeGreaterThan(0);
    expect(descriptor.briefing.learningObjectives.length).toBeGreaterThanOrEqual(1);
    expect(descriptor.hintLadder.length).toBeGreaterThanOrEqual(1);
  });

  it("隐藏测试形态边界:v1 只允许 predicate_probe 且载荷为空(D-H2)", () => {
    const pair = MY_CHALLENGE.buildPair();
    const bundle = pair.privateBundle as {
      readonly judging: { readonly hiddenTests: readonly { readonly kind: string; readonly payloadHex?: string; readonly expectedResult: string }[] };
    };
    expect(bundle.judging.hiddenTests.length).toBeGreaterThanOrEqual(1);
    for (const test of bundle.judging.hiddenTests) {
      expect(test.kind).toBe("predicate_probe");
      expect(test.payloadHex).toBeUndefined();
      expect(test.expectedResult).toBe("success");
    }
  });

  it("语料矩阵覆盖:success + wrong_answer + 非平凡失败方向", () => {
    expect(MY_CHALLENGE.corpora.length).toBeGreaterThanOrEqual(3);
    const directions = MY_CHALLENGE.corpora.map((entry) => entry.expectedVerdict);
    expect(directions).toContain("success");
    expect(directions).toContain("wrong_answer");
    expect(directions).toContain("program_crash");
  });

  it("登记哈希确定性:重复构造的规范化摘要逐字节一致(D-API-23)", () => {
    const first = canonicalDigests(MY_CHALLENGE.buildPair());
    const second = canonicalDigests(MY_CHALLENGE.buildPair());
    expect(first.publicDescriptorSha256).toBe(second.publicDescriptorSha256);
    expect(first.privateBundleSha256).toBe(second.privateBundleSha256);
    const pair = MY_CHALLENGE.buildPair();
    expect(first.publicDescriptorSha256).toBe(
      createHash("sha256").update(canonicalize(pair.publicDescriptor), "utf8").digest("hex"),
    );
  });

  it("D-J8 口径:aslrEnabled 缺省(不启用真实实例 ASLR)", () => {
    const pair = MY_CHALLENGE.buildPair();
    const descriptor = pair.publicDescriptor as { readonly aslrEnabled?: boolean };
    expect(descriptor.aslrEnabled).toBeUndefined();
  });
});

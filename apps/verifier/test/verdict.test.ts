/**
 * 裁决面受理单测(WP-61):11 值冻结枚举的受理校验(零新增字面)。
 * 非 11 值 = 引擎契约漂移 → null(verifier 侧 run failed,不落 verdicts)。
 */
import { describe, expect, it } from "vitest";

import { parseVerdict } from "../src/verdict.js";

describe("parseVerdict(11 值受理)", () => {
  it("11 值逐一受理", () => {
    const expected = [
      "success",
      "wrong_answer",
      "invalid_action",
      "program_crash",
      "memory_fault",
      "resource_limit",
      "timeout",
      "engine_error",
      "challenge_invalid",
      "replay_mismatch",
      "cancelled",
    ];
    for (const verdict of expected) {
      expect(parseVerdict(verdict)).toBe(verdict);
    }
  });

  it("非 11 值字面 / 非字符串 / 空串 → null", () => {
    expect(parseVerdict("passed")).toBeNull();
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict(42)).toBeNull();
    expect(parseVerdict(null)).toBeNull();
    expect(parseVerdict({ verdict: "success" })).toBeNull();
  });
});

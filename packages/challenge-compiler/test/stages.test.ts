// 多阶段状态机静态校验测试(WP-2:副作用引用可解析、允许动作封闭性;
// WP-4 已覆盖的 XS-STAGE-* 规则做透传回归)。
import { describe, expect, it } from "vitest";

import { loadChallengePair } from "../src/index.js";
import type { Stage } from "@stackmaster/challenge-schema/server-only";
import {
  buildIrPair,
  loadPairWithEdits,
  violationRuleIds,
} from "./helpers/private-bundle.js";

function stage(overrides?: Partial<Stage>): Stage {
  return {
    stageId: "s0",
    allowedActions: ["step"],
    preconditions: { all: [] },
    transitions: [],
    sideEffects: [],
    failureConditions: [],
    resourceBudget: { maxInstructionSteps: 1000 },
    ...overrides,
  };
}

describe("XC-STAGE-SIDE-EFFECT:副作用引用可解析", () => {
  it("红灯:副作用 fileId 不在 secrets.virtualFiles", () => {
    const result = loadChallengePair(
      buildIrPair({
        stages: [stage({ sideEffects: [{ type: "grant_virtual_file", fileId: "nope" }] })],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XC-STAGE-SIDE-EFFECT");
      const violation = result.violations.find((item) => item.ruleId === "XC-STAGE-SIDE-EFFECT");
      expect(violation?.path).toBe("/stages/0/sideEffects/0/fileId");
    }
  });

  it("绿灯:副作用 fileId 落在声明面(win-notes)", () => {
    const result = loadChallengePair(
      buildIrPair({
        stages: [stage({ sideEffects: [{ type: "grant_virtual_file", fileId: "win-notes" }] })],
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("XC-STAGE-ACTIONS:阶段允许动作 ⊆ 公开允许面", () => {
  it("红灯:阶段动作超出公开 allowedActions", () => {
    const result = loadChallengePair(
      buildIrPair({
        // 公开包 allowedActions 不含 undo;阶段声明 undo 即越出题目允许面。
        stages: [stage({ allowedActions: ["step", "undo"] })],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XC-STAGE-ACTIONS");
    }
  });

  it("绿灯:阶段动作是公开允许面的子集", () => {
    const result = loadChallengePair(
      buildIrPair({
        stages: [stage({ allowedActions: ["step", "write_bytes"] })],
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("WP-4 状态机规则透传回归(检查器前置仍然生效)", () => {
  it("XS-STAGE-REACH:迁移目标不存在即拒", () => {
    const result = loadChallengePair(
      buildIrPair({
        stages: [
          stage({
            transitions: [
              {
                toStageId: "ghost",
                onCondition: { all: [{ all: [{ predicate: { type: "stack_canary_intact" } }] }] },
              },
            ],
          }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XS-STAGE-REACH");
    }
  });

  it("XS-STAGE-BUDGET:maxInstructionSteps = 0 即拒(Schema 与检查器双重封顶)", () => {
    const result = loadPairWithEdits(buildIrPair(), undefined, (privateClone) => {
      privateClone["stages"] = [stage({ resourceBudget: { maxInstructionSteps: 0 } })];
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        violationRuleIds(result).has("XS-STAGE-BUDGET") ||
          violationRuleIds(result).has("SCHEMA-VIOLATION"),
      ).toBe(true);
    }
  });

  it("XS-PRED-REFS:阶段前置条件引用未知寄存器即拒", () => {
    const result = loadChallengePair(
      buildIrPair({
        stages: [
          stage({
            preconditions: {
              all: [
                {
                  all: [
                    {
                      predicate: {
                        type: "register_equals",
                        register: "RNOPE",
                        valueHex: "0x1",
                      },
                    },
                  ],
                },
              ],
            },
          }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XS-PRED-REFS");
    }
  });
});

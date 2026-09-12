/**
 * 提交引用受理面测试(WP-61):六记录项完备性与形态域。
 * 完成标准承接:「六记录项缺项裁决无效红灯」——任一记录项缺席 / 形态漂移
 * = 受理失败(challenge_invalid 方向的管线输入),不进入重放。
 */
import { describe, expect, it } from "vitest";

import { parseSubmitReference } from "../src/reference.js";
import { validReference } from "./helpers/memory-ports.js";

describe("parseSubmitReference(六记录项完备性,版本策略 §三)", () => {
  it("合法引用受理", () => {
    expect(parseSubmitReference(validReference())).not.toBeNull();
  });

  it("replay 材料整体缺席(阶段五形态旧引用)→ 受理失败", () => {
    const reference = validReference() as Record<string, unknown>;
    delete reference["replay"];
    expect(parseSubmitReference(reference)).toBeNull();
  });

  it("六记录项逐项缺项红灯", () => {
    const records = [
      "challengeBundleHash",
      "vmProfileHash",
      "engineBuildId",
      "verdictRuleVersion",
    ] as const;
    for (const record of records) {
      const reference = validReference() as {
        replay: { replayContext: Record<string, unknown> };
      };
      reference.replay.replayContext[record] = undefined;
      expect(parseSubmitReference(reference), record).toBeNull();
    }
    // #5 seed 策略缺项。
    const noSeed = validReference() as {
      replay: { replayContext: { seedPolicy?: Record<string, unknown> } };
    };
    noSeed.replay.replayContext.seedPolicy = undefined;
    expect(parseSubmitReference(noSeed)).toBeNull();
  });

  it("哈希形态漂移(非 64 hex)→ 受理失败", () => {
    const reference = validReference() as {
      replay: { replayContext: Record<string, unknown> };
    };
    reference.replay.replayContext["challengeBundleHash"] = "0".repeat(63);
    expect(parseSubmitReference(reference)).toBeNull();
  });

  it("actionLog 为空串(无日志可重放)→ 受理失败", () => {
    const reference = validReference() as {
      replay: { actionLog: string };
    };
    reference.replay.actionLog = "";
    expect(parseSubmitReference(reference)).toBeNull();
  });

  it("多余字段(strictObject)→ 受理失败,SERVER_ONLY 明细无公开表达位", () => {
    const reference = validReference() as { replay: Record<string, unknown> };
    reference.replay["detail"] = { predicateHits: 1 };
    expect(parseSubmitReference(reference)).toBeNull();
  });
});

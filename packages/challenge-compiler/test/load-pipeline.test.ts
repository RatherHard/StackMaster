// 装载管线测试(WP-2:层次化 fail-closed、challenge_invalid 方向、双模式、32 位)。
import { describe, expect, it } from "vitest";

import { LOAD_FAILURE_RESULT_DIRECTION, loadChallengePair, loadChallengePairTexts } from "../src/index.js";
import {
  buildBytePair,
  buildIrPair,
  loadPairWithEdits,
  violationRuleIds,
} from "./helpers/private-bundle.js";

describe("装载管线:绿灯路径", () => {
  it("IR 模式缺省双包全绿(编译产物含 CFG 事实)", () => {
    const result = loadChallengePair(buildIrPair());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.challenge.program.mode).toBe("ir");
      if (result.challenge.program.mode === "ir") {
        expect(result.challenge.program.reachableInstructionCount).toBe(3);
        expect(result.challenge.program.backEdges).toHaveLength(0);
      }
    }
  });

  it("字节模式缺省双包全绿(译码产物 = 编码表装载)", () => {
    const result = loadChallengePair(buildBytePair());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.challenge.program.mode).toBe("byte");
      const program = result.challenge.program;
      // 程序 = push RBP; mov RBP,RSP; call 接口; leave; ret;其后为 NOP0 填充 token
      // (纯指令流约定:自入口到区域尾必须连续可译码)。
      expect(program.instructions.slice(0, 5).map((item) => item.op)).toEqual([
        "push",
        "mov",
        "call",
        "leave",
        "ret",
      ]);
      expect(program.instructions).toHaveLength(4096);
      expect(program.instructions[5]?.op).toBe("NOP0");
      expect(program.instructions[4095]?.op).toBe("NOP0");
    }
  });

  it("32 位 IR 题目全绿(archBits 位宽域内)", () => {
    const result = loadChallengePair(buildIrPair({ archBits: 32 }));
    expect(result.ok).toBe(true);
  });
});

describe("装载管线:层次化 fail-closed", () => {
  it("第一层:公开包 Schema 违规 → SCHEMA-VIOLATION + challenge_invalid 方向", () => {
    const result = loadPairWithEdits(buildIrPair(), (publicClone) => {
      publicClone["challengeId"] = "Bad_Id!";
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.direction).toBe(LOAD_FAILURE_RESULT_DIRECTION);
      expect(violationRuleIds(result)).toContain("SCHEMA-VIOLATION");
      // 不近似执行:失败结果不携带任何程序产物。
      expect("challenge" in result).toBe(false);
    }
  });

  it("第一层:私有包 Schema 违规(未知 dslSchemaVersion)→ 拒绝", () => {
    const result = loadPairWithEdits(buildIrPair(), undefined, (privateClone) => {
      privateClone["dslSchemaVersion"] = 3;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("SCHEMA-VIOLATION");
    }
  });

  it("第二层:WP-4 检查器违规透传(XS-PROG-MODE 双给)", () => {
    const result = loadPairWithEdits(buildBytePair(), undefined, (privateClone) => {
      // 字节模式私包同时给 compiledIr → 双真源,XS-PROG-MODE 拒绝。
      privateClone["compiledIr"] = {
        irFormatVersion: 2,
        entrypointIndex: 0,
        instructions: [{ op: "ret", operands: [] }],
        labels: [],
      };
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XS-PROG-MODE");
    }
  });

  it("第三层:检查器全绿但编译期违规 → 拒绝(XC-OPCODE-SHAPE)", () => {
    const result = loadPairWithEdits(buildIrPair(), undefined, (privateClone) => {
      const ir = privateClone["compiledIr"] as { instructions: unknown[] };
      ir.instructions[1] = { op: "mov", operands: [{ kind: "register", name: "RBP" }] };
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XC-OPCODE-SHAPE");
    }
  });
});

describe("装载管线:文本入口(XS-DUP-KEY 纪律)", () => {
  it("重复 JSON 键被严格扫描器拒绝", () => {
    const pair = buildIrPair();
    const privateText = JSON.stringify(pair.privateBundle).replace(
      "\"dslSchemaVersion\":2",
      "\"dslSchemaVersion\":2,\"dslSchemaVersion\":1",
    );
    const result = loadChallengePairTexts({
      publicDescriptorText: JSON.stringify(pair.publicDescriptor),
      privateBundleText: privateText,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("JSON-PARSE");
    }
  });

  it("合法文本双包走同一管线全绿", () => {
    const pair = buildIrPair();
    const result = loadChallengePairTexts({
      publicDescriptorText: JSON.stringify(pair.publicDescriptor),
      privateBundleText: JSON.stringify(pair.privateBundle),
    });
    expect(result.ok).toBe(true);
  });
});

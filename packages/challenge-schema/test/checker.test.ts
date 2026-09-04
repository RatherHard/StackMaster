/**
 * 字段分类检查器测试(WP-1 §12.6 扫描器自检纪律):
 * - 绿灯基线 = fixture 公开包 × builder 派生私有包,必须零违规;
 * - 每条规则一个必触发红灯样例(单一定向破坏),测试名直接引用规则 ID;
 * - 部分规则(XS-REG-NAMESPACE / XS-MEM-TOTAL / XS-MEM-CONTENT / XS-STAGE-BUDGET /
 *   XS-NESTING / XS-MEM-PAGE-ALIGN / XS-CUSTOM-DEF)在 Schema 层已被拦截,红灯样例刻意绕过
 *   前置条件直测检查器(纵深防御第二道防线;测试内注明)。
 * - XS-DUP-KEY 的落点在 json-strict-parse,红灯样例见 test/json-strict-parse.test.ts。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validatePublicDescriptor } from "../src/index.js";
import type { PublicChallengeDescriptor } from "../src/index.js";
import {
  CAPABILITY_SCAN_PREFIXES,
  RULE_ID_ALIASES,
  checkChallengePair,
  checkSchemaMeta,
} from "../src/server-only/index.js";
import type { CheckerResult, CheckerViolation, PrivateChallengeBundle } from "../src/server-only/index.js";
import { buildPrivateBundle } from "./helpers/private-bundle.js";

const basicText = readFileSync(
  join(import.meta.dirname, "fixtures", "public-descriptor", "basic.json"),
  "utf8",
);

function loadPublicDescriptor(): PublicChallengeDescriptor {
  const result = validatePublicDescriptor(JSON.parse(basicText));
  if (!result.ok) {
    throw new Error(`fixture 应通过校验:${JSON.stringify(result.violations, null, 2)}`);
  }
  return result.value;
}

type PairEdit = (clone: Record<string, unknown>) => void;

/** 构造(可定向破坏的)双包输入并执行联合检查。 */
function checkPairWith(editPublic?: PairEdit, editPrivate?: PairEdit): CheckerResult {
  const base = loadPublicDescriptor();
  const publicClone = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  editPublic?.(publicClone);
  const privateClone = JSON.parse(
    JSON.stringify(buildPrivateBundle(base)),
  ) as Record<string, unknown>;
  editPrivate?.(privateClone);
  return checkChallengePair(
    publicClone as unknown as PublicChallengeDescriptor,
    privateClone as unknown as PrivateChallengeBundle,
  );
}

/** 断言结果中存在指定规则 ID 的违规,返回该违规供路径 / 消息断言。 */
function expectRule(result: CheckerResult, ruleId: string): CheckerViolation {
  const violation = result.violations.find((candidate) => candidate.ruleId === ruleId);
  if (violation === undefined) {
    throw new Error(
      `预期违规 ${ruleId},实际:${JSON.stringify(result.violations, null, 2)}`,
    );
  }
  return violation;
}

/** 取数组指定下标作为定向破坏点(越界属测试自身错误,快速失败)。 */
function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`测试破坏点越界:下标 ${index}`);
  }
  return item;
}

/** 构造 Schema 形态合法的状态机阶段(仅供跨包检查输入)。 */
function makeStage(
  stageId: string,
  toStageIds: readonly string[],
  maxInstructionSteps = 100,
): Record<string, unknown> {
  return {
    stageId,
    allowedActions: ["step"],
    preconditions: { all: [] },
    transitions: toStageIds.map((toStageId) => ({
      toStageId,
      onCondition: { all: [] },
    })),
    sideEffects: [],
    failureConditions: [],
    resourceBudget: { maxInstructionSteps },
  };
}

describe("字段分类检查器:绿灯基线", () => {
  it("fixture 公开包 × 派生私有包零违规(checkChallengePair 契约形态)", () => {
    const base = loadPublicDescriptor();
    const result = checkChallengePair(base, buildPrivateBundle(base));

    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("双锚点别名与 capability 前缀清单导出形态正确", () => {
    expect(RULE_ID_ALIASES["XS-REG-SUBSET"]).toBe("XS-PROJ-REG");
    expect(CAPABILITY_SCAN_PREFIXES).toContain("virtual_file:");
  });

  it("G2/D3 自由命名绿灯:自定义寄存器名全链路声明一致时零违规", () => {
    const result = checkPairWith(
      (pub) => {
        const profile = pub.vmProfile as { registers: Array<{ name: string }> };
        profile.registers.push({ name: "R_MYDATA" }, { name: "CTRL" });
        (pub.initialProjection as { visibleRegisters: unknown[] }).visibleRegisters.push(
          { name: "R_MYDATA", valueHex: "0x0" },
          { name: "CTRL", valueHex: "0x0" },
        );
      },
      (priv) => {
        const registers = (priv.initialState as { registers: Record<string, string> }).registers;
        registers["R_MYDATA"] = "0x0";
        registers["CTRL"] = "0x0";
      },
    );

    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

describe("字段分类检查器:公开包单侧规则红灯样例", () => {
  it("I2-PUB-PAIRWISE:公开内存区域相交被拒绝", () => {
    const result = checkPairWith((pub) => {
      const layout = pub.memoryLayout as { regions: Array<Record<string, unknown>> };
      at(layout.regions, 0).startAddressHex = "0x7ffff800";
    });

    expect(result.ok).toBe(false);
    expectRule(result, "I2-PUB-PAIRWISE");
  });

  it("I2-HIGHLIGHT:高亮区间越出目标区域被拒绝", () => {
    const result = checkPairWith((pub) => {
      const highlights = pub.initialProjection as {
        semanticHighlights: Array<Record<string, unknown>>;
      };
      at(highlights.semanticHighlights, 0).startAddressHex = "0x80000000";
    });

    const violation = expectRule(result, "I2-HIGHLIGHT");
    expect(violation.message).toContain("未完全落在");
  });

  it("I2-HIGHLIGHT:高亮引用不存在的可见区域被拒绝", () => {
    const result = checkPairWith((pub) => {
      const highlights = pub.initialProjection as {
        semanticHighlights: Array<Record<string, unknown>>;
      };
      at(highlights.semanticHighlights, 0).targetRegionId = "heap";
    });

    const violation = expectRule(result, "I2-HIGHLIGHT");
    expect(violation.message).toContain("不在初始投影");
  });

  it("D2-CODE-PUBLIC:代码区域不出现在初始投影被拒绝", () => {
    const result = checkPairWith((pub) => {
      const projection = pub.initialProjection as { visibleRegions: unknown[] };
      projection.visibleRegions = projection.visibleRegions.slice(1);
    });

    const violation = expectRule(result, "D2-CODE-PUBLIC");
    expect(violation.message).toContain("必须出现在初始投影");
  });

  it("XS-ID-UNIQUE:公开区域 regionId 重复被拒绝", () => {
    const result = checkPairWith((pub) => {
      const layout = pub.memoryLayout as { regions: Record<string, unknown>[] };
      layout.regions.push({ ...at(layout.regions, 1) });
    });

    const violation = expectRule(result, "XS-ID-UNIQUE");
    expect(violation.message).toContain("重复");
  });

  it("XS-REG-CORE:声明集缺必选核心寄存器 RSP 被拒绝(G2/D3)", () => {
    const result = checkPairWith((pub) => {
      const profile = pub.vmProfile as {
        registers: Array<{ name: string }>;
      };
      profile.registers = profile.registers.filter((register) => register.name !== "RSP");
    });

    const violation = expectRule(result, "XS-REG-CORE");
    expect(violation.path).toBe("/vmProfile/registers");
    expect(violation.message).toContain("RSP");
  });
});

describe("字段分类检查器:私有包单侧规则红灯样例", () => {
  it("I2-PRIV-PAIRWISE:私有内存区域相交被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      const regions = (priv.initialState as { memoryRegions: Array<Record<string, unknown>> })
        .memoryRegions;
      at(regions, 2).startAddressHex = "0x7ffff800";
    });

    expectRule(result, "I2-PRIV-PAIRWISE");
  });

  it("I3-SINK-HIDDEN:公开可见对象含秘密被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      at(priv.privateObjects as Array<Record<string, unknown>>, 0).containsSecret = true;
    });

    const violation = expectRule(result, "I3-SINK-HIDDEN");
    expect(violation.message).toContain("input-buffer");
  });

  it("XS-ID-UNIQUE:私有对象 objectId 重复被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      const objects = priv.privateObjects as Record<string, unknown>[];
      objects.push({ ...at(objects, 0) });
    });

    const violation = expectRule(result, "XS-ID-UNIQUE");
    expect(violation.message).toContain("input-buffer");
  });

  it("XS-REG-NAMESPACE:不属任何命名空间的寄存器键被拒(纵深防御,G2/D3;Schema 负向前瞻已先行拦截)", () => {
    const result = checkPairWith(undefined, (priv) => {
      // 小写 "rsp" 既不匹配一般命名空间 ^(?!FLAG)[A-Z][A-Z0-9_]{0,15}$,也不匹配 FLAG 保留区。
      (priv.initialState as { registers: Record<string, string> }).registers["rsp"] = "0x0";
    });

    const violation = expectRule(result, "XS-REG-NAMESPACE");
    expect(violation.path).toBe("/initialState/registers/rsp");
  });

  it("XS-MEM-TOTAL:区域字节总量超限被拒(纵深防御样例)", () => {
    const result = checkPairWith(undefined, (priv) => {
      const regions = (priv.initialState as { memoryRegions: Array<Record<string, unknown>> })
        .memoryRegions;
      at(regions, 1).byteLength = 100_000_000;
    });

    expectRule(result, "XS-MEM-TOTAL");
  });

  it("XS-MEM-CONTENT:contentHex 长度与 byteLength 不符被拒(纵深防御样例)", () => {
    const result = checkPairWith(undefined, (priv) => {
      const regions = (priv.initialState as { memoryRegions: Array<{ contentHex: string }> })
        .memoryRegions;
      const region = at(regions, 0);
      region.contentHex = region.contentHex.slice(0, -2);
    });

    expectRule(result, "XS-MEM-CONTENT");
  });

  it("XS-IR-LABEL:标签 instructionIndex 越界被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      const labels = (priv.compiledIr as { labels: Array<Record<string, unknown>> }).labels;
      at(labels, 0).instructionIndex = 99;
    });

    expectRule(result, "XS-IR-LABEL");
  });

  it("XS-IR-LABEL:标签 ID 重复被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      const ir = priv.compiledIr as { labels: Record<string, unknown>[] };
      ir.labels.push({ ...at(ir.labels, 0) });
    });

    expectRule(result, "XS-IR-LABEL");
  });

  it("XS-STAGE-REACH:迁移目标不存在且阶段不可达被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      priv.stages = [makeStage("s1", ["ghost"]), makeStage("s2", [])];
    });

    const violation = expectRule(result, "XS-STAGE-REACH");
    expect(violation.message).toContain("ghost");
  });

  it("XS-STAGE-BUDGET:maxInstructionSteps < 1 被拒(纵深防御样例)", () => {
    const result = checkPairWith(undefined, (priv) => {
      priv.stages = [makeStage("s1", [], 0)];
    });

    expectRule(result, "XS-STAGE-BUDGET");
  });

  it("XS-PRED-REFS:谓词引用不存在的内存区域被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      priv.judging = {
        ...(priv.judging as Record<string, unknown>),
        successCondition: {
          all: [
            {
              all: [
                {
                  predicate: {
                    type: "memory_equals",
                    regionId: "heap",
                    offsetBytes: 0,
                    bytesHex: "00",
                  },
                },
              ],
            },
          ],
        },
      };
    });

    const violation = expectRule(result, "XS-PRED-REFS");
    expect(violation.message).toContain("heap");
  });

  it("XS-PRED-REFS:memory_equals 切片越出区域界被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      priv.judging = {
        ...(priv.judging as Record<string, unknown>),
        successCondition: {
          all: [
            {
              all: [
                {
                  predicate: {
                    type: "memory_equals",
                    regionId: "stack",
                    offsetBytes: 4095,
                    bytesHex: "aabb",
                  },
                },
              ],
            },
          ],
        },
      };
    });

    const violation = expectRule(result, "XS-PRED-REFS");
    expect(violation.message).toContain("超出区域");
  });

  it("XS-PRED-REFS:virtual_file_read 引用不存在的 fileId 被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      priv.judging = {
        ...(priv.judging as Record<string, unknown>),
        successCondition: {
          all: [{ all: [{ predicate: { type: "virtual_file_read", fileId: "ghost-notes" } }] }],
        },
      };
    });

    expectRule(result, "XS-PRED-REFS");
  });

  it("XS-NESTING:布尔组合深度超 3 被拒(纵深防御样例)", () => {
    const result = checkPairWith(undefined, (priv) => {
      priv.judging = {
        ...(priv.judging as Record<string, unknown>),
        successCondition: {
          all: [{ all: [{ all: [{ predicate: { type: "stack_canary_intact" } }] }] }],
        },
      };
    });

    const violation = expectRule(result, "XS-NESTING");
    expect(violation.message).toContain("嵌套深度");
  });
});

describe("字段分类检查器:G4/D4 自定义指令与作者接口规则红灯样例", () => {
  it("XS-CUSTOM-REF:IR 使用未声明的自定义助记符被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      (priv.compiledIr as { instructions: unknown[] }).instructions = [
        { op: "LOAD_TWICE", operands: [] },
      ];
    });

    const violation = expectRule(result, "XS-CUSTOM-REF");
    expect(violation.path).toBe("/compiledIr/instructions/0/op");
    expect(violation.message).toContain("LOAD_TWICE");
  });

  it("XS-CUSTOM-DEF:助记符与基线 opcode 冲突被拒(纵深防御样例,小写形态被类型断言绕过)", () => {
    const result = checkPairWith(undefined, (priv) => {
      priv.customInstructions = [
        {
          mnemonic: "mov",
          displayText: "冒充基线指令",
          semantics: [{ op: "load_imm", dst: "RAX", valueHex: "0x0" }],
        },
      ];
    });

    const violation = expectRule(result, "XS-CUSTOM-DEF");
    expect(violation.path).toBe("/customInstructions/0/mnemonic");
  });

  it("XS-SYSCALL-DECL:syscall 引用未声明的接口号被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      (priv.compiledIr as { instructions: unknown[] }).instructions = [
        { op: "syscall", operands: [{ kind: "immediate", valueHex: "0x200" }] },
      ];
    });

    const violation = expectRule(result, "XS-SYSCALL-DECL");
    expect(violation.path).toBe("/compiledIr/instructions/0/operands/0");
  });

  it("XS-SYSCALL-DECL:syscall 操作数非单一立即数被拒(封闭单值伪操作)", () => {
    const result = checkPairWith(undefined, (priv) => {
      (priv.compiledIr as { instructions: unknown[] }).instructions = [
        { op: "syscall", operands: [{ kind: "register", name: "RAX" }] },
      ];
    });

    const violation = expectRule(result, "XS-SYSCALL-DECL");
    expect(violation.message).toContain("封闭单值伪操作");
  });

  it("XS-IFACE-REF:call 的 interface 操作数引用不存在条目被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      (priv.compiledIr as { instructions: unknown[] }).instructions = [
        { op: "call", operands: [{ kind: "interface", interfaceId: 999 }] },
      ];
    });

    const violation = expectRule(result, "XS-IFACE-REF");
    expect(violation.path).toBe("/compiledIr/instructions/0/operands/0");
  });

  it("XS-IFACE-REF:接口效果引用不存在的虚拟文件被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      priv.interfaces = [
        {
          interfaceId: 512,
          displayText: "授予解题笔记读取权",
          effects: [{ effect: "grant_virtual_file", fileId: "ghost-notes" }],
        },
      ];
    });

    const violation = expectRule(result, "XS-IFACE-REF");
    expect(violation.path).toBe("/interfaces/0/effects/0/fileId");
  });

  it("XS-IFACE-REF:接口效果 set_flag 引用未声明的 FLAG 寄存器被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      priv.interfaces = [
        {
          interfaceId: 512,
          displayText: "置位完成标志",
          effects: [{ effect: "set_flag", flagRegister: "FLAG_GHOST", valueHex: "0x1" }],
        },
      ];
    });

    const violation = expectRule(result, "XS-IFACE-REF");
    expect(violation.message).toContain("FLAG_GHOST");
  });

  it("XS-IR-LEAVE:leave 出现在无 RBP 的寄存器集被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      const registers = (priv.initialState as { registers: Record<string, string> }).registers;
      delete registers["RBP"];
      (priv.compiledIr as { instructions: unknown[] }).instructions = [
        { op: "leave", operands: [] },
      ];
    });

    const violation = expectRule(result, "XS-IR-LEAVE");
    expect(violation.path).toBe("/compiledIr/instructions/0/op");
  });

  it("XS-CUSTOM-DISPLAY:displayText 含隐藏区域名 / 谓词标识被拒绝(E-4/E-6 扫描)", () => {
    const result = checkPairWith(undefined, (priv) => {
      priv.customInstructions = [
        {
          mnemonic: "LOAD_TWICE",
          displayText: "读取 canary-vault 内容",
          semantics: [{ op: "load_imm", dst: "RAX", valueHex: "0x0" }],
        },
      ];
      priv.interfaces = [
        {
          interfaceId: 512,
          displayText: "通过 payload-72 校验",
          effects: [{ effect: "noop" }],
        },
      ];
    });

    const displayViolations = result.violations.filter(
      (candidate) => candidate.ruleId === "XS-CUSTOM-DISPLAY",
    );
    expect(
      displayViolations.some((v) => v.path === "/customInstructions/0/displayText"),
    ).toBe(true);
    expect(displayViolations.some((v) => v.path === "/interfaces/0/displayText")).toBe(true);
  });

  it("XS-ID-UNIQUE:作者接口 interfaceId 重复被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      priv.interfaces = [
        { interfaceId: 512, displayText: "接口甲", effects: [{ effect: "noop" }] },
        { interfaceId: 512, displayText: "接口乙", effects: [{ effect: "noop" }] },
      ];
    });

    const violation = expectRule(result, "XS-ID-UNIQUE");
    expect(violation.path).toBe("/interfaces/1/interfaceId");
    expect(violation.message).toContain("重复");
  });

  it("G4/D4 绿灯:自定义指令 + 作者接口全链路声明一致时零违规", () => {
    const result = checkPairWith(undefined, (priv) => {
      priv.customInstructions = [
        {
          mnemonic: "LOAD_TWICE",
          displayText: "装载立即数并取低字节",
          semantics: [
            { op: "load_imm", dst: "RAX", valueHex: "0x2A" },
            { op: "bit_mask", dst: "RAX", src: "RAX", maskHex: "0xFF", logic: "and" },
          ],
        },
      ];
      priv.interfaces = [
        {
          interfaceId: 512,
          displayText: "授予解题笔记读取权",
          effects: [
            { effect: "grant_virtual_file", fileId: "win-notes" },
            { effect: "set_flag", flagRegister: "FLAG0", valueHex: "0x1" },
          ],
        },
      ];
      (priv.compiledIr as { instructions: unknown[] }).instructions = [
        { op: "push", operands: [{ kind: "register", name: "RBP" }] },
        {
          op: "mov",
          operands: [
            { kind: "register", name: "RBP" },
            { kind: "register", name: "RSP" },
          ],
        },
        { op: "LOAD_TWICE", operands: [] },
        { op: "call", operands: [{ kind: "interface", interfaceId: 512 }] },
        { op: "syscall", operands: [{ kind: "immediate", valueHex: "0x200" }] },
        { op: "leave", operands: [] },
        { op: "ret", operands: [] },
      ];
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

describe("字段分类检查器:跨包一致性规则红灯样例", () => {
  it("XS-ID-CORR:challengeContentVersion 两包不同值被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      priv.challengeContentVersion = "1.0.1";
    });

    const violation = expectRule(result, "XS-ID-CORR");
    expect(violation.path).toBe("/challengeContentVersion");
  });

  it("I2-PUB-MIRROR:区域起始地址两包不一致被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      const regions = (priv.initialState as { memoryRegions: Array<Record<string, unknown>> })
        .memoryRegions;
      at(regions, 1).startAddressHex = "0x7fffe000";
    });

    const violation = expectRule(result, "I2-PUB-MIRROR");
    expect(violation.message).toContain("起始地址");
  });

  it("I2-HIDDEN-NOT-PUBLIC:隐藏区域与公开区域相交被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      const regions = (priv.initialState as { memoryRegions: Array<Record<string, unknown>> })
        .memoryRegions;
      at(regions, 2).startAddressHex = "0x7ffff800";
    });

    expectRule(result, "I2-HIDDEN-NOT-PUBLIC");
  });

  it("I2-OBJ-NOT-PUBLIC:hidden 对象落进公开区域被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      at(priv.privateObjects as Array<Record<string, unknown>>, 2).addressHex = "0x7ffffff0";
    });

    expectRule(result, "I2-OBJ-NOT-PUBLIC");
  });

  it("I3-VISIBLE-REG:可见寄存器落入 secretSinkRegisters 被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      priv.secretSinkRegisters = ["RAX"];
    });

    const violation = expectRule(result, "I3-VISIBLE-REG");
    expect(violation.message).toContain("RAX");
  });

  it("I3-VISIBLE-REG:自由命名下秘密汇仍被拦截(G2/D3:自定义名进入可见面被拒绝)", () => {
    const result = checkPairWith(
      (pub) => {
        const profile = pub.vmProfile as { registers: Array<{ name: string }> };
        profile.registers.push({ name: "R_SECRET" });
        (pub.initialProjection as { visibleRegisters: unknown[] }).visibleRegisters.push({
          name: "R_SECRET",
          valueHex: "0x0",
        });
      },
      (priv) => {
        (priv.initialState as { registers: Record<string, string> }).registers["R_SECRET"] = "0x0";
        priv.secretSinkRegisters = ["R_SECRET"];
      },
    );

    const violation = expectRule(result, "I3-VISIBLE-REG");
    expect(violation.message).toContain("R_SECRET");
  });

  it("ZR-B8-CAP-SCAN:capability 前缀字符串进入公开包被拒绝", () => {
    const result = checkPairWith((pub) => {
      pub.randomizationNotice = "virtual_file:win-notes";
    });

    const violation = expectRule(result, "ZR-B8-CAP-SCAN");
    expect(violation.path).toBe("/randomizationNotice");
  });

  it("XS-ID-NO-PRIVATE:公开字符串值等于私有 objectId 被拒绝", () => {
    const result = checkPairWith((pub) => {
      pub.randomizationNotice = "input-buffer";
    });

    const violation = expectRule(result, "XS-ID-NO-PRIVATE");
    expect(violation.message).toContain("input-buffer");
  });

  it("XS-PROJ-REG(= XS-REG-SUBSET):可见寄存器越出声明集被拒绝(G2/D3 重锚)", () => {
    const result = checkPairWith(
      (pub) => {
        (pub.initialProjection as { visibleRegisters: unknown[] }).visibleRegisters.push({
          name: "R13",
          valueHex: "0x0",
        });
      },
      (priv) => {
        (priv.initialState as { registers: Record<string, string> }).registers["R13"] = "0x0";
      },
    );

    const violation = expectRule(result, "XS-PROJ-REG");
    expect(violation.message).toContain("R13");
  });

  it("XS-PROJ-REG(XS-REG-SUBSET 初始面):私有初始寄存器越出声明集被拒绝(G2/D3)", () => {
    const result = checkPairWith(undefined, (priv) => {
      (priv.initialState as { registers: Record<string, string> }).registers["R_UNDECLARED"] = "0x0";
    });

    const violation = expectRule(result, "XS-PROJ-REG");
    expect(violation.path).toBe("/initialState/registers/R_UNDECLARED");
  });

  it("XS-REG-FLAG:FLAG 寄存器未在私有包初始寄存器集声明被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      const registers = (priv.initialState as { registers: Record<string, string> }).registers;
      delete registers["FLAG0"];
    });

    expectRule(result, "XS-REG-FLAG");
  });

  it("XS-PROJ-GEOM:投影区域几何与布局不一致被拒绝", () => {
    const result = checkPairWith((pub) => {
      const projection = pub.initialProjection as {
        visibleRegions: Array<Record<string, unknown>>;
      };
      at(projection.visibleRegions, 0).byteLength = 2048;
    });

    expectRule(result, "XS-PROJ-GEOM");
  });

  it("XS-PROJ-VALUES:bytesHex 不再是私有 contentHex 前缀被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      const regions = (
        priv.initialState as { memoryRegions: Array<{ contentHex: string }> }
      ).memoryRegions;
      const region = at(regions, 0);
      region.contentHex = `aa${region.contentHex.slice(2)}`;
    });

    const violation = expectRule(result, "XS-PROJ-VALUES");
    expect(violation.path).toBe("/initialProjection/visibleRegions/0/bytesHex");
  });

  it("XS-PROJ-VALUES:寄存器公开值与私有初始值不一致被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      (priv.initialState as { registers: Record<string, string> }).registers["RAX"] = "0x42";
    });

    const violation = expectRule(result, "XS-PROJ-VALUES");
    expect(violation.path).toBe("/initialProjection/visibleRegisters/3/valueHex");
  });

  it("XS-CANARY-CORR:启用 canary 但缺少合规隐藏 canary 对象被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      priv.privateObjects = (priv.privateObjects as unknown[]).slice(0, 2);
    });

    expectRule(result, "XS-CANARY-CORR");
  });

  it("XS-SEED-DECL:seed 公开路径根不在可声明面被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      priv.declaredSeedPublicPaths = ["secrets.flag"];
    });

    expectRule(result, "XS-SEED-DECL");
  });

  it("XS-SEED-DECL:seed 公开路径叶子不可声明被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      priv.declaredSeedPublicPaths = ["visibleRegions.stack.bytesHex.tail"];
    });

    expectRule(result, "XS-SEED-DECL");
  });

  it("XS-SEED-DECL:目标区域不在初始投影被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      priv.declaredSeedPublicPaths = ["visibleRegions.vault.bytesHex"];
    });

    expectRule(result, "XS-SEED-DECL");
  });

  it("XS-ARCH-WIDTH:archBits=32 时寄存器值超出位宽域被拒绝(公开镜像与私有初值同改,隔离目标规则)", () => {
    const result = checkPairWith(
      (pub) => {
        (pub.vmProfile as Record<string, unknown>)["archBits"] = 32;
        const registers = (pub.initialProjection as {
          visibleRegisters: Array<Record<string, unknown>>;
        }).visibleRegisters;
        at(registers, 0).valueHex = "0x7FFFFFFF0000";
      },
      (priv) => {
        (priv.initialState as { registers: Record<string, string> }).registers["RSP"] =
          "0x7FFFFFFF0000";
      },
    );

    const violation = expectRule(result, "XS-ARCH-WIDTH");
    expect(violation.path).toBe("/initialState/registers/RSP");
  });

  it("XS-ARCH-WIDTH:IR 立即数超出无符号位宽域被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      (priv.compiledIr as { instructions: unknown[] }).instructions = [
        {
          op: "mov",
          operands: [
            { kind: "register", name: "RAX" },
            { kind: "immediate", valueHex: "0x10000000000000000" },
          ],
        },
      ];
    });

    const violation = expectRule(result, "XS-ARCH-WIDTH");
    expect(violation.path).toBe("/compiledIr/instructions/0/operands/1/valueHex");
  });

  it("XS-ARCH-WIDTH:内存位移超出有符号位宽域被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      (priv.compiledIr as { instructions: unknown[] }).instructions = [
        {
          op: "mov",
          operands: [
            { kind: "register", name: "RAX" },
            { kind: "memory", baseRegister: "RBP", displacementHex: "-0x10000000000000000" },
          ],
        },
      ];
    });

    const violation = expectRule(result, "XS-ARCH-WIDTH");
    expect(violation.path).toBe("/compiledIr/instructions/0/operands/1/displacementHex");
  });

  it("XS-ARCH-WIDTH:archBits=32 且全部架构值落在 32 位域时保持绿灯(fixture 值域兼容双位宽)", () => {
    const result = checkPairWith((pub) => {
      (pub.vmProfile as Record<string, unknown>)["archBits"] = 32;
    });

    expect(result.ok).toBe(true);
  });

  it("XS-MEM-PAGE-ALIGN:公开区域 byteLength 非 4KB 倍数被拒绝(纵深防御样例,Schema multipleOf 已先行拦截)", () => {
    const result = checkPairWith((pub) => {
      const layout = pub.memoryLayout as { regions: Array<Record<string, unknown>> };
      at(layout.regions, 0).byteLength = 6144;
    });

    const violation = expectRule(result, "XS-MEM-PAGE-ALIGN");
    expect(violation.path).toBe("/memoryLayout/regions/0/byteLength");
  });

  it("XS-MEM-PAGE-ALIGN:私有区域 byteLength 非 4KB 倍数被拒绝(纵深防御样例)", () => {
    const result = checkPairWith(undefined, (priv) => {
      const regions = (priv.initialState as { memoryRegions: Array<Record<string, unknown>> })
        .memoryRegions;
      at(regions, 2).byteLength = 100;
    });

    const violation = expectRule(result, "XS-MEM-PAGE-ALIGN");
    expect(violation.path).toBe("/initialState/memoryRegions/2/byteLength");
  });
});

describe("字段分类检查器:Schema 文档元检查(XS-1 / D2-NO-HIDDEN-IN-PUBLIC)", () => {
  const schemaDir = join(import.meta.dirname, "..", "schema");
  const publicSchemaText = readFileSync(
    join(schemaDir, "public-descriptor.schema.json"),
    "utf8",
  );
  const privateSchemaText = readFileSync(join(schemaDir, "private-bundle.schema.json"), "utf8");

  it("两份冻结 Schema 文档通过元检查(根标记 + 无私有字段名 + 无示例值)", () => {
    const result = checkSchemaMeta(publicSchemaText, privateSchemaText);

    expect(result).toEqual([]);
  });

  it("XS-1:公开 Schema 根标记错标 server-only 被拒绝", () => {
    const mutated = JSON.parse(publicSchemaText) as Record<string, unknown>;
    mutated["x-sm-class"] = "server-only";

    const result = checkSchemaMeta(JSON.stringify(mutated), privateSchemaText);

    const violation = result.find((candidate) => candidate.ruleId === "XS-1");
    expect(violation).toBeDefined();
    expect(violation?.path).toBe("/x-sm-class");
  });

  it("XS-1:私有 Schema 根标记错标 public 被拒绝", () => {
    const mutated = JSON.parse(privateSchemaText) as Record<string, unknown>;
    mutated["x-sm-class"] = "public";

    const result = checkSchemaMeta(publicSchemaText, JSON.stringify(mutated));

    const violation = result.find((candidate) => candidate.ruleId === "XS-1");
    expect(violation).toBeDefined();
    expect(violation?.path).toBe("/x-sm-class");
  });

  it("D2-NO-HIDDEN-IN-PUBLIC:公开 Schema 声明私有属性名被拒绝", () => {
    const mutated = JSON.parse(publicSchemaText) as {
      properties: Record<string, unknown>;
    };
    mutated.properties["secrets"] = { type: "object" };

    const result = checkSchemaMeta(JSON.stringify(mutated), privateSchemaText);

    const violation = result.find((candidate) => candidate.ruleId === "D2-NO-HIDDEN-IN-PUBLIC");
    expect(violation).toBeDefined();
    expect(violation?.message).toContain("secrets");
  });

  it("D2-NO-HIDDEN-IN-PUBLIC:公开 Schema 携带 default 示值被拒绝", () => {
    const mutated = JSON.parse(publicSchemaText) as {
      properties: Record<string, Record<string, unknown>>;
    };
    mutated.properties["challengeId"] = {
      ...mutated.properties["challengeId"],
      default: "ret-basics",
    };

    const result = checkSchemaMeta(JSON.stringify(mutated), privateSchemaText);

    const violation = result.find((candidate) => candidate.ruleId === "D2-NO-HIDDEN-IN-PUBLIC");
    expect(violation).toBeDefined();
    expect(violation?.message).toContain("default");
  });
});

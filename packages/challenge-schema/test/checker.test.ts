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

function loadByteDescriptor(): PublicChallengeDescriptor {
  const descriptor = JSON.parse(basicText) as Record<string, unknown>;
  const profile = descriptor.vmProfile as Record<string, unknown>;
  profile.encodingTable = [
    { tokenHex: "0x00", op: "ret", operands: [] },
    { tokenHex: "0x55", op: "push", operands: [{ kind: "register", name: "RBP" }] },
    { tokenHex: "0xc3", op: "ret", operands: [] },
  ];
  const projection = descriptor.initialProjection as {
    visibleRegions: Array<Record<string, unknown>>;
  };
  const codeProjection = projection.visibleRegions.find((region) => region.regionId === "code");
  if (codeProjection === undefined) {
    throw new Error("字节模式 fixture 缺少公开代码投影");
  }
  codeProjection.bytesHex = "55c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
  const result = validatePublicDescriptor(descriptor);
  if (!result.ok) {
    throw new Error(`字节模式 fixture 应通过校验:${JSON.stringify(result.violations, null, 2)}`);
  }
  return result.value;
}

function checkBytePairWith(editPublic?: PairEdit, editPrivate?: PairEdit): CheckerResult {
  const base = loadByteDescriptor();
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

describe("字段分类检查器:P5 字节权威执行规则", () => {
  it("字节模式绿灯:公开 token 表与私有字节代码从入口线性译码时零违规", () => {
    const base = loadByteDescriptor();
    const result = checkChallengePair(base, buildPrivateBundle(base));

    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("XS-IR-LEAVE:字节模式 leave 出现在无 RBP 的寄存器集被拒绝", () => {
    const result = checkBytePairWith(
      (pub) => {
        const table = (pub.vmProfile as { encodingTable: Array<Record<string, unknown>> }).encodingTable;
        at(table, 1).op = "leave";
      },
      (priv) => {
        const registers = (priv.initialState as { registers: Record<string, string> }).registers;
        delete registers["RBP"];
      },
    );

    const violation = expectRule(result, "XS-IR-LEAVE");
    expect(violation.path).toBe("/vmProfile/encodingTable/1/op");
  });

  it("XS-PROG-MODE:字节模式同时提供 compiledIr 被拒绝", () => {
    const result = checkBytePairWith(undefined, (priv) => {
      priv.compiledIr = { irFormatVersion: 2, instructions: [], labels: [] };
    });

    const violation = expectRule(result, "XS-PROG-MODE");
    expect(violation.path).toBe("/compiledIr");
  });

  it("XS-PROG-MODE:字节模式缺入口地址被拒绝", () => {
    const result = checkBytePairWith(undefined, (priv) => {
      delete priv.entrypointAddressHex;
    });

    const violation = expectRule(result, "XS-PROG-MODE");
    expect(violation.path).toBe("/entrypointAddressHex");
  });

  it("XS-PROG-MODE:IR 模式缺 compiledIr 被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      delete priv.compiledIr;
    });

    const violation = expectRule(result, "XS-PROG-MODE");
    expect(violation.path).toBe("/compiledIr");
  });

  it("XS-PROG-MODE:IR 模式携带字节入口被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      priv.entrypointAddressHex = "0x400000";
    });

    const violation = expectRule(result, "XS-PROG-MODE");
    expect(violation.path).toBe("/entrypointAddressHex");
  });

  it("XS-CODE-WRX:字节模式公开代码区含写权限被拒绝", () => {
    const result = checkBytePairWith((pub) => {
      const regions = (pub.memoryLayout as { regions: Array<Record<string, unknown>> }).regions;
      at(regions, 0).permissions = "rwx";
    });

    const violation = expectRule(result, "XS-CODE-WRX");
    expect(violation.path).toBe("/memoryLayout/regions/0/permissions");
  });

  it("XS-CODE-WRX:字节模式私有代码区含写权限被拒绝", () => {
    const result = checkBytePairWith(undefined, (priv) => {
      const regions = (priv.initialState as { memoryRegions: Array<Record<string, unknown>> })
        .memoryRegions;
      at(regions, 0).permissions = "rwx";
    });

    const violation = expectRule(result, "XS-CODE-WRX");
    expect(violation.path).toBe("/initialState/memoryRegions/0/permissions");
  });

  it("XS-ENC-TOKEN:重复 token 被拒绝", () => {
    const result = checkBytePairWith((pub) => {
      const table = (pub.vmProfile as { encodingTable: Array<Record<string, unknown>> }).encodingTable;
      table.push({ tokenHex: "0x55", op: "ret", operands: [] });
    });

    const violation = expectRule(result, "XS-ENC-TOKEN");
    expect(violation.path).toBe("/vmProfile/encodingTable/3/tokenHex");
  });

  it("XS-ENC-TOKEN:未声明自定义助记符被拒绝", () => {
    const result = checkBytePairWith((pub) => {
      const table = (pub.vmProfile as { encodingTable: Array<Record<string, unknown>> }).encodingTable;
      at(table, 1).op = "LOAD_TWICE";
    });

    const violation = expectRule(result, "XS-ENC-TOKEN");
    expect(violation.path).toBe("/vmProfile/encodingTable/1/op");
  });

  it("XS-ENC-TOKEN:syscall 未声明单一立即数被拒绝", () => {
    const result = checkBytePairWith((pub) => {
      const table = (pub.vmProfile as { encodingTable: Array<Record<string, unknown>> }).encodingTable;
      at(table, 1).op = "syscall";
      at(table, 1).operands = [];
    });

    const violation = expectRule(result, "XS-ENC-TOKEN");
    expect(violation.message).toContain("immediate");
  });

  it("XS-ENC-TOKEN:编码条目引用未声明寄存器被拒绝", () => {
    const result = checkBytePairWith((pub) => {
      const table = (pub.vmProfile as { encodingTable: Array<Record<string, unknown>> }).encodingTable;
      const operands = at(table, 1).operands as Array<Record<string, unknown>>;
      at(operands, 0).name = "R_GHOST";
    });

    const violation = expectRule(result, "XS-ENC-TOKEN");
    expect(violation.path).toBe("/vmProfile/encodingTable/1/operands/0/name");
  });

  it("XS-ENC-PROBE:入口不在代码区被拒绝", () => {
    const result = checkBytePairWith(undefined, (priv) => {
      priv.entrypointAddressHex = "0x7ffff000";
    });

    const violation = expectRule(result, "XS-ENC-PROBE");
    expect(violation.path).toBe("/entrypointAddressHex");
  });

  it("XS-ENC-PROBE:入口可达位置出现未知 token 被拒绝", () => {
    const result = checkBytePairWith(undefined, (priv) => {
      const regions = (priv.initialState as { memoryRegions: Array<{ contentHex: string }> })
        .memoryRegions;
      const code = at(regions, 0);
      code.contentHex = `ff${code.contentHex.slice(2)}`;
    });

    const violation = expectRule(result, "XS-ENC-PROBE");
    expect(violation.message).toContain("未在 encodingTable 声明");
  });

  it("XS-ENC-PROBE:内联立即数越出代码区末尾被拒绝", () => {
    const result = checkBytePairWith(
      (pub) => {
        const table = (pub.vmProfile as { encodingTable: Array<Record<string, unknown>> }).encodingTable;
        at(table, 0).op = "syscall";
        at(table, 0).operands = [{ kind: "immediate", width: "arch" }];
      },
      (priv) => {
        priv.entrypointAddressHex = "0x400fff";
      },
    );

    const violation = expectRule(result, "XS-ENC-PROBE");
    expect(violation.message).toContain("越出代码区末尾");
  });

  it("XS-ENC-PROBE:syscall 按字节偏移读取小端派发号", () => {
    const result = checkBytePairWith(
      (pub) => {
        const table = (pub.vmProfile as { encodingTable: Array<Record<string, unknown>> }).encodingTable;
        at(table, 0).op = "syscall";
        at(table, 0).operands = [{ kind: "immediate", width: "arch" }];
      },
      (priv) => {
        const regions = (priv.initialState as { memoryRegions: Array<Record<string, unknown>> }).memoryRegions;
        const code = at(regions, 0) as { contentHex: string };
        code.contentHex = `00${"0200000000000000"}${"c3".repeat(4087)}`;
      },
    );

    const violation = result.violations.find((candidate) => candidate.ruleId === "XS-ENC-PROBE");
    expect(violation).toBeUndefined();
  });

  it("XS-ENC-PROBE:非首字节 gadget 入口可被独立线性译码", () => {
    const result = checkBytePairWith(undefined, (priv) => {
      priv.entrypointAddressHex = "0x400001";
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

describe("字段分类检查器:R3 架构宽度递归覆盖私有声明面", () => {
  function withArchBits32(editPrivate: PairEdit): CheckerResult {
    return checkPairWith(
      (pub) => {
        (pub.vmProfile as Record<string, unknown>)["archBits"] = 32;
      },
      editPrivate,
    );
  }

  it("XS-ARCH-WIDTH:32 位下微算子 load_imm / set_flag / bit_mask / load_mem 越界被拒绝", () => {
    const result = withArchBits32((priv) => {
      priv.customInstructions = [
        {
          mnemonic: "LOAD_TWICE",
          displayText: "越界语义组合",
          semantics: [
            { op: "load_imm", dst: "RAX", valueHex: "0x100000000" },
            { op: "set_flag", flagRegister: "FLAG0", valueHex: "0x100000000" },
            { op: "bit_mask", dst: "RAX", src: "RAX", maskHex: "0x1FFFFFFFF", logic: "and" },
            { op: "load_mem", dst: "RBX", baseRegister: "RBP", displacementHex: "0x80000000" },
          ],
        },
      ];
    });

    const widthViolations = result.violations.filter((c) => c.ruleId === "XS-ARCH-WIDTH");
    expect(widthViolations.map((v) => v.path)).toEqual([
      "/customInstructions/0/semantics/0/valueHex",
      "/customInstructions/0/semantics/1/valueHex",
      "/customInstructions/0/semantics/2/maskHex",
      "/customInstructions/0/semantics/3/displacementHex",
    ]);
  });

  it("XS-ARCH-WIDTH:32 位下接口效果 set_flag 的 valueHex 越界被拒绝", () => {
    const result = withArchBits32((priv) => {
      priv.interfaces = [
        {
          interfaceId: 512,
          displayText: "置位完成标志",
          effects: [{ effect: "set_flag", flagRegister: "FLAG0", valueHex: "0x100000000" }],
        },
      ];
    });

    const violation = expectRule(result, "XS-ARCH-WIDTH");
    expect(violation.path).toBe("/interfaces/0/effects/0/valueHex");
  });

  it("XS-ARCH-WIDTH:64 位域上界之外的值(绕过 Schema 形态)仍被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      priv.customInstructions = [
        {
          mnemonic: "LOAD_TWICE",
          displayText: "越界语义",
          semantics: [{ op: "load_imm", dst: "RAX", valueHex: "0x1FFFFFFFFFFFFFFFF" }],
        },
      ];
    });

    const violation = expectRule(result, "XS-ARCH-WIDTH");
    expect(violation.path).toBe("/customInstructions/0/semantics/0/valueHex");
  });

  it("XS-ARCH-WIDTH:32 位边界值 0xFFFFFFFF 保持绿灯(不因声明面检查误伤)", () => {
    const result = withArchBits32((priv) => {
      priv.customInstructions = [
        {
          mnemonic: "LOAD_TWICE",
          displayText: "边界值语义",
          semantics: [
            { op: "load_imm", dst: "RAX", valueHex: "0xFFFFFFFF" },
            { op: "load_mem", dst: "RBX", baseRegister: "RBP", displacementHex: "-0x80000000" },
          ],
        },
      ];
    });

    expect(result.violations.filter((c) => c.ruleId === "XS-ARCH-WIDTH")).toHaveLength(0);
  });
});

describe("字段分类检查器:R4 地址区间 64 位上溢统一检查", () => {
  /**
   * 代码区平移到地址空间末尾(公开布局 + 投影 + 私有镜像三处同步;
   * 0xFFFFFFFFFFFFF000 = 2^64 − 4096,byteLength 4096 ⇒ 结束地址恰为 2^64)。
   */
  function moveCodeRegion(byteLength: number): { editPublic: PairEdit; editPrivate: PairEdit } {
    return {
      editPublic: (pub) => {
        const layout = pub.memoryLayout as { regions: Array<Record<string, unknown>> };
        const codeRegion = layout.regions.find((region) => region.kind === "code");
        if (codeRegion === undefined) {
          throw new Error("fixture 缺少代码区域");
        }
        codeRegion.startAddressHex = "0xFFFFFFFFFFFFF000";
        codeRegion.byteLength = byteLength;
        const projection = pub.initialProjection as {
          visibleRegions: Array<Record<string, unknown>>;
        };
        const codeProjection = projection.visibleRegions.find((region) => region.regionId === "code");
        if (codeProjection === undefined) {
          throw new Error("fixture 缺少代码投影");
        }
        codeProjection.startAddressHex = "0xFFFFFFFFFFFFF000";
        codeProjection.byteLength = byteLength;
      },
      editPrivate: (priv) => {
        const regions = (priv.initialState as {
          memoryRegions: Array<{ contentHex: string; startAddressHex: string; byteLength: number }>;
        }).memoryRegions;
        const codeRegion = regions.find((region) => (region as { kind?: string }).kind === "code");
        if (codeRegion === undefined) {
          throw new Error("fixture 缺少私有代码区域");
        }
        codeRegion.startAddressHex = "0xFFFFFFFFFFFFF000";
        const previousContent = codeRegion.contentHex;
        codeRegion.byteLength = byteLength;
        const prefixBytes = previousContent.length / 2;
        codeRegion.contentHex = previousContent + "00".repeat(byteLength - prefixBytes);
      },
    };
  }

  it("XS-ADDR-SPACE:结束地址恰好 2^64 合法(末字节 0xFFFFFFFFFFFFFFFF 可表示)", () => {
    const edits = moveCodeRegion(4096);
    const result = checkPairWith(edits.editPublic, edits.editPrivate);

    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("XS-ADDR-SPACE:公开区域越过 2^64 被拒绝", () => {
    const edits = moveCodeRegion(8192);
    const result = checkPairWith(edits.editPublic, edits.editPrivate);

    const violation = expectRule(result, "XS-ADDR-SPACE");
    expect(violation.path).toBe("/memoryLayout/regions/0");
    expect(violation.message).toContain("2^64");
  });

  it("XS-ADDR-SPACE:私有隐藏区域越过 2^64 被拒绝(不与公开侧共用路径差异)", () => {
    const result = checkPairWith(undefined, (priv) => {
      const regions = (priv.initialState as { memoryRegions: Array<Record<string, unknown>> })
        .memoryRegions;
      const vault = regions.find((region) => region.isHidden);
      if (vault === undefined) {
        throw new Error("fixture 缺少隐藏区域");
      }
      vault.startAddressHex = "0xFFFFFFFFFFFFF000";
      vault.byteLength = 8192;
    });

    const violation = expectRule(result, "XS-ADDR-SPACE");
    expect(violation.path).toBe("/initialState/memoryRegions/2");
  });

  it("XS-ADDR-SPACE:私有对象登记越过 2^64 被拒绝", () => {
    const result = checkPairWith(undefined, (priv) => {
      const objects = priv.privateObjects as Array<Record<string, unknown>>;
      const canaryObject = objects.find((object) => object.visibility === "hidden");
      if (canaryObject === undefined) {
        throw new Error("fixture 缺少 hidden 对象");
      }
      canaryObject.addressHex = "0xFFFFFFFFFFFFF000";
      canaryObject.byteLength = 8192;
    });

    const violation = expectRule(result, "XS-ADDR-SPACE");
    expect(violation.path).toBe("/privateObjects/2");
  });

  it("XS-ADDR-SPACE:私有非隐藏区域与公开区域同越界时双侧报告(半开区间统一)", () => {
    const edits = moveCodeRegion(8192);
    const result = checkPairWith(edits.editPublic, edits.editPrivate);

    const bounds = result.violations.filter((c) => c.ruleId === "XS-ADDR-SPACE");
    expect(bounds.length).toBeGreaterThanOrEqual(2);
    expect(bounds.some((v) => v.path === "/memoryLayout/regions/0")).toBe(true);
    expect(bounds.some((v) => (v.path ?? "").startsWith("/initialState/memoryRegions/0"))).toBe(
      true,
    );
  });
});

describe("字段分类检查器:R10-R13 契约冻结纵深防御", () => {
  it("R10:字节模式出现第二个私有代码区被拒绝(单代码区模型)", () => {
    const result = checkBytePairWith(undefined, (priv) => {
      const regions = (priv.initialState as { memoryRegions: Array<Record<string, unknown>> })
        .memoryRegions;
      regions.push({
        regionId: "code2",
        kind: "code",
        startAddressHex: "0x500000",
        byteLength: 4096,
        permissions: "rx",
        contentHex: "00".repeat(4096),
        isHidden: false,
      });
    });

    const violation = expectRule(result, "XS-ENC-PROBE");
    expect(violation.message).toContain("恰有一个公开且非隐藏的代码区");
  });

  it("R10:IR 模式私有代码区不得隐藏(代码区恒公开,D2 私有面)", () => {
    const result = checkPairWith(undefined, (priv) => {
      const regions = (priv.initialState as { memoryRegions: Array<{ isHidden: boolean }> })
        .memoryRegions;
      const code = regions.find((region) => (region as { kind?: string }).kind === "code");
      if (code === undefined) {
        throw new Error("fixture 缺少代码区域");
      }
      code.isHidden = true;
    });

    const violation = expectRule(result, "D2-CODE-PUBLIC");
    expect(violation.message).toContain("不得隐藏");
  });

  it("R11:编码操作数引用 FLAG 寄存器被拒绝(绕过 Schema 直测,FLAG 不可编码)", () => {
    const registerResult = checkBytePairWith((pub) => {
      const table = (pub.vmProfile as { encodingTable: Array<Record<string, unknown>> }).encodingTable;
      at(table, 1).operands = [{ kind: "register", name: "FLAG0" }];
    });
    const baseRegisterResult = checkBytePairWith((pub) => {
      const table = (pub.vmProfile as { encodingTable: Array<Record<string, unknown>> }).encodingTable;
      at(table, 1).op = "mov";
      at(table, 1).operands = [{ kind: "memory", baseRegister: "FLAG0", displacementWidth: "arch" }];
    });

    const registerViolation = expectRule(registerResult, "XS-ENC-TOKEN");
    expect(registerViolation.message).toContain("FLAG0");
    const baseViolation = expectRule(baseRegisterResult, "XS-ENC-TOKEN");
    expect(baseViolation.message).toContain("FLAG0");
  });

  it("R12:immediate 缺 width 被拒绝(绕过 Schema 直测,宽度不得依赖隐式推断)", () => {
    const result = checkBytePairWith((pub) => {
      const table = (pub.vmProfile as { encodingTable: Array<Record<string, unknown>> }).encodingTable;
      at(table, 0).op = "syscall";
      at(table, 0).operands = [{ kind: "immediate" }];
    });

    const violation = expectRule(result, "XS-ENC-TOKEN");
    expect(violation.path).toBe("/vmProfile/encodingTable/0/operands/0/width");
    expect(violation.message).toContain("必填");
  });

  it("R12:memory 缺 displacementWidth 被拒绝(绕过 Schema 直测)", () => {
    const result = checkBytePairWith((pub) => {
      const table = (pub.vmProfile as { encodingTable: Array<Record<string, unknown>> }).encodingTable;
      at(table, 1).op = "mov";
      at(table, 1).operands = [{ kind: "memory", baseRegister: "RBP" }];
    });

    const violation = expectRule(result, "XS-ENC-TOKEN");
    expect(violation.path).toBe("/vmProfile/encodingTable/1/operands/0/displacementWidth");
    expect(violation.message).toContain("必填");
  });

  it("R13:程序模式三态判定——undefined 走 IR 模式、空数组失败关闭、有效表字节模式", () => {
    const irMode = checkPairWith(undefined);
    expect(irMode.ok).toBe(true);

    const emptyTable = checkBytePairWith((pub) => {
      (pub.vmProfile as { encodingTable: unknown[] }).encodingTable = [];
    });
    const emptyTableViolation = expectRule(emptyTable, "XS-ENC-TOKEN");
    expect(emptyTableViolation.message).toContain("空数组");
    expect(emptyTableViolation.path).toBe("/vmProfile/encodingTable");
    // 空表按字节模式处理(存在即字节模式),不得静默退回 IR 模式:
    // 缺少可解析 token 表时探测必然报未知 token,失败关闭。
    expect(emptyTable.violations.some((v) => v.ruleId === "XS-ENC-PROBE")).toBe(true);

    const validTable = checkBytePairWith(undefined);
    expect(validTable.ok).toBe(true);
  });
});

describe("字段分类检查器:R14 P5 专项测试矩阵补齐", () => {
  /**
   * 字节代码同步编辑:公开投影 bytesHex 与私有 contentHex 前缀镜像
   * (XS-PROJ-VALUES 前提),私有侧以 00(ret token)填充至区域尾。
   */
  function byteCode(bytesHex: string): { editPublic: PairEdit; editPrivate: PairEdit } {
    return {
      editPublic: (pub) => {
        const projection = pub.initialProjection as {
          visibleRegions: Array<Record<string, unknown>>;
        };
        const code = projection.visibleRegions.find((region) => region.regionId === "code");
        if (code === undefined) {
          throw new Error("fixture 缺少代码投影");
        }
        code.bytesHex = bytesHex;
      },
      editPrivate: (priv) => {
        const regions = (priv.initialState as {
          memoryRegions: Array<{ contentHex: string }>;
        }).memoryRegions;
        const code = regions.find((region) => (region as { kind?: string }).kind === "code");
        if (code === undefined) {
          throw new Error("fixture 缺少私有代码区域");
        }
        code.contentHex = bytesHex + "00".repeat(4096 - bytesHex.length / 2);
      },
    };
  }

  /** 在编码表追加一条 syscall 条目并按给定内联字节布置代码(0x00 = ret 填充)。 */
  function syscallScenario(dispatchBytesHex: string): {
    editPublic: PairEdit;
    editPrivate: PairEdit;
  } {
    const code = `f1${dispatchBytesHex}`;
    return {
      editPublic: (pub) => {
        const table = (pub.vmProfile as { encodingTable: Array<Record<string, unknown>> })
          .encodingTable;
        table.push({
          tokenHex: "0xf1",
          op: "syscall",
          operands: [{ kind: "immediate", width: "arch" }],
        });
        byteCode(code).editPublic(pub);
      },
      editPrivate: (priv) => {
        byteCode(code).editPrivate(priv);
      },
    };
  }

  it("32 位 syscall 探测:按 archBits/8 = 4 字节读取小端派发号(保留带绿灯)", () => {
    const edits = syscallScenario("02000000");
    const result = checkBytePairWith(
      (pub) => {
        (pub.vmProfile as Record<string, unknown>)["archBits"] = 32;
        edits.editPublic(pub);
      },
      edits.editPrivate,
    );

    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("syscall 派发号已声明接口时绿灯;未声明时拒绝(探测译码产物)", () => {
    const edits = syscallScenario("0002000000000000");

    const green = checkBytePairWith(edits.editPublic, (priv) => {
      edits.editPrivate(priv);
      priv.interfaces = [
        { interfaceId: 512, displayText: "接口甲", effects: [{ effect: "noop" }] },
      ];
    });
    expect(green.ok).toBe(true);

    const red = checkBytePairWith(edits.editPublic, edits.editPrivate);

    const violation = expectRule(red, "XS-ENC-PROBE");
    expect(violation.message).toContain("未在保留带或 interfaces 声明");
  });

  it("字节模式代码区地址范围越出 2^64 时探测拒绝(R4 与 XS-ADDR-SPACE 同公式)", () => {
    // 私有代码区平移到 2^64 − 8192 处并越界;公开侧保持原几何
    // (I2-PUB-MIRROR 噪声可接受,断言探测的区间越界语义)。
    const result = checkBytePairWith(undefined, (priv) => {
      const regions = (priv.initialState as {
        memoryRegions: Array<{ startAddressHex: string; byteLength: number }>;
      }).memoryRegions;
      const code = regions.find((region) => (region as { kind?: string }).kind === "code");
      if (code === undefined) {
        throw new Error("fixture 缺少私有代码区域");
      }
      code.startAddressHex = "0xFFFFFFFFFFFFF000";
      code.byteLength = 8192;
      priv.entrypointAddressHex = "0xFFFFFFFFFFFFF000";
    });

    const violation = expectRule(result, "XS-ENC-PROBE");
    expect(violation.message).toContain("64 位地址空间");
  });

  it("call 的 immediate / register / interface 三种操作数形态均为绿灯", () => {
    const edits = byteCode(`55${"e8"}${"0102030405060708"}e9ea`);
    const result = checkBytePairWith(
      (pub) => {
        const table = (pub.vmProfile as { encodingTable: Array<Record<string, unknown>> }).encodingTable;
        table.push(
          { tokenHex: "0xe8", op: "call", operands: [{ kind: "immediate", width: "arch" }] },
          { tokenHex: "0xe9", op: "call", operands: [{ kind: "register", name: "RAX" }] },
          { tokenHex: "0xea", op: "call", operands: [{ kind: "interface", interfaceId: 512 }] },
        );
        edits.editPublic(pub);
      },
      (priv) => {
        edits.editPrivate(priv);
        priv.interfaces = [
          { interfaceId: 512, displayText: "接口甲", effects: [{ effect: "noop" }] },
        ];
      },
    );

    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("ret / leave 编码条目携带操作数被拒绝(封闭零操作数)", () => {
    const retResult = checkBytePairWith((pub) => {
      const table = (pub.vmProfile as { encodingTable: Array<Record<string, unknown>> }).encodingTable;
      at(table, 0).operands = [{ kind: "register", name: "RAX" }];
    });
    const leaveResult = checkBytePairWith((pub) => {
      const table = (pub.vmProfile as { encodingTable: Array<Record<string, unknown>> }).encodingTable;
      at(table, 1).op = "leave";
    });

    expect(expectRule(retResult, "XS-ENC-TOKEN").message).toContain("不得声明操作数");
    expect(expectRule(leaveResult, "XS-ENC-TOKEN").message).toContain("不得声明操作数");
  });

  it("自定义助记符条目携带操作数被拒绝(操作数必须烘焙在 token 中)", () => {
    const result = checkBytePairWith(
      (pub) => {
        const table = (pub.vmProfile as { encodingTable: Array<Record<string, unknown>> }).encodingTable;
        at(table, 1).op = "LOAD_TWICE";
      },
      (priv) => {
        priv.customInstructions = [
          {
            mnemonic: "LOAD_TWICE",
            displayText: "装载语义",
            semantics: [{ op: "load_imm", dst: "RAX", valueHex: "0x2A" }],
          },
        ];
      },
    );

    const violation = expectRule(result, "XS-ENC-TOKEN");
    expect(violation.message).toContain("操作数必须烘焙在 token 中");
  });

  it("token 大小写拼写差异视作重复(XS-ENC-TOKEN 大小写不敏感唯一)", () => {
    const result = checkBytePairWith((pub) => {
      const table = (pub.vmProfile as { encodingTable: Array<Record<string, unknown>> }).encodingTable;
      at(table, 0).tokenHex = "0x5A";
      table.push({ tokenHex: "0x5a", op: "ret", operands: [] });
    });

    const violation = expectRule(result, "XS-ENC-TOKEN");
    expect(violation.path).toBe("/vmProfile/encodingTable/3/tokenHex");
    expect(violation.message).toContain("重复");
  });

  it("字节模式代码区缺失被拒绝(恰有一个公开代码区前提)", () => {
    const result = checkBytePairWith((pub) => {
      const layout = pub.memoryLayout as { regions: Array<Record<string, unknown>> };
      const codeRegion = layout.regions.find((region) => region.kind === "code");
      if (codeRegion === undefined) {
        throw new Error("fixture 缺少代码区域");
      }
      codeRegion.kind = "global";
    });

    const violation = expectRule(result, "XS-ENC-PROBE");
    expect(violation.message).toContain("恰有一个公开且非隐藏的代码区");
  });

  it("入口可达指令数超过 MAX_IR_INSTRUCTIONS 被拒绝(区域扩充且双包同步)", () => {
    const result = checkBytePairWith(
      (pub) => {
        const layout = pub.memoryLayout as { regions: Array<Record<string, unknown>> };
        const codeRegion = layout.regions.find((region) => region.kind === "code");
        if (codeRegion === undefined) {
          throw new Error("fixture 缺少代码区域");
        }
        codeRegion.byteLength = 8192;
        const projection = pub.initialProjection as {
          visibleRegions: Array<Record<string, unknown>>;
        };
        const codeProjection = projection.visibleRegions.find((region) => region.regionId === "code");
        if (codeProjection === undefined) {
          throw new Error("fixture 缺少代码投影");
        }
        codeProjection.byteLength = 8192;
      },
      (priv) => {
        const regions = (priv.initialState as {
          memoryRegions: Array<{ contentHex: string; byteLength: number }>;
        }).memoryRegions;
        const code = regions.find((region) => (region as { kind?: string }).kind === "code");
        if (code === undefined) {
          throw new Error("fixture 缺少私有代码区域");
        }
        code.byteLength = 8192;
        code.contentHex += "00".repeat(4096);
      },
    );

    const violation = expectRule(result, "XS-ENC-PROBE");
    expect(violation.message).toContain("上限");
  });

  it("字节模式 leave 携带 RBP 时绿灯(栈帧语义前提成立)", () => {
    const result = checkBytePairWith((pub) => {
      const table = (pub.vmProfile as { encodingTable: Array<Record<string, unknown>> }).encodingTable;
      at(table, 1).op = "leave";
      at(table, 1).operands = [];
    });

    expect(result.ok).toBe(true);
  });

  it("截断 displacement:内联位移越出代码区末尾被拒绝", () => {
    const result = checkBytePairWith((pub) => {
      const table = (pub.vmProfile as { encodingTable: Array<Record<string, unknown>> }).encodingTable;
      at(table, 0).op = "mov";
      at(table, 0).operands = [{ kind: "memory", baseRegister: "RBP", displacementWidth: "arch" }];
    }, (priv) => {
      priv.entrypointAddressHex = "0x400fff";
    });

    const violation = expectRule(result, "XS-ENC-PROBE");
    expect(violation.message).toContain("越出代码区末尾");
  });
});

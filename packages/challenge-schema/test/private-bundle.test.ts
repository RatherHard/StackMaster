/**
 * 私有判题包校验器测试。
 *
 * 全部私有样例由 test/helpers/private-bundle.ts 在测试进程内派生构造,
 * **没有任何私有包样例文件入 git**(CLAUDE.md 红线)。
 * 红灯样例在 JSON 层对基础判题包做单次定向破坏(镜像类型全只读,
 * 直接赋值无法通过 typecheck),每条对应 WP-1 §12.6 规则或 Schema 结构面。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PublicChallengeDescriptor } from "../src/index.js";
import { validatePublicDescriptor } from "../src/index.js";
import { parsePrivateBundleText, validatePrivateBundle } from "../src/server-only/index.js";
import type { SchemaViolation, Validated } from "../src/common/validation.js";
import type { PrivateChallengeBundle } from "../src/server-only/private-types.js";
import { buildPrivateBundle } from "./helpers/private-bundle.js";

const basicText = readFileSync(
  join(import.meta.dirname, "fixtures", "public-descriptor", "basic.json"),
  "utf8",
);

function loadPublicDescriptor(): PublicChallengeDescriptor {
  const result = validatePublicDescriptor(JSON.parse(basicText));
  if (!result.ok) {
    throw new Error(`公开 fixture 校验失败:${JSON.stringify(result.violations)}`);
  }
  return result.value;
}

function assertOk<T>(result: Validated<T>): T {
  if (!result.ok) {
    throw new Error(`预期校验通过,实际失败:${JSON.stringify(result.violations, null, 2)}`);
  }
  return result.value;
}

function assertFail(result: Validated<unknown>): readonly SchemaViolation[] {
  if (result.ok) {
    throw new Error("预期校验失败,实际通过");
  }
  return result.violations;
}

/** 定向破坏后的反例故意违反类型镜像;仅用于 Schema 层红灯,故走 unknown。 */
function breakBundle(
  bundle: PrivateChallengeBundle,
  edit: (clone: Record<string, unknown>) => void,
): unknown {
  const clone = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
  edit(clone);
  return clone;
}

describe("私有判题包校验器", () => {
  it("由公开描述包派生的判题包通过 Schema 校验,身份字段镜像一致(XS-ID-CORR)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const bundle = buildPrivateBundle(publicDescriptor);

    expect(bundle.challengeId).toBe(publicDescriptor.challengeId);
    expect(bundle.challengeContentVersion).toBe(publicDescriptor.challengeContentVersion);
    expect(bundle.vmProfileVersion).toBe(publicDescriptor.vmProfileVersion);
  });

  it("非隐藏区域 contentHex 长度等于 2 × byteLength 且以公开 bytesHex 开头(XS-MEM-CONTENT/XS-PROJ-VALUES 前提)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const bundle = buildPrivateBundle(publicDescriptor);

    for (const region of bundle.initialState.memoryRegions) {
      expect(region.contentHex.length).toBe(region.byteLength * 2);
      if (!region.isHidden) {
        const projected = publicDescriptor.initialProjection.visibleRegions.find(
          (v) => v.regionId === region.regionId,
        );
        expect(projected).toBeDefined();
        expect(region.contentHex.startsWith(projected?.bytesHex ?? "")).toBe(true);
      }
    }
  });

  it("权威 canary 值位于隐藏 key 区域,与公开区域地址范围不相交(I-2 区域级)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const bundle = buildPrivateBundle(publicDescriptor);

    const vault = bundle.initialState.memoryRegions.find((r) => r.regionId === "canary-vault");
    expect(vault?.isHidden).toBe(true);
    expect(vault?.kind).toBe("key");

    const vaultStart = BigInt(vault?.startAddressHex ?? "0x0");
    const vaultEnd = vaultStart + BigInt(vault?.byteLength ?? 0);
    for (const region of publicDescriptor.memoryLayout.regions) {
      const start = BigInt(region.startAddressHex);
      const end = start + BigInt(region.byteLength);
      expect(vaultStart < end && start < vaultEnd).toBe(false);
    }
  });

  it("canary 对象登记为 hidden 且 containsSecret(I2-OBJ-NOT-PUBLIC 前提)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const bundle = buildPrivateBundle(publicDescriptor);

    const canaryObject = bundle.privateObjects.find((o) => o.kind === "canary");
    expect(canaryObject?.visibility).toBe("hidden");
    expect(canaryObject?.containsSecret).toBe(true);
  });

  it("dslSchemaVersion 只接受冻结常量 2(G4/D4:opcode v2 定基,v1 包不再受纳)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        clone.dslSchemaVersion = 1;
      })),
    );

    expect(violations.length).toBeGreaterThan(0);
  });

  it("判题条件超过三级布尔嵌套被拒绝(XS-NESTING)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        // L1.all → L2.all → L3;第三层再包 all 越过深度上限。
        (clone.judging as Record<string, unknown>).successCondition = {
          all: [{ all: [{ all: [{ predicate: { type: "stack_canary_intact" } }] }] }],
        };
      })),
    );

    expect(violations.some((v) => v.path.includes("/judging/successCondition"))).toBe(true);
  });

  it("未知 opcode 被拒绝(DSL 词汇封闭)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        clone.compiledIr = {
          ...(clone.compiledIr as Record<string, unknown>),
          instructions: [{ op: "int3", operands: [] }],
        };
      })),
    );

    expect(violations.some((v) => v.path.includes("/compiledIr/instructions"))).toBe(true);
  });

  it("单条指令操作数超过 4 槽被拒绝(maxItems)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        clone.compiledIr = {
          ...(clone.compiledIr as Record<string, unknown>),
          instructions: [
            {
              op: "mov",
              operands: Array.from({ length: 5 }, () => ({
                kind: "immediate",
                valueHex: "0x0",
              })),
            },
          ],
        };
      })),
    );

    expect(
      violations.some((v) => v.path.includes("/compiledIr/instructions/0/operands")),
    ).toBe(true);
  });

  it("fixed seed 策略必须携带 seedHex(if/then)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        clone.seedPolicy = { strategy: "fixed" };
      })),
    );

    expect(violations.some((v) => v.path.includes("/seedPolicy"))).toBe(true);
  });

  it("隐藏测试 expectedResult 只接受可达裁决枚举(D6:不可达结果不是预期结果)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        const judging = clone.judging as Record<string, unknown>;
        const hiddenTests = judging.hiddenTests as Array<Record<string, unknown>>;
        hiddenTests[0] = { ...hiddenTests[0]!, expectedResult: "replay_mismatch" };
      })),
    );

    expect(violations.some((v) => v.path.includes("/judging/hiddenTests/0"))).toBe(true);
  });

  it("寄存器键必须归属双命名空间之一(G2/D3:XS-REG-NAMESPACE 结构面,不属任何命名空间的键拒绝)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        clone.initialState = {
          ...(clone.initialState as Record<string, unknown>),
          registers: { RSP: "0x7FFFFFF8", rsp: "0x0" },
        };
      })),
    );

    expect(violations.some((v) => v.path.includes("/initialState/registers"))).toBe(true);
  });

  it("自定义寄存器键通过 Schema(G2/D3 验收绿灯样例:R_MYDATA)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const bundle = assertOk(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        const registers = (clone.initialState as { registers: Record<string, string> }).registers;
        registers["R_MYDATA"] = "0x2A";
      })),
    );

    expect(bundle.initialState.registers["R_MYDATA"]).toBe("0x2A");
  });

  it("registers 超过 256 键被拒绝(G2/D3.1:上限 64 → 256,资源护栏样例)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const oversized: Record<string, string> = {};
    for (let index = 0; index < 257; index += 1) {
      oversized[`R${index}`] = "0x0";
    }
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        (clone.initialState as { registers: Record<string, string> }).registers = oversized;
      })),
    );

    expect(violations.some((v) => v.path === "/initialState/registers")).toBe(true);
  });

  it("阶段 resourceBudget.maxInstructionSteps 必填(XS-STAGE-BUDGET 结构面)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        clone.stages = [
          {
            stageId: "s1",
            allowedActions: ["write_bytes"],
            preconditions: { all: [] },
            transitions: [],
            sideEffects: [],
            failureConditions: [],
            resourceBudget: { maxActions: 5 },
          },
        ];
      })),
    );

    expect(violations.some((v) => v.path.includes("/stages/0/resourceBudget"))).toBe(true);
  });

  it("parsePrivateBundleText 往返接受合法判题包", () => {
    const publicDescriptor = loadPublicDescriptor();
    const bundle = buildPrivateBundle(publicDescriptor);

    const parsed = assertOk(parsePrivateBundleText(JSON.stringify(bundle)));

    expect(parsed).toEqual(bundle);
  });

  it("parsePrivateBundleText 拒绝重复键(XS-DUP-KEY,严格扫描器)", () => {
    const result = parsePrivateBundleText('{"dslSchemaVersion":1,"dslSchemaVersion":1}');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.message).toContain("重复键");
    }
  });

  it("私有区域 byteLength 非 4KB 倍数被拒绝(G3/D2:VMA 页对齐)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        const regions = (clone.initialState as {
          memoryRegions: Array<Record<string, unknown>>;
        }).memoryRegions;
        regions[0]!["byteLength"] = 6144;
      })),
    );

    expect(
      violations.some((v) => v.path.includes("/initialState/memoryRegions/0/byteLength")),
    ).toBe(true);
  });

  it("custom 区域类型可入私有初始状态(G3:与公开布局同枚举)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const bundle = assertOk(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        const regions = (clone.initialState as {
          memoryRegions: Array<Record<string, unknown>>;
        }).memoryRegions;
        regions[0]!["kind"] = "custom";
      })),
    );

    expect(bundle.initialState.memoryRegions[0]?.kind).toBe("custom");
  });

  it("已废止 opcode read / write 被拒绝(G4/D4 v2:教学 IO 收敛,21 → 20 定基)", () => {
    const publicDescriptor = loadPublicDescriptor();
    for (const abolished of ["read", "write"]) {
      const violations = assertFail(
        validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
          clone.compiledIr = {
            ...(clone.compiledIr as Record<string, unknown>),
            instructions: [{ op: abolished, operands: [] }],
          };
        })),
      );

      expect(
        violations.some((v) => v.path.includes("/compiledIr/instructions")),
        `已废止 opcode ${abolished}`,
      ).toBe(true);
    }
  });

  it("自定义指令语义含未知微算子(控制转移变体)被拒(G4/D4:封闭集直线语义)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        clone.customInstructions = [
          {
            mnemonic: "LOAD_TWICE",
            displayText: "装载两次",
            semantics: [
              { op: "load_imm", dst: "RAX", valueHex: "0x2A" },
              // jmp_back 不在微算子封闭集 v1(load_imm/mov_reg/load_mem/
              // store_mem/set_flag/bit_mask):控制转移语义在 Schema 层结构性不可表达。
              { op: "jmp_back" },
            ],
          },
        ];
      })),
    );

    expect(violations.some((v) => v.path.includes("/customInstructions/0/semantics/1"))).toBe(
      true,
    );
  });

  it("小写助记符不满足自定义指令形态被拒(G4/D4:与基线枚举大小写结构性不相交)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        clone.customInstructions = [
          {
            mnemonic: "load_twice",
            displayText: "装载两次",
            semantics: [{ op: "load_imm", dst: "RAX", valueHex: "0x0" }],
          },
        ];
      })),
    );

    expect(violations.some((v) => v.path.includes("/customInstructions/0/mnemonic"))).toBe(true);
  });

  it("interfaceId 低于 0x100 被拒(G4/D4:保留系统号带 [0x0, 0xFF] 不开放声明)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        clone.interfaces = [
          {
            interfaceId: 255,
            displayText: "闯入保留带的接口",
            effects: [{ effect: "noop" }],
          },
        ];
      })),
    );

    expect(violations.some((v) => v.path.includes("/interfaces/0/interfaceId"))).toBe(true);
  });

  it("G4/D4 绿灯:customInstructions + interfaces 声明面与双形态 IR 通过 Schema 校验", () => {
    const publicDescriptor = loadPublicDescriptor();
    const bundle = assertOk(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        clone.customInstructions = [
          {
            mnemonic: "LOAD_TWICE",
            displayText: "装载立即数并取低字节",
            semantics: [
              { op: "load_imm", dst: "RAX", valueHex: "0x2A" },
              { op: "bit_mask", dst: "RAX", src: "RAX", maskHex: "0xFF", logic: "and" },
            ],
          },
        ];
        clone.interfaces = [
          {
            interfaceId: 512,
            displayText: "授予解题笔记读取权",
            effects: [
              { effect: "grant_virtual_file", fileId: "win-notes" },
              { effect: "set_flag", flagRegister: "FLAG0", valueHex: "0x1" },
            ],
          },
        ];
        clone.compiledIr = {
          ...(clone.compiledIr as Record<string, unknown>),
          instructions: [
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
          ],
        };
      })),
    );

    expect(bundle.customInstructions?.[0]?.mnemonic).toBe("LOAD_TWICE");
    expect(bundle.interfaces?.[0]?.interfaceId).toBe(512);
  });

  it("interfaceId 超过 0xFFFF 被拒(G4/D4 声明带上限)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        clone.interfaces = [
          {
            interfaceId: 65536,
            displayText: "越界接口",
            effects: [{ effect: "noop" }],
          },
        ];
      })),
    );

    expect(violations.some((v) => v.path.includes("/interfaces/0/interfaceId"))).toBe(true);
  });

  it("自定义指令条目携带未知附加属性被拒(R15:声明面严格对象边界)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        clone.customInstructions = [
          {
            mnemonic: "LOAD_TWICE",
            displayText: "装载两次",
            semantics: [{ op: "load_imm", dst: "RAX", valueHex: "0x0" }],
            hostHandler: "eval",
          },
        ];
      })),
    );

    expect(violations.some((v) => v.path.includes("/customInstructions/0"))).toBe(true);
  });

  it("接口条目携带未知附加属性被拒(R15:声明面严格对象边界)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        clone.interfaces = [
          {
            interfaceId: 512,
            displayText: "接口甲",
            effects: [{ effect: "noop" }],
            handlerPointer: "0x401000",
          },
        ];
      })),
    );

    expect(violations.some((v) => v.path.includes("/interfaces/0"))).toBe(true);
  });
});

describe("私有判题包:程序形态与公开面隔离(R15)", () => {
  function loadBytePublicDescriptor(): PublicChallengeDescriptor {
    const descriptor = JSON.parse(basicText) as Record<string, unknown>;
    const profile = descriptor.vmProfile as Record<string, unknown>;
    profile.encodingTable = [
      { tokenHex: "0x00", op: "ret", operands: [] },
      { tokenHex: "0x55", op: "push", operands: [{ kind: "register", name: "RBP" }] },
    ];
    const projection = descriptor.initialProjection as {
      visibleRegions: Array<Record<string, unknown>>;
    };
    const codeProjection = projection.visibleRegions.find((region) => region.regionId === "code");
    if (codeProjection === undefined) {
      throw new Error("字节模式 fixture 缺少代码投影");
    }
    codeProjection.bytesHex = "55c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
    const result = validatePublicDescriptor(descriptor);
    if (!result.ok) {
      throw new Error(`字节模式 fixture 应通过校验:${JSON.stringify(result.violations)}`);
    }
    return result.value;
  }

  it("字节模式形态:私有包携带 entrypointAddressHex 且无 compiledIr 通过 Schema", () => {
    const bundle = buildPrivateBundle(loadBytePublicDescriptor());

    expect(bundle.entrypointAddressHex).toBeDefined();
    expect(bundle.compiledIr).toBeUndefined();
    expect(validatePrivateBundle(JSON.parse(JSON.stringify(bundle))).ok).toBe(true);
  });

  it("字节模式形态:非法入口地址被拒(hexValue64 形态,R15)", () => {
    const publicDescriptor = loadBytePublicDescriptor();
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        clone.entrypointAddressHex = "0xZZZZ";
      })),
    );

    expect(violations.some((v) => v.path.includes("entrypointAddressHex"))).toBe(true);
  });

  it("双程序字段双给:Schema 层放行(跨包条件不可表达),交由 XS-PROG-MODE 拒绝", () => {
    const publicDescriptor = loadPublicDescriptor();
    const mutated = JSON.parse(JSON.stringify(buildPrivateBundle(publicDescriptor))) as Record<
      string,
      unknown
    >;
    mutated.entrypointAddressHex = "0x400000";

    // Schema 层无条件约束 compiledIr × entrypointAddressHex(字节模式由公开包
    // encodingTable 决定,单包 Schema 不可见);此处固化"Schema 放行、检查器拒绝"
    // 的分层事实,防止误以为 Schema 已拦截。
    expect(validatePrivateBundle(mutated).ok).toBe(true);
  });

  it("双程序字段双缺:Schema 层放行(同上,跨包约束归 XS-PROG-MODE)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const mutated = JSON.parse(JSON.stringify(buildPrivateBundle(publicDescriptor))) as Record<
      string,
      unknown
    >;
    delete mutated.compiledIr;

    expect(validatePrivateBundle(mutated).ok).toBe(true);
  });

  it("私有包携带公开面字段 memoryLayout 被拒(additionalProperties,R15)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        clone.memoryLayout = { regions: [] };
      })),
    );

    expect(violations.some((v) => v.message.includes("memoryLayout"))).toBe(true);
  });

  it("私有包复制 archBits 被拒(位宽是公开常量,私有包不复制防双真相源,G1/R15)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        clone.archBits = 64;
      })),
    );

    expect(violations.some((v) => v.message.includes("archBits"))).toBe(true);
  });
});

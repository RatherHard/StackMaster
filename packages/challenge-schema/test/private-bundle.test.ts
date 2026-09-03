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

  it("dslSchemaVersion 只接受冻结常量 1", () => {
    const publicDescriptor = loadPublicDescriptor();
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        clone.dslSchemaVersion = 2;
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

  it("寄存器键必须匹配基集或 FLAG 模式(XS-REG-FROZEN 结构面)", () => {
    const publicDescriptor = loadPublicDescriptor();
    const violations = assertFail(
      validatePrivateBundle(breakBundle(buildPrivateBundle(publicDescriptor), (clone) => {
        clone.initialState = {
          ...(clone.initialState as Record<string, unknown>),
          registers: { RSP: "0x7FFFFFF8", EAX: "0x0" },
        };
      })),
    );

    expect(violations.some((v) => v.path.includes("/initialState/registers"))).toBe(true);
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
});

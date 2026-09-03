/**
 * 公开描述包校验器测试(TDD 红→绿):
 * - committed fixture(test/fixtures/public-descriptor/basic.json)是绿灯基线,
 *   同时是 WP-6 golden fixture 的公开侧源;
 * - 每条红灯样例只做一次定向破坏,对应 WP-1 §12.6 规则或 Schema 结构面。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHALLENGE_PACKAGE_SCHEMA_VERSION,
  parsePublicDescriptorText,
  validatePublicDescriptor,
} from "../src/index.js";
import type { SchemaViolation, Validated } from "../src/common/validation.js";
import { parseJsonStrict } from "../src/internal/json-strict-parse.js";

const basicText = readFileSync(
  join(import.meta.dirname, "fixtures", "public-descriptor", "basic.json"),
  "utf8",
);

/** 显式构造 C0 控制字符,避免源码里出现不可见字符。 */
const BELL_CONTROL_CHAR = String.fromCharCode(0x07);

function parseFixture(): unknown {
  return parseJsonStrict(basicText);
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

/** 在 JSON 层面对 fixture 做定向破坏(绕开只读镜像类型的编辑限制)。 */
function breakFixture(edit: (clone: Record<string, unknown>) => void): unknown {
  const clone = JSON.parse(basicText) as Record<string, unknown>;
  edit(clone);
  return clone;
}

describe("公开描述包校验器", () => {
  it("合法公开描述包 fixture 通过校验并解析出强类型", () => {
    const descriptor = assertOk(validatePublicDescriptor(parseFixture()));

    expect(descriptor.schemaVersion).toBe(CHALLENGE_PACKAGE_SCHEMA_VERSION);
    expect(descriptor.challengeId).toBe("ret-basics");
    expect(descriptor.vmProfileVersion).toBe("1.0.0");
    expect(descriptor.vmProfile.canary.enabled).toBe(true);
    expect(descriptor.initialProjection.visibleRegions).toHaveLength(2);
    expect(descriptor.initialProjection.semanticHighlights).toHaveLength(3);
    expect(descriptor.vmProfile.registers.map((r) => r.name)).toContain("RIP");
  });

  it("未知顶层字段被拒绝(I-1:Schema 存在不等于可下发)", () => {
    const violations = assertFail(
      validatePublicDescriptor(breakFixture((clone) => {
        clone.secrets = { flag: "FLAG{leak}" };
      })),
    );

    expect(violations.some((v) => v.message.includes("secrets"))).toBe(true);
  });

  it("文本字段拒绝 C0/C1 控制字符(公开文本面加固)", () => {
    const violations = assertFail(
      validatePublicDescriptor(breakFixture((clone) => {
        clone.briefing = {
          ...(clone.briefing as Record<string, unknown>),
          title: `标题${BELL_CONTROL_CHAR}带控制字符`,
        };
      })),
    );

    expect(violations.some((v) => v.path.includes("/briefing/title"))).toBe(true);
  });

  it("vmProfile.registers 拒绝 FLAG 命名(XS-REG-FLAG 结构面)", () => {
    const violations = assertFail(
      validatePublicDescriptor(breakFixture((clone) => {
        clone.vmProfile = {
          ...(clone.vmProfile as Record<string, unknown>),
          registers: [{ name: "FLAG1" }],
        };
      })),
    );

    expect(violations.some((v) => v.path.startsWith("/vmProfile/registers"))).toBe(true);
  });

  it("初始投影寄存器值必须是大写 hex(公开输出面)", () => {
    const violations = assertFail(
      validatePublicDescriptor(breakFixture((clone) => {
        clone.initialProjection = {
          ...(clone.initialProjection as Record<string, unknown>),
          visibleRegisters: [{ name: "RSP", valueHex: "0x7ffffff8" }],
        };
      })),
    );

    expect(
      violations.some((v) => v.path.includes("/initialProjection/visibleRegisters")),
    ).toBe(true);
  });

  it("schemaVersion 只接受冻结常量 1", () => {
    const violations = assertFail(
      validatePublicDescriptor(breakFixture((clone) => {
        clone.schemaVersion = 2;
      })),
    );

    expect(violations.length).toBeGreaterThan(0);
  });

  it("canary.enabled = true 时 sizeBytes 必填(if/then)", () => {
    const violations = assertFail(
      validatePublicDescriptor(breakFixture((clone) => {
        clone.vmProfile = {
          ...(clone.vmProfile as Record<string, unknown>),
          canary: { enabled: true },
        };
      })),
    );

    expect(violations.some((v) => v.path.includes("/vmProfile/canary"))).toBe(true);
  });

  it("after_n_failures 提示必须携带 failureThreshold(if/then)", () => {
    const violations = assertFail(
      validatePublicDescriptor(breakFixture((clone) => {
        clone.hintLadder = [
          {
            order: 1,
            revealPolicy: "after_n_failures",
            hintText: "缺少 failureThreshold 的提示",
          },
        ];
      })),
    );

    expect(violations.some((v) => v.path.includes("/hintLadder"))).toBe(true);
  });

  it("allowedActions 只接受冻结动作枚举的子集", () => {
    const violations = assertFail(
      validatePublicDescriptor(breakFixture((clone) => {
        clone.allowedActions = ["write_bytes", "explode"];
      })),
    );

    expect(violations.some((v) => v.path.includes("/allowedActions"))).toBe(true);
  });
});

describe("公开描述包文本解析", () => {
  it("从 JSON 文本解析出强类型", () => {
    const descriptor = assertOk(parsePublicDescriptorText(basicText));

    expect(descriptor.challengeId).toBe("ret-basics");
  });

  it("拒绝重复键(XS-DUP-KEY,严格扫描器)", () => {
    const result = parsePublicDescriptorText('{"schemaVersion":1,"schemaVersion":1}');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.message).toContain("重复键");
    }
  });

  it("拒绝语法错误的 JSON 文本", () => {
    expect(parsePublicDescriptorText("{oops}").ok).toBe(false);
    expect(parsePublicDescriptorText('{"schemaVersion":1} trailing').ok).toBe(false);
  });
});

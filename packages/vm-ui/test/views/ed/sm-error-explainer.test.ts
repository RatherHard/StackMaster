/**
 * <sm-error-explainer> 组件测试(FE-ED-07):code/message 呈现、能力矩阵缺席
 * 形态(addressHex / explanation 缺席不渲染,null 同缺席)、explanation 子字段
 * 逐键"存在才渲染"、teachingNote 匹配与默认文案、空态。
 */
import { describe, expect, it } from "vitest";

import type { PublicError } from "@stackmaster/protocol";

import { DEFAULT_TEACHING_NOTE, type PublicErrorMapping } from "../../../src/ed/ed-types.js";

import type { SmErrorExplainer } from "../../../src/views/ed/sm-error-explainer.js";

import "../../../src/views/ed/sm-error-explainer.js";
import { queryAllShadow, queryShadow } from "./helpers.js";

const MAPPINGS: readonly PublicErrorMapping[] = [
  { errorCode: "permission_denied", teachingNote: "可写区域只有 stack;查 r/w/x 权限" },
  { errorCode: "inaccessible_address", teachingNote: "地址不可达:目标可能不在可见区域" },
];

function errorFixture(overrides: Partial<PublicError>): PublicError {
  return {
    code: "permission_denied",
    message: "区域 region-stack 不允许该写入",
    addressHex: "0x1008",
    explanation: { regionId: "region-stack", permissions: "rw", hints: ["检查写入目标"] },
    ...overrides,
  };
}

async function mounted(
  error: PublicError | null,
  mappings: readonly PublicErrorMapping[] = MAPPINGS,
): Promise<SmErrorExplainer> {
  const element = document.createElement("sm-error-explainer") as SmErrorExplainer;
  document.body.append(element);
  element.error = error;
  element.mappings = mappings;
  await element.updateComplete;
  return element;
}

describe("SmErrorExplainer 基本呈现(FE-ED-07)", () => {
  it("code 徽标 + message 呈现", async () => {
    const element = await mounted(errorFixture({}));
    expect(queryShadow(element, ".code-badge")?.textContent?.trim()).toBe("permission_denied");
    expect(queryShadow(element, ".message")?.textContent?.trim()).toBe("区域 region-stack 不允许该写入");
    element.remove();
  });

  it("addressHex 真实携带(required-real / free)→ 渲染地址行", async () => {
    const element = await mounted(errorFixture({}));
    expect(queryShadow(element, "dd.mono")?.textContent?.trim()).toBe("0x1008");
    element.remove();
  });

  it("teachingNote 按 errorCode 匹配;无匹配 → 默认教学文案", async () => {
    const matched = await mounted(errorFixture({}));
    expect(queryShadow(matched, ".teaching-note")?.textContent).toContain("查 r/w/x 权限");
    matched.remove();

    const unmatched = await mounted(errorFixture({ code: "objective_not_met", addressHex: undefined, explanation: undefined }));
    expect(queryShadow(unmatched, ".teaching-note")?.textContent).toContain(DEFAULT_TEACHING_NOTE);
    unmatched.remove();
  });

  it("error 为 null → 空态'当前没有错误'", async () => {
    const element = await mounted(null);
    expect(queryShadow(element, "section")).toBeNull();
    expect(queryShadow(element, "[role='status']")?.textContent).toContain("当前没有错误");
    element.remove();
  });
});

describe("SmErrorExplainer 能力矩阵缺席形态(FE-ED-07)", () => {
  it("addressHex 缺席(forbidden)与 null(null-only)同缺席:地址行不渲染", async () => {
    const forbidden = await mounted(errorFixture({ addressHex: undefined }));
    expect(forbidden.shadowRoot?.querySelectorAll("dl")).toHaveLength(1); // 只有 explanation 段
    forbidden.remove();

    const nullOnly = await mounted(
      errorFixture({
        code: "inaccessible_address",
        message: "目标地址不可达",
        addressHex: null,
        explanation: { valueHex: "0x40" },
      }),
    );
    expect(nullOnly.shadowRoot?.querySelectorAll("dl")).toHaveLength(1);
    expect(queryShadow(nullOnly, ".code-badge")?.textContent?.trim()).toBe("inaccessible_address");
    nullOnly.remove();
  });

  it("explanation 缺席(forbidden 码,零解释)→ 解释段不渲染,teachingNote 照呈", async () => {
    const element = await mounted(
      errorFixture({ code: "objective_not_met", addressHex: undefined, explanation: undefined }),
      [],
    );
    expect(element.shadowRoot?.querySelectorAll("dl")).toHaveLength(0);
    expect(queryShadow(element, ".teaching-note")?.textContent).toContain(DEFAULT_TEACHING_NOTE);
    element.remove();
  });

  it("explanation 子字段逐键'存在才渲染'(满解释形态全量呈现)", async () => {
    const element = await mounted(
      errorFixture({
        code: "invalid_rip",
        addressHex: null,
        message: "非法 RIP",
        explanation: {
          regionId: "region-code",
          permissions: "rx",
          valueHex: "0xdead",
          interpretedAs: "little_endian_qword",
          alignmentBytes: 4,
          expectedBytesLength: 8,
          actualBytesLength: 2,
          hints: ["小端解释", "检查 RSP 对齐"],
        },
      }),
      [],
    );
    const dts = queryAllShadow(element, "dt").map((dt) => dt.textContent?.trim());
    expect(dts).toEqual(["区域", "区域权限", "涉及的值", "值被解释为", "对齐要求", "期望长度", "实际长度", "提示"]);
    const monoValues = queryAllShadow(element, "dd.mono").map((dd) => dd.textContent?.trim());
    expect(monoValues).toContain("0xDEAD");
    expect(monoValues).toContain("little_endian_qword");
    expect(queryAllShadow(element, ".hint-list li")).toHaveLength(2);
    element.remove();
  });

  it("部分解释形态:仅存在的子字段渲染(hints 缺席 → 无提示行)", async () => {
    const element = await mounted(
      errorFixture({
        code: "offset_out_of_range",
        message: "写入越过可见边界",
        addressHex: "0x1ff0",
        explanation: { expectedBytesLength: 8, actualBytesLength: 16 },
      }),
      [],
    );
    const dts = queryAllShadow(element, "dt").map((dt) => dt.textContent?.trim());
    expect(dts).toEqual(["地址", "期望长度", "实际长度"]);
    element.remove();
  });
});

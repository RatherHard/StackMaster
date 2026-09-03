/**
 * PublicStateProjection 契约测试(WP-3;字段集合 WP-1 §4.1 冻结)。
 *
 * 重点断言:I-1 字段白名单(含 VmState 标识符篡改形态,ZR-B9 红灯语料)、
 * PublicStatus 不含 rejected(D1)、寄存器值大写形态(WP-1 §4.2)、
 * 权限规范序、presence-only truncated 标记(显式 false 即拒绝)。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CALL_STACK_MAX_DEPTH,
  PublicStateProjectionSchema,
  PublicValueHex64Schema,
  RegisterNameSchema,
} from "../src/index.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "public-state-projection");

interface FixtureCase {
  readonly name: string;
  readonly payload: unknown;
}

function loadFixtures(kind: "valid" | "invalid"): readonly FixtureCase[] {
  const dir = join(FIXTURE_DIR, kind);
  return readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => ({
      name: fileName,
      payload: JSON.parse(readFileSync(join(dir, fileName), "utf8")) as unknown,
    }));
}

function baseProjection(): Record<string, unknown> {
  return {
    revision: 0,
    visibleRegions: [],
    visibleRegisters: [],
    callStackSummary: [],
    controlFlow: {
      currentInstruction: { addressHex: "0x401000", text: "push rbp" },
      pausedOn: null,
    },
    semanticHighlights: [],
    status: "running",
  };
}

describe("PublicStateProjection 契约(WP-3)", () => {
  it.each(loadFixtures("valid"))("接受典型样例 $name", ({ payload }) => {
    const result = PublicStateProjectionSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it.each(loadFixtures("invalid"))("拒绝非法样例 $name", ({ payload }) => {
    const result = PublicStateProjectionSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("拒绝 7 个冻结字段之外的新增字段(WP-1 §4.1,I-1)", () => {
    const result = PublicStateProjectionSchema.safeParse({
      ...baseProjection(),
      progressHint: "已接近目标",
    });
    expect(result.success).toBe(false);
  });

  it("拒绝超过调用栈深度上限(64,D2)的摘要", () => {
    const frames = Array.from({ length: CALL_STACK_MAX_DEPTH + 1 }, (_, index) => ({
      index,
      functionLabel: `frame_${index}`,
      returnAddressHex: "0x401000",
    }));
    const result = PublicStateProjectionSchema.safeParse({
      ...baseProjection(),
      callStackSummary: frames,
    });
    expect(result.success).toBe(false);
  });

  it("接受恰好达到调用栈深度上限(64)的摘要,且带截断标记的最后一帧合法", () => {
    const frames = Array.from({ length: CALL_STACK_MAX_DEPTH }, (_, index) => ({
      index,
      functionLabel: `frame_${index}`,
      returnAddressHex: "0x401000",
      ...(index === CALL_STACK_MAX_DEPTH - 1 ? { truncated: true } : {}),
    }));
    const result = PublicStateProjectionSchema.safeParse({
      ...baseProjection(),
      callStackSummary: frames,
    });
    expect(result.success).toBe(true);
  });

  it("寄存器值必须是大写十六进制(WP-1 §4.2 规范化输出面)", () => {
    expect(PublicValueHex64Schema.safeParse("0x7FFF00F8").success).toBe(true);
    expect(PublicValueHex64Schema.safeParse("0x7fff00f8").success).toBe(false);
    expect(PublicValueHex64Schema.safeParse("0x7FFF00F8090A0B0C0D").success).toBe(false);
  });

  it("寄存器名称形态宽松(允许题目 VM Profile 扩展),非法字符拒绝", () => {
    expect(RegisterNameSchema.safeParse("RSP").success).toBe(true);
    expect(RegisterNameSchema.safeParse("R12").success).toBe(true);
    expect(RegisterNameSchema.safeParse("flag_carry").success).toBe(true);
    expect(RegisterNameSchema.safeParse("author_custom_reg_name").success).toBe(true);
    expect(RegisterNameSchema.safeParse("1AX").success).toBe(false);
    expect(RegisterNameSchema.safeParse("R SP").success).toBe(false);
    expect(RegisterNameSchema.safeParse("R".repeat(33)).success).toBe(false);
  });

  it("permissions 只接受 r/w/x 非空规范序子集", () => {
    const region = (permissions: string): unknown => ({
      ...baseProjection(),
      visibleRegions: [
        {
          regionId: "r1",
          label: "栈",
          startAddressHex: "0x1000",
          byteLength: 64,
          permissions,
          bytesHex: "00",
          truncated: false,
        },
      ],
    });
    expect(PublicStateProjectionSchema.safeParse(region("rwx")).success).toBe(true);
    expect(PublicStateProjectionSchema.safeParse(region("rx")).success).toBe(true);
    expect(PublicStateProjectionSchema.safeParse(region("r")).success).toBe(true);
    expect(PublicStateProjectionSchema.safeParse(region("wr")).success).toBe(false);
    expect(PublicStateProjectionSchema.safeParse(region("")).success).toBe(false);
    expect(PublicStateProjectionSchema.safeParse(region("rwxs")).success).toBe(false);
  });
});

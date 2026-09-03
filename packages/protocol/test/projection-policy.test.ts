/**
 * ProjectionPolicy 契约测试(WP-3;字段集合 WP-1 §4.5 冻结)。
 *
 * 注意:本 Schema 属于服务端专用面(src/server-only),按 WP-1 §五 仅供
 * challenge-compiler / session-api / verifier 依赖;此处从 server-only
 * 子路径导入,正是边界规则所允许的消费方式。
 *
 * 重点断言:I-1 白名单(禁止 hiddenRegions 等"补集泄露"形态字段)、
 * maxBytesPerRange 协议上限(4096,默认 256 由服务端策略自选)、
 * errorDetailLevel 二值枚举、寄存器名称形态。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_BYTES_PER_RANGE_DEFAULT, MAX_BYTES_PER_RANGE_MAX } from "../src/index.js";
import { ProjectionPolicySchema } from "../src/server-only/index.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "projection-policy");

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

function basePolicy(): Record<string, unknown> {
  return {
    visibleRegions: ["stack-main"],
    visibleObjects: ["obj-input-buffer"],
    visibleRegisters: ["RSP", "RBP"],
    maxBytesPerRange: MAX_BYTES_PER_RANGE_DEFAULT,
    errorDetailLevel: "educational",
  };
}

describe("ProjectionPolicy 契约(WP-3,服务端专用)", () => {
  it.each(loadFixtures("valid"))("接受典型样例 $name", ({ payload }) => {
    const result = ProjectionPolicySchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it.each(loadFixtures("invalid"))("拒绝非法样例 $name", ({ payload }) => {
    const result = ProjectionPolicySchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("拒绝 5 个冻结字段之外的字段(hiddenRegions 属补集泄露形态,I-1)", () => {
    const result = ProjectionPolicySchema.safeParse({
      ...basePolicy(),
      hiddenRegions: ["canary-slot"],
    });
    expect(result.success).toBe(false);
  });

  it(`maxBytesPerRange 上限为协议上限 ${MAX_BYTES_PER_RANGE_MAX},默认值 ${MAX_BYTES_PER_RANGE_DEFAULT} 只是服务端策略取值`, () => {
    expect(
      ProjectionPolicySchema.safeParse({
        ...basePolicy(),
        maxBytesPerRange: MAX_BYTES_PER_RANGE_MAX,
      }).success,
    ).toBe(true);
    expect(
      ProjectionPolicySchema.safeParse({
        ...basePolicy(),
        maxBytesPerRange: MAX_BYTES_PER_RANGE_MAX + 1,
      }).success,
    ).toBe(false);
  });

  it("errorDetailLevel 只有 coarse / educational 两档", () => {
    expect(
      ProjectionPolicySchema.safeParse({ ...basePolicy(), errorDetailLevel: "verbose" }).success,
    ).toBe(false);
    expect(
      ProjectionPolicySchema.safeParse({ ...basePolicy(), errorDetailLevel: "coarse" }).success,
    ).toBe(true);
  });

  it("空白名单合法:全隐藏投影(verifier 场景)也能表达", () => {
    const result = ProjectionPolicySchema.safeParse({
      visibleRegions: [],
      visibleObjects: [],
      visibleRegisters: [],
      maxBytesPerRange: 64,
      errorDetailLevel: "coarse",
    });
    expect(result.success).toBe(true);
  });
});

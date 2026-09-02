/**
 * VerdictResult 契约测试(11 种稳定结果类型,计划书 9.1)。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VerdictResultSchema } from "../src/index.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "verdict-result");

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

describe("VerdictResult 契约(11 种稳定结果类型,计划书 9.1)", () => {
  it("枚举恰好包含 11 种冻结结果类型", () => {
    expect(VerdictResultSchema.options).toHaveLength(11);
  });

  it.each(VerdictResultSchema.options)("接受结果类型 %s", (value) => {
    expect(VerdictResultSchema.safeParse(value).success).toBe(true);
  });

  it.each(loadFixtures("invalid"))("拒绝非法样例 $name", ({ payload }) => {
    expect(VerdictResultSchema.safeParse(payload).success).toBe(false);
  });

  it("值精确匹配:大写 SUCCESS 不被接受(枚举大小写敏感)", () => {
    expect(VerdictResultSchema.safeParse("SUCCESS").success).toBe(false);
  });
});

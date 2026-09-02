/**
 * ActionRequest 契约测试(WP-2 完成标准:典型与非法样例均被正确接受 / 拒绝)。
 *
 * 样例来自 test/fixtures/action-request/,同样作为 WP-6 golden fixture 的
 * 增量来源;非法样例覆盖:未知动作、未知字段(I-1 / ZR-T2 篡改形态)、
 * 坏 hex、超限写入、错误协议版本、非法序号等。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ZodLiteral } from "zod";
import {
  ActionObjectSchema,
  ActionRequestSchema,
  SESSION_ACTION_TYPES,
  type SessionActionType,
} from "../src/index.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "action-request");

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

describe("ActionRequest 契约(WP-2)", () => {
  it.each(loadFixtures("valid"))("接受典型样例 $name", ({ payload }) => {
    const result = ActionRequestSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it.each(loadFixtures("invalid"))("拒绝非法样例 $name", ({ payload }) => {
    const result = ActionRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("动作判别联合恰好覆盖 12 种冻结动作类型", () => {
    expect(ActionObjectSchema.options).toHaveLength(SESSION_ACTION_TYPES.length);
    const unionTypes = ActionObjectSchema.options.map(
      (option) => (option.shape.type as ZodLiteral<SessionActionType>).value,
    );
    expect([...unionTypes].sort()).toEqual([...SESSION_ACTION_TYPES].sort());
  });

  it("合法样例两两动作类型不同,合计覆盖全部 12 种动作", () => {
    const coveredTypes = loadFixtures("valid").map(
      (fixture) => ActionRequestSchema.parse(fixture.payload).action.type,
    );
    expect(new Set(coveredTypes).size).toBe(SESSION_ACTION_TYPES.length);
  });
});

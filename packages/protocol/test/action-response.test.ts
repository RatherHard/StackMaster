/**
 * ActionResponse 契约测试(信封为 WP-2 冻结面;载荷字段当前为 WP-3 前置声明)。
 *
 * 重点断言:未知字段拒绝(ZR-P1 / I-1,含 VmState 序列化篡改形态)、
 * 每动作公开事件上限(D4)、projectionDelta 必填(无变化用 null 表达)。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActionResponseSchema, MAX_PUBLIC_EVENTS_PER_ACTION } from "../src/index.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "action-response");

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

describe("ActionResponse 契约(WP-2)", () => {
  it.each(loadFixtures("valid"))("接受典型样例 $name", ({ payload }) => {
    const result = ActionResponseSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it.each(loadFixtures("invalid"))("拒绝非法样例 $name", ({ payload }) => {
    const result = ActionResponseSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("拒绝超过每动作公开事件上限(256,D4)的响应", () => {
    const overflowingEvents = Array.from(
      { length: MAX_PUBLIC_EVENTS_PER_ACTION + 1 },
      (_, seq) => ({ seq, kind: "write" as const }),
    );
    const result = ActionResponseSchema.safeParse({
      requestId: "r-overflow",
      revision: 1,
      status: "running",
      projectionDelta: null,
      publicEvents: overflowingEvents,
    });
    expect(result.success).toBe(false);
  });

  it("接受恰好达到公开事件上限(256)的响应", () => {
    const boundaryEvents = Array.from({ length: MAX_PUBLIC_EVENTS_PER_ACTION }, (_, seq) => ({
      seq,
      kind: "write" as const,
    }));
    const result = ActionResponseSchema.safeParse({
      requestId: "r-boundary",
      revision: 1,
      status: "running",
      projectionDelta: { revision: 1 },
      publicEvents: boundaryEvents,
    });
    expect(result.success).toBe(true);
  });

  it("projectionDelta 必填:拒绝缺少该字段的响应(无变化时用 null 表达)", () => {
    const result = ActionResponseSchema.safeParse({
      requestId: "r-missing-delta",
      revision: 0,
      status: "rejected",
      publicEvents: [],
    });
    expect(result.success).toBe(false);
  });

  it("接受无错误的 paused 响应(userVisibleError 可选)", () => {
    const result = ActionResponseSchema.safeParse({
      requestId: "r-paused",
      revision: 1,
      status: "paused",
      projectionDelta: { revision: 1 },
      publicEvents: [],
    });
    expect(result.success).toBe(true);
  });
});

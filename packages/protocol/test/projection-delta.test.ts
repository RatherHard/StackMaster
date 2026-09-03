/**
 * ProjectionDelta 契约测试(WP-3;字段集合 WP-1 §4.3 冻结)。
 *
 * 重点断言:必填数组字段(dirtyRanges / changedRegisters,空数组表达"无变化")、
 * 单 revision 字节总预算(D3:8192,超限增量在契约层拒绝)、
 * presence-only truncated 标记、可选字段整体替换语义。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_BYTES_PER_RANGE_MAX,
  MAX_PROJECTION_BYTES_PER_REVISION,
  ProjectionDeltaSchema,
} from "../src/index.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "projection-delta");

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

function rangeWithBytes(bytes: number): Record<string, unknown> {
  return {
    regionId: "stack-main",
    startAddressHex: "0x7FFF0000",
    bytesHex: "41".repeat(bytes),
  };
}

describe("ProjectionDelta 契约(WP-3)", () => {
  it.each(loadFixtures("valid"))("接受典型样例 $name", ({ payload }) => {
    const result = ProjectionDeltaSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it.each(loadFixtures("invalid"))("拒绝非法样例 $name", ({ payload }) => {
    const result = ProjectionDeltaSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("空增量(无内存写入、无寄存器变化)合法:必填数组以空数组表达", () => {
    const result = ProjectionDeltaSchema.safeParse({
      revision: 7,
      dirtyRanges: [],
      changedRegisters: [],
    });
    expect(result.success).toBe(true);
  });

  it(`dirtyRanges 字节总数恰达预算上限(${MAX_PROJECTION_BYTES_PER_REVISION})合法`, () => {
    const perRange = MAX_PROJECTION_BYTES_PER_REVISION / 2;
    const result = ProjectionDeltaSchema.safeParse({
      revision: 8,
      dirtyRanges: [rangeWithBytes(perRange), rangeWithBytes(perRange)],
      changedRegisters: [],
    });
    expect(result.success).toBe(true);
  });

  it(`dirtyRanges 字节总数超预算 1 字节即拒绝(D3:${MAX_PROJECTION_BYTES_PER_REVISION})`, () => {
    const perRange = MAX_PROJECTION_BYTES_PER_REVISION / 2;
    const result = ProjectionDeltaSchema.safeParse({
      revision: 8,
      dirtyRanges: [rangeWithBytes(perRange), rangeWithBytes(perRange), rangeWithBytes(1)],
      changedRegisters: [],
    });
    expect(result.success).toBe(false);
  });

  it(`单 range 字节数受协议上限(${MAX_BYTES_PER_RANGE_MAX})约束,生效上限由策略收紧`, () => {
    const result = ProjectionDeltaSchema.safeParse({
      revision: 8,
      dirtyRanges: [rangeWithBytes(MAX_BYTES_PER_RANGE_MAX)],
      changedRegisters: [],
    });
    expect(result.success).toBe(true);
    const over = ProjectionDeltaSchema.safeParse({
      revision: 8,
      dirtyRanges: [rangeWithBytes(MAX_BYTES_PER_RANGE_MAX + 1)],
      changedRegisters: [],
    });
    expect(over.success).toBe(false);
  });

  it("truncated 标记 presence-only:显式 false 拒绝", () => {
    const result = ProjectionDeltaSchema.safeParse({
      revision: 9,
      dirtyRanges: [
        { regionId: "stack-main", startAddressHex: "0x7FFF0000", bytesHex: "41", truncated: false },
      ],
      changedRegisters: [],
    });
    expect(result.success).toBe(false);
  });
});

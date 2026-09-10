/**
 * DebugVariantBundle 契约测试(阶段四 WP-40:调试变体镜像进程间契约的可测面;
 * 调试通道协议语义文档 §七,WP-1 清单 §6.9)。
 *
 * 红灯样例覆盖:结构性排除面(变体含 judgingConfig / seed 字段必须拒,
 * ADR-DC1 条款 5)、algorithmId 不符(封闭字面量)、区域内容奇数 hex、
 * 三条跨字段耦合(ASLR ⇄ baseAddresses / draws 下限 / canary 可见性,
 * superRefine + 生成管线 if/then 双侧承载)、寄存器空集、引擎协议版本漂移。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEBUG_VARIANT_BUNDLE_SCHEMA_VERSION,
  DEBUG_VARIANT_SEED_ALGORITHM_ID,
  DebugVariantBundleSchema,
} from "../src/debug/debug-variant-bundle.js";
import { ENGINE_PROCESS_PROTOCOL_VERSION } from "../src/version.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "debug-variant-bundle");

interface FixtureCase {
  readonly name: string;
  readonly payload: Record<string, unknown>;
}

function loadFixtures(kind: "valid" | "invalid"): readonly FixtureCase[] {
  const dir = join(FIXTURE_DIR, kind);
  return readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => ({
      name: fileName,
      payload: JSON.parse(readFileSync(join(dir, fileName), "utf8")) as Record<string, unknown>,
    }));
}

describe("DebugVariantBundle 契约(阶段四 WP-40)", () => {
  it.each(loadFixtures("valid"))("接受典型样例 $name", ({ payload }) => {
    expect(DebugVariantBundleSchema.safeParse(payload).success).toBe(true);
  });

  it.each(loadFixtures("invalid"))("拒绝非法样例 $name", ({ payload }) => {
    expect(DebugVariantBundleSchema.safeParse(payload).success).toBe(false);
  });

  it("冻结字面量:派生算法标识与 vm-core seed.rs SEED_ALGORITHM_ID 同字面量(重复冻结,不依赖 vm-engine)", () => {
    expect(DEBUG_VARIANT_SEED_ALGORITHM_ID).toBe("splitmix64-stream-v1");
    expect(DEBUG_VARIANT_BUNDLE_SCHEMA_VERSION).toBe(1);
  });

  it("引擎进程协议版本复用既有常量字面量(零新版本号)", () => {
    const valid = loadFixtures("valid")[0]!.payload;
    const mutated = {
      ...valid,
      engineProcessProtocolVersion: ENGINE_PROCESS_PROTOCOL_VERSION + 1,
    };
    expect(DebugVariantBundleSchema.safeParse(mutated).success).toBe(false);
  });

  it("结构性排除面(ADR-DC1 条款 5):judgingConfig / 隐藏测试 / seed 值字段不可表达", () => {
    const valid = loadFixtures("valid")[0]!.payload;
    for (const forbiddenKey of [
      "judgingConfig",
      "judging",
      "hiddenTests",
      "seed",
      "seedHex",
      "seedPolicy",
    ]) {
      const mutated = { ...valid, [forbiddenKey]: { probe: true } };
      expect(DebugVariantBundleSchema.safeParse(mutated).success).toBe(false);
    }
  });

  it("整体 server-only:本 Schema 不经包入口导出(浏览器永不可见,WP-1 清单 §6.9)", async () => {
    const entry = await import("../src/index.js");
    expect((entry as Record<string, unknown>).DebugVariantBundleSchema).toBeUndefined();
  });
});

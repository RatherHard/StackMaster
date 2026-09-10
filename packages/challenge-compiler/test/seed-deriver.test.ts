/**
 * SeedDeriver TS 移植测试(WP-42;判题语义规约 §六 D-J7)。
 *
 * 跨语言一致性以黄金向量锁死:消费 `test/golden/seed-derivation-vectors.json`
 * (32 条 draw 向量 + 6 条 ASLR 基址样例),与 Rust 对偶测试
 * `vm-engine/vm-worker/tests/seed_derivation_conformance.rs` 读同一文件,
 * 断言 vm-core 权威实现与 TS 移植对同一种子同序数派生同值。
 * 向量值本身经独立三方实现(Python)验证后落盘。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DerivationPathSummary } from "../src/index.js";
import {
  MAX_SEED_BYTES,
  MIN_SEED_BYTES,
  SEED_ALGORITHM_ID,
  SeedDeriver,
} from "../src/index.js";

interface GoldenVectorFile {
  readonly algorithmId: string;
  readonly drawVectors: readonly {
    readonly seedHex: string;
    readonly draw: number;
    readonly expectedU64Decimal: string;
    readonly expectedU64Hex: string;
  }[];
  readonly baseAddressVectors: readonly {
    readonly name: string;
    readonly seedHex: string;
    readonly archBits: number;
    readonly pageSizeBytes: number;
    readonly structuralSpanBytes: number;
    readonly firstDrawU64Hex: string;
    readonly expectedBaseAddressHex: string;
  }[];
}

const GOLDEN = JSON.parse(
  readFileSync(new URL("./golden/seed-derivation-vectors.json", import.meta.url), "utf8"),
) as GoldenVectorFile;

/** 第 k 次(k 自 1 起)抽取值。 */
function drawK(seedHex: string, k: number): bigint {
  const deriver = SeedDeriver.fromHex(seedHex);
  let value = 0n;
  for (let index = 0; index < k; index += 1) {
    value = deriver.nextU64();
  }
  return value;
}

describe("SeedDeriver(splitmix64-stream-v1)黄金向量一致性", () => {
  it("向量集非空且算法标识与常量镜像一致", () => {
    expect(GOLDEN.algorithmId).toBe(SEED_ALGORITHM_ID);
    expect(GOLDEN.drawVectors.length).toBeGreaterThanOrEqual(20);
    expect(GOLDEN.baseAddressVectors.length).toBeGreaterThanOrEqual(1);
    expect(MIN_SEED_BYTES).toBe(8);
    expect(MAX_SEED_BYTES).toBe(32);
  });

  it("每条 draw 向量:同种子同序数派生同值(十进制与 hex 双写断言)", () => {
    for (const vector of GOLDEN.drawVectors) {
      const value = drawK(vector.seedHex, vector.draw);
      expect(value.toString(10)).toBe(vector.expectedU64Decimal);
      expect(`0x${value.toString(16)}`).toBe(vector.expectedU64Hex);
    }
  });

  it("种子长度边界向量在列(8 / 32 字节)", () => {
    const lengths = new Set(GOLDEN.drawVectors.map((vector) => vector.seedHex.length / 2));
    expect(lengths.has(MIN_SEED_BYTES)).toBe(true);
    expect(lengths.has(MAX_SEED_BYTES)).toBe(true);
  });

  it("派生计数与摘要(不含种子值)", () => {
    const deriver = SeedDeriver.fromHex("deadbeef01020304");
    expect(deriver.draws()).toBe(0);
    deriver.nextU64();
    deriver.nextU64();
    const summary: DerivationPathSummary = deriver.summary();
    expect(summary.algorithmId).toBe(SEED_ALGORITHM_ID);
    expect(summary.draws).toBe(2);
  });

  it("同种子同序列、异种子异序列(13.1 属性的直测锚)", () => {
    const seedHex = "deadbeef01020304";
    const a = SeedDeriver.fromHex(seedHex);
    const b = SeedDeriver.fromHex(seedHex);
    const streamA = Array.from({ length: 64 }, () => a.nextU64());
    const streamB = Array.from({ length: 64 }, () => b.nextU64());
    expect(streamB).toEqual(streamA);
    const c = SeedDeriver.fromHex("0000000000000000");
    const streamC = Array.from({ length: 64 }, () => c.nextU64());
    expect(streamC).not.toEqual(streamA);
  });
});

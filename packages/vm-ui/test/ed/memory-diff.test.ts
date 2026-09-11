/**
 * computeByteDiff 纯函数测试(FE-ED-03):
 * 归并语义(跨 dirtyRange 同地址以后者为准 / 前后相同剔除)、窗口外与未知
 * 区域前值不可知、before 缺省、地址升序与小写归一化。
 */
import { describe, expect, it } from "vitest";

import type { DirtyRange, VisibleMemoryRegion } from "@stackmaster/protocol";

import { computeByteDiff } from "../../src/ed/memory-diff.js";

/** 前快照:region-stack 起点 0x1000,窗口前缀 16 字节(00..0f 递增)。 */
function beforeRegionsFixture(): VisibleMemoryRegion[] {
  return [
    {
      regionId: "region-stack",
      label: "stack",
      startAddressHex: "0x1000",
      byteLength: 4096,
      permissions: "rw",
      bytesHex: "000102030405060708090a0b0c0d0e0f",
      truncated: true,
    },
    {
      regionId: "region-data",
      label: "data",
      startAddressHex: "0x9000",
      byteLength: 256,
      permissions: "rw",
      bytesHex: "ff",
      truncated: false,
    },
  ];
}

function dirtyRange(overrides: Partial<DirtyRange>): DirtyRange {
  return {
    regionId: "region-stack",
    startAddressHex: "0x1002",
    bytesHex: "aabb",
    ...overrides,
  };
}

describe("computeByteDiff 基本对照", () => {
  it("单 range:逐字节给出 前值 → 后值,地址 0x 小写归一化", () => {
    const units = computeByteDiff(beforeRegionsFixture(), [
      dirtyRange({ startAddressHex: "0x1002", bytesHex: "AABB" }),
    ]);
    expect(units).toEqual([
      { regionId: "region-stack", addressHex: "0x1002", beforeByteHex: "02", afterByteHex: "aa" },
      { regionId: "region-stack", addressHex: "0x1003", beforeByteHex: "03", afterByteHex: "bb" },
    ]);
  });

  it("前值与后值相同的字节不是变化,不进变更列表", () => {
    const units = computeByteDiff(beforeRegionsFixture(), [
      dirtyRange({ startAddressHex: "0x1000", bytesHex: "00ff" }), // 00 不变、ff 变化
    ]);
    expect(units).toEqual([
      { regionId: "region-stack", addressHex: "0x1001", beforeByteHex: "01", afterByteHex: "ff" },
    ]);
  });
});

describe("computeByteDiff 归并语义", () => {
  it("跨 dirtyRange:同地址以后出现的 range 为准(数组序)", () => {
    const units = computeByteDiff(beforeRegionsFixture(), [
      dirtyRange({ startAddressHex: "0x1002", bytesHex: "aabb" }),
      dirtyRange({ startAddressHex: "0x1003", bytesHex: "ccdd" }), // 0x1003 重写
    ]);
    expect(units).toEqual([
      { regionId: "region-stack", addressHex: "0x1002", beforeByteHex: "02", afterByteHex: "aa" },
      { regionId: "region-stack", addressHex: "0x1003", beforeByteHex: "03", afterByteHex: "cc" },
      { regionId: "region-stack", addressHex: "0x1004", beforeByteHex: "04", afterByteHex: "dd" },
    ]);
  });

  it("重写回原值:净变化为零的字节被剔除(写入 ≠ 内容变化)", () => {
    const units = computeByteDiff(beforeRegionsFixture(), [
      dirtyRange({ startAddressHex: "0x1002", bytesHex: "ffee" }),
      dirtyRange({ startAddressHex: "0x1002", bytesHex: "02ee" }), // 0x1002 写回原值 02
    ]);
    expect(units).toEqual([
      { regionId: "region-stack", addressHex: "0x1003", beforeByteHex: "03", afterByteHex: "ee" },
    ]);
  });

  it("输出按地址数值升序(跨 range 归并后)", () => {
    const units = computeByteDiff(beforeRegionsFixture(), [
      dirtyRange({ startAddressHex: "0x1008", bytesHex: "11" }),
      dirtyRange({ startAddressHex: "0x1002", bytesHex: "22" }),
    ]);
    expect(units.map((unit) => unit.addressHex)).toEqual(["0x1002", "0x1008"]);
  });
});

describe("computeByteDiff 前值缺失边界", () => {
  it("前值越出已下发窗口(区域起点前缀之外)→ 前值不可知(null),后值照呈", () => {
    const units = computeByteDiff(beforeRegionsFixture(), [
      dirtyRange({ startAddressHex: "0x100f", bytesHex: "aa" }), // 窗口 16 字节,0x100f 是窗口内
      dirtyRange({ startAddressHex: "0x1010", bytesHex: "bb" }), // 窗口外
    ]);
    expect(units).toEqual([
      { regionId: "region-stack", addressHex: "0x100f", beforeByteHex: "0f", afterByteHex: "aa" },
      { regionId: "region-stack", addressHex: "0x1010", beforeByteHex: null, afterByteHex: "bb" },
    ]);
  });

  it("range 引用未知区域 → 该 range 全部前值不可知", () => {
    const units = computeByteDiff(beforeRegionsFixture(), [
      dirtyRange({ regionId: "region-unknown", startAddressHex: "0x2000", bytesHex: "aa" }),
    ]);
    expect(units).toEqual([
      { regionId: "region-unknown", addressHex: "0x2000", beforeByteHex: null, afterByteHex: "aa" },
    ]);
  });

  it("range 起点在区域起点之前(防御)→ 前值不可知,不误读负偏移", () => {
    const units = computeByteDiff(beforeRegionsFixture(), [
      dirtyRange({ startAddressHex: "0xfff", bytesHex: "aa" }),
    ]);
    expect(units).toEqual([
      { regionId: "region-stack", addressHex: "0xfff", beforeByteHex: null, afterByteHex: "aa" },
    ]);
  });

  it("before 快照缺省(如首个动作前)→ 全部前值不可知", () => {
    const units = computeByteDiff(undefined, [dirtyRange({ startAddressHex: "0x1002", bytesHex: "aa" })]);
    expect(units).toEqual([
      { regionId: "region-stack", addressHex: "0x1002", beforeByteHex: null, afterByteHex: "aa" },
    ]);
  });

  it("dirtyRanges 为空 → 空变更列表(无内存写入的动作)", () => {
    expect(computeByteDiff(beforeRegionsFixture(), [])).toEqual([]);
  });
});

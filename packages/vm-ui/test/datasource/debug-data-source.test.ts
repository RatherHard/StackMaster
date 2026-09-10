/**
 * DebugDataSource 占位骨架测试(WP-F2):类存在、构造签名、方法体一律抛
 * "调试档由 WP-F8 填充"(禁止占位实现伪造全量语义)。
 */
import { describe, expect, it } from "vitest";

import { DebugDataSource } from "../../src/datasource/debug-data-source.js";
import type { MemoryDataSource } from "../../src/datasource/types.js";

describe("DebugDataSource 占位骨架(WP-F8 前置)", () => {
  it("构造签名可实例化(缺省与显式选项两形态)", () => {
    expect(new DebugDataSource()).toBeInstanceOf(DebugDataSource);
    expect(new DebugDataSource({ debugChannelUrl: "wss://host/sessions/debug-channel" }).options).toEqual({
      debugChannelUrl: "wss://host/sessions/debug-channel",
    });
  });

  it("全部接口方法抛『调试档由 WP-F8 填充』", () => {
    const source: MemoryDataSource = new DebugDataSource();
    expect(() => source.regions()).toThrow("调试档由 WP-F8 填充");
    expect(() => source.registers()).toThrow("调试档由 WP-F8 填充");
    expect(() => source.bytesRows({ startAddressHex: "0x0", endAddressHex: "0x8" })).toThrow(
      "调试档由 WP-F8 填充",
    );
    expect(() => source.search({ patternHex: "00" })).toThrow("调试档由 WP-F8 填充");
  });

  it("instructionStream 存在(调试档独有;公开档 undefined)", () => {
    const source = new DebugDataSource();
    expect(typeof source.instructionStream).toBe("function");
    expect(() =>
      source.instructionStream({ startAddressHex: "0x0", endAddressHex: "0x8" }),
    ).toThrow("调试档由 WP-F8 填充");
  });
});

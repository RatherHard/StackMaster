/**
 * render/hex 渲染原语测试(WP-F2):bytesHex 小写归一化与分组格式化、
 * valueHex 恒 0x + 大写、地址解析与展示格式化。
 */
import { describe, expect, it } from "vitest";

import {
  addressToHex,
  bytesHexToBytes,
  bytesToBytesHex,
  formatAddressHex,
  formatBytesHexGrouped,
  normalizeBytesHex,
  normalizeValueHex,
  parseAddressHex,
} from "../../src/render/hex.js";

describe("bytesHex 归一化(小写、偶数长度)", () => {
  it("大写输入归一化为小写,非法形态(奇数长度 / 非十六进制)抛错", () => {
    expect(normalizeBytesHex("AABB0C")).toBe("aabb0c");
    expect(normalizeBytesHex("00")).toBe("00");
    expect(() => normalizeBytesHex("abc")).toThrow(); // 奇数长度。
    expect(() => normalizeBytesHex("zz")).toThrow(); // 非十六进制。
    expect(() => normalizeBytesHex("")).toThrow(); // 空串非字节序列。
  });

  it("bytesHex ↔ 字节数组互转", () => {
    expect(Array.from(bytesHexToBytes("0aFF10"))).toEqual([0x0a, 0xff, 0x10]);
    expect(bytesToBytesHex([0x0a, 0xff, 0x10])).toBe("0aff10");
  });

  it("分组格式化:组间空格分隔、组内字节连续", () => {
    expect(formatBytesHexGrouped("aabbccddeeff0011", 2)).toBe("aabb ccdd eeff 0011");
    expect(formatBytesHexGrouped("AABBCC", 1)).toBe("aa bb cc");
    expect(formatBytesHexGrouped("aabbccdd", 4)).toBe("aabbccdd");
    expect(() => formatBytesHexGrouped("aabb", 0)).toThrow();
  });
});

describe("valueHex 契约归一化(恒 0x + 大写)", () => {
  it("小写 / 无前缀输入归一化为 0x + 大写,1-16 位约束", () => {
    expect(normalizeValueHex("0xdeadbeef")).toBe("0xDEADBEEF");
    expect(normalizeValueHex("0xbff8")).toBe("0xBFF8");
    expect(normalizeValueHex("bff8")).toBe("0xBFF8");
    expect(normalizeValueHex("0XFFFFFFFFFFFFFFFF")).toBe("0xFFFFFFFFFFFFFFFF");
    expect(() => normalizeValueHex("0x")).toThrow(); // 零位数字。
    expect(() => normalizeValueHex("0x0123456789abcdef0")).toThrow(); // 17 位。
    expect(() => normalizeValueHex("0xg")).toThrow();
  });
});

describe("地址解析与展示格式化(0x + 小写)", () => {
  it("解析大小写形态为 bigint,往返一致", () => {
    expect(parseAddressHex("0x1000")).toBe(0x1000n);
    expect(parseAddressHex("0XABCD")).toBe(0xabcdn);
    expect(addressToHex(0x1000n)).toBe("0x1000");
    expect(addressToHex(parseAddressHex("0xFFFFFFFFFFFFFFFF"))).toBe("0xffffffffffffffff");
  });

  it("formatAddressHex 零填充到最小位数,不截断超宽地址", () => {
    expect(formatAddressHex("0x40", 8)).toBe("0x00000040");
    expect(formatAddressHex("0x1000", 4)).toBe("0x1000");
    expect(formatAddressHex("0x1000")).toBe("0x1000");
    expect(formatAddressHex("0xdeadbeef", 8)).toBe("0xdeadbeef");
    expect(formatAddressHex("0x1", 16)).toBe("0x0000000000000001");
    expect(() => formatAddressHex("0x40", 0)).toThrow();
    expect(() => formatAddressHex("0x40", 17)).toThrow();
  });

  it("非法地址抛错", () => {
    expect(() => parseAddressHex("1000")).not.toThrow(); // 防御性接受无前缀形态。
    expect(() => parseAddressHex("0x")).toThrow();
    expect(() => parseAddressHex("0xzzzz")).toThrow();
  });
});

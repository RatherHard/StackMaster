/**
 * 严格 JSON 扫描器测试(XS-DUP-KEY)。
 *
 * JSON.parse 的 reviver 观察不到重复键(后值覆盖先值发生在 reviver 之前),
 * 因此重复键拒绝由字符级状态机在 JSON.parse 之前完成。
 */

import { describe, expect, it } from "vitest";
import { JsonStrictParseError, parseJsonStrict } from "../src/internal/json-strict-parse.js";

describe("parseJsonStrict", () => {
  it("接受合法 JSON(嵌套对象与数组)", () => {
    const text = '{"a":1,"b":{"c":[true,null,"x"]},"d":[]}';

    expect(parseJsonStrict(text)).toEqual({ a: 1, b: { c: [true, null, "x"] }, d: [] });
  });

  it("拒绝顶层重复键", () => {
    expect(() => parseJsonStrict('{"a":1,"a":2}')).toThrow(JsonStrictParseError);
  });

  it("拒绝嵌套对象重复键", () => {
    expect(() => parseJsonStrict('{"a":{"x":1,"x":2}}')).toThrow(/重复键/);
  });

  it("转义等价键视为重复(\\u0061 与 a)", () => {
    expect(() => parseJsonStrict('{"a":1,"\\u0061":2}')).toThrow(/重复键/);
  });

  it("不同对象中的同名键不误报", () => {
    const value = parseJsonStrict('{"a":{"x":1},"b":{"x":2}}');

    expect(value).toEqual({ a: { x: 1 }, b: { x: 2 } });
  });

  it("数组内的重复字符串值不误报", () => {
    const value = parseJsonStrict('{"a":["x","x"]}');

    expect(value).toEqual({ a: ["x", "x"] });
  });

  it("嵌套数组内的对象重复键仍被拒绝", () => {
    expect(() => parseJsonStrict('{"a":[{"k":1},{"k":2,"k":3}]}')).toThrow(/重复键/);
  });

  it("重复键错误消息携带键名", () => {
    try {
      parseJsonStrict('{"alpha":1,"alpha":2}');
      expect.unreachable("应抛出 JsonStrictParseError");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(JsonStrictParseError);
      expect((error as JsonStrictParseError).message).toContain('"alpha"');
    }
  });

  it("拒绝未闭合字符串与语法错误", () => {
    expect(() => parseJsonStrict('{"a":1')).toThrow();
    expect(() => parseJsonStrict('{"a":unquoted}')).toThrow();
    expect(() => parseJsonStrict('{"a":1} trailing')).toThrow();
    expect(() => parseJsonStrict('{"a" 1}')).toThrow();
  });
});

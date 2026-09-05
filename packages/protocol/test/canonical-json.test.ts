/**
 * 规范化 JSON 序列化测试(WP-6;规范 docs/规范化JSON序列化.md)。
 *
 * 覆盖:键排序、零空白、字符串最短转义、整数域数值规则与各拒绝码、
 * 幂等性(规范化输出再次规范化不变)、十六进制值层不归本模块的边界说明。
 * 跨语言一致性由 tooling/contract-smoke 对摘要清单逐条比对保证。
 */
import { describe, expect, it } from "vitest";
import {
  MAX_CANONICAL_JSON_DEPTH,
  CanonicalJsonError,
  canonicalize,
  canonicalizeJsonText,
} from "../src/index.js";

describe("文法规则(规范 §三)", () => {
  it("对象键按 UTF-16 码元序排序,零空白", () => {
    expect(canonicalize({ b: 1, a: 2, B: 3, "": 4 })).toBe(
      '{"":4,"B":3,"a":2,"b":1}',
    );
  });

  it("键序含转义与增补平面字符时按码元序(非码位序)", () => {
    // "\u00e9" 是单码元(é 的预组合形态),码元 0x00E9 排在 "z"(0x007A) 之后;
    // "😀" 是代理对,高位代理 0xD83D 排在 "z" 之后、0x00E9 之前。
    expect(canonicalize({ z: 1, "é": 2, "😀": 3 })).toBe('{"z":1,"é":2,"😀":3}');
  });

  it("数组保持原序,对象递归排序", () => {
    expect(canonicalize([{ b: 1, a: [2, { d: 3, c: 4 }] }])).toBe(
      '[{"a":[2,{"c":4,"d":3}],"b":1}]',
    );
  });

  it("null / true / false 字面量", () => {
    expect(canonicalize([null, true, false])).toBe("[null,true,false]");
  });
});

describe("字符串转义(规范 §3.1)", () => {
  it("仅转义引号、反斜杠与控制字符,其余原样", () => {
    expect(canonicalize('a"b\\c\bd\fe\nf\rg\th')).toBe(
      '"a\\"b\\\\c\\bd\\fe\\nf\\rg\\th"',
    );
  });

  it("其他控制字符用小写 \\u00xx,斜杠不转义,非 ASCII 直出", () => {
    expect(canonicalize("\u0000\u001f/中文😀")).toBe(
      '"\\u0000\\u001f/中文😀"',
    );
  });

  it("拒绝孤立代理项", () => {
    expect(() => canonicalize("\ud800")).toThrowError(CanonicalJsonError);
    expect(() => canonicalize("\udc00")).toThrowError(CanonicalJsonError);
    expect(() => canonicalize("a\ud800b")).toThrowError(CanonicalJsonError);
    // 合法代理对(整个码位)放行。
    expect(canonicalize("\ud83d\ude00")).toBe('"😀"');
  });

  it("对象键中的孤立代理项同样拒绝", () => {
    expect(() => canonicalize({ ["\ud800"]: 1 })).toThrowError(CanonicalJsonError);
  });
});

describe("数值域(规范 §二 / §六,整数-only)", () => {
  it("安全整数按十进制输出,-0 规范化为 0", () => {
    expect(canonicalize([0, -0, 9007199254740991, -9007199254740991])).toBe(
      "[0,0,9007199254740991,-9007199254740991]",
    );
  });

  it.each([
    ["非整数", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("拒绝%s", (_name, value) => {
    expect(() => canonicalize(value)).toThrowError(CanonicalJsonError);
    const error = (() => {
      try {
        canonicalize(value);
      } catch (caught) {
        return caught as CanonicalJsonError;
      }
    })()!;
    expect(error.code).toBe("non_integer_number");
  });

  it("拒绝超出 ±(2^53 − 1) 的整数", () => {
    expect(() => canonicalize(9007199254740992)).toThrowError(CanonicalJsonError);
    // 字面量 -(2^53 − 1 + 2) 在 double 下失真,故以运行时运算构造越界值。
    expect(() => canonicalize(-Number.MAX_SAFE_INTEGER - 2)).toThrowError(
      CanonicalJsonError,
    );
    try {
      canonicalize(-Number.MAX_SAFE_INTEGER - 2);
    } catch (caught) {
      expect((caught as CanonicalJsonError).code).toBe("unsafe_integer");
    }
  });

  it("拒绝 JSON 文本中的浮点字面量;整数值的指数写法规范化为十进制", () => {
    expect(() => canonicalizeJsonText("1.5")).toThrowError(CanonicalJsonError);
    expect(canonicalizeJsonText("1e3")).toBe("1000");
  });
});

describe("严格解析(规范 §二)", () => {
  it("拒绝重复键(解码后语义拼写比较)", () => {
    expect(() => canonicalizeJsonText('{"a":1,"a":2}')).toThrowError(/重复键/);
    expect(() => canonicalizeJsonText('{"a":1,"\\u0061":2}')).toThrowError(
      /重复键/,
    );
  });

  it("嵌套对象中的重复键同样拒绝,数组内不受键规则影响", () => {
    expect(() => canonicalizeJsonText('{"o":{"k":1,"k":2}}')).toThrowError(
      /重复键/,
    );
    expect(canonicalizeJsonText('["a","a"]')).toBe('["a","a"]');
  });

  it("语法错误以 invalid_json 拒绝", () => {
    expect(() => canonicalizeJsonText('{"a":')).toThrowError(CanonicalJsonError);
    try {
      canonicalizeJsonText("{");
    } catch (caught) {
      expect((caught as CanonicalJsonError).code).toBe("invalid_json");
    }
  });
});

describe("内存态输入(规范 §二第 4 条)", () => {
  it("拒绝 undefined / 函数 / bigint 等非 JSON 值", () => {
    expect(() => canonicalize(undefined)).toThrowError(CanonicalJsonError);
    expect(() => canonicalize(() => 1)).toThrowError(CanonicalJsonError);
    expect(() => canonicalize(1n)).toThrowError(CanonicalJsonError);
    expect(() => canonicalize({ a: undefined })).toThrowError(CanonicalJsonError);
    expect(() => canonicalize([1, undefined])).toThrowError(CanonicalJsonError);
    try {
      canonicalize(1n);
    } catch (caught) {
      expect((caught as CanonicalJsonError).code).toBe("unsupported_type");
    }
  });
});

describe("深度护栏(规范 §3.3)", () => {
  it("超过上限拒绝,上限内放行", () => {
    const within = JSON.parse(`[${"[".repeat(MAX_CANONICAL_JSON_DEPTH - 1)}]${"]".repeat(MAX_CANONICAL_JSON_DEPTH - 1)}`);
    expect(canonicalize(within)).toBe(`[${"[".repeat(MAX_CANONICAL_JSON_DEPTH - 1)}]${"]".repeat(MAX_CANONICAL_JSON_DEPTH - 1)}`);
    const beyond = `${"[".repeat(MAX_CANONICAL_JSON_DEPTH + 2)}${"]".repeat(MAX_CANONICAL_JSON_DEPTH + 2)}`;
    expect(() => canonicalizeJsonText(beyond)).toThrowError(CanonicalJsonError);
  });
});

describe("幂等性与十六进制值层边界", () => {
  it("规范化输出再次规范化不变", () => {
    const once = canonicalizeJsonText('{"b":[1,"x"],"a":{"c":null}}');
    expect(canonicalizeJsonText(once)).toBe(once);
  });

  it("文法规范化不改写字符串内容:十六进制值形态由生产者负责(规范 §四)", () => {
    expect(canonicalizeJsonText('{"addrHex":"0x401200"}')).toBe(
      '{"addrHex":"0x401200"}',
    );
  });
});

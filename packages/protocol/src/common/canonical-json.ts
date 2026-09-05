/**
 * 规范化 JSON 序列化(WP-6;规范文本 docs/规范化JSON序列化.md)。
 *
 * `stackmaster-canonical-json/1`:RFC 8785(JCS)的整数域子集。键按 UTF-16
 * 码元序排序、零空白、字符串最短转义、数值域收窄为安全整数(非整数拒绝,
 * 见规范 §六论证)——TS 与 Rust 双实现,由 tooling/contract-smoke 的
 * golden fixture 摘要清单锁定,任何一侧单方修改即冒烟失败。
 *
 * 值级规范化(十六进制标量的发射形态,hex.ts 交由 WP-6 冻结的部分)不在
 * 本模块:文法规范化是上下文无关的机械变换;十六进制值由生产者按
 * docs/规范化JSON序列化.md §四在构造载荷时完成,再进入本模块。
 */

/** 规范化失败的机器可读原因(规范 §五;Rust 侧拒绝集合与之对齐)。 */
export type CanonicalJsonErrorCode =
  | "invalid_json"
  | "duplicate_key"
  | "non_integer_number"
  | "unsafe_integer"
  | "lone_surrogate"
  | "unsupported_type"
  | "max_depth_exceeded";

export class CanonicalJsonError extends Error {
  public readonly code: CanonicalJsonErrorCode;

  public constructor(code: CanonicalJsonErrorCode, message: string) {
    super(message);
    this.name = "CanonicalJsonError";
    this.code = code;
  }
}

/**
 * 嵌套深度护栏(docs/规范化JSON序列化.md §3.3)。契约实例深度由消息字节
 * 上限约束,本值仅防御病态输入导致的栈溢出,正常负载远不可达。
 */
export const MAX_CANONICAL_JSON_DEPTH = 512;

/**
 * 文本入口:严格解析(拒绝重复键、语法错误)后规范化。
 * 返回值参与哈希时取其 UTF-8 字节序列(规范 §3.2)。
 */
export function canonicalizeJsonText(text: string): string {
  rejectDuplicateKeys(text);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new CanonicalJsonError("invalid_json", "JSON 语法错误或包含尾随内容");
  }
  return canonicalize(value);
}

/** 内存态入口:对已解析的 JSON 值做规范化;输入必须是 JSON 值域内的数据。 */
export function canonicalize(value: unknown): string {
  const out: string[] = [];
  writeValue(value, out, 0);
  return out.join("");
}

function writeValue(value: unknown, out: string[], depth: number): void {
  if (depth > MAX_CANONICAL_JSON_DEPTH) {
    throw new CanonicalJsonError(
      "max_depth_exceeded",
      `JSON 嵌套深度超过护栏(${MAX_CANONICAL_JSON_DEPTH})`,
    );
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      out.push(writeNumber(value));
      return;
    case "string":
      writeJsonString(value, out);
      return;
    case "object":
      if (value === null) {
        out.push("null");
        return;
      }
      if (Array.isArray(value)) {
        out.push("[");
        for (let i = 0; i < value.length; i++) {
          if (i > 0) {
            out.push(",");
          }
          writeValue(value[i], out, depth + 1);
        }
        out.push("]");
        return;
      }
      writeObject(value as Record<string, unknown>, out, depth);
      return;
    default:
      // undefined / function / symbol / bigint:不是 JSON 值域,拒绝而非静默跳过。
      throw new CanonicalJsonError(
        "unsupported_type",
        `非 JSON 值:${typeof value}`,
      );
  }
}

function writeObject(value: Record<string, unknown>, out: string[], depth: number): void {
  const keys = Object.keys(value).sort();
  out.push("{");
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) {
      out.push(",");
    }
    writeJsonString(keys[i]!, out);
    out.push(":");
    writeValue(value[keys[i]!], out, depth + 1);
  }
  out.push("}");
}

function writeNumber(value: number): string {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new CanonicalJsonError(
      "non_integer_number",
      `规范化数值域仅允许整数,收到:${String(value)}`,
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new CanonicalJsonError(
      "unsafe_integer",
      `整数超出 ±(2^53 − 1) 安全域,拒绝近似:${String(value)}`,
    );
  }
  // 安全整数域内 String(n) 即十进制无指数形态;String(-0) === "0"(承 JCS)。
  return String(value);
}

function writeJsonString(value: string, out: string[]): void {
  assertNoLoneSurrogate(value);
  out.push('"');
  let chunkStart = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    let escaped: string | undefined;
    switch (code) {
      case 0x22:
        escaped = '\\"';
        break;
      case 0x5c:
        escaped = "\\\\";
        break;
      case 0x08:
        escaped = "\\b";
        break;
      case 0x09:
        escaped = "\\t";
        break;
      case 0x0a:
        escaped = "\\n";
        break;
      case 0x0c:
        escaped = "\\f";
        break;
      case 0x0d:
        escaped = "\\r";
        break;
      default:
        if (code < 0x20) {
          escaped = `\\u${code.toString(16).padStart(4, "0")}`;
        }
        break;
    }
    if (escaped !== undefined) {
      out.push(value.slice(chunkStart, i), escaped);
      chunkStart = i + 1;
    }
  }
  out.push(value.slice(chunkStart), '"');
}

function assertNoLoneSurrogate(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        throw new CanonicalJsonError("lone_surrogate", "字符串含孤立高位代理项");
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalJsonError("lone_surrogate", "字符串含孤立低位代理项");
    }
  }
}

/**
 * 解析前线性扫描,拒绝对象重复键(键按转义解码后的精确拼写比较)。
 * JSON.parse 规范允许重复键且后值静默覆盖前值,reviver 无法观测覆盖,
 * 因此与 challenge-schema 的 json-strict-parse 同法:交给 JSON.parse 之前
 * 先扫描拒绝(两包无依赖关系,各自实现、拒绝语义对齐,规范 §二第 1 条)。
 */
function rejectDuplicateKeys(text: string): void {
  interface Frame {
    readonly isObject: boolean;
    readonly keys: Set<string>;
    nextStringIsKey: boolean;
  }
  const frames: Frame[] = [];
  const decodeKey = (raw: string): string => {
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      throw new CanonicalJsonError("invalid_json", "对象键转义非法");
    }
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      const frame = frames[frames.length - 1];
      const isKey = frame !== undefined && frame.isObject && frame.nextStringIsKey;
      const end = scanStringEnd(text, index);
      if (isKey && frame !== undefined) {
        const key = decodeKey(text.slice(index + 1, end - 1));
        if (frame.keys.has(key)) {
          throw new CanonicalJsonError("duplicate_key", `JSON 对象出现重复键:"${key}"`);
        }
        frame.keys.add(key);
        frame.nextStringIsKey = false;
      }
      index = end;
      continue;
    }
    switch (char) {
      case "{":
        frames.push({ isObject: true, keys: new Set<string>(), nextStringIsKey: true });
        break;
      case "[":
        frames.push({ isObject: false, keys: new Set<string>(), nextStringIsKey: false });
        break;
      case "}":
      case "]":
        if (frames.pop() === undefined) {
          throw new CanonicalJsonError("invalid_json", "JSON 结构错误:意外的闭合括号");
        }
        break;
      case ",": {
        const frame = frames[frames.length - 1];
        if (frame !== undefined && frame.isObject) {
          frame.nextStringIsKey = true;
        }
        break;
      }
      default:
        // 冒号、数字、字面量与空白不关心;语法错误交给 JSON.parse 兜底。
        break;
        // 冒号、数字、字面量与空白不关心;语法错误交给 JSON.parse 兜底。
        break;
    }
    index += 1;
  }
}

/** 从开引号扫描到闭引号(处理 `\\` 转义),返回闭引号之后的下标。 */
function scanStringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      return index + 1;
    }
    if (char === "\\") {
      index += 2;
      continue;
    }
    index += 1;
  }
  throw new CanonicalJsonError("invalid_json", "JSON 字符串未闭合");
}

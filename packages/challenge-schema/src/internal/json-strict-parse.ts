/**
 * 严格 JSON 装载(XS-DUP-KEY)。
 *
 * JSON.parse 规范允许对象出现重复键(后值静默覆盖前值),且 reviver 在
 * 键已被覆盖后才执行、无法观测重复;因此在交给 JSON.parse 之前,先用
 * 一遍线性字符扫描拒绝任何重复键(键按转义解码后的精确拼写比较)。
 */

export class JsonStrictParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "JsonStrictParseError";
  }
}

interface ContainerFrame {
  readonly kind: "object" | "array";
  readonly keys: Set<string>;
  /** 下一个字符串是否处于对象键位置(仅 object 帧会被置位)。 */
  nextStringIsKey: boolean;
}

/** 解析并拒绝重复键;JSON 语法错误同样以异常抛出。 */
export function parseJsonStrict(text: string): unknown {
  rejectDuplicateKeys(text);
  return JSON.parse(text) as unknown;
}

function rejectDuplicateKeys(text: string): void {
  const frames: ContainerFrame[] = [];
  let index = 0;
  while (index < text.length) {
    const char: string = text[index]!;
    if (char === '"') {
      const frame = frames[frames.length - 1];
      const isKey = frame?.kind === "object" && frame.nextStringIsKey;
      const keySink = frame !== undefined && isKey ? makeKeySink(frame) : undefined;
      index = scanString(text, index, keySink);
      if (isKey && frame !== undefined) {
        frame.nextStringIsKey = false;
      }
      continue;
    }
    switch (char) {
      case "{":
        frames.push({ kind: "object", keys: new Set<string>(), nextStringIsKey: true });
        break;
      case "[":
        frames.push({ kind: "array", keys: new Set<string>(), nextStringIsKey: false });
        break;
      case "}":
      case "]": {
        const frame = frames.pop();
        if (frame === undefined) {
          throw new JsonStrictParseError("JSON 结构错误:意外的闭合括号");
        }
        break;
      }
      case ",": {
        const frame = frames[frames.length - 1];
        if (frame?.kind === "object") {
          frame.nextStringIsKey = true;
        }
        break;
      }
      default:
        // 冒号、数字、字面量与空白不关心;语法错误交给 JSON.parse 兜底。
        break;
    }
    index += 1;
  }
}

function makeKeySink(frame: ContainerFrame): (key: string) => void {
  return (key: string) => {
    if (frame.keys.has(key)) {
      throw new JsonStrictParseError(`JSON 对象出现重复键:"${key}"`);
    }
    frame.keys.add(key);
  };
}

/**
 * 从开引号扫描到闭引号,返回闭引号之后的下标。
 * `onKeyDecoded` 存在时解码字符串内容(键按语义值比较,`a` 与 `a` 视为同键);
 * 否则仅定位边界(值字符串可能极大,避免逐字符拼接)。
 */
function scanString(
  text: string,
  start: number,
  onKeyDecoded: ((key: string) => void) | undefined,
): number {
  let index = start + 1;
  let decoded = onKeyDecoded !== undefined ? "" : undefined;
  while (index < text.length) {
    const char: string = text[index]!;
    if (char === '"') {
      if (decoded !== undefined && onKeyDecoded !== undefined) {
        onKeyDecoded(decoded);
      }
      return index + 1;
    }
    if (char === "\\") {
      const escape = text[index + 1];
      if (escape === undefined) {
        throw new JsonStrictParseError("JSON 字符串未闭合");
      }
      index += 2;
      if (decoded !== undefined) {
        switch (escape) {
          case '"':
            decoded += '"';
            break;
          case "\\":
            decoded += "\\";
            break;
          case "/":
            decoded += "/";
            break;
          case "b":
            decoded += "\b";
            break;
          case "f":
            decoded += "\f";
            break;
          case "n":
            decoded += "\n";
            break;
          case "r":
            decoded += "\r";
            break;
          case "t":
            decoded += "\t";
            break;
          case "u": {
            const hex = text.slice(index, index + 4);
            const code = Number.parseInt(hex, 16);
            decoded += Number.isNaN(code) ? "�" : String.fromCharCode(code);
            index += 4;
            break;
          }
          default:
            throw new JsonStrictParseError("JSON 字符串转义错误");
        }
      } else if (escape === "u") {
        index += 4;
      }
      continue;
    }
    if (decoded !== undefined) {
      decoded += char;
    }
    index += 1;
  }
  throw new JsonStrictParseError("JSON 字符串未闭合");
}

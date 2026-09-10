import { Writable } from "node:stream";

export interface LogCapture {
  /** 传给 pino 作 destination 的可写流。 */
  stream: Writable;
  /** 已完成的日志行(逐行 JSON.parse;未换行的尾行忽略)。 */
  entries: () => Record<string, unknown>[];
  /** 全部原始文本(含未换行尾行)。 */
  raw: () => string;
}

/** pino 输出捕获流:NDJSON 逐行收集,供日志纪律断言。 */
export function createLogCapture(): LogCapture {
  let text = "";
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      text += chunk.toString("utf8");
      callback();
    },
  });
  return {
    stream,
    entries: () =>
      text
        .split("\n")
        .filter((line) => line.trim().length > 0 && textHasClosingBrace(line))
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    raw: () => text,
  };
}

function textHasClosingBrace(line: string): boolean {
  return line.trimEnd().endsWith("}");
}

/**
 * `CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE` 的迁移守护测试。
 *
 * 该常量原定义于 `src/embed/embed-token-claims.ts`,2026-09-19 随 WP-96 迁至
 * `src/common/challenge-content-version.ts`(嵌入协议面整体退役,但本常量是
 * **题目内容版本格式常量**,被六处活跃契约复用 ⇒ 中立位置承接)。
 *
 * 本套件把迁移纪律变成红灯语料(原 `embed-token-claims.test.ts` 中的
 * 格式冻结断言在此**逐字保留**,不因源文件退场而失去被测对象):
 *  1. **字面值逐字不变**(`^[0-9]+\.[0-9]+\.[0-9]+$`);
 *  2. **双入口可达**(包入口与 server-only 子路径都能拿到同一值);
 *  3. **全仓单源**(`packages/protocol/src` 下正则源码只出现一次 —— 禁复制
 *     第二份字面量,这正是迁移文档里承诺的机检面)。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE as fromPackageEntry } from "../src/index.js";
import { CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE as fromServerOnly } from "../src/server-only/index.js";

const FROZEN_LITERAL = "^[0-9]+\\.[0-9]+\\.[0-9]+$";
const SRC_ROOT = join(import.meta.dirname, "..", "src");

describe("题目内容版本格式常量(2026-09-19 自 embed-token-claims.ts 迁移)", () => {
  it("字面值逐字冻结(X.Y.Z;与 challenge-schema 的 SEMVER_PATTERN_SOURCE 同源格式)", () => {
    expect(fromPackageEntry).toBe(FROZEN_LITERAL);
    expect(fromServerOnly).toBe(FROZEN_LITERAL);
    // 迁移不改语义:正则行为本身也钉住。
    const pattern = new RegExp(fromPackageEntry);
    expect(pattern.test("1.2.3")).toBe(true);
    expect(pattern.test("v1.2.3")).toBe(false);
    expect(pattern.test("1.2")).toBe(false);
  });

  it("双入口可达性自迁移前逐字保留(格式常量不受「凭证解析器不给浏览器」纪律约束)", () => {
    expect(fromPackageEntry).toBe(fromServerOnly);
  });

  it("全仓单源:src 下正则源码只出现一次(禁复制第二份字面量)", () => {
    const sourceText = collectSourceText(SRC_ROOT);
    // 源码文本里的转义形态(`\.` 在 TS 字符串字面量中写作 `\\.`)。
    const rawLiteral = FROZEN_LITERAL.replace(/\\/g, "\\\\");
    expect(sourceText).toContain(rawLiteral);
    expect(countOccurrences(sourceText, rawLiteral)).toBe(1);
  });
});

/** 递归拼接目录下全部 .ts 源码。 */
function collectSourceText(root: string): string {
  const chunks: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      chunks.push(collectSourceText(full));
      continue;
    }
    if (entry.endsWith(".ts")) {
      chunks.push(readFileSync(full, "utf8"));
    }
  }
  return chunks.join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * 摘要清单防漂移测试(WP-6;docs/contracts/规范化JSON序列化.md §五)。
 *
 * 以 TS 侧 canonicalizer(src/,与生成脚本 dist 同源)对全部 fixture 复算
 * 规范化摘要 / 拒绝码,与 tooling/contract-smoke/canonical-digests.json
 * 逐条比对:fixture 增删或规范化实现变更而未重建清单,此处即红。
 * Rust 侧对同一清单的比对在 tooling/contract-smoke(冒烟 §三)。
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalizeJsonText } from "../src/index.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const MANIFEST_PATH = join(REPO_ROOT, "tooling", "contract-smoke", "canonical-digests.json");
const FIXTURE_ROOTS = [
  join(REPO_ROOT, "packages", "protocol", "test", "fixtures"),
  join(REPO_ROOT, "packages", "challenge-schema", "test", "fixtures"),
];

interface ManifestEntry {
  readonly sha256?: string;
  readonly rejected?: string;
}

function walkJsonFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJsonFiles(full));
    } else if (entry.name.endsWith(".json")) {
      files.push(full);
    }
  }
  return files;
}

describe("golden fixture 摘要清单防漂移(WP-6)", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    algorithm?: string;
    fixtures: Record<string, ManifestEntry>;
  };

  const onDisk = new Map<string, ManifestEntry>();
  for (const root of FIXTURE_ROOTS) {
    for (const file of walkJsonFiles(root)) {
      const key = file.slice(REPO_ROOT.length + 1).replaceAll("\\", "/");
      let entry: ManifestEntry;
      try {
        const canonical = canonicalizeJsonText(readFileSync(file, "utf8"));
        entry = { sha256: createHash("sha256").update(canonical, "utf8").digest("hex") };
      } catch (error) {
        entry = { rejected: (error as { code?: string }).code ?? "unknown" };
      }
      onDisk.set(key, entry);
    }
  }

  it("清单条目集合与 fixture 目录严格一致", () => {
    expect(Object.keys(manifest.fixtures).sort()).toEqual([...onDisk.keys()].sort());
  });

  it("全部 fixture 的摘要 / 拒绝码与清单逐条一致", () => {
    const mismatches: string[] = [];
    for (const [key, actual] of onDisk) {
      const expected = manifest.fixtures[key];
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        mismatches.push(`${key}:清单=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("规范标识为 stackmaster-canonical-json/1 + sha256", () => {
    expect(manifest.algorithm).toBe("stackmaster-canonical-json/1 + sha256");
  });
});

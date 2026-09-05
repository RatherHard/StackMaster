/**
 * golden fixture 规范化摘要清单生成器(WP-6;docs/规范化JSON序列化.md §五)。
 *
 * 遍历 protocol 与 challenge-schema 两个包的 test/fixtures,对每个 fixture:
 *   - 可规范化 → 记录 canonicalSha256(规范化形态的 UTF-8 SHA-256,小写十六进制);
 *   - 触犯规范化前置条件 → 记录拒绝码(与 CanonicalJsonErrorCode 对齐)。
 * 产物 tooling/contract-smoke/canonical-digests.json 是跨语言锁:TS 生成、
 * Rust 冒烟(tooling/contract-smoke)逐条比对,任一侧实现漂移即失败。
 *
 * 输出确定性:无时间戳、键按路径字典序、统一 POSIX 分隔符;`--check` 只比对
 * 不写盘(CI 防漂移)。用法:
 *   pnpm fixtures:manifest           # 重新生成
 *   node tooling/generate-canonical-manifest.mjs --check
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeJsonText } from "../packages/protocol/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "tooling", "contract-smoke", "canonical-digests.json");
const fixtureRoots = [
  join(repoRoot, "packages", "protocol", "test", "fixtures"),
  join(repoRoot, "packages", "challenge-schema", "test", "fixtures"),
];

const distIndex = join(repoRoot, "packages", "protocol", "dist", "index.js");
if (!existsSync(distIndex)) {
  console.error("先构建 @stackmaster/protocol:pnpm --filter @stackmaster/protocol build");
  process.exit(1);
}

function walkJsonFiles(dir) {
  const files = [];
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

function digestOrRejection(text) {
  try {
    const canonical = canonicalizeJsonText(text);
    return { sha256: createHash("sha256").update(canonical, "utf8").digest("hex") };
  } catch (error) {
    const code = error?.code;
    if (typeof code !== "string") {
      throw error;
    }
    return { rejected: code };
  }
}

const fixtures = {};
for (const root of fixtureRoots) {
  for (const file of walkJsonFiles(root)) {
    const key = relative(repoRoot, file).replaceAll("\\", "/");
    const text = readFileSync(file, "utf8");
    fixtures[key] = digestOrRejection(text);
  }
}

const manifest = JSON.stringify(
  {
    algorithm: "stackmaster-canonical-json/1 + sha256",
    generator: "tooling/generate-canonical-manifest.mjs",
    spec: "docs/规范化JSON序列化.md",
    fixtures: Object.fromEntries(Object.entries(fixtures).sort(([a], [b]) => (a < b ? -1 : 1))),
  },
  null,
  2,
) + "\n";

if (process.argv.includes("--check")) {
  if (!existsSync(manifestPath)) {
    console.error(`--check:清单不存在,先生成 ${manifestPath}`);
    process.exit(1);
  }
  const current = readFileSync(manifestPath, "utf8");
  if (current !== manifest) {
    console.error("--check:清单与 fixture 现状不一致(fixture 漂移或实现变更),请重新生成并跑 Rust 冒烟");
    process.exit(1);
  }
  console.log(`--check 通过:${Object.keys(fixtures).length} 个 fixture 与清单一致`);
} else {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, manifest, "utf8");
  const digests = Object.values(fixtures).filter((e) => e.sha256 !== undefined).length;
  const rejected = Object.values(fixtures).filter((e) => e.rejected !== undefined).length;
  console.log(`已生成 ${manifestPath}:${digests} 个摘要,${rejected} 个记录拒绝码`);
}

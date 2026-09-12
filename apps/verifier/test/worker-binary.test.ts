/**
 * vm-worker 二进制解析单测(WP-61;版本策略 §四.4 同锁的进程载体)。
 *
 * 解析序:STACKMASTER_WORKER_BIN(env 优先)→ vm-engine/target/{release,
 * debug} 产物序;env 命中即短路(测试以临时文件证明优先级)。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveWorkerBinary } from "../src/worker/worker-binary.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempWorkerFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "verifier-bin-"));
  tempDirs.push(dir);
  const file = join(dir, "vm-worker-test.exe");
  writeFileSync(file, "not-a-real-binary");
  return file;
}

describe("resolveWorkerBinary", () => {
  it("env 命中即短路(优先于 target 产物序)", () => {
    const candidate = tempWorkerFile();
    expect(resolveWorkerBinary({ STACKMASTER_WORKER_BIN: candidate })).toBe(candidate);
  });

  it("env 未命中:回退 target 产物序(存在则返回存在路径;否则 null)", () => {
    const resolved = resolveWorkerBinary({ STACKMASTER_WORKER_BIN: join(tmpdir(), "absent-bin") });
    if (resolved === null) {
      expect(resolved).toBeNull();
    } else {
      expect(resolved).toContain(join("vm-engine", "target"));
      expect(existsSync(resolved)).toBe(true);
    }
  });
});

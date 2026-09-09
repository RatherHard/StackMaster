/**
 * vm-worker 二进制定位(WP-8;集成测试与生产编排共用)。
 *
 * 解析序:`STACKMASTER_WORKER_BIN` 环境变量 → cargo target 目录下的
 * `vm-worker`(`debug` / `release` profile 由 `STACKMASTER_CARGO_PROFILE`
 * 选择,缺省 debug)。二进制缺失时按需 `cargo build -p vm-worker`(构建
 * 结果在进程内缓存,只构建一次)。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..", "..");

let buildPromise: Promise<string> | null = null;

/** 解析(必要时构建)vm-worker 二进制路径。 */
export function ensureWorkerBinary(): Promise<string> {
  return buildPromise ??= Promise.resolve().then(() => {
    const fromEnv = process.env.STACKMASTER_WORKER_BIN;
    if (fromEnv !== undefined && existsSync(fromEnv)) {
      return resolve(fromEnv);
    }
    const profile = process.env.STACKMASTER_CARGO_PROFILE ?? "debug";
    const exe = platform() === "win32" ? "vm-worker.exe" : "vm-worker";
    const candidate = join(REPO_ROOT, "vm-engine", "target", profile, exe);
    if (existsSync(candidate)) {
      return candidate;
    }
    const build = spawnSync("cargo", ["build", "-p", "vm-worker"], {
      cwd: join(REPO_ROOT, "vm-engine"),
      stdio: ["ignore", "ignore", "inherit"],
      shell: platform() === "win32",
    });
    if (build.status !== 0 || !existsSync(candidate)) {
      throw new Error(
        `vm-worker 二进制不可用且 cargo build 失败(期待 ${candidate})`,
      );
    }
    return candidate;
  });
}

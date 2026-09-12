/**
 * vm-worker 二进制解析(WP-61;与 `packages/session-core` 的
 * `ensureWorkerBinary` 同一解析序的 verifier 侧镜像)。
 *
 * 版本策略 §四.4(verifier 与交互执行同锁)的进程载体:两个服务必须
 * 解析到**同一份**引擎构建——compose 拓扑下二者共用同一镜像
 * (`/app/bin/vm-worker`,同锁由镜像同一性结构性保证);host 拓扑下沿
 * `STACKMASTER_WORKER_BIN` → `vm-engine/target/{release,debug}` 产物序解析。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 解析本机 vm-worker 二进制(env 优先;产物解析序与 session-core 一致)。 */
export function resolveWorkerBinary(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const fromEnv = env["STACKMASTER_WORKER_BIN"];
  if (fromEnv !== undefined && existsSync(fromEnv)) {
    return fromEnv;
  }
  const appDir = fileURLToPath(new URL("../../", import.meta.url)); // apps/verifier
  const repoDir = join(appDir, "..", "..");
  const exe = process.platform === "win32" ? "vm-worker.exe" : "vm-worker";
  for (const profile of ["release", "debug"] as const) {
    const candidate = join(repoDir, "vm-engine", "target", profile, exe);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * compose 拓扑装配帮手(WP-F7 E2E global-setup / teardown 共用)。
 *
 * 等价 `pnpm --filter @stackmaster/session-api compose:app:up / compose:app:down`
 * (docker compose -f deps.yaml -f app.yaml),不经 pnpm 直调 docker 以解除
 * Windows 下 .cmd 解析的壳层依赖。拓扑语义见 apps/session-api/README.md §二。
 */
import { spawnSync, type StdioOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根(本文件位于 apps/plugin-dev/e2e/helpers/)。 */
export const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
/** session-api 包目录(compose 文件与 seed 脚本相对锚点)。 */
export const SESSION_API_DIR = join(REPO_ROOT, "apps", "session-api");

/** compose 文件对(与 session-api package.json scripts 一致)。 */
const COMPOSE_FILES = ["-f", "compose/deps.yaml", "-f", "compose/app.yaml"];

/** 前置产物检查:vm-ui 产物(webServer publicDir)与 session-api dist(seed 依赖)。 */
export function assertPrerequisites(): void {
  const vmUiEntry = join(REPO_ROOT, "packages", "vm-ui", "dist", "index.js");
  if (!existsSync(vmUiEntry)) {
    throw new Error("packages/vm-ui/dist/index.js 不存在:先执行 pnpm build(turbo 构建序)");
  }
  const persistenceEntry = join(SESSION_API_DIR, "dist", "persistence", "index.js");
  if (!existsSync(persistenceEntry)) {
    throw new Error(
      "apps/session-api/dist/persistence/index.js 不存在(seed 脚本经真实登记路径出题依赖该产物):" +
        "先执行 pnpm build(turbo 构建序)",
    );
  }
}

/** 轮询 session-api /readyz 至 200(compose up --wait 后的进程内复核)。 */
export async function waitForReady(origin: string, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/readyz`);
      if (response.ok) {
        return true;
      }
    } catch {
      // 连接失败:拓扑未就绪,继续轮询。
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/** 同步执行 docker compose 子命令(失败抛错并透传 stdout/stderr)。 */
function compose(args: readonly string[], options: { timeoutMs?: number } = {}): void {
  const result: ReturnType<typeof spawnSync> = spawnSync(
    "docker",
    ["compose", ...COMPOSE_FILES, ...args],
    {
      cwd: SESSION_API_DIR,
      stdio: "inherit" as StdioOptions,
      // WORKER_CARGO_PROFILE 透传(CI=release,本地缺省 debug;D-API-64)。
      env: process.env,
      windowsHide: true,
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    },
  );
  if (result.status !== 0 || result.error !== undefined) {
    const reason = result.error instanceof Error ? ` (${result.error.message})` : "";
    throw new Error(`docker compose ${args.join(" ")} 失败:exit=${result.status ?? "n/a"}${reason}`);
  }
}

/** 拓扑是否已在运行(readyz 探测)。 */
export async function topologyRunning(origin: string): Promise<boolean> {
  return waitForReady(origin, 2_000);
}

/** 全拓扑构建与启动(up -d --build --wait;等价 compose:app:up)。 */
export function composeAppUp(): void {
  compose(["up", "-d", "--build", "--wait"], { timeoutMs: 10 * 60_000 });
}

/** 拓扑收尾(down -v,含数据卷;等价 compose:app:down)。 */
export function composeAppDown(): void {
  compose(["down", "-v"], { timeoutMs: 3 * 60_000 });
}

/**
 * 题目登记(阶段三 seed 路径复用):`apps/session-api/k6/seed-challenge.mjs`
 * 经发布端口的 PG / MinIO 走 ChallengeRegistrar 真实验签登记(版本不可变,
 * 已存在即复用)。题目内容 = 生命周期教学题合成占位(零真实秘密)。
 */
export function seedChallenge(env: { challengeId: string; tenantId: string }): void {
  const result = spawnSync(
    process.execPath,
    ["--env-file=compose/integration.env", "k6/seed-challenge.mjs"],
    {
      cwd: SESSION_API_DIR,
      stdio: "inherit",
      env: {
        ...process.env,
        K6_CHALLENGE_ID: env.challengeId,
        K6_TENANT_ID: env.tenantId,
      },
      windowsHide: true,
      timeout: 120_000,
    },
  );
  if (result.status !== 0 || result.error !== undefined) {
    const reason = result.error instanceof Error ? ` (${result.error.message})` : "";
    throw new Error(`seed-challenge 失败:exit=${result.status ?? "n/a"}${reason}`);
  }
}

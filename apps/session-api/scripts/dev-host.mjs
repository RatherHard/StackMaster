/**
 * 浏览器联调 host 启动器(开发专用,非测试基建)。
 *
 * 用途:在本机以"依赖容器 + 宿主进程"形态起 session-api(13000)与
 * verifier(13100),并把 plugin-dev 开发壳 origin(http://localhost:5173)
 * 加入来源白名单——compose 集成测试拓扑(test/compose/helpers/topology.ts
 * 的 HostProcess)只放行 13000,浏览器从 5173 发起经 vite 代理的请求会被
 * CORS / CSRF 闸拒绝,故本脚本独立装配环境。
 *
 * 用法(cwd = apps/session-api):
 *   pnpm --filter @stackmaster/session-api compose:deps:up   # 先起依赖服务
 *   pnpm --filter @stackmaster/session-api dev:host          # 本脚本
 *
 * 凭证纪律:签发密钥与宿主共享凭证是**本地开发专用合成值**(与
 * compose/app.yaml / test/helpers/required-env.ts 的合成值同性质),
 * 严禁用于任何真实环境;只经环境变量呈递给子进程,不入库不落盘。
 *
 * 环境来源:compose/integration.env(存储 / verifier 键)按键值对解析后
 * 注入;门控键(SESSION_API_IT / SESSION_API_COMPOSE / SESSION_API_TOPOLOGY)
 * 不属登记配置键,注入前剔除(保留键闸会拒绝启动,topology.ts 同纪律)。
 */

import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = join(APP_DIR, "..", "..");

const SESSION_API_PORT = process.env["DEV_SESSION_API_PORT"] ?? "13000";
const VERIFIER_PORT = process.env["DEV_VERIFIER_PORT"] ?? "13100";
const ALLOWED_ORIGINS =
  process.env["DEV_ALLOWED_ORIGINS"] ?? "http://localhost:5173,http://localhost:13000";

// 本地联调专用固定合成密钥(与 test/helpers/required-env.ts 同生成方式;
// 固定值使重启后已签发的 embed token 仍然有效,便于浏览器联调)。
const DEV_SIGNING_KEY_PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MC4CAQAwBQYDK2VwBCIEIPe35BIZKZY7An/tmhbo7bSz5c42xxuo/w4KmoZuF+XI",
  "-----END PRIVATE KEY-----",
].join("\n");

// 与 test/helpers/required-env.ts 的 HOST_BACKEND_TOKEN 同值(测试基建专用合成凭证)。
const DEV_HOST_BACKEND_TOKEN = "host-backend-shared-credential-0123456789";

function parseIntegrationEnv() {
  const path = join(APP_DIR, "compose", "integration.env");
  if (!existsSync(path)) {
    throw new Error(`compose/integration.env 不存在:${path}`);
  }
  const env = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

function resolveWorkerBinary() {
  const candidates = [
    join(REPO_ROOT, "vm-engine", "target", "debug", "vm-worker.exe"),
    join(REPO_ROOT, "vm-engine", "target", "debug", "vm-worker"),
    join(REPO_ROOT, "vm-engine", "target", "release", "vm-worker.exe"),
    join(REPO_ROOT, "vm-engine", "target", "release", "vm-worker"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (found === undefined) {
    throw new Error(
      "vm-worker 二进制不存在:先执行 cargo build -p vm-worker --manifest-path vm-engine/Cargo.toml",
    );
  }
  return found;
}

function assertDist(distPath, hint) {
  if (!existsSync(distPath)) {
    throw new Error(`${distPath} 不存在:${hint}`);
  }
  return distPath;
}

const children = [];
let shuttingDown = false;

function spawnChild(name, cwd, entryPath, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  // 门控 / 拓扑选择键不是登记配置键(保留键闸会拒绝启动)。
  delete env["SESSION_API_IT"];
  delete env["SESSION_API_COMPOSE"];
  delete env["SESSION_API_TOPOLOGY"];
  const child = spawn(process.execPath, [entryPath], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const tag = `[${name}]`;
  const forward = (to) => (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line !== "") to(`${tag} ${line}`);
    }
  };
  child.stdout?.on("data", forward((l) => console.log(l)));
  child.stderr?.on("data", forward((l) => console.error(l)));
  child.on("exit", (code) => {
    if (shuttingDown) return;
    console.error(`${tag} 意外退出(code=${code});联调拓扑不完整,按 Ctrl+C 退出。`);
  });
  children.push(child);
  return child;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[dev-host] 正在停止子进程…");
  for (const child of children) {
    child.kill("SIGTERM");
  }
  globalThis.setTimeout(() => {
    for (const child of children) {
      child.kill("SIGKILL");
    }
    process.exit(0);
  }, 3_000);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function waitFor(url, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "never";
  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(url);
      if (response.ok) {
        console.log(`[dev-host] ${label} 就绪(${url})`);
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
  }
  throw new Error(`等待 ${label} 就绪超时(${lastError})`);
}

// ── 主流程 ──────────────────────────────────────────────────────────────
const integrationEnv = parseIntegrationEnv();
const workerBin = resolveWorkerBinary();
const sessionApiDist = assertDist(
  join(APP_DIR, "dist", "index.js"),
  "先 pnpm --filter @stackmaster/session-api build",
);
const verifierDist = assertDist(
  join(REPO_ROOT, "apps", "verifier", "dist", "index.js"),
  "先 pnpm --filter @stackmaster/verifier build",
);
const verifierDir = join(REPO_ROOT, "apps", "verifier");

const sharedEnv = {
  ...integrationEnv,
  SESSION_API_SIGNING_KEY: DEV_SIGNING_KEY_PEM,
  SESSION_API_HOST_BACKEND_TOKEN: DEV_HOST_BACKEND_TOKEN,
  STACKMASTER_WORKER_BIN: workerBin,
};

console.log("[dev-host] 联调形态:依赖容器(compose:deps:up)+ 宿主进程;5173 已加入来源白名单。");
spawnChild("session-api", APP_DIR, sessionApiDist, {
  ...sharedEnv,
  SESSION_API_HOST: "127.0.0.1",
  SESSION_API_PORT: SESSION_API_PORT,
  SESSION_API_ALLOWED_ORIGINS: ALLOWED_ORIGINS,
});
spawnChild("verifier", verifierDir, verifierDist, {
  ...sharedEnv,
  VERIFIER_HOST: "127.0.0.1",
  VERIFIER_PORT: VERIFIER_PORT,
});

await waitFor(`http://127.0.0.1:${SESSION_API_PORT}/healthz`, "session-api");
await waitFor(`http://127.0.0.1:${VERIFIER_PORT}/healthz`, "verifier");

console.log(
  `[dev-host] 联调拓扑就绪:session-api=http://127.0.0.1:${SESSION_API_PORT} verifier=http://127.0.0.1:${VERIFIER_PORT}`,
);
console.log(
  "[dev-host] 下一步 ①登记题目:SESSION_API_COMPOSE=1 pnpm --filter @stackmaster/session-api exec vitest run test/extended-challenges/register-extended.compose.integration.test.ts",
);
console.log("[dev-host] 下一步 ②签发 token 并启动 plugin-dev:见 apps/session-api/test/extended-challenges/README.md;按 Ctrl+C 停止全部进程。");

/**
 * test:compose 入口(WP-7;D-API-65)。
 *
 * 形态选择(SESSION_API_TOPOLOGY):
 *  - `host`(缺省;本机 Windows 降级形态):compose/deps.yaml 依赖服务 +
 *    session-api 宿主进程(node dist/index.js)+ 本机 worker 二进制;
 *  - `container`(CI 形态;完整 linux 拓扑):compose/deps.yaml + app.yaml
 *    全拓扑(build 镜像 → up --wait → vm-worker linux 冒烟),测试经发布
 *    端口 13000 访问。
 *
 * 用法:
 *   pnpm --filter @stackmaster/session-api test:compose
 *   SESSION_API_TOPOLOGY=container WORKER_CARGO_PROFILE=release pnpm --filter @stackmaster/session-api test:compose
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

const APP_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // …/apps/session-api

async function compose(files, args) {
  return exec("docker", ["compose", ...files, ...args], {
    cwd: APP_DIR,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env },
  });
}

async function runVitest(topology) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["./node_modules/vitest/vitest.mjs", "run", "test/compose"],
      {
        cwd: APP_DIR,
        stdio: "inherit",
        windowsHide: true,
        env: {
          ...process.env,
          SESSION_API_COMPOSE: "1",
          SESSION_API_TOPOLOGY: topology,
        },
      },
    );
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`vitest 退出码 ${code}`));
      }
    });
    child.on("error", reject);
  });
}

const FILES_CONTAINER = ["-f", "compose/deps.yaml", "-f", "compose/app.yaml"];
const FILES_DEPS = ["-f", "compose/deps.yaml"];
const topology = process.env.SESSION_API_TOPOLOGY === "container" ? "container" : "host";

if (topology === "container") {
  console.log("[test:compose] container 拓扑:构建全拓扑镜像(CI 形态;WORKER_CARGO_PROFILE=" +
    (process.env.WORKER_CARGO_PROFILE ?? "debug") + ")……");
  await compose(FILES_CONTAINER, ["up", "-d", "--build", "--wait"]);
  let failed = false;
  try {
    // 拓扑第五元素冒烟:linux vm-worker 二进制(镜像内)可执行、stdio EOF 优雅退出。
    console.log("[test:compose] vm-worker linux 二进制冒烟……");
    await compose(FILES_CONTAINER, ["run", "--rm", "-T", "vm-worker"]);
    await runVitest("container");
  } catch (error) {
    failed = true;
    console.error("[test:compose] 失败:", error.message);
  } finally {
    try {
      await compose(FILES_CONTAINER, ["down", "-v"]);
    } catch {
      // 收尾失败不掩盖测试结果。
    }
  }
  process.exit(failed ? 1 : 0);
} else {
  // host 混合形态(本机):依赖服务拓扑 + session-api 宿主进程 + 本机 worker 二进制。
  if (!existsSync(join(APP_DIR, "dist", "index.js"))) {
    console.error("[test:compose] apps/session-api/dist 不存在:先运行 pnpm --filter @stackmaster/session-api build");
    process.exit(1);
  }
  console.log("[test:compose] host 混合拓扑:拉起依赖服务(compose/deps.yaml)……");
  await compose(FILES_DEPS, ["up", "-d", "--wait"]);
  let code = 0;
  try {
    await runVitest("host");
  } catch (error) {
    console.error("[test:compose] 失败:", error.message);
    code = 1;
  } finally {
    try {
      await compose(FILES_DEPS, ["down"]);
    } catch {
      // 收尾失败不掩盖测试结果。
    }
  }
  process.exit(code);
}

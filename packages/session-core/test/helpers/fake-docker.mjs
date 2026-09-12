/**
 * 假 docker shim(worker 执行形态容器实现的单测承载;WP-66)。
 *
 * 模拟被测代码消费的 docker CLI 子集,docker run 语义对齐:
 *  - `run [flags...] <image> <cmd>`:记录调用 → 以子进程承载假 worker
 *    (FAKE_DOCKER_WORKER 路径;`-e K=V` 旗解析为容器 env)→ CLI 退出码 =
 *    内部进程退出码(信号 → 137,与 docker run 一致);
 *  - `rm -f <name>`:记录调用,exit 0(真实 docker 对已移除容器报错,
 *    连接层忽略 —— shim 侧无需模拟);
 *  - `info` / `image inspect <ref>`:探测应答(exit 0;FAKE_DOCKER_FAIL_IMAGE=1
 *    时 image inspect 以 exit 1 模拟镜像缺失)。
 *
 * 调用记录:本文件同目录 `.fake-docker-log.jsonl`(JSONL;测试读取断言)。
 */

import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOG_PATH = join(dirname(fileURLToPath(import.meta.url)), ".fake-docker-log.jsonl");
const argv = process.argv.slice(2);
const op = argv[0] ?? "";
const record = (entry) => appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);

if (op === "run") {
  record({ op: "run", argv });
  // `-e K=V` 旗 = 容器内显式 env(容器 env 为显式面,零编排器环境继承)。
  const env = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "-e") {
      const pair = argv[index + 1] ?? "";
      const separator = pair.indexOf("=");
      if (separator > 0) {
        env[pair.slice(0, separator)] = pair.slice(separator + 1);
      }
    }
  }
  const worker = process.env.FAKE_DOCKER_WORKER
    ?? join(dirname(fileURLToPath(import.meta.url)), "fake-worker.mjs");
  const child = spawn(process.execPath, [worker], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  child.stdout.pipe(process.stdout);
  process.stdin.pipe(child.stdin);
  child.stderr.pipe(process.stderr);
  child.once("exit", (code, signal) => {
    // docker run 语义:CLI 退出码 = 容器退出码;信号终止 = 137(SIGKILL)。
    process.exit(signal !== null ? 137 : (code ?? 1));
  });
  child.once("error", () => process.exit(125));
} else if (op === "rm") {
  record({ op: "rm", argv });
  process.exit(0);
} else if (op === "info") {
  record({ op: "info", argv });
  process.exit(0);
} else if (op === "image") {
  record({ op: "image", argv });
  // FAKE_DOCKER_FAIL_IMAGE=1 ⇒ image inspect 失败(镜像缺失路径)。
  process.exit(process.env.FAKE_DOCKER_FAIL_IMAGE === "1" ? 1 : 0);
} else {
  process.stderr.write(`fake-docker: 未知子命令 ${op}\n`);
  process.exit(125);
}

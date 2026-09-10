/**
 * 容器门控集成测试的依赖服务生命周期(vitest globalSetup;WP-3)。
 *
 * 纪律:仅当 SESSION_API_IT=1 时连接真实容器——此时先 `docker compose
 * -f compose/deps.yaml up -d --wait` 拉起 PostgreSQL / Redis / MinIO
 * (带 healthcheck,--wait 等待就绪),全部测试结束后 `down` 收尾;
 * 环境门控未开启时不做任何 Docker 操作(单元测试只使用内存实现,
 * 输出明确跳过原因由各测试文件的 describe.skipIf 承担)。
 *
 * 固定本地端口(避免与常用端口冲突):PostgreSQL 15432 / Redis 16379 /
 * MinIO 19000(与 compose/.env.example、compose/integration.env 一致)。
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

const SESSION_API_DIR = fileURLToPath(new URL("../../", import.meta.url));
const COMPOSE_FILE = "compose/deps.yaml";

function compose(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    cwd: SESSION_API_DIR,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env["SESSION_API_IT"] !== "1") {
    // 环境门控未开启:不做任何容器操作(集成测试文件按 skipIf 自行跳过)。
    return undefined;
  }
  await compose(["up", "-d", "--wait"]);
  return async () => {
    await compose(["down"]);
  };
}

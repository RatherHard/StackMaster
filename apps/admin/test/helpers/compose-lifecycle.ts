/**
 * admin 容器门控集成测试的依赖服务生命周期(vitest globalSetup)。
 *
 * 形态与 verifier `test/helpers/compose-lifecycle.ts` 同款:仅当
 * SESSION_API_IT=1 时连接真实容器——`docker compose -f deps.yaml up -d --wait`
 * (PostgreSQL / Redis / MinIO),全部测试结束后 `down`(保留数据卷)。
 * 环境门控未开启时不做任何 Docker 操作(单元测试只使用内存实现;跳过原因
 * 由各集成测试文件的 describe.skipIf 承担)。
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

const ADMIN_DIR = fileURLToPath(new URL("../../", import.meta.url));
const COMPOSE_FILE = fileURLToPath(
  new URL("../../../session-api/compose/deps.yaml", import.meta.url),
);

function compose(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    cwd: ADMIN_DIR,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env["SESSION_API_IT"] !== "1") {
    return undefined;
  }
  await compose(["up", "-d", "--wait"]);
  return async () => {
    await compose(["down"]);
  };
}

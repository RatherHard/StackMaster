/**
 * verifier 容器门控集成测试的依赖服务生命周期(vitest globalSetup;WP-61)。
 *
 * 形态与会话编排 test/persistence/compose-lifecycle.ts 同款:仅当
 * SESSION_API_IT=1 时连接真实容器——先 `docker compose -f deps.yaml
 * up -d --wait`(PostgreSQL / Redis / MinIO;verifier 不消费 Redis,
 * 拉起完整依赖服务以复用同一拓扑),全部测试结束后 `down`(保留数据卷)。
 * 环境门控未开启时不做任何 Docker 操作(单元测试只使用内存实现,跳过
 * 原因由各集成测试文件的 describe.skipIf 承担)。
 *
 * deps.yaml 与 session-api 共用(compose 项目 session-api-deps;固定本地
 * 端口 PostgreSQL 15432 / Redis 16379 / MinIO 19000)——up / down 均幂等,
 * 与 session-api 的同名 globalSetup 在根级覆盖率(SESSION_API_IT=1 全量
 * 形态)下并存安全。
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

const VERIFIER_DIR = fileURLToPath(new URL("../../", import.meta.url));
const COMPOSE_FILE = fileURLToPath(
  new URL("../../../session-api/compose/deps.yaml", import.meta.url),
);

function compose(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    cwd: VERIFIER_DIR,
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

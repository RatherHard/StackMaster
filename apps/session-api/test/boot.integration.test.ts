/**
 * 进程级集成测试(WP-1 完成标准 + WP-4 全量装配):
 *  - fail-closed:非法取值 / 未知保留键 → 非零退出,进程不起监听(无容器
 *    依赖,无条件运行);
 *  - 启动(含持久化栈装配:PG 迁移 / Redis / MinIO 建桶)→ /healthz +
 *    /readyz → 冻结错误形态 → 优雅停机(退出码 0,序列含持久化步骤)。
 *
 * 触发通道按平台分支:POSIX 投递真实 SIGTERM;Windows 无信号投递
 * (process.kill 等价 TerminateProcess,处理器不运行),以 IPC `shutdown`
 * 消息触发同一停机序列(shutdown.ts / D-API-9)。
 *
 * 容器门控:全量装配的启动路径依赖 PostgreSQL / Redis / MinIO(compose
 * 依赖服务),仅在 SESSION_API_IT=1(test:integration 入口)运行;否则跳过
 * 并输出原因(与 WP-3 持久化集成测试同一门控纪律)。
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const IT_ENABLED = process.env["SESSION_API_IT"] === "1";
const SKIP_REASON =
  "跳过原因:SESSION_API_IT != 1(全量装配后的启动路径 fail-closed 依赖存储容器;" +
  "入口 pnpm --filter @stackmaster/session-api test:integration)";

/**
 * 全部必备键的测试专用值(WP-2 签发面 + WP-3 持久化面;与
 * test/config.test.ts 的 REQUIRED_WP3 同值域——合成密钥,非真实凭据)。
 * fail-closed 不削弱:缺失必备键的拒绝路径仍由下方两个用例独立覆盖。
 */
const REQUIRED_WP3_ENV: Record<string, string> = {
  SESSION_API_SIGNING_KEY: [
    "-----BEGIN PRIVATE KEY-----",
    "MC4CAQAwBQYDK2VwBCIEIK11DLj8nDBqdChkWTmwkhU/CGIjEA3JdufHWQshc6nr",
    "-----END PRIVATE KEY-----",
  ].join("\n"),
  SESSION_API_HOST_BACKEND_TOKEN: "host-backend-test-token-0123456789",
  SESSION_API_POSTGRES_URL: "postgres://stackmaster:stackmaster-dev@127.0.0.1:15432/session_api",
  SESSION_API_REDIS_URL: "redis://127.0.0.1:16379/0",
  SESSION_API_MINIO_ENDPOINT: "127.0.0.1",
  SESSION_API_MINIO_PORT: "19000",
  SESSION_API_MINIO_ACCESS_KEY: "stackmaster-dev",
  SESSION_API_MINIO_SECRET_KEY: "stackmaster-dev-secret",
  SESSION_API_SNAPSHOT_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
};

interface SpawnedServer {
  child: ChildProcess;
  stdoutLines: string[];
  stderrLines: string[];
  exited: Promise<{ code: number | null; signal: string | null }>;
}

function spawnServer(extraEnv: Record<string, string>): SpawnedServer {
  // 测试门控开关不进子进程:SESSION_API_IT 以保留前缀命名,会触发子进程的
  // "未知保留键"配置闸(按设计 fail-closed),此处显式剥离。
  const { ["SESSION_API_IT"]: _gated, ...inheritedEnv } = process.env;
  void _gated;
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...inheritedEnv, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  void createInterface({ input: child.stdout! }).on("line", (line) => stdoutLines.push(line));
  void createInterface({ input: child.stderr! }).on("line", (line) => stderrLines.push(line));
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));
  return { child, stdoutLines, stderrLines, exited };
}

async function parsedStdoutLines(server: SpawnedServer): Promise<Array<Record<string, unknown>>> {
  return server.stdoutLines
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("进程启动与 fail-closed", () => {
  const spawned: SpawnedServer[] = [];
  afterEach(() => {
    for (const server of spawned.splice(0)) {
      server.child.kill();
    }
  });

  it("非法配置值拒绝启动:非零退出、无监听、stderr 携带校验失败消息(仅字段名,无字段值)", async () => {
    const server = spawnServer({ SESSION_PROTOCOL_N1_WINDOW_DAYS: "-1" });
    spawned.push(server);
    const { code } = await server.exited;
    expect(code).toBe(1);
    const stderrText = server.stderrLines.join("\n");
    expect(stderrText).toContain("配置校验失败");
    expect(stderrText).toContain("SESSION_PROTOCOL_N1_WINDOW_DAYS");
    expect(stderrText).not.toContain("-1");
    expect(server.stdoutLines.join("\n")).not.toContain("session-api listening");
  }, 20_000);

  it("未知保留键拒绝启动(拼写错误不静默落默认值)", async () => {
    const server = spawnServer({ SESSION_API_IDEMPOTENCY_TTL: "300" });
    spawned.push(server);
    const { code } = await server.exited;
    expect(code).toBe(1);
    expect(server.stderrLines.join("\n")).toContain("SESSION_API_IDEMPOTENCY_TTL");
  }, 20_000);

  it("全量装配启动 → 健康检查 + readiness → 优雅停机(退出码 0,序列含持久化步骤)", async () => {
    if (!IT_ENABLED) {
      console.warn(`  ${SKIP_REASON}`);
      return;
    }
    const server = spawnServer({ ...REQUIRED_WP3_ENV, NODE_ENV: "test", SESSION_API_PORT: "0" });
    spawned.push(server);

    try {
      await vi.waitFor(async () => {
        const lines = await parsedStdoutLines(server);
        const listening = lines.find((entry) => entry["msg"] === "session-api listening");
        if (!listening) {
          throw new Error("尚未监听");
        }
      }, { timeout: 30_000, interval: 100 });
    } catch (error) {
      // 诊断面:启动超时时转储子进程输出(含启动失败原因),不吞错。
      console.error("stdout:", server.stdoutLines.join("\n").slice(0, 4000));
      console.error("stderr:", server.stderrLines.join("\n").slice(0, 4000));
      throw error;
    }

    const lines = await parsedStdoutLines(server);
    const listening = lines.find((entry) => entry["msg"] === "session-api listening");
    const port = listening?.["port"] as number;
    expect(port).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${port}`;

    // liveness:恒 200(WP-1 语义不变)。
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    // readiness:PG / Redis / MinIO 全部可达 → 200(WP-4 全量装配)。
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ok" });

    const unknownRoute = await fetch(`${base}/not-a-route`);
    expect(unknownRoute.status).toBe(404);
    expect(await unknownRoute.json()).toEqual({
      code: "invalid_input_format",
      message: "resource not found",
    });

    // 生命周期路由已装配:未认证访问业务路由 → 认证统一 401 形态。
    const guarded = await fetch(`${base}/sessions/projection-sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "sync_projection", protocolVersion: 1, payload: { sessionId: "sess-x" } }),
    });
    expect(guarded.status).toBe(401);
    expect(await guarded.json()).toEqual({
      code: "invalid_input_format",
      message: "authentication failed",
    });

    if (process.platform === "win32") {
      const delivered = server.child.send("shutdown");
      expect(delivered).toBe(true);
    } else {
      server.child.kill("SIGTERM");
    }
    const { code, signal } = await server.exited;
    expect(code).toBe(0);
    expect(signal).toBeNull();

    // 停机序列可解释性:started → 步骤序(stop-accepting → 在途落盘 →
    // close-postgres → close-redis → flush-logs)→ completed。
    const stdoutText = server.stdoutLines.join("\n");
    const indexOf = (needle: string): number => stdoutText.indexOf(needle);
    expect(indexOf("graceful shutdown started")).toBeGreaterThan(-1);
    expect(
      indexOf("shutdown step started") < indexOf("graceful shutdown completed"),
    ).toBe(true);
    expect(indexOf("stop-accepting-requests")).toBeLessThan(indexOf("flush-live-sessions"));
    expect(indexOf("flush-live-sessions")).toBeLessThan(indexOf("close-postgres"));
    expect(indexOf("close-postgres")).toBeLessThan(indexOf("close-redis"));
    expect(indexOf("close-redis")).toBeLessThan(indexOf("flush-logs"));
    expect(indexOf("graceful shutdown completed")).toBeGreaterThan(-1);
  }, 60_000);
});

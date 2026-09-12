/**
 * Compose 拓扑装配(WP-7;test:compose 的环境门控与生命周期)。
 *
 * 两种拓扑形态(D-API-65):
 *  - `container`(CI 形态,完整 linux 拓扑):compose/app.yaml 全拓扑已由
 *    test/compose/run.mjs 拉起;BASE_URL = 发布端口 13000;重启 =
 *    docker compose restart session-api;
 *  - `host`(本机 Windows 降级形态):依赖服务经 deps.yaml 拉起,session-api
 *    以宿主进程(node dist/index.js)运行,vm-worker 用本机二进制
 *    (STACKMASTER_WORKER_BIN 或 vm-engine/target 产物);重启 = 受控终止
 *    (SIGTERM → 优雅停机冲刷)后重新拉起。
 *
 * 机检采集面(TrafficRecorder):HTTP 响应体 + WSS 入站帧全量录制,
 * 供 scanCrossDomainPayloads 零命中断言(通道上只有公开投影)。
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { HOST_BACKEND_TOKEN, REQUIRED_AUTH_ENV } from "../../helpers/required-env.js";
import { IT_CONFIG } from "../../persistence/helpers/it.js";

const APP_DIR = fileURLToPath(new URL("../../../", import.meta.url)); // apps/session-api
const exec = promisify(execFile);

/** 拓扑形态(SESSION_API_TOPOLOGY=container | host;缺省 host 本机形态)。 */
export const TOPOLOGY: "container" | "host" =
  process.env["SESSION_API_TOPOLOGY"] === "container" ? "container" : "host";

/** 环境门控(test:compose 设 SESSION_API_COMPOSE=1;pnpm test 恒跳过)。 */
export const COMPOSE_ENABLED = process.env["SESSION_API_COMPOSE"] === "1";

export const SKIP_REASON =
  "跳过原因:SESSION_API_COMPOSE != 1(Compose 拓扑集成测试仅在 test:compose 入口运行:" +
  "pnpm --filter @stackmaster/session-api test:compose)";

export const BASE_URL = process.env["SESSION_API_BASE_URL"] ?? (
  TOPOLOGY === "container" ? "http://127.0.0.1:13000" : "http://127.0.0.1:13117"
);
export const BASE_HOST = new URL(BASE_URL).hostname;
export const BASE_PORT = Number(new URL(BASE_URL).port ?? "80");
export const WSS_PATH = "/sessions/channel";
/** 变更方法必携白名单 Origin(CSRF 闸,D-API-17;与 compose/app.yaml 一致)。 */
export const ALLOWED_ORIGIN = "http://localhost:13000";
export { HOST_BACKEND_TOKEN };
export { IT_CONFIG };

/** compose 文件对(容器拓扑;与 package.json scripts 一致)。 */
const COMPOSE_FILES = ["-f", "compose/deps.yaml", "-f", "compose/app.yaml"];

function compose(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec("docker", ["compose", ...COMPOSE_FILES, ...args], {
    cwd: APP_DIR,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env }, // WORKER_CARGO_PROFILE 透传(CI=release)
  });
}

/** 轮询 /healthz 至 200(容器重启 / 宿主进程重启共用)。 */
export async function waitForHealth(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "never";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/healthz`);
      if (response.ok) {
        return;
      }
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`等待 session-api 就绪超时(${lastError})`);
}

/** 从 compose/integration.env 提取宿主进程环境(键值对解析,非 shell)。 */
function integrationEnv(): Record<string, string> {
  const path = join(APP_DIR, "compose", "integration.env");
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return values;
}

/** 解析本机 vm-worker 二进制(env 优先;沿 ensureWorkerBinary 的产物解析序)。 */
function localWorkerBinary(): string {
  const fromEnv = process.env["STACKMASTER_WORKER_BIN"];
  if (fromEnv !== undefined && existsSync(fromEnv)) {
    return fromEnv;
  }
  const exe = process.platform === "win32" ? "vm-worker.exe" : "vm-worker";
  for (const profile of ["debug", "release"] as const) {
    const candidate = join(APP_DIR, "..", "..", "vm-engine", "target", profile, exe);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "host 拓扑需要本机 vm-worker 二进制(STACKMASTER_WORKER_BIN 或 vm-engine/target/{debug,release});" +
      "或改用完整容器拓扑:SESSION_API_TOPOLOGY=container test:compose",
  );
}

/** 宿主 session-api 进程(host 拓扑;container 拓扑为 no-op)。 */
export class HostProcess {
  #child: ChildProcess | null = null;

  get running(): boolean {
    return this.#child !== null && this.#child.exitCode === null;
  }

  async start(): Promise<void> {
    if (TOPOLOGY !== "host") {
      return; // 容器拓扑:进程由 compose 管理。
    }
    await this.#spawn();
    await waitForHealth();
  }

  async #spawn(): Promise<void> {
    const dist = join(APP_DIR, "dist", "index.js");
    if (!existsSync(dist)) {
      throw new Error("apps/session-api/dist 不存在:先运行 pnpm --filter @stackmaster/session-api build");
    }
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...integrationEnv(),
      // 认证面必备键(integration.env 只承载持久化面;签发密钥为进程内生成的
      // 合成 PEM,与 test/helpers/required-env.ts 同一 fixture)。
      ...REQUIRED_AUTH_ENV,
      SESSION_API_HOST: "127.0.0.1",
      SESSION_API_PORT: String(BASE_PORT),
      SESSION_API_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
      STACKMASTER_WORKER_BIN: localWorkerBinary(),
    };
    // 门控 / 拓扑选择键不是 session-api 的登记配置键(保留键闸会拒绝启动)。
    delete env["SESSION_API_IT"];
    delete env["SESSION_API_COMPOSE"];
    delete env["SESSION_API_TOPOLOGY"];
    this.#child = spawn(process.execPath, [dist], {
      cwd: APP_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    // 宿主进程日志(pino 走 stdout)与 stderr 都转发,便于拓扑级排障;
    // 转发内容与容器形态的 `docker compose logs` 对齐。
    this.#child.stdout?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[session-api:host] ${chunk}`);
    });
    this.#child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[session-api:host] ${chunk}`);
    });
  }

  /** 重启:SIGTERM(优雅停机:flush-live-sessions 冲刷恢复点)→ 重新拉起。 */
  async restart(): Promise<void> {
    if (TOPOLOGY !== "host") {
      await compose(["restart", "session-api"]);
      await waitForHealth();
      return;
    }
    const child = this.#child;
    if (child === null) {
      throw new Error("宿主进程未运行");
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 15_000)),
    ]);
    await this.#spawn();
    await waitForHealth();
  }

  async stop(): Promise<void> {
    if (TOPOLOGY !== "host" || this.#child === null) {
      return;
    }
    const child = this.#child;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 15_000)),
    ]);
    this.#child = null;
  }
}

/** verifier 运维面地址(compose 发布端口 13100;host 拓扑同端口)。 */
export const VERIFIER_BASE_URL = process.env["VERIFIER_BASE_URL"] ?? "http://127.0.0.1:13100";

/** 轮询 verifier /healthz 至 200(容器重启 / 宿主进程重启共用)。 */
export async function waitForVerifierHealth(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "never";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${VERIFIER_BASE_URL}/healthz`);
      if (response.ok) {
        return;
      }
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`等待 verifier 就绪超时(${lastError})`);
}

/**
 * 宿主 verifier 进程(host 拓扑;container 拓扑 start/stop 为 no-op,由
 * compose 管理;restart 两形态分别为 compose restart / 受控终止后重拉)。
 * 裁决闭环的队列持久性测试消费其 restart:停机 → 提交(pending 行落库)→
 * 重启 → 裁决落库(裁决队列以 PG 承载,跨进程不丢)。
 */
export class VerifierProcess {
  #child: ChildProcess | null = null;

  async start(): Promise<void> {
    if (TOPOLOGY !== "host") {
      await waitForVerifierHealth();
      return; // 容器拓扑:进程由 compose 管理。
    }
    await this.#spawn();
    await waitForVerifierHealth();
  }

  async #spawn(): Promise<void> {
    const verifierDir = join(APP_DIR, "..", "verifier");
    const dist = join(verifierDir, "dist", "index.js");
    if (!existsSync(dist)) {
      throw new Error("apps/verifier/dist 不存在:先运行 pnpm --filter @stackmaster/verifier build");
    }
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...integrationEnv(),
      STACKMASTER_WORKER_BIN: localWorkerBinary(),
    };
    // 门控 / 拓扑选择键不是 verifier 的登记配置键(保留键闸会拒绝启动)。
    delete env["SESSION_API_IT"];
    delete env["SESSION_API_COMPOSE"];
    delete env["SESSION_API_TOPOLOGY"];
    this.#child = spawn(process.execPath, [dist], {
      cwd: verifierDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child.stdout?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[verifier:host] ${chunk}`);
    });
    this.#child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[verifier:host] ${chunk}`);
    });
  }

  async restart(): Promise<void> {
    if (TOPOLOGY !== "host") {
      await compose(["restart", "verifier"]);
      await waitForVerifierHealth();
      return;
    }
    const child = this.#child;
    if (child === null) {
      // stop() 之后的 restart = start(停机窗口语义:队列行持久于 PG)。
      await this.#spawn();
      await waitForVerifierHealth();
      return;
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 15_000)),
    ]);
    await this.#spawn();
    await waitForVerifierHealth();
  }

  async stop(): Promise<void> {
    if (TOPOLOGY !== "host") {
      await compose(["stop", "verifier"]);
      return;
    }
    const child = this.#child;
    if (child === null) {
      return;
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 15_000)),
    ]);
    this.#child = null;
  }
}

/** 机检流量录制器(HTTP 响应体 + WSS 入站帧;扫描器输入)。 */
export class TrafficRecorder {
  readonly httpBodies: unknown[] = [];
  readonly wssFrames: unknown[] = [];

  recordHttp(body: unknown): void {
    this.httpBodies.push(body);
  }

  recordWss(frameText: string): void {
    try {
      this.wssFrames.push(JSON.parse(frameText));
    } catch {
      this.wssFrames.push({ raw: frameText });
    }
  }
}

/** JSON 请求 helper(fetch;Cookie / Origin / bearer 显式呈递)。 */
export async function postJson(
  recorder: TrafficRecorder,
  path: string,
  body: unknown,
  options: { cookie?: string; bearer?: string } = {},
): Promise<{ status: number; body: unknown; setCookie: string | null }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: ALLOWED_ORIGIN,
  };
  if (options.cookie !== undefined) {
    headers["cookie"] = options.cookie;
  }
  if (options.bearer !== undefined) {
    headers["authorization"] = `Bearer ${options.bearer}`;
  }
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let parsed: unknown;
  const text = await response.text();
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = text;
  }
  recorder.recordHttp(parsed);
  const setCookie = response.headers.get("set-cookie");
  return { status: response.status, body: parsed, setCookie };
}

/** 从 Set-Cookie 提取凭证值(HttpOnly Cookie 呈递,D-API-12)。 */
export function credentialFromSetCookie(setCookie: string | null): string {
  if (setCookie === null) {
    throw new Error("响应缺少 Set-Cookie(凭证交付面缺失)");
  }
  const separator = setCookie.indexOf("=");
  return setCookie.slice(separator + 1, setCookie.indexOf(";", separator));
}

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
 * **会话建立入口 = 启动地址链(WP-96)**;旧链(`POST /auth/embed-tokens` + 四键
 * `create_session` 载荷)已随嵌入协议面退役。见文件末「启动地址链」段。
 *
 * 机检采集面(TrafficRecorder):HTTP 响应体 + WSS 入站帧全量录制,
 * 供 scanCrossDomainPayloads 零命中断言(通道上只有公开投影)。
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect } from "vitest";

import { HOST_BACKEND_TOKEN, REQUIRED_AUTH_ENV } from "../../helpers/required-env.js";
import { SESSION_CREDENTIAL_COOKIE_NAME } from "../../../src/auth/cookie.js";
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

// ── 启动地址链(WP-96;D-LT-1 ~ D-LT-5,契约 `docs/contracts/启动票据协议.md`)──
//
// | 步骤 | 旧链(已退役) | 新链(本段) |
// |---|---|---|
// | 授权取得 | `POST /auth/embed-tokens` → embed token | `POST /auth/launch-tickets` → **一次性启动地址** |
// | 授权落地 | `create_session` 载荷带 token(四键) | `GET <launchUrl>` 换票 → `Set-Cookie: sm_launch_grant` |
// | 建会话 | 四键载荷 | **恰两键**载荷(`protocolVersion: 2`),授权来自 Cookie |
//
// **租户从哪来**:新链的 `tenantId` 由服务端在**签发时**从「宿主凭证 ×
// `SESSION_API_HOST_TENANTS` 白名单」派生(请求体连 `tenantId` 位都没有)⇒
// 本套件里所有会话的租户恒等于该白名单的**锚租户**(字典序最小项),而
// `create_session` 的题目装载按 `(challengeId, version, tenantId)` **强制过滤**
// (`session-manager.ts#createSessionReserved`)⇒ **登记题目必须用这个租户**
// (签发期的「已发布」校验是跨租户公开面,不构成兜底)。故此处把锚租户导成常量,
// 供「登记租户」与「PG 侧按租户查询」共用同一个值(单点,避免两处各写一份)。

/** 启动票据签发端点(契约常量同值;此处按字面量写入,不引契约包以免跨包静态依赖)。 */
export const LAUNCH_TICKET_ISSUANCE_ROUTE = "/auth/launch-tickets";
/** 授权凭证 Cookie 名(契约 §四;非秘密)。 */
export const LAUNCH_GRANT_COOKIE_NAME = "sm_launch_grant";
/** 会话动作协议版本(WP-90 起 v2;`create_session` 载荷恰两键)。 */
export const SESSION_ACTION_PROTOCOL_VERSION = 2;

/**
 * 锚租户 = `SESSION_API_HOST_TENANTS` 的字典序最小项(与 `config.ts#splitHostTenants`
 * 同规则:去空白 → 去重 → 排序 → 取首)。
 *
 * 取值序:测试进程环境(容器拓扑下由 `test/compose/run.mjs` 显式注入)> 缺省
 * `host-scores-tenant`(compose/app.yaml 与 compose/integration.env 的同值;
 * 两处任一改动而另一处未改时,本套件会以「签发 404 / 建会话 422」硬失败,
 * 不会静默跑在别的租户上)。
 */
export const SESSION_TENANT_ID: string = anchorTenantFrom(
  process.env["SESSION_API_HOST_TENANTS"] ?? "host-scores-tenant",
);

function anchorTenantFrom(value: string): string {
  const tenants = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const unique = [...new Set(tenants)].sort();
  if (unique.length === 0) {
    throw new Error(
      "SESSION_API_HOST_TENANTS 为空:启动地址链的锚租户无从派生(签发面本身也会 404 fail-closed)",
    );
  }
  return unique[0]!;
}

/** 换票响应(302 + 授权凭证 Cookie);`node:http` 客户端形态见 `redeemLaunchAddress`。 */
interface RedeemOutcome {
  readonly status: number;
  readonly location: string | null;
  readonly setCookie: readonly string[];
}

/**
 * 取换票响应(**不跟随 302**)。
 *
 * ⚠ **为什么不用 `fetch`**:Node 的 fetch(undici)**强制改写** `Sec-Fetch-Mode`
 * —— 实测(2026-09-19)服务端收到的是 `cors`,即使调用方显式传 `navigate`
 * (`fetch(url, { headers: { "sec-fetch-mode": "navigate" } })` → 服务端
 * `req.headers["sec-fetch-mode"] === "cors"`)。而换票路由的第一道闸**恰是**
 * 「`Sec-Fetch-Mode` 必须逐字等于 `navigate`」(D-LT-2:拒绝子资源 / 嵌入式换票)
 * ⇒ **只有非 fetch 客户端**才能发出该头,故这里落到 `node:http`/`node:https`
 * (它们也天然不跟随重定向)。浏览器侧由顶层导航自带该头,不需要这段代码。
 *
 * 该行为由 `test/compose/launch-chain.dry-run.test.ts` 机检锁定(换成 fetch 即红)。
 */
function redeemLaunchAddress(launchUrl: string): Promise<RedeemOutcome> {
  const url = new URL(launchUrl);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<RedeemOutcome>((resolve, reject) => {
    const request = send(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === "" ? undefined : url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          // 顶层导航语义(D-LT-2 ⓪);浏览器由 `page.goto` 自带,node 侧手工补。
          "sec-fetch-mode": "navigate",
          accept: "text/html",
        },
      },
      (response) => {
        response.resume(); // 丢弃响应体(换票响应只是 302 / 401)
        resolve({
          status: response.statusCode ?? 0,
          location: response.headers.location ?? null,
          setCookie: response.headers["set-cookie"] ?? [],
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/** 从多枚 Set-Cookie 头里取指定 Cookie 的值。 */
function cookieFromSetCookieHeaders(
  headers: readonly string[],
  name: string,
): string | undefined {
  for (const header of headers) {
    const pair = header.split(";")[0]!;
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    if (pair.slice(0, separator).trim() === name) {
      const value = pair.slice(separator + 1).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

/** 启动地址链建立起来的会话(供用例继续以会话凭证驱动 REST / WSS)。 */
export interface LaunchedSession {
  readonly sessionId: string;
  /** 会话凭证值(`sm_session_credential` 的 Cookie 值)。 */
  readonly cookie: string;
  /** `create_session` 响应的 `payload.revision`(新会话恒 0;调用方按需断言)。 */
  readonly revision: number;
  /** 服务端签发的启动地址(含一次性票据;**不得**写进断言消息 / 归档)。 */
  readonly launchUrl: string;
}

/**
 * 走**启动地址链**建立会话(WP-96 起的**唯一**会话建立入口)。
 *
 * 旧链在用例里展开为三处断言(`签发 201` / `create_session 201` / `Set-Cookie`
 * 存在),本函数把它们**原样搬进链路内部**并再加两条新链独有的断言:
 *  1. 签发响应体**恰两键** `{expiresAt, launchUrl}`(契约 §2.2);
 *  2. `launchUrl` 的 origin = `SESSION_API_PUBLIC_ORIGIN`(= 拓扑 BASE_URL 的源)
 *     —— 换票闸之一是「绑定逐字一致」,而这里的地址由服务端配置派生,**永不采信
 *     请求头**(Host 头注入面);origin 不符即配置错位,必须红而不是静默换源;
 *  3. 换票响应 **302 + `Set-Cookie: sm_launch_grant`**(且 Location 不含 `?t=`,
 *     即票据被 302 抹除);
 *  4. `create_session` 201 且响应 `Set-Cookie` 含会话凭证。
 *
 * 零删除:旧链的三处断言全部在场,只是从「每个用例各写一遍」收敛到本函数一处。
 */
export async function createSessionViaLaunchAddress(
  recorder: TrafficRecorder,
  challengeId: string,
  challengeVersion: string,
): Promise<LaunchedSession> {
  // ── ① 签发(宿主凭证;请求体恰两键,无租户位)──
  const issuance = await postJson(
    recorder,
    LAUNCH_TICKET_ISSUANCE_ROUTE,
    { challengeId, version: challengeVersion },
    { bearer: HOST_BACKEND_TOKEN },
  );
  expect(
    issuance.status,
    `启动票据签发应回 201(实测 ${issuance.status};404 = 签发面未启用/题目未发布/白名单外租户,` +
      "401 = 宿主凭证不符)",
  ).toBe(201);
  const issuedBody = issuance.body as Record<string, unknown>;
  expect(
    Object.keys(issuedBody).sort(),
    "签发响应体应恰两键 {expiresAt, launchUrl}(契约 §2.2)",
  ).toEqual(["expiresAt", "launchUrl"]);
  const launchUrl = issuedBody["launchUrl"];
  if (typeof launchUrl !== "string" || launchUrl === "") {
    throw new Error("签发响应缺少 launchUrl(契约恰两键)");
  }

  // ── ② 换票(顶层导航语义 + 不跟随 302;见 redeemLaunchAddress 的「为什么不用 fetch」)──
  const expectedOrigin = new URL(BASE_URL).origin;
  expect(
    new URL(launchUrl).origin,
    `launchUrl 的 origin 应等于服务端配置的 SESSION_API_PUBLIC_ORIGIN(${expectedOrigin});` +
      `实测 ${launchUrl}。两处不同源 = 拓扑配置错位(换票用例会打到另一个源)`,
  ).toBe(expectedOrigin);
  const redeemed = await redeemLaunchAddress(launchUrl);
  expect(redeemed.status, `换票应回 302(实测 ${redeemed.status};401 = 非导航语义/票据无效)`).toBe(302);
  expect(
    redeemed.location ?? "",
    "换票 302 的 Location 必须是**不含票据**的干净路径(方案 A:票据即刻脱离地址栏)",
  ).not.toContain("?t=");
  const grant = cookieFromSetCookieHeaders(redeemed.setCookie, LAUNCH_GRANT_COOKIE_NAME);
  if (grant === undefined) {
    throw new Error(
      `换票响应缺少 ${LAUNCH_GRANT_COOKIE_NAME} Cookie(Set-Cookie 交付面缺失):` +
        `${JSON.stringify(redeemed.setCookie)}`,
    );
  }

  // ── ③ 建会话(v2 恰两键 payload;授权只来自上一步的 Cookie)──
  const created = await postJson(
    recorder,
    "/sessions",
    {
      command: "create_session",
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
      payload: { challengeId, challengeVersion },
    },
    { cookie: `${LAUNCH_GRANT_COOKIE_NAME}=${grant}` },
  );
  expect(
    created.status,
    `create_session 应回 201(实测 ${created.status};422 = 该租户下题目未登记,` +
      `会话租户恒为锚租户 ${SESSION_TENANT_ID})`,
  ).toBe(201);
  const createdBody = created.body as { payload: { sessionId: string; revision: number } };
  const sessionId = createdBody.payload.sessionId;
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new Error("create_session 响应缺少 payload.sessionId");
  }
  return {
    sessionId,
    cookie: credentialFromSetCookie(created.setCookie),
    revision: createdBody.payload.revision,
    launchUrl,
  };
}

/**
 * 显式收尾一批会话(`close_session`;套件 `afterAll` 调用)。
 *
 * **为什么新链下必须做**(WP-96:这是锚租户带来的**跨套件**新约束):
 *  - 会话租户 = 锚租户(见上)= **同一拓扑下的两个 compose 套件共用同一个会话
 *    租户**,而 `SESSION_API_MAX_CONCURRENT_SESSIONS_PER_TENANT`(缺省 **8**)是
 *    租户级硬护栏,超限即 **429 `budget_exhausted`**;
 *  - 会话只在**通道关闭后**进入断线保持窗口(`SESSION_API_DISCONNECT_KEEPALIVE_SECONDS`
 *    缺省 **300 s**),窗口到期才回收 ⇒ 套件 A 结束后其会话最长还占 5 分钟预算,
 *    紧随其后的套件 B 起会话就可能撞顶(旧链每套件一个随机租户,**不存在**跨套件
 *    争用;这正是「新链把租户收窄成一个」的直接后果,如实登记);
 *  - **best-effort**:收尾失败只吞掉(不改变测试结论)——会话仍会被断线保持到期
 *    回收兜住,故失败不会造成泄漏性后果,但会拖慢下一个套件。
 */
export async function releaseSessions(
  recorder: TrafficRecorder,
  sessions: readonly { readonly sessionId: string; readonly cookie: string }[],
): Promise<void> {
  for (const session of sessions) {
    try {
      const response = await postJson(recorder, "/sessions/close", {
        command: "close_session",
        protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
        payload: { sessionId: session.sessionId },
      }, { cookie: `${SESSION_CREDENTIAL_COOKIE_NAME}=${session.cookie}` });
      if (response.status !== 200) {
        process.stderr.write(
          `[compose] 会话收尾返回 ${response.status}(sessionId=${session.sessionId};best-effort,继续)\n`,
        );
      }
    } catch (error) {
      process.stderr.write(
        `[compose] 会话收尾失败(best-effort,继续):${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}

/**
 * 启动地址链的**协议形态机检**(dry-run;WP-96)。
 *
 * ## 边界声明(必读 —— 这不是真机测试)
 *
 * 本文件跑在一个**自建 stub** 上,断言的是「**我们客户端的链路形状**」,不是
 * 「真实 session-api 的行为」。真实换票 / 建会话链路的实跑归
 * `test/compose/{compose-full-chain,mvp-challenge-set}.compose.integration.test.ts`
 * (门控 `SESSION_API_COMPOSE=1`;**本机 Docker 引擎不可达 ⇒ 未实测**,如实登记)。
 *
 * 它存在的理由:链路上有三件事**会静默跑错**(不报错、只是走到另一条语义上),
 * 只有把请求**实际发出去**才能锁住:
 *
 *  1. **换票必须带 `Sec-Fetch-Mode: navigate`** —— 该头是换票路由的第一道闸
 *     (D-LT-2 ⓪:拒绝子资源 / 嵌入式换票)。浏览器由顶层导航自带,**node 侧必须
 *     手工补**;补漏了会得到 401,而不是"少一个头"这种无害结果。
 *     ⚠ 且**不能用 `fetch` 补**:本机实测(Node 24.20.0)undici **强制改写**
 *     该头为 `cors`(服务端收到的是 `cors`),故 `helpers/topology.ts` 的换票步
 *     落到 `node:http`。本文件第 2 例即锁定「实际到达服务端的是 `navigate`」——
 *     它同时是「有人把 node:http 换成 fetch」时的红灯(那个改法在本机 Node 上
 *     必然 401,而 401 与"环境不对"长得一样,容易被误判)。
 *  2. **必须 `redirects: 0` / 不跟随 302** —— 授权凭证经 `Set-Cookie` 交付,跟随
 *     重定向就拿不到凭证材料(Node 侧手工解析;k6 侧同理)。
 *  3. **`create_session` 必须是 v2 恰两键 payload + 授权凭证 Cookie** ——
 *     授权不在载荷里(D-LT-5 第 2 条),载荷只提供导航信息。
 *
 * ## 与真实面的一致性来自哪里
 *
 * stub 的闸**逐条对应真实路由的闸**(launch-routes.ts:宿主凭证 → 签发面启用 →
 * 请求体恰两键 → 201 恰两键响应;换票:导航头 → 票据形态 → 单次消费 → 302 +
 * `Set-Cookie`;session-routes.ts v2:`sm_launch_grant` Cookie → payload 与凭证
 * 逐字一致 → 201 + 会话凭证 Cookie)。差异只在:**没有 Redis / PG / 题目注册表**,
 * 且 401 的"三态同形"未复现(那是服务端机检项,不在本文件的价值面)。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** 冻结常量(与 helpers/topology.ts 同值;按字面量写以免循环依赖)。 */
const LAUNCH_GRANT_COOKIE = "sm_launch_grant";
const SESSION_CREDENTIAL_COOKIE = "sm_session_credential";
const CHALLENGE_ID = "chal-dry-run";
const CHALLENGE_VERSION = "1.2.3";

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly secFetchMode: string | undefined;
  readonly origin: string | undefined;
  readonly cookie: string | undefined;
  readonly body: unknown;
}

/** 已消费票据集合(stub 复现「单次消费」语义)。 */
const consumedTickets = new Set<string>();
const requests: RecordedRequest[] = [];
/** 故障注入开关:换票一律 401(用于验证"失败链路上不得继续建会话")。 */
let rejectRedeem = false;

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let text = "";
    request.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(text) as unknown);
      } catch {
        resolve(text);
      }
    });
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(text);
}

let hostBackendToken = "";

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://stub.invalid");
  const body = request.method === "POST" ? await readBody(request) : undefined;
  requests.push({
    method: request.method ?? "",
    path: url.pathname,
    query: url.search,
    secFetchMode: request.headers["sec-fetch-mode"] as string | undefined,
    origin: request.headers.origin,
    cookie: request.headers.cookie,
    body,
  });

  // ── ① 签发(launch-routes.ts:宿主凭证 → 签发面启用 → 请求体恰两键)──
  if (request.method === "POST" && url.pathname === "/auth/launch-tickets") {
    if (request.headers.authorization !== `Bearer ${hostBackendToken}`) {
      send(response, 401, { code: "invalid_input_format", message: "authentication failed" });
      return;
    }
    const keys = body !== null && typeof body === "object" ? Object.keys(body as object).sort() : [];
    if (keys.join(",") !== "challengeId,version") {
      send(response, 400, { code: "invalid_input_format", message: "invalid request body" });
      return;
    }
    const { challengeId, version } = body as { challengeId: string; version: string };
    const ticket = "D".repeat(22); // 形态与 LAUNCH_TICKET_TOKEN_LENGTH 同值
    consumedTickets.add(ticket);
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    send(response, 201, {
      launchUrl: `${origin}/app/c/${encodeURIComponent(challengeId)}/${encodeURIComponent(version)}?t=${ticket}`,
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    });
    return;
  }

  // ── ② 换票(导航语义 → 票据形态 → 单次消费 → 302 + Set-Cookie)──
  if (request.method === "GET" && url.pathname.startsWith("/app/c/")) {
    if (rejectRedeem || request.headers["sec-fetch-mode"] !== "navigate") {
      send(response, 401, { code: "invalid_input_format", message: "authentication failed" });
      return;
    }
    const ticket = url.searchParams.get("t");
    if (ticket === null || ticket.length === 0 || !consumedTickets.has(ticket)) {
      send(response, 401, { code: "invalid_input_format", message: "authentication failed" });
      return;
    }
    consumedTickets.delete(ticket); // 单次消费(CAS 语义的 stub 表达)
    response.writeHead(302, {
      location: url.pathname,
      "set-cookie": `${LAUNCH_GRANT_COOKIE}=grant-${ticket}; Path=/sessions; HttpOnly`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    response.end();
    return;
  }

  // ── ③ 建会话(session-routes.ts:v2 恰两键 payload + 授权凭证 Cookie)──
  if (request.method === "POST" && url.pathname === "/sessions") {
    const envelope = body as { command?: string; protocolVersion?: number; payload?: Record<string, unknown> };
    if (envelope?.command !== "create_session" || envelope.protocolVersion !== 2) {
      send(response, 400, { code: "invalid_input_format", message: "invalid request body" });
      return;
    }
    const payloadKeys = Object.keys(envelope.payload ?? {}).sort();
    if (payloadKeys.join(",") !== "challengeId,challengeVersion") {
      send(response, 400, { code: "invalid_input_format", message: "invalid request body" });
      return;
    }
    const grant = (request.headers.cookie ?? "")
      .split(";")
      .map((pair) => pair.trim())
      .find((pair) => pair.startsWith(`${LAUNCH_GRANT_COOKIE}=`));
    if (grant === undefined) {
      send(response, 401, { code: "invalid_input_format", message: "authentication failed" });
      return;
    }
    response.writeHead(201, {
      "content-type": "application/json",
      "set-cookie": `${SESSION_CREDENTIAL_COOKIE}=session-credential; Path=/; HttpOnly`,
    });
    response.end(JSON.stringify({ command: "create_session", payload: { sessionId: "sess-dry-run", revision: 0 } }));
    return;
  }

  send(response, 404, { code: "invalid_input_format", message: "resource not found" });
}

const server = createServer((request, response) => {
  void handle(request, response);
});

/** 动态导入的拓扑 helper(BASE_URL 在模块求值时读环境 ⇒ 必须先起 stub)。 */
type TopologyModule = typeof import("./helpers/topology.js");
// `beforeAll` 里赋值(definite assignment:两个用例都在其之后运行)。
let topology!: TopologyModule;
beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  process.env["SESSION_API_BASE_URL"] = `http://127.0.0.1:${port}`;
  process.env["SESSION_API_HOST_TENANTS"] = "dry-run-anchor";
  topology = await import("./helpers/topology.js");
  hostBackendToken = topology.HOST_BACKEND_TOKEN;
});

afterAll(async () => {
  delete process.env["SESSION_API_BASE_URL"];
  delete process.env["SESSION_API_HOST_TENANTS"];
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe("启动地址链 dry-run(协议形态机检;非真机)", () => {
  it("完整链:签发(恰两键体 / 201 恰两键响应)→ 换票(navigate + 不跟随 302 + 授权凭证 Cookie)→ create_session v2", async () => {
    const recorder = new topology.TrafficRecorder();
    const launched = await topology.createSessionViaLaunchAddress(recorder, CHALLENGE_ID, CHALLENGE_VERSION);

    expect(launched.sessionId).toBe("sess-dry-run");
    expect(launched.cookie).toBe("session-credential");
    expect(launched.revision).toBe(0);
    expect(launched.launchUrl).toContain("?t="); // 票据只在 launchUrl 内(契约 §2.2)

    // 客户端链路的逐请求形状(与真实路由的闸一一对应)。
    const issuance = requests.find((entry) => entry.path === "/auth/launch-tickets")!;
    expect(issuance.method).toBe("POST");
    expect(Object.keys(issuance.body as object).sort()).toEqual(["challengeId", "version"]);
    const redeem = requests.find((entry) => entry.method === "GET" && entry.path.startsWith("/app/c/"))!;
    expect(
      redeem.secFetchMode,
      "换票必须实际携带 Sec-Fetch-Mode: navigate(顶层导航语义;浏览器自带,node 侧手工补)",
    ).toBe("navigate");
    expect(redeem.query).toContain("t=");
    const create = requests.find((entry) => entry.path === "/sessions")!;
    const createBody = create.body as { command: string; protocolVersion: number; payload: Record<string, unknown> };
    expect(createBody.command).toBe("create_session");
    expect(createBody.protocolVersion).toBe(2);
    expect(Object.keys(createBody.payload).sort()).toEqual(["challengeId", "challengeVersion"]);
    expect(create.cookie).toContain(`${LAUNCH_GRANT_COOKIE}=`);
  });

  it("换票被拒 ⇒ 链路在换票处失败并抛出,**不继续**建会话(失败不伪装成成功)", async () => {
    const recorder = new topology.TrafficRecorder();
    const before = requests.length;
    rejectRedeem = true;
    try {
      await expect(
        topology.createSessionViaLaunchAddress(recorder, CHALLENGE_ID, CHALLENGE_VERSION),
      ).rejects.toThrow(/换票/);
    } finally {
      rejectRedeem = false;
    }
    // 失败链路必须在**换票**处终止:不得出现任何 POST /sessions(授权凭证没拿到
    // 就"顺手试一下"正是"静默跑错链路"的形态)。
    const after = requests.slice(before);
    expect(after.some((entry) => entry.path === "/sessions")).toBe(false);
    expect(after.some((entry) => entry.method === "GET" && entry.path.startsWith("/app/c/"))).toBe(true);
  });
});

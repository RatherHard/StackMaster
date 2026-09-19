/**
 * 启动票据签发 / 换票 / create_session v2 消费链的机检(草案 §十一 九条)。
 *
 * **本文件是 WP-91 第二步的完成标准载体**,逐条对应:
 *  ① URL / body 参数不得进入租户派生路径(结构性断言);
 *  ② 应用侧日志零票据(换票请求**本身**;序列化器级断言在 log-redaction.test.ts);
 *  ③ 401 三态同形(不存在 / 已消费 / 已过期 —— 响应**逐字节**一致);
 *  ④ 单次消费原子性(此处为路由级;内存替身与真实 Redis 版另见
 *     launch-ticket-store.test.ts / redis.integration.test.ts);
 *  ⑤ 429 逐字节;
 *  ⑥ 404 同形(签发面未启用 / 题目不存在);
 *  ⑦ 票据不入 PG / 审计账 / 指标标签;
 *  ⑧ 响应键集冻结(`{launchUrl, expiresAt}` 恰两键);
 *  ⑨ golden fixture 属 WP-90(本文件不重复)。
 *
 * 另覆盖第二步特有的语义:5b(换票**不建会话**、只发授权凭证)、5c
 * (create_session 以凭证为授权来源、payload 逐字一致、凭证单次消费)。
 */
import { describe, expect, it } from "vitest";
import {
  LAUNCH_TICKET_ISSUANCE_ROUTE,
  LaunchTicketResponseSchema,
  SESSION_ACTION_PROTOCOL_VERSION,
  WssFrameSchema,
} from "@stackmaster/protocol";

import {
  buildSessionTestRig,
  credentialHeaders,
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  TEST_HOST_BACKEND_TOKEN,
  TEST_TENANT_ID,
  type SessionTestRig,
} from "../routes/helpers/session-rig.js";

const PUBLIC_ORIGIN = "https://lab.example.com";

/** 装配一条完整启用签发面的装置(白名单租户 + 公开来源 + 已发布题目)。 */
async function buildLaunchRig(env: Record<string, string> = {}): Promise<SessionTestRig> {
  const rig = await buildSessionTestRig({
    env: {
      SESSION_API_HOST_TENANTS: TEST_TENANT_ID,
      SESSION_API_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      ...env,
    },
  });
  await rig.registerByteChallenge({});
  return rig;
}

function issue(
  rig: SessionTestRig,
  body: unknown = { challengeId: TEST_CHALLENGE_ID, version: TEST_CHALLENGE_VERSION },
  authorization: string | undefined = `Bearer ${TEST_HOST_BACKEND_TOKEN}`,
) {
  return rig.app.inject({
    method: "POST",
    url: LAUNCH_TICKET_ISSUANCE_ROUTE,
    headers: {
      "content-type": "application/json",
      ...(authorization === undefined ? {} : { authorization }),
    },
    payload: body as object,
  });
}

/** 从签发响应取出票据值(它**只**在 launchUrl 内;响应无第二个载位)。 */
function ticketOf(payload: string): string {
  const body = LaunchTicketResponseSchema.parse(JSON.parse(payload));
  const ticket = new URL(body.launchUrl).searchParams.get("t");
  if (ticket === null) {
    throw new Error("launchUrl 内没有票据");
  }
  return ticket;
}

function redeem(
  rig: SessionTestRig,
  ticket: string,
  options: { challengeId?: string; version?: string; secFetchMode?: string | null } = {},
) {
  const challengeId = options.challengeId ?? TEST_CHALLENGE_ID;
  const version = options.version ?? TEST_CHALLENGE_VERSION;
  const mode = options.secFetchMode === undefined ? "navigate" : options.secFetchMode;
  return rig.app.inject({
    method: "GET",
    url: `/app/c/${challengeId}/${version}?t=${ticket}`,
    headers: mode === null ? {} : { "sec-fetch-mode": mode },
  });
}

function grantCookieOf(response: { cookies: { name: string; value: string }[] }): string {
  const cookie = response.cookies.find((item) => item.name === "sm_launch_grant");
  if (cookie === undefined) {
    throw new Error("换票响应未下发授权凭证 Cookie");
  }
  return `${cookie.name}=${cookie.value}`;
}

function createSession(
  rig: SessionTestRig,
  cookie: string,
  payload: unknown = { challengeId: TEST_CHALLENGE_ID, challengeVersion: TEST_CHALLENGE_VERSION },
) {
  return rig.app.inject({
    method: "POST",
    url: "/sessions",
    headers: { "content-type": "application/json", cookie, ...credentialHeaders() },
    payload: { protocolVersion: SESSION_ACTION_PROTOCOL_VERSION, command: "create_session", payload },
  });
}

describe("机检 ⑥ / ⑧:签发端点的 404 同形与响应键集冻结", () => {
  it("⑧ 响应**恰两键** `{launchUrl, expiresAt}`;票据只在 launchUrl 内,响应无第二个载位", async () => {
    const rig = await buildLaunchRig();
    const response = await issue(rig);
    expect(response.statusCode).toBe(201);

    const body = JSON.parse(response.payload) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "launchUrl"]);
    // 冻结 Schema 自检(超集 / 缺键都会在这里炸)。
    const parsed = LaunchTicketResponseSchema.parse(body);
    expect(typeof parsed.expiresAt).toBe("number");

    // 票据**只**在 launchUrl 的 `?t=` 内 —— 不得另回 ticket / jti 字段。
    expect(body).not.toHaveProperty("ticket");
    expect(body).not.toHaveProperty("jti");
    const ticket = ticketOf(response.payload);
    expect(parsed.launchUrl).toBe(
      `${PUBLIC_ORIGIN}/app/c/${TEST_CHALLENGE_ID}/${TEST_CHALLENGE_VERSION}?t=${ticket}`,
    );
  });

  it("⑥ 签发面未启用(白名单空 / 未配公开来源)与题目不存在**逐字节同形**", async () => {
    // (a) 白名单为空 ⇒ 面整体 404。
    const unbound = await buildSessionTestRig({ env: { SESSION_API_PUBLIC_ORIGIN: PUBLIC_ORIGIN } });
    const noTenants = await issue(unbound);
    expect(noTenants.statusCode).toBe(404);

    // (b) 未配公开来源 ⇒ 404。
    const noOrigin = await buildSessionTestRig({ env: { SESSION_API_HOST_TENANTS: TEST_TENANT_ID } });
    const noOriginResponse = await issue(noOrigin);
    expect(noOriginResponse.statusCode).toBe(404);

    // (c) 题目未登记 ⇒ 404。
    const rig = await buildLaunchRig();
    const unknown = await issue(rig, { challengeId: "ch-not-registered", version: "1.0.0" });
    expect(unknown.statusCode).toBe(404);

    // (d) 版本未登记 ⇒ 404。
    const badVersion = await issue(rig, { challengeId: TEST_CHALLENGE_ID, version: "9.9.9" });
    expect(badVersion.statusCode).toBe(404);

    // ★ 四者体**逐字节一致**(防枚举:调用方分不出"面没开"与"题不存在")。
    const bodies = [noTenants.payload, noOriginResponse.payload, unknown.payload, badVersion.payload];
    expect(new Set(bodies).size).toBe(1);
  });
});

describe("机检 ①:URL / body 参数不得进入租户派生路径", () => {
  it("body 携带 tenantId ⇒ strictObject 即拒(结构性:契约层无此表达位)", async () => {
    const rig = await buildLaunchRig();
    const response = await issue(rig, {
      challengeId: TEST_CHALLENGE_ID,
      version: TEST_CHALLENGE_VERSION,
      tenantId: "tenant-attacker",
    });
    expect(response.statusCode).toBe(400);
  });

  it("查询参数携带 tenantId 不影响绑定:票据内的租户恒为**锚租户**(白名单首项)", async () => {
    // 白名单两项(含一项字典序更小者)⇒ 锚 = 字典序最小项,与配置书写顺序无关。
    const twoTenants = await buildSessionTestRig({
      env: {
        SESSION_API_HOST_TENANTS: `${TEST_TENANT_ID},tenant-aaa`,
        SESSION_API_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      },
    });
    await twoTenants.registerByteChallenge({});

    const response = await twoTenants.app.inject({
      method: "POST",
      url: `${LAUNCH_TICKET_ISSUANCE_ROUTE}?tenantId=tenant-attacker&tenant=tenant-attacker`,
      headers: {
        authorization: `Bearer ${TEST_HOST_BACKEND_TOKEN}`,
        "content-type": "application/json",
      },
      payload: { challengeId: TEST_CHALLENGE_ID, version: TEST_CHALLENGE_VERSION },
    });
    expect(response.statusCode).toBe(201);

    // ★ 直接读回**绑定记录**:URL 上的 tenantId 从未参与派生,记录里的租户
    //   恒为锚租户(字典序最小项 `tenant-aaa`,不是书写顺序里的 TEST_TENANT_ID)。
    const ticket = ticketOf(response.payload);
    const binding = await twoTenants.ticketStore.consume(ticket, {
      challengeId: TEST_CHALLENGE_ID,
      version: TEST_CHALLENGE_VERSION,
    });
    expect(binding?.tenantId).toBe("tenant-aaa");
    expect(twoTenants.config.hostTenants).toEqual(["tenant-aaa", TEST_TENANT_ID]);
  });
});

describe("机检 ③:换票 401 三态**逐字节**同形", () => {
  it("不存在 / 已消费 / 已过期 三者响应体逐字节一致(端口面同形 ⇒ 结构上没有第二出口)", async () => {
    const rig = await buildLaunchRig();

    // (1) 不存在的票据:形态合法但从未签发。
    const absent = await redeem(rig, "A".repeat(22));
    expect(absent.statusCode).toBe(401);

    // (2) 已消费:签发一次并成功换票,再重放同一票据。
    const issued = await issue(rig);
    const consumedTicket = ticketOf(issued.payload);
    const first = await redeem(rig, consumedTicket);
    expect(first.statusCode).toBe(302);
    const replay = await redeem(rig, consumedTicket);
    expect(replay.statusCode).toBe(401);

    // (3) 已过期:时钟推进越过 TTL。
    let nowMs = Date.now();
    const expiringRig = await buildSessionTestRig({
      env: {
        SESSION_API_HOST_TENANTS: TEST_TENANT_ID,
        SESSION_API_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
        SESSION_API_LAUNCH_TICKET_TTL_SECONDS: "1",
      },
      now: () => nowMs,
    });
    await expiringRig.registerByteChallenge({});
    const expiringIssued = await issue(expiringRig);
    const expiringTicket = ticketOf(expiringIssued.payload);
    nowMs += 2000; // 越过 1 s TTL
    const expired = await redeem(expiringRig, expiringTicket);
    expect(expired.statusCode).toBe(401);

    // ★ 三态体逐字节一致。
    expect(new Set([absent.payload, replay.payload, expired.payload]).size).toBe(1);
    // 与冻结 401 形态同源(零新增错误码)。
    expect(absent.payload).toBe(
      JSON.stringify({ code: "invalid_input_format", message: "authentication failed" }),
    );
  });

  it("绑定不符(路径题目 / 版本与票据不同)**不消费**票据,且与 401 同形", async () => {
    const rig = await buildLaunchRig();
    const issued = await issue(rig);
    const ticket = ticketOf(issued.payload);

    const wrongChallenge = await redeem(rig, ticket, { challengeId: "ch-other" });
    expect(wrongChallenge.statusCode).toBe(401);
    const wrongVersion = await redeem(rig, ticket, { version: "9.9.9" });
    expect(wrongVersion.statusCode).toBe(401);
    expect(wrongChallenge.payload).toBe(wrongVersion.payload);

    // ★ 两次错配之后票据**依然可用**(不一致不消费 = 可用性保护)。
    const ok = await redeem(rig, ticket);
    expect(ok.statusCode).toBe(302);
  });

  it("`Sec-Fetch-Mode` 非 navigate(子资源 / 嵌入换票)⇒ 401 同形,且**不消费**票据", async () => {
    const rig = await buildLaunchRig();
    const issued = await issue(rig);
    const ticket = ticketOf(issued.payload);

    for (const mode of ["no-cors", "cors", "same-origin", null]) {
      const rejected = await redeem(rig, ticket, { secFetchMode: mode });
      expect(rejected.statusCode).toBe(401);
    }
    // 纯请求头闸在消费之前 ⇒ 票据未被烧掉。
    expect((await redeem(rig, ticket)).statusCode).toBe(302);
  });
});

describe("机检 ④(路由级)+ 5b:换票 = 校验 + 原子消费 + 发凭证,不建会话", () => {
  it("成功换票:302 到**不含票据**的干净路径 + 授权凭证 Cookie + no-store / no-referrer", async () => {
    const rig = await buildLaunchRig();
    const issued = await issue(rig);
    const ticket = ticketOf(issued.payload);
    const response = await redeem(rig, ticket);

    expect(response.statusCode).toBe(302);
    expect(response.headers["location"]).toBe(
      `/app/c/${TEST_CHALLENGE_ID}/${TEST_CHALLENGE_VERSION}`,
    );
    // ★ Location **不含任何查询串**(更不含票据)。
    expect(response.headers["location"]).not.toContain("?");
    expect(response.headers["location"]).not.toContain(ticket);

    // D-LT-3:no-store + no-referrer 必须在场(机检)。
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");

    // 授权凭证经 Set-Cookie 下发,属性与会话凭证同款。
    const cookie = response.cookies.find((item) => item.name === "sm_launch_grant");
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite?.toLowerCase()).toBe("strict");

    // ★ 5b:换票**不建会话**(候选 C 已否决)—— 此时管理器里零会话。
    expect(rig.manager.liveCount).toBe(0);
  });

  it("④ 并发两次换票:恰一次 302、一次 401(单次消费原子性的路由级证据)", async () => {
    const rig = await buildLaunchRig();
    const issued = await issue(rig);
    const ticket = ticketOf(issued.payload);

    const [a, b] = await Promise.all([redeem(rig, ticket), redeem(rig, ticket)]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([302, 401]);
  });
});

describe("机检 ⑤:签发限流触顶 429 逐字节(沿既有唯一出口)", () => {
  it("频率闸触顶 ⇒ 429 + 冻结 budget_exhausted 形态,维度只进受控日志", async () => {
    const rig = await buildLaunchRig({ SESSION_API_LAUNCH_TICKET_ISSUANCE_PER_MINUTE: "1" });

    const first = await issue(rig);
    expect(first.statusCode).toBe(201);
    const second = await issue(rig);
    expect(second.statusCode).toBe(429);
    // 与 D-API-50 频率类**字节级一致**(同一冻结常量)。
    expect(second.payload).toBe(
      JSON.stringify({ code: "budget_exhausted", message: "rate limit exceeded" }),
    );
    // 同类别恒同三元组:再多打一次仍是同一形态。
    expect((await issue(rig)).payload).toBe(second.payload);
  });
});

describe("机检 ⑦:票据不入审计账 / 指标标签 / 日志", () => {
  it("签发票据**零审计写入**(D-LT-5 第 7 条:审计 kind 零新增)", async () => {
    const rig = await buildLaunchRig();
    const before = rig.audit.size;
    const issued = await issue(rig);
    const ticket = ticketOf(issued.payload);
    await redeem(rig, ticket);
    // 换票链同样零审计(授权凭证的签发 / 消费都不进封闭集)。
    expect(rig.audit.size).toBe(before);
  });

  it("票据值与授权凭证值**都不出现在应用侧日志**(换票请求本身)", async () => {
    const rig = await buildLaunchRig();
    const issued = await issue(rig);
    const ticket = ticketOf(issued.payload);
    const redeemed = await redeem(rig, ticket);
    const cookie = grantCookieOf(redeemed);

    const raw = rig.capture.raw();
    expect(raw).not.toContain(ticket);
    // 授权凭证载体(签名 JWT)同样零落日志。
    const grantToken = cookie.slice(cookie.indexOf("=") + 1);
    expect(grantToken.length).toBeGreaterThan(20);
    expect(raw).not.toContain(grantToken);
    // 路径被正常记录(脱敏不是"不记日志")。
    expect(raw).toContain(`/app/c/${TEST_CHALLENGE_ID}/${TEST_CHALLENGE_VERSION}`);
  });
});

describe("5c:create_session v2 —— 授权来源 = 启动授权凭证 Cookie", () => {
  it("完整链:签发 → 换票 → create_session 201 + 会话凭证 Cookie(身份只从凭证派生)", async () => {
    const rig = await buildLaunchRig();
    const issued = await issue(rig);
    const ticket = ticketOf(issued.payload);
    const redeemed = await redeem(rig, ticket);
    const grantCookie = grantCookieOf(redeemed);

    const created = await createSession(rig, grantCookie);
    expect(created.statusCode).toBe(201);
    const body = JSON.parse(created.payload) as {
      command: string;
      payload: { sessionId: string; revision: number };
    };
    expect(body.command).toBe("create_session");
    expect(body.payload.revision).toBe(0);

    // 会话行落库(D-LT-5 5c:校验通过后**才**建会话)。
    expect(rig.manager.liveCount).toBe(1);
    // 会话凭证 Cookie 同时下发(既有链路的交付面不变)。
    expect(created.cookies.some((item) => item.name === "sm_session_credential")).toBe(true);
  });

  it("凭证**单次消费**:同一 Cookie 第二次 create_session ⇒ 401(重放即拒绝)", async () => {
    const rig = await buildLaunchRig();
    const issued = await issue(rig);
    const ticket = ticketOf(issued.payload);
    const grantCookie = grantCookieOf(await redeem(rig, ticket));

    expect((await createSession(rig, grantCookie)).statusCode).toBe(201);
    const replay = await createSession(rig, grantCookie);
    expect(replay.statusCode).toBe(401);
    expect(replay.payload).toBe(
      JSON.stringify({ code: "invalid_input_format", message: "authentication failed" }),
    );
  });

  it("payload 与凭证绑定**不逐字一致** ⇒ 401(不得降级为「以 payload 为准」)", async () => {
    const rig = await buildLaunchRig();
    const issued = await issue(rig);
    const ticket = ticketOf(issued.payload);
    const grantCookie = grantCookieOf(await redeem(rig, ticket));

    const wrongVersion = await createSession(rig, grantCookie, {
      challengeId: TEST_CHALLENGE_ID,
      challengeVersion: "9.9.9",
    });
    expect(wrongVersion.statusCode).toBe(401);
    // 拒绝即拒绝:未建任何会话。
    expect(rig.manager.liveCount).toBe(0);
  });

  it("无授权凭证 Cookie ⇒ 401(v2 不再接受请求体内的 embed token)", async () => {
    const rig = await buildLaunchRig();
    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      headers: { "content-type": "application/json", ...credentialHeaders() },
      payload: {
        protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
        command: "create_session",
        payload: {
          challengeId: TEST_CHALLENGE_ID,
          challengeVersion: TEST_CHALLENGE_VERSION,
        },
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it("v2 payload 仍是**恰两键**:携带 embedToken / embedSessionId ⇒ 400", async () => {
    const rig = await buildLaunchRig();
    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      headers: { "content-type": "application/json", ...credentialHeaders() },
      payload: {
        protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
        command: "create_session",
        payload: {
          challengeId: TEST_CHALLENGE_ID,
          challengeVersion: TEST_CHALLENGE_VERSION,
          embedSessionId: "embed-session-0000000001",
          embedToken: "whatever",
        },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("授权凭证 claims 恰六字段且**无 sessionId / embedSessionId**(5a 的结构性表达)", async () => {
    const rig = await buildLaunchRig();
    const issued = await issue(rig);
    const ticket = ticketOf(issued.payload);
    const redeemed = await redeem(rig, ticket);
    const cookie = grantCookieOf(redeemed);

    // 授权凭证的 claims 形态由**解码后**的字段集合断言:无会话位。
    const grantToken = cookie.slice(cookie.indexOf("=") + 1);
    // 载体是 JWS(三段点分);载荷可解出但**服务端不以此为准**(锚是签发记录)。
    const payloadSegment = grantToken.split(".")[1];
    expect(payloadSegment).toBeDefined();
    const decoded = JSON.parse(
      Buffer.from(payloadSegment as string, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(decoded).sort()).toEqual([
      "challengeId",
      "challengeVersion",
      "exp",
      "expiresAt",
      "jti",
      "tenantId",
      "userId",
    ]);
  });
});

describe("WSS 域不因本 WP 改动而漂移(回归护栏)", () => {
  it("冻结帧 Schema 仍只表达单一协议版本(本 WP 未触碰帧面)", () => {
    const parsed = WssFrameSchema.safeParse({
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
      type: "error",
      sessionId: "sess-1",
      seq: 1,
      payload: { code: "invalid_input_format", message: "authentication failed" },
    });
    expect(parsed.success).toBe(true);
  });
});

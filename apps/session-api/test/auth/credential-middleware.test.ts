/**
 * 会话凭证校验中间件测试(middleware.ts;REST 与 WSS 统一认证入口):
 * Cookie / Bearer 呈递、过期 / 吊销 / 绑定不匹配确定性拒绝、CSRF Origin 闸、
 * 身份只来自认证上下文(基线 #1:请求体自报身份被 strictObject 拒绝且即使
 * 注入也不被采信)。
 */

import { SessionCommandRequestSchema } from "@stackmaster/protocol";
import { describe, expect, it } from "vitest";

import {
  SessionCredentialRejected,
  authenticateSessionCredential,
  revokeSessionCredential,
  sessionCredentialFromCookieHeader,
} from "../../src/auth/index.js";
import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  TEST_TENANT_ID,
  TEST_USER_ID,
  buildAuthTestRig,
  sessionCredentialFromSetCookie,
} from "../helpers/auth-rig.js";

type Rig = Awaited<ReturnType<typeof buildAuthTestRig>>;

/** 走完整链路取得会话与凭证(消费 → 签发 → Set-Cookie)。 */
async function establishSession(rig: Rig): Promise<{ sessionId: string; credential: string }> {
  const issued = await rig.issueEmbedToken();
  const response = await rig.app.inject({
    method: "POST",
    url: "/test/sessions",
    payload: {
      embedToken: issued.token,
      challengeId: TEST_CHALLENGE_ID,
      challengeVersion: TEST_CHALLENGE_VERSION,
      embedSessionId: issued.claims.embedSessionId,
    },
  });
  expect(response.statusCode).toBe(201);
  return { sessionId: (response.json() as { sessionId: string }).sessionId, credential: sessionCredentialFromSetCookie(response) };
}

function actionPayload(sessionId: string, identityInjection?: Record<string, unknown>): Record<string, unknown> {
  return {
    payload: { sessionId, ...identityInjection },
  };
}

describe("凭证校验中间件:合法呈递", () => {
  it("Bearer 呈递:受保护路由可访问,principal 与凭证一致(身份只来自认证上下文)", async () => {
    const rig = await buildAuthTestRig();
    const { sessionId, credential } = await establishSession(rig);
    const response = await rig.app.inject({
      method: "POST",
      url: "/test/actions",
      headers: { authorization: `Bearer ${credential}` },
      payload: actionPayload(sessionId),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      principal: { tenantId: TEST_TENANT_ID, userId: TEST_USER_ID },
      sessionId,
    });
  });

  it("Cookie 呈递:只读请求(GET 类)无需 Origin 即可访问;身份与凭证一致", async () => {
    const rig = await buildAuthTestRig();
    const { sessionId, credential } = await establishSession(rig);
    const response = await rig.app.inject({
      method: "GET",
      url: "/test/actions",
      headers: { cookie: `sm_session_credential=${credential}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ sessionId });
  });
});

describe("凭证校验中间件:红灯矩阵(统一 401 冻结形态)", () => {
  const FROZEN_401 = { code: "invalid_input_format", message: "authentication failed" };

  it("未呈递凭证:确定性拒绝(reason = absent)", async () => {
    const rig = await buildAuthTestRig();
    const response = await rig.app.inject({
      method: "POST",
      url: "/test/actions",
      payload: actionPayload("sess-anything"),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(FROZEN_401);
  });

  it("凭证过期:确定性拒绝(reason = expired)", async () => {
    let now = 1_000_000_000_000;
    const rig = await buildAuthTestRig({ now: () => now });
    const { sessionId, credential } = await establishSession(rig);
    now += 3_600_001; // 越过默认凭证 TTL
    const response = await rig.app.inject({
      method: "POST",
      url: "/test/actions",
      headers: { authorization: `Bearer ${credential}` },
      payload: actionPayload(sessionId),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(FROZEN_401);
  });

  it("凭证吊销后使用:确定性拒绝(reason = revoked)", async () => {
    const rig = await buildAuthTestRig();
    const { sessionId, credential } = await establishSession(rig);
    const claims = await rig.signer.verifySessionCredential(credential);
    await revokeSessionCredential({ revocationStore: rig.revocationStore }, claims.jti, 3600);
    const response = await rig.app.inject({
      method: "POST",
      url: "/test/actions",
      headers: { authorization: `Bearer ${credential}` },
      payload: actionPayload(sessionId),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(FROZEN_401);
  });

  it("凭证跨会话使用(绑定不匹配):确定性拒绝(reason = session_binding)", async () => {
    const rig = await buildAuthTestRig();
    const first = await establishSession(rig);
    const second = await establishSession(rig);
    const response = await rig.app.inject({
      method: "POST",
      url: "/test/actions",
      headers: { authorization: `Bearer ${first.credential}` },
      payload: actionPayload(second.sessionId), // A 会话凭证打 B 会话
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(FROZEN_401);
    expect(middlewareReasons(rig)).toContain("session_binding");
  });

  it("伪造 / 畸形凭证:确定性拒绝且零凭证材料出响应面", async () => {
    const rig = await buildAuthTestRig();
    const response = await rig.app.inject({
      method: "POST",
      url: "/test/actions",
      headers: { authorization: "Bearer forged.credential.value" },
      payload: actionPayload("sess-anything"),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(FROZEN_401);
    expect(response.body).not.toContain("forged.credential.value");
  });
});

describe("CSRF 闸(D-API-17:Cookie 呈递 + 变更方法)", () => {
  it("Cookie 呈递的 POST:Origin 缺失或不在白名单 → 统一 401;白名单 Origin → 放行", async () => {
    const rig = await buildAuthTestRig();
    const { sessionId, credential } = await establishSession(rig);
    const cookieHeader = `sm_session_credential=${credential}`;

    const missingOrigin = await rig.app.inject({
      method: "POST",
      url: "/test/actions",
      headers: { cookie: cookieHeader },
      payload: actionPayload(sessionId),
    });
    expect(missingOrigin.statusCode).toBe(401);
    expect(middlewareReasons(rig)).toContain("csrf_origin");

    const evilOrigin = await rig.app.inject({
      method: "POST",
      url: "/test/actions",
      headers: { cookie: cookieHeader, origin: "https://evil.example" },
      payload: actionPayload(sessionId),
    });
    expect(evilOrigin.statusCode).toBe(401);

    const allowedOrigin = await rig.app.inject({
      method: "POST",
      url: "/test/actions",
      headers: { cookie: cookieHeader, origin: "https://plugin.example" },
      payload: actionPayload(sessionId),
    });
    expect(allowedOrigin.statusCode).toBe(200);
  });

  it("Bearer 呈递不走 CSRF 闸(非浏览器向量):无 Origin 的 POST 照常认证", async () => {
    const rig = await buildAuthTestRig();
    const { sessionId, credential } = await establishSession(rig);
    const response = await rig.app.inject({
      method: "POST",
      url: "/test/actions",
      headers: { authorization: `Bearer ${credential}` },
      payload: actionPayload(sessionId),
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("身份派生(基线 #1:不接受请求体自报身份)", () => {
  it("契约面:create_session 载荷注入身份字段被 SessionCommandRequestSchema(strictObject)拒绝", () => {
    const probe = {
      protocolVersion: 1,
      command: "create_session",
      payload: {
        challengeId: "chal-x",
        challengeVersion: "1.0.0",
        embedSessionId: "a".repeat(22),
        embedToken: "token-material",
        tenantId: "tenant-attacker",
      },
    };
    expect(SessionCommandRequestSchema.safeParse(probe).success).toBe(false);
  });

  it("运行面:请求体注入身份字段不改变 principal——身份只来自凭证 claims", async () => {
    const rig = await buildAuthTestRig();
    const { sessionId, credential } = await establishSession(rig);
    const response = await rig.app.inject({
      method: "POST",
      url: "/test/actions",
      headers: { authorization: `Bearer ${credential}` },
      payload: actionPayload(sessionId, { tenantId: "tenant-attacker", userId: "user-attacker" }),
    });
    // 替身路由锚提取器只读 payload.sessionId;注入的身份字段不参与身份派生。
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      principal: { tenantId: TEST_TENANT_ID, userId: TEST_USER_ID },
      sessionId,
    });
  });
});

describe("统一认证入口 authenticateSessionCredential(WSS 升级复用面)", () => {
  it("Cookie 头解析助手与入口函数直连(WP-5 升级握手路径)", async () => {
    const rig = await buildAuthTestRig();
    const { credential } = await establishSession(rig);
    const fromHeader = sessionCredentialFromCookieHeader(
      `other=1; sm_session_credential=${credential}`,
    );
    expect(fromHeader).toBe(credential);
    const authenticated = await authenticateSessionCredential(
      { signer: rig.signer, revocationStore: rig.revocationStore },
      { cookie: fromHeader },
    );
    expect(authenticated.via).toBe("cookie");
    expect(authenticated.claims.tenantId).toBe(TEST_TENANT_ID);

    await expect(
      authenticateSessionCredential(
        { signer: rig.signer, revocationStore: rig.revocationStore },
        {},
      ),
    ).rejects.toMatchObject({ reason: "absent" });
    expect(new SessionCredentialRejected("absent", "x").reason).toBe("absent");
  });

  it("jti 是随机会话实例标识(不可预测;UUID 形态)", async () => {
    const rig = await buildAuthTestRig();
    const { credential } = await establishSession(rig);
    const { claims } = await authenticateSessionCredential(
      { signer: rig.signer, revocationStore: rig.revocationStore },
      { bearer: credential },
    );
    expect(claims.jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

function middlewareReasons(rig: Rig): string[] {
  return rig.capture
    .entries()
    .filter((entry) => entry["msg"] === "session credential rejected")
    .map((entry) => String(entry["reason"]));
}

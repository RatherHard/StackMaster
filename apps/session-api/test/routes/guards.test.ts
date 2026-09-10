/**
 * 请求护栏与认证红灯矩阵(任务分解 WP-4 完成标准;基线 #8 / 8.3 / D-API-31):
 *  - 畸形请求返回冻结错误形态,原始校验器细节(字段路径 / issue 计数)只进
 *    受控日志(捕获内存日志断言);
 *  - 请求超限红灯:体大小(bodyLimit 413)/ 嵌套深度 / 字符串长度;
 *  - 认证红灯:未认证 / 过期凭证 / 吊销凭证 / 跨租户会话(绑定锚比对);
 *  - 命令与路由不匹配的确定性拒绝。
 */
import { describe, expect, it } from "vitest";
import { PublicErrorSchema } from "@stackmaster/protocol";
import { SignJWT } from "jose";
import { createPrivateKey } from "node:crypto";

import {
  DEFAULT_ALLOWED_ORIGINS,
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  buildSessionTestRig,
  sessionCommand,
  sessionCredentialFromSetCookie,
  credentialHeaders,
  type SessionTestRig,
} from "./helpers/session-rig.js";

async function rigWithSession(): Promise<{ rig: SessionTestRig; sessionId: string; cookie: string }> {
  const rig = await buildSessionTestRig();
  await rig.registerChallenge();
  const issued = await rig.issueEmbedToken();
  const response = await rig.app.inject({
    method: "POST",
    url: "/sessions",
    payload: sessionCommand("create_session", {
      challengeId: TEST_CHALLENGE_ID,
      challengeVersion: TEST_CHALLENGE_VERSION,
      embedSessionId: issued.claims.embedSessionId,
      embedToken: issued.token,
    }),
  });
  expect(response.statusCode).toBe(201);
  return {
    rig,
    sessionId: (response.json().payload as { sessionId: string }).sessionId,
    cookie: sessionCredentialFromSetCookie(response),
  };
}

function contractRejections(capture: SessionTestRig["capture"]): Record<string, unknown>[] {
  return capture
    .entries()
    .filter((entry) => entry["msg"] === "session command rejected at contract layer");
}

describe("畸形请求:冻结错误形态 + 原始错误仅入受控日志(基线 #8)", () => {
  it("未知字段(strictObject)拒绝:响应零校验器细节,字段路径只进日志", async () => {
    const rig = await buildSessionTestRig();
    await rig.registerChallenge();
    const issued = await rig.issueEmbedToken();
    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: {
        ...sessionCommand("create_session", {
          challengeId: TEST_CHALLENGE_ID,
          challengeVersion: TEST_CHALLENGE_VERSION,
          embedSessionId: issued.claims.embedSessionId,
          embedToken: issued.token,
        }),
        // 自报身份字段(ZR 红灯形态):strictObject 结构性拒绝。
        tenantId: "tenant-self-reported",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(() => PublicErrorSchema.parse(response.json())).not.toThrow();
    expect(response.json()).toEqual({ code: "invalid_input_format", message: "invalid request" });
    // 响应面零字段路径;受控日志有 issue 计数与路径(基线 #8 的日志侧)。
    expect(response.body).not.toContain("tenantId");
    const rejections = contractRejections(rig.capture);
    expect(rejections.length).toBeGreaterThan(0);
    expect(rejections[0]?.["issueCount"]).toBeGreaterThan(0);
    expect(Array.isArray(rejections[0]?.["issuePaths"])).toBe(true);
  });

  it("命令与路由不匹配(sync 载体打到 close 路由)确定性拒绝", async () => {
    const { rig, sessionId, cookie } = await rigWithSession();
    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions/close",
      cookies: { sm_session_credential: cookie },
      headers: credentialHeaders(),
      payload: sessionCommand("sync_projection", { sessionId }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "invalid_input_format", message: "invalid request" });
  });

  it("请求体非对象(数组 / 标量)确定性拒绝", async () => {
    const rig = await buildSessionTestRig();
    await rig.registerChallenge();
    const cases: unknown[] = [[1, 2, 3], "create_session", 42];
    for (const payload of cases) {
      const response = await rig.app.inject({
        method: "POST",
        url: "/sessions",
        payload: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
      });
      expect(response.statusCode, `payload=${JSON.stringify(payload)}`).toBe(400);
      expect(response.json()).toEqual({ code: "invalid_input_format", message: "invalid request" });
    }
  });
});

describe("请求超限红灯(8.3 护栏;D-API-31)", () => {
  it("请求体字节超限:bodyLimit 413 + 冻结形态(零框架细节)", async () => {
    const rig = await buildSessionTestRig({
      env: { SESSION_API_MAX_REQUEST_BODY_BYTES: "128" },
    });
    await rig.registerChallenge();
    const issued = await rig.issueEmbedToken();
    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: sessionCommand("create_session", {
        challengeId: TEST_CHALLENGE_ID,
        challengeVersion: TEST_CHALLENGE_VERSION,
        embedSessionId: issued.claims.embedSessionId,
        embedToken: `${issued.token}${"x".repeat(512)}`,
      }),
    });
    expect(response.statusCode).toBe(413);
    expect(() => PublicErrorSchema.parse(response.json())).not.toThrow();
    expect(response.json()).toEqual({ code: "invalid_input_format", message: "request too large" });
    expect(response.body).not.toContain("FST_");
  });

  it("嵌套深度超限:结构护栏 400,越界细节只进日志", async () => {
    const rig = await buildSessionTestRig({
      env: { SESSION_API_MAX_JSON_DEPTH: "4" },
    });
    await rig.registerChallenge();
    // 深度越界结构藏在未知字段里(护栏先于 Schema 校验触发)。
    let deep: unknown = "bottom";
    for (let i = 0; i < 10; i += 1) {
      deep = { nested: deep };
    }
    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: { command: "create_session", deep },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "invalid_input_format", message: "invalid request" });
    expect(response.body).not.toContain("nested");
    const rejections = contractRejections(rig.capture);
    expect(rejections.some((entry) => entry["dimension"] === "json_depth")).toBe(true);
  });

  it("字符串长度超限:结构护栏 400,确定性", async () => {
    const rig = await buildSessionTestRig({
      env: { SESSION_API_MAX_JSON_DEPTH: "4" },
    });
    await rig.registerChallenge();
    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: { command: "create_session", note: "x".repeat(5000) },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "invalid_input_format", message: "invalid request" });
    expect(response.body).not.toContain("xxxxx");
    const rejections = contractRejections(rig.capture);
    expect(rejections.some((entry) => entry["dimension"] === "string_length")).toBe(true);
  });
});

describe("认证红灯(未认证 / 过期 / 吊销 / 跨租户)", () => {
  it("未呈递凭证访问业务路由:统一 401 形态", async () => {
    const { rig, sessionId } = await rigWithSession();
    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions/projection-sync",
      payload: sessionCommand("sync_projection", { sessionId }),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      code: "invalid_input_format",
      message: "authentication failed",
    });
  });

  it("过期会话凭证:确定性 401(响应面不区分过期原因)", async () => {
    const { rig, sessionId } = await rigWithSession();
    const past = Math.floor(Date.now() / 1000) - 3600;
    const key = createPrivateKey(rig.config.signingKey);
    const expired = await new SignJWT({
      sessionId,
      tenantId: "tenant-alpha",
      userId: "user-42",
      challengeId: TEST_CHALLENGE_ID,
      challengeVersion: TEST_CHALLENGE_VERSION,
      jti: "expired-jti",
      expiresAt: past,
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setExpirationTime(past)
      .sign(key);
    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions/projection-sync",
      cookies: { sm_session_credential: expired },
      headers: credentialHeaders(),
      payload: sessionCommand("sync_projection", { sessionId }),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      code: "invalid_input_format",
      message: "authentication failed",
    });
  });

  it("吊销后的凭证:确定性 401", async () => {
    const { rig, sessionId, cookie } = await rigWithSession();
    // 从审计取该会话凭证 jti(签发审计 detail;非秘密标量)。
    const issuedEvent = rig.audit
      .snapshot()
      .find((event) => event.kind === "session_credential_issued" && event.sessionId === sessionId);
    const jti = issuedEvent?.detail?.["jti"];
    expect(typeof jti).toBe("string");
    await rig.revocationStore.revoke(jti as string, 600);
    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions/projection-sync",
      cookies: { sm_session_credential: cookie },
      headers: credentialHeaders(),
      payload: sessionCommand("sync_projection", { sessionId }),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      code: "invalid_input_format",
      message: "authentication failed",
    });
  });

  it("跨租户访问他人会话:凭证绑定锚比对确定性 401", async () => {
    const rig = await buildSessionTestRig();
    await rig.registerChallenge({ tenantId: "tenant-alpha" });
    // 租户各自的题目登记与签发(版本行按租户隔离;beta 用独立题目 ID)。
    await rig.registerChallenge({ tenantId: "tenant-beta", challengeId: "chal-beta" });
    const issuedBeta = await rig.issueEmbedToken({
      claims: { tenantId: "tenant-beta", challengeId: "chal-beta" },
    });
    const betaSession = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: sessionCommand("create_session", {
        challengeId: "chal-beta",
        challengeVersion: TEST_CHALLENGE_VERSION,
        embedSessionId: issuedBeta.claims.embedSessionId,
        embedToken: issuedBeta.token,
      }),
    });
    expect(betaSession.statusCode).toBe(201);
    const betaCookie = sessionCredentialFromSetCookie(betaSession);

    // 以 beta 凭证访问 alpha 用户的会话(sessionId 锚不在绑定内)。
    const issuedAlpha = await rig.issueEmbedToken();
    const alphaSession = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: sessionCommand("create_session", {
        challengeId: TEST_CHALLENGE_ID,
        challengeVersion: TEST_CHALLENGE_VERSION,
        embedSessionId: issuedAlpha.claims.embedSessionId,
        embedToken: issuedAlpha.token,
      }),
    });
    const alphaSessionId = (alphaSession.json().payload as { sessionId: string }).sessionId;

    const crossTenant = await rig.app.inject({
      method: "POST",
      url: "/sessions/projection-sync",
      cookies: { sm_session_credential: betaCookie },
      headers: credentialHeaders(),
      payload: sessionCommand("sync_projection", { sessionId: alphaSessionId }),
    });
    expect(crossTenant.statusCode).toBe(401);
    expect(crossTenant.json()).toEqual({
      code: "invalid_input_format",
      message: "authentication failed",
    });
    // 跨租户探测与"会话不存在"零差异信号(401 是认证面统一形态)。
  });

  it("跨题目版本绑定:embed token 与请求上下文版本不符 → 401(三方比对)", async () => {
    const rig = await buildSessionTestRig();
    await rig.registerChallenge();
    const issued = await rig.issueEmbedToken();
    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: sessionCommand("create_session", {
        challengeId: TEST_CHALLENGE_ID,
        challengeVersion: "9.9.9",
        embedSessionId: issued.claims.embedSessionId,
        embedToken: issued.token,
      }),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      code: "invalid_input_format",
      message: "authentication failed",
    });
  });

  it("题目版本未登记(challenge_invalid 方向)→ 422 冻结形态,细节只进日志", async () => {
    const rig = await buildSessionTestRig();
    const issued = await rig.issueEmbedToken({
      claims: { challengeId: "chal-never-registered" },
    });
    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: sessionCommand("create_session", {
        challengeId: "chal-never-registered",
        challengeVersion: TEST_CHALLENGE_VERSION,
        embedSessionId: issued.claims.embedSessionId,
        embedToken: issued.token,
      }),
    });
    expect(response.statusCode).toBe(422);
    expect(() => PublicErrorSchema.parse(response.json())).not.toThrow();
    expect(response.json()).toEqual({ code: "internal_error", message: "challenge invalid" });
    expect(rig.capture.raw()).toContain("challenge load rejected");
  });
});

describe("CORS 装配在完整服务上生效(沿袭 WP-2,D-API-16)", () => {
  it("白名单外来源不回 ACAO(fail-closed 沿袭)", async () => {
    const rig = await buildSessionTestRig({ env: { SESSION_API_ALLOWED_ORIGINS: DEFAULT_ALLOWED_ORIGINS } });
    const response = await rig.app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: "https://evil.example" },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

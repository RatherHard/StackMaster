/**
 * 合法链路端到端 + 传输卫生 + 审计面(WP-2 完成标准的收口测试):
 * 签发 embed token → create-session 消费(三方比对 + jti 单次消费)→
 * 会话凭证签发(Set-Cookie 交付)→ 凭证中间件保护的路由可访问;
 * 凭证不入 URL / 日志 / 错误响应;审计六(七)类事件可观察。
 */

import { PublicErrorSchema } from "@stackmaster/protocol";
import { describe, expect, it } from "vitest";

import { EMBED_TOKEN_ISSUANCE_ROUTE } from "../../src/auth/index.js";
import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  TEST_TENANT_ID,
  TEST_USER_ID,
  buildAuthTestRig,
  makeEmbedSessionId,
  sessionCredentialFromSetCookie,
} from "../helpers/auth-rig.js";

async function fullChain(rig: Awaited<ReturnType<typeof buildAuthTestRig>>): Promise<{
  sessionId: string;
  credential: string;
}> {
  const embedSessionId = makeEmbedSessionId();
  const issuance = await rig.app.inject({
    method: "POST",
    url: EMBED_TOKEN_ISSUANCE_ROUTE,
    headers: rig.hostHeaders(),
    payload: {
      tenantId: TEST_TENANT_ID,
      userId: TEST_USER_ID,
      challengeId: TEST_CHALLENGE_ID,
      challengeVersion: TEST_CHALLENGE_VERSION,
      embedSessionId,
    },
  });
  expect(issuance.statusCode).toBe(201);
  const { embedToken } = issuance.json() as { embedToken: string };

  const created = await rig.app.inject({
    method: "POST",
    url: "/test/sessions",
    payload: {
      embedToken,
      challengeId: TEST_CHALLENGE_ID,
      challengeVersion: TEST_CHALLENGE_VERSION,
      embedSessionId,
    },
  });
  expect(created.statusCode).toBe(201);
  const { sessionId } = created.json() as { sessionId: string };
  return { sessionId, credential: sessionCredentialFromSetCookie(created) };
}

describe("插件装配面(WP-4 取用点)", () => {
  it("authRuntimeDeps 装饰与注入端口同源,凭证 preHandler 由此组装", async () => {
    const rig = await buildAuthTestRig();
    expect(rig.app.authRuntimeDeps.signer).toBe(rig.signer);
    expect(rig.app.authRuntimeDeps.issuanceStore).toBe(rig.issuanceStore);
    expect(rig.app.authRuntimeDeps.revocationStore).toBe(rig.revocationStore);
    expect(rig.app.authRuntimeDeps.audit).toBe(rig.audit);
    expect(rig.app.authRuntimeDeps.config.embedTokenTtlSeconds).toBe(
      rig.config.embedTokenTtlSeconds,
    );
  });
});

describe("合法链路端到端(签发 → 消费 → 凭证 → 受保护路由)", () => {
  it("全链路绿:cookie 呈递的受保护路由返回与 token 一致的 principal;Set-Cookie 属性齐全", async () => {
    const rig = await buildAuthTestRig();
    const { sessionId, credential } = await fullChain(rig);

    const action = await rig.app.inject({
      method: "POST",
      url: "/test/actions",
      headers: {
        cookie: `sm_session_credential=${credential}`,
        origin: "https://plugin.example",
      },
      payload: { payload: { sessionId } },
    });
    expect(action.statusCode).toBe(200);
    expect(action.json()).toEqual({
      principal: { tenantId: TEST_TENANT_ID, userId: TEST_USER_ID },
      sessionId,
    });

    // 凭证 Cookie 属性(D-API-12 / 13):HttpOnly + SameSite=Strict + 精确
    // Path;NODE_ENV=test 豁免 Secure(http 注入测试)。
    const created = await rig.app.inject({
      method: "POST",
      url: "/test/sessions",
      payload: { garbage: true },
    });
    expect(created.statusCode).toBe(400); // 替身路由先做形态闸
    const setCookie = await (async () => {
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
      return response.headers["set-cookie"];
    })();
    const raw = Array.isArray(setCookie) ? String(setCookie[0]) : String(setCookie);
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Strict");
    expect(raw).toContain("Path=/sessions");
    expect(raw).not.toContain("Secure"); // test 环境豁免(D-API-13)

    // 审计链:issued → consumed → credential_issued → create_session → submit。
    const kinds = rig.audit.snapshot().map((event) => event.kind);
    for (const expected of [
      "embed_token_issued",
      "embed_token_consumed",
      "session_credential_issued",
      "create_session",
      "submit",
    ]) {
      expect(kinds).toContain(expected);
    }
  });
});

describe("传输卫生(凭证不入 URL / 日志 / 错误响应)", () => {
  it("日志捕获全量零凭证材料:embed token 与会话凭证均不出现在任何日志行", async () => {
    const rig = await buildAuthTestRig();
    const { credential } = await fullChain(rig);
    const raw = rig.capture.raw();
    expect(raw.length).toBeGreaterThan(0); // 日志面确有产出
    expect(raw).not.toContain(credential);
    // embed token 的 JWT 三段结构语料全量扫描。
    expect(raw).not.toMatch(/ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/);
  });

  it("拒绝响应体零凭证材料:红灯路径的 401 体不含呈递过的任何 token", async () => {
    const rig = await buildAuthTestRig();
    const { credential } = await fullChain(rig);
    const presented = ["forged.token.material", credential];
    for (const token of presented) {
      const response = await rig.app.inject({
        method: "POST",
        url: "/test/actions",
        headers: { authorization: `Bearer ${token}` },
        payload: { payload: { sessionId: "sess-x" } },
      });
      expect(response.statusCode).toBe(401);
      expect(() => PublicErrorSchema.parse(response.json())).not.toThrow();
      expect(response.body).not.toContain(token);
    }
  });

  it("凭证不出现在 URL:签发与消费均为 POST 体交付,请求 URL 无 query 面", async () => {
    const rig = await buildAuthTestRig();
    const embedSessionId = makeEmbedSessionId();
    const issuance = await rig.app.inject({
      method: "POST",
      url: EMBED_TOKEN_ISSUANCE_ROUTE,
      headers: rig.hostHeaders(),
      payload: {
        tenantId: TEST_TENANT_ID,
        userId: TEST_USER_ID,
        challengeId: TEST_CHALLENGE_ID,
        challengeVersion: TEST_CHALLENGE_VERSION,
        embedSessionId,
      },
    });
    expect(issuance.statusCode).toBe(201);
    const { embedToken } = issuance.json() as { embedToken: string };
    const created = await rig.app.inject({
      method: "POST",
      url: "/test/sessions",
      payload: {
        embedToken,
        challengeId: TEST_CHALLENGE_ID,
        challengeVersion: TEST_CHALLENGE_VERSION,
        embedSessionId,
      },
    });
    expect(created.statusCode).toBe(201);
    // 日志中的请求 URL 白名单面(method / url)不含任何凭证材料或 query 载荷。
    const urls = rig.capture
      .entries()
      .map((entry) => entry["req"])
      .filter((req): req is Record<string, unknown> => typeof req === "object" && req !== null)
      .map((req) => String(req["url"] ?? ""));
    expect(urls).toContain(EMBED_TOKEN_ISSUANCE_ROUTE);
    expect(urls).toContain("/test/sessions");
    for (const url of urls) {
      expect(url).not.toContain(embedToken.slice(0, 24));
      expect(url).not.toContain("?");
    }
  });
});

describe("审计面:七类事件可观察 + 零秘密语料", () => {
  it("强制终止事件与会话凭证吊销组合(编排路径演示)后,事件面完整且零凭证材料", async () => {
    const rig = await buildAuthTestRig();
    const { sessionId, credential } = await fullChain(rig);
    const claims = await rig.signer.verifySessionCredential(credential);

    // 吊销前:凭证正常提交一次(submit 审计)。
    const beforeRevoke = await rig.app.inject({
      method: "POST",
      url: "/test/actions",
      headers: {
        cookie: `sm_session_credential=${credential}`,
        origin: "https://plugin.example",
      },
      payload: { payload: { sessionId } },
    });
    expect(beforeRevoke.statusCode).toBe(200);

    // 强制终止(编排路径;WP-6):吊销凭证 + session_force_closed 审计。
    const { revokeSessionCredential } = await import("../../src/auth/index.js");
    await revokeSessionCredential(
      { revocationStore: rig.revocationStore },
      claims.jti,
      3600,
    );
    await rig.audit.append({
      kind: "session_force_closed",
      at: Date.now(),
      actor: { tenantId: TEST_TENANT_ID, userId: TEST_USER_ID },
      sessionId,
      detail: { reasonCode: "operator_request" },
    });
    // 吊销后原凭证即失效(确定性拒绝)。
    const afterRevoke = await rig.app.inject({
      method: "POST",
      url: "/test/actions",
      headers: {
        cookie: `sm_session_credential=${credential}`,
        origin: "https://plugin.example",
      },
      payload: { payload: { sessionId } },
    });
    expect(afterRevoke.statusCode).toBe(401);

    const events = rig.audit.snapshot();
    for (const kind of [
      "embed_token_issued",
      "embed_token_consumed",
      "session_credential_issued",
      "create_session",
      "submit",
      "session_force_closed",
    ]) {
      expect(events.map((event) => event.kind)).toContain(kind);
    }
    const raw = JSON.stringify(events);
    expect(raw).not.toContain(credential);
    expect(raw).not.toMatch(/ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/);
  });
});

/**
 * embed token 签发端点测试(POST /auth/embed-tokens;嵌入协议 §六 / D-API-11
 * / 15 / 16):宿主凭证认证(无凭证签发拒绝)、请求体契约、响应体 JSON 交付、
 * CORS 精确来源白名单、日志卫生。
 */

import { PublicErrorSchema } from "@stackmaster/protocol";
import { EmbedTokenClaimsSchema } from "@stackmaster/protocol/server-only";
import { describe, expect, it } from "vitest";

import {
  EMBED_TOKEN_ISSUANCE_ROUTE,
  type EmbedTokenIssuanceResponse,
} from "../../src/auth/index.js";
import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  TEST_TENANT_ID,
  TEST_USER_ID,
  buildAuthTestRig,
  makeEmbedSessionId,
  type AuthTestRig,
} from "../helpers/auth-rig.js";

function issuanceBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    tenantId: TEST_TENANT_ID,
    userId: TEST_USER_ID,
    challengeId: TEST_CHALLENGE_ID,
    challengeVersion: TEST_CHALLENGE_VERSION,
    embedSessionId: makeEmbedSessionId(),
    ...overrides,
  };
}

async function rigWithoutAllowedOrigins(): Promise<AuthTestRig> {
  return buildAuthTestRig({ env: { SESSION_API_ALLOWED_ORIGINS: "" } });
}

describe("签发端点:合法链路", () => {
  it("合法宿主凭证:201 + 响应体 JSON 交付(embedToken + expiresAt),签发记录带 TTL 入库,审计 embed_token_issued", async () => {
    const rig = await buildAuthTestRig();
    const embedSessionId = makeEmbedSessionId();
    const response = await rig.app.inject({
      method: "POST",
      url: EMBED_TOKEN_ISSUANCE_ROUTE,
      headers: rig.hostHeaders(),
      payload: issuanceBody({ embedSessionId }),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as EmbedTokenIssuanceResponse;
    expect(typeof body.embedToken).toBe("string");

    // 响应体零多余字段(交付面最小);claims 过冻结 Schema(七字段)。
    expect(Object.keys(body).sort()).toEqual(["embedToken", "expiresAt"]);
    expect(response.headers["set-cookie"]).toBeUndefined();

    // token 可解析且绑定与请求体一致;签发记录在 store(TTL 内可消费)。
    const claims = await rig.signer.verifyEmbedToken(body.embedToken);
    expect(EmbedTokenClaimsSchema.parse(claims)).toMatchObject({
      tenantId: TEST_TENANT_ID,
      userId: TEST_USER_ID,
      challengeId: TEST_CHALLENGE_ID,
      challengeVersion: TEST_CHALLENGE_VERSION,
      embedSessionId,
    });
    expect(claims.jti.length).toBeGreaterThan(0);
    const record = await rig.issuanceStore.consume(claims.jti);
    expect(record).not.toBeNull();
    expect(record?.tenantId).toBe(TEST_TENANT_ID);

    const issuedEvents = rig.audit
      .snapshot()
      .filter((event) => event.kind === "embed_token_issued");
    expect(issuedEvents.length).toBe(1);
    expect(issuedEvents[0]?.actor).toEqual({ tenantId: TEST_TENANT_ID, userId: TEST_USER_ID });

    // 传输卫生:token 不进 URL(POST 体)、不入日志。
    expect(captureUrls(rig)).not.toContain(body.embedToken);
    expect(rig.capture.raw()).not.toContain(body.embedToken);
  });

  it("TTL 上限生效:SESSION_API_EMBED_TOKEN_TTL_SECONDS 超过 MAX_EMBED_TOKEN_TTL_SECONDS 拒绝启动", async () => {
    await expect(buildAuthTestRig({ env: { SESSION_API_EMBED_TOKEN_TTL_SECONDS: "604801" } })).rejects.toThrow(
      /SESSION_API_EMBED_TOKEN_TTL_SECONDS/,
    );
  });
});

describe("签发端点:宿主无凭证 / 错凭证签发拒绝(红灯)", () => {
  const matrix: ReadonlyArray<[name: string, headers: Record<string, string> | undefined]> = [
    ["无 Authorization 头", undefined],
    ["非 Bearer 形态", { authorization: `Basic ${TEST_TENANT_ID}` }],
    ["错误共享凭证", { authorization: "Bearer not-the-host-token-0123456789" }],
  ];
  for (const [name, headers] of matrix) {
    it(`${name} → 统一 401 冻结形态(先认证后校验体,畸形体同样 401)`, async () => {
      const rig = await buildAuthTestRig();
      const frozen = { code: "invalid_input_format", message: "authentication failed" };
      for (const payload of [issuanceBody(), { garbage: true }]) {
        const response = await rig.app.inject({
          method: "POST",
          url: EMBED_TOKEN_ISSUANCE_ROUTE,
          headers: headers ?? {},
          payload,
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual(frozen);
        expect(() => PublicErrorSchema.parse(response.json())).not.toThrow();
      }
      // 拒绝路径零审计签发事件、零签发记录。
      expect(rig.audit.snapshot().filter((e) => e.kind === "embed_token_issued")).toHaveLength(0);
      const reasons = rig.capture
        .entries()
        .filter((entry) => entry["msg"] === "embed token issuance rejected")
        .map((entry) => entry["reason"]);
      expect(reasons).toContain("host_backend_token_invalid");
    });
  }
});

describe("签发端点:请求体契约(已过宿主认证后)", () => {
  it("多余身份字段(strictObject)/ 缺字段 / 非法版本 → 400 冻结形态,零校验器细节", async () => {
    const rig = await buildAuthTestRig();
    const bodies: ReadonlyArray<Record<string, unknown>> = [
      issuanceBody({ tenantId: "tenant-attacker", injectedRole: "admin" }), // 自报字段
      issuanceBody({ challengeVersion: "not-semver" }),
      { tenantId: TEST_TENANT_ID }, // 缺字段
      issuanceBody({ embedSessionId: "short" }), // 低于熵下限
    ];
    for (const body of bodies) {
      const response = await rig.app.inject({
        method: "POST",
        url: EMBED_TOKEN_ISSUANCE_ROUTE,
        headers: rig.hostHeaders(),
        payload: body,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: "invalid_input_format", message: "invalid request" });
      // 响应面零校验器细节(字段路径 / 原始文本只进受控日志)。
      expect(response.body).not.toContain("issue");
      expect(response.body).not.toContain("路径");
      const logged = rig.capture
        .entries()
        .filter((entry) => entry["msg"] === "embed token issuance rejected")
        .map((entry) => entry["reason"]);
      expect(logged).toContain("invalid_issuance_body");
    }
  });
});

describe("签发端点:CORS 精确来源白名单(D-API-16)", () => {
  it("白名单来源:ACAO 精确回显 + 允许凭据", async () => {
    const rig = await buildAuthTestRig();
    const response = await rig.app.inject({
      method: "OPTIONS",
      url: EMBED_TOKEN_ISSUANCE_ROUTE,
      headers: {
        origin: "https://plugin.example",
        "access-control-request-method": "POST",
      },
    });
    expect(response.headers["access-control-allow-origin"]).toBe("https://plugin.example");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("非白名单 / 空:不回 ACAO 头(拒绝不透出配置细节),非浏览器请求不受影响", async () => {
    const rig = await rigWithoutAllowedOrigins();
    const preflight = await rig.app.inject({
      method: "OPTIONS",
      url: EMBED_TOKEN_ISSUANCE_ROUTE,
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    // 非浏览器调用方(宿主后端,无 Origin 头)照常签发。
    const response = await rig.app.inject({
      method: "POST",
      url: EMBED_TOKEN_ISSUANCE_ROUTE,
      headers: rig.hostHeaders(),
      payload: issuanceBody(),
    });
    expect(response.statusCode).toBe(201);
  });
});

function captureUrls(rig: AuthTestRig): string[] {
  return rig.capture
    .entries()
    .map((entry) => entry["req"])
    .filter((req): req is Record<string, unknown> => typeof req === "object" && req !== null)
    .map((req) => String(req["url"] ?? ""));
}

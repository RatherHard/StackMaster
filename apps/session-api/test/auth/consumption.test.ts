/**
 * create-session 三方比对消费测试(consumption.ts;嵌入协议 §六 / D-API-14):
 * 签名 claims × 签发记录 × 请求上下文,任一不一致 fail-closed;jti 单次原子
 * 消费;拒绝 reason 只进受控日志与审计。
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  EmbedTokenConsumptionRejected,
  consumeEmbedToken,
  createTokenSigner,
  revokeEmbedToken,
  type TokenIssuanceStore,
} from "../../src/auth/index.js";
import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  TEST_TENANT_ID,
  TEST_USER_ID,
  buildAuthTestRig,
  makeEmbedSessionId,
} from "../helpers/auth-rig.js";

type Rig = Awaited<ReturnType<typeof buildAuthTestRig>>;

/** 通过替身路由整链消费(与消费服务同一代码路径),返回响应。 */
async function consumeViaRoute(
  rig: Rig,
  embedToken: string,
  overrides?: { challengeId?: string; challengeVersion?: string; embedSessionId?: string },
) {
  return rig.app.inject({
    method: "POST",
    url: "/test/sessions",
    payload: {
      embedToken,
      challengeId: overrides?.challengeId ?? TEST_CHALLENGE_ID,
      challengeVersion: overrides?.challengeVersion ?? TEST_CHALLENGE_VERSION,
      embedSessionId: overrides?.embedSessionId ?? makeEmbedSessionId(),
    },
  });
}

describe("三方比对消费:合法路径", () => {
  it("签发 → 消费返回 201 + sessionId;audit 记 embed_token_consumed(accepted)与 create_session", async () => {
    const rig = await buildAuthTestRig();
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
    const body = response.json() as { sessionId: string };
    expect(body.sessionId).toMatch(/^[A-Za-z0-9_-]+$/);

    const kinds = rig.audit.snapshot().map((event) => event.kind);
    expect(kinds).toContain("embed_token_consumed");
    expect(kinds).toContain("create_session");
    const consumed = rig.audit.snapshot().find((event) => event.kind === "embed_token_consumed");
    expect(consumed?.detail).toMatchObject({ outcome: "accepted", jti: issued.claims.jti });
  });
});

describe("三方比对消费:红灯矩阵(统一 401 冻结形态)", () => {
  const FROZEN_401 = { code: "invalid_input_format", message: "authentication failed" };

  it("已消费 jti 重放:第二次消费确定性拒绝(单次消费语义)", async () => {
    const rig = await buildAuthTestRig();
    const issued = await rig.issueEmbedToken();
    const payload = () => ({
      embedToken: issued.token,
      challengeId: TEST_CHALLENGE_ID,
      challengeVersion: TEST_CHALLENGE_VERSION,
      embedSessionId: issued.claims.embedSessionId,
    });
    const first = await rig.app.inject({ method: "POST", url: "/test/sessions", payload: payload() });
    expect(first.statusCode).toBe(201);
    const replay = await rig.app.inject({ method: "POST", url: "/test/sessions", payload: payload() });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual(FROZEN_401);
    // 拒绝细节只进受控日志:reason = unknown_jti(无有效签发记录)。
    expect(rejectionReasons(rig)).toContain("unknown_jti");
  });

  it("过期 token:确定性拒绝(reason = expired)", async () => {
    let now = 1_000_000_000_000;
    const rig = await buildAuthTestRig({ now: () => now });
    const issued = await rig.issueEmbedToken({ ttlSeconds: 60 });
    now += 61_000; // 时钟越过有效期
    const response = await consumeViaRoute(rig, issued.token, {
      embedSessionId: issued.claims.embedSessionId,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(FROZEN_401);
    expect(rejectionReasons(rig)).toContain("expired");
  });

  it("伪造签名(他密钥签发):确定性拒绝(reason = signature_invalid),不消费任何记录", async () => {
    const rig = await buildAuthTestRig();
    const { privateKey } = generateKeyPairSync("ed25519");
    const forger = await createTokenSigner(privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const forged = await forger.signEmbedToken((await rig.issueEmbedToken()).claims);
    const issuedCountBefore = rig.audit.snapshot().filter((e) => e.kind === "embed_token_issued").length;
    const response = await consumeViaRoute(rig, forged);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(FROZEN_401);
    expect(rejectionReasons(rig)).toContain("signature_invalid");
    // 伪造路径不产生任何签发事件(签发面计数不变)。
    expect(
      rig.audit.snapshot().filter((e) => e.kind === "embed_token_issued").length,
    ).toBe(issuedCountBefore);
  });

  it("跨租户(签发记录租户与签名 claims 不一致):确定性拒绝(reason = record_mismatch)", async () => {
    const rig = await buildAuthTestRig();
    const issued = await rig.issueEmbedToken();
    // 篡改签发记录的租户锚(模拟签发存储被换到他租户记录)。
    await rig.issuanceStore.revoke(issued.claims.jti);
    await rig.issuanceStore.put({ ...issued.record, tenantId: "tenant-other" }, 3600);
    const response = await consumeViaRoute(rig, issued.token, {
      embedSessionId: issued.claims.embedSessionId,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(FROZEN_401);
    expect(rejectionReasons(rig)).toContain("record_mismatch");
  });

  it("跨题目版本绑定(请求上下文版本 ≠ claims):确定性拒绝(reason = context_mismatch)", async () => {
    const rig = await buildAuthTestRig();
    const issued = await rig.issueEmbedToken();
    const response = await consumeViaRoute(rig, issued.token, {
      challengeVersion: "9.9.9",
      embedSessionId: issued.claims.embedSessionId,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(FROZEN_401);
    expect(rejectionReasons(rig)).toContain("context_mismatch");
  });

  it("embedSessionId 绑定不符(重载换会话):确定性拒绝(reason = context_mismatch)", async () => {
    const rig = await buildAuthTestRig();
    const issued = await rig.issueEmbedToken();
    const response = await consumeViaRoute(rig, issued.token, {
      embedSessionId: makeEmbedSessionId(), // 新 embedSessionId(iframe 重载)
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(FROZEN_401);
    expect(rejectionReasons(rig)).toContain("context_mismatch");
  });

  it("吊销后使用(revokeEmbedToken 删除 token:{jti}):确定性拒绝 + embed_token_revoked 审计", async () => {
    const rig = await buildAuthTestRig();
    const issued = await rig.issueEmbedToken();
    const removed = await revokeEmbedToken(
      { issuanceStore: rig.issuanceStore, audit: rig.audit },
      { jti: issued.claims.jti, tenantId: TEST_TENANT_ID, userId: TEST_USER_ID },
    );
    expect(removed).toBe(true);
    const response = await consumeViaRoute(rig, issued.token, {
      embedSessionId: issued.claims.embedSessionId,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(FROZEN_401);
    expect(rig.audit.snapshot().map((e) => e.kind)).toContain("embed_token_revoked");
    expect(rejectionReasons(rig)).toContain("unknown_jti");
  });

  it("失败响应面防枚举:全部红灯的响应体字节相同(状态 / 码 / 文案零差异)", async () => {
    const rig = await buildAuthTestRig();
    const issued = await rig.issueEmbedToken();
    const payload = () => ({
      embedToken: issued.token,
      challengeId: TEST_CHALLENGE_ID,
      challengeVersion: TEST_CHALLENGE_VERSION,
      embedSessionId: issued.claims.embedSessionId,
    });
    // 先合法消费一次,使后续同 token 请求全部落入红灯形态。
    const accepted = await rig.app.inject({ method: "POST", url: "/test/sessions", payload: payload() });
    expect(accepted.statusCode).toBe(201);
    const responses = [
      // 已消费 jti 重放。
      await rig.app.inject({ method: "POST", url: "/test/sessions", payload: payload() }),
      // 上下文绑定不符(题目版本)。
      await consumeViaRoute(rig, issued.token, { challengeVersion: "9.9.9" }),
      // 伪造 / 畸形载体。
      await rig.app.inject({
        method: "POST",
        url: "/test/sessions",
        payload: {
          embedToken: "totally-invalid-token",
          challengeId: TEST_CHALLENGE_ID,
          challengeVersion: TEST_CHALLENGE_VERSION,
          embedSessionId: makeEmbedSessionId(),
        },
      }),
    ];
    const bodies = responses.map((response) => response.body);
    expect(responses.every((response) => response.statusCode === 401)).toBe(true);
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toBe(JSON.stringify({ code: "invalid_input_format", message: "authentication failed" }));
  });
});

describe("消费服务直接调用(reason 语义)", () => {
  it("EmbedTokenConsumptionRejected 携带封闭 reason;记录面不区分四种无记录形态", async () => {
    const rig = await buildAuthTestRig();
    const issued = await rig.issueEmbedToken();
    const base = {
      challengeId: TEST_CHALLENGE_ID,
      challengeVersion: TEST_CHALLENGE_VERSION,
      embedSessionId: issued.claims.embedSessionId,
    };
    const deps = {
      signer: rig.signer,
      issuanceStore: rig.issuanceStore as TokenIssuanceStore,
      audit: rig.audit,
      logger: rig.logger,
    };
    await expect(
      consumeEmbedToken(deps, { embedToken: issued.token, context: base }),
    ).resolves.toMatchObject({ tenantId: TEST_TENANT_ID, embedTokenJti: issued.claims.jti });
    // 重放 → unknown_jti。
    await expect(
      consumeEmbedToken(deps, { embedToken: issued.token, context: base }),
    ).rejects.toMatchObject({ reason: "unknown_jti" });
    // 未签发 token(签名合法但无记录)→ unknown_jti。
    const stranger = await rig.issueEmbedToken();
    await rig.issuanceStore.revoke(stranger.claims.jti);
    await expect(
      consumeEmbedToken(deps, {
        embedToken: stranger.token,
        context: {
          challengeId: TEST_CHALLENGE_ID,
          challengeVersion: TEST_CHALLENGE_VERSION,
          embedSessionId: stranger.claims.embedSessionId,
        },
      }),
    ).rejects.toMatchObject({ reason: "unknown_jti" });
    // 类型面冒烟:拒绝异常是封闭类型。
    expect(new EmbedTokenConsumptionRejected("malformed", "x").reason).toBe("malformed");
  });
});

function rejectionReasons(rig: Rig): string[] {
  return rig.capture
    .entries()
    .filter((entry) => entry["msg"] === "embed token consumption rejected")
    .map((entry) => String(entry["reason"]));
}

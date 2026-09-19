/**
 * create-session 三方比对消费测试(consumption.ts 的**启动授权凭证**消费面;
 * D-LT-5 5c / D-API-14):签名 claims × 签发记录 × payload 导航信息,任一不一致
 * fail-closed;jti 单次原子消费;拒绝 reason 只进受控日志。
 *
 * **2026-09-19(WP-96)**:本文件的前身测的是 embed token 消费
 * (`consumeEmbedToken`,嵌入协议 §六)。该面已随嵌入协议面与 create_session 的
 * v1 分支**物理删除**;被测语义(三方比对顺序、四类拒绝、单次消费、防枚举
 * 统一响应面、reason 只进日志)**逐条由启动授权凭证消费承接**
 * (`consumeLaunchGrant`,D-LT-5 5c 明示"顺序与 consumeEmbedToken 逐条同构")。
 * 红灯矩阵逐条保留,并把"拒绝不写入任何审计 kind"登记为独立用例
 * (D-LT-5 第 7 条:审计十值封闭集不变 ⇒ 本族零审计写入)。
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  LAUNCH_GRANT_COOKIE_NAME,
  LaunchGrantConsumptionRejected,
  consumeLaunchGrant,
  createTokenSigner,
} from "../../src/auth/index.js";
import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  TEST_TENANT_ID,
  buildAuthTestRig,
} from "../helpers/auth-rig.js";

type Rig = Awaited<ReturnType<typeof buildAuthTestRig>>;

/** 带授权凭证 Cookie 发起 create_session(与消费服务同一代码路径)。 */
async function consumeViaRoute(
  rig: Rig,
  grantToken: string,
  overrides?: { challengeId?: string; challengeVersion?: string; omitCookie?: boolean },
) {
  const headers =
    overrides?.omitCookie === true ? {} : { cookie: `${LAUNCH_GRANT_COOKIE_NAME}=${grantToken}` };
  return rig.app.inject({
    method: "POST",
    url: "/test/sessions",
    headers,
    payload: {
      challengeId: overrides?.challengeId ?? TEST_CHALLENGE_ID,
      challengeVersion: overrides?.challengeVersion ?? TEST_CHALLENGE_VERSION,
    },
  });
}

describe("三方比对消费:合法路径", () => {
  it("铸造 → 消费返回 201 + sessionId;audit 记 create_session 与 session_credential_issued", async () => {
    const rig = await buildAuthTestRig();
    const issued = await rig.issueLaunchGrant();
    const response = await consumeViaRoute(rig, issued.token);
    expect(response.statusCode).toBe(201);
    const body = response.json() as { sessionId: string };
    expect(body.sessionId).toMatch(/^[A-Za-z0-9_-]+$/);

    const kinds = rig.audit.snapshot().map((event) => event.kind);
    expect(kinds).toContain("create_session");
    expect(kinds).toContain("session_credential_issued");
  });
});

describe("三方比对消费:红灯矩阵(统一 401 冻结形态)", () => {
  const FROZEN_401 = { code: "invalid_input_format", message: "authentication failed" };

  it("已消费 jti 重放:第二次消费确定性拒绝(单次消费语义)", async () => {
    const rig = await buildAuthTestRig();
    const issued = await rig.issueLaunchGrant();
    const first = await consumeViaRoute(rig, issued.token);
    expect(first.statusCode).toBe(201);
    const replay = await consumeViaRoute(rig, issued.token);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual(FROZEN_401);
    // 拒绝细节只进受控日志:reason = unknown_jti(无有效签发记录)。
    expect(rejectionReasons(rig)).toContain("unknown_jti");
  });

  it("过期凭证:确定性拒绝(reason = expired)", async () => {
    let now = 1_000_000_000_000;
    const rig = await buildAuthTestRig({ now: () => now });
    const issued = await rig.issueLaunchGrant({ ttlSeconds: 60 });
    now += 61_000; // 时钟越过有效期
    const response = await consumeViaRoute(rig, issued.token);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(FROZEN_401);
    expect(rejectionReasons(rig)).toContain("expired");
  });

  it("伪造签名(他密钥签发):确定性拒绝(reason = signature_invalid),不消费任何记录", async () => {
    const rig = await buildAuthTestRig();
    const { privateKey } = generateKeyPairSync("ed25519");
    const forger = await createTokenSigner(privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const issued = await rig.issueLaunchGrant();
    const forged = await forger.signLaunchGrant(issued.claims);
    const response = await consumeViaRoute(rig, forged);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(FROZEN_401);
    expect(rejectionReasons(rig)).toContain("signature_invalid");
    // 伪造路径不消费任何记录:原签发记录仍可被合法持有者消费。
    await expect(rig.grantStore.consume(issued.claims.jti)).resolves.toBeDefined();
  });

  it("跨租户(签发记录租户与签名 claims 不一致):确定性拒绝(reason = record_mismatch)", async () => {
    const rig = await buildAuthTestRig();
    const issued = await rig.issueLaunchGrant();
    // 篡改签发记录的租户锚(模拟签发存储被换到他租户记录)。
    await rig.grantStore.put({ ...issued.record, tenantId: "tenant-other" }, 3600);
    const response = await consumeViaRoute(rig, issued.token);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(FROZEN_401);
    expect(rejectionReasons(rig)).toContain("record_mismatch");
  });

  it("跨题目版本绑定(payload 版本 ≠ 凭证 claims):确定性拒绝(reason = payload_mismatch)", async () => {
    const rig = await buildAuthTestRig();
    const issued = await rig.issueLaunchGrant();
    const response = await consumeViaRoute(rig, issued.token, { challengeVersion: "9.9.9" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(FROZEN_401);
    expect(rejectionReasons(rig)).toContain("payload_mismatch");
  });

  it("跨题目绑定(payload challengeId ≠ 凭证 claims):确定性拒绝(reason = payload_mismatch)", async () => {
    const rig = await buildAuthTestRig();
    const issued = await rig.issueLaunchGrant();
    const response = await consumeViaRoute(rig, issued.token, { challengeId: "chal-other" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(FROZEN_401);
    expect(rejectionReasons(rig)).toContain("payload_mismatch");
  });

  it("缺失授权凭证 Cookie:确定性拒绝(reason 面零差异,不消费任何票据面)", async () => {
    const rig = await buildAuthTestRig();
    const issued = await rig.issueLaunchGrant();
    const response = await consumeViaRoute(rig, issued.token, { omitCookie: true });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(FROZEN_401);
  });

  it("失败响应面防枚举:全部红灯的响应体字节相同(状态 / 码 / 文案零差异)", async () => {
    const rig = await buildAuthTestRig();
    const issued = await rig.issueLaunchGrant();
    // 先合法消费一次,使后续同 token 请求全部落入红灯形态。
    const accepted = await consumeViaRoute(rig, issued.token);
    expect(accepted.statusCode).toBe(201);
    const responses = [
      // 已消费 jti 重放。
      await consumeViaRoute(rig, issued.token),
      // payload 绑定不符(题目版本)。
      await consumeViaRoute(rig, issued.token, { challengeVersion: "9.9.9" }),
      // 伪造 / 畸形载体。
      await consumeViaRoute(rig, "totally-invalid-token"),
    ];
    const bodies = responses.map((response) => response.body);
    expect(responses.every((response) => response.statusCode === 401)).toBe(true);
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toBe(JSON.stringify({ code: "invalid_input_format", message: "authentication failed" }));
  });
});

describe("消费服务直接调用(reason 语义)", () => {
  it("LaunchGrantConsumptionRejected 携带封闭 reason;记录面不区分三种无记录形态", async () => {
    const rig = await buildAuthTestRig();
    const issued = await rig.issueLaunchGrant();
    const payload = {
      challengeId: TEST_CHALLENGE_ID,
      challengeVersion: TEST_CHALLENGE_VERSION,
    };
    const deps = {
      signer: rig.signer,
      grantStore: rig.grantStore,
      logger: rig.logger,
    };
    await expect(
      consumeLaunchGrant(deps, { grantToken: issued.token, payload }),
    ).resolves.toMatchObject({ tenantId: TEST_TENANT_ID, launchGrantJti: issued.claims.jti });
    // 重放 → unknown_jti。
    await expect(
      consumeLaunchGrant(deps, { grantToken: issued.token, payload }),
    ).rejects.toMatchObject({ reason: "unknown_jti" });
    // 签名合法但无记录 → unknown_jti(与"已消费"同形)。
    const stranger = await rig.issueLaunchGrant();
    await rig.grantStore.consume(stranger.claims.jti);
    await expect(
      consumeLaunchGrant(deps, { grantToken: stranger.token, payload }),
    ).rejects.toMatchObject({ reason: "unknown_jti" });
    // 类型面冒烟:拒绝异常是封闭类型。
    expect(new LaunchGrantConsumptionRejected("malformed", "x").reason).toBe("malformed");
  });
});

describe("★ 机检:授权凭证消费面零审计写入(D-LT-5 第 7 条)", () => {
  it("接受路径与拒绝路径都不新增任何 audit 事件(十值封闭集不变)", async () => {
    const rig = await buildAuthTestRig();
    // 接受路径:唯一允许写入的审计来自 create_session / 会话凭证签发。
    const accepted = await rig.issueLaunchGrant();
    expect((await consumeViaRoute(rig, accepted.token)).statusCode).toBe(201);
    const afterAccepted = rig.audit.snapshot().map((event) => event.kind);
    expect(afterAccepted).toEqual(["session_credential_issued", "create_session"]);

    // 拒绝路径:过期 / 重放 / 绑定不符一律零审计写入。
    const before = rig.audit.size;
    const replay = await consumeViaRoute(rig, accepted.token);
    expect(replay.statusCode).toBe(401);
    const mismatched = await consumeViaRoute(rig, accepted.token, { challengeVersion: "9.9.9" });
    expect(mismatched.statusCode).toBe(401);
    const malformed = await consumeViaRoute(rig, "not-a-jwt");
    expect(malformed.statusCode).toBe(401);
    expect(rig.audit.size).toBe(before);
    // 且现行链路上三个 embed 域 kind 恒不出现(现无写入方)。
    for (const retired of ["embed_token_issued", "embed_token_consumed", "embed_token_revoked"]) {
      expect(rig.audit.snapshot().map((event) => event.kind)).not.toContain(retired);
    }
  });
});

function rejectionReasons(rig: Rig): string[] {
  return rig.capture
    .entries()
    .filter((entry) => entry["msg"] === "launch grant consumption rejected")
    .map((entry) => String(entry["reason"]));
}

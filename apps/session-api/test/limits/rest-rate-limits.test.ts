/**
 * REST 限流触顶红灯(任务分解 WP-6 第 1 条;D-API-35 / D-API-50 / D-API-52):
 *  - 每租户 / 每用户请求频率:create-session 守卫 + 凭证保护命令共闸,
 *    触顶 = 429 + 冻结 PublicError(budget_exhausted / "rate limit exceeded"),
 *    非 5xx、非静默;两次触顶响应逐字节一致(同状态同请求字节相同,I-4);
 *  - 提交频率闸:submit 专属维度(rate:{tenant}:{user}:submit),触顶同形;
 *  - 每租户并发会话预算:guard 早期快检与 manager 同步入场预留双侧呈现同一
 *    冻结形态;租户间隔离;close 释放预算;并发创建窗口不超卖;
 *  - 计数键域:rate:{tenant}:{user}(WP-3 键域纪律)。
 */
import { describe, expect, it } from "vitest";
import { PublicErrorSchema, type PublicError } from "@stackmaster/protocol";

import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  TEST_TENANT_ID,
  TEST_TENANT_BETA_ID,
  TEST_USER_ID,
  buildSessionTestRig,
  sessionCommand,
  sessionCredentialFromSetCookie,
  credentialHeaders,
  type SessionTestRig,
} from "../routes/helpers/session-rig.js";

const RATE_LIMIT_BODY = JSON.stringify({ code: "budget_exhausted", message: "rate limit exceeded" });
const CONCURRENCY_BODY = JSON.stringify({
  code: "budget_exhausted",
  message: "concurrent session budget exceeded",
});

interface CreateOutcome {
  status: number;
  bodyText: string;
  body: unknown;
  sessionId?: string;
  cookie?: string;
}

/** create-session 请求(冻结信封;embed token 由 rig 签发面提供)。 */
async function createSession(
  rig: SessionTestRig,
  overrides: { tenantId?: string; userId?: string; challengeId?: string } = {},
): Promise<CreateOutcome> {
  const challengeId = overrides.challengeId ?? TEST_CHALLENGE_ID;
  const issued = await rig.issueEmbedToken({
    ...(overrides.tenantId === undefined && overrides.userId === undefined
      ? {}
      : {
          claims: {
            ...(overrides.tenantId === undefined ? {} : { tenantId: overrides.tenantId }),
            ...(overrides.userId === undefined ? {} : { userId: overrides.userId }),
            ...(overrides.challengeId === undefined ? {} : { challengeId: overrides.challengeId }),
          },
        }),
  });
  const response = await rig.app.inject({
    method: "POST",
    url: "/sessions",
    payload: sessionCommand("create_session", {
      challengeId,
      challengeVersion: TEST_CHALLENGE_VERSION,
      embedSessionId: issued.claims.embedSessionId,
      embedToken: issued.token,
    }),
  });
  const outcome: CreateOutcome = {
    status: response.statusCode,
    bodyText: response.body,
    body: response.json(),
  };
  if (response.statusCode === 201) {
    outcome.sessionId = (response.json() as { payload: { sessionId: string } }).payload.sessionId;
    outcome.cookie = sessionCredentialFromSetCookie({
      headers: response.headers as Record<string, unknown>,
    });
  }
  return outcome;
}

/** submit 命令请求(Cookie 呈递 + CSRF Origin)。 */
async function submitCommand(
  rig: SessionTestRig,
  sessionId: string,
  cookie: string,
): Promise<{ status: number; bodyText: string }> {
  const response = await rig.app.inject({
    method: "POST",
    url: "/sessions/submissions",
    cookies: { sm_session_credential: cookie },
    headers: credentialHeaders(),
    payload: sessionCommand("submit", { sessionId }),
  });
  return { status: response.statusCode, bodyText: response.body };
}

describe("每租户 / 每用户请求频率触顶(create-session 守卫,D-API-50)", () => {
  it("窗口内第 3 次 create_session 确定性 429;两次触顶响应逐字节一致", async () => {
    const rig = await buildSessionTestRig({
      env: { SESSION_API_RATE_LIMIT_REQUESTS_PER_MINUTE: "2" },
    });
    await rig.registerChallenge();

    expect((await createSession(rig)).status).toBe(201);
    expect((await createSession(rig)).status).toBe(201);
    const firstReject = await createSession(rig);
    const secondReject = await createSession(rig);

    // 确定性拒绝:同状态、同请求字节相同(I-4;不同的 token / embedSessionId
    // 不影响呈现面)。
    expect(firstReject.status).toBe(429);
    expect(secondReject.status).toBe(429);
    expect(firstReject.bodyText).toBe(secondReject.bodyText);
    // 冻结 PublicError 形态:16 冻结码 + 静态文案,零额外字段、零内部细节
    // (限流器计数 / 窗口状态零透出)。
    const body = PublicErrorSchema.parse(firstReject.body) as PublicError;
    expect(body.code).toBe("budget_exhausted");
    expect(body.message).toBe("rate limit exceeded");
    expect(firstReject.bodyText).toBe(RATE_LIMIT_BODY);
  });

  it("计量的租户 / 用户隔离:不同用户或租户互不挤占", async () => {
    const rig = await buildSessionTestRig({
      env: { SESSION_API_RATE_LIMIT_REQUESTS_PER_MINUTE: "1" },
    });
    await rig.registerChallenge();
    // beta 租户独立登记题目(内存注册表按 challengeId@version 键域)。
    const betaChallenge = "chal-beta-tenant";
    await rig.registerChallenge({ challengeId: betaChallenge, tenantId: TEST_TENANT_BETA_ID });

    expect((await createSession(rig, { tenantId: TEST_TENANT_ID, userId: "user-a" })).status).toBe(201);
    // 同 (tenant,user) 触顶。
    expect((await createSession(rig, { tenantId: TEST_TENANT_ID, userId: "user-a" })).status).toBe(429);
    // 不同用户、不同租户各自有独立窗口。
    expect((await createSession(rig, { tenantId: TEST_TENANT_ID, userId: "user-b" })).status).toBe(201);
    expect(
      (await createSession(rig, { tenantId: TEST_TENANT_BETA_ID, userId: "user-a", challengeId: betaChallenge }))
        .status,
    ).toBe(201);
  });

  it("凭证保护命令与 create-session 共用同一计数键(同窗口合并计量)", async () => {
    const rig = await buildSessionTestRig({
      env: { SESSION_API_RATE_LIMIT_REQUESTS_PER_MINUTE: "2" },
    });
    await rig.registerChallenge();
    const created = await createSession(rig); // 计数 1(create-session 走守卫,同键)
    expect(created.status).toBe(201);
    const sessionId = created.sessionId as string;
    const cookie = created.cookie as string;

    const first = await rig.app.inject({
      method: "POST",
      url: "/sessions/projection-sync",
      cookies: { sm_session_credential: cookie },
      headers: credentialHeaders(),
      payload: sessionCommand("sync_projection", { sessionId }),
    });
    expect(first.statusCode).toBe(200); // 计数 2(窗口满)
    // 同窗口内下一个命令请求触顶:429 冻结形态(非 5xx、非静默)。
    const second = await rig.app.inject({
      method: "POST",
      url: "/sessions/projection-sync",
      cookies: { sm_session_credential: cookie },
      headers: credentialHeaders(),
      payload: sessionCommand("sync_projection", { sessionId }),
    });
    expect(second.statusCode).toBe(429);
    expect(second.body).toBe(RATE_LIMIT_BODY);
  });

  it("并发预算触顶与频率触顶是两类确定性形态(同码不同静态文案)", async () => {
    const rig = await buildSessionTestRig({
      env: {
        SESSION_API_RATE_LIMIT_REQUESTS_PER_MINUTE: "100",
        SESSION_API_MAX_CONCURRENT_SESSIONS_PER_TENANT: "1",
      },
    });
    await rig.registerChallenge();
    expect((await createSession(rig)).status).toBe(201);
    const reject = await createSession(rig);
    expect(reject.status).toBe(429);
    expect(reject.bodyText).toBe(CONCURRENCY_BODY);
  });
});

describe("提交频率闸(submit 专属维度,D-API-50)", () => {
  it("窗口内第 3 次 submit 确定性 429;两次触顶响应逐字节一致", async () => {
    const rig = await buildSessionTestRig({
      env: { SESSION_API_SUBMISSIONS_PER_MINUTE: "2" },
    });
    await rig.registerChallenge();
    const created = await createSession(rig);
    const sessionId = created.sessionId as string;
    const cookie = created.cookie as string;

    expect((await submitCommand(rig, sessionId, cookie)).status).toBe(200);
    expect((await submitCommand(rig, sessionId, cookie)).status).toBe(200);
    const firstReject = await submitCommand(rig, sessionId, cookie);
    const secondReject = await submitCommand(rig, sessionId, cookie);

    expect(firstReject.status).toBe(429);
    expect(firstReject.bodyText).toBe(secondReject.bodyText);
    expect(JSON.parse(firstReject.bodyText)).toEqual({
      code: "budget_exhausted",
      message: "rate limit exceeded",
    });
  });

  it("触顶的 submit 不产生裁决引用行(拒绝先于编排入口)", async () => {
    const rig = await buildSessionTestRig({
      env: { SESSION_API_SUBMISSIONS_PER_MINUTE: "1" },
    });
    await rig.registerChallenge();
    const created = await createSession(rig);
    const sessionId = created.sessionId as string;
    const cookie = created.cookie as string;

    expect((await submitCommand(rig, sessionId, cookie)).status).toBe(200);
    expect(await rig.submissions.findBySession(sessionId, TEST_TENANT_ID)).toHaveLength(1);
    expect((await submitCommand(rig, sessionId, cookie)).status).toBe(429);
    expect(await rig.submissions.findBySession(sessionId, TEST_TENANT_ID)).toHaveLength(1);
  });
});

describe("每租户并发会话预算(D-API-52)", () => {
  it("预算内创建放行、触顶确定性 429;租户间隔离;close 释放预算", async () => {
    const rig = await buildSessionTestRig({
      env: { SESSION_API_MAX_CONCURRENT_SESSIONS_PER_TENANT: "1" },
    });
    await rig.registerChallenge();
    const betaChallenge = "chal-beta-tenant";
    await rig.registerChallenge({ challengeId: betaChallenge, tenantId: TEST_TENANT_BETA_ID });

    const first = await createSession(rig);
    expect(first.status).toBe(201);
    const sessionId = first.sessionId as string;
    const cookie = first.cookie as string;

    // 同租户第二会话:guard 早期快检拒绝,冻结形态、两次一致。
    const rejectA = await createSession(rig);
    const rejectB = await createSession(rig);
    expect(rejectA.status).toBe(429);
    expect(rejectA.bodyText).toBe(rejectB.bodyText);
    expect(rejectA.bodyText).toBe(CONCURRENCY_BODY);

    // 租户隔离:beta 租户不受 alpha 预算挤占。
    expect(
      (await createSession(rig, { tenantId: TEST_TENANT_BETA_ID, challengeId: betaChallenge })).status,
    ).toBe(201);

    // close 释放在途名额:预算恢复。
    const close = await rig.app.inject({
      method: "POST",
      url: "/sessions/close",
      cookies: { sm_session_credential: cookie },
      headers: credentialHeaders(),
      payload: sessionCommand("close_session", { sessionId }),
    });
    expect(close.statusCode).toBe(200);
    expect((await createSession(rig)).status).toBe(201);
  });

  it("并发创建窗口不超卖:预算 1 时并发 5 个 createSession 恰好 1 个成功", async () => {
    const rig = await buildSessionTestRig({
      env: { SESSION_API_MAX_CONCURRENT_SESSIONS_PER_TENANT: "1" },
    });
    await rig.registerChallenge();

    // 同步入场预留(D-API-52):检查与预留都在首个 await 之前完成,并发
    // 创建窗口内至多预算数个创建进入装载管线。
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        rig.manager.createSession({
          tenantId: TEST_TENANT_ID,
          userId: TEST_USER_ID,
          challengeId: TEST_CHALLENGE_ID,
          challengeVersion: TEST_CHALLENGE_VERSION,
          embedTokenJti: `jti-${Math.random().toString(36).slice(2)}`,
        }),
      ),
    );
    const fulfilled = attempts.filter((item) => item.status === "fulfilled");
    const budgetRejected = attempts.filter(
      (item) =>
        item.status === "rejected" &&
        (item.reason as Error).name === "ConcurrentSessionBudgetExhausted",
    );
    expect(fulfilled).toHaveLength(1);
    expect(budgetRejected).toHaveLength(4);
    expect(rig.manager.liveCountByTenant(TEST_TENANT_ID)).toBe(1);
    expect(rig.manager.liveCount).toBe(1);
  });

  it("创建失败的入场预留如数释放(失败路径不泄漏预算名额)", async () => {
    const rig = await buildSessionTestRig({
      env: { SESSION_API_MAX_CONCURRENT_SESSIONS_PER_TENANT: "2" },
    });
    await rig.registerChallenge();

    // 未登记题目 → 装载拒绝(ChallengeLoadRejected):预留必须在 finally 释放。
    await expect(
      rig.manager.createSession({
        tenantId: TEST_TENANT_ID,
        userId: TEST_USER_ID,
        challengeId: "chal-not-registered",
        challengeVersion: "9.9.9",
        embedTokenJti: "jti-fail-1",
      }),
    ).rejects.toThrow(/challenge load rejected/);
    // 失败后预算满额可用:两次创建都在预算内。
    expect((await createSession(rig)).status).toBe(201);
    expect((await createSession(rig)).status).toBe(201);
    expect(rig.manager.liveCount).toBe(2);
  });
});

/**
 * 裁决呈现路由红灯矩阵(阶段六 WP-63;D-API-83 / D-API-84 / D-API-86):
 * `GET /verdicts/:submissionId` 的实现期红灯语料(WP-60 契约级红灯的路由面承接)。
 *
 * 矩阵逐条:
 *  - 认证:未呈递 / 畸形 / 过期凭证 → 统一 401 冻结形态(D-API-14,零原因差异);
 *  - 路径参数:submissionId 字符集违规 → 404 同形(与不存在同响应,防枚举);
 *  - 定位链(404 同形矩阵):不存在 / 跨租户 / 跨会话 → 全部 404 + 冻结
 *    `invalid_input_format` / "resource not found"(跨租户探测零额外信号);
 *  - pending:submit 已受理、裁决未落库 → 200 恒定三字段形态,重复重询
 *    字节确定(I-4;零进度 / 队列位置 / 预计等待);
 *  - verdicted:裁决落库 → 200 五字段契约形态(11 值字面 + decidedAt epoch 秒);
 *    非成绩方向与成绩方向同构呈现(同键集,零成绩语义附加字段);
 *  - 限流:SESSION_API_VERDICT_QUERIES_PER_MINUTE 触顶 → 429 逐字节沿
 *    D-API-50 频率类冻结形态(`budget_exhausted` / "rate limit exceeded");
 *  - 服务器数据完整性:落库字面在 11 值外 → 响应面自检失败 500 兜底
 *    (绝不下发非契约形态);
 *  - Cookie Path(D-API-83 调宽登记):凭证 Cookie Path=/ 覆盖 /verdicts 族;
 *    GET 非变更方法不走 CSRF 闸(无 Origin 的 Cookie 呈递放行,D-API-17);
 *  - 裁决边界攻击面(WP-67,9.2 第四边界延伸):伪造 public_status 客户端
 *    污染不可达(未决期呈现恒三字段 pending,与诚实提交同形);客户端
 *    全表面重询风暴不可推进 verifier_runs 状态机(认领 = verifier 独占)。
 */

import { describe, expect, it } from "vitest";
import { VerdictQueryResponseSchema } from "@stackmaster/protocol";

import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  TEST_TENANT_ID,
  buildSessionTestRig,
  sessionCommand,
  sessionCredentialFromSetCookie,
  type SessionTestRig,
} from "./helpers/session-rig.js";

/** 404 / 401 / 429 的冻结呈现面字节(逐字节断言锚;D-API-32 / 14 / 50)。 */
const NOT_FOUND_BODY = JSON.stringify({ code: "invalid_input_format", message: "resource not found" });
const AUTH_FAILED_BODY = JSON.stringify({ code: "invalid_input_format", message: "authentication failed" });
const RATE_LIMIT_BODY = JSON.stringify({ code: "budget_exhausted", message: "rate limit exceeded" });

const LOG_DIGEST = "a".repeat(64);

interface SessionHandle {
  readonly sessionId: string;
  readonly cookie: string;
}

/** 已登记题目的 rig 集合(registerChallenge 幂等;版本不可变约束防重复登记)。 */
const REGISTERED = new WeakSet<object>();

async function createSession(rig: SessionTestRig, embedSessionId?: string): Promise<SessionHandle> {
  if (!REGISTERED.has(rig)) {
    await rig.registerChallenge();
    REGISTERED.add(rig);
  }
  const issued = await rig.issueEmbedToken({
    ...(embedSessionId === undefined ? {} : { claims: { embedSessionId } }),
  });
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
    sessionId: (response.json() as { payload: { sessionId: string } }).payload.sessionId,
    cookie: sessionCredentialFromSetCookie(response),
  };
}

async function getVerdict(
  rig: SessionTestRig,
  cookie: string,
  submissionId: string,
): Promise<{ status: number; bodyText: string }> {
  const response = await rig.app.inject({
    method: "GET",
    url: `/verdicts/${encodeURIComponent(submissionId)}`,
    cookies: { sm_session_credential: cookie },
  });
  return { status: response.statusCode, bodyText: response.body };
}

async function seedSubmission(
  rig: SessionTestRig,
  sessionId: string,
  revision = 3,
  tenantId: string = TEST_TENANT_ID,
  publicStatus = "running",
): Promise<string> {
  const record = await rig.submissions.record({
    tenantId,
    sessionId,
    revision,
    publicStatus,
    reference: { form: "stackmaster-session-submit/1", sessionId, revision },
    logDigest: LOG_DIGEST,
  });
  return record.id;
}

describe("GET /verdicts/:submissionId 认证面(D-API-83 会话凭证同模型)", () => {
  it("未呈递凭证 → 统一 401 冻结形态(零路由差异)", async () => {
    const rig = await buildSessionTestRig();
    const response = await rig.app.inject({ method: "GET", url: "/verdicts/01J9KD5EXAMPLE" });
    expect(response.statusCode).toBe(401);
    expect(response.body).toBe(AUTH_FAILED_BODY);
  });

  it("过期凭证 → 统一 401 冻结形态(与未呈递同形,防枚举)", async () => {
    let nowMs = 1_700_000_000_000;
    const rig = await buildSessionTestRig({ now: () => nowMs });
    const { cookie } = await createSession(rig);
    // 推进时钟 2 小时使会话凭证过期(签发 TTL 缺省 3600 s)。
    nowMs += 2 * 3_600_000;
    const submissionId = "0f0e0d0c-0b0a-4988-8776-665544332211";
    const response = await rig.app.inject({
      method: "GET",
      url: `/verdicts/${submissionId}`,
      cookies: { sm_session_credential: cookie },
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).toBe(AUTH_FAILED_BODY);
  });

  it("GET 非变更方法不走 CSRF 闸:Cookie 呈递缺 Origin 头放行(D-API-17)", async () => {
    const rig = await buildSessionTestRig();
    const { sessionId, cookie } = await createSession(rig);
    const submissionId = await seedSubmission(rig, sessionId);
    const result = await getVerdict(rig, cookie, submissionId);
    expect(result.status).toBe(200);
  });
});

describe("GET /verdicts/:submissionId 定位链 404 同形矩阵(D-API-83 防枚举)", () => {
  it("路径参数字符集违规(路径穿越 / 非法字符)→ 404 同形", async () => {
    const rig = await buildSessionTestRig();
    const { cookie } = await createSession(rig);
    for (const bad of ["..%2Fetc", "not%20a%20uuid!", "%00"]) {
      const response = await rig.app.inject({
        method: "GET",
        url: `/verdicts/${bad}`,
        cookies: { sm_session_credential: cookie },
      });
      expect(response.statusCode, bad).toBe(404);
      expect(response.body, bad).toBe(NOT_FOUND_BODY);
    }
  });

  it("不存在的 submissionId → 404 同形(冻结形态逐字节)", async () => {
    const rig = await buildSessionTestRig();
    const { cookie } = await createSession(rig);
    const result = await getVerdict(rig, cookie, "0f0e0d0c-0b0a-4988-8776-665544332211");
    expect(result.status).toBe(404);
    expect(result.bodyText).toBe(NOT_FOUND_BODY);
  });

  it("跨租户提交行(他租户 submissionId)→ 404 同形,与不存在零差异", async () => {
    const rig = await buildSessionTestRig();
    const { sessionId, cookie } = await createSession(rig);
    const foreign = await rig.submissions.record({
      tenantId: "tenant-foreign",
      sessionId: "sess-foreign",
      revision: 1,
      publicStatus: "running",
      reference: {},
      logDigest: LOG_DIGEST,
    });
    void sessionId;
    const result = await getVerdict(rig, cookie, foreign.id);
    expect(result.status).toBe(404);
    expect(result.bodyText).toBe(NOT_FOUND_BODY);
  });

  it("跨会话提交行(同租户他会话 submissionId)→ 404 同形", async () => {
    const rig = await buildSessionTestRig();
    const mine = await createSession(rig);
    const theirs = await createSession(rig, "another-embed-session-0123456789");
    const theirsSubmission = await seedSubmission(rig, theirs.sessionId);
    const result = await getVerdict(rig, mine.cookie, theirsSubmission);
    expect(result.status).toBe(404);
    expect(result.bodyText).toBe(NOT_FOUND_BODY);
  });
});

describe("pending 未决期呈现(D-API-84 确定性形态)", () => {
  it("submit 已受理、裁决未落库 → 200 恒定三字段形态(过契约 Schema)", async () => {
    const rig = await buildSessionTestRig();
    const { sessionId, cookie } = await createSession(rig);
    const submissionId = await seedSubmission(rig, sessionId, 7);

    const result = await getVerdict(rig, cookie, submissionId);
    expect(result.status).toBe(200);
    const payload = VerdictQueryResponseSchema.parse(JSON.parse(result.bodyText));
    expect(payload).toEqual({ submissionId, revision: 7, status: "pending" });
  });

  it("未决期内重复重询字节确定(I-4:载荷随 submissionId 确定而字节确定)", async () => {
    const rig = await buildSessionTestRig();
    const { sessionId, cookie } = await createSession(rig);
    const submissionId = await seedSubmission(rig, sessionId);

    const first = await getVerdict(rig, cookie, submissionId);
    const second = await getVerdict(rig, cookie, submissionId);
    expect(first.bodyText).toBe(second.bodyText);
  });
});

describe("verdicted 已裁决呈现(D-API-83 五字段上限面 / D-API-84)", () => {
  it("成绩方向 wrong_answer → 五字段契约形态,decidedAt 为 epoch 秒", async () => {
    const rig = await buildSessionTestRig();
    const { sessionId, cookie } = await createSession(rig);
    const submissionId = await seedSubmission(rig, sessionId);
    await rig.submissions.recordVerdict(submissionId, "wrong_answer", 1_789_200_000);

    const result = await getVerdict(rig, cookie, submissionId);
    expect(result.status).toBe(200);
    const payload = VerdictQueryResponseSchema.parse(JSON.parse(result.bodyText));
    expect(payload).toEqual({
      submissionId,
      revision: 3,
      status: "verdicted",
      verdict: "wrong_answer",
      decidedAt: 1_789_200_000,
    });
  });

  it.each(["engine_error", "challenge_invalid", "replay_mismatch", "cancelled"] as const)(
    "非成绩方向 %s 与成绩方向同构呈现(同键集,零成绩语义附加字段)",
    async (verdict) => {
      const rig = await buildSessionTestRig();
      const { sessionId, cookie } = await createSession(rig);
      const submissionId = await seedSubmission(rig, sessionId);
      await rig.submissions.recordVerdict(submissionId, verdict, 1_789_200_000);

      const result = await getVerdict(rig, cookie, submissionId);
      expect(result.status).toBe(200);
      const payload = VerdictQueryResponseSchema.parse(JSON.parse(result.bodyText));
      expect(Object.keys(payload).sort()).toEqual(["decidedAt", "revision", "status", "submissionId", "verdict"]);
      expect(payload.verdict).toBe(verdict);
    },
  );

  it("落库字面在 11 值外 → 500 兜底(响应面自检,绝不下发非契约形态)", async () => {
    const rig = await buildSessionTestRig();
    const { sessionId, cookie } = await createSession(rig);
    const submissionId = await seedSubmission(rig, sessionId);
    await rig.submissions.recordVerdict(submissionId, "bogus_verdict_literal", 1_789_200_000);

    const result = await getVerdict(rig, cookie, submissionId);
    expect(result.status).toBe(500);
    const body = JSON.parse(result.bodyText) as { code: string; message: string };
    expect(body.code).toBe("internal_error");
  });
});

describe("重询限流(D-API-84 / D-API-86:SESSION_API_VERDICT_QUERIES_PER_MINUTE)", () => {
  it("窗口内触顶 → 429 逐字节沿 D-API-50 频率类冻结形态;计数不回退", async () => {
    const rig = await buildSessionTestRig({
      env: { SESSION_API_VERDICT_QUERIES_PER_MINUTE: "2" },
    });
    const { sessionId, cookie } = await createSession(rig);
    const submissionId = await seedSubmission(rig, sessionId);

    expect((await getVerdict(rig, cookie, submissionId)).status).toBe(200);
    expect((await getVerdict(rig, cookie, submissionId)).status).toBe(200);
    const firstReject = await getVerdict(rig, cookie, submissionId);
    const secondReject = await getVerdict(rig, cookie, submissionId);
    expect(firstReject.status).toBe(429);
    expect(secondReject.status).toBe(429);
    expect(firstReject.bodyText).toBe(RATE_LIMIT_BODY);
    expect(secondReject.bodyText).toBe(RATE_LIMIT_BODY);
  });

  it("限流计量按 (tenant, user) 维度隔离:rate:{tenant}:{user}:verdict 子键", async () => {
    const rig = await buildSessionTestRig({
      env: { SESSION_API_VERDICT_QUERIES_PER_MINUTE: "1" },
    });
    const alpha = await createSession(rig);
    // beta 租户独立登记题目(内存注册表按 challengeId@version 键域)。
    const betaChallenge = "chal-verdict-beta";
    await rig.registerChallenge({ challengeId: betaChallenge, tenantId: "tenant-verdict-beta" });
    const betaToken = await rig.issueEmbedToken({
      claims: { tenantId: "tenant-verdict-beta", challengeId: betaChallenge },
    });
    const betaResponse = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: sessionCommand("create_session", {
        challengeId: betaChallenge,
        challengeVersion: TEST_CHALLENGE_VERSION,
        embedSessionId: betaToken.claims.embedSessionId,
        embedToken: betaToken.token,
      }),
    });
    expect(betaResponse.statusCode).toBe(201);
    const beta = {
      sessionId: (betaResponse.json() as { payload: { sessionId: string } }).payload.sessionId,
      cookie: sessionCredentialFromSetCookie(betaResponse),
    };
    const alphaSubmission = await seedSubmission(rig, alpha.sessionId);
    const betaSubmission = await seedSubmission(rig, beta.sessionId, 3, "tenant-verdict-beta");

    expect((await getVerdict(rig, alpha.cookie, alphaSubmission)).status).toBe(200);
    expect((await getVerdict(rig, beta.cookie, betaSubmission)).status).toBe(200);
    expect((await getVerdict(rig, alpha.cookie, alphaSubmission)).status).toBe(429);
  });
});

describe("Cookie Path 调宽(D-API-83:Path=/ 覆盖 /sessions 与 /verdicts 两族)", () => {
  it("create_session 的 Set-Cookie 为 Path=/(HttpOnly / SameSite=Strict 属性零改动)", async () => {
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
    const setCookie = (response.headers as Record<string, unknown>)["set-cookie"];
    const raw = Array.isArray(setCookie) ? String(setCookie[0]) : String(setCookie);
    expect(raw).toContain("Path=/");
    expect(raw).not.toContain("Path=/sessions");
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Strict");
  });
});

// ── 阶段六 WP-67:裁决边界攻击面(9.2 第四边界延伸;裁决伪造方向)──────────
// 两个不可达性质:①客户端污染不可达——提交行上任何客户端可伪造字段
// (public_status 成功标志)不改变未决期呈现的零成绩语义;②状态机推进
// 不可达——客户端全部可达表面(GET /verdicts 族)不触发 verifier_runs
// 状态迁移(认领与推进是 verifier 信任域 4 独占面,D-API-85)。
describe("裁决边界攻击面(WP-67:客户端污染与 verifier_runs 推进不可达)", () => {
  it("伪造 public_status='won' 的提交行:未决期呈现恒 pending 三字段,与诚实提交同形(零成绩语义客户端污染不可达)", async () => {
    const rig = await buildSessionTestRig();
    const { sessionId, cookie } = await createSession(rig);
    const honest = await seedSubmission(rig, sessionId, 5);
    const forged = await seedSubmission(rig, sessionId, 5, TEST_TENANT_ID, "won");

    const honestResult = await getVerdict(rig, cookie, honest);
    const forgedResult = await getVerdict(rig, cookie, forged);
    expect(honestResult.status).toBe(200);
    expect(forgedResult.status).toBe(200);
    // 同 revision 下,伪造行与诚实行未决期载荷仅 submissionId 不同(逐字节对齐)。
    expect(forgedResult.bodyText).toBe(honestResult.bodyText.replaceAll(honest, forged));
    // 恒定三字段:零 verdict 键、零成绩方向字段(pending ≠ 通过 / 失败)。
    const payload = VerdictQueryResponseSchema.parse(JSON.parse(forgedResult.bodyText));
    expect(payload).toEqual({ submissionId: forged, revision: 5, status: "pending" });
    expect(forgedResult.bodyText).not.toContain("won");
    expect(forgedResult.bodyText).not.toContain("verdict");
  });

  it("重询风暴(200 / 404 / 429 / 401 全表面)后:verifier_runs 恒 pending、裁决零落库(客户端面不可推进状态机)", async () => {
    const rig = await buildSessionTestRig({
      env: { SESSION_API_VERDICT_QUERIES_PER_MINUTE: "12" },
    });
    const { sessionId, cookie } = await createSession(rig);
    const submissionId = await seedSubmission(rig, sessionId);

    // 风暴(计量序):归属重询 200 × 8 → 不存在 / 字符集违规 404 × 2 →
    // 无凭证 401(认证先于计量,不占预算)→ 触顶 429 × 2(计数不回退)。
    for (let index = 0; index < 8; index += 1) {
      const attempt = await getVerdict(rig, cookie, submissionId);
      expect(attempt.status, `第 ${index + 1} 次归属重询`).toBe(200);
      expect(JSON.parse(attempt.bodyText)).toMatchObject({ status: "pending" });
    }
    expect((await getVerdict(rig, cookie, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    const malformed = await rig.app.inject({
      method: "GET",
      url: "/verdicts/..%2Fetc",
      cookies: { sm_session_credential: cookie },
    });
    expect(malformed.statusCode).toBe(404);
    const anonymous = await rig.app.inject({ method: "GET", url: `/verdicts/${submissionId}` });
    expect(anonymous.statusCode).toBe(401);
    // 触顶(有界循环:404 探测是否计量属实现细节,两种形态都收敛到 429)。
    let capped: { status: number; bodyText: string } | null = null;
    for (let index = 0; index < 12 && capped === null; index += 1) {
      const attempt = await getVerdict(rig, cookie, submissionId);
      if (attempt.status === 429) {
        capped = attempt;
      } else {
        expect(attempt.status).toBe(200);
        expect(JSON.parse(attempt.bodyText)).toMatchObject({ status: "pending" });
      }
    }
    expect(capped, "风暴内必触顶(限流生效)").not.toBeNull();
    expect(capped!.bodyText).toBe(RATE_LIMIT_BODY);
    // 计数不回退:窗口内继续触顶(确定性同形,I-4)。
    expect((await getVerdict(rig, cookie, submissionId)).bodyText).toBe(capped!.bodyText);

    // 状态机零推进:全部 run 行仍 pending(认领 = verifier SKIP LOCKED 独占)。
    const runs = rig.submissions.verifierRuns.filter((run) => run.submissionId === submissionId);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.map((run) => run.status)).toEqual(runs.map(() => "pending"));
    // 裁决零落库(直接查 VerdictQueryStore 端口,不受重询限流计量影响)。
    expect(await rig.submissions.findVerdictBySubmissionId(submissionId, TEST_TENANT_ID)).toBeNull();
  });

  it("未决期载荷与最终裁决方向零相关(侧信道最小断言):异裁决双提交的 pending 字节同形", async () => {
    // 侧信道论证的裁决呈现面最小断言(WP-67;9.2 侧信道约束在裁决链上的
    // 延伸):异步队列解耦使 pending 期客户端可观察面 = 恒定三字段,与该
    // 提交最终的裁决字面(success / wrong_answer / 非成绩方向)零相关——
    // 若 pending 载荷携带任何与最终裁决相关的信号(长度 / 字段 / 字节),
    // 本用例的逐字节对齐断言即红灯。
    const rig = await buildSessionTestRig();
    const { sessionId, cookie } = await createSession(rig);
    const eventualSuccess = await seedSubmission(rig, sessionId, 5);
    const eventualWrong = await seedSubmission(rig, sessionId, 5);
    const eventualNonScore = await seedSubmission(rig, sessionId, 5);

    // 未决期窗口:三提交 pending 载荷仅 submissionId 不同,其余逐字节一致。
    const pendingBodies = [eventualSuccess, eventualWrong, eventualNonScore].map(
      (id) => getVerdict(rig, cookie, id).then((result) => {
        expect(result.status).toBe(200);
        return result.bodyText.replaceAll(id, "<submissionId>");
      }),
    );
    const [pendingSuccess, pendingWrong, pendingNonScore] = await Promise.all(pendingBodies);
    expect(pendingWrong).toBe(pendingSuccess);
    expect(pendingNonScore).toBe(pendingSuccess);

    // 三提交最终落向三个不同方向(成绩两极 + 非成绩),反证"同 pending 字节
    // ≠ 同裁决":pending 期可观察面不承载裁决方向的任何函数。
    await rig.submissions.recordVerdict(eventualSuccess, "success", 1_789_200_000);
    await rig.submissions.recordVerdict(eventualWrong, "wrong_answer", 1_789_200_001);
    await rig.submissions.recordVerdict(eventualNonScore, "engine_error", 1_789_200_002);
    const finalVerdicts = [eventualSuccess, eventualWrong, eventualNonScore].map(
      (id) => getVerdict(rig, cookie, id).then((result) => {
        expect(result.status).toBe(200);
        return (JSON.parse(result.bodyText) as { verdict: string }).verdict;
      }),
    );
    expect(await Promise.all(finalVerdicts)).toEqual(["success", "wrong_answer", "engine_error"]);
  });
});

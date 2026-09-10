/**
 * 生命周期全链路 REST 面测试(任务分解 WP-4 完成标准;D-API-1 路由表):
 * 签发 embed token → create_session → sync_projection → checkpoint(WSS
 * 动作入口的 manager.applyAction;12 动作不设 REST 镜像,D-API-1)→
 * list_checkpoints → submit → close_session。
 * 断言:一切响应面通过冻结 `SessionCommandResponseSchema`(含 superRefine
 * 跨字段耦合);响应零凭证字段、零协议版本字段、零快照信封字段。
 */
import { describe, expect, it } from "vitest";
import {
  SessionCommandResponseSchema,
  SESSION_ACTION_PROTOCOL_VERSION,
} from "@stackmaster/protocol";

import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  TEST_TENANT_ID,
  buildSessionTestRig,
  sessionCommand,
  sessionCredentialFromSetCookie,
  credentialHeaders,
  type SessionTestRig,
} from "./helpers/session-rig.js";

function parseEnvelope(body: unknown): unknown {
  // 过冻结 Schema(superRefine 耦合含内)即证明形态、字段集与取值域全在契约内。
  return SessionCommandResponseSchema.parse(body);
}

async function createSessionViaHttp(
  rig: SessionTestRig,
  overrides: {
    readonly tenantId?: string;
    readonly embedSessionId?: string;
  } = {},
): Promise<{ sessionId: string; cookie: string; status: number }> {
  const issued = await rig.issueEmbedToken({
    ...(overrides.tenantId === undefined ? {} : { claims: { tenantId: overrides.tenantId } }),
  });
  const response = await rig.app.inject({
    method: "POST",
    url: "/sessions",
    payload: sessionCommand("create_session", {
      challengeId: TEST_CHALLENGE_ID,
      challengeVersion: TEST_CHALLENGE_VERSION,
      embedSessionId: overrides.embedSessionId ?? issued.claims.embedSessionId,
      embedToken: issued.token,
    }),
  });
  expect(response.statusCode).toBe(201);
  const body = parseEnvelope(response.json()) as {
    command: "create_session";
    payload: { sessionId: string; revision: number; projection: { revision: number } };
  };
  expect(body.command).toBe("create_session");
  return {
    sessionId: body.payload.sessionId,
    cookie: sessionCredentialFromSetCookie(response),
    status: response.statusCode,
  };
}

describe("生命周期全链路(REST 命令 + WSS 动作入口)", () => {
  it("create_session:三方比对 → 会话签发 → Cookie 交付 → 冻结 create_session 响应", async () => {
    const rig = await buildSessionTestRig();
    await rig.registerChallenge();
    const issued = await rig.issueEmbedToken();
    const embedSessionId = issued.claims.embedSessionId;

    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: sessionCommand("create_session", {
        challengeId: TEST_CHALLENGE_ID,
        challengeVersion: TEST_CHALLENGE_VERSION,
        embedSessionId,
        embedToken: issued.token,
      }),
    });

    expect(response.statusCode).toBe(201);
    const body = parseEnvelope(response.json()) as {
      command: "create_session";
      payload: { sessionId: string; revision: number; projection: { revision: number; status: string } };
    };
    expect(body.command).toBe("create_session");
    expect(body.payload.sessionId).toMatch(/^sess-[0-9a-f]{32}$/);
    expect(body.payload.revision).toBe(0);
    expect(body.payload.projection.revision).toBe(0);
    expect(body.payload.projection.status).toBe("running");
    // 响应体零凭证字段(契约冻结面);凭证只在 Set-Cookie(D-API-12)。
    expect(JSON.stringify(body)).not.toContain("embedToken");
    expect(JSON.stringify(body)).not.toContain("sm_session_credential");
    const cookie = sessionCredentialFromSetCookie(response);
    expect(cookie.split(".")).toHaveLength(3); // JWT 形态(非秘密断言:仅段数)
    // create_session 审计(WP-2 审计最小写入面)。
    const kinds = rig.audit.snapshot().map((event) => event.kind);
    expect(kinds).toContain("create_session");
    expect(kinds).toContain("session_credential_issued");
    // 会话行落库(active;seed 策略元数据)。
    const row = await rig.sessions.findSession(body.payload.sessionId, TEST_TENANT_ID);
    expect(row?.phase).toBe("active");
  });

  it("create_session → sync_projection:重发最近投影,revision 对齐", async () => {
    const rig = await buildSessionTestRig();
    await rig.registerChallenge();
    const { sessionId, cookie } = await createSessionViaHttp(rig);

    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions/projection-sync",
      cookies: { sm_session_credential: cookie },
      headers: credentialHeaders(),
      payload: sessionCommand("sync_projection", { sessionId }),
    });
    expect(response.statusCode).toBe(200);
    const body = parseEnvelope(response.json()) as {
      command: "sync_projection";
      payload: { revision: number; projection: { revision: number } };
    };
    expect(body.command).toBe("sync_projection");
    expect(body.payload.revision).toBe(0);
    expect(body.payload.projection.revision).toBe(0);
  });

  it("全链路:create → checkpoint(动作入口)→ list_checkpoints → submit → close", async () => {
    const rig = await buildSessionTestRig();
    await rig.registerChallenge();
    const { sessionId, cookie } = await createSessionViaHttp(rig);

    // checkpoint:12 动作经 manager.applyAction(WSS 归 WP-5,REST 无镜像端点)。
    const checkpoint = await rig.manager.applyAction(sessionId, TEST_TENANT_ID, {
      type: "create_checkpoint",
      args: { label: "before-run" },
    });
    expect(checkpoint.status).toBe("running");
    expect(checkpoint.revision).toBe(1);

    const listResponse = await rig.app.inject({
      method: "POST",
      url: "/sessions/checkpoints",
      cookies: { sm_session_credential: cookie },
      headers: credentialHeaders(),
      payload: sessionCommand("list_checkpoints", { sessionId }),
    });
    expect(listResponse.statusCode).toBe(200);
    const list = parseEnvelope(listResponse.json()) as {
      command: "list_checkpoints";
      payload: {
        checkpoints: { checkpointId: string; label?: string; revision: number }[];
      };
    };
    expect(list.command).toBe("list_checkpoints");
    expect(list.payload.checkpoints).toHaveLength(1);
    expect(list.payload.checkpoints[0]?.label).toBe("before-run");
    expect(list.payload.checkpoints[0]?.revision).toBe(1);
    // 快照信封 SERVER_ONLY:响应面零 snapshot 字段。
    expect(listResponse.body).not.toContain("snapshot");

    const submitResponse = await rig.app.inject({
      method: "POST",
      url: "/sessions/submissions",
      cookies: { sm_session_credential: cookie },
      headers: credentialHeaders(),
      payload: sessionCommand("submit", { sessionId }),
    });
    expect(submitResponse.statusCode).toBe(200);
    const submission = parseEnvelope(submitResponse.json()) as {
      command: "submit";
      payload: { submissionId: string; revision: number };
    };
    expect(submission.command).toBe("submit");
    expect(submission.payload.revision).toBe(1);
    // 裁决引用落库:动作日志锚(规范化动作日志)完整可取(SERVER_ONLY 保留在服务端)。
    const stored = await rig.submissions.findBySession(sessionId, TEST_TENANT_ID);
    expect(stored).toHaveLength(1);
    const reference = stored[0]?.reference as { actionLog: unknown[] };
    expect(reference.actionLog).toHaveLength(1);
    expect(rig.audit.snapshot().some((event) => event.kind === "submit")).toBe(true);

    const closeResponse = await rig.app.inject({
      method: "POST",
      url: "/sessions/close",
      cookies: { sm_session_credential: cookie },
      headers: credentialHeaders(),
      payload: sessionCommand("close_session", { sessionId }),
    });
    expect(closeResponse.statusCode).toBe(200);
    const closed = parseEnvelope(closeResponse.json()) as {
      command: "close_session";
      payload: { revision: number };
    };
    expect(closed.command).toBe("close_session");
    expect(closed.payload.revision).toBe(1);
    expect(rig.manager.liveCount).toBe(0);
    const row = await rig.sessions.findSession(sessionId, TEST_TENANT_ID);
    expect(row?.phase).toBe("closed");

    // 终态回收:后续命令 404(不存在与已回收同形,防枚举)。
    const afterClose = await rig.app.inject({
      method: "POST",
      url: "/sessions/submissions",
      cookies: { sm_session_credential: cookie },
      headers: credentialHeaders(),
      payload: sessionCommand("submit", { sessionId }),
    });
    expect(afterClose.statusCode).toBe(404);
    expect(afterClose.json()).toEqual({
      code: "invalid_input_format",
      message: "resource not found",
    });
  });

  it("close 前落终态恢复点:close_session 持久化 session_close 快照(密文静止)", async () => {
    const rig = await buildSessionTestRig();
    await rig.registerChallenge();
    const { sessionId, cookie } = await createSessionViaHttp(rig);
    await rig.manager.applyAction(sessionId, TEST_TENANT_ID, {
      type: "create_checkpoint",
      args: { label: "cp" },
    });

    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions/close",
      cookies: { sm_session_credential: cookie },
      headers: credentialHeaders(),
      payload: sessionCommand("close_session", { sessionId }),
    });
    expect(response.statusCode).toBe(200);
    const rows = await rig.snapshots.listBySession(sessionId, TEST_TENANT_ID);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // 密文静止:落库 blob 以 SMEN 魔数起始(D-W8-11 / D-API-22)。
    const blob = rows[rows.length - 1]?.ciphertext;
    expect([blob?.[0], blob?.[1], blob?.[2], blob?.[3]]).toEqual([0x53, 0x4d, 0x45, 0x4e]);
  });

  it("create_session 后 embed token 不可重放(jti 单次原子消费)", async () => {
    const rig = await buildSessionTestRig();
    await rig.registerChallenge();
    const issued = await rig.issueEmbedToken();
    const payload = sessionCommand("create_session", {
      challengeId: TEST_CHALLENGE_ID,
      challengeVersion: TEST_CHALLENGE_VERSION,
      embedSessionId: issued.claims.embedSessionId,
      embedToken: issued.token,
    });
    const first = await rig.app.inject({ method: "POST", url: "/sessions", payload });
    expect(first.statusCode).toBe(201);
    const second = await rig.app.inject({ method: "POST", url: "/sessions", payload });
    expect(second.statusCode).toBe(401);
    expect(second.json()).toEqual({
      code: "invalid_input_format",
      message: "authentication failed",
    });
  });

  it("协议版本受理:当前版本受理,集合外版本确定性拒绝(N-1 受理集合路由)", async () => {
    const rig = await buildSessionTestRig();
    await rig.registerChallenge();
    const issued = await rig.issueEmbedToken();
    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: {
        command: "create_session",
        protocolVersion: SESSION_ACTION_PROTOCOL_VERSION + 99,
        payload: {
          challengeId: TEST_CHALLENGE_ID,
          challengeVersion: TEST_CHALLENGE_VERSION,
          embedSessionId: issued.claims.embedSessionId,
          embedToken: issued.token,
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: "invalid_input_format",
      message: "unsupported protocol version",
    });
  });
});

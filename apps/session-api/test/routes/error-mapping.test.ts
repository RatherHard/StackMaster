/**
 * 错误映射矩阵的确定性呈现测试(任务分解 WP-4 第 4 条;D-API-32):
 *  - worker 看门狗退出码 3(watchdog_timeout)→ timeout 结果:504 +
 *    冻结 budget_exhausted 形态,零进程细节,双实例字节一致(I-4);
 *  - 一般 worker 崩溃 → engine_error:500 + 冻结 internal_error 形态;
 *  - 崩溃会话回收后:后续命令 404(终态资源不复活,重开 = 重新 create_session);
 *  - 强制终止审计(session_force_closed)入账。
 */
import { describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";

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

/** 创建会话(路由面;返回凭证 Cookie 供命令路由使用)。 */
async function createSessionViaHttp(
  rig: SessionTestRig,
): Promise<{ sessionId: string; cookie: string; created: LightMyRequestResponse }> {
  const issued = await rig.issueEmbedToken();
  const created = await rig.app.inject({
    method: "POST",
    url: "/sessions",
    payload: sessionCommand("create_session", {
      challengeId: TEST_CHALLENGE_ID,
      challengeVersion: TEST_CHALLENGE_VERSION,
      embedSessionId: issued.claims.embedSessionId,
      embedToken: issued.token,
    }),
  });
  expect(created.statusCode).toBe(201);
  const body = created.json() as { payload: { sessionId: string } };
  return {
    sessionId: body.payload.sessionId,
    cookie: sessionCredentialFromSetCookie(created),
    created,
  };
}

describe("worker 看门狗退出码 3 → timeout 的确定性呈现(close_session 命令路径)", () => {
  it("close_session:504 + budget_exhausted 冻结形态,零进程细节", async () => {
    const rig = await buildSessionTestRig({ workerMode: "watchdog_on_shutdown" });
    await rig.registerChallenge();
    const { sessionId, cookie } = await createSessionViaHttp(rig);

    const close = await rig.app.inject({
      method: "POST",
      url: "/sessions/close",
      cookies: { sm_session_credential: cookie },
      headers: credentialHeaders(),
      payload: sessionCommand("close_session", { sessionId }),
    });
    expect(close.statusCode).toBe(504);
    expect(close.json()).toEqual({ code: "budget_exhausted", message: "session timed out" });
    // 零进程细节:响应面不出现退出码 / 进程 / worker 字样。
    expect(close.body).not.toContain("exit");
    expect(close.body).not.toContain("worker");
    expect(close.body).not.toContain("3");
    // 会话已回收:在途表清空 + 强制终止审计。
    expect(rig.manager.liveCount).toBe(0);
    expect(rig.audit.snapshot().some((event) => event.kind === "session_force_closed")).toBe(true);
  });

  it("timeout 呈现确定性:两个独立实例同输入恒同响应(I-4)", async () => {
    const build = async (): Promise<string> => {
      const rig = await buildSessionTestRig({ workerMode: "watchdog_on_shutdown" });
      await rig.registerChallenge();
      const { sessionId, cookie } = await createSessionViaHttp(rig);
      const close = await rig.app.inject({
        method: "POST",
        url: "/sessions/close",
        cookies: { sm_session_credential: cookie },
        headers: credentialHeaders(),
        payload: sessionCommand("close_session", { sessionId }),
      });
      return close.body;
    };
    expect(await build()).toBe(await build());
  });

  it("一般崩溃(非看门狗退出码)→ engine_error 分类,且崩溃回收后命令 404 防枚举", async () => {
    const rig = await buildSessionTestRig({ workerMode: "crash_on_apply" });
    await rig.registerChallenge();
    const { sessionId, cookie } = await createSessionViaHttp(rig);

    // 动作入口触发崩溃(退出码 9):manager 分类为 engine_error。
    let failure: unknown;
    try {
      await rig.manager.applyAction(sessionId, TEST_TENANT_ID, {
        type: "write_bytes",
        args: { addressHex: "0x7FFFF000", bytesHex: "deadbeef" },
      });
      expect.unreachable("worker 崩溃必须使动作失败");
    } catch (error) {
      failure = error;
    }
    expect((failure as { name?: string }).name).toBe("MappedOrchestratorFailure");
    expect((failure as { kind?: string }).kind).toBe("engine_error");

    // 崩溃会话已 reap:后续 REST 命令 404(与不存在同形,防枚举)。
    const close = await rig.app.inject({
      method: "POST",
      url: "/sessions/close",
      cookies: { sm_session_credential: cookie },
      headers: credentialHeaders(),
      payload: sessionCommand("close_session", { sessionId }),
    });
    expect(close.statusCode).toBe(404);
    expect(close.json()).toEqual({ code: "invalid_input_format", message: "resource not found" });
    expect(rig.manager.liveCount).toBe(0);
    expect(rig.audit.snapshot().some((event) => event.kind === "session_force_closed")).toBe(true);
  });
});

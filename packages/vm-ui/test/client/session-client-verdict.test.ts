/**
 * SessionClient.queryVerdict 测试(阶段六 WP-63;D-API-83 呈现通道客户端消费面):
 *  - GET /verdicts/:submissionId + `credentials: "include"`(会话凭证 Cookie
 *    呈递,与 REST 5 命令同模型;submissionId 走 URI 编码);
 *  - 响应体过冻结 `VerdictQueryResponseSchema`(pending 三字段 / verdicted
 *    五字段;契约漂移 = SessionClientError,零非契约形态上抛);
 *  - 非 2xx → SessionCommandError(冻结 PublicError:404 同形 / 429 重询
 *    限流)并分发 onCommandError(与 REST 命令错误面同路)。
 */
import { describe, expect, it } from "vitest";

import { SessionClient } from "../../src/client/session-client.js";
import { SessionClientError, SessionCommandError } from "../../src/client/session-errors.js";
import { createMockFetch, settle, type MockFetch } from "../helpers/fixtures.js";

interface Harness {
  readonly client: SessionClient;
  readonly mockFetch: MockFetch;
}

function createHarness(handler: Parameters<typeof createMockFetch>[0]): Harness {
  const mockFetch = createMockFetch(handler);
  const client = new SessionClient({ fetch: mockFetch.fetch });
  return { client, mockFetch };
}

describe("SessionClient.queryVerdict(裁决呈现通道客户端消费,D-API-83)", () => {
  it("GET /verdicts/:submissionId,Cookie 呈递;pending 三字段过契约自检", async () => {
    const harness = createHarness((request) => {
      expect(request.init.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe("/verdicts/sub-01");
      return {
        status: 200,
        body: { submissionId: "sub-01", revision: 7, status: "pending" },
      };
    });
    const response = await harness.client.queryVerdict("sub-01");
    expect(response).toEqual({ submissionId: "sub-01", revision: 7, status: "pending" });
  });

  it("verdicted 五字段(11 值字面 + decidedAt)过契约自检;路径参数经 URI 编码防注入", async () => {
    const harness = createHarness((request) => {
      expect(new URL(request.url).pathname).toBe("/verdicts/sub%2F..%2F01");
      return {
        status: 200,
        body: {
          submissionId: "sub-01",
          revision: 3,
          status: "verdicted",
          verdict: "wrong_answer",
          decidedAt: 1_789_200_000,
        },
      };
    });
    const response = await harness.client.queryVerdict("sub/../01");
    expect(response.status).toBe("verdicted");
    expect(response).toMatchObject({ verdict: "wrong_answer", decidedAt: 1_789_200_000 });
  });

  it("404 同形(不存在 / 跨租户 / 跨会话)→ SessionCommandError + onCommandError 分发", async () => {
    const harness = createHarness(() => ({
      status: 404,
      body: { code: "invalid_input_format", message: "resource not found" },
    }));
    const errors: SessionCommandError[] = [];
    harness.client.onCommandError((error) => errors.push(error));
    const attempt = harness.client.queryVerdict("missing").catch((error: unknown) => error);
    const outcome = await attempt;
    await settle();
    expect(outcome).toBeInstanceOf(SessionCommandError);
    expect((outcome as SessionCommandError).httpStatus).toBe(404);
    expect((outcome as SessionCommandError).publicError.code).toBe("invalid_input_format");
    expect(errors.length).toBe(1);
  });

  it("429 重询限流(冻结形态)→ SessionCommandError(零解释面)", async () => {
    const harness = createHarness(() => ({
      status: 429,
      body: { code: "budget_exhausted", message: "rate limit exceeded" },
    }));
    const outcome = await harness.client.queryVerdict("sub-01").catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(SessionCommandError);
    expect((outcome as SessionCommandError).publicError).toEqual({
      code: "budget_exhausted",
      message: "rate limit exceeded",
    });
  });

  it("响应体契约漂移(进度类字段 / 状态机耦合破坏)→ SessionClientError(contract_drift)", async () => {
    const harness = createHarness(() => ({
      status: 200,
      // pending 携带 verdict:契约层结构性非法(WP-60 红灯语料的客户端镜像)。
      body: { submissionId: "sub-01", revision: 7, status: "pending", verdict: "success" },
    }));
    const outcome = await harness.client.queryVerdict("sub-01").catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(SessionClientError);
    expect((outcome as SessionClientError).code).toBe("contract_drift");
  });
});

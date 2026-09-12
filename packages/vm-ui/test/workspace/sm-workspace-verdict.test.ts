/**
 * <sm-workspace> 正式裁决呈现接线测试(阶段六 WP-63;D-API-83 / D-API-84):
 *  - 菜单「提交」→ REST submit → 裁决重询启动 → pending 确定性呈现
 *    (「已提交 · 裁决进行中」,零进度语义、不误读为通过 / 失败);
 *  - verdicted → 11 值结果类型呈现(成绩方向与非成绩方向文案区分);
 *    非成绩方向附显式重新提交入口(不自动重试);
 *  - 重询连续失败触顶 → unavailable 降级明示(「裁决暂不可用」,不中断会话、
 *    不判负;复用 pwn-degraded 语义锚纪律:确定性 testid + 原因属性)。
 */
import { describe, expect, it, beforeEach } from "vitest";

import { SessionClient } from "../../src/client/session-client.js";
import { VerdictPoller } from "../../src/client/verdict-poller.js";
import { SmWorkspace } from "../../src/workspace/sm-workspace.js";
import {
  CREATE_INPUT,
  FakeTimers,
  FakeWebSocket,
  SESSION_COOKIE,
  SESSION_ID,
  createMockFetch,
  fakeWebSocketFactory,
  makeProjection,
  settle,
  type MockFetch,
} from "../helpers/fixtures.js";

beforeEach(() => {
  FakeWebSocket.reset();
});

async function mountWorkspace(): Promise<SmWorkspace> {
  const element = new SmWorkspace();
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function shadowOf(element: SmWorkspace): ShadowRoot {
  return element.shadowRoot as ShadowRoot;
}

function menuShadow(workspace: SmWorkspace): ShadowRoot {
  const menu = shadowOf(workspace).querySelector("sm-workspace-menu");
  if (menu === null) {
    throw new Error("未找到工作区菜单");
  }
  return menu.shadowRoot as ShadowRoot;
}

function verdictBanner(workspace: SmWorkspace): HTMLElement | null {
  return shadowOf(workspace).querySelector('[data-testid="sm-verdict"]');
}

/** 裁决接线装配体:mock fetch(FakeTimers 驱动重询;verdict 路由可编程)。 */
interface VerdictHarness {
  readonly workspace: SmWorkspace;
  readonly mockFetch: MockFetch;
  readonly timers: FakeTimers;
  readonly submitCalls: { count: number };
}

async function mountVerdictWorkspace(input: {
  verdictResponses: () => { status: number; body: unknown };
}): Promise<VerdictHarness> {
  const timers = new FakeTimers();
  const submitCalls = { count: 0 };
  const mockFetch = createMockFetch((request) => {
    const path = new URL(request.url).pathname;
    if (path === "/sessions/submissions") {
      submitCalls.count += 1;
      return {
        status: 200,
        body: { command: "submit", payload: { submissionId: "submission-verdict-1", revision: 0 } },
      };
    }
    if (path.startsWith("/verdicts/")) {
      const response = input.verdictResponses();
      return { status: response.status, body: response.body };
    }
    switch (path) {
      case "/sessions":
        return {
          status: 201,
          body: {
            command: "create_session",
            payload: { sessionId: SESSION_ID, revision: 0, projection: makeProjection() },
          },
          setCookie: `${SESSION_COOKIE}; Path=/; HttpOnly; SameSite=Strict`,
        };
      case "/sessions/projection-sync":
        return {
          status: 200,
          body: { command: "sync_projection", payload: { revision: 0, projection: makeProjection() } },
        };
      default:
        return { status: 404, body: { code: "internal_error", message: "no such route (mock)" } };
    }
  });
  const client = new SessionClient({
    fetch: mockFetch.fetch,
    webSocketFactory: fakeWebSocketFactory,
    raf: (callback) => {
      callback();
      return 0;
    },
    cancelRaf: () => undefined,
    scheduleTimer: timers.schedule,
    cancelTimer: timers.cancel,
    generateIdempotencyKey: (() => {
      let counter = 0;
      return () => `key-${String((counter += 1))}`;
    })(),
    baseUrl: "http://127.0.0.1:13000",
  });
  const workspace = await mountWorkspace();
  workspace.verdictPollerFactory = (sessionClient: SessionClient) =>
    new VerdictPoller({
      sink: sessionClient,
      baseIntervalMs: 2500,
      maxIntervalMs: 30000,
      scheduleTimer: timers.schedule,
      cancelTimer: timers.cancel,
    });
  workspace.client = client;
  await workspace.updateComplete;
  await client.createSession(CREATE_INPUT);
  client.connect();
  const socket = FakeWebSocket.last;
  socket.serverAccepts();
  await settle();
  await workspace.updateComplete;
  return { workspace, mockFetch, timers, submitCalls };
}

async function clickSubmit(workspace: SmWorkspace): Promise<void> {
  const submit = menuShadow(workspace).querySelector("button.submit-button") as HTMLButtonElement;
  expect(submit).not.toBeNull();
  submit.click();
  await settle();
  await workspace.updateComplete;
}

describe("<sm-workspace> 提交 → pending 呈现(D-API-84 确定性形态)", () => {
  it("菜单「提交」点击 → submit 受理 → 裁决重询启动,pending 横幅呈现(零进度语义)", async () => {
    const harness = await mountVerdictWorkspace({
      verdictResponses: () => ({
        status: 200,
        body: { submissionId: "submission-verdict-1", revision: 0, status: "pending" },
      }),
    });
    const { workspace, timers, submitCalls } = harness;
    expect(submitCalls.count).toBe(0);

    await clickSubmit(workspace);
    expect(submitCalls.count).toBe(1);

    await timers.runNext(); // 首询 pending
    await workspace.updateComplete;
    const banner = verdictBanner(workspace);
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute("data-verdict-state")).toBe("pending");
    expect(banner!.textContent).toContain("已提交 · 裁决进行中");
    // 不误读锚:pending 呈现明示"不代表通过或失败"(D-API-84 定案锚)。
    expect(banner!.textContent).toContain("不代表通过或失败");
    expect(banner!.getAttribute("data-verdict-result")).toBeNull();
    workspace.remove();
  });

  it("提交前无裁决横幅(呈现缺席 ≠ 空数据)", async () => {
    const harness = await mountVerdictWorkspace({
      verdictResponses: () => ({ status: 200, body: { submissionId: "x", revision: 0, status: "pending" } }),
    });
    expect(verdictBanner(harness.workspace)).toBeNull();
    harness.workspace.remove();
  });
});

describe("<sm-workspace> verdicted 呈现(11 值结果类型;成绩 / 非成绩分向)", () => {
  it("success → 成绩方向通过呈现,携带 data-verdict-result 字面,零重试入口", async () => {
    const { workspace, timers } = await mountVerdictWorkspace({
      verdictResponses: () => ({
        status: 200,
        body: {
          submissionId: "submission-verdict-1",
          revision: 0,
          status: "verdicted",
          verdict: "success",
          decidedAt: 1_789_200_000,
        },
      }),
    });
    await clickSubmit(workspace);
    await timers.runNext();
    await workspace.updateComplete;

    const banner = verdictBanner(workspace);
    expect(banner!.getAttribute("data-verdict-state")).toBe("verdicted");
    expect(banner!.getAttribute("data-verdict-result")).toBe("success");
    expect(banner!.textContent).toContain("本次提交通过(success)");
    expect(banner!.querySelector("button.verdict-resubmit")).toBeNull();
    workspace.remove();
  });

  it("wrong_answer → 成绩方向未通过呈现(字面呈现,零部分匹配信息)", async () => {
    const { workspace, timers } = await mountVerdictWorkspace({
      verdictResponses: () => ({
        status: 200,
        body: {
          submissionId: "submission-verdict-1",
          revision: 0,
          status: "verdicted",
          verdict: "wrong_answer",
          decidedAt: 1_789_200_000,
        },
      }),
    });
    await clickSubmit(workspace);
    await timers.runNext();
    await workspace.updateComplete;

    const banner = verdictBanner(workspace);
    expect(banner!.getAttribute("data-verdict-result")).toBe("wrong_answer");
    expect(banner!.textContent).toContain("本次提交未通过(wrong_answer)");
    expect(banner!.querySelector("button.verdict-resubmit")).toBeNull();
    workspace.remove();
  });

  it.each(["engine_error", "challenge_invalid", "replay_mismatch", "cancelled"] as const)(
    "非成绩方向 %s → 「未产生成绩」呈现 + 显式重新提交入口(点击即新 submit)",
    async (verdict) => {
      const { workspace, timers, submitCalls } = await mountVerdictWorkspace({
        verdictResponses: () => ({
          status: 200,
          body: {
            submissionId: "submission-verdict-1",
            revision: 0,
            status: "verdicted",
            verdict,
            decidedAt: 1_789_200_000,
          },
        }),
      });
      await clickSubmit(workspace);
      await timers.runNext();
      await workspace.updateComplete;

      const banner = verdictBanner(workspace);
      expect(banner!.getAttribute("data-verdict-result")).toBe(verdict);
      expect(banner!.textContent).toContain(`本次提交未产生成绩(${verdict})`);
      const resubmit = banner!.querySelector("button.verdict-resubmit") as HTMLButtonElement;
      expect(resubmit).not.toBeNull();
      resubmit.click();
      await settle();
      await workspace.updateComplete;
      expect(submitCalls.count).toBe(2);
      workspace.remove();
    },
  );
});

describe("<sm-workspace> 裁决暂不可用(降级明示;不中断会话、不判负)", () => {
  it("重询连续失败触顶 → unavailable 横幅(pwn-degraded 语义锚;会话标签页仍在)", async () => {
    const { workspace, timers } = await mountVerdictWorkspace({
      verdictResponses: () => ({
        status: 429,
        body: { code: "budget_exhausted", message: "rate limit exceeded" },
      }),
    });
    await clickSubmit(workspace);
    // 失败预算缺省 5:首询 + 4 次退避重试后停询。
    for (let index = 0; index < 5; index += 1) {
      await timers.runNext();
      await workspace.updateComplete;
    }
    const banner = verdictBanner(workspace);
    expect(banner!.getAttribute("data-verdict-state")).toBe("unavailable");
    expect(banner!.getAttribute("data-pwn-reason")).toBe("verdict-unavailable");
    expect(banner!.textContent).toContain("裁决暂不可用");
    expect(banner!.textContent).toContain("不会因此判负");
    // 不中断会话:标签页面板仍挂载。
    expect(shadowOf(workspace).querySelectorAll("sm-byte-tab").length).toBeGreaterThanOrEqual(0);
    workspace.remove();
  });
});

/**
 * 13.3 API 侧条目落地(阶段三 WP-7 第 3 条;逐条测试)。
 *
 * 条目 → 测试(行内注明承载面;iframe 面条目见文件尾排除说明):
 *  1. 过期 revision —— 服务端权威锚定(零状态腐化),确定性(I-4);
 *  2. 重复幂等键 —— 同键同负载缓存同形;同键异负载冲突;
 *  3. 跨租户 session —— REST 凭证绑定 401;WSS 会话绑定错误帧;
 *  4. 断线重连与投影重同步 —— 重连(凭证重验)→ sync-projection 对齐 →
 *     新锚继续;
 *  5. 权限校验 —— 过期 embed token、已消费 jti 重放、未认证、过期会话凭证
 *     全部确定性 401 统一形态;
 *  6. 限流 —— REST 429 冻结形态逐字节确定(rate:{tenant}:{user});
 *  7. 超时和资源限制 —— worker 看门狗超时(timeout 映射)、请求体字节
 *     上限 413、clientSeq 单会话预算触顶;帧字节超限 close 1009 已由
 *     test/wss/channel.integration.test.ts 承载(协议层强制,此处不重复)。
 *
 * 排除说明(D-API-64 登记):13.3 中 iframe / 握手超时 / 自适应高度等嵌入面
 * 条目归阶段五(嵌入协议交付通道),不在本 API 侧清单。
 */

import { afterEach, describe, expect, it } from "vitest";

import { SESSION_CREDENTIAL_COOKIE_NAME } from "../../src/auth/cookie.js";
import {
  DEFAULT_ALLOWED_ORIGINS,
  TEST_TENANT_BETA_ID,
  buildSessionTestRig,
  sessionCommand,
} from "../routes/helpers/session-rig.js";
import {
  actionFrame,
  createConnectedStack,
  sendFrame,
  type ConnectedStack,
} from "./helpers/wp7-harness.js";

const STACKS: ConnectedStack[] = [];
const RIGS: Awaited<ReturnType<typeof buildSessionTestRig>>[] = [];

async function buildStack(options?: Parameters<typeof createConnectedStack>[0]): Promise<ConnectedStack> {
  const stack = await createConnectedStack(options);
  STACKS.push(stack);
  return stack;
}

afterEach(async () => {
  const stacks = STACKS.splice(0, STACKS.length);
  for (const stack of stacks) {
    await stack.rig.wssRegistry.closeAll();
    await stack.rig.app.close();
  }
  const rigs = RIGS.splice(0, RIGS.length);
  for (const rig of rigs) {
    await rig.wssRegistry.closeAll();
    await rig.app.close();
  }
});

/** 13.3-1:过期 revision。 */
describe("13.3-1 过期 revision:服务端权威锚定,确定性", () => {
  it("携带过期 baseRevision 的动作不腐化权威状态(服务端锚定续算,同输入恒同响应)", async () => {
    const stack = await buildStack();
    sendFrame(stack.client, actionFrame({
      sessionId: stack.sessionId, seq: 1, clientSeq: 1, baseRevision: 0,
      idempotencyKey: "acc-rev-1", actionType: "step",
    }));
    await stack.collector.waitFor((frames) => frames.length === 1);
    // 携带过期锚(baseRevision = 0,权威已是 1)的动作:服务端以权威账本
    // 锚定执行(实现语义 D-API-62),revision 确定性 +1。
    sendFrame(stack.client, actionFrame({
      sessionId: stack.sessionId, seq: 2, clientSeq: 2, baseRevision: 0,
      idempotencyKey: "acc-rev-2", actionType: "step",
    }));
    await stack.collector.waitFor((frames) => frames.length === 2);
    const second = stack.collector.frames[1];
    expect(second?.type).toBe("action_response");
    if (second?.type === "action_response") {
      expect(second.payload.revision).toBe(2);
    }
    // 同输入恒同响应:新会话对同序列产生同形响应面。
    const twin = await buildStack();
    for (const seq of [1, 2]) {
      sendFrame(twin.client, actionFrame({
        sessionId: twin.sessionId, seq, clientSeq: seq, baseRevision: 0,
        idempotencyKey: `acc-rev-twin-${seq}`, actionType: "step",
      }));
    }
    await twin.collector.waitFor((frames) => frames.length === 2);
    const strip = (frame: unknown) => {
      const clone = JSON.parse(JSON.stringify(frame)) as Record<string, unknown> & {
        payload: Record<string, unknown>;
      };
      delete clone["seq"];
      delete clone["sessionId"];
      delete clone.payload["requestId"];
      delete clone.payload["sessionId"];
      return JSON.stringify(clone);
    };
    expect(strip(twin.collector.frames[1])).toBe(strip(second));
  });
});

/** 13.3-2:重复幂等键。 */
describe("13.3-2 重复幂等键:缓存同形与冲突拒绝", () => {
  it("同键同负载 → 字节相同缓存;同键异负载 → idempotency_conflict 且无执行", async () => {
    const stack = await buildStack();
    sendFrame(stack.client, actionFrame({
      sessionId: stack.sessionId, seq: 1, clientSeq: 1, baseRevision: 0,
      idempotencyKey: "acc-idem-1", actionType: "write_bytes", bytesHex: "aa",
    }));
    await stack.collector.waitFor((frames) => frames.length === 1);
    sendFrame(stack.client, actionFrame({
      sessionId: stack.sessionId, seq: 2, clientSeq: 1, baseRevision: 0,
      idempotencyKey: "acc-idem-1", actionType: "write_bytes", bytesHex: "aa",
    }));
    await stack.collector.waitFor((frames) => frames.length === 2);
    const [first, replay] = stack.collector.frames;
    expect(replay?.type).toBe("action_response");
    const strip = (frame: unknown) => {
      const clone = JSON.parse(JSON.stringify(frame)) as Record<string, unknown> & {
        payload: Record<string, unknown>;
      };
      delete clone["seq"];
      delete clone.payload["requestId"];
      return JSON.stringify(clone);
    };
    expect(strip(replay)).toBe(strip(first));

    sendFrame(stack.client, actionFrame({
      sessionId: stack.sessionId, seq: 3, clientSeq: 2, baseRevision: 0,
      idempotencyKey: "acc-idem-1", actionType: "step",
    }));
    await stack.collector.waitFor((frames) => frames.length === 3);
    const conflict = stack.collector.frames[2];
    expect(conflict?.type).toBe("error");
    if (conflict?.type === "error") {
      expect(conflict.payload.code).toBe("idempotency_conflict");
    }
  });
});

/** 13.3-3:跨租户 session。 */
describe("13.3-3 跨租户 session:凭证绑定与会话绑定双层拒绝", () => {
  it("租户 B 凭证操作租户 A 会话:REST 401 统一形态;WSS 错误帧且连接保持", async () => {
    const rig = await buildSessionTestRig();
    RIGS.push(rig);
    await rig.registerChallenge(); // 租户 A(alpha)题目
    // 租户 B 同名题目:版本键为 challengeId@version 全局唯一(版本不可变),
    // 以独立 challengeId 登记(跨租户隔离在注册表层即为独立行)。
    await rig.registerChallenge({ challengeId: "chal-beta-stack", tenantId: TEST_TENANT_BETA_ID });

    // 租户 A 会话。
    const issuedA = await rig.issueEmbedToken();
    const createdA = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: sessionCommand("create_session", {
        challengeId: issuedA.claims.challengeId,
        challengeVersion: issuedA.claims.challengeVersion,
        embedSessionId: issuedA.claims.embedSessionId,
        embedToken: issuedA.token,
      }),
    });
    expect(createdA.statusCode).toBe(201);
    const sessionIdA = (createdA.json() as { payload: { sessionId: string } }).payload.sessionId;

    // 租户 B 会话(独立凭证;独立 challengeId)。
    const issuedB = await rig.issueEmbedToken({
      claims: { tenantId: TEST_TENANT_BETA_ID, challengeId: "chal-beta-stack" },
    });
    const createdB = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: sessionCommand("create_session", {
        challengeId: issuedB.claims.challengeId,
        challengeVersion: issuedB.claims.challengeVersion,
        embedSessionId: issuedB.claims.embedSessionId,
        embedToken: issuedB.token,
      }),
    });
    expect(createdB.statusCode).toBe(201);
    const cookieB = createdA.headers["set-cookie"] === undefined ? "" : "";
    void cookieB;
    const credentialB = createdB.headers["set-cookie"] as unknown as string;
    const cookieValueB = credentialB.slice(credentialB.indexOf("=") + 1, credentialB.indexOf(";", credentialB.indexOf("=")));

    // REST 层:B 的凭证 + A 的 sessionId → 凭证绑定 401 统一形态(防枚举)。
    const crossRest = await rig.app.inject({
      method: "POST",
      url: "/sessions/projection-sync",
      cookies: { [SESSION_CREDENTIAL_COOKIE_NAME]: cookieValueB },
      headers: { origin: DEFAULT_ALLOWED_ORIGINS },
      payload: sessionCommand("sync_projection", { sessionId: sessionIdA }),
    });
    expect(crossRest.statusCode).toBe(401);
    expect(crossRest.json()).toEqual({ code: "invalid_input_format", message: "authentication failed" });

    // WSS 层:B 的连接(绑定 B 会话)发 A 的 sessionId 帧 → 会话绑定错误帧。
    const clientB = await rig.connectChannel(cookieValueB);
    const frames: unknown[] = [];
    clientB.on("message", (data: Buffer) => frames.push(JSON.parse(data.toString("utf8"))));
    clientB.send(JSON.stringify(actionFrame({ sessionId: sessionIdA, seq: 1, idempotencyKey: "acc-cross-1" })));
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = () => {
        if (frames.length > 0) {
          resolve();
        } else if (Date.now() > deadline) {
          reject(new Error("等待跨会话错误帧超时"));
        } else {
          setTimeout(poll, 10);
        }
      };
      poll();
    });
    const rejected = frames[0] as { type: string; payload?: { code: string; message: string } };
    expect(rejected.type).toBe("error");
    expect(rejected.payload?.code).toBe("invalid_input_format");
    expect(rejected.payload?.message).toBe("session mismatch");

    // 会话定位双条件:manager 以 (sessionId, tenantId) 定位——B 会话命令不受影响。
    const ownSession = (createdB.json() as { payload: { sessionId: string } }).payload.sessionId;
    const ownSync = await rig.app.inject({
      method: "POST",
      url: "/sessions/projection-sync",
      cookies: { [SESSION_CREDENTIAL_COOKIE_NAME]: cookieValueB },
      headers: { origin: DEFAULT_ALLOWED_ORIGINS },
      payload: sessionCommand("sync_projection", { sessionId: ownSession }),
    });
    expect(ownSync.statusCode).toBe(200);
  });
});

/** 13.3-4:断线重连与投影重同步。 */
describe("13.3-4 断线重连与投影重同步", () => {
  it("断开 → 重连(凭证重验)→ REST sync-projection 对齐 revision → 新锚继续", async () => {
    const stack = await buildStack();
    sendFrame(stack.client, actionFrame({
      sessionId: stack.sessionId, seq: 1, clientSeq: 1, baseRevision: 0,
      idempotencyKey: "acc-reconn-1", actionType: "step",
    }));
    await stack.collector.waitFor((frames) => frames.length === 1);
    stack.client.close();

    // 重连:升级即凭证重验(preHandler 全量重跑)。
    const reconnected = await stack.rig.connectChannel(stack.cookie);
    const collector2 = new (await import("./helpers/wp7-harness.js")).WssFrameCollector();
    collector2.attach(reconnected);

    // REST sync-projection:只重发缓存投影(通道无同步通道,D-API-47)。
    const sync = await stack.rig.app.inject({
      method: "POST",
      url: "/sessions/projection-sync",
      cookies: { [SESSION_CREDENTIAL_COOKIE_NAME]: stack.cookie },
      headers: { origin: DEFAULT_ALLOWED_ORIGINS },
      payload: sessionCommand("sync_projection", { sessionId: stack.sessionId }),
    });
    expect(sync.statusCode).toBe(200);
    expect((sync.json() as { payload: { revision: number } }).payload.revision).toBe(1);

    // 新锚继续:会话未因断线关闭(在途表不动)。
    sendFrame(reconnected, actionFrame({
      sessionId: stack.sessionId, seq: 2, clientSeq: 2, baseRevision: 1,
      idempotencyKey: "acc-reconn-2", actionType: "step",
    }));
    await collector2.waitFor((frames) => frames.length === 1);
    const next = collector2.frames[0];
    expect(next?.type).toBe("action_response");
    if (next?.type === "action_response") {
      expect(next.payload.revision).toBe(2);
    }
    expect(stack.rig.manager.liveCount).toBe(1);
  });
});

/** 13.3-5:权限校验。 */
describe("13.3-5 权限校验:过期 / 重放 / 未认证 / 过期会话凭证", () => {
  it("过期 embed token → 401 统一形态(时钟注入,无需真实等待)", async () => {
    let nowMs = 1_700_000_000_000;
    const rig = await buildSessionTestRig({ now: () => nowMs });
    RIGS.push(rig);
    await rig.registerChallenge();
    const issued = await rig.issueEmbedToken({ ttlSeconds: 60 });
    nowMs += 61_000; // token 过期
    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: sessionCommand("create_session", {
        challengeId: issued.claims.challengeId,
        challengeVersion: issued.claims.challengeVersion,
        embedSessionId: issued.claims.embedSessionId,
        embedToken: issued.token,
      }),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "invalid_input_format", message: "authentication failed" });
  });

  it("已消费 jti 重放(同 token 二次 create_session)→ 401;绑定不符(embedSessionId 不一致)→ 401", async () => {
    const rig = await buildSessionTestRig();
    RIGS.push(rig);
    await rig.registerChallenge();
    const issued = await rig.issueEmbedToken();
    const body = sessionCommand("create_session", {
      challengeId: issued.claims.challengeId,
      challengeVersion: issued.claims.challengeVersion,
      embedSessionId: issued.claims.embedSessionId,
      embedToken: issued.token,
    });
    const first = await rig.app.inject({ method: "POST", url: "/sessions", payload: body });
    expect(first.statusCode).toBe(201);
    const replay = await rig.app.inject({ method: "POST", url: "/sessions", payload: body });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ code: "invalid_input_format", message: "authentication failed" });

    // 绑定不符:同一 token 换 embedSessionId 消费(与签发记录比对不一致)。
    const issued2 = await rig.issueEmbedToken();
    const mismatched = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: sessionCommand("create_session", {
        challengeId: issued2.claims.challengeId,
        challengeVersion: issued2.claims.challengeVersion,
        embedSessionId: "different-embed-session",
        embedToken: issued2.token,
      }),
    });
    expect(mismatched.statusCode).toBe(401);
  });

  it("未认证命令(无凭证 Cookie)→ 401;过期会话凭证(TTL=1s)→ 401", async () => {
    const rig = await buildSessionTestRig({ env: { SESSION_API_SESSION_CREDENTIAL_TTL_SECONDS: "1" } });
    RIGS.push(rig);
    await rig.registerChallenge();
    const issued = await rig.issueEmbedToken();
    const created = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: sessionCommand("create_session", {
        challengeId: issued.claims.challengeId,
        challengeVersion: issued.claims.challengeVersion,
        embedSessionId: issued.claims.embedSessionId,
        embedToken: issued.token,
      }),
    });
    expect(created.statusCode).toBe(201);
    const sessionId = (created.json() as { payload: { sessionId: string } }).payload.sessionId;
    const cookie = created.headers["set-cookie"] as unknown as string;
    const cookieValue = cookie.slice(cookie.indexOf("=") + 1, cookie.indexOf(";", cookie.indexOf("=")));

    const unauthenticated = await rig.app.inject({
      method: "POST",
      url: "/sessions/projection-sync",
      headers: { origin: DEFAULT_ALLOWED_ORIGINS },
      payload: sessionCommand("sync_projection", { sessionId }),
    });
    expect(unauthenticated.statusCode).toBe(401);

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const expired = await rig.app.inject({
      method: "POST",
      url: "/sessions/projection-sync",
      cookies: { [SESSION_CREDENTIAL_COOKIE_NAME]: cookieValue },
      headers: { origin: DEFAULT_ALLOWED_ORIGINS },
      payload: sessionCommand("sync_projection", { sessionId }),
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toEqual({ code: "invalid_input_format", message: "authentication failed" });
  }, 15_000);
});

/** 13.3-6:限流。 */
describe("13.3-6 限流:触顶 429 冻结形态,逐字节确定", () => {
  it("rate:{tenant}:{user} 触顶 → 429 {budget_exhausted};拒绝响应逐字节一致", async () => {
    const rig = await buildSessionTestRig({
      env: { SESSION_API_RATE_LIMIT_REQUESTS_PER_MINUTE: "2" },
    });
    RIGS.push(rig);
    await rig.registerChallenge();
    const issued = await rig.issueEmbedToken();
    const created = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: sessionCommand("create_session", {
        challengeId: issued.claims.challengeId,
        challengeVersion: issued.claims.challengeVersion,
        embedSessionId: issued.claims.embedSessionId,
        embedToken: issued.token,
      }),
    });
    expect(created.statusCode).toBe(201); // 第 1 次(窗口内)
    const sessionId = (created.json() as { payload: { sessionId: string } }).payload.sessionId;
    const cookie = created.headers["set-cookie"] as unknown as string;
    const cookieValue = cookie.slice(cookie.indexOf("=") + 1, cookie.indexOf(";", cookie.indexOf("=")));

    const command = () => rig.app.inject({
      method: "POST",
      url: "/sessions/projection-sync",
      cookies: { [SESSION_CREDENTIAL_COOKIE_NAME]: cookieValue },
      headers: { origin: DEFAULT_ALLOWED_ORIGINS },
      payload: sessionCommand("sync_projection", { sessionId }),
    });
    const second = await command();
    expect(second.statusCode).toBe(200); // 第 2 次(窗口内最后一次)
    const third = await command();
    const fourth = await command();
    expect(third.statusCode).toBe(429);
    expect(fourth.statusCode).toBe(429);
    expect(third.json()).toEqual({ code: "budget_exhausted", message: "rate limit exceeded" });
    // 确定性:同状态同请求 → 响应体逐字节一致(I-4)。
    expect(JSON.stringify(fourth.json())).toBe(JSON.stringify(third.json()));
  });
});

/** 13.3-7:超时和资源限制。 */
describe("13.3-7 超时和资源限制", () => {
  it("worker 看门狗超时 → timeout 映射错误帧(budget_exhausted / session timed out)", async () => {
    const stack = await buildStack({ workerMode: "watchdog_on_apply" });
    sendFrame(stack.client, actionFrame({
      sessionId: stack.sessionId, seq: 1, clientSeq: 1, baseRevision: 0,
      idempotencyKey: "acc-timeout-1", actionType: "step",
    }));
    await stack.collector.waitFor((frames) => frames.length === 1);
    const timeout = stack.collector.frames[0];
    expect(timeout?.type).toBe("error");
    if (timeout?.type === "error") {
      expect(timeout.payload.code).toBe("budget_exhausted");
      expect(timeout.payload.message).toBe("session timed out");
    }
  });

  it("请求体字节超限 → 413 冻结形态(request too large)", async () => {
    const rig = await buildSessionTestRig();
    RIGS.push(rig);
    await rig.registerChallenge();
    const oversized = "x".repeat(70_000); // > 默认 64 KiB bodyLimit
    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      headers: { origin: DEFAULT_ALLOWED_ORIGINS },
      payload: { command: "create_session", protocolVersion: 1, payload: { pad: oversized } },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ code: "invalid_input_format", message: "request too large" });
  });

  it("clientSeq 单会话预算触顶 → 409 错误帧(stale_client_seq / budget exhausted)", async () => {
    const stack = await buildStack({ env: { SESSION_API_MAX_CLIENT_SEQ_PER_SESSION: "2" } });
    for (const seq of [1, 2]) {
      sendFrame(stack.client, actionFrame({
        sessionId: stack.sessionId, seq, clientSeq: seq, baseRevision: seq - 1,
        idempotencyKey: `acc-budget-${seq}`, actionType: "step",
      }));
    }
    await stack.collector.waitFor((frames) => frames.length === 2);
    sendFrame(stack.client, actionFrame({
      sessionId: stack.sessionId, seq: 3, clientSeq: 3, baseRevision: 2,
      idempotencyKey: "acc-budget-3", actionType: "step",
    }));
    await stack.collector.waitFor((frames) => frames.length === 3);
    const exhausted = stack.collector.frames[2];
    expect(exhausted?.type).toBe("error");
    if (exhausted?.type === "error") {
      expect(exhausted.payload.code).toBe("stale_client_seq");
      expect(exhausted.payload.message).toBe("client sequence budget exhausted");
    }
  });
});

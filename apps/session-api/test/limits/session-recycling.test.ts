/**
 * 会话资源回收(任务分解 WP-6 第 3 条;D-API-45 / D-API-55):
 *  - 断线保持超时回收:fake 会话 → 保持计时器到期 → 会话关闭 + worker 回收 +
 *    sessions 行 phase 对齐 closed + route 键已释放(WP-5 注册表释放,断言
 *    不双重释放)+ session_force_closed 审计 + 每会话动作频率桶逐出;
 *  - 重连在到期前取消回收:会话保持活跃、phase 不变、零强制关闭审计;
 *  - 终态会话保留窗口:TerminalSessionCleaner 清理入口(purgeExpired)——
 *    终态行按窗口清除、active 行不受影响、快照按自身保留期先行清除;幂等。
 *
 * 驱动方式:rig 的 wssRegistry 直驱(injectWS 的 Duplexify 模拟传输不把
 * "客户端发起 close"传播为服务端 close 事件——与 WP-5 connection-lifecycle
 * 测试同一约束),走装配台真实的 onKeepaliveExpiry 组合钩子(回收执行面)。
 */
import { describe, expect, it, vi } from "vitest";

import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  TEST_TENANT_ID,
  buildSessionTestRig,
  sessionCommand,
  sessionCredentialFromSetCookie,
  type SessionTestRig,
} from "../routes/helpers/session-rig.js";
import type { RegistryChannel } from "../../src/wss/connection-registry.js";

async function createSessionWithCookie(rig: SessionTestRig): Promise<{ sessionId: string; cookie: string }> {
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
  expect(response.statusCode).toBe(201);
  const sessionId = (response.json() as { payload: { sessionId: string } }).payload.sessionId;
  const cookie = sessionCredentialFromSetCookie({
    headers: response.headers as Record<string, unknown>,
  });
  return { sessionId, cookie };
}

/** 注册表替身通道(RegistryChannel 最小实现;激活即 route 绑定)。 */
function stubChannel(sessionId: string, tenantId: string): RegistryChannel {
  return {
    sessionId,
    tenantId,
    replaceByNewConnection: () => undefined,
    closeForShutdown: async () => undefined,
  };
}

describe("断线保持超时回收(D-API-55)", () => {
  it("保持计时器到期:会话关闭 + worker 回收 + phase 对齐 closed + route 已释放(不双重释放)+ 频率桶逐出", async () => {
    const rig = await buildSessionTestRig({ wss: { disconnectKeepaliveSeconds: 0.05 } });
    await rig.registerChallenge();
    const { sessionId } = await createSessionWithCookie(rig);
    expect(rig.manager.liveCount).toBe(1);

    // route 键释放计数(注册表到期释放一次;回收路径不得重复触碰 route 键)。
    let routeReleaseCalls = 0;
    const originalRelease = rig.routeStore.release.bind(rig.routeStore);
    rig.routeStore.release = async (id: string) => {
      routeReleaseCalls += 1;
      await originalRelease(id);
    };

    // 激活连接(route 绑定 + 每会话动作频率桶创建),然后断开(启动计时器)→ 到期。
    const channel = stubChannel(sessionId, TEST_TENANT_ID);
    rig.wssRegistry.activate(channel);
    expect(rig.sessionActionLimiter.tryTake(sessionId)).toBe(true); // 桶已建(消耗 1 令牌)
    expect(await rig.routeStore.resolve(sessionId)).not.toBeNull();
    rig.wssRegistry.deactivate(channel);

    await vi.waitFor(
      async () => {
        expect(rig.manager.liveCount).toBe(0);
      },
      { timeout: 2000, interval: 10 },
    );

    // route 键已释放(WP-5 注册表先行),且只释放一次(回收路径不双重释放)。
    expect(routeReleaseCalls).toBe(1);
    expect(await rig.routeStore.resolve(sessionId)).toBeNull();
    // 每会话动作频率桶已逐出(D-API-53 回收联动)。
    expect(rig.sessionActionLimiter.trackedSessionCount).toBe(0);
    // 会话行 phase 对齐 + 强制关闭审计(回收理由)。
    expect((await rig.sessions.findSession(sessionId, TEST_TENANT_ID))?.phase).toBe("closed");
    const forceClose = rig.audit
      .snapshot()
      .filter((event) => event.kind === "session_force_closed" && event.sessionId === sessionId);
    expect(forceClose).toHaveLength(1);
    expect(forceClose[0]?.detail).toMatchObject({ reason: "disconnect_keepalive_expiry" });
    // 回收幂等:重复到期回收对已回收会话为 no-op。
    expect(await rig.manager.reclaimDisconnected(sessionId, TEST_TENANT_ID)).toBe("not_live");
  });

  it("重连在到期前取消回收;到期后回收带终态恢复点落库", async () => {
    const rig = await buildSessionTestRig({ wss: { disconnectKeepaliveSeconds: 0.05 } });
    await rig.registerChallenge();
    const { sessionId } = await createSessionWithCookie(rig);

    // checkpoint 先建(显式恢复点落库)。
    await rig.manager.applyAction(sessionId, TEST_TENANT_ID, { type: "create_checkpoint", args: {} });
    expect(await rig.snapshots.listBySession(sessionId, TEST_TENANT_ID)).toHaveLength(1);

    // 断开(启动计时器)→ 到期前重连(取消)→ 会话保持活跃、phase 不变。
    const first = stubChannel(sessionId, TEST_TENANT_ID);
    rig.wssRegistry.activate(first);
    rig.wssRegistry.deactivate(first);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = stubChannel(sessionId, TEST_TENANT_ID);
    rig.wssRegistry.activate(second); // 重连激活(取消回收计时器)
    await new Promise((resolve) => setTimeout(resolve, 150)); // 越过保持窗口

    expect(rig.manager.liveCount).toBe(1);
    expect((await rig.sessions.findSession(sessionId, TEST_TENANT_ID))?.phase).toBe("active");
    expect(rig.audit.snapshot().filter((event) => event.kind === "session_force_closed")).toHaveLength(0);

    // 再次断开且不重连:到期回收(优雅关闭 → phase 对齐 → 审计)。
    rig.wssRegistry.deactivate(second);
    await vi.waitFor(
      async () => {
        expect(rig.manager.liveCount).toBe(0);
      },
      { timeout: 2000, interval: 10 },
    );

    const row = await rig.sessions.findSession(sessionId, TEST_TENANT_ID);
    expect(row?.phase).toBe("closed");
    expect(await rig.routeStore.resolve(sessionId)).toBeNull();
    const forceClose = rig.audit
      .snapshot()
      .filter((event) => event.kind === "session_force_closed" && event.sessionId === sessionId);
    expect(forceClose).toHaveLength(1);
    expect(forceClose[0]?.detail).toMatchObject({ reason: "disconnect_keepalive_expiry" });
    // 回收路径落终态恢复点(session_close,不去重——D-API-25 ③):显式行 +
    // 终态行,恢复点保持可用。
    const persisted = await rig.snapshots.listBySession(sessionId, TEST_TENANT_ID);
    expect(persisted).toHaveLength(2);
    expect(persisted.map((row) => row.origin).sort()).toEqual(["explicit_checkpoint", "session_close"]);
  });

  it("优雅关闭失败的回收路径:worker 收割(kill)仍对齐 phase 并完成回收", async () => {
    // crash_on_apply worker:任何动作触发崩溃 → 回收路径中优雅关闭必失败。
    const rig = await buildSessionTestRig({
      workerMode: "crash_on_apply",
      wss: { disconnectKeepaliveSeconds: 0.05 },
    });
    await rig.registerChallenge();
    const { sessionId } = await createSessionWithCookie(rig);

    const channel = stubChannel(sessionId, TEST_TENANT_ID);
    rig.wssRegistry.activate(channel);
    rig.wssRegistry.deactivate(channel);
    await vi.waitFor(
      async () => {
        expect(rig.manager.liveCount).toBe(0);
      },
      { timeout: 2000, interval: 10 },
    );

    // worker 已收割、会话行仍对齐终态(回收优先于状态细分)。
    expect((await rig.sessions.findSession(sessionId, TEST_TENANT_ID))?.phase).toBe("closed");
    expect(rig.audit.snapshot().some((event) => event.kind === "session_force_closed")).toBe(true);
  });
});

describe("终态会话保留窗口清理入口(T0 无 cron,可调用;D-API-55)", () => {
  it("终态行按窗口清除;active 行不受影响;快照按保留期先行清除;幂等", async () => {
    let nowMs = 1_700_000_000_000;
    const rig = await buildSessionTestRig({
      now: () => nowMs,
      env: { SESSION_API_SNAPSHOT_RETENTION_DAYS: "7", SESSION_API_TERMINAL_SESSION_RETENTION_DAYS: "30" },
    });
    await rig.registerChallenge();

    // 会话 A:checkpoint(显式快照行)→ close(终态行 + session_close 快照行)。
    const a = await createSessionWithCookie(rig);
    await rig.manager.applyAction(a.sessionId, TEST_TENANT_ID, { type: "create_checkpoint", args: {} });
    await rig.manager.closeSession(a.sessionId, TEST_TENANT_ID);
    // 会话 B:保持 active。
    const b = await createSessionWithCookie(rig);
    expect(await rig.sessions.listSessionsByTenant(TEST_TENANT_ID)).toHaveLength(2);

    // 第 3 天:终态窗口(30 天)与快照保留期(7 天)均未到 → 零清除。
    nowMs += 3 * 86_400_000;
    expect(
      await rig.terminalCleaner.purgeExpired({ terminalRetentionDays: 30, snapshotRetentionDays: 7 }),
    ).toEqual({ purgedSessions: 0, purgedSnapshots: 0 });

    // 第 40 天:A 的终态行过 30 天窗口 → 清除;active 行(B)保留;
    // A 的两行快照(第 0 天)早已过 7 天快照保留期 → 先行清除。
    nowMs += 37 * 86_400_000;
    expect(
      await rig.terminalCleaner.purgeExpired({ terminalRetentionDays: 30, snapshotRetentionDays: 7 }),
    ).toEqual({ purgedSessions: 1, purgedSnapshots: 2 });
    expect(await rig.sessions.findSession(a.sessionId, TEST_TENANT_ID)).toBeNull();
    expect((await rig.sessions.findSession(b.sessionId, TEST_TENANT_ID))?.phase).toBe("active");

    // 幂等:重复调用零效果。
    expect(
      await rig.terminalCleaner.purgeExpired({ terminalRetentionDays: 30, snapshotRetentionDays: 7 }),
    ).toEqual({ purgedSessions: 0, purgedSnapshots: 0 });
  });
});

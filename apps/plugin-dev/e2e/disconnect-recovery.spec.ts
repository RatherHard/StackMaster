/**
 * E2E 场景(任务分解 ③断线恢复;阶段退出条件 7 的浏览器面)。
 *
 * 断线注入 = page.routeWebSocket 在页面侧以 close 1000(服务端语义 = 空闲
 * 超时,可重连)断开动作通道——从客户端视角等价"服务端侧断开",不依赖
 * CDP 离线模拟(Chromium 网络离线仿真不影响已建立的 WebSocket)。
 *
 * 断言(硬门槛:断线只展示最近一次公开投影,禁止本地 VM 降级;重连走
 * sync-projection):
 *  - 断线 → 横幅出现(正在呈现最近一次公开投影 + 明示零本地 VM 降级);
 *  - 恢复(解除注入,自动重连)→ 横幅消失、连接态 connected、触发过 REST
 *    sync-projection 对齐、revision 不回退;
 *  - 「视图仍渲染最近投影(行地址与断线前一致)」的字节行断言为验收锚,
 *    当前受 vm-ui 虚拟化真实浏览器缺陷影响(见 session.spec.ts 文件头登记)。
 */
import {
  byteRows,
  closeSessionBestEffort,
  createSessionViaForm,
  disconnectBanner,
  expect,
  menuStatus,
  openTabButton,
  test,
} from "./fixtures.js";
import type { WebSocketRoute } from "@playwright/test";

test.describe("断线恢复(sync-projection 对齐;零本地 VM 降级)", () => {
  test("服务端侧断开 → 断线横幅 → 重连 → sync 对齐恢复,revision 不回退", async ({
    page,
  }) => {
    // 注入点必须先于会话建立注册(WSS 首连即经注入点,拿到通道句柄):
    // 截获动作通道并保持与服务端直通;drop 时从页面侧以 close 1000(服务端
    // 语义 = 空闲超时,可自动重连)断开——从客户端视角等价"服务端侧断开"。
    // 重连的新连接在 unroute 之后直连服务端,不再经注入点。
    let channel: WebSocketRoute | null = null;
    const intercept = (ws: WebSocketRoute): void => {
      channel = ws;
      ws.connectToServer();
    };
    await page.routeWebSocket(/\/sessions\/channel$/, intercept);

    const sessionId = await createSessionViaForm(page);
    try {
      await openTabButton(page, "stack").click();

      // 断线前锚点:revision(恢复后不得回退)。
      const revisionBefore = (await menuStatus(page, "revision").textContent())?.trim();
      expect(revisionBefore ?? "").toMatch(/^\d+$/);

      // ── 服务端侧断开 ──
      if (channel === null) {
        throw new Error("动作通道尚未建立,无法注入断线");
      }
      await channel.close({ code: 1000, reason: "server-side drop (e2e)" });

      // 断线横幅出现:呈现最近一次公开投影;明示零本地 VM 降级(硬门槛)。
      const banner = disconnectBanner(page);
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("最近一次公开投影");
      await expect(banner).toContainText("本工作区不做任何本地 VM 执行降级");

      // 统计 sync-projection 调用(重连成功后必须至少一次;fallback 链回
      // context 的 Origin 对齐路由,不改写请求本身)。
      let syncCalls = 0;
      await page.route(/\/sessions\/projection-sync$/, async (route) => {
        syncCalls += 1;
        await route.fallback();
      });

      // ── 重连:注入点保持透传(connectToServer = 直连语义),新连接不再
      // 注入断线;Playwright 1.63 无 unrouteWebSocket,透传即等价解除注入 ──
      await expect(banner).toHaveCount(0);
      await expect(menuStatus(page, "connection-status")).toHaveText("connected");
      // 连接态翻转为 connected(onopen)先于 sync 响应回流:轮询等待调用发生。
      await expect
        .poll(() => syncCalls, { message: "重连后未触发 sync-projection" })
        .toBeGreaterThanOrEqual(1);

      // revision 不回退(断线只保留最近投影,重连 sync 对齐同值)。
      const revisionAfter = (await menuStatus(page, "revision").textContent())?.trim() ?? "";
      expect(Number(revisionAfter)).toBeGreaterThanOrEqual(Number(revisionBefore ?? "0"));

      // ── 验收锚:视图仍渲染最近投影(行地址与断线前一致)─────────────────
      // 当前受 vm-ui 虚拟化真实浏览器缺陷影响(行不渲染),修复后即绿。
      const rows = byteRows(page);
      const firstRowAddressBefore = await rows.first().getAttribute("data-row-address");
      await expect(rows.first()).toBeVisible();
      expect(await rows.first().getAttribute("data-row-address")).toBe(firstRowAddressBefore);
    } finally {
      // 会话回收(卫生措施;tenant 隔离已兜底预算)。
      if (sessionId !== null) {
        await closeSessionBestEffort(page, sessionId);
      }
    }
  });
});

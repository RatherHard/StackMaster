/**
 * 临时探针(取证后删除):量测「开发壳 #dev-status 置为『会话已创建并连接』」
 * 到「sm-workspace-menu .connection-status 收敛为 connected」之间的时序差,
 * 以及该差值是否与浏览器引擎相关。不与任何既有用例共用断言。
 */
import { randomBytes } from "node:crypto";

import { closeSessionBestEffort, createSessionViaForm, menuStatus, test } from "./fixtures.js";
import { seedFormalChallenge } from "./helpers/seed-formal-challenge.mjs";

test("探针:连接状态收敛时序", async ({ page }, testInfo) => {
  const tenantId = `e2e-probe-${randomBytes(4).toString("hex")}`;
  const challengeId = `chal-probe-${randomBytes(5).toString("hex")}`;
  const sessionId = await createSessionViaForm(page, {
    path: `/?descriptor=formal&challengeId=${challengeId}&challengeVersion=1.0.0`,
    challengeId,
    tenantId,
    registerChallenge: (ctx) => seedFormalChallenge(ctx),
  });

  // 采样:自 #dev-status 已确认起的 connection-status 文本轨迹。
  const start = Date.now();
  const samples: string[] = [];
  let connectedAt: number | null = null;
  for (let index = 0; index < 200; index += 1) {
    const text = (await menuStatus(page, "connection-status").textContent())?.trim() ?? "";
    samples.push(`${Date.now() - start}ms=${text}`);
    if (text === "connected") {
      connectedAt = Date.now() - start;
      break;
    }
    await page.waitForTimeout(50);
  }
  const devStatus = (await page.locator("#dev-status").textContent())?.trim() ?? "";
  const clientStatus = await page.evaluate(() => {
    const workspace = document.querySelector("sm-workspace") as {
      client?: { connectionStatus?: string; sendAction?: unknown };
    };
    return {
      hasClient: workspace?.client !== undefined,
      connectionStatus: workspace?.client?.connectionStatus ?? "(无)",
    };
  });
  console.log(
    `[probe][${testInfo.project.name}] devStatus=${JSON.stringify(devStatus)} client=${JSON.stringify(clientStatus)} connectedAt=${String(connectedAt)} 轨迹=${samples.slice(0, 12).join(" | ")}${samples.length > 12 ? " | …" : ""}`,
  );

  if (sessionId !== null) {
    await closeSessionBestEffort(page, sessionId);
  }
});

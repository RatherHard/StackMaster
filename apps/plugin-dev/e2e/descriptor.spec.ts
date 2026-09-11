/**
 * WP-54 E2E:M2 描述包正式下发通道全链路(compose 全拓扑 + plugin-dev 壳)。
 *
 * 与既有 spec 的差异(任务分解 WP-54 完成标准):**FE-ED-06 / FE-ED-07 与
 * 题目静态面由正式下发数据驱动**——题目经 `seed-formal-challenge.mjs` 的真实
 * 登记路径注册(公开描述包 = `e2e/fixtures/formal-descriptor.json` 语料,
 * 携带 hintLadder / publicErrorMapping / debugMode / encodingTable),开发壳
 * 以 `?descriptor=formal` 正式通道从 session-api descriptor 端点
 * (`GET /descriptors/:challengeId/:version`,WP-50 D-API-76)获取并消费。
 *
 * 全链路 = 每用例唯一 challengeId 登记 → 服务端间签发 embed token → 开发壳
 * 表单建会话 → 描述包客户端加载器(哈希 + 尺寸护栏双闸)→ 工作区:
 *   静态面(briefing / VM Profile / encodingTable)+ 提示阶梯(on_request
 *   逐级揭示 / after_n_failures 锁定)+ debugMode 门控 + 动作拒绝的错误解释
 *   teachingNote;
 * 以及红灯面:未登记题目 → 确定性缺席明示(会话不建立也不受影响)。
 *
 * 选择器锚 = 结构化属性与 class(vm-ui 结构契约;shadow DOM 由 Playwright
 * CSS 自动穿透),不依赖文案排版(文案断言仅锚定正式下发语料的独特标记串,
 * 用于证明「数据来自正式通道」)。
 */
import { randomBytes } from "node:crypto";

import type { Page } from "@playwright/test";

import { createSessionViaForm, closeSessionBestEffort, expect, menu, test } from "./fixtures.js";
import { seedFormalChallenge } from "./helpers/seed-formal-challenge.mjs";

/** 正式通道页面路径(题目上下文进 URL 查询参数;非会话标识,公开定位符)。 */
function formalPath(challengeId: string): string {
  return `/?descriptor=formal&challengeId=${challengeId}&challengeVersion=1.0.0`;
}

/** 打开教学面板(details 折叠区;内容锚在打开后可见)。 */
async function openTeachingPanel(page: Page): Promise<void> {
  const summary = page.locator("sm-workspace .teaching-panel summary");
  await summary.click();
}

test.describe("M2 正式下发通道(compose 全拓扑 + plugin-dev 壳)", () => {
  test("正式下发数据驱动静态面 + 提示阶梯 + debugMode 门控全链路", async ({ page }) => {
    // 每用例唯一题目上下文(隔离纪律同 fixtures.ts)。
    const tenantId = `e2e-wp54-${randomBytes(4).toString("hex")}`;
    const challengeId = `chal-wp54-${randomBytes(5).toString("hex")}`;
    const sessionId = await createSessionViaForm(page, {
      path: formalPath(challengeId),
      challengeId,
      tenantId,
      registerChallenge: (ctx) => seedFormalChallenge(ctx),
    });

    // 1. 静态面:loaded 状态 + briefing 标题(正式下发语料的独特标记串)。
    const panel = page.locator("sm-workspace .challenge-panel");
    await expect(panel).toHaveAttribute("data-descriptor-status", "loaded");
    await expect(page.locator("sm-workspace .challenge-title")).toHaveText(
      "WP-54 正式下发通道 E2E 题(占位数据)",
    );
    await expect(page.locator("sm-workspace .challenge-summary")).toContainText("descriptor 端点正式下发");

    // 2. VM Profile 事实表:archBits 32 / 寄存器白名单 / canary 未启用。
    const facts = page.locator("sm-workspace .challenge-facts");
    await expect(facts).toContainText("RSP, RBP, RIP, RAX");
    await expect(facts).toContainText("未启用"); // canary.enabled = false

    // 3. encodingTable 最小渲染(存在才渲染):tokenHex / op 行。
    const encodingRows = page.locator("sm-workspace .encoding-table tbody tr");
    await expect(encodingRows).toHaveCount(3);
    await expect(encodingRows.first()).toContainText("0x00");

    // 4. debugMode 门控:正式下发 debugMode=true → 菜单呈现模式切换项。
    await expect(menu(page).locator("button.mode-toggle-button")).toBeVisible();

    // 5. 提示阶梯(FE-ED-06):after_n_failures 锁定文案(threshold 来自
    //    正式下发数据)+ on_request 逐级揭示(点击后正式提示文案出现)。
    await openTeachingPanel(page);
    await expect(page.locator("sm-hint-ladder .locked").filter({ hasText: "再失败 2 次解锁" })).toBeVisible();
    await page.locator("sm-hint-ladder button.reveal-button").click();
    await expect(page.locator("sm-hint-ladder .hint-text").first()).toContainText(
      "E2E 正式通道提示一:打开栈视图观察 rip 停靠窗口。",
    );

    // 会话回收(卫生措施;租户隔离已兜底预算)。
    if (sessionId !== null) {
      await closeSessionBestEffort(page, sessionId);
    }
  });

  test("动作拒绝的错误解释由正式下发 teachingNote 驱动(FE-ED-07)", async ({ page }) => {
    const tenantId = `e2e-wp54-${randomBytes(4).toString("hex")}`;
    const challengeId = `chal-wp54-${randomBytes(5).toString("hex")}`;
    const sessionId = await createSessionViaForm(page, {
      path: formalPath(challengeId),
      challengeId,
      tenantId,
      registerChallenge: (ctx) => seedFormalChallenge(ctx),
    });
    await openTeachingPanel(page);

    // 触发一次确定性拒绝:write_bytes 落在未映射地址(I-9 统一拒绝形态,
    // code = inaccessible_address——正式下发 publicErrorMapping 已收录)。
    // 经工作区组合根的会话客户端提交(真实认证 WSS 链路;拒绝事件回流
    // #lastError → sm-error-explainer 按 errorCode 匹配正式下发注解)。
    await page.evaluate(() => {
      const workspace = document.querySelector("sm-workspace") as {
        client?: { sendAction(action: { type: string; args: Record<string, string> }): void };
      };
      if (workspace?.client === undefined) {
        throw new Error("会话客户端未装配");
      }
      workspace.client.sendAction({
        type: "write_bytes",
        args: { addressHex: "0xdead0000", bytesHex: "90" },
      });
    });
    const teachingNote = page.locator("sm-error-explainer .teaching-note");
    await expect(teachingNote).toContainText("E2E 正式通道注解:目标地址不在任何可见区域(I-9)。");
    // 错误码徽标 = 拒绝的协议码(与注解匹配键同源)。
    await expect(page.locator("sm-error-explainer .code-badge")).toHaveText("inaccessible_address");

    if (sessionId !== null) {
      await closeSessionBestEffort(page, sessionId);
    }
  });

  test("未登记题目:正式通道 404 → 缺席明示(确定性失败态)", async ({ page }) => {
    // 无 seed(题目未登记):descriptor 端点 404(服务端同形拒绝)→ 加载器
    // 确定性失败 → 工作区缺席明示面板(不建会话即可断言,零内部透出)。
    await page.goto(formalPath(`chal-wp54-absent-${randomBytes(4).toString("hex")}`));
    await page.waitForFunction(() => customElements.get("sm-workspace") !== undefined);
    const panel = page.locator("sm-workspace .challenge-panel");
    await expect(panel).toHaveAttribute("data-descriptor-status", "absent");
    await expect(page.locator("sm-workspace .challenge-absent")).toContainText("题目描述包未成功加载");
    // 缺席明示 ≠ 静默:原因码 / URL 不进 DOM(失败细节零透出)。
    await expect(page.locator("sm-workspace .challenge-absent")).not.toContainText("not-found");
    await expect(page.locator("sm-workspace .challenge-panel")).not.toContainText("chal-wp54-absent");
  });
});

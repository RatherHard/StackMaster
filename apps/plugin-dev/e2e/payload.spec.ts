/**
 * E2E 场景 ④(WP-F7 附加冒烟,视稳定性保留):payload 搭建页打开冒烟。
 *
 * 并行 WP-F8 正在演进调试模式档 UI,本用例只锚定注册表契约级稳定面:
 * 菜单「打开 → Payload 搭建」(data-tab-type="payload")→ 三区结构
 * (积木画布 / 程序原子步骤 / 执行输出,aria-label 语义化 DOM 契约)出现。
 * 积木编译与步进执行的组件级行为由 vm-ui 自身测试覆盖,不在本冒烟展开。
 */
import { expect, openTabButton, test } from "./fixtures.js";

test.describe("payload 搭建页冒烟(WP-F6 交付面)", () => {
  test("④菜单打开 Payload 搭建 → 三区结构呈现", async ({ createdSession }) => {
    const page = createdSession;
    await openTabButton(page, "payload").click();

    // 三区布局(FE-PB-01):画布(light DOM 挂载)/ 程序区 / 输出区。
    const payloadTab = page.locator("sm-payload-tab");
    await expect(payloadTab).toBeVisible();
    await expect(payloadTab.locator("[aria-label=\"积木画布\"]")).toBeVisible();
    await expect(payloadTab.locator("[aria-label=\"程序原子步骤\"]")).toBeVisible();
    await expect(payloadTab.locator("[aria-label=\"执行输出\"]")).toBeVisible();
  });
});

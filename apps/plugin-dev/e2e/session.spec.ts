/**
 * E2E 场景(任务分解 ①创建会话/投影渲染 + ②指令步进;阶段退出条件 1/2 的
 * 浏览器面)。
 *
 * 已知缺陷登记(2026-09-11 实测):`<sm-byte-view>` 的 lit-virtualizer 在真实
 * Chromium 下不渲染字节行(virtualizer core 收到 32 条 items、宿主被设置
 * min-height:3200px,但 rangeChanged 事件从不派发 → 零行;等待 / 滚动均无效)。
 * jsdom 组件测试因几何桩(getBoundingClientRect 恒定值)无法暴露该缺陷。
 * 字节行断言作为验收锚保留(「栈视图字节行渲染」用例);公开投影在真实浏览器
 * 的渲染证据另由寄存器视图(非虚拟化路径)用例承载。诊断与复跑见 README「E2E」。
 *
 * 选择器锚 = 结构化属性与 role(表单 input[name]、菜单 data-tab-type / class、
 * 语义化 role),不依赖文案排版。
 */
import {
  byteRows,
  expect,
  menuButton,
  menuStatus,
  openTabButton,
  test,
} from "./fixtures.js";

test.describe("解题模式档最小集(compose 全拓扑 + plugin-dev 壳)", () => {
  test("创建会话:表单提交 → 会话建立 → 菜单呈现 running / revision 0 / connected", async ({
    createdSession,
  }) => {
    const page = createdSession;

    // 会话已建立:菜单状态面呈现真实 create_session 结果(Cookie 交付 + WSS
    // 升级即认证;初始投影 revision 0,status = running)。
    await expect(menuStatus(page, "session-status")).toHaveText("running");
    await expect(menuStatus(page, "revision")).toHaveText("0");
    await expect(menuStatus(page, "connection-status")).toHaveText("connected");
  });

  test("投影渲染(寄存器视图):公开投影寄存器行呈现(非虚拟化路径)", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await openTabButton(page, "registers").click();

    // 寄存器视图:纵向全量白名单寄存器行(M14 不留占位);初始投影
    // RSP = 0x7FFFF008(生命周期教学题合成占位,与 seed 脚本同源)。
    const registerRows = page.locator("sm-register-view [role=\"row\"], sm-register-view tbody tr");
    await expect(registerRows.first()).toBeVisible();
    await expect(page.locator("sm-register-view")).toContainText("RSP");
    await expect(page.locator("sm-register-view")).toContainText("0x7FFFF008");
  });

  test("投影渲染(栈视图):sm-byte-view 字节行出现(虚拟列表;验收锚,登记缺陷)", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await openTabButton(page, "stack").click();

    // 打开即有区域(初始投影 visibleRegions 直读):区域选择器呈现。
    await expect(page.locator("sm-byte-view .region-select")).toBeVisible();

    // 字节行断言(验收锚):虚拟列表出现携带 data-row-address 的数据行。
    // 当前因 vm-ui 虚拟化真实浏览器缺陷红灯(见文件头登记),修复后即绿。
    const rows = byteRows(page);
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(1);
  });

  test("指令步进:菜单 step → 认证 WSS 动作 → 投影 revision 前进", async ({
    createdSession,
  }) => {
    const page = createdSession;

    // 菜单动作对真实会话生效(退出条件 2):动作走认证 WSS 提交,响应增量
    // 回流推进 revision(恰执行一条指令后暂停;初始 0 → 步进后 1)。
    await expect(menuStatus(page, "revision")).toHaveText("0");
    await menuButton(page, "step-button").click();
    await expect(menuStatus(page, "revision")).toHaveText("1");

    // 会话仍在线(非终态、连接未断)。
    await expect(menuStatus(page, "connection-status")).toHaveText("connected");
  });
});

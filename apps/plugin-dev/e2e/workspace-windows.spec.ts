/**
 * E2E 场景 ⑤:固定视图集工作区(D-MP-1;**2026-09-18 整页布局改版重写**)。
 *
 * 门禁面(完成标准逐条落地):
 *  - **全部视图类型常驻**:视图集 = 注册表登记集合(各类型**恰一实例**、无重无漏);
 *    「暂离」= 滚出可视区(**第一种成因**)或未勾选(**第二种成因**,D-API-153);
 *  - **payload 固定于右半侧**:左半侧渲染其余九类,右半侧承载 payload 内容元素
 *    (同一实例);
 *  - **无任何关闭入口**:视图位无关闭按钮 / 无关闭语义 aria;公共 API 面无
 *    `closeTab` / `openTab`(组件面由 vm-ui 单测机检,此处锚定 DOM 面);
 *  - **模式切换布局不动**:解题 ↔ 调试切换前后视图集与焦点不动(只换绑数据源)。
 *
 * 选择器锚 = 结构属性(菜单 `data-window-type` / 视图位 `data-view-panel`,
 * 视图 id ≡ 类型键),不依赖文案排版与像素几何。
 */
import {
  expect,
  focusWindowButton,
  rightRole,
  test,
  viewListButton,
  viewListCheckbox,
  workspaceWindow,
  workspaceWindows,
  workspaceWindowTypes,
} from "./fixtures.js";

/** 注册表登记类型集(vm-ui `createDefaultTabTypeRegistry()`)。 */
const REGISTERED_VIEW_TYPES = [
  "stack",
  "free",
  "registers",
  "payload",
  "debug",
  "structure",
  "call-stack",
  "memory-diff",
  "timeline",
  "checkpoints",
] as const;

/** 左半侧呈现序(=「重置视图」的默认顺序,payload 固定右半侧故不在其中)。 */
const LEFT_PRESENTATION_ORDER = [
  "stack",
  "registers",
  "debug",
  "free",
  "call-stack",
  "structure",
  "timeline",
  "checkpoints",
  "memory-diff",
] as const;

/** 视图类型名文案(注册表 label;无类型内序号)。 */
const VIEW_TITLES: Record<string, string> = {
  stack: "栈视图",
  free: "自由视图",
  registers: "寄存器视图",
  payload: "Payload 搭建",
  debug: "指令视图",
  structure: "结构视图",
  "call-stack": "调用栈",
  "memory-diff": "内存 diff",
  timeline: "时间线",
  checkpoints: "checkpoint",
};

test.describe("固定视图集(D-MP-1:全部常驻、各恰一实例、无关闭;整页布局改版)", () => {
  test("全部视图类型常驻、各类型唯一、无任何关闭入口", async ({ createdSession }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });

    // ① 左半侧视图集 ≡ 登记集合 − payload(各恰一实例;无重无漏)。
    const types = await workspaceWindowTypes(page);
    expect([...types].sort()).toEqual(
      [...REGISTERED_VIEW_TYPES].filter((type) => type !== "payload").sort(),
    );
    expect(types).toEqual([...LEFT_PRESENTATION_ORDER]);
    expect(new Set(types).size).toBe(LEFT_PRESENTATION_ORDER.length);
    await expect(workspaceWindows(page)).toHaveCount(LEFT_PRESENTATION_ORDER.length);

    // ② 每个视图位常驻呈现:类型名写在**视图内左上角**(无独立标题栏),
    //    面板地标名 = 视图名(D-UI-7 ①:地标名不因标题栏消失而改变)。
    for (const viewType of LEFT_PRESENTATION_ORDER) {
      const panel = workspaceWindow(page, viewType);
      await expect(panel).toHaveCount(1);
      await expect(panel.locator(".view-label")).toHaveText(VIEW_TITLES[viewType] ?? "");
      await expect(panel).toHaveAttribute("aria-label", VIEW_TITLES[viewType] ?? "");
      // 原标题栏整条退场(无 `.tab-bar` / 无 `.tab-title`)。
      await expect(panel.locator(".tab-bar")).toHaveCount(0);
      await expect(panel.locator(".tab-title")).toHaveCount(0);
    }

    // ③ 右半侧 = payload 搭建窗口(内容元素唯一归属)。
    await expect(rightRole(page)).toHaveAttribute("aria-label", VIEW_TITLES.payload ?? "");
    await expect(rightRole(page).locator("sm-payload-tab-host")).toHaveCount(1);

    // ④ 无任何关闭入口:无关闭按钮(class / 视图位内按钮)与关闭语义 aria。
    await expect(page.locator("sm-workspace .tab-close")).toHaveCount(0);
    await expect(page.locator("sm-workspace .ws-view button")).toHaveCount(0);
    const closeSemantics = await page.locator("sm-workspace").evaluate((element) =>
      [...element.shadowRoot!.querySelectorAll("[aria-label], [title], [data-close], [data-view-close]")]
        .flatMap((node) => [
          node.getAttribute("aria-label") ?? "",
          node.getAttribute("title") ?? "",
          node.getAttribute("data-close") ?? "",
          node.getAttribute("data-view-close") ?? "",
        ])
        .filter((label) => /关闭|(^|\W)close(\W|$)/i.test(label)),
    );
    expect(closeSemantics).toEqual([]);

    // ⑤ 无空态引导(视图集恒非空;锚定工作区自身的渲染面)。
    const ownEmptyStates = await page
      .locator("sm-workspace")
      .evaluate((element) => element.shadowRoot!.querySelectorAll(".empty").length);
    expect(ownEmptyStates).toBe(0);
  });

  test("视图导航:聚焦入口气回收滚出视野的视图位;aria-pressed 单点表达焦点", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });
    const lastViewType = LEFT_PRESENTATION_ORDER[LEFT_PRESENTATION_ORDER.length - 1] as string;
    const lastButton = focusWindowButton(page, lastViewType);

    // 聚焦导航恒可用(无禁用态)。
    await expect(lastButton).toBeEnabled();
    await expect(lastButton).toHaveAttribute("aria-pressed", "false");

    await lastButton.click();
    await expect(lastButton).toHaveAttribute("aria-pressed", "true");
    // 恰一个入口为按下态(焦点唯一)。
    await expect(
      page.locator('sm-workspace-menu button.focus-window[aria-pressed="true"]'),
    ).toHaveCount(1);

    // 「暂离(滚出可视区)」的视图位经聚焦滚动回收进左半侧可视区(可达性底线)。
    await expect(workspaceWindow(page, lastViewType)).toBeInViewport();
    await expect(workspaceWindow(page, lastViewType)).toHaveClass(/focused/);

    // 聚焦不是开窗:视图集不变(实例数恒定)。
    expect(await workspaceWindowTypes(page)).toEqual([...LEFT_PRESENTATION_ORDER]);

    // 聚焦另一视图 → aria-pressed 单点跟随。
    const firstViewType = LEFT_PRESENTATION_ORDER[0] as string;
    await focusWindowButton(page, firstViewType).click();
    await expect(focusWindowButton(page, firstViewType)).toHaveAttribute("aria-pressed", "true");
    await expect(lastButton).toHaveAttribute("aria-pressed", "false");
    await expect(workspaceWindow(page, firstViewType)).toBeInViewport();
  });

  test("「暂离」的第二种成因(未勾选):只影响显示,视图仍常驻(无开 / 关语义)", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });
    const total = LEFT_PRESENTATION_ORDER.length;

    await viewListButton(page).click();
    await viewListCheckbox(page, "timeline").uncheck();
    // 不显示 = 暂离(不是关闭):面板消失但视图集成员不变。
    await expect(workspaceWindow(page, "timeline")).toHaveCount(0);
    await expect(workspaceWindows(page)).toHaveCount(total - 1);
    await expect(viewListCheckbox(page, "timeline")).not.toBeChecked();

    // 重新勾选即回到可视区(仍只改显示)。
    await viewListCheckbox(page, "timeline").check();
    await expect(workspaceWindows(page)).toHaveCount(total);
    await expect(workspaceWindow(page, "timeline")).toHaveCount(1);
  });

  test("解题 ↔ 调试模式切换只换绑数据源:视图集与焦点不动(布局零副作用)", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });
    // 开发壳夹具描述包 debugMode=true → 模式切换项可见(plugin-dev 缺省通道)。
    const modeToggle = page.locator("sm-workspace-menu button.mode-toggle-button");
    await expect(modeToggle).toBeVisible();

    await focusWindowButton(page, "structure").click();
    const before = await workspaceWindowTypes(page);
    await expect(workspaceWindow(page, "structure")).toHaveClass(/focused/);

    await modeToggle.click();
    await expect(page.locator("sm-workspace-menu .mode-indicator")).toHaveText("调试模式");
    expect(await workspaceWindowTypes(page)).toEqual(before);
    await expect(workspaceWindow(page, "structure")).toHaveClass(/focused/);

    await modeToggle.click();
    await expect(page.locator("sm-workspace-menu .mode-indicator")).toHaveText("解题模式");
    expect(await workspaceWindowTypes(page)).toEqual(before);
    await expect(workspaceWindow(page, "structure")).toHaveClass(/focused/);
    // 视图集不变量:模式切换后仍各恰一实例。
    expect(new Set(await workspaceWindowTypes(page)).size).toBe(LEFT_PRESENTATION_ORDER.length);
  });
});

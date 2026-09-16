/**
 * E2E 场景 ⑤:固定窗口工作区(WP-71 / D-MP-1)。
 *
 * 门禁面(完成标准逐条落地):
 *  - **全部窗口类型常驻**:窗口集 = 注册表登记集合(登记序),各类型**恰一
 *    实例**(无重无漏);「暂离」= 条带滚出视野,聚焦入口可滚动回收视口内;
 *  - **无任何关闭入口**:窗口标题栏无按钮、工作区内无关闭语义 aria、
 *    公共 API 面无 closeTab / openTab(组件面由 vm-ui 单测机检,此处锚定
 *    DOM 面);
 *  - **模式切换布局不动**:解题 ↔ 调试切换前后窗口集与焦点列不动(只换绑
 *    数据源)。
 *
 * 选择器锚 = 结构属性(菜单 `data-window-type` / 窗口面板 `data-tab-id`,
 * 窗口 id ≡ 类型键),不依赖文案排版与像素几何。
 */
import {
  expect,
  focusWindowButton,
  test,
  workspaceWindow,
  workspaceWindows,
  workspaceWindowTypes,
} from "./fixtures.js";

/**
 * 注册表登记类型集(登记序权威来源 = vm-ui `createDefaultTabTypeRegistry()`;
 * vm-ui `test/workspace/tab-registry.test.ts` 固定同序,漂移即双面红灯)。
 */
const REGISTERED_WINDOW_TYPES = [
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

/** 窗口标题文案(注册表 label;无类型内序号)。 */
const WINDOW_TITLES: Record<string, string> = {
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

test.describe("固定窗口集(WP-71 / D-MP-1:全部常驻、各恰一实例、无关闭)", () => {
  test("全部窗口类型常驻可见、各类型唯一、无任何关闭入口", async ({ createdSession }) => {
    const page = createdSession;

    // ① 窗口集 ≡ 注册表登记集合(登记序),各类型恰一实例(无重无漏)。
    const types = await workspaceWindowTypes(page);
    expect(types).toEqual([...REGISTERED_WINDOW_TYPES]);
    expect(new Set(types).size).toBe(REGISTERED_WINDOW_TYPES.length);
    await expect(workspaceWindows(page)).toHaveCount(REGISTERED_WINDOW_TYPES.length);

    // ② 每个窗口面板常驻呈现(标题 = 注册表展示名;无「类型名 + 序号」)。
    for (const windowType of REGISTERED_WINDOW_TYPES) {
      const panel = workspaceWindow(page, windowType);
      await expect(panel).toHaveCount(1);
      await expect(panel.locator(".tab-title")).toHaveText(WINDOW_TITLES[windowType] ?? "");
      await expect(panel).toHaveAttribute("aria-label", WINDOW_TITLES[windowType] ?? "");
    }

    // ③ 无任何关闭入口:无关闭按钮(class / 标题栏按钮)与关闭语义 aria。
    await expect(page.locator("sm-workspace .tab-close")).toHaveCount(0);
    await expect(page.locator("sm-workspace .tab-bar button")).toHaveCount(0);
    const closeSemantics = await page.locator("sm-workspace").evaluate((element) =>
      [...element.shadowRoot!.querySelectorAll("[aria-label], [title], [data-close], [data-tab-close]")]
        .flatMap((node) => [
          node.getAttribute("aria-label") ?? "",
          node.getAttribute("title") ?? "",
          node.getAttribute("data-close") ?? "",
          node.getAttribute("data-tab-close") ?? "",
        ])
        .filter((label) => /关闭|(^|\W)close(\W|$)/i.test(label)),
    );
    expect(closeSemantics).toEqual([]);

    // ④ 无空态引导(窗口集恒非空;空态文案已从 i18n 双目录退场)。锚定
    // **工作区自身**的渲染面:内容组件(寄存器 / 时间线等)各自的空态
    // class 属其内部面,不在本断言范围。
    const ownEmptyStates = await page
      .locator("sm-workspace")
      .evaluate((element) => element.shadowRoot!.querySelectorAll(".empty").length);
    expect(ownEmptyStates).toBe(0);
  });

  test("窗口聚焦入口:点击聚焦 + 滚出视野的窗口回收进视口;aria-pressed 表达当前焦点", async ({
    createdSession,
  }) => {
    const page = createdSession;
    const lastWindowType = REGISTERED_WINDOW_TYPES[REGISTERED_WINDOW_TYPES.length - 1] as string;
    const lastButton = focusWindowButton(page, lastWindowType);

    // 聚焦导航恒可用(无禁用态)。
    await expect(lastButton).toBeEnabled();
    await expect(lastButton).toHaveAttribute("aria-pressed", "false");

    await lastButton.click();
    await expect(lastButton).toHaveAttribute("aria-pressed", "true");
    // 恰一个入口为按下态(焦点唯一)。
    const pressed = page.locator("sm-workspace-menu button.focus-window[aria-pressed=\"true\"]");
    await expect(pressed).toHaveCount(1);

    // 「暂离(条带滚出视野)」的窗口经聚焦滚动回收视口内(可达性底线)。
    await expect(workspaceWindow(page, lastWindowType)).toBeInViewport();
    await expect(workspaceWindow(page, lastWindowType)).toHaveClass(/focused/);

    // 聚焦不是开窗:窗口集不变(实例数恒定)。
    expect(await workspaceWindowTypes(page)).toEqual([...REGISTERED_WINDOW_TYPES]);

    // 聚焦另一窗口 → aria-pressed 单点跟随。
    const firstWindowType = REGISTERED_WINDOW_TYPES[0] as string;
    await focusWindowButton(page, firstWindowType).click();
    await expect(focusWindowButton(page, firstWindowType)).toHaveAttribute("aria-pressed", "true");
    await expect(lastButton).toHaveAttribute("aria-pressed", "false");
    await expect(workspaceWindow(page, firstWindowType)).toBeInViewport();
  });

  test("解题 ↔ 调试模式切换只换绑数据源:窗口集与焦点列不动(布局零副作用)", async ({
    createdSession,
  }) => {
    const page = createdSession;
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
    // 窗口集不变量:模式切换后仍各恰一实例。
    expect(new Set(await workspaceWindowTypes(page)).size).toBe(REGISTERED_WINDOW_TYPES.length);
  });
});

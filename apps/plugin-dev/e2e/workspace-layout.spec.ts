/**
 * E2E 场景 ⑥:工作区 Niri 式布局交互(WP-72 / 中期计划 §2.2 交互设计 1~8)。
 *
 * 门禁面(完成标准逐条落地,全部真机 chromium):
 *  - **默认预设 P0**:宽屏 5 列逐列分组(列 1 = 栈视图 + 寄存器视图 …);
 *  - **列宽可调**:列间分隔条真实鼠标拖拽 + 菜单列宽预设档(1/4、1/3、1/2、
 *    2/3、全宽),调整在会话内保持(模式切换 / 聚焦导航后不回退);
 *  - **列宽最小护栏生效**:任何调整后列宽像素 ≥ `MIN_COLUMN_WIDTH`(十六进制行
 *    不折行的最小可读宽度);
 *  - **窗高可调**:同列窗间分隔条拖拽改变两窗高度,和守恒,会话内保持;
 *  - **三类落点**:同列堆叠 / 跨列移动 / 列间空隙新建列位;
 *  - **焦点列居中滚动**:聚焦远端列 → 相机把该列滚入视口并居中;滚到远端后
 *    窗口仍可交互,切回时字节窗口照常渲染(视口外降级渲染的可逆性);
 *  - **响应式降级**:中宽 P1(3 列合并)/ 窄条 P2(单列纵向 + 窗口切换条),
 *    宽度回宽屏即回 P0;
 *  - **重置布局**:清空列宽 / 窗高调整并回到当前宽度档预设;
 *  - **渲染负担观测**:窗口数 × 工作区 shadow 节点数 × 交互 RTT(风险表
 *    「全窗口常驻」行的可复跑证据;观测值经 testInfo 附注与 stdout 记录)。
 *
 * 选择器锚 = 结构属性(`data-column-index` / `data-column-divider` /
 * `data-row-divider` / `data-width-ratio` / `data-layout-preset` / `data-tab-id`),
 * 不依赖文案排版与像素几何;唯一例外是列宽护栏与列宽档的像素断言(观测目标本身)。
 */
import {
  columnDivider,
  dragBy,
  dragWindowTo,
  expect,
  focusWindowButton,
  layoutColumn,
  layoutColumnGroups,
  layoutColumnWidthPx,
  layoutColumns,
  layoutPresetBadge,
  layoutStatus,
  layoutStrip,
  resetLayoutButton,
  rowDivider,
  test,
  waitForCameraSettled,
  widthPresetButton,
  workspaceWindow,
  workspaceWindows,
  byteRows,
} from "./fixtures.js";

/** 注册表登记类型集(WP-71 权威序;本用例集只做集合断言)。 */
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

/** P0(宽屏 5 列;vm-ui `layout-presets.ts` 的规范单一来源)。 */
const P0_COLUMNS: readonly (readonly string[])[] = [
  ["stack", "registers"],
  ["debug", "free"],
  ["payload"],
  ["call-stack", "structure"],
  ["timeline", "checkpoints", "memory-diff"],
];

/** P1(中宽 3 列预设合并)。 */
const P1_COLUMNS: readonly (readonly string[])[] = [
  ["stack", "registers", "free"],
  ["debug", "structure", "call-stack"],
  ["payload", "timeline", "checkpoints", "memory-diff"],
];

/**
 * 列宽最小护栏(px):vm-ui `MIN_COLUMN_WIDTH` = 58ch × 7.8px = 452.4
 * (推导式与机检位置:`packages/vm-ui/src/workspace/layout-presets.ts` +
 * `test/workspace/layout-presets.test.ts`)。E2E 为黑箱面:**此处以字面量登记**
 * (产物 dist 无独立 JS 模块可导入;漂移由 vm-ui 单测与下面的列宽断言双向暴露)。
 */
const MIN_COLUMN_WIDTH = 452.4;

/** 视口宽 → 工作区宽度(开发壳 `max-inline-size: 78rem` + `padding: 1rem`)。 */
function expectedWorkspaceWidth(viewportWidth: number): number {
  return Math.min(viewportWidth, 78 * 16 + 2 * 16) - 2 * 16;
}

test.describe("工作区布局交互(WP-72:Niri 式列条带 / 尺寸可调 / 响应式)", () => {
  test("默认预设 P0:5 列逐列分组 + 列宽最小护栏生效 + 视口外降级渲染标记", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });

    await expect(layoutPresetBadge(page)).toHaveText("P0");
    expect(await layoutColumnGroups(page)).toEqual(P0_COLUMNS.map((column) => [...column]));
    await expect(layoutColumns(page)).toHaveCount(5);

    // 列宽最小护栏:每列像素宽 ≥ MIN_COLUMN_WIDTH(十六进制行不折行)。
    const widths = await layoutColumnWidthPx(page);
    expect(widths).toHaveLength(5);
    for (const width of widths) {
      expect(width).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH - 1);
    }

    // 视口外降级渲染:每个窗口面板声明 content-visibility: auto + 语义标记
    // (离屏窗口子树跳过渲染;payload / 指令视图等重窗口成本随之后移)。
    await expect(workspaceWindows(page)).toHaveCount(REGISTERED_WINDOW_TYPES.length);
    for (const windowType of REGISTERED_WINDOW_TYPES) {
      const panel = workspaceWindow(page, windowType);
      await expect(panel).toHaveAttribute("data-render-degrade", "content-visibility");
      expect(
        await panel.evaluate((element) => getComputedStyle(element).contentVisibility),
      ).toBe("auto");
    }

    // 列宽与窗高可选:分隔条为可聚焦的 role=separator(键盘可达)。
    await expect(columnDivider(page, 1)).toHaveAttribute("role", "separator");
    await expect(columnDivider(page, 1)).toHaveAttribute("tabindex", "0");
    await expect(rowDivider(page, 0, 0)).toHaveAttribute("aria-orientation", "horizontal");
  });

  test("列宽可调:分隔条拖拽 + 预设档,调整在会话内保持(模式切换 / 聚焦导航不回退)", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });
    const before = (await layoutColumnWidthPx(page))[0] as number;

    // ① 列间分隔条真实拖拽:右侧位移 +80px ⇒ 左列宽 +80(右列宽度自持)。
    await dragBy(page, columnDivider(page, 1), 80, 0);
    await expect(layoutStatus(page)).not.toHaveText("");
    const dragged = (await layoutColumnWidthPx(page))[0] as number;
    expect(dragged).toBeGreaterThan(before + 60);
    expect(dragged).toBeLessThan(before + 100);
    // 右侧列宽不受影响(边界平移语义)。
    expect((await layoutColumnWidthPx(page))[1] as number).toBeGreaterThanOrEqual(
      MIN_COLUMN_WIDTH - 1,
    );

    // ② 预设档:焦点列(列 1)设为 1/2 视口宽。
    await widthPresetButton(page, "0.5").click();
    await expect(layoutStatus(page)).not.toHaveText("");
    const halfWidth = expectedWorkspaceWidth(1440) / 2;
    await expect
      .poll(async () => (await layoutColumnWidthPx(page))[0] as number, { timeout: 5_000 })
      .toBeGreaterThan(halfWidth - 4);
    expect((await layoutColumnWidthPx(page))[0] as number).toBeLessThan(halfWidth + 4);

    // ③ 全宽档:焦点列 = 容器全宽。
    await widthPresetButton(page, "1").click();
    await expect
      .poll(async () => (await layoutColumnWidthPx(page))[0] as number, { timeout: 5_000 })
      .toBeGreaterThan(expectedWorkspaceWidth(1440) - 4);

    // ④ 会话内保持:模式切换(只换数据源)+ 聚焦远端窗口,列宽不回退。
    await page.locator("sm-workspace-menu button.mode-toggle-button").click();
    await expect(page.locator("sm-workspace-menu .mode-indicator")).toHaveText("调试模式");
    await page.locator("sm-workspace-menu button.mode-toggle-button").click();
    await focusWindowButton(page, "checkpoints").click();
    await focusWindowButton(page, "stack").click();
    await waitForCameraSettled(page);

    const kept = (await layoutColumnWidthPx(page))[0] as number;
    expect(kept).toBeGreaterThan(expectedWorkspaceWidth(1440) - 4);
  });

  test("窗高可调:同列窗间分隔条拖拽改变两窗高度,和守恒且会话内保持", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });
    const stackPanel = workspaceWindow(page, "stack");
    const registersPanel = workspaceWindow(page, "registers");
    const stackBefore = (await stackPanel.boundingBox())?.height ?? 0;
    const registersBefore = (await registersPanel.boundingBox())?.height ?? 0;

    await dragBy(page, rowDivider(page, 0, 0), 0, 60);
    await expect(layoutStatus(page)).not.toHaveText("");

    const stackAfter = (await stackPanel.boundingBox())?.height ?? 0;
    const registersAfter = (await registersPanel.boundingBox())?.height ?? 0;
    expect(stackAfter).toBeGreaterThan(stackBefore + 40);
    expect(registersAfter).toBeLessThan(registersBefore - 40);
    // 和守恒(两窗比例之和恒为 1 ⇒ 两窗高度之和恒定)。
    expect(stackAfter + registersAfter).toBeCloseTo(stackBefore + registersBefore, 0);

    // 会话内保持:切模式后窗高不回退。
    await page.locator("sm-workspace-menu button.mode-toggle-button").click();
    await expect(page.locator("sm-workspace-menu .mode-indicator")).toHaveText("调试模式");
    expect((await stackPanel.boundingBox())?.height ?? 0).toBeCloseTo(stackAfter, 0);
    await page.locator("sm-workspace-menu button.mode-toggle-button").click();
    await expect(page.locator("sm-workspace-menu .mode-indicator")).toHaveText("解题模式");
    expect((await stackPanel.boundingBox())?.height ?? 0).toBeCloseTo(stackAfter, 0);
  });

  test("三类拖拽落点:同列堆叠 / 跨列移动 / 列间空隙新建列位", async ({ createdSession }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(await layoutColumnGroups(page)).toEqual(P0_COLUMNS.map((column) => [...column]));

    // ① 同列堆叠:栈视图拖到同列「寄存器视图」下半 → 插到其后。
    await dragWindowTo(page, workspaceWindow(page, "stack"), workspaceWindow(page, "registers"), "lower");
    await expect
      .poll(async () => await layoutColumnGroups(page), { timeout: 5_000 })
      .toEqual([["registers", "stack"], ...P0_COLUMNS.slice(1).map((column) => [...column])]);

    // ② 跨列移动:栈视图拖到列 2「自由视图」上半 → 该列内插到 debug 与 free 之间。
    await dragWindowTo(page, workspaceWindow(page, "stack"), workspaceWindow(page, "free"), "upper");
    await expect
      .poll(async () => await layoutColumnGroups(page), { timeout: 5_000 })
      .toEqual([
        ["registers"],
        ["debug", "stack", "free"],
        ...P0_COLUMNS.slice(2).map((column) => [...column]),
      ]);
    await expect(layoutColumns(page)).toHaveCount(5);

    // ③ 列间空隙新建列位:栈视图拖到列 2 与列 3 之间的空隙(该空隙在相机居中
    //    「列 2」后的可视区内;空隙索引 = 其右侧列序)⇒ 在该列序位置插为新列。
    await dragWindowTo(page, workspaceWindow(page, "stack"), columnDivider(page, 2), "upper");
    await expect
      .poll(async () => await layoutColumnGroups(page), { timeout: 5_000 })
      .toEqual([
        ["registers"],
        ["debug", "free"],
        ["stack"],
        ["payload"],
        ["call-stack", "structure"],
        ["timeline", "checkpoints", "memory-diff"],
      ]);
    await expect(layoutColumns(page)).toHaveCount(6);

    // 窗口集不变量:三类落点全程无重无漏。
    const groups = await layoutColumnGroups(page);
    const flat = groups.flat();
    expect([...flat].sort()).toEqual([...REGISTERED_WINDOW_TYPES].sort());
    expect(new Set(flat).size).toBe(REGISTERED_WINDOW_TYPES.length);
  });

  test("焦点列居中滚动:聚焦远端列滚入视口并居中;远端窗口仍可交互、切回后照常渲染", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });
    await waitForCameraSettled(page);

    // ① 聚焦中间列(payload)→ 相机居中(列中心 ≈ 条带中心,容差 8px)。
    await focusWindowButton(page, "payload").click();
    await waitForCameraSettled(page);
    const stripBox = (await layoutStrip(page).boundingBox()) as { x: number; width: number };
    const payloadBox = (await layoutColumn(page, 2).boundingBox()) as { x: number; width: number };
    const centerDelta = Math.abs(
      payloadBox.x + payloadBox.width / 2 - (stripBox.x + stripBox.width / 2),
    );
    expect(centerDelta).toBeLessThanOrEqual(8);

    // ② 聚焦远端列(checkpoints)→ 该列完整滚入视口(通栏可达)。
    await focusWindowButton(page, "checkpoints").click();
    await waitForCameraSettled(page);
    await expect(workspaceWindow(page, "checkpoints")).toBeInViewport();
    const farColumnBox = (await layoutColumn(page, 4).boundingBox()) as { x: number; width: number };
    expect(farColumnBox.x).toBeGreaterThanOrEqual(stripBox.x - 1);
    expect(farColumnBox.x + farColumnBox.width).toBeLessThanOrEqual(stripBox.x + stripBox.width + 1);

    // ③ 滚到远端后窗口仍可交互:点击远端窗口标题栏 = 激活该窗口。
    await workspaceWindow(page, "timeline").locator(".tab-bar").click();
    await expect(workspaceWindow(page, "timeline")).toHaveClass(/focused/);

    // ④ 切回首列:视口外窗口经降级渲染后照常渲染(字节行虚拟列表恢复)。
    await focusWindowButton(page, "stack").click();
    await waitForCameraSettled(page);
    await expect(byteRows(page).first()).toBeVisible();
    expect(await byteRows(page).count()).toBeGreaterThan(0);
  });

  test("响应式降级:中宽 P1 合并列 / 窄条 P2 单列 + 窗口切换条;回宽屏回 P0", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(layoutPresetBadge(page)).toHaveText("P0");

    // 中宽(800px 视口 = 768px 工作区)→ P1:预设合并为 3 列。
    await page.setViewportSize({ width: 800, height: 900 });
    await expect(layoutPresetBadge(page)).toHaveText("P1");
    await expect
      .poll(async () => await layoutColumnGroups(page), { timeout: 5_000 })
      .toEqual(P1_COLUMNS.map((column) => [...column]));

    // 窄条(360px 视口 = 328px 工作区)→ P2:单列纵向(全部窗口同列)。
    await page.setViewportSize({ width: 360, height: 900 });
    await expect(layoutPresetBadge(page)).toHaveText("P2");
    await expect(layoutColumns(page)).toHaveCount(1);
    const single = await layoutColumnGroups(page);
    expect(single).toHaveLength(1);
    expect(single[0]).toHaveLength(REGISTERED_WINDOW_TYPES.length);

    // 单列下降级可用性:窗口切换条(菜单「窗口」组)聚焦远端窗口可达。
    await focusWindowButton(page, "checkpoints").click();
    await expect(workspaceWindow(page, "checkpoints")).toHaveClass(/focused/);
    await expect(workspaceWindow(page, "checkpoints")).toBeInViewport();

    // 回到宽屏 → P0(档位双向切换)。
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(layoutPresetBadge(page)).toHaveText("P0");
    await expect
      .poll(async () => await layoutColumnGroups(page), { timeout: 5_000 })
      .toEqual(P0_COLUMNS.map((column) => [...column]));
  });

  test("「重置布局」:清空列宽 / 窗高调整并回到当前宽度档预设", async ({ createdSession }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });

    // 制造两项用户调整:焦点列全宽 + 首列窗高拖拽。
    await widthPresetButton(page, "1").click();
    const fullWidth = (await layoutColumnWidthPx(page))[0] as number;
    expect(fullWidth).toBeGreaterThan(MIN_COLUMN_WIDTH * 1.5);
    await dragBy(page, rowDivider(page, 0, 0), 0, 60);

    await resetLayoutButton(page).click();
    await expect(layoutStatus(page)).toContainText("P0");

    // 列分组回 P0;列宽 / 窗高回该档缺省(列宽 = 等分夹取护栏)。
    expect(await layoutColumnGroups(page)).toEqual(P0_COLUMNS.map((column) => [...column]));
    const widths = await layoutColumnWidthPx(page);
    for (const width of widths) {
      expect(width).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH - 1);
      expect(width).toBeLessThan(MIN_COLUMN_WIDTH + 4);
    }
    const stackBelow = (await workspaceWindow(page, "stack").boundingBox())?.height ?? 0;
    const registersBelow = (await workspaceWindow(page, "registers").boundingBox())?.height ?? 0;
    expect(Math.abs(stackBelow - registersBelow)).toBeLessThanOrEqual(2);
  });

  test("渲染负担观测:全窗口常驻(窗口数 × 节点数 × 交互 RTT;风险表证据)", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });

    const windowCount = await workspaceWindows(page).count();
    const shadowNodes = await page.locator("sm-workspace").evaluate((element) =>
      element.shadowRoot?.querySelectorAll("*").length ?? 0,
    );
    const panelsWithDegrade = await page
      .locator("sm-workspace .tab-panel[data-render-degrade='content-visibility']")
      .count();

    // 交互 RTT:聚焦远端窗口(菜单入口)→ 该窗口进入焦点态(含相机滚动合帧)。
    const started = Date.now();
    await focusWindowButton(page, "checkpoints").click();
    await expect(workspaceWindow(page, "checkpoints")).toHaveClass(/focused/);
    const focusRttMs = Date.now() - started;

    test.info().annotations.push({
      type: "render-burden",
      description:
        `窗口数=${windowCount};工作区 shadow 节点数=${shadowNodes};` +
        `降级渲染面板数=${panelsWithDegrade};聚焦交互 RTT=${focusRttMs}ms`,
    });
    // 观测行同时落 stdout(可复跑命令的记录面)与 testInfo 附注。
    console.log(
      `[WP-72 渲染负担观测] 窗口数=${windowCount} 节点数=${shadowNodes} ` +
        `降级面板数=${panelsWithDegrade} 交互RTT=${focusRttMs}ms`,
    );

    // 上限护栏(宽松上界;超限即需重评降级渲染策略)。
    expect(windowCount).toBe(REGISTERED_WINDOW_TYPES.length);
    expect(panelsWithDegrade).toBe(REGISTERED_WINDOW_TYPES.length);
    expect(shadowNodes).toBeLessThan(2_000);
    expect(focusRttMs).toBeLessThan(2_000);
  });

  /**
   * 溢出列 regime(窗高下限 266px 之后的核心口径;与上面「:170 富余空间列」互补):
   *
   * P0 的三窗列(时间线 / 检查点 / 内存差异)在 1440×900 下的列高下限 = 3 × 266
   * + 非面板占位 54 = **852px**,恰好等于条带内容高 ⇒ 该列**贴住下限、自由空间
   * 恰好只够三个下限**。旧口径(列高钉死、拖拽只能把像素从同列另一窗挪过来)在
   * 此列**数学上不可能**:被压窗已在下限 ⇒ 拖拽零位移(死操作)。新口径下:增大的
   * 窗按位移长高、被压窗**贴住下限不动**、多出来的像素由**列盒长高**承载(条带 /
   * 文档滚动到达)⇒ 拖拽有效。两条 regime 的差异被显式固定:富余空间的列「和守恒」,
   * 溢出列的列「总高增长」。
   */
  test("窗高可调(溢出列):列高贴住下限时拖拽仍有效——被压窗停在下限、列总高随之增长", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });

    /** 窗高下限(px;vm-ui `MIN_ROW_HEIGHT_PX` = chrome 182.1 + 4 × 20.8 ⇒ 266)。 */
    const MIN_ROW_HEIGHT = 266;
    /** 三窗列的非面板占位(2 × 3 边框 + 2 分隔条 + 4 处列内间距)。 */
    const THREE_PANE_CHROME = 3 * 2 + 2 * 8 + 4 * 8;

    const timelinePanel = workspaceWindow(page, "timeline");
    const checkpointsPanel = workspaceWindow(page, "checkpoints");
    const memoryDiffPanel = workspaceWindow(page, "memory-diff");
    const columnBoxBefore = (await layoutColumn(page, 4).boundingBox())?.height ?? 0;
    const timelineBefore = (await timelinePanel.boundingBox())?.height ?? 0;
    const checkpointsBefore = (await checkpointsPanel.boundingBox())?.height ?? 0;
    const memoryDiffBefore = (await memoryDiffPanel.boundingBox())?.height ?? 0;

    // 前提固定(不是口号):该列盒 = 下限,自由空间恰好 = 3 × 下限。
    expect(columnBoxBefore).toBeCloseTo(3 * MIN_ROW_HEIGHT + THREE_PANE_CHROME, 0);
    expect(checkpointsBefore).toBeCloseTo(MIN_ROW_HEIGHT + 2, 0);

    await dragBy(page, rowDivider(page, 4, 0), 0, 60);
    await expect(layoutStatus(page)).not.toHaveText("");

    const columnBoxAfter = (await layoutColumn(page, 4).boundingBox())?.height ?? 0;
    const timelineAfter = (await timelinePanel.boundingBox())?.height ?? 0;
    const checkpointsAfter = (await checkpointsPanel.boundingBox())?.height ?? 0;
    const memoryDiffAfter = (await memoryDiffPanel.boundingBox())?.height ?? 0;

    // ① 增大的窗按位移长高(拖拽真的有效,不是死操作)。
    expect(timelineAfter).toBeGreaterThan(timelineBefore + 40);
    // ② 被压窗**贴住下限**(不缩到下限以下,也不被挤扁);内容盒 ≥ 下限。
    expect(checkpointsAfter).toBeLessThanOrEqual(checkpointsBefore + 1);
    expect(checkpointsAfter).toBeGreaterThanOrEqual(MIN_ROW_HEIGHT);
    // ③ 非相邻窗**不受影响**(换算基准在按下瞬间冻结;否则列高增长会摊回它身上)。
    expect(memoryDiffAfter).toBeCloseTo(memoryDiffBefore, 0);
    // ④ 多出来的像素由**列盒长高**承载(旧口径下这里是「和守恒」,即拖不动)。
    expect(columnBoxAfter).toBeGreaterThan(columnBoxBefore + 40);
    expect(columnBoxAfter).toBeCloseTo(columnBoxBefore + (timelineAfter - timelineBefore), 0);

    // 会话内保持:切模式后列盒不回退(尺寸调整与数据源换绑解耦)。
    await page.locator("sm-workspace-menu button.mode-toggle-button").click();
    await expect(page.locator("sm-workspace-menu .mode-indicator")).toHaveText("调试模式");
    expect((await layoutColumn(page, 4).boundingBox())?.height ?? 0).toBeCloseTo(
      columnBoxAfter,
      0,
    );
  });
});

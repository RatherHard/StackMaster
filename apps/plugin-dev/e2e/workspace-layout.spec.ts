/**
 * E2E 场景 ⑥:工作区**整页布局**交互(2026-09-18 改版 = D-API-153 / D-UI-1 ~ D-UI-7)。
 *
 * 本文件**取代**原「Niri 式列条带布局交互」spec(列宽 / 窗高 / 分隔条 / 三类落点 /
 * 相机 / 预设档位 —— 那一整套面随列条带整条废止)。
 *
 * 门禁面(全部真机 chromium;判据逐条对齐 D-UI-x 与完成标准):
 *  - **D-UI-1 整页布局**:左右两分固定 1:1、**无间隙无描边**、工作区占满视口、
 *    **文档层不溢出**(溢出由左半侧内部滚动承载);
 *  - **D-UI-2 恰两个可见视图位**:左半侧任一时刻通过两个视图位看到视图,更多视图
 *    由**纵向滚动**承载(**只滚动、不压缩**);
 *  - **可读性判据**:每个视图位高度 ≥ chrome + 4 行;字节视图内**可见数据行 ≥ 4**;
 *  - **D-UI-3 `Ctrl + ↑/↓`**:切换视图位、`preventDefault`、**边界不环绕**;
 *  - **D-UI-4 列表按钮**:勾选控制左半侧显示;**列表内重排**(拖拽 + `Alt + ↑/↓`);
 *  - **D-UI-5 窄屏**:左半侧保底 452.4px(不隐藏右半侧 / 不上下堆叠);
 *  - **D-UI-7 无障碍**:面板地标名不变、列表按钮键盘路径、`aria-live` 播报。
 *
 * 选择器锚 = 结构属性(`data-view-role` / `data-view-panel` / `data-view-stack` /
 * `data-view-type` / `data-view-visible`),不依赖文案排版与像素几何;唯一例外是
 * 几何读数(观测目标本身)。
 */
import {
  byteRows,
  dragViewListItem,
  expect,
  focusWindowButton,
  layoutStatus,
  menu,
  panelHeightPx,
  rightRole,
  scrollViewIntoStack,
  test,
  viewListButton,
  viewListCheckbox,
  viewListItem,
  viewListStatus,
  viewStack,
  visibleByteRowCount,
  workspaceGeometry,
  workspaceWindow,
  workspaceWindowTypes,
  workspaceWindows,
} from "./fixtures.js";

/** 注册表登记类型集(十类;**全部常驻**,D-MP-1 不修订)。 */
const REGISTERED_VIEW_TYPES = [
  "stack",
  "registers",
  "debug",
  "free",
  "payload",
  "call-stack",
  "structure",
  "timeline",
  "checkpoints",
  "memory-diff",
] as const;

/** payload 固定于右半侧 ⇒ 左半侧可见视图位 = 其余九类。 */
const LEFT_VIEW_TYPES = REGISTERED_VIEW_TYPES.filter((type) => type !== "payload");

/** 一个行单位(px;vm-ui `HEX_ROW_HEIGHT_PX` = 13 × 1.6)。 */
const HEX_ROW_HEIGHT_PX = 20.8;
/** 视图位 chrome(px;vm-ui `VIEW_PANEL_CHROME_HEIGHT_PX`)。 */
const VIEW_PANEL_CHROME_HEIGHT_PX = 20.8 + 4 + 1 + 133.3 + (20.8 + 1);
/** 视图位高度下限(px)= chrome + 4 行(vm-ui `viewSlotHeightPx()` 的下限)。 */
const VIEW_SLOT_MIN_HEIGHT_PX = Math.ceil(
  VIEW_PANEL_CHROME_HEIGHT_PX + 4 * HEX_ROW_HEIGHT_PX,
);
/** 左半侧宽度底线(px;D-UI-5 = `MIN_COLUMN_WIDTH`)。 */
const SIDE_PANEL_MIN_WIDTH_PX = 452.4;

test.describe("工作区整页布局(2026-09-18 改版:D-UI-1 ~ D-UI-7)", () => {
  test("D-UI-1 整页布局:左右 1:1 无间隙、工作区占满视口、文档层不溢出", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });

    const geometry = await workspaceGeometry(page);

    // ① 左右两分固定 1:1(视口足够宽时)。
    expect(Math.abs(geometry.leftClientWidth - geometry.rightClientWidth)).toBeLessThanOrEqual(1);
    // ② 两半侧紧密贴合:无间隙(无 gap / 无 border)。
    expect(Math.abs(geometry.horizontalGapPx)).toBeLessThanOrEqual(0.5);
    // ③ 整页布局:工作区占满视口高 ⇒ 文档层零溢出(溢出由左半侧内部滚动承载)。
    expect(geometry.documentOverflowPx).toBeLessThanOrEqual(1);
    // ④ 左半侧自身是滚动容器(溢出没有上浮到文档层)。
    expect(geometry.stackScrollHeight).toBeGreaterThan(geometry.stackClientHeight);
    // ⑤ 滚动带丝滑动画(FE-WS-09;prefers-reduced-motion 下降级为 auto)。
    expect(geometry.stackScrollBehavior).toBe("smooth");
  });

  test("D-UI-2 视图位:左半侧可见视图纵向堆叠、滚动可达全部视图位(只滚动不压缩)", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });

    // 左半侧渲染全部可见视图位(payload 固定于右半侧,故少一个)。
    const types = await workspaceWindowTypes(page);
    expect([...types]).toEqual([...LEFT_VIEW_TYPES]);
    expect(await workspaceWindows(page)).toHaveCount(LEFT_VIEW_TYPES.length);

    // 每个视图位有**确定高度**且 ≥ chrome + 4 行(不得压到装不下一行字节)。
    for (const viewType of LEFT_VIEW_TYPES) {
      const height = await panelHeightPx(page, viewType);
      expect(height, `${viewType} 视图位高 ${height}px`).toBeGreaterThanOrEqual(
        VIEW_SLOT_MIN_HEIGHT_PX - 1,
      );
    }

    // 一屏只可见两个视图位(需求:上下两半);其余由纵向滚动承载。
    const geometry = await workspaceGeometry(page);
    const twoSlots = VIEW_SLOT_MIN_HEIGHT_PX * 2;
    expect(geometry.stackClientHeight).toBeLessThan(LEFT_VIEW_TYPES.length * twoSlots);

    // 滚动可达最后一个视图位(纵向滚动确实是可达性载体)。
    await scrollViewIntoStack(page, "memory-diff");
    await expect(workspaceWindow(page, "memory-diff")).toBeInViewport();

    // 视口外降级渲染标记保留(FE-WS 保留面)。
    for (const viewType of ["stack", "memory-diff"]) {
      await expect(workspaceWindow(page, viewType)).toHaveAttribute(
        "data-render-degrade",
        "content-visibility",
      );
    }
  });

  test("可读性判据:字节视图内可见数据行 ≥ 4(真机读数,不以常量化简)", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });

    await scrollViewIntoStack(page, "stack");
    expect(await visibleByteRowCount(page, "stack")).toBeGreaterThanOrEqual(4);
    expect(await byteRows(page).count()).toBeGreaterThan(0);
  });

  test("D-UI-3 Ctrl+↑/↓:切换视图位、preventDefault、边界不环绕", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });

    const readActive = async (): Promise<string | null> =>
      page.evaluate(
        () =>
          (document.querySelector("sm-workspace") as { layoutSnapshot?: { activeType: string | null } })
            ?.layoutSnapshot?.activeType ?? null,
      );
    const dispatchCtrlArrow = async (key: "ArrowUp" | "ArrowDown"): Promise<boolean> =>
      page.evaluate((keyName) => {
        const workspace = document.querySelector("sm-workspace") as HTMLElement;
        const target = workspace.shadowRoot!.querySelector('[data-view-role="left"]')!;
        const event = new KeyboardEvent("keydown", {
          key: keyName,
          ctrlKey: true,
          bubbles: true,
          composed: true,
          cancelable: true,
        });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      }, key);

    // 首次向后 = 序首可见视图。
    expect(await dispatchCtrlArrow("ArrowDown")).toBe(true);
    expect(await readActive()).toBe(LEFT_VIEW_TYPES[0]);
    // 状态行宣读当前视图名(不只是视觉)。
    await expect(layoutStatus(page)).not.toHaveText("");

    // 逐步向后;到末位即停(**边界不环绕**)。
    for (let step = 1; step < LEFT_VIEW_TYPES.length; step += 1) {
      await dispatchCtrlArrow("ArrowDown");
    }
    expect(await readActive()).toBe(LEFT_VIEW_TYPES[LEFT_VIEW_TYPES.length - 1]);
    await dispatchCtrlArrow("ArrowDown");
    expect(await readActive()).toBe(LEFT_VIEW_TYPES[LEFT_VIEW_TYPES.length - 1]);

    // 向前回到序首,再向前仍停在序首。
    for (let step = 1; step < LEFT_VIEW_TYPES.length; step += 1) {
      await dispatchCtrlArrow("ArrowUp");
    }
    expect(await readActive()).toBe(LEFT_VIEW_TYPES[0]);
    await dispatchCtrlArrow("ArrowUp");
    expect(await readActive()).toBe(LEFT_VIEW_TYPES[0]);
  });

  test("D-UI-4 列表按钮:勾选控制左半侧显示;视图仍全部常驻(无开 / 关语义)", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });

    // 列表按钮可展开(视觉顺序 = 焦点顺序)。
    await viewListButton(page).click();
    await expect(viewListCheckbox(page, "free")).toBeVisible();

    // 取消勾选「自由视图」⇒ 左半侧不再显示它,但视图数不变(常驻,不是关闭)。
    await viewListCheckbox(page, "free").uncheck();
    await expect(workspaceWindow(page, "free")).toHaveCount(0);
    expect(await workspaceWindowTypes(page)).toHaveLength(LEFT_VIEW_TYPES.length - 1);
    // aria-live 播报「已隐藏」。
    await expect(viewListStatus(page)).toContainText("已隐藏");

    // 再勾选即恢复显示。
    await viewListCheckbox(page, "free").check();
    await expect(workspaceWindow(page, "free")).toHaveCount(1);
    await expect(viewListStatus(page)).toContainText("已显示");
  });

  test("D-UI-4 列表内重排:键盘 Alt+↑/↓ 与拖拽都只改顺序(唯一落点语义)", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });
    await viewListButton(page).click();

    const readOrder = async (): Promise<string[]> =>
      page.evaluate(() =>
        [
          ...(document.querySelector("sm-workspace") as HTMLElement).shadowRoot!.querySelectorAll(
            "li.view-list-item[data-view-type]",
          ),
        ].map((item) => item.getAttribute("data-view-type") ?? ""),
      );

    const before = await readOrder();
    expect(before).toEqual([...LEFT_VIEW_TYPES]);

    // ① 键盘等价路径:Alt + ↓ 把序首条目下移一位。
    await viewListItem(page, LEFT_VIEW_TYPES[0]).focus();
    await page.keyboard.press("Alt+ArrowDown");
    await expect
      .poll(readOrder, { timeout: 5_000 })
      .toEqual([before[1], before[0], ...before.slice(2)]);
    await expect(viewListStatus(page)).toContainText("已把");

    // ② 拖拽重排:把当前第 1 项拖到第 3 项下半 ⇒ 落到其后。
    const order = await readOrder();
    await dragViewListItem(
      page,
      viewListItem(page, order[0] as string),
      viewListItem(page, order[2] as string),
      "lower",
    );
    await expect
      .poll(readOrder, { timeout: 5_000 })
      .toEqual([order[1], order[2], order[0], ...order.slice(3)]);

    // ③ 重排**不改变视图集**(无重无漏;仍是同一批类型)。
    expect([...(await readOrder())].sort()).toEqual([...LEFT_VIEW_TYPES].sort());
    expect(await workspaceWindowTypes(page)).toHaveLength(LEFT_VIEW_TYPES.length);
  });

  test("D-UI-5 窄屏:左半侧保底 452.4px,形态不变(否决隐藏右半侧 / 上下堆叠)", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 768, height: 900 });

    const geometry = await workspaceGeometry(page);
    // 左半侧获得宽度底线(不是被压缩)。
    expect(geometry.leftClientWidth).toBeGreaterThanOrEqual(SIDE_PANEL_MIN_WIDTH_PX - 1);
    expect(geometry.leftMinInlineSize).not.toBe("0px");
    // 形态不变:右半侧仍在(不隐藏)、两半侧不上下堆叠(仍在同一行 ⇒ 有水平排布)。
    await expect(rightRole(page)).toHaveCount(1);
    expect(geometry.rightClientWidth).toBeGreaterThan(0);
    // 窄屏下两半侧都拿到底线 ⇒ 网格宽超出视口 ⇒ 页面横向滚动(D-UI-5 裁定)。
    expect(geometry.leftClientWidth + geometry.rightClientWidth).toBeGreaterThanOrEqual(
      geometry.innerWidth - 1,
    );
  });

  test("视图导航:菜单「视图」组聚焦导航不改变视图集;「重置视图」恢复默认顺序与全选", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });

    // 聚焦导航:点击 = 聚焦 + 滚动到该视图(菜单不承载勾选 / 排序)。
    await focusWindowButton(page, "checkpoints").click();
    await expect(menu(page).locator('button.focus-window[data-window-type="checkpoints"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // 菜单内**不得出现第二个勾选 / 排序入口**(D-UI-7 补充裁定)。
    await expect(menu(page).locator('input[type="checkbox"]')).toHaveCount(0);

    // 制造两项调整:隐藏一个视图 + 重排一次。
    await viewListButton(page).click();
    await viewListCheckbox(page, "free").uncheck();
    await viewListItem(page, "stack").focus();
    await page.keyboard.press("Alt+ArrowDown");

    // 「重置视图」= 恢复默认顺序 + 全选。
    await menu(page).locator("button.reset-views-button").click();
    await expect(workspaceWindowTypes(page)).toHaveCount(LEFT_VIEW_TYPES.length);
    const order = await page.evaluate(() =>
      [
        ...(document.querySelector("sm-workspace") as HTMLElement).shadowRoot!.querySelectorAll(
          "li.view-list-item[data-view-type]",
        ),
      ].map((item) => item.getAttribute("data-view-type") ?? ""),
    );
    expect(order).toEqual([
      "stack",
      "registers",
      "debug",
      "free",
      "payload",
      "call-stack",
      "structure",
      "timeline",
      "checkpoints",
      "memory-diff",
    ]);
    await expect(layoutStatus(page)).toContainText("已重置视图");
  });

  test("渲染负担观测:视图位 × 节点数 × 交互 RTT(风险表证据,可复跑)", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });

    const viewCount = await workspaceWindows(page).count();
    const shadowNodes = await page
      .locator("sm-workspace")
      .evaluate((element) => element.shadowRoot?.querySelectorAll("*").length ?? 0);
    const degradePanels = await page
      .locator("sm-workspace .ws-view[data-render-degrade='content-visibility']")
      .count();

    const started = Date.now();
    await focusWindowButton(page, "checkpoints").click();
    await expect(menu(page).locator('button.focus-window[data-window-type="checkpoints"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const focusRttMs = Date.now() - started;

    test.info().annotations.push({
      type: "render-burden",
      description:
        `视图位=${viewCount};工作区 shadow 节点数=${shadowNodes};` +
        `降级渲染视图位=${degradePanels};聚焦交互 RTT=${focusRttMs}ms`,
    });
    console.log(
      `[整页布局渲染负担观测] 视图位=${viewCount} 节点数=${shadowNodes} ` +
        `降级视图位=${degradePanels} 交互RTT=${focusRttMs}ms`,
    );

    expect(viewCount).toBe(LEFT_VIEW_TYPES.length);
    expect(degradePanels).toBe(LEFT_VIEW_TYPES.length);
    expect(shadowNodes).toBeLessThan(2_000);
    expect(focusRttMs).toBeLessThan(2_000);
  });

  test("payload 搭建窗口固定于右半侧(同一实例;左半侧无同名面板)", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });

    // 右半侧承载 payload 内容元素(惰性宿主;真组件按需取回)。
    await expect(rightRole(page).locator("sm-payload-tab-host")).toHaveCount(1);
    // 左半侧**不渲染** payload 视图位(避免同名地标与双 ChildPart 争夺同一节点)。
    await expect(workspaceWindow(page, "payload")).toHaveCount(0);

    // 「左半侧 = 视图管理窗口」:它管的正是除 payload 外的其余视图。
    expect(await workspaceWindowTypes(page)).not.toContain("payload");
    // 右半侧不随左侧滚动移动(整页布局下左半侧滚动不影响右半侧几何)。
    const before = await rightRole(page).boundingBox();
    await viewStack(page).evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const after = await rightRole(page).boundingBox();
    expect(after?.x ?? 0).toBeCloseTo(before?.x ?? 0, 0);
    expect(after?.y ?? 0).toBeCloseTo(before?.y ?? 0, 0);
  });
});

/**
 * 工作区**布局模型 × 视图位高度算式**联动测试(WP-72 布局状态面;
 * **2026-09-18 整页布局改版 = D-API-153 / D-UI-1 ~ D-UI-7 整条重写**)。
 *
 * ## 本文件原测什么(已废止)
 *
 * 原文件测「列宽占比 / 同列窗高比例 / 预设应用」——**整条面随 Niri 式列条带废止**
 * (**随 D-API-153 废止**):`columns[].widthRatio` / `columns[].rowHeights` /
 * `viewportWidth` / `setColumnWidth` / `setRowHeights` / `setViewportWidth` /
 * `applyPreset` / `resetLayout` / `openColumnAt` / `moveTab` / 三类落点。
 * 上述断言**不得复活**(已随改版整条退出,模型不再暴露兼容别名)。
 *
 * ## 本文件现在测什么(不重复另外两处)
 *
 *  - **模型结构 / 可见性 / 焦点 / 重排**语义面 → `workspace-model.test.ts`;
 *  - **常量推导**(字符宽 / 行单位 / chrome / N / 下限取值 / 默认顺序表)
 *    → `layout-presets.test.ts`;
 *  - **本文件** = 两者的**联动**:模型状态与 `viewSlotHeightPx()` 算式之间的
 *    不等式(「两个可见视图位 + 列表按钮 + 留白 ≤ 左半侧可视高」;空间不足即
 *    溢出由纵向滚动承托 = **只滚动、不压缩**)、视位容量常量与**渲染数**的分野
 *    (D-UI-2:恰两个可见视位 = 可视区容量,不是渲染数)、以及 `leftRoleWidth`
 *    与 D-UI-5 底线的分工(诊断面不夹取,底线由 CSS 承担)。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_VIEW_ORDER,
  HEX_ROW_HEIGHT_PX,
  SIDE_PANEL_MIN_WIDTH_PX,
  VIEW_LIST_BUTTON_HEIGHT_PX,
  VIEW_PANEL_CHROME_HEIGHT_PX,
  VIEW_SLOT_MIN_VISIBLE_HEX_ROWS,
  VIEW_STACK_SPACING_PX,
  VISIBLE_VIEW_SLOT_COUNT,
  orderByDefault,
  viewSlotHeightPx,
} from "../../src/workspace/layout-presets.js";
import {
  CALL_STACK_TAB_TYPE,
  CHECKPOINTS_TAB_TYPE,
  DEBUG_TAB_TYPE,
  FREE_TAB_TYPE,
  MEMORY_DIFF_TAB_TYPE,
  PAYLOAD_TAB_TYPE,
  REGISTERS_TAB_TYPE,
  STACK_TAB_TYPE,
  STRUCTURE_TAB_TYPE,
  TIMELINE_TAB_TYPE,
} from "../../src/workspace/tab-registry.js";
import {
  WorkspaceLayoutModel,
  isLayoutStateValid,
  isWindowSetComplete,
  type WorkspaceWindowBinding,
} from "../../src/workspace/workspace-model.js";

/**
 * 登记集合替身(等价 `defaultTabTypeRegistry.list()`,**登记序**)。
 * 顺序刻意与 `DEFAULT_VIEW_ORDER` 不同 —— 两者是**不同**的面(登记序 vs
 * 默认呈现序),本文件的多处不等式依赖这一区分。
 */
const REGISTRY_BINDINGS: readonly WorkspaceWindowBinding[] = [
  { type: STACK_TAB_TYPE, label: "栈视图" },
  { type: FREE_TAB_TYPE, label: "自由视图" },
  { type: REGISTERS_TAB_TYPE, label: "寄存器视图" },
  { type: PAYLOAD_TAB_TYPE, label: "Payload 搭建" },
  { type: DEBUG_TAB_TYPE, label: "指令视图" },
  { type: STRUCTURE_TAB_TYPE, label: "结构视图" },
  { type: CALL_STACK_TAB_TYPE, label: "调用栈" },
  { type: MEMORY_DIFF_TAB_TYPE, label: "内存 diff" },
  { type: TIMELINE_TAB_TYPE, label: "时间线" },
  { type: CHECKPOINTS_TAB_TYPE, label: "checkpoint" },
];

const REGISTRY_TYPES: readonly string[] = REGISTRY_BINDINGS.map((binding) => binding.type);

/** 视位高下限(算式在非法 / 矮输入下的确定性回落值;与 layout-presets 同式同源)。 */
const SLOT_FLOOR_PX = viewSlotHeightPx(0);

/** 左半侧「非视位」占用 = 列表按钮 + 上下留白(算式里被扣掉的那部分)。 */
const NON_SLOT_CHROME_PX = VIEW_LIST_BUTTON_HEIGHT_PX + VIEW_STACK_SPACING_PX;

/** 一个视位减去 chrome 后可容纳的数据行数。 */
function visibleRows(slotHeightPx: number): number {
  return (slotHeightPx - VIEW_PANEL_CHROME_HEIGHT_PX) / HEX_ROW_HEIGHT_PX;
}

describe("模型 × 算式:左半侧可视高的分配不等式(D-UI-2 / FE-WS-15)", () => {
  it("空间充足:两个视位 + 列表按钮 + 留白 ≤ 左半侧可视高(等分,不溢出)", () => {
    for (const height of [900, 1024, 1200, 1440, 2160]) {
      const slot = viewSlotHeightPx(height);
      // 下限未生效 ⇒ 视位高严格大于下限(否则下面「等分」的断言测不到东西)。
      expect(slot, `左半侧高 ${String(height)} 触发了下限`).toBeGreaterThan(SLOT_FLOOR_PX);
      // **核心不等式**:两个视位 + 列表按钮 + 留白 不超出左半侧可视高。
      expect(slot * VISIBLE_VIEW_SLOT_COUNT + NON_SLOT_CHROME_PX).toBeLessThanOrEqual(height);
      // 且是**等分**(不是随手取小):可用高被恰 2 除、向下取整 ⇒ 差额 < 2px。
      expect(slot).toBe(Math.floor((height - NON_SLOT_CHROME_PX) / VISIBLE_VIEW_SLOT_COUNT));
      expect(height - (slot * VISIBLE_VIEW_SLOT_COUNT + NON_SLOT_CHROME_PX)).toBeLessThan(2);
      // 视野内恰好两个视位(容量常量 = 2,不是「可见视图数」)。
      expect(VISIBLE_VIEW_SLOT_COUNT).toBe(2);
    }
  });

  it("空间不足:下限生效 ⇒ 两视位之和**超过**可视高,溢出由滚动承载(只滚动,不压缩)", () => {
    const height = 320;
    const slot = viewSlotHeightPx(height);

    // 下限生效(恰好 chrome + N 行)—— 这才是「不压缩」的判据。
    expect(slot).toBe(SLOT_FLOOR_PX);
    expect(slot).toBeGreaterThan(Math.floor((height - NON_SLOT_CHROME_PX) / VISIBLE_VIEW_SLOT_COUNT));
    // 不等式在此**必须**反向:装不下是预期结果,承托者 = `.ws-stack` 的纵向滚动。
    expect(slot * VISIBLE_VIEW_SLOT_COUNT + NON_SLOT_CHROME_PX).toBeGreaterThan(height);
    // 回归护栏:绝不出现「按可用高压缩到一半」的旧机制(历史反例:4 窗列每窗
    // 146px 而面板 chrome 实测 182.1px ⇒ 连一行字节都装不下)。
    expect(slot).toBeGreaterThan(VIEW_PANEL_CHROME_HEIGHT_PX);
  });

  it("可读性判据与左半侧高**无关**:任一高度下每视位 − chrome ≥ N 行", () => {
    for (const height of [0, 100, 200, 320, 480, 768, 900, 1440, 2160, Number.MAX_SAFE_INTEGER]) {
      const slot = viewSlotHeightPx(height);
      expect(visibleRows(slot), `左半侧高 ${String(height)}`).toBeGreaterThanOrEqual(
        VIEW_SLOT_MIN_VISIBLE_HEX_ROWS,
      );
    }
  });

  it("算式真的扣掉了列表按钮与留白(不是裸的 H / 2)", () => {
    const height = 900;
    const slot = viewSlotHeightPx(height);

    // 裸 H / 2 会得到 450;扣掉按钮与留白后必然更小 —— 否则「两个视位 + 列表
    // 按钮 + 留白 ≤ 左半侧高」的不等式就是巧合而非算式保证。
    expect(slot).toBeLessThan(Math.floor(height / VISIBLE_VIEW_SLOT_COUNT));
    expect(NON_SLOT_CHROME_PX).toBeGreaterThan(0);
    // 扣减量可复算:slot × 2 = 可用高的向下取整。
    expect(slot * VISIBLE_VIEW_SLOT_COUNT).toBe(
      Math.floor((height - NON_SLOT_CHROME_PX) / VISIBLE_VIEW_SLOT_COUNT) * VISIBLE_VIEW_SLOT_COUNT,
    );
  });
});

describe("模型可见集 × 视位容量(D-UI-2:恰两个可见视位 = 容量,不是渲染数)", () => {
  it("全选缺省 ⇒ 可见视图数 = 登记数(远超视位容量)⇒ 溢出即滚动,渲染数不裁剪", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(REGISTRY_BINDINGS);

    expect(model.visibleViews()).toHaveLength(REGISTRY_TYPES.length);
    expect(REGISTRY_TYPES.length).toBeGreaterThan(VISIBLE_VIEW_SLOT_COUNT);
    // 容量恒 2:可视区只放得下两个视位,其余由滚动承载(渲染数 = 可见视图数,
    // 该 DOM 事实在 `sm-workspace-layout.test.ts` 断言)。
    const height = 900;
    const slot = viewSlotHeightPx(height);
    expect(slot * VISIBLE_VIEW_SLOT_COUNT).toBeLessThanOrEqual(height - NON_SLOT_CHROME_PX + 1);
    expect(slot * model.visibleViews().length).toBeGreaterThan(height);
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });

  it("可见性变化**不改变**视位高算式(容量是布局常量,不是可见数的函数)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(REGISTRY_BINDINGS);
    const height = 900;
    const slotBefore = viewSlotHeightPx(height);

    // 逐个取消勾选:可见数从 10 递减到 0,算式结果恒不变。
    for (const binding of REGISTRY_BINDINGS) {
      expect(model.setViewVisible(binding.type, false)).toBe(true);
      expect(viewSlotHeightPx(height)).toBe(slotBefore);
    }
    expect(model.visibleViews()).toHaveLength(0);
    // 「无可见视图」也是合法状态(不是空布局;视图仍全员在场)。
    expect(model.viewCount).toBe(REGISTRY_TYPES.length);
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });

  it("可见视图数恒等于「勾选数」,与视位容量无关(未勾选者不显示,但仍在场)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(REGISTRY_BINDINGS);
    model.setViewVisible(PAYLOAD_TAB_TYPE, false);
    model.setViewVisible(TIMELINE_TAB_TYPE, false);

    expect(model.visibleViews()).toHaveLength(REGISTRY_TYPES.length - 2);
    expect(model.visibleIndexOf(PAYLOAD_TAB_TYPE)).toBeNull();
    expect(model.indexOfView(PAYLOAD_TAB_TYPE)).not.toBeNull();
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });
});

describe("模型 × 默认顺序(layout-presets 是默认顺序的唯一来源)", () => {
  it("以登记序为输入 + orderByDefault 注入 ⇒ 呈现序 = DEFAULT_VIEW_ORDER ∩ 登记集(装配路径)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(REGISTRY_BINDINGS, orderByDefault(REGISTRY_TYPES));

    const expected = DEFAULT_VIEW_ORDER.filter((type) => REGISTRY_TYPES.includes(type));
    expect(model.orderedViews().map((view) => view.type)).toEqual([...expected]);
    // 与登记序**不同** —— 若两者相同,本用例测不到「默认顺序经单点注入」。
    expect([...expected]).not.toEqual([...REGISTRY_TYPES]);
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });

  it("「重置视图」的恢复顺序 = `bindWindows` 的**输入顺序**(模型不持有默认顺序字面量)", () => {
    // 输入顺序 = DEFAULT_VIEW_ORDER 展平序(无第二份字面量:顺序全部来自调用方)。
    const defaultOrdered = orderByDefault(REGISTRY_TYPES);
    const byType = new Map(REGISTRY_BINDINGS.map((binding) => [binding.type, binding]));
    const bindingsInDefaultOrder = defaultOrdered
      .map((type) => byType.get(type))
      .filter((binding): binding is WorkspaceWindowBinding => binding !== undefined);

    const model = new WorkspaceLayoutModel();
    model.bindWindows(bindingsInDefaultOrder);

    // 用户扰动:重排 + 取消勾选。
    expect(model.moveView(FREE_TAB_TYPE, 0)).toBe(true);
    expect(model.setViewVisible(DEBUG_TAB_TYPE, false)).toBe(true);
    expect(model.orderedViews().map((view) => view.type)).not.toEqual(defaultOrdered);

    model.resetViews();
    expect(model.orderedViews().map((view) => view.type)).toEqual(defaultOrdered);
    expect(model.visibleViews()).toHaveLength(defaultOrdered.length);
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });

  it("登记序输入下 resetViews 亦回到登记序(恢复依据 = 输入序,非 DEFAULT_VIEW_ORDER)", () => {
    // 记录模型侧契约的边界:模型只认 `bindWindows` 的输入顺序。工作区装配时
    // 输入序 = 注册表登记序(见 `sm-workspace.ts#bindWindows`),故组件层
    // 「重置视图」的恢复序 = 登记序;`DEFAULT_VIEW_ORDER` 只决定**初始呈现序**。
    const model = new WorkspaceLayoutModel();
    model.bindWindows(REGISTRY_BINDINGS, orderByDefault(REGISTRY_TYPES));
    expect(model.orderedViews().map((view) => view.type)).not.toEqual([...REGISTRY_TYPES]);

    model.moveView(CHECKPOINTS_TAB_TYPE, 0);
    model.setViewVisible(STACK_TAB_TYPE, false);
    model.resetViews();

    expect(model.orderedViews().map((view) => view.type)).toEqual([...REGISTRY_TYPES]);
    expect(model.visibleViews()).toHaveLength(REGISTRY_TYPES.length);
  });
});

describe("模型 × 切换域过滤(D-UI-3 裁定:切换域 ≡ 左半侧渲染集)", () => {
  /** 工作区传入的判据形态(模型自身零 payload 字面量,过滤由调用方给)。 */
  const eligible = (type: string): boolean => type !== PAYLOAD_TAB_TYPE;

  it("stepActiveView(delta, isEligible) 只在合格子序列内移动,边界不环绕", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(REGISTRY_BINDINGS);

    const domain = model
      .visibleViews()
      .filter((view) => eligible(view.type))
      .map((view) => view.type);
    expect(domain).toHaveLength(REGISTRY_TYPES.length - 1);
    expect(domain).not.toContain(PAYLOAD_TAB_TYPE);

    expect(model.stepActiveView(1, eligible)).toBe(true);
    expect(model.activeType).toBe(domain[0]);
    for (let index = 1; index < domain.length; index += 1) {
      expect(model.stepActiveView(1, eligible)).toBe(true);
      expect(model.activeType).toBe(domain[index]);
      expect(model.activeType).not.toBe(PAYLOAD_TAB_TYPE);
    }
    // 末位不环绕。
    expect(model.stepActiveView(1, eligible)).toBe(false);
    expect(model.activeType).toBe(domain[domain.length - 1]);
    expect(model.stepActiveView(-1, eligible)).toBe(true);
    expect(model.activeType).toBe(domain[domain.length - 2]);
    expect(model.stepActiveView(-1)).toBe(true); // 无过滤时切到全量可见序(通用语义保留)
    expect(model.activeType).toBe(domain[domain.length - 3]);
  });

  it("落点落在过滤域外时按「域首 / 域尾」重置(不因序号错位跳变)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(REGISTRY_BINDINGS);
    const domain = model
      .visibleViews()
      .filter((view) => eligible(view.type))
      .map((view) => view.type);

    // 先以**无过滤**语义把落点放到 payload 上,再按过滤域步进。
    expect(model.setActiveView(PAYLOAD_TAB_TYPE)).toBe(true);
    expect(model.activeType).toBe(PAYLOAD_TAB_TYPE);
    expect(model.stepActiveView(1, eligible)).toBe(true);
    expect(model.activeType).toBe(domain[0]);

    expect(model.setActiveView(PAYLOAD_TAB_TYPE)).toBe(true);
    expect(model.stepActiveView(-1, eligible)).toBe(true);
    expect(model.activeType).toBe(domain[domain.length - 1]);
  });

  it("setActiveView(type, isEligible) 拒绝域外视图;无过滤时仍是全量可见语义", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(REGISTRY_BINDINGS);

    expect(model.setActiveView(PAYLOAD_TAB_TYPE, eligible)).toBe(false);
    expect(model.activeType).toBeNull();
    expect(model.setActiveView(STACK_TAB_TYPE, eligible)).toBe(true);
    expect(model.activeType).toBe(STACK_TAB_TYPE);
    // 模型自身不持有 payload 字面量 ⇒ 不传判据时 payload 仍可选(工作区层负责过滤)。
    expect(model.setActiveView(PAYLOAD_TAB_TYPE)).toBe(true);
    expect(model.activeType).toBe(PAYLOAD_TAB_TYPE);
  });

  it("切换域为空 ⇒ 恒 no-op(不可见视图不在域内)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(REGISTRY_BINDINGS);
    for (const type of REGISTRY_TYPES) {
      model.setViewVisible(type, false);
    }
    expect(model.stepActiveView(1, eligible)).toBe(false);
    expect(model.stepActiveView(-1, eligible)).toBe(false);
    expect(model.activeType).toBeNull();
  });
});

describe("模型 × leftRoleWidth(D-UI-5 底线的核对面)", () => {
  it("登记左半侧实际宽:**不夹取**到 SIDE_PANEL_MIN_WIDTH_PX(底线由 CSS 承担)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(REGISTRY_BINDINGS);

    const narrow = SIDE_PANEL_MIN_WIDTH_PX - 100;
    model.setLeftRoleWidth(narrow);
    expect(model.leftRoleWidth).toBe(narrow);
    expect(model.snapshot.leftRoleWidth).toBe(narrow);
    // 快照合法 —— 底线**不是**模型不变量(D-UI-5 的载体 = CSS
    // `repeat(2, minmax(SIDE_PANEL_MIN_WIDTH_PX, 1fr))` + `.ws-left` 的
    // `min-inline-size`;窄屏真实横向滚动读数归真机几何断言)。
    expect(isLayoutStateValid(model.snapshot)).toBe(true);

    model.setLeftRoleWidth(SIDE_PANEL_MIN_WIDTH_PX * 2);
    expect(model.leftRoleWidth).toBe(SIDE_PANEL_MIN_WIDTH_PX * 2);
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });
});

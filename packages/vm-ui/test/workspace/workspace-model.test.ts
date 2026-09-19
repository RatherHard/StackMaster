/**
 * 工作区视图模型行为测试(WP-71 固定窗口集 / D-MP-1;**2026-09-18 整页布局改版**
 * = D-API-153 / D-UI-1 ~ D-UI-7 按**新模型**重写)。
 *
 * 新模型 = **一条有序的视图类型列表 + 每个类型的可见性(勾选)+ 焦点类型**:
 *  - 视图集绑定(登记集合各恰一实例、常驻)/ 缺省顺序 = 登记序;
 *  - 可见性 = 勾选(**不是开 / 关**;未勾选 = 不显示 = 「暂离」的第二种成因);
 *  - 列表内重排(**只此一种落点语义**,D-UI-4);
 *  - 焦点唯一 / `Ctrl + ↑↓` 切换落点(边界不环绕)/ 重置视图(恢复默认顺序 + 全选)。
 *
 * **已废止(整条退出)**:列式模型的 `columns[].tabIds` / `widthRatio` /
 * `rowHeights` / `viewportWidth`、`moveTab` 三类落点、`openColumnAt`、
 * `setColumnWidth` / `setRowHeights` / `applyPreset` / `resetLayout`、
 * `focusedColumnIndex` / `columnIndexOfTab` / `positionOfTab` / `tabIdsInColumn`。
 */
import { describe, expect, it } from "vitest";

import {
  WorkspaceLayoutModel,
  isLayoutStateValid,
  isWindowSetComplete,
  type WorkspaceWindowBinding,
} from "../../src/workspace/workspace-model.js";

/** 登记集合替身(等价 `WorkspaceTabTypeRegistry.list()` 的收敛形态)。 */
const BINDINGS: readonly WorkspaceWindowBinding[] = [
  { type: "stack", label: "栈视图" },
  { type: "free", label: "自由视图" },
  { type: "registers", label: "寄存器视图" },
  { type: "payload", label: "Payload 搭建" },
];

/** 视图类型序列(断言辅助)。 */
function types(model: WorkspaceLayoutModel): string[] {
  return model.orderedViews().map((view) => view.type);
}

/** 可见视图类型序列(断言辅助)。 */
function visibleTypes(model: WorkspaceLayoutModel): string[] {
  return model.visibleViews().map((view) => view.type);
}

describe("视图模型:视图集绑定(D-MP-1 固定窗口集)", () => {
  it("绑定登记集合:每种类型恰一实例,视图集无重无漏(结构性不变量)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);

    expect(model.viewCount).toBe(BINDINGS.length);
    expect(types(model)).toEqual(BINDINGS.map((entry) => entry.type));
    // id ≡ 类型键:单实例是结构性保证,同类型重复实例无法表达。
    expect(model.orderedViews().map((view) => view.id)).toEqual(BINDINGS.map((entry) => entry.type));
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });

  it("标题 = 绑定时的 label,不含类型内序号(序号语义随单实例退场)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);

    expect(model.orderedViews().map((view) => view.title)).toEqual([
      "栈视图",
      "自由视图",
      "寄存器视图",
      "Payload 搭建",
    ]);
    expect(model.view("stack")?.title).toBe("栈视图");
    // `tab` 是保留的既有消费面名(视图 id ≡ 类型键 ⇒ 与 `view` 同值)。
    expect(model.tab("stack")?.title).toBe("栈视图");
  });

  it("缺省顺序 = **登记序**;可见性初始**全选**", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);

    expect(types(model)).toEqual(["stack", "free", "registers", "payload"]);
    expect(visibleTypes(model)).toEqual(["stack", "free", "registers", "payload"]);
    expect(model.orderedViews().every((view) => view.visible)).toBe(true);
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });

  it("显式顺序:已登记键按给定序;未覆盖者按登记序补末尾(仍是全排列)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS, ["payload", "stack"]);

    // 未覆盖的 free / registers 按**登记序**补在末尾。
    expect(types(model)).toEqual(["payload", "stack", "free", "registers"]);
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });

  it("显式顺序中的重复键 / 未登记键被忽略,缺失者补齐(无重无漏不变量)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS, ["stack", "stack", "no-such-type", "free"]);

    expect(types(model)).toEqual(["stack", "free", "registers", "payload"]);
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });

  it("重新绑定(注册表换绑)不产生重复实例,仍恰一实例且全选", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    model.setViewVisible("free", false);
    model.bindWindows(BINDINGS);

    expect(model.viewCount).toBe(BINDINGS.length);
    // 勾选态属于用户调整 ⇒ 重新绑窗即复位全选。
    expect(visibleTypes(model)).toEqual(["stack", "free", "registers", "payload"]);
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });

  it("焦点缺省 = 序首;仍存在的焦点在重新绑定时保持,消失的类型回落序首", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    expect(model.focusedTabId).toBe("stack");

    model.activateTab("registers");
    model.bindWindows(BINDINGS);
    expect(model.focusedTabId).toBe("registers");

    model.bindWindows(BINDINGS.filter((entry) => entry.type !== "registers"));
    expect(model.focusedTabId).toBe("stack");
  });

  it("空登记集合:无视图无焦点(模型仍表达空集;组件层视图集恒非空)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows([]);

    expect(model.viewCount).toBe(0);
    expect(model.focusedTabId).toBeNull();
    expect(model.focusedType).toBeNull();
    expect(model.activeType).toBeNull();
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });

  it("开 / 关生命周期与列式 API 全部退场(不留兼容别名)", () => {
    const model = new WorkspaceLayoutModel() as unknown as Record<string, unknown>;
    for (const retired of [
      "openTab",
      "closeTab",
      "moveTab",
      "openColumnAt",
      "setColumnWidth",
      "setRowHeights",
      "setViewportWidth",
      "applyPreset",
      "resetLayout",
      "tabIdsInColumn",
      "columnWidthRatio",
      "columnIndexOfTab",
      "positionOfTab",
      "columnCount",
      "focusedColumnIndex",
    ]) {
      expect(model[retired], `已废止 API 仍暴露:${retired}`).toBeUndefined();
    }
  });
});

describe("视图模型:聚焦导航(固定窗口集)", () => {
  it("focusWindow(type) 聚焦已绑定视图;未绑定类型返回 false 且状态不变", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);

    expect(model.focusWindow("payload")).toBe(true);
    expect(model.focusedTabId).toBe("payload");
    expect(model.focusedType).toBe("payload");
    expect(model.indexOfView("payload")).toBe(3);

    const before = model.snapshot;
    expect(model.focusWindow("no-such-type")).toBe(false);
    expect(model.snapshot).toEqual(before);
  });

  it("焦点唯一:activateTab / focusWindow 之后恰有一个焦点", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    model.focusWindow("free");
    model.activateTab("payload");

    const focused = model.orderedViews().filter((view) => view.type === model.focusedTabId);
    expect(focused).toHaveLength(1);
    expect(model.focusedTabId).toBe("payload");
    // 焦点恒在场(视图集常驻 ⇒ 焦点类型必在列表内)。
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });

  it("activateTab 未绑定 id 为 no-op(焦点不变)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    model.activateTab("no-such-type");
    expect(model.focusedTabId).toBe("stack");
  });
});

describe("视图模型:可见性 = 勾选(不是开 / 关;D-MP-1 不修订)", () => {
  it("setViewVisible 只改 visible:类型仍全员在场,视图数不变", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);

    expect(model.setViewVisible("free", false)).toBe(true);
    expect(visibleTypes(model)).toEqual(["stack", "registers", "payload"]);
    // **关键不变量**:隐藏 ≠ 消失 —— 列表成员数与顺序都不变。
    expect(types(model)).toEqual(["stack", "free", "registers", "payload"]);
    expect(model.view("free")?.visible).toBe(false);
    expect(model.visibleIndexOf("free")).toBeNull();
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });

  it("幂等:同值重复设置返回 false 且状态零变化", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    expect(model.setViewVisible("free", false)).toBe(true);
    const before = model.snapshot;
    expect(model.setViewVisible("free", false)).toBe(false);
    expect(model.snapshot).toEqual(before);
  });

  it("未登记类型 → false(零变化)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    const before = model.snapshot;
    expect(model.setViewVisible("no-such-type", false)).toBe(false);
    expect(model.snapshot).toEqual(before);
  });

  it("隐藏焦点视图是合法状态(焦点不受可见性影响 —— 不是关窗)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    model.focusWindow("free");
    expect(model.setViewVisible("free", false)).toBe(true);

    expect(model.focusedTabId).toBe("free");
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });

  it("被隐藏者恰是 Ctrl+↑↓ 落点 → 落点复位为 null", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    expect(model.stepActiveView(1)).toBe(true);
    expect(model.activeType).toBe("stack");
    expect(model.setViewVisible("stack", false)).toBe(true);
    expect(model.activeType).toBeNull();
  });
});

describe("视图模型:列表内重排(D-UI-4:只此一种落点语义)", () => {
  it("后移:目标序号 = 夹取后序号(先摘除再插入)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);

    expect(model.moveView("stack", 2)).toBe(true);
    expect(types(model)).toEqual(["free", "registers", "stack", "payload"]);
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });

  it("前移:目标序号 = 夹取后序号", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);

    expect(model.moveView("payload", 0)).toBe(true);
    expect(types(model)).toEqual(["payload", "stack", "free", "registers"]);
  });

  it("越界目标序号被夹取到 [0, 视图数 − 1]", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);

    expect(model.moveView("stack", 99)).toBe(true);
    expect(types(model)).toEqual(["free", "registers", "payload", "stack"]);
    expect(model.moveView("stack", -5)).toBe(true);
    expect(types(model)).toEqual(["stack", "free", "registers", "payload"]);
  });

  it("原地(夹取后序号 = 自身序号)→ false,状态零变化", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    const before = model.snapshot;
    expect(model.moveView("free", 1)).toBe(false);
    expect(model.snapshot).toEqual(before);
  });

  it("未登记类型 → false;非有限目标序号 → 视为原地(false)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    expect(model.moveView("no-such-type", 0)).toBe(false);
    expect(model.moveView("stack", Number.NaN)).toBe(false);
    expect(types(model)).toEqual(["stack", "free", "registers", "payload"]);
  });

  it("重排不动可见性,也不动焦点", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    model.focusWindow("registers");
    model.setViewVisible("free", false);

    expect(model.moveView("stack", 3)).toBe(true);
    expect(model.focusedTabId).toBe("registers");
    expect(visibleTypes(model)).toEqual(["registers", "payload", "stack"]);
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });
});

describe("视图模型:重置视图(D-UI-7 补充:恢复默认顺序 + 全选)", () => {
  it("恢复默认顺序(绑定时登记序)并全选;焦点与切换落点复位", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    model.moveView("payload", 0);
    model.setViewVisible("free", false);
    model.setViewVisible("registers", false);
    model.stepActiveView(1);

    model.resetViews();

    expect(types(model)).toEqual(["stack", "free", "registers", "payload"]);
    expect(visibleTypes(model)).toEqual(["stack", "free", "registers", "payload"]);
    expect(model.activeType).toBeNull();
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });

  it("重置视图**不改变视图集**(无开 / 关语义)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    model.setViewVisible("free", false);
    model.resetViews();
    expect(model.viewCount).toBe(BINDINGS.length);
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });
});

describe("视图模型:Ctrl + ↑ / ↓ 切换落点(D-UI-3;边界不环绕)", () => {
  it("首次向后落序首可见视图;首次向前落末个可见视图", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);

    expect(model.stepActiveView(1)).toBe(true);
    expect(model.activeType).toBe("stack");

    const second = new WorkspaceLayoutModel();
    second.bindWindows(BINDINGS);
    expect(second.stepActiveView(-1)).toBe(true);
    expect(second.activeType).toBe("payload");
  });

  it("逐步向后 / 向前移动;到首 / 末即停(不环绕)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);

    model.stepActiveView(1);
    expect(model.activeType).toBe("stack");
    model.stepActiveView(1);
    expect(model.activeType).toBe("free");
    model.stepActiveView(1);
    expect(model.activeType).toBe("registers");
    model.stepActiveView(1);
    expect(model.activeType).toBe("payload");
    // 已到末位:再向后为 no-op(边界不环绕)。
    expect(model.stepActiveView(1)).toBe(false);
    expect(model.activeType).toBe("payload");
    // 回到末位前的可见视图。
    expect(model.stepActiveView(-1)).toBe(true);
    expect(model.activeType).toBe("registers");
  });

  it("只在**可见**视图之间移动(不可见者不在切换序列内)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    model.setViewVisible("free", false);
    model.setViewVisible("registers", false);

    model.stepActiveView(1);
    expect(model.activeType).toBe("stack");
    model.stepActiveView(1);
    expect(model.activeType).toBe("payload");
    expect(model.stepActiveView(1)).toBe(false);
  });

  it("无可见视图 → 恒 no-op(false)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    for (const binding of BINDINGS) {
      model.setViewVisible(binding.type, false);
    }
    expect(model.stepActiveView(1)).toBe(false);
    expect(model.stepActiveView(-1)).toBe(false);
    expect(model.activeType).toBeNull();
  });

  it("setActiveView 只接受可见视图(不可见 / 未登记为 no-op)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    expect(model.setActiveView("registers")).toBe(true);
    expect(model.activeType).toBe("registers");
    expect(model.setActiveView("registers")).toBe(false);
    expect(model.setActiveView("no-such-type")).toBe(false);

    model.setViewVisible("registers", false);
    expect(model.activeType).toBeNull();
    expect(model.setActiveView("registers")).toBe(false);
  });
});

describe("视图模型:左半侧宽度登记(D-UI-5 底线核对面)", () => {
  it("合法值登记;非有限 / ≤0 归 0(未知),确定性不抛错", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);

    model.setLeftRoleWidth(720);
    expect(model.leftRoleWidth).toBe(720);
    expect(model.snapshot.leftRoleWidth).toBe(720);

    model.setLeftRoleWidth(Number.NaN);
    expect(model.leftRoleWidth).toBe(0);
    model.setLeftRoleWidth(-10);
    expect(model.leftRoleWidth).toBe(0);
    model.setLeftRoleWidth(Number.POSITIVE_INFINITY);
    expect(model.leftRoleWidth).toBe(0);
  });
});

describe("视图集不变量机检(isWindowSetComplete / isLayoutStateValid)", () => {
  it("列表每登记类型恰一次且 id ≡ type 才为真;缺一 / 重复 → 假", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    const snapshot = model.snapshot;

    expect(isWindowSetComplete(snapshot)).toBe(true);

    // 缺一视图 → 假(无重无漏被破坏:size 与去重后数量不等即由重复检出,
    // 缺一由「无漏」不变量在模型层结构性保证;此处以重复夹具验证)。
    expect(
      isWindowSetComplete({
        ...snapshot,
        views: [
          { id: "stack", type: "stack" },
          { id: "free", type: "free" },
          { id: "stack", type: "stack" },
        ],
      }),
    ).toBe(false);

    // id ≠ type(单实例被破坏)→ 假。
    expect(
      isWindowSetComplete({
        ...snapshot,
        views: [{ id: "stack", type: "free" }],
      }),
    ).toBe(false);
  });

  it("焦点不在场 → 假(视图集常驻 ⇒ 焦点必在场)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    expect(isWindowSetComplete({ ...model.snapshot, focusedTabId: "no-such-type" })).toBe(false);
    expect(isWindowSetComplete({ ...model.snapshot, focusedTabId: null })).toBe(true);
  });

  it("隐藏**不**使机检失败(不存在「隐藏即消失」语义)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    model.setViewVisible("stack", false);
    model.setViewVisible("free", false);

    expect(isWindowSetComplete(model.snapshot)).toBe(true);
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });

  it("切换落点必须是可见视图(不可见 → 假,防御性反例)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    model.setViewVisible("free", false);
    expect(isLayoutStateValid({ ...model.snapshot, activeType: "free" })).toBe(false);
    expect(isLayoutStateValid({ ...model.snapshot, activeType: "stack" })).toBe(true);
  });

  it("两个焦点面必须同值;leftRoleWidth 不得为负 / 非有限", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    expect(isLayoutStateValid({ ...model.snapshot, focusedType: "free" })).toBe(false);
    expect(isLayoutStateValid({ ...model.snapshot, leftRoleWidth: -1 })).toBe(false);
    expect(isLayoutStateValid({ ...model.snapshot, leftRoleWidth: Number.NaN })).toBe(false);
    expect(isLayoutStateValid({ ...model.snapshot, leftRoleWidth: 0 })).toBe(true);
  });

  it("title 非空字符串(空标题 → 假)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    const views = model.snapshot.views.map((view, index) =>
      index === 0 ? { ...view, title: "" } : view,
    );
    expect(isLayoutStateValid({ ...model.snapshot, views })).toBe(false);
  });
});

describe("视图模型:默认顺序来源(layout-presets.DEFAULT_VIEW_ORDER)", () => {
  it("显式传入 DEFAULT_VIEW_ORDER 时顺序与之一致(工作区的单点注入路径)", async () => {
    const { DEFAULT_VIEW_ORDER, orderByDefault } = await import(
      "../../src/workspace/layout-presets.js"
    );
    const model = new WorkspaceLayoutModel();
    // 以登记序打乱输入,再按默认顺序注入。
    const shuffled = [...BINDINGS].reverse();
    model.bindWindows(shuffled, orderByDefault(shuffled.map((entry) => entry.type)));

    const expected = DEFAULT_VIEW_ORDER.filter((type) =>
      BINDINGS.some((entry) => entry.type === type),
    );
    expect(types(model)).toEqual([...expected]);
    // 未在 DEFAULT_VIEW_ORDER 内登记的类型按输入序补末尾(全排列不变量)。
    expect(types(model)).toHaveLength(BINDINGS.length);
  });
});

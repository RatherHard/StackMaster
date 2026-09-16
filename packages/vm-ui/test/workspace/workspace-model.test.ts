/**
 * 工作区布局模型行为测试(WP-F5 列式滚动平铺 × WP-71 固定窗口集 / D-MP-1):
 * 窗口集绑定(登记集合各恰一实例)/ 缺省列布局(登记序、每列一窗)/ 显式列分组 /
 * 移动落点语义(moveTab,WP-F5 已定案保留)/ 焦点唯一 / 平铺不变量(不存在空列)。
 *
 * WP-71 变更口径:标签页「打开 / 关闭生命周期」退场——不存在 `openTab` /
 * `closeTab` / 类型内序号;窗口集由 `bindWindows()` 一次性绑定(id ≡ 类型键)。
 */
import { describe, expect, it } from "vitest";

import {
  WorkspaceLayoutModel,
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

describe("工作区布局模型:窗口集绑定(D-MP-1 固定窗口集)", () => {
  it("绑定登记集合:每种类型恰一实例,窗口集无重无漏(结构性不变量)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);

    expect(model.tabCount).toBe(BINDINGS.length);
    expect(model.tabs().map((info) => info.type)).toEqual(BINDINGS.map((entry) => entry.type));
    // id ≡ 类型键:单实例是结构性保证,同类型重复实例无法表达。
    expect(model.tabs().map((info) => info.id)).toEqual(BINDINGS.map((entry) => entry.type));
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });

  it("标题 = 绑定时的 label,不含类型内序号(序号语义随单实例退场)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);

    expect(model.tabs().map((info) => info.title)).toEqual(["栈视图", "自由视图", "寄存器视图", "Payload 搭建"]);
    expect(model.tab("stack")?.title).toBe("栈视图");
  });

  it("缺省布局 = 登记序、每列一窗(WP-72 落 P0 预设前的最小形态)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);

    expect(model.columnCount).toBe(4);
    expect(model.snapshot.columns.map((column) => column.tabIds)).toEqual([
      ["stack"],
      ["free"],
      ["registers"],
      ["payload"],
    ]);
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });

  it("显式列分组:按给定列应用(WP-72 预设的单点入口)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS, [["stack", "free"], ["registers"], ["payload"]]);

    expect(model.snapshot.columns.map((column) => column.tabIds)).toEqual([
      ["stack", "free"],
      ["registers"],
      ["payload"],
    ]);
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });

  it("显式列分组的兜底:未覆盖类型按登记序补单窗列;空列 / 未登记键不落地", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS, [["stack"], [], ["no-such-type"], ["free"]]);

    // 空列不落地(平铺不变量);未登记键忽略;registers / payload 未被覆盖 → 补列。
    expect(model.snapshot.columns.map((column) => column.tabIds)).toEqual([
      ["stack"],
      ["free"],
      ["registers"],
      ["payload"],
    ]);
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });

  it("显式列分组中重复出现的类型只落一次(单实例不变量由绑定结构性保证)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS, [["stack", "stack"], ["stack"], ["free"]]);

    const ids = model.snapshot.columns.flatMap((column) => column.tabIds);
    expect(ids.filter((id) => id === "stack")).toEqual(["stack"]);
    // 重复落位键被忽略后该列为空 → 不落地;未覆盖类型补单窗列。
    expect(model.snapshot.columns.map((column) => column.tabIds)).toEqual([
      ["stack"],
      ["free"],
      ["registers"],
      ["payload"],
    ]);
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });

  it("重新绑定(注册表换绑)不产生重复实例,仍恰一实例", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    model.bindWindows(BINDINGS);

    expect(model.tabCount).toBe(BINDINGS.length);
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });

  it("焦点缺省 = 首列首窗;仍存在的焦点在重新绑定时保持,消失的类型回落首窗", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    expect(model.focusedTabId).toBe("stack");

    model.activateTab("registers");
    model.bindWindows(BINDINGS);
    expect(model.focusedTabId).toBe("registers");

    model.bindWindows(BINDINGS.filter((entry) => entry.type !== "registers"));
    expect(model.focusedTabId).toBe("stack");
  });

  it("空登记集合:无列无焦点(模型仍表达空集;组件层窗口集恒非空)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows([]);

    expect(model.columnCount).toBe(0);
    expect(model.tabCount).toBe(0);
    expect(model.focusedTabId).toBeNull();
    expect(model.focusedColumnIndex).toBeNull();
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });

  it("开 / 关生命周期 API 退场:模型不再暴露 openTab / closeTab", () => {
    const model = new WorkspaceLayoutModel() as unknown as Record<string, unknown>;
    expect(model["openTab"]).toBeUndefined();
    expect(model["closeTab"]).toBeUndefined();
  });
});

describe("工作区布局模型:聚焦导航(固定窗口集)", () => {
  it("focusWindow(type) 聚焦已绑定窗口;未绑定类型返回 false 且布局不变", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);

    expect(model.focusWindow("payload")).toBe(true);
    expect(model.focusedTabId).toBe("payload");
    expect(model.focusedColumnIndex).toBe(3);

    const before = model.snapshot;
    expect(model.focusWindow("no-such-type")).toBe(false);
    expect(model.snapshot).toEqual(before);
  });

  it("焦点唯一:activateTab / focusWindow 之后恰有一个焦点", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    model.focusWindow("free");
    model.activateTab("payload");

    const focused = model.snapshot.columns.flatMap((column) => column.tabIds).filter(
      (id) => id === model.focusedTabId,
    );
    expect(focused).toHaveLength(1);
    expect(model.focusedTabId).toBe("payload");
  });

  it("activateTab 未绑定 id 为 no-op(焦点不变)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    model.activateTab("no-such-type");
    expect(model.focusedTabId).toBe("stack");
  });
});

describe("工作区布局模型:移动落点语义(moveTab,WP-F5 已定案保留)", () => {
  it("同列内后移到列尾:插入位扣除自身(先摘除语义)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS, [["stack", "free", "registers"], ["payload"]]);

    model.moveTab("stack", { column: 0, index: 3 });
    expect(model.tabIdsInColumn(0)).toEqual(["free", "registers", "stack"]);
  });

  it("同列原地后移(index = 自身 +1)为 no-op", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS, [["stack", "free"]]);

    model.moveTab("stack", { column: 0, index: 1 });
    expect(model.tabIdsInColumn(0)).toEqual(["stack", "free"]);
  });

  it("跨列前移到后一列:目标列序因源列删除而前移", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS, [["stack", "free", "registers"], ["payload"]]);
    // 把 registers 拖到新列(列 2)。
    model.moveTab("registers", { column: 9, index: 0 });
    expect(model.columnCount).toBe(3);
    expect(model.tabIdsInColumn(2)).toEqual(["registers"]);

    // 把 stack 拖到列 1(源列 0 在目标列之前,stack 摘除后列 0 仍剩 free 非空)。
    model.moveTab("stack", { column: 1, index: 0 });
    expect(model.tabIdsInColumn(1)).toEqual(["stack", "payload"]);
    expect(model.tabIdsInColumn(0)).toEqual(["free"]);
  });

  it("跨列移动到「源列为独窗且位于目标列之前」的列:目标列序前移(源列删除)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);

    model.moveTab("stack", { column: 1, index: 0 });
    // 源列(独窗)删除 → 目标列序前移为 0;插入位 0 = 落至目标列首位。
    expect(model.tabIdsInColumn(0)).toEqual(["stack", "free"]);
    expect(model.columnCount).toBe(3);
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });

  it("拖到列区空白(target.column ≥ 列数)开新列尾插", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);

    model.moveTab("stack", { column: 4, index: 0 });
    expect(model.columnCount).toBe(4);
    expect(model.tabIdsInColumn(3)).toEqual(["stack"]);
    expect(model.focusedColumnIndex).toBe(3);
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });

  it("移动不存在的窗口为 no-op;移动后窗口集完整性不变(无重无漏、无空列)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);

    model.moveTab("no-such-type", { column: 0, index: 0 });
    expect(model.tabCount).toBe(BINDINGS.length);

    model.moveTab("payload", { column: 0, index: 0 });
    model.moveTab("stack", { column: 9, index: 0 });
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });

  it("移动后焦点跟随被移动窗口(WP-F5 语义保留)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);

    model.moveTab("payload", { column: 0, index: 0 });
    expect(model.focusedTabId).toBe("payload");
  });
});

describe("工作区布局模型:窗口集不变量机检(isWindowSetComplete)", () => {
  it("列内 id 全集 ≡ 窗口集键集且每键恰一次才为真", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    const snapshot = model.snapshot;

    expect(isWindowSetComplete(snapshot)).toBe(true);
    // 缺一窗(列内少了 payload)→ 假。
    expect(
      isWindowSetComplete({
        ...snapshot,
        columns: [{ tabIds: ["stack"] }, { tabIds: ["free"] }, { tabIds: ["registers"] }],
      }),
    ).toBe(false);
    // 同一窗落两列(重复实例)→ 假。
    expect(
      isWindowSetComplete({
        ...snapshot,
        columns: [
          { tabIds: ["stack", "free"] },
          { tabIds: ["registers"] },
          { tabIds: ["payload"] },
          { tabIds: ["stack"] },
        ],
      }),
    ).toBe(false);
    // 存在空列(平铺不变量)→ 假。
    expect(
      isWindowSetComplete({
        ...snapshot,
        columns: [
          { tabIds: ["stack", "free", "registers", "payload"] },
          { tabIds: [] },
        ],
      }),
    ).toBe(false);
  });
});

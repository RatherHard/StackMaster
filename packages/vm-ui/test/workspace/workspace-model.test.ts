/**
 * 工作区布局模型行为测试(WP-F5 / FE-WS-01 / FE-WS-02,Q1 v1 列式滚动平铺):
 * 打开分割 / 关闭邻居焦点 / 激活 / 拖拽换位 / 开新列 / 原地 no-op / 序号稳定。
 */
import { describe, expect, it } from "vitest";

import {
  WorkspaceLayoutModel,
  formatTabTitle,
} from "../../src/workspace/workspace-model.js";

/** 确定性 id 生成器(测试内自增)。 */
function ids(): () => string {
  let counter = 0;
  return () => `id-${String((counter += 1))}`;
}

describe("工作区布局模型:打开与分割(FE-WS-02 Hyprland 式)", () => {
  it("首个标签页创建第一列并获得焦点", () => {
    const model = new WorkspaceLayoutModel(ids());
    const id = model.openTab("stack", "栈视图");

    expect(model.columnCount).toBe(1);
    expect(model.tabCount).toBe(1);
    expect(model.focusedTabId).toBe(id);
    expect(model.tab(id)?.title).toBe("栈视图 1");
  });

  it("新标签页落入焦点列并分割:插入到焦点标签页之后(同列两页)", () => {
    const model = new WorkspaceLayoutModel(ids());
    const first = model.openTab("stack", "栈视图");
    const second = model.openTab("free", "自由视图");

    expect(model.columnCount).toBe(1);
    expect(model.tabIdsInColumn(0)).toEqual([first, second]);
    expect(model.focusedTabId).toBe(second);
  });

  it("同类型可多开:类型内序号递增且标题带序号(FE-MV-01)", () => {
    const model = new WorkspaceLayoutModel(ids());
    model.openTab("stack", "栈视图");
    model.openTab("stack", "栈视图");

    const stacks = model.tabs().filter((tab) => tab.type === "stack");
    expect(stacks.map((tab) => tab.title)).toEqual(["栈视图 1", "栈视图 2"]);
  });
});

describe("工作区布局模型:多列(Niri 式列序)", () => {
  it("激活另一列的标签页后,新打开的标签页落入被激活的列", () => {
    const model = new WorkspaceLayoutModel(ids());
    const a = model.openTab("stack", "栈视图");
    const b = model.openTab("free", "自由视图");
    // 拖 b 到新列(列 1),再激活 b:后续打开应落入列 1。
    model.moveTab(b, { column: 9, index: 0 });
    model.activateTab(b);

    const c = model.openTab("registers", "寄存器视图");
    expect(model.columnCount).toBe(2);
    expect(model.tabIdsInColumn(0)).toEqual([a]);
    expect(model.tabIdsInColumn(1)).toEqual([b, c]);
  });

  it("关闭整列后布局无空列(平铺不变量)", () => {
    const model = new WorkspaceLayoutModel(ids());
    const a = model.openTab("stack", "栈视图");
    const b = model.openTab("free", "自由视图");
    model.closeTab(a);
    model.closeTab(b);

    expect(model.columnCount).toBe(0);
    expect(model.tabCount).toBe(0);
    expect(model.focusedTabId).toBeNull();
  });
});

describe("工作区布局模型:关闭与焦点邻居(FE-WS-01)", () => {
  it("关闭非焦点标签页:焦点不变", () => {
    const model = new WorkspaceLayoutModel(ids());
    const a = model.openTab("stack", "栈视图");
    const b = model.openTab("free", "自由视图");
    model.activateTab(a);

    model.closeTab(b);
    expect(model.focusedTabId).toBe(a);
  });

  it("关闭焦点标签页:焦点交给同列后继", () => {
    const model = new WorkspaceLayoutModel(ids());
    const a = model.openTab("stack", "栈视图");
    const b = model.openTab("free", "自由视图");

    model.closeTab(a);
    expect(model.focusedTabId).toBe(b);
  });

  it("关闭列尾焦点页且无后继:焦点交给同列前驱", () => {
    const model = new WorkspaceLayoutModel(ids());
    const a = model.openTab("stack", "栈视图");
    const b = model.openTab("free", "自由视图");

    model.closeTab(b);
    expect(model.focusedTabId).toBe(a);
  });

  it("关闭独列焦点页:焦点交给前一列末尾标签页", () => {
    const model = new WorkspaceLayoutModel(ids());
    const a = model.openTab("stack", "栈视图");
    const b = model.openTab("free", "自由视图");
    // 拖 b 到新列(列 1),关 b(焦点在 b)→ 焦点回到列 0 末尾 = a。
    model.moveTab(b, { column: 5, index: 0 });
    expect(model.columnCount).toBe(2);

    model.closeTab(b);
    expect(model.focusedTabId).toBe(a);
    expect(model.columnCount).toBe(1);
  });

  it("关闭不存在的标签页为 no-op", () => {
    const model = new WorkspaceLayoutModel(ids());
    model.closeTab("no-such");
    expect(model.tabCount).toBe(0);
  });
});

describe("工作区布局模型:拖拽换位(moveTab)", () => {
  it("同列内后移到列尾:插入位扣除自身(先摘除语义)", () => {
    const model = new WorkspaceLayoutModel(ids());
    const a = model.openTab("stack", "栈视图");
    const b = model.openTab("free", "自由视图");
    const c = model.openTab("registers", "寄存器视图");

    // 目标 index = 原数组插入位(index 3 = 列尾);a 摘除后插入位前移。
    model.moveTab(a, { column: 0, index: 3 });
    expect(model.tabIdsInColumn(0)).toEqual([b, c, a]);
  });

  it("同列原地后移(index = 自身 +1)为 no-op", () => {
    const model = new WorkspaceLayoutModel(ids());
    const a = model.openTab("stack", "栈视图");
    const b = model.openTab("free", "自由视图");

    model.moveTab(a, { column: 0, index: 1 });
    expect(model.tabIdsInColumn(0)).toEqual([a, b]);
  });

  it("跨列前移到后一列:目标列序因源列删除而前移", () => {
    const model = new WorkspaceLayoutModel(ids());
    const a = model.openTab("stack", "栈视图");
    const b = model.openTab("free", "自由视图");
    const c = model.openTab("registers", "寄存器视图");
    // 三页同列;把 c 拖到新列(列 1)。
    model.moveTab(c, { column: 9, index: 0 });
    expect(model.columnCount).toBe(2);
    expect(model.tabIdsInColumn(1)).toEqual([c]);

    // 把 a 拖到列 1(源列 0 在目标列 1 之前,a 摘除后列 0 仍剩 b 非空)。
    model.moveTab(a, { column: 1, index: 0 });
    expect(model.tabIdsInColumn(1)).toEqual([a, c]);
    expect(model.tabIdsInColumn(0)).toEqual([b]);
  });

  it("拖到列区空白(target.column ≥ 列数)开新列尾插", () => {
    const model = new WorkspaceLayoutModel(ids());
    const a = model.openTab("stack", "栈视图");
    const b = model.openTab("free", "自由视图");

    model.moveTab(b, { column: 1, index: 0 });
    expect(model.columnCount).toBe(2);
    expect(model.tabIdsInColumn(0)).toEqual([a]);
    expect(model.tabIdsInColumn(1)).toEqual([b]);
    expect(model.focusedColumnIndex).toBe(1);
  });

  it("移动不存在的标签页为 no-op", () => {
    const model = new WorkspaceLayoutModel(ids());
    model.moveTab("no-such", { column: 0, index: 0 });
    expect(model.tabCount).toBe(0);
  });
});

describe("工作区布局模型:杂项定案", () => {
  it("类型内序号只增不减:关闭后新开不复用旧序号(标题稳定)", () => {
    const model = new WorkspaceLayoutModel(ids());
    const a = model.openTab("stack", "栈视图");
    model.openTab("stack", "栈视图");
    model.closeTab(a);

    const id = model.openTab("stack", "栈视图");
    expect(model.tab(id)?.title).toBe("栈视图 3");
  });

  it("formatTabTitle = 类型名 + 序号(FE-WS-01 标题栏定案)", () => {
    expect(formatTabTitle("栈视图", 2)).toBe("栈视图 2");
  });
});

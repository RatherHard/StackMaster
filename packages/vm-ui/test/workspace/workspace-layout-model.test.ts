/**
 * 工作区**布局状态**行为测试(WP-72:列宽 / 窗高进模型快照面,纯状态机、无 DOM)。
 *
 * 固定面:
 *  - 列宽 = **视口占比**(进入 `layoutSnapshot.columns[].widthRatio`),夹取到
 *    `MIN_COLUMN_WIDTH` 护栏(基准 = `setViewportWidth` 登记的视口宽);
 *  - 同列窗高 = **比例**(`layoutSnapshot.columns[].rowHeights`,和恒为 1;单窗列恒 [1]);
 *  - `applyPreset` / `resetLayout`:列分组回当前视口宽对应的预设,尺寸调整清空;
 *  - `openColumnAt`:Niri「列间空隙新建列位」落点在模型侧的显式 API;
 *  - `isLayoutStateValid`:布局不变量机检(可断言面)。
 */
import { describe, expect, it } from "vitest";

import {
  LAYOUT_PRESET_P0,
  LAYOUT_PRESET_P1,
  LAYOUT_PRESET_P2,
  MIN_COLUMN_WIDTH,
  selectLayoutPreset,
} from "../../src/workspace/layout-presets.js";
import {
  WorkspaceLayoutModel,
  isLayoutStateValid,
  isWindowSetComplete,
  type WorkspaceWindowBinding,
} from "../../src/workspace/workspace-model.js";

/** 登记集合替身(等价默认注册表 `list()` 的收敛形态)。 */
const BINDINGS: readonly WorkspaceWindowBinding[] = [
  { type: "stack", label: "栈视图" },
  { type: "free", label: "自由视图" },
  { type: "registers", label: "寄存器视图" },
  { type: "payload", label: "Payload 搭建" },
];

/** 全量登记集合替身(预设三表按**十个登记类型**定义,故预设用例用全量集)。 */
const FULL_BINDINGS: readonly WorkspaceWindowBinding[] = [
  { type: "stack", label: "栈视图" },
  { type: "free", label: "自由视图" },
  { type: "registers", label: "寄存器视图" },
  { type: "payload", label: "Payload 搭建" },
  { type: "debug", label: "指令视图" },
  { type: "structure", label: "结构视图" },
  { type: "call-stack", label: "调用栈" },
  { type: "memory-diff", label: "内存 diff" },
  { type: "timeline", label: "时间线" },
  { type: "checkpoints", label: "checkpoint" },
];

const WIDE_VIEWPORT = 1200;
/** 宽屏档下单列宽度护栏(占比形态)。 */
const MIN_RATIO = MIN_COLUMN_WIDTH / WIDE_VIEWPORT;

describe("布局状态:绑定时的缺省尺寸(视口占比 / 窗高比例)", () => {
  it("缺省列宽 = 视口等分(1 / 列数);未登记视口宽时不夹取", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);

    expect(model.snapshot.viewportWidth).toBe(0);
    expect(model.snapshot.columns.map((column) => column.widthRatio)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(model.snapshot.columns.map((column) => [...column.rowHeights])).toEqual([[1], [1], [1], [1]]);
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });

  it("登记视口宽后列宽夹取到最小可读宽(等分小于护栏时抬升,横向滚动可达)", () => {
    const model = new WorkspaceLayoutModel();
    model.setViewportWidth(1000);
    model.bindWindows(BINDINGS);

    // 等分 0.25 × 1000 = 250px < 452.4px 护栏 → 抬升到 0.4524。
    expect(model.snapshot.columns.map((column) => column.widthRatio)).toEqual([
      MIN_COLUMN_WIDTH / 1000,
      MIN_COLUMN_WIDTH / 1000,
      MIN_COLUMN_WIDTH / 1000,
      MIN_COLUMN_WIDTH / 1000,
    ]);
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });

  it("P0 预设注入:逐列窗高比例 = 等分(2 窗 [1/2,1/2]、3 窗 [1/3,1/3,1/3]、单窗 [1])", () => {
    const model = new WorkspaceLayoutModel();
    model.setViewportWidth(WIDE_VIEWPORT);
    model.bindWindows(FULL_BINDINGS, LAYOUT_PRESET_P0.columns);

    expect(model.snapshot.columns.map((column) => column.widthRatio)).toEqual([
      MIN_RATIO,
      MIN_RATIO,
      MIN_RATIO,
      MIN_RATIO,
      MIN_RATIO,
    ]);
    expect(model.snapshot.columns.map((column) => [...column.rowHeights])).toEqual([
      [0.5, 0.5],
      [0.5, 0.5],
      [1],
      [0.5, 0.5],
      [1 / 3, 1 / 3, 1 / 3],
    ]);
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });

  it("setViewportWidth:非正 / 非有限输入归 0(未知基准 = 不夹取,确定性)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    model.setViewportWidth(2000);
    model.setViewportWidth(Number.NaN);
    expect(model.snapshot.viewportWidth).toBe(0);
    model.setViewportWidth(-5);
    expect(model.snapshot.viewportWidth).toBe(0);
  });
});

describe("布局状态:setColumnWidth(列宽,夹取护栏)", () => {
  it("合法占比逐列生效(其他列不受影响)", () => {
    const model = new WorkspaceLayoutModel();
    model.setViewportWidth(WIDE_VIEWPORT);
    model.bindWindows(BINDINGS, [["stack"], ["free"], ["registers"], ["payload"]]);

    expect(model.setColumnWidth(1, 0.6)).toBe(true);
    const ratios = model.snapshot.columns.map((column) => column.widthRatio);
    expect(ratios[1]).toBeCloseTo(0.6, 9);
    expect(ratios[0]).toBeCloseTo(MIN_RATIO, 9);
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });

  it("低于护栏的占比被抬升到 MIN_COLUMN_WIDTH / 视口宽(列宽最小护栏)", () => {
    const model = new WorkspaceLayoutModel();
    model.setViewportWidth(WIDE_VIEWPORT);
    model.bindWindows(BINDINGS);

    model.setColumnWidth(0, 0.05);
    expect(model.snapshot.columns[0]?.widthRatio).toBeCloseTo(MIN_RATIO, 9);
    expect((model.snapshot.columns[0]?.widthRatio ?? 0) * WIDE_VIEWPORT).toBeCloseTo(MIN_COLUMN_WIDTH, 6);
  });

  it("超过全宽的占比夹取到 1(全宽档为上限)", () => {
    const model = new WorkspaceLayoutModel();
    model.setViewportWidth(WIDE_VIEWPORT);
    model.bindWindows(BINDINGS);

    expect(model.setColumnWidth(2, 3)).toBe(true);
    expect(model.snapshot.columns[2]?.widthRatio).toBe(1);
  });

  it("非法占比(≤0 / 非有限)与越界列序 → false 且布局不变", () => {
    const model = new WorkspaceLayoutModel();
    model.setViewportWidth(WIDE_VIEWPORT);
    model.bindWindows(BINDINGS);
    const before = model.snapshot;

    for (const ratio of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(model.setColumnWidth(0, ratio)).toBe(false);
    }
    expect(model.setColumnWidth(-1, 0.5)).toBe(false);
    expect(model.setColumnWidth(9, 0.5)).toBe(false);
    expect(model.snapshot).toEqual(before);
  });
});

describe("布局状态:setRowHeights(同列窗高比例)", () => {
  it("相对比例被归一化(和恒为 1),逐列独立", () => {
    const model = new WorkspaceLayoutModel();
    model.setViewportWidth(WIDE_VIEWPORT);
    model.bindWindows(BINDINGS, [["stack", "free"], ["registers", "payload"]]);

    expect(model.setRowHeights(0, [3, 1])).toBe(true);
    expect(model.snapshot.columns[0]?.rowHeights).toEqual([0.75, 0.25]);
    expect(model.snapshot.columns[1]?.rowHeights).toEqual([0.5, 0.5]);
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });

  it("单窗列恒 [1](自动占满列高),传入任何正比例都归一化为 1", () => {
    const model = new WorkspaceLayoutModel();
    model.setViewportWidth(WIDE_VIEWPORT);
    model.bindWindows(BINDINGS, [["stack", "free"], ["registers"]]);

    expect(model.setRowHeights(1, [4])).toBe(true);
    expect(model.snapshot.columns[1]?.rowHeights).toEqual([1]);
  });

  it("长度不符 / 含非正或非有限值 / 越界列序 → false 且布局不变", () => {
    const model = new WorkspaceLayoutModel();
    model.setViewportWidth(WIDE_VIEWPORT);
    model.bindWindows(BINDINGS, [["stack", "free"], ["registers"]]);
    const before = model.snapshot;

    expect(model.setRowHeights(0, [1])).toBe(false);
    expect(model.setRowHeights(0, [1, 0])).toBe(false);
    expect(model.setRowHeights(0, [1, -1])).toBe(false);
    expect(model.setRowHeights(0, [1, Number.NaN])).toBe(false);
    expect(model.setRowHeights(5, [1])).toBe(false);
    expect(model.snapshot).toEqual(before);
  });
});

describe("布局状态:applyPreset / resetLayout(预设应用与重置语义)", () => {
  it("applyPreset:列分组回预设,尺寸调整清空为缺省,焦点保持", () => {
    const model = new WorkspaceLayoutModel();
    model.setViewportWidth(WIDE_VIEWPORT);
    model.bindWindows(BINDINGS, [["stack"], ["free"], ["registers"], ["payload"]]);
    model.focusWindow("payload");
    model.setColumnWidth(0, 0.9);
    model.setRowHeights(0, [1]);

    model.applyPreset([["stack", "free"], ["registers"], ["payload"]]);
    expect(model.snapshot.columns.map((column) => [...column.tabIds])).toEqual([
      ["stack", "free"],
      ["registers"],
      ["payload"],
    ]);
    expect(model.snapshot.columns.map((column) => column.widthRatio)).toEqual([MIN_RATIO, MIN_RATIO, MIN_RATIO]);
    expect(model.snapshot.columns.map((column) => [...column.rowHeights])).toEqual([[0.5, 0.5], [1], [1]]);
    expect(model.focusedTabId).toBe("payload");
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });

  it("applyPreset:未覆盖类型按登记序补单窗列(不变量兜底)", () => {
    const model = new WorkspaceLayoutModel();
    model.setViewportWidth(WIDE_VIEWPORT);
    model.bindWindows(BINDINGS, [["stack"], ["free"], ["registers"]]);

    model.applyPreset([["stack", "registers"]]);
    expect(model.snapshot.columns.map((column) => [...column.tabIds])).toEqual([
      ["stack", "registers"],
      ["free"],
      ["payload"],
    ]);
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });

  it("resetLayout:清空列宽 / 窗高调整并回到**当前视口宽**对应的预设(宽屏 = P0)", () => {
    const model = new WorkspaceLayoutModel();
    model.setViewportWidth(WIDE_VIEWPORT);
    model.bindWindows(FULL_BINDINGS, LAYOUT_PRESET_P1.columns);
    model.setColumnWidth(0, 0.8);
    model.setRowHeights(0, [0.8, 0.1, 0.1]);
    expect(selectLayoutPreset(WIDE_VIEWPORT).id).toBe("P0");

    model.resetLayout();

    // 「重置布局 = 清空调整 + 应用 selectLayoutPreset(当前宽度)」的等价关系。
    const preset = selectLayoutPreset(model.snapshot.viewportWidth);
    expect(preset.id).toBe("P0");
    expect(model.snapshot.columns.map((column) => [...column.tabIds])).toEqual(
      LAYOUT_PRESET_P0.columns.map((column) => [...column]),
    );
    expect(model.snapshot.columns.map((column) => column.widthRatio)).toEqual(
      LAYOUT_PRESET_P0.columns.map(() => MIN_RATIO),
    );
    expect(model.snapshot.columns[0]?.rowHeights).toEqual([0.5, 0.5]);
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });

  it("resetLayout:窄条视口回到该宽度的降级形态(P2 单列),不回 P0", () => {
    const model = new WorkspaceLayoutModel();
    model.setViewportWidth(400);
    model.bindWindows(FULL_BINDINGS, LAYOUT_PRESET_P0.columns);
    model.setColumnWidth(0, 1);

    model.resetLayout();

    expect(selectLayoutPreset(400).id).toBe("P2");
    expect(model.snapshot.columns).toHaveLength(1);
    expect(model.snapshot.columns[0]?.tabIds).toEqual([...LAYOUT_PRESET_P2.columns[0]!]);
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });
});

describe("布局状态:openColumnAt(Niri「列间空隙新建列位」落点)", () => {
  it("在指定列序位置新建列(中间插入,源列非空时列序不变)", () => {
    const model = new WorkspaceLayoutModel();
    model.setViewportWidth(WIDE_VIEWPORT);
    model.bindWindows(BINDINGS, [["stack", "free"], ["registers"], ["payload"]]);

    model.openColumnAt("stack", 1);

    expect(model.snapshot.columns.map((column) => [...column.tabIds])).toEqual([
      ["free"],
      ["stack"],
      ["registers"],
      ["payload"],
    ]);
    expect(model.focusedTabId).toBe("stack");
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });

  it("源列被清空时插入位前移(与「源列删除」一致)", () => {
    const model = new WorkspaceLayoutModel();
    model.setViewportWidth(WIDE_VIEWPORT);
    model.bindWindows(BINDINGS, [["stack"], ["free", "registers"], ["payload"]]);

    model.openColumnAt("stack", 1);

    expect(model.snapshot.columns.map((column) => [...column.tabIds])).toEqual([
      ["stack"],
      ["free", "registers"],
      ["payload"],
    ]);
  });

  it("列序超出列数 → 尾插(与 moveTab 的「≥ 列数 = 开新列」语义同形)", () => {
    const model = new WorkspaceLayoutModel();
    model.setViewportWidth(WIDE_VIEWPORT);
    model.bindWindows(BINDINGS, [["stack"], ["free", "registers"], ["payload"]]);

    model.openColumnAt("payload", 9);

    expect(model.snapshot.columns.at(-1)?.tabIds).toEqual(["payload"]);
    expect(model.snapshot.columns).toHaveLength(3);
    expect(isWindowSetComplete(model.snapshot)).toBe(true);
  });

  it("未登记窗口 / 空布局为 no-op", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS, [["stack"], ["free"]]);
    const before = model.snapshot;

    model.openColumnAt("no-such-type", 0);
    expect(model.snapshot).toEqual(before);
  });
});

describe("布局不变量机检(isLayoutStateValid)", () => {
  it("绑定后的快照为真(列宽 ≥ 护栏、窗高和 = 1、列长一致)", () => {
    const model = new WorkspaceLayoutModel();
    model.setViewportWidth(WIDE_VIEWPORT);
    model.bindWindows(BINDINGS, LAYOUT_PRESET_P0.columns);
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
  });

  it("列宽低于护栏 → 假", () => {
    const model = new WorkspaceLayoutModel();
    model.setViewportWidth(WIDE_VIEWPORT);
    model.bindWindows(BINDINGS, [["stack", "free"]]);
    const snapshot = model.snapshot;
    expect(
      isLayoutStateValid({
        ...snapshot,
        columns: snapshot.columns.map((column) => ({ ...column, widthRatio: 0.01 })),
      }),
    ).toBe(false);
  });

  it("窗高比例和 ≠ 1 / 长度 ≠ 列长 / 单窗列非 [1] → 假", () => {
    const model = new WorkspaceLayoutModel();
    model.setViewportWidth(WIDE_VIEWPORT);
    model.bindWindows(BINDINGS, [["stack", "free"], ["registers"]]);
    const snapshot = model.snapshot;

    expect(
      isLayoutStateValid({
        ...snapshot,
        columns: [
          { tabIds: ["stack", "free"], widthRatio: 0.5, rowHeights: [0.6, 0.6] },
          { tabIds: ["registers"], widthRatio: 0.5, rowHeights: [1] },
        ],
      }),
    ).toBe(false);
    expect(
      isLayoutStateValid({
        ...snapshot,
        columns: [
          { tabIds: ["stack", "free"], widthRatio: 0.5, rowHeights: [1] },
          { tabIds: ["registers"], widthRatio: 0.5, rowHeights: [1] },
        ],
      }),
    ).toBe(false);
    expect(
      isLayoutStateValid({
        ...snapshot,
        columns: [
          { tabIds: ["stack", "free"], widthRatio: 0.5, rowHeights: [0.5, 0.5] },
          { tabIds: ["registers"], widthRatio: 0.5, rowHeights: [0.5, 0.5] },
        ],
      }),
    ).toBe(false);
  });

  it("视口宽未知(0)时不校验像素护栏,仅校验占比形态(> 0 且 ≤ 1)", () => {
    const model = new WorkspaceLayoutModel();
    model.bindWindows(BINDINGS);
    expect(model.snapshot.viewportWidth).toBe(0);
    expect(isLayoutStateValid(model.snapshot)).toBe(true);
    const snapshot = model.snapshot;
    expect(
      isLayoutStateValid({
        ...snapshot,
        columns: snapshot.columns.map((column) => ({ ...column, widthRatio: 0 })),
      }),
    ).toBe(false);
  });
});

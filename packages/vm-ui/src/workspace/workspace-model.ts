/**
 * 工作区布局模型(WP-F5 / FE-WS-01 / FE-WS-02,Q1 定案 v1 = 列式滚动平铺;
 * WP-71 起 = D-MP-1 固定窗口集;WP-72 起 = Niri 式尺寸状态)。
 *
 * 布局语义(Niri × Hyprland 的最小可演示形态,主控定案):
 *  - 工作区 = **列的有序序列**;列间水平滚动可达任意列(Niri 式);
 *  - 列内 = 窗口的有序序列,纵向二叉分割——同列窗口按**窗高比例**分配列高
 *    (Hyprland 式);
 *  - **拖拽排布**:窗口可移动到任意列的任意位置(呈现层把指针落点翻译为
 *    `{column, index}` 目标);「列间空隙」落点经 `openColumnAt` 在指定列序
 *    位置新建列位(Niri 语义,WP-72 显式化);
 *  - 焦点:唯一 focusedTabId;焦点列 = 焦点窗口所在列。
 *
 * 窗口集(D-MP-1 定案,WP-71 «固定窗口工作区模型»):
 *  - 窗口集合 = **注册表登记的全部类型、各恰一个实例、常驻**;窗口没有开 /
 *    关状态,只有「视口内 / 暂离(条带滚出视野)」——后者是呈现层滚动语义,
 *    模型不表达生命周期;
 *  - 一次性绑定经 `bindWindows()`(绑定集 = 注册表 `list()` 的收敛形态);
 *    窗口 id ≡ 类型键 ⇒ **单实例是结构性保证**(同类型重复实例无法表达);
 *  - 标题 = 绑定时刻由调用方按注册表 label(可带 i18n 键)**求值固化**
 *    (绑定后不随 locale 切换追溯;无「类型内序号」——单实例下无意义);
 *  - 保留不变量:列式平铺(**不存在空列**)、焦点唯一、`moveTab` 落点语义
 *    (含「`target.column ≥ 列数` = 开新列尾插」与同列 / 跨列索引修正,
 *    WP-F5 已定案)。
 *
 * 尺寸状态(WP-72 «布局状态进模型»,可断言、可重置):
 *  - **列宽 = 视口占比**(`widthRatio ∈ (0, 1]`,1 = 全宽):以占比表达使窗口
 *    变宽 / 变窄时列宽按比例随动;夹取到**可读性护栏**——像素宽度不得小于
 *    `MIN_COLUMN_WIDTH`(十六进制行不折行的最小可读宽度,推导式见
 *    layout-presets.ts)。护栏基准 = `setViewportWidth()` 登记的视口宽
 *    (未知 = 0 时不夹取,只保证占比形态合法);
 *  - **同列窗高 = 比例**(`rowHeights`,和恒为 1):单窗列恒 `[1]`(自动占满
 *    列高);列内窗口数变化 / 预设应用时重置为等分;
 *  - `applyPreset(columns)` / `resetLayout()`:列分组回预设(尺寸调整清空为
 *    缺省),**焦点保持**(窗口集不变);`resetLayout` = 「清空调整 + 应用当前
 *    视口宽对应的预设」(宽屏即回到 P0,窄屏回到该宽度的降级形态)。
 *
 * 纯状态机:无 DOM、无 IO;类型键为开放 string(对齐 tab-registry 的可扩展
 * 结构);预设表(默认列排布的唯一来源)只经 `bindWindows` / `applyPreset` 的
 * `columns` 参数流入,模型自身不持有任何预设字面量。
 */

import { MIN_COLUMN_WIDTH, selectLayoutPreset } from "./layout-presets.js";

/** 单个窗口的布局态(id ≡ 类型键;单实例由此结构性保证)。 */
export interface WorkspaceTabInfo {
  readonly id: string;
  /** 窗口类型键(注册表条目键;开放 string)。 */
  readonly type: string;
  /** 展示标题(工作区按注册表 label 于绑定时刻求值固化)。 */
  readonly title: string;
}

/** 单列的布局态(列内窗口 id 有序 + 尺寸状态)。 */
export interface WorkspaceColumnState {
  readonly tabIds: readonly string[];
  /** 列宽(视口占比;0 < widthRatio ≤ 1,1 = 全宽)。 */
  readonly widthRatio: number;
  /** 同列窗高比例(长度 = `tabIds.length`,和恒为 1;单窗列恒 `[1]`)。 */
  readonly rowHeights: readonly number[];
}

/** 窗口位置。 */
export interface TabPosition {
  readonly column: number;
  readonly index: number;
}

/** 拖拽 / 移动目标(列序 + 插入位)。 */
export interface MoveTarget {
  readonly column: number;
  readonly index: number;
}

/**
 * Niri 落点类别(WP-72 显式化;呈现层解析指针几何后给出,模型据此选择移动语义):
 *  - `stack`:落到**同列**窗口上 / 下半 = 同列堆叠(插到其前 / 后);
 *  - `cross-column`:落到**另一列**窗口(或列本身)= 跨列移动;
 *  - `new-column`:落到**列间空隙**(分隔条)或列区空白 = 在该列序位置
 *    **新建列位**(`openColumnAt`;`column` = 插入列序,`index` 恒 0)。
 */
export type DropKind = "stack" | "cross-column" | "new-column";

/** 落点(类别 + 目标列序 + 插入位)。 */
export interface DropTarget {
  readonly kind: DropKind;
  readonly column: number;
  readonly index: number;
}

/** 布局快照(呈现层渲染与测试断言面)。 */
export interface WorkspaceLayoutSnapshot {
  readonly columns: readonly WorkspaceColumnState[];
  readonly focusedTabId: string | null;
  readonly tabs: readonly WorkspaceTabInfo[];
  /** 列宽护栏基准(px;0 = 未知——此时不夹取像素下限)。 */
  readonly viewportWidth: number;
}

/** 窗口集绑定项:类型键 + 绑定时刻已求值的展示标题(注册表收敛形态)。 */
export interface WorkspaceWindowBinding {
  readonly type: string;
  readonly label: string;
}

/** 内部列态(可变;快照面按值拷贝输出)。 */
interface ColumnState {
  tabIds: string[];
  widthRatio: number;
  rowHeights: number[];
}

/** 比例比较容差(浮点归一化后的「和 = 1」判定)。 */
const RATIO_EPSILON = 1e-9;

/** 等分比例(n 份)。 */
function equalShares(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}

export class WorkspaceLayoutModel {
  readonly #tabs = new Map<string, WorkspaceTabInfo>();
  #columns: ColumnState[] = [];
  #focusedTabId: string | null = null;
  /** 列宽护栏基准(px;0 = 未知:不夹取像素下限)。 */
  #viewportWidth = 0;

  // ── 只读视图 ──────────────────────────────────────────────────────────────

  /** 布局快照(渲染与测试断言面;含列宽 / 窗高与护栏基准)。 */
  get snapshot(): WorkspaceLayoutSnapshot {
    return {
      columns: this.#columns.map((column) => ({
        tabIds: [...column.tabIds],
        widthRatio: column.widthRatio,
        rowHeights: [...column.rowHeights],
      })),
      focusedTabId: this.#focusedTabId,
      tabs: [...this.#tabs.values()],
      viewportWidth: this.#viewportWidth,
    };
  }

  get focusedTabId(): string | null {
    return this.#focusedTabId;
  }

  get tabCount(): number {
    return this.#tabs.size;
  }

  get columnCount(): number {
    return this.#columns.length;
  }

  /** 列宽护栏基准(px;0 = 未知)。 */
  get viewportWidth(): number {
    return this.#viewportWidth;
  }

  /** 焦点窗口所在列(无焦点为 null)。 */
  get focusedColumnIndex(): number | null {
    return this.#focusedTabId === null ? null : this.columnIndexOfTab(this.#focusedTabId);
  }

  tab(id: string): WorkspaceTabInfo | null {
    return this.#tabs.get(id) ?? null;
  }

  /** 全部窗口(登记序)。 */
  tabs(): readonly WorkspaceTabInfo[] {
    return [...this.#tabs.values()];
  }

  /** 某列的窗口 id(越界返回空数组)。 */
  tabIdsInColumn(column: number): readonly string[] {
    return this.#columns[column]?.tabIds ?? [];
  }

  /** 某列列宽占比(越界返回 null)。 */
  columnWidthRatio(column: number): number | null {
    return this.#columns[column]?.widthRatio ?? null;
  }

  /** 窗口 → 列序;未找到返回 null。 */
  columnIndexOfTab(id: string): number | null {
    for (let index = 0; index < this.#columns.length; index += 1) {
      if (this.#columns[index]?.tabIds.includes(id) === true) {
        return index;
      }
    }
    return null;
  }

  /** 窗口 → 位置;未找到返回 null。 */
  positionOfTab(id: string): TabPosition | null {
    const column = this.columnIndexOfTab(id);
    if (column === null) {
      return null;
    }
    const index = this.#columns[column]?.tabIds.indexOf(id) ?? -1;
    return index < 0 ? null : { column, index };
  }

  // ── 尺寸状态(WP-72)───────────────────────────────────────────────────────

  /**
   * 登记列宽护栏基准(视口宽 px):列宽占比的像素下限 = `MIN_COLUMN_WIDTH ÷
   * 视口宽`。非有限 / ≤0 → 归 0(未知基准,不夹取),确定性且不抛错。
   *
   * 基准变化只**抬升**既有占比到新护栏(不回落):占比是「视口占比」语义,
   * 窗口变窄时列宽按比例随动;变宽时既有调整保留(避免用户调整被静默抹平)。
   */
  setViewportWidth(width: number): void {
    this.#viewportWidth = Number.isFinite(width) && width > 0 ? width : 0;
    const minRatio = this.#minWidthRatio();
    if (minRatio > 0) {
      for (const column of this.#columns) {
        column.widthRatio = Math.max(column.widthRatio, minRatio);
      }
    }
  }

  /** 列宽初始 / 护栏下界占比(视口宽未知时为 0 = 不夹取)。 */
  #minWidthRatio(): number {
    return this.#viewportWidth > 0 ? Math.min(1, MIN_COLUMN_WIDTH / this.#viewportWidth) : 0;
  }

  /**
   * 设置列宽(视口占比):夹取到 `[MIN_COLUMN_WIDTH ÷ 视口宽, 1]`
   *  - 越界列序 / 非有限或 ≤ 0 的占比 → false(布局零变化);
   *  - 低于护栏的合法占比 → **抬升**到护栏并返回 true(调用方按快照回读生效值)。
   */
  setColumnWidth(column: number, widthRatio: number): boolean {
    const target = this.#columns[Math.floor(column)];
    if (target === undefined || !Number.isFinite(column)) {
      return false;
    }
    if (!Number.isFinite(widthRatio) || widthRatio <= 0) {
      return false;
    }
    target.widthRatio = Math.min(Math.max(widthRatio, this.#minWidthRatio()), 1);
    return true;
  }

  /**
   * 设置同列窗高比例:
   *  - 长度必须等于列内窗口数(不符 → false);含非有限 / ≤0 值 → false;
   *  - 合法输入按**相对比例**归一化(和恒为 1);单窗列恒归一化为 `[1]`;
   *  - 越界列序 → false。像素下限不在此夹取:呈现层的 `min-block-size`
   *    承担窗高下限(`MIN_ROW_HEIGHT_PX`,落地点 = `sm-workspace.ts` 的
   *    `.tab-panel { min-block-size }` 与 `.column` 的内联列高下限),
   *    模型只保证比例语义。
   */
  setRowHeights(column: number, heights: readonly number[]): boolean {
    const target = this.#columns[Math.floor(column)];
    if (target === undefined || !Number.isFinite(column)) {
      return false;
    }
    if (heights.length !== target.tabIds.length) {
      return false;
    }
    if (heights.some((value) => !Number.isFinite(value) || value <= 0)) {
      return false;
    }
    const sum = heights.reduce((total, value) => total + value, 0);
    target.rowHeights = heights.map((value) => value / sum);
    return true;
  }

  // ── 窗口集绑定(固定窗口集:D-MP-1)───────────────────────────────────────

  /**
   * 一次性绑定窗口集(每种类型恰一实例):窗口集 = **列内 id 全集 ≡ 绑定项
   * 类型集,无重无漏**。
   *
   * - 缺省 `columns` = **登记序、每列一窗**——模型层的兜底形态(登记集合未被
   *   任何预设覆盖时的结构保底);工作区的**默认列排布唯一来源** = 预设表
   *   (`layout-presets.ts`),经本方法 `columns` 参数单点注入(不得在别处再写
   *   一份默认布局);
   * - 显式 `columns` = 按给定列分组应用(同一类型只落一次;未登记键忽略;
   *   空列不落地;未被覆盖的类型按登记序补为单窗列——不变量兜底);
   * - 列宽 / 窗高重置为缺省:列宽 = 视口等分并夹取到护栏,窗高 = 等分;
   * - 焦点:上次焦点类型仍在绑定集则保持,否则取首列首窗,空集为 null。
   */
  bindWindows(
    bindings: readonly WorkspaceWindowBinding[],
    columns?: readonly (readonly string[])[],
  ): void {
    this.#tabs.clear();
    for (const binding of bindings) {
      // id ≡ 类型键(单实例的结构性保证;类型键即窗口身份)。
      this.#tabs.set(binding.type, {
        id: binding.type,
        type: binding.type,
        title: binding.label,
      });
    }
    const grouped = this.#resolveColumns(
      bindings.map((binding) => binding.type),
      columns,
    );
    this.#setColumns(grouped);
    const previous = this.#focusedTabId;
    this.#focusedTabId =
      previous !== null && this.#tabs.has(previous) ? previous : (this.#columns[0]?.tabIds[0] ?? null);
  }

  /**
   * 应用预设列分组(预设注入的模型侧入口;窗口集不变):
   *  - 未覆盖类型按登记序补单窗列(不变量兜底);列宽 / 窗高重置为缺省;
   *  - **焦点保持**(预设只重排分组,不接管焦点);
   *  - `resetLayout()` = 本方法 + 当前视口宽对应预设。
   */
  applyPreset(columns: readonly (readonly string[])[]): void {
    this.#setColumns(this.#resolveColumns([...this.#tabs.keys()], columns));
  }

  /**
   * 重置布局(WP-72 逃生门):清空列宽 / 窗高调整并**应用当前视口宽对应的预设**。
   * 宽屏下即回到 P0;窄屏下回到该宽度的降级形态(P1 / P2)——避免「回到 P0
   * 后立即被断点降级覆盖」的自相矛盾。焦点保持。
   */
  resetLayout(): void {
    this.applyPreset(selectLayoutPreset(this.#viewportWidth).columns);
  }

  /** 列分组应用(缺省登记序单窗列;见 `bindWindows` 纪律)。 */
  #resolveColumns(
    registered: readonly string[],
    columns?: readonly (readonly string[])[],
  ): string[][] {
    if (columns === undefined) {
      return registered.map((type) => [type]);
    }
    const known = new Set(registered);
    const assigned = new Set<string>();
    const result: string[][] = [];
    for (const column of columns) {
      const ids: string[] = [];
      for (const type of column) {
        if (!known.has(type) || assigned.has(type)) {
          continue; // 未登记键 / 重复落位:忽略(单实例不变量)。
        }
        assigned.add(type);
        ids.push(type);
      }
      if (ids.length > 0) {
        result.push(ids); // 空列不落地(平铺不变量)。
      }
    }
    for (const type of registered) {
      if (!assigned.has(type)) {
        result.push([type]);
      }
    }
    return result;
  }

  /** 落地列分组并重置尺寸为缺省(等分占比,夹取护栏)。 */
  #setColumns(grouped: readonly (readonly string[])[]): void {
    this.#columns = grouped.map((tabIds) => ({
      tabIds: [...tabIds],
      widthRatio: 1,
      rowHeights: equalShares(tabIds.length),
    }));
    this.#applyDefaultWidths();
  }

  /** 缺省列宽 = 视口等分,夹取到可读性护栏与全宽上限。 */
  #applyDefaultWidths(): void {
    const ratio = Math.min(
      Math.max(this.#columns.length === 0 ? 1 : 1 / this.#columns.length, this.#minWidthRatio()),
      1,
    );
    for (const column of this.#columns) {
      column.widthRatio = ratio;
    }
  }

  // ── 聚焦导航 ──────────────────────────────────────────────────────────────

  /**
   * 聚焦指定类型窗口(D-MP-1 三类管理动作之「聚焦导航」):已绑定返回 true
   * 并置焦点;未登记类型返回 false(布局与焦点零变化)。
   */
  focusWindow(type: string): boolean {
    if (!this.#tabs.has(type)) {
      return false;
    }
    this.#focusedTabId = type;
    return true;
  }

  /** 激活窗口(焦点跟随;不存在的 id 为 no-op)。 */
  activateTab(id: string): void {
    if (this.#tabs.has(id)) {
      this.#focusedTabId = id;
    }
  }

  /**
   * 移动窗口到目标位置(拖拽排布):
   *  - `target.column ≥ 列数` = **开新列尾插**(拖到列区空白,Niri 语义);
   *  - 其余:目标列夹取到现有列、插入位夹取到 [0, 列长];同列相邻位(原地)
   *    为 no-op;
   *  - 先摘除再插入:跨列时若源列在目标列之前,目标列序 -1(源列为空被删除);
   *    同列时若源位在目标位之前,插入位 -1(同列摘除后列必非空——原地 no-op
   *    已先行排除)。
   */
  moveTab(id: string, target: MoveTarget): void {
    const from = this.positionOfTab(id);
    if (from === null || this.#columns.length === 0) {
      return;
    }
    if (Math.floor(target.column) >= this.#columns.length) {
      // 开新列尾插:先摘除(列空即删),再追加新列。
      this.#removeFromPosition(from);
      this.#appendColumn([id]);
      this.#focusedTabId = id;
      return;
    }
    let column = Math.min(Math.max(Math.floor(target.column), 0), this.#columns.length - 1);
    let index = Math.max(Math.floor(target.index), 0);
    const sameColumn = from.column === column;
    if (sameColumn && (from.index === index || from.index + 1 === index)) {
      return; // 原地 no-op(拖回自己或紧邻自己后方)。
    }
    const sourceColumn = this.#columns[from.column] as ColumnState;
    const sourceWillEmpty = sourceColumn.tabIds.length === 1;
    if (!sameColumn && sourceWillEmpty && from.column < column) {
      column -= 1; // 源列将被删除且在目标列之前:目标列序前移。
    }
    if (sameColumn && from.index < index) {
      index -= 1; // 同列先摘除:目标插入位前移。
    }
    this.#removeFromPosition(from);
    // 目标列引用必须在**摘除之后**取:上方列序修正以「源列已删除」为前提
    // (摘除前取到的是源列自身,插入会落进已脱离列序列的列 —— 窗口会从布局
    // 中消失,破坏窗口集不变量)。
    const targetColumn = this.#columns[column];
    if (targetColumn === undefined) {
      return; // 理论不可达(上方已夹取);防御保持不变量。
    }
    targetColumn.tabIds.splice(Math.min(index, targetColumn.tabIds.length), 0, id);
    targetColumn.rowHeights = equalShares(targetColumn.tabIds.length);
    this.#focusedTabId = id;
  }

  /**
   * 在指定列序位置**新建列位**并尾插窗口(Niri「列间空隙」落点,WP-72 显式化):
   * `moveTab` 的 `target.column ≥ 列数` 只表达「尾插」,无法表达「插到第 k 与
   * 第 k+1 列之间」。语义:
   *  - `column` 夹取到 `[0, 列数]`(等于列数 = 尾插,与 `moveTab` 同形);
   *  - 源列被清空且位于插入位之前 → 插入位前移(源列删除,与 `moveTab` 同规);
   *  - 新列宽度 = 当前缺省占比(1 ÷ 新列数,夹取护栏);其余列宽度自持;
   *  - 焦点跟随被移动窗口;窗口不存在 / 空布局为 no-op。
   */
  openColumnAt(id: string, column: number): void {
    const from = this.positionOfTab(id);
    if (from === null || this.#columns.length === 0) {
      return;
    }
    const sourceEmptying = (this.#columns[from.column]?.tabIds.length ?? 0) === 1;
    let position = Number.isFinite(column)
      ? Math.min(Math.max(Math.floor(column), 0), this.#columns.length)
      : this.#columns.length;
    if (sourceEmptying && from.column < position) {
      position -= 1;
    }
    this.#removeFromPosition(from);
    const clamped = Math.min(Math.max(position, 0), this.#columns.length);
    const created: ColumnState = {
      tabIds: [id],
      widthRatio: 1,
      rowHeights: [1],
    };
    created.widthRatio = Math.min(
      Math.max(1 / (this.#columns.length + 1), this.#minWidthRatio()),
      1,
    );
    this.#columns.splice(clamped, 0, created);
    this.#focusedTabId = id;
  }

  /** 尾插新列(缺省占比;`moveTab` 的开新列路径与 `openColumnAt` 同规)。 */
  #appendColumn(tabIds: string[]): void {
    const ratio = Math.min(Math.max(1 / (this.#columns.length + 1), this.#minWidthRatio()), 1);
    this.#columns.push({ tabIds, widthRatio: ratio, rowHeights: equalShares(tabIds.length) });
  }

  /** 从位置摘除窗口 id;列空即删除列(平铺不变量:不存在空列)。 */
  #removeFromPosition(position: TabPosition): void {
    const column = this.#columns[position.column] as ColumnState;
    column.tabIds.splice(position.index, 1);
    if (column.tabIds.length === 0) {
      this.#columns.splice(position.column, 1);
      return;
    }
    column.rowHeights = equalShares(column.tabIds.length);
  }
}

/**
 * 窗口集不变量机检(WP-71):列内窗口 id 全集 ≡ 窗口集键集且每键恰一次、
 * 窗口 id ≡ 类型键(单实例)、不存在空列(平铺不变量)。
 *
 * 形参取结构子集(只需 `columns[].tabIds` 与 `tabs`),便于以最小夹具构造反例。
 */
export function isWindowSetComplete(snapshot: {
  readonly columns: readonly { readonly tabIds: readonly string[] }[];
  readonly tabs: readonly WorkspaceTabInfo[];
}): boolean {
  const perColumn = new Map<string, number>();
  for (const column of snapshot.columns) {
    if (column.tabIds.length === 0) {
      return false; // 平铺不变量:不存在空列。
    }
    for (const id of column.tabIds) {
      perColumn.set(id, (perColumn.get(id) ?? 0) + 1);
    }
  }
  if (perColumn.size !== snapshot.tabs.length) {
    return false;
  }
  for (const info of snapshot.tabs) {
    if (info.id !== info.type) {
      return false; // 单实例:窗口 id ≡ 类型键。
    }
    if (perColumn.get(info.id) !== 1) {
      return false; // 无重无漏。
    }
  }
  return true;
}

/**
 * 尺寸状态不变量机检(WP-72):列宽 ≥ 可读性护栏且 ≤ 1(视口宽已知时按像素
 * 护栏校验,未知时只校验占比形态)、同列窗高比例和 = 1 且长度 = 列内窗口数、
 * 单窗列恒 `[1]`、不存在空列。
 */
export function isLayoutStateValid(snapshot: WorkspaceLayoutSnapshot): boolean {
  const minRatio =
    snapshot.viewportWidth > 0 ? Math.min(1, MIN_COLUMN_WIDTH / snapshot.viewportWidth) : 0;
  for (const column of snapshot.columns) {
    if (column.tabIds.length === 0) {
      return false; // 平铺不变量:不存在空列。
    }
    if (
      !Number.isFinite(column.widthRatio) ||
      column.widthRatio <= 0 ||
      column.widthRatio > 1 + RATIO_EPSILON
    ) {
      return false;
    }
    if (minRatio > 0 && column.widthRatio < minRatio - RATIO_EPSILON) {
      return false; // 列宽最小护栏(像素语义)。
    }
    const heights = column.rowHeights;
    if (heights.length !== column.tabIds.length) {
      return false; // 比例长度 = 列内窗口数。
    }
    if (heights.some((value) => !Number.isFinite(value) || value <= 0)) {
      return false;
    }
    const sum = heights.reduce((total, value) => total + value, 0);
    if (Math.abs(sum - 1) > RATIO_EPSILON) {
      return false; // 比例和 = 1。
    }
    if (column.tabIds.length === 1 && heights[0] !== 1) {
      return false; // 单窗列自动占满列高。
    }
  }
  return true;
}

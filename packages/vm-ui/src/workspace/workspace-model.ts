/**
 * 工作区布局模型(WP-F5 / FE-WS-01 / FE-WS-02,Q1 定案 v1 = 列式滚动平铺)。
 *
 * 布局语义(Niri × Hyprland 的最小可演示形态,主控定案):
 *  - 工作区 = **列的有序序列**;列间水平滚动可达任意列(Niri 式);
 *  - 列内 = 标签页的有序序列,纵向二叉分割——新标签页落入**焦点列**并分割
 *    (Hyprland 式):模型表现 = 插入到焦点标签页之后,呈现层让同列标签页
 *    均分列高;
 *  - **拖拽排布**:标签页可移动到任意列的任意位置(呈现层把指针落点翻译为
 *    `{column, index}` 目标);
 *  - 焦点:唯一 focusedTabId;焦点列 = 焦点标签页所在列。
 *
 * 生命周期(FE-WS-01):
 *  - 打开:分配 id(可注入生成器)+ 类型内序号(只增不减,关闭后不复用,
 *    保证标题稳定);无列时创建首列;
 *  - 关闭:焦点交给邻居(同列后继 → 同列前驱 → 全局后继 → null);列空即
 *    删除列(FE-WS-02 平铺不变量:不存在空列);
 *  - 空态:无任何标签页 → 呈现层给出"打开标签页"引导(本模型只表达
 *    tabCount === 0)。
 *
 * 纯状态机:无 DOM、无 IO;类型键为开放 string(对齐 tab-registry 的可扩展
 * 结构),标题由调用方(工作区)按注册表 label + 序号组装后传入。
 */

/** 单个标签页的布局态。 */
export interface WorkspaceTabInfo {
  readonly id: string;
  /** 标签页类型键(注册表条目键;开放 string)。 */
  readonly type: string;
  /** 类型内序号(1 起,只增不减;标题"类型名 + 序号"的序号源)。 */
  readonly ordinal: number;
  /** 展示标题(工作区按注册表 label + ordinal 组装)。 */
  readonly title: string;
}

/** 单列的布局态(列内标签页 id 有序)。 */
export interface WorkspaceColumnState {
  readonly tabIds: readonly string[];
}

/** 标签页位置。 */
export interface TabPosition {
  readonly column: number;
  readonly index: number;
}

/** 拖拽 / 移动目标(列序 + 插入位)。 */
export interface MoveTarget {
  readonly column: number;
  readonly index: number;
}

/** 布局快照(呈现层渲染与测试断言面)。 */
export interface WorkspaceLayoutSnapshot {
  readonly columns: readonly WorkspaceColumnState[];
  readonly focusedTabId: string | null;
  readonly tabs: readonly WorkspaceTabInfo[];
}

export class WorkspaceLayoutModel {
  readonly #tabs = new Map<string, WorkspaceTabInfo>();
  #columns: string[][] = [];
  #focusedTabId: string | null = null;
  readonly #ordinalCounters = new Map<string, number>();
  #nextId: () => string;

  constructor(nextId: () => string = defaultNextId()) {
    this.#nextId = nextId;
  }

  // ── 只读视图 ──────────────────────────────────────────────────────────────

  /** 布局快照(渲染与测试断言面)。 */
  get snapshot(): WorkspaceLayoutSnapshot {
    return {
      columns: this.#columns.map((tabIds) => ({ tabIds: [...tabIds] })),
      focusedTabId: this.#focusedTabId,
      tabs: [...this.#tabs.values()],
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

  /** 焦点标签页所在列(无焦点为 null)。 */
  get focusedColumnIndex(): number | null {
    return this.#focusedTabId === null ? null : this.columnIndexOfTab(this.#focusedTabId);
  }

  tab(id: string): WorkspaceTabInfo | null {
    return this.#tabs.get(id) ?? null;
  }

  /** 全部标签页(登记序)。 */
  tabs(): readonly WorkspaceTabInfo[] {
    return [...this.#tabs.values()];
  }

  /** 某列的标签页 id(越界返回空数组)。 */
  tabIdsInColumn(column: number): readonly string[] {
    return this.#columns[column] ?? [];
  }

  /** 标签页 → 列序;未找到返回 null。 */
  columnIndexOfTab(id: string): number | null {
    for (let index = 0; index < this.#columns.length; index += 1) {
      if (this.#columns[index]?.includes(id) === true) {
        return index;
      }
    }
    return null;
  }

  /** 标签页 → 位置;未找到返回 null。 */
  positionOfTab(id: string): TabPosition | null {
    const column = this.columnIndexOfTab(id);
    if (column === null) {
      return null;
    }
    const index = this.#columns[column]?.indexOf(id) ?? -1;
    return index < 0 ? null : { column, index };
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  /**
   * 打开标签页(Hyprland 式分割):落入焦点列、插入到焦点标签页之后(无列
   * 创建首列;无焦点追加到末列末尾,末列也不存在时创建首列);新标签页获得
   * 焦点。标题 = `formatTabTitle(label, 类型内序号)`(FE-WS-01:类型名 + 序号,
   * 序号只增不减保证标题稳定)。返回新标签页 id。
   */
  openTab(type: string, label: string): string {
    const id = this.#nextId();
    const ordinal = (this.#ordinalCounters.get(type) ?? 0) + 1;
    this.#ordinalCounters.set(type, ordinal);
    this.#tabs.set(id, { id, type, ordinal, title: formatTabTitle(label, ordinal) });

    if (this.#columns.length === 0) {
      this.#columns = [[id]];
      this.#focusedTabId = id;
      return id;
    }
    let columnIndex = this.focusedColumnIndex ?? this.#columns.length - 1;
    if (columnIndex < 0 || columnIndex >= this.#columns.length) {
      columnIndex = this.#columns.length - 1;
    }
    const column = this.#columns[columnIndex] as string[];
    const focusedIndex = this.#focusedTabId === null ? -1 : column.indexOf(this.#focusedTabId);
    const insertAt = focusedIndex < 0 ? column.length : focusedIndex + 1;
    column.splice(insertAt, 0, id);
    this.#focusedTabId = id;
    return id;
  }

  /**
   * 关闭标签页:列空即删除列;焦点交给邻居(同列后继 → 同列前驱 → 前一列末
   * → null)。关闭不存在的标签页为 no-op。
   */
  closeTab(id: string): void {
    if (!this.#tabs.has(id)) {
      return;
    }
    const position = this.positionOfTab(id);
    this.#tabs.delete(id);
    if (position === null) {
      return;
    }
    this.#removeFromPosition(position);
    if (this.#focusedTabId === id) {
      this.#focusedTabId = this.#neighborFocus(position);
    }
  }

  /** 关闭后的焦点邻居:同列后继 → 同列前驱 → 前一列末 → null。 */
  #neighborFocus(position: TabPosition): string | null {
    const column = this.#columns[position.column];
    if (column !== undefined) {
      // 列仍在(原列 ≥2 个标签页):优先同列后继,其次前驱。
      return column[position.index] ?? column[position.index - 1] ?? null;
    }
    // 列已删除(原列仅此一页,且无后续列接替位置):前一列末标签页,
    // 否则工作区已空。
    const previousColumn = this.#columns[position.column - 1];
    return previousColumn?.[previousColumn.length - 1] ?? null;
  }

  /** 激活标签页(焦点跟随;不存在的 id 为 no-op)。 */
  activateTab(id: string): void {
    if (this.#tabs.has(id)) {
      this.#focusedTabId = id;
    }
  }

  /**
   * 移动标签页到目标位置(拖拽排布):
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
      this.#columns.push([id]);
      this.#focusedTabId = id;
      return;
    }
    let column = Math.min(Math.max(Math.floor(target.column), 0), this.#columns.length - 1);
    let index = Math.max(Math.floor(target.index), 0);
    const sameColumn = from.column === column;
    if (sameColumn && (from.index === index || from.index + 1 === index)) {
      return; // 原地 no-op(拖回自己或紧邻自己后方)。
    }
    const sourceColumn = this.#columns[from.column] as string[];
    const sourceWillEmpty = sourceColumn.length === 1;
    if (!sameColumn && sourceWillEmpty && from.column < column) {
      column -= 1; // 源列将被删除且在目标列之前:目标列序前移。
    }
    if (sameColumn && from.index < index) {
      index -= 1; // 同列先摘除:目标插入位前移。
    }
    const targetColumn = this.#columns[column];
    if (targetColumn === undefined) {
      return; // 理论不可达(上方已夹取);防御保持不变量。
    }
    this.#removeFromPosition(from);
    targetColumn.splice(Math.min(index, targetColumn.length), 0, id);
    this.#focusedTabId = id;
  }

  /** 从位置摘除标签页 id;列空即删除列(平铺不变量:不存在空列)。 */
  #removeFromPosition(position: TabPosition): void {
    const column = this.#columns[position.column] as string[];
    column.splice(position.index, 1);
    if (column.length === 0) {
      this.#columns.splice(position.column, 1);
    }
  }
}

/** 缺省 id 生成器:tab-1、tab-2、…(模块级计数,进程内唯一)。 */
function defaultNextId(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `tab-${counter}`;
  };
}

/** 按注册表 label + 类型内序号组装标签页标题(FE-WS-01:类型名 + 序号)。 */
export function formatTabTitle(label: string, ordinal: number): string {
  return `${label} ${ordinal}`;
}

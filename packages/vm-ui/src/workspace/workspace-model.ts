/**
 * 工作区布局模型(WP-F5 / FE-WS-01 / FE-WS-02,Q1 定案 v1 = 列式滚动平铺;
 * WP-71 起 = D-MP-1 固定窗口集)。
 *
 * 布局语义(Niri × Hyprland 的最小可演示形态,主控定案):
 *  - 工作区 = **列的有序序列**;列间水平滚动可达任意列(Niri 式);
 *  - 列内 = 窗口的有序序列,纵向二叉分割——呈现层让同列窗口均分列高
 *    (Hyprland 式);
 *  - **拖拽排布**:窗口可移动到任意列的任意位置(呈现层把指针落点翻译为
 *    `{column, index}` 目标);
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
 * 纯状态机:无 DOM、无 IO;类型键为开放 string(对齐 tab-registry 的可扩展
 * 结构)。
 */

/** 单个窗口的布局态(id ≡ 类型键;单实例由此结构性保证)。 */
export interface WorkspaceTabInfo {
  readonly id: string;
  /** 窗口类型键(注册表条目键;开放 string)。 */
  readonly type: string;
  /** 展示标题(工作区按注册表 label 于绑定时刻求值固化)。 */
  readonly title: string;
}

/** 单列的布局态(列内窗口 id 有序)。 */
export interface WorkspaceColumnState {
  readonly tabIds: readonly string[];
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

/** 布局快照(呈现层渲染与测试断言面)。 */
export interface WorkspaceLayoutSnapshot {
  readonly columns: readonly WorkspaceColumnState[];
  readonly focusedTabId: string | null;
  readonly tabs: readonly WorkspaceTabInfo[];
}

/** 窗口集绑定项:类型键 + 绑定时刻已求值的展示标题(注册表收敛形态)。 */
export interface WorkspaceWindowBinding {
  readonly type: string;
  readonly label: string;
}

export class WorkspaceLayoutModel {
  readonly #tabs = new Map<string, WorkspaceTabInfo>();
  #columns: string[][] = [];
  #focusedTabId: string | null = null;

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
    return this.#columns[column] ?? [];
  }

  /** 窗口 → 列序;未找到返回 null。 */
  columnIndexOfTab(id: string): number | null {
    for (let index = 0; index < this.#columns.length; index += 1) {
      if (this.#columns[index]?.includes(id) === true) {
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
    const index = this.#columns[column]?.indexOf(id) ?? -1;
    return index < 0 ? null : { column, index };
  }

  // ── 窗口集绑定(固定窗口集:D-MP-1)───────────────────────────────────────

  /**
   * 一次性绑定窗口集(每种类型恰一实例):窗口集 = **列内 id 全集 ≡ 绑定项
   * 类型集,无重无漏**。
   *
   * - 缺省 `columns` = **登记序、每列一窗**——WP-72 落 P0 精确预设前的
   *   **最小形态**(登记二者关系:WP-72 承接该入口,以 P0 预设
   *   `[[stack, registers], [debug, free], [payload], …]` 传入);
   * - 显式 `columns` = 按给定列分组应用(同一类型只落一次;未登记键忽略;
   *   空列不落地;未被覆盖的类型按登记序补为单窗列——不变量兜底);
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
    this.#columns = this.#resolveColumns(bindings, columns);
    const previous = this.#focusedTabId;
    this.#focusedTabId =
      previous !== null && this.#tabs.has(previous) ? previous : (this.#columns[0]?.[0] ?? null);
  }

  /** 列分组应用(缺省登记序单窗列;见 `bindWindows` 纪律)。 */
  #resolveColumns(
    bindings: readonly WorkspaceWindowBinding[],
    columns?: readonly (readonly string[])[],
  ): string[][] {
    const registered: string[] = bindings.map((binding) => binding.type);
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
    this.#removeFromPosition(from);
    // 目标列数组必须在**摘除之后**取:上方列序修正以「源列已删除」为前提
    // (摘除前取到的是源列自身的数组,插入会落进已脱离列序列的数组 —— 窗口
    // 会从布局中消失,破坏窗口集不变量)。
    const targetColumn = this.#columns[column];
    if (targetColumn === undefined) {
      return; // 理论不可达(上方已夹取);防御保持不变量。
    }
    targetColumn.splice(Math.min(index, targetColumn.length), 0, id);
    this.#focusedTabId = id;
  }

  /** 从位置摘除窗口 id;列空即删除列(平铺不变量:不存在空列)。 */
  #removeFromPosition(position: TabPosition): void {
    const column = this.#columns[position.column] as string[];
    column.splice(position.index, 1);
    if (column.length === 0) {
      this.#columns.splice(position.column, 1);
    }
  }
}

/**
 * 窗口集不变量机检(WP-71):列内窗口 id 全集 ≡ 窗口集键集且每键恰一次、
 * 窗口 id ≡ 类型键(单实例)、不存在空列(平铺不变量)。
 */
export function isWindowSetComplete(snapshot: WorkspaceLayoutSnapshot): boolean {
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

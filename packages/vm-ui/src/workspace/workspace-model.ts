/**
 * 工作区视图模型(WP-F5 / FE-WS-01 / FE-WS-02;WP-71 = D-MP-1 固定窗口集;
 * **2026-09-18 整页布局改版 = D-API-153 / D-UI-1 ~ D-UI-7**)。
 *
 * ## 本版模型(整页布局:一条有序视图列表 + 可见性 + 焦点)
 *
 * 状态 = **一条有序的视图类型列表** + 每个类型的**可见性(勾选)** + **焦点类型**。
 *
 * **不变量(机检 = `isWindowSetComplete` / `isLayoutStateValid`)**:
 *  1. 列表内**每个登记类型恰一次、无重无漏**(permutation of the registry);
 *  2. 视图 id ≡ 类型键 ⇒ **单实例是结构性保证**(同类型重复实例无法表达);
 *  3. **焦点唯一**(恰一个类型,或 null);
 *  4. **不存在「隐藏即消失」语义** —— 隐藏只改 `visible`,类型仍**全员在场**
 *     (未勾选 = 不显示 = 「暂离」的**第二种成因**,第一种仍是滚出可视区;
 *      **D-MP-1 不修订**:视图仍全部常驻,无开 / 关状态)。
 *
 * **操作**:
 *  - `bindWindows(bindings, order?)` 一次性绑窗(顺序缺省 = **登记序**);
 *  - `focusWindow(type)` 聚焦(不创建实例);
 *  - `setViewVisible(type, visible)` 勾选(幂等);
 *  - `moveView(type, targetIndex)` **列表内重排**(只此一种落点语义,D-UI-4);
 *  - `resetViews()` **重置视图** = 恢复默认顺序(= 绑定时的登记序)+ 全选
 *    (焦点保持 —— 窗口集不变,只重排与全选);
 *  - `visibleViews()` / `orderedViews()` 只读面 + `snapshot` 快照面;
 *  - `stepActiveView(delta)` / `setActiveView(type)` 供 `Ctrl + ↑ / ↓` 的
 *    「左半侧上下切换视图窗口」(D-UI-3;**边界不环绕**)。
 *
 * **本版废止(整条退出,不留兼容别名)** —— Niri 式列条带模型全部:
 * 列的有序序列、列间水平滚动、列内二叉分割、`columns[].widthRatio` /
 * `columns[].rowHeights`、视口宽预设档位判定、列宽五档、列高下限
 * (`columnMinHeightPx` / `columnChromePx` / 拖拽像素语义,D-API-152 几何面)、
 * 三类拖拽落点(`stack` / `cross-column` / `new-column`)、焦点列 / 相机。
 * **D-API-152 条目本身是历史决策,不得删除**。
 *
 * **快照面 `WorkspaceLayoutSnapshot` 已按新模型替换字段**(旧的 `columns` /
 * `widthRatio` / `rowHeights` / `viewportWidth` 全部退场;`viewportWidth` 的替代
 * = `leftRoleWidth` —— 语义明确 =「左半侧实际宽度」,用于核对 D-UI-5 的
 * `SIDE_PANEL_MIN_WIDTH_PX` 底线)。该快照面**不是冻结契约面**
 * (`packages/protocol` 对 `layoutSnapshot` / `widthRatio` / `rowHeights` /
 * `viewportWidth` 零命中,已查证)⇒ 内部模型自由重构 + 同步改 vm-ui 测试。
 *
 * 纯状态机:无 DOM、无 IO;类型键为开放 string(对齐 tab-registry 的可扩展
 * 结构);默认顺序只经 `bindWindows` 的 `order` 参数流入,模型自身不持有
 * 默认顺序字面量。
 */

/** 单个视图的布局态(id ≡ 类型键;单实例由此结构性保证)。 */
export interface WorkspaceViewState {
  readonly id: string;
  /** 视图类型键(注册表条目键;开放 string)。 */
  readonly type: string;
  /** 展示标题(工作区按注册表 label 于绑定时刻求值固化)。 */
  readonly title: string;
  /** 可见性(勾选态):false = 不在左半侧显示(视图仍常驻,不是「关闭」)。 */
  readonly visible: boolean;
}

/**
 * 布局快照(呈现层渲染与测试断言面)。
 *
 *  - `views`:全部视图的**有序**列表(含 `visible`,顺序 = 左半侧纵向堆叠序);
 *  - `focusedType` / `focusedTabId`:焦点(唯一或 null;两者同值 —— `focusedTabId`
 *    为既有消费面名,视图 id ≡ 类型键);
 *  - `activeType`:`Ctrl + ↑/↓` 的当前切换落点(恒为**可见**视图之一或 null);
 *  - `leftRoleWidth`:左半侧实际宽度(px;0 = 未知)。**用于核对 D-UI-5 的
 *    左半侧宽度底线** —— 语义明确,取代已废止的 `viewportWidth`。
 */
export interface WorkspaceLayoutSnapshot {
  readonly views: readonly WorkspaceViewState[];
  readonly focusedTabId: string | null;
  readonly focusedType: string | null;
  readonly activeType: string | null;
  readonly leftRoleWidth: number;
}

/** 视图集绑定项:类型键 + 绑定时刻已求值的展示标题(注册表收敛形态)。 */
export interface WorkspaceWindowBinding {
  readonly type: string;
  readonly label: string;
}

/** 内部视图态(可变;快照面按值拷贝输出)。 */
interface ViewState {
  type: string;
  title: string;
  visible: boolean;
}

export class WorkspaceLayoutModel {
  /** 有序视图列表(顺序 = 左半侧纵向堆叠序)。 */
  #views: ViewState[] = [];
  /** 绑定时的登记序(「重置视图 = 恢复默认顺序」的默认顺序依据)。 */
  #defaultOrder: string[] = [];
  #focusedType: string | null = null;
  /** `Ctrl + ↑/↓` 的当前切换落点(可见视图之一或 null)。 */
  #activeType: string | null = null;
  /** 左半侧实际宽度(px;0 = 未知)。 */
  #leftRoleWidth = 0;

  // ── 只读视图 ──────────────────────────────────────────────────────────────

  /** 布局快照(渲染与测试断言面)。 */
  get snapshot(): WorkspaceLayoutSnapshot {
    return {
      views: this.#views.map((view) => ({
        id: view.type,
        type: view.type,
        title: view.title,
        visible: view.visible,
      })),
      focusedTabId: this.#focusedType,
      focusedType: this.#focusedType,
      activeType: this.#activeType,
      leftRoleWidth: this.#leftRoleWidth,
    };
  }

  get focusedTabId(): string | null {
    return this.#focusedType;
  }

  /** 焦点视图类型(与 `focusedTabId` 同值;视图 id ≡ 类型键)。 */
  get focusedType(): string | null {
    return this.#focusedType;
  }

  /** `Ctrl + ↑/↓` 的当前切换落点(可见视图之一或 null)。 */
  get activeType(): string | null {
    return this.#activeType;
  }

  /** 视图总数(固定窗口集:恒等于登记类型数)。 */
  get viewCount(): number {
    return this.#views.length;
  }

  /** 左半侧实际宽度(px;0 = 未知)。 */
  get leftRoleWidth(): number {
    return this.#leftRoleWidth;
  }

  view(type: string): WorkspaceViewState | null {
    const found = this.#views.find((entry) => entry.type === type);
    return found === undefined
      ? null
      : { id: found.type, type: found.type, title: found.title, visible: found.visible };
  }

  /**
   * 按 id 取视图(视图 id ≡ 类型键 ⇒ 与 `view` 同值)。保留本名以维持
   * 既有消费面(`sm-workspace` 的 payload 焦点判定 / 各处标题解析)。
   */
  tab(id: string): WorkspaceViewState | null {
    return this.view(id);
  }

  /** 全部视图(当前顺序;含不可见者 —— 类型恒全员在场)。 */
  orderedViews(): readonly WorkspaceViewState[] {
    return this.snapshot.views;
  }

  /** 可见视图(当前顺序;左半侧纵向堆叠序)。 */
  visibleViews(): readonly WorkspaceViewState[] {
    return this.snapshot.views.filter((view) => view.visible);
  }

  /** 视图 → 序号;未登记返回 null。 */
  indexOfView(type: string): number | null {
    const index = this.#views.findIndex((view) => view.type === type);
    return index < 0 ? null : index;
  }

  /** 可见视图中的序号;不可见 / 未登记返回 null。 */
  visibleIndexOf(type: string): number | null {
    const visible = this.visibleViews();
    const index = visible.findIndex((view) => view.type === type);
    return index < 0 ? null : index;
  }

  // ── 视图集绑定(D-MP-1 固定窗口集)─────────────────────────────────────────

  /**
   * 一次性绑定视图集(每种类型恰一实例):类型集 ≡ 绑定项类型集,**无重无漏**。
   *
   * - 顺序:显式 `order` = 按给定顺序(**未覆盖的类型按登记序补在末尾**,缺失 /
   *   未登记键忽略);缺省 = **登记序**;
   * - 可见性:全部 `visible = true`(**勾选态属于用户调整**,重新绑窗即复位);
   * - 焦点:上次焦点类型仍在绑定集则保持,否则取序首,空集为 null;
   * - `Ctrl + ↑/↓` 落点复位为 null(下一次按键从头开始)。
   */
  bindWindows(bindings: readonly WorkspaceWindowBinding[], order?: readonly string[]): void {
    const registered = bindings.map((binding) => binding.type);
    const titles = new Map<string, string>();
    for (const binding of bindings) {
      // id ≡ 类型键(单实例的结构性保证;类型键即视图身份)。
      titles.set(binding.type, binding.label);
    }
    const next = this.#resolveOrder(registered, order);
    this.#defaultOrder = [...registered];
    this.#views = next.map((type) => ({
      type,
      title: titles.get(type) ?? type,
      visible: true,
    }));
    const previous = this.#focusedType;
    this.#focusedType =
      previous !== null && titles.has(previous) ? previous : (this.#views[0]?.type ?? null);
    this.#activeType = null;
  }

  /**
   * 顺序解析(缺省登记序;显式顺序 = 已登记键按给定序,未覆盖者按登记序补末尾;
   * 结果恒为输入的全排列 —— 无重无漏不变量由本方法单点保证)。
   */
  #resolveOrder(registered: readonly string[], order?: readonly string[]): string[] {
    if (order === undefined) {
      return [...registered];
    }
    const known = new Set(registered);
    const result: string[] = [];
    const seen = new Set<string>();
    for (const type of order) {
      if (known.has(type) && !seen.has(type)) {
        seen.add(type);
        result.push(type);
      }
    }
    for (const type of registered) {
      if (!seen.has(type)) {
        seen.add(type);
        result.push(type);
      }
    }
    return result;
  }

  // ── 聚焦导航 ──────────────────────────────────────────────────────────────

  /**
   * 聚焦指定类型视图(D-MP-1 三类管理动作之「聚焦导航」):已绑定返回 true 并
   * 置焦点;未登记类型返回 false(布局与焦点零变化)。**不创建实例**。
   */
  focusWindow(type: string): boolean {
    if (this.indexOfView(type) === null) {
      return false;
    }
    this.#focusedType = type;
    return true;
  }

  /** 激活视图(焦点跟随;不存在的类型为 no-op)。 */
  activateTab(id: string): void {
    if (this.indexOfView(id) !== null) {
      this.#focusedType = id;
    }
  }

  // ── 可见性(勾选)─────────────────────────────────────────────────────────

  /**
   * 设置视图可见性(左半侧列表按钮的「勾选」;唯一入口,D-UI-7 补充裁定)。
   *
   * - 未登记类型 / 非法值 → false(零变化);
   * - 与当前值相同 → false(幂等,不触发状态变更);
   * - **焦点不受影响**:可见性只管「显示与否」,不是开 / 关语义
   *   (D-MP-1 不修订);把焦点视图设为不可见是合法状态(焦点仍在,只是不显示);
   * - 被隐藏者若恰是 `Ctrl + ↑/↓` 的落点,则落点复位为 null。
   */
  setViewVisible(type: string, visible: boolean): boolean {
    const target = this.#views.find((view) => view.type === type);
    if (target === undefined) {
      return false;
    }
    if (target.visible === visible) {
      return false;
    }
    target.visible = visible;
    if (!visible && this.#activeType === type) {
      this.#activeType = null;
    }
    return true;
  }

  // ── 列表内重排(D-UI-4:只此一种落点语义)──────────────────────────────────

  /**
   * 列表内重排(视图管理窗口的**拖拽**排序;只保留「列表内重排」一种落点语义,
   * 原三类 Niri 落点整体废止)。
   *
   * - `targetIndex` 夹取到 `[0, 视图数 − 1]`;
   * - 未登记类型 / 原地(夹取后序号等于自身序号)→ false(零变化);
   * - 先摘除再插入 ⇒ 实际落位 = 夹取后序号(与「移动到第 N 位」的直觉一致);
   * - **可见性与焦点不变**(重排只动顺序)。
   */
  moveView(type: string, targetIndex: number): boolean {
    const from = this.indexOfView(type);
    if (from === null || this.#views.length === 0) {
      return false;
    }
    const clamped = Number.isFinite(targetIndex)
      ? Math.min(Math.max(Math.floor(targetIndex), 0), this.#views.length - 1)
      : from;
    if (clamped === from) {
      return false;
    }
    const [moved] = this.#views.splice(from, 1);
    if (moved === undefined) {
      return false; // 理论不可达(上方已核 indexOf);防御保持不变量。
    }
    this.#views.splice(clamped, 0, moved);
    return true;
  }

  // ── 重置视图(D-UI-7 补充:恢复默认顺序 + 全选)────────────────────────────

  /**
   * 重置视图(**取代**已废止的「重置布局」):恢复默认顺序(= 绑定时登记序)
   * 并**全选**(全部可见)。焦点与 `Ctrl + ↑/↓` 落点复位为 null(**窗口集不变**,
   * 只重排与全选 —— 与「重置布局」旧语义无继承关系)。
   */
  resetViews(): void {
    const byType = new Map(this.#views.map((view) => [view.type, view]));
    this.#views = this.#defaultOrder
      .map((type) => byType.get(type))
      .filter((view): view is ViewState => view !== undefined)
      .map((view) => ({ ...view, visible: true }));
    // 防御:默认顺序表与当前列表不一致(理论上不可能)时补齐缺席者,保持不变量。
    for (const view of byType.values()) {
      if (!this.#defaultOrder.includes(view.type)) {
        this.#views.push({ ...view, visible: true });
      }
    }
    this.#activeType = null;
  }

  // ── `Ctrl + ↑ / ↓` 切换(D-UI-3)──────────────────────────────────────────

  /**
   * 在**可见**视图中移动切换落点(delta = ±1):首次调用(落点为 null)落在
   * 首个合格可见视图(向后)/ 末个合格可见视图(向前);**边界处不环绕**(到达
   * 首 / 末即可停,确定性可预期)。返回是否发生变化。
   *
   * `isEligible`(可选)过滤**切换域**:工作区传「非 payload」把固定于右半侧的
   * payload 排除在 `Ctrl + ↑/↓` 的序列之外 —— 该视图位不在左半侧渲染,落在它上面
   * 会让切换看起来「无反应」(无对应视图位可滚)。模型自身保持通用(零 payload 字面量)。
   *
   * 切换域为空时为 no-op(返回 false)。
   */
  stepActiveView(delta: number, isEligible?: (type: string) => boolean): boolean {
    const domain = this.visibleViews().filter(
      (view) => isEligible === undefined || isEligible(view.type),
    );
    if (domain.length === 0) {
      return false;
    }
    const step = delta < 0 ? -1 : 1;
    // 当前位置必须在**切换域**内取序号(可见集与切换域可以是两个不同的序列)。
    const currentIndex =
      this.#activeType === null ? -1 : domain.findIndex((view) => view.type === this.#activeType);
    // 未进入域 / 落点在域外:向后取域首、向前取域尾(不因序号错位跳变)。
    const nextIndex =
      currentIndex < 0
        ? step > 0
          ? 0
          : domain.length - 1
        : Math.min(Math.max(currentIndex + step, 0), domain.length - 1);
    const next = domain[nextIndex]?.type ?? null;
    if (next === null || next === this.#activeType) {
      return false; // 边界不环绕:已到首 / 末即为 no-op。
    }
    this.#activeType = next;
    return true;
  }

  /**
   * 直接设置切换落点(仅接受**可见**视图;不可见 / 未登记为 no-op)。
   * `isEligible` 语义同 `stepActiveView`。
   */
  setActiveView(type: string, isEligible?: (candidate: string) => boolean): boolean {
    if (this.visibleIndexOf(type) === null) {
      return false;
    }
    if (isEligible !== undefined && !isEligible(type)) {
      return false;
    }
    if (this.#activeType === type) {
      return false;
    }
    this.#activeType = type;
    return true;
  }

  // ── 左半侧宽度登记(D-UI-5 底线核对面)────────────────────────────────────

  /**
   * 登记左半侧实际宽度(px):非有限 / ≤0 → 归 0(未知),确定性且不抛错。
   * 本值只作**诊断 / 快照面**(不参与任何夹取 —— 窄屏底线由 CSS
   * `min-width: SIDE_PANEL_MIN_WIDTH_PX` + 页面横向滚动承担,D-UI-5)。
   */
  setLeftRoleWidth(width: number): void {
    this.#leftRoleWidth = Number.isFinite(width) && width > 0 ? width : 0;
  }
}

/**
 * 窗口集不变量机检(**本版重写**):列表内每登记类型恰一次、无重无漏;视图
 * id ≡ 类型键(单实例结构性保证);**不存在「隐藏即消失」语义** —— 隐藏只改
 * `visible`,类型仍全员在场(因此本函数**不**因不可见而失败);焦点唯一(或 null)。
 *
 * 形参取结构子集(只需 `views` 列表与可选焦点),便于以最小夹具构造反例。
 */
export function isWindowSetComplete(snapshot: {
  readonly views: readonly { readonly id: string; readonly type: string }[];
  readonly focusedTabId?: string | null;
}): boolean {
  const counts = new Map<string, number>();
  for (const view of snapshot.views) {
    if (view.id !== view.type) {
      return false; // 单实例:视图 id ≡ 类型键。
    }
    counts.set(view.type, (counts.get(view.type) ?? 0) + 1);
  }
  for (const count of counts.values()) {
    if (count !== 1) {
      return false; // 无重无漏。
    }
  }
  if (counts.size !== snapshot.views.length) {
    return false;
  }
  if (
    snapshot.focusedTabId !== undefined &&
    snapshot.focusedTabId !== null &&
    !counts.has(snapshot.focusedTabId)
  ) {
    return false; // 焦点唯一:必须在场(窗口集常驻 ⇒ 恒在场)。
  }
  return true;
}

/**
 * 视图状态不变量机检(WP-72 的尺寸面重写;**新模型下只剩结构 / 语义面**,
 * 因为尺寸面(列宽 / 窗高 / 下限)已随列条带整体废止):
 *  ① `views` 每登记类型恰一次、无重无漏、id ≡ type;
 *  ② `focusedTabId` / `focusedType` 一致性且为 null 或在场;
 *  ③ `activeType` 为 null 或**在场且可见**(切换落点只在可见视图之间移动);
 *  ④ `leftRoleWidth` 非有限 / 负值非法(0 = 未知,合法);
 *  ⑤ `visible` 是布尔(**不存在「隐藏即消失」**:隐藏不改列表成员数)。
 */
export function isLayoutStateValid(snapshot: WorkspaceLayoutSnapshot): boolean {
  if (!isWindowSetComplete({ views: snapshot.views, focusedTabId: snapshot.focusedTabId })) {
    return false;
  }
  if (snapshot.focusedType !== snapshot.focusedTabId) {
    return false; // 两个焦点面必须同值(视图 id ≡ 类型键)。
  }
  const visible = new Set<string>();
  for (const view of snapshot.views) {
    if (typeof view.visible !== "boolean") {
      return false;
    }
    if (view.visible) {
      visible.add(view.type);
    }
    if (typeof view.title !== "string" || view.title.length === 0) {
      return false;
    }
  }
  if (snapshot.activeType !== null && !visible.has(snapshot.activeType)) {
    return false; // 切换落点必须是**可见**视图(不可见视图不在切换序列内)。
  }
  if (!Number.isFinite(snapshot.leftRoleWidth) || snapshot.leftRoleWidth < 0) {
    return false;
  }
  return true;
}

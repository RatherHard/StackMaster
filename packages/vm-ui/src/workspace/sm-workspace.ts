/**
 * <sm-workspace> —— 工作区容器(WP-F5;FE-X-02 唯一主体边界)。
 *
 * 职责 = 容纳、管理、排布工作标签页(FE-WS-01)+ 顶部菜单(FE-WS-03)+
 * 跨视图集成接线(F3/F4 交付能力的组合根):
 *
 *  - **列式滚动平铺**(Q1 定案 v1):工作区 = 列的有序序列,列间水平滚动
 *    (Niri 式,`scrollToColumn` / 激活时滚动可达任意列);列内二叉分割
 *    (Hyprland 式:新标签页落入焦点列并均分列高);
 *  - **拖拽排布**(pointer 事件):标签页标题栏按下拖动,落到目标标签页
 *    (上/下半 = 前/后)、目标列(尾插)或列区空白(开新列);
 *  - **标签页生命周期**:tab-type registry 可扩展(FE-MV-01 同类型可多开);
 *    打开 / 关闭 / 激活 / 焦点管理;关到最后一个 → 空态引导打开;标题栏 =
 *    类型名 + 序号 + 关闭钮;debug 占位类型呈现 WP-F8 空态;
 *  - **组合根装配**(README §双档数据源纪律):`client` 换绑即
 *    `new ProjectionDataSource(client.store)` 注入各标签页内容;
 *    `client.onProjectionChanged(() => 各内容 refresh())` 驱动视图刷新;
 *  - **跨视图联动**:`vma-select ↔ showRegion ↔ selectedRegionId` 回路在
 *    `<sm-byte-tab>` 内闭环;寄存器交叉标注(FE-RG-04)与跳转链
 *    (FE-ST-07/09)经字节视图行装饰挂点(宿主层追加渲染)落地;
 *  - **菜单动作**:`step`(FE-WS-04a)/ `reset`(FE-WS-05,Q5/M11 终态禁用
 *    + 新建引导)/ 手动重连(connection-replaced);拒绝动作呈现
 *    userVisibleError(含 explanation);断线横幅呈现"最近一次公开投影 +
 *    重连中"(零本地 VM 降级)。
 *
 * 纪律(CLAUDE.md 第十章):浏览器只保存公开投影与 UI 状态;动画只用
 * transform / opacity(拖拽反馈 = opacity);语义化 DOM。
 */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";

import type {
  ActionObject,
  PublicError,
} from "@stackmaster/protocol";

import {
  type ConnectionStatus,
  type ConnectionStatusEvent,
  type DisconnectReason,
  type SessionClient,
} from "../client/session-client.js";
import { SessionClientError } from "../client/session-errors.js";
import { ProjectionDataSource } from "../datasource/projection-data-source.js";
import type { MemoryDataSource, Row } from "../datasource/types.js";
import { formatAddressHex } from "../render/hex.js";
import { crossAnnotateRegisters, type RegisterHit } from "../views/register/cross-annotation.js";
import { resolveJumpChain } from "../views/chain/resolve.js";
// 模板依赖的自定义元素经 side-effect import 注册(独立入口自包含;
// sm-byte-tab 会级联注册字节视图 / VMA 侧栏,此处补齐跳转链与标注、菜单)。
import "../views/chain/sm-jump-chain.js";
import type { ViewportJumpDetail } from "../views/chain/sm-jump-chain.js";
import {
  type ByteRowDecoration,
} from "../views/byte/byte-view.js";
import { SmByteTab, type ByteTabRowDecorator } from "./byte-tab.js";
import "./sm-register-annotation.js";
import "./sm-workspace-menu.js";
import type { WorkspaceMenuActionDetail } from "./sm-workspace-menu.js";
import {
  defaultTabTypeRegistry,
  type WorkspaceTabTypeDescriptor,
  type WorkspaceTabTypeRegistry,
} from "./tab-registry.js";
import { WorkspaceLayoutModel, type MoveTarget, type WorkspaceLayoutSnapshot } from "./workspace-model.js";

/** 拖拽启动的位移阈值(px):超过才算拖拽(否则视为激活点击)。 */
const DRAG_THRESHOLD_PX = 3;

@customElement("sm-workspace")
export class SmWorkspace extends LitElement {
  // ── 公共属性(组合根注入面)─────────────────────────────────────────────

  /**
   * 会话客户端(组合根):换绑即重建公开档数据源(`new
   * ProjectionDataSource(client.store)`)并接入事件面(投影变更 / 连接
   * 状态 / 动作拒绝);null = 未接会话(菜单动作禁用,布局可用)。
   */
  @property({ attribute: false })
  client: SessionClient | null = null;

  /** 数据源直接注入(测试 / 无 client 装配;client 换绑时被组合根装配覆盖)。 */
  @property({ attribute: false })
  dataSource: MemoryDataSource | null = null;

  /** 标签页类型注册表(缺省 = 四类型默认注册表;WP-F6 可注入扩展副本)。 */
  @property({ attribute: false })
  tabTypes: WorkspaceTabTypeRegistry = defaultTabTypeRegistry;

  // ── 内部状态 ─────────────────────────────────────────────────────────────

  readonly #model = new WorkspaceLayoutModel();
  readonly #contents = new Map<string, HTMLElement>();
  #listenerDisposers: readonly (() => void)[] = [];

  // 菜单呈现状态(由 client 事件与投影快照驱动;render 读取)。
  #connectionStatus: ConnectionStatus = "disconnected";
  #disconnectReason: DisconnectReason | null = null;
  #reconnectAttempt = 0;
  #retryDelayMs: number | null = null;
  #projectionStatus: string | null = null;
  #revision: number | null = null;
  #lastError: PublicError | null = null;
  #jumpFeedback: string | null = null;

  // 交叉标注缓存(投影变更重建;行装饰按行区间过滤)。
  #registerHits: readonly RegisterHit[] = [];

  // 拖拽态(pointer 事件;标题栏按下 → 阈值外位移 = 拖拽,否则 = 激活)。
  #drag: { tabId: string; startX: number; startY: number; moved: boolean } | null = null;
  #lastVisibleTabId: string | null = null;

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-block-size: 24rem;
      border: 1px solid rgb(0 0 0 / 15%);
      border-radius: 8px;
      background: canvas;
      color: canvastext;
      overflow: hidden;
    }

    /* 列式滚动平铺:列间水平滚动(Niri 式),滚动可达任意列。 */
    .columns {
      flex: 1;
      display: flex;
      align-items: stretch;
      gap: 0.5rem;
      padding: 0.5rem;
      overflow-x: auto;
      overscroll-behavior-x: contain;
      min-block-size: 0;
    }

    .column {
      flex: 0 0 auto;
      inline-size: min(100%, 36rem);
      min-inline-size: 18rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    /* 列内二叉分割(Hyprland 式):同列标签页均分列高。 */
    .tab-panel {
      flex: 1 1 0;
      min-block-size: 9rem;
      display: flex;
      flex-direction: column;
      border: 1px solid rgb(0 0 0 / 15%);
      border-radius: 8px;
      overflow: hidden;
      background: canvas;
    }

    .tab-panel.focused {
      border-color: highlight;
    }

    /* 拖拽反馈:opacity(compositor 友好;零 transform 之外的动画属性)。 */
    .tab-panel.dragging {
      opacity: 0.5;
    }

    .tab-bar {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.25rem 0.5rem;
      border-block-end: 1px solid rgb(0 0 0 / 10%);
      background: color-mix(in srgb, canvas 92%, highlight 8%);
      cursor: grab;
      user-select: none;
      touch-action: none;
    }

    .tab-title {
      font-weight: 600;
      font-size: 0.8125rem;
    }

    .tab-close {
      margin-inline-start: auto;
      padding: 0 0.375rem;
      border: 1px solid rgb(0 0 0 / 20%);
      border-radius: 4px;
      background: canvas;
      color: canvastext;
      font: inherit;
      line-height: 1.3;
      cursor: pointer;
    }

    .tab-content {
      flex: 1;
      min-block-size: 0;
      display: flex;
      flex-direction: column;
      overflow: auto;
    }

    .tab-content > * {
      flex: 1;
    }

    .tab-placeholder,
    .empty {
      margin: 0;
      padding: 1rem;
      color: graytext;
      font-size: 0.875rem;
    }

    .jump-feedback {
      margin: 0;
      padding: 0.25rem 0.75rem;
      color: graytext;
      font-size: 0.75rem;
      border-block-end: 1px solid rgb(0 0 0 / 10%);
    }
  `;

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("client")) {
      this.#onClientChanged();
    }
    if (changed.has("dataSource")) {
      // 组合根数据面换绑(含 client 装配路径):重绑内容 + 重建标注缓存。
      this.#rebindContents();
      this.#rebuildAnnotationCache();
    }
  }

  protected override updated(): void {
    // 焦点变化 → 滚动使焦点标签页可见(列间水平滚动可达,验收底线)。
    const focusedTabId = this.#model.focusedTabId;
    if (focusedTabId !== this.#lastVisibleTabId) {
      this.#lastVisibleTabId = focusedTabId;
      if (focusedTabId !== null) {
        this.ensureTabVisible(focusedTabId);
      }
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // pointer 拖拽监听挂在 shadow root 内:避免跨 shadow 边界的 target 重定向。
    this.renderRoot.addEventListener("pointermove", this.#onPointerMove as EventListener);
    this.renderRoot.addEventListener("pointerup", this.#onPointerUp as EventListener);
    this.renderRoot.addEventListener("pointercancel", this.#onPointerCancel as EventListener);
    if (this.client !== null && this.#listenerDisposers.length === 0) {
      this.#attachClientListeners();
    }
  }

  override disconnectedCallback(): void {
    this.renderRoot.removeEventListener("pointermove", this.#onPointerMove as EventListener);
    this.renderRoot.removeEventListener("pointerup", this.#onPointerUp as EventListener);
    this.renderRoot.removeEventListener("pointercancel", this.#onPointerCancel as EventListener);
    this.#detachClientListeners();
    super.disconnectedCallback();
  }

  // ── 公共 API(宿主 / 测试接线面)─────────────────────────────────────────

  /** 布局快照(测试断言与宿主诊断面)。 */
  get layoutSnapshot(): WorkspaceLayoutSnapshot {
    return this.#model.snapshot;
  }

  /** 打开标签页(按注册表类型;返回标签页 id,未登记类型返回 null)。 */
  openTab(type: string): string | null {
    const descriptor = this.#tabTypeDescriptor(type);
    if (descriptor === undefined) {
      return null;
    }
    // Hyprland 式分割:新标签页落入焦点列(模型负责插入位),内容工厂产出
    // 内容元素;字节页注入行装饰挂点(交叉标注 + 跳转链)。
    const content = descriptor.createContent?.({ dataSource: this.dataSource }) ?? null;
    if (content instanceof SmByteTab) {
      content.rowDecorator = this.#rowDecorator;
    }
    const id = this.#model.openTab(type, descriptor.label);
    if (content !== null) {
      this.#contents.set(id, content);
    }
    this.requestUpdate();
    return id;
  }

  /** 关闭标签页(内容元素一并弃用;最后一个关闭后呈现空态引导)。 */
  closeTab(tabId: string): void {
    if (this.#model.tab(tabId) === null) {
      return;
    }
    this.#contents.delete(tabId);
    this.#model.closeTab(tabId);
    this.requestUpdate();
  }

  /** 激活标签页(焦点跟随 + 滚动可见)。 */
  activateTab(tabId: string): void {
    this.#model.activateTab(tabId);
    this.requestUpdate();
  }

  /** 滚动使标签页可见(jsdom 无布局环境静默)。 */
  ensureTabVisible(tabId: string): void {
    const panel = this.renderRoot.querySelector(`[data-tab-id="${tabId}"]`);
    if (panel !== null && typeof panel.scrollIntoView === "function") {
      try {
        panel.scrollIntoView({ block: "nearest", inline: "nearest" });
      } catch {
        // 无布局环境(jsdom):滚动增强失败静默,不影响可达性语义。
      }
    }
  }

  /** 列间水平滚动到目标列(Niri 式可达任意列)。 */
  scrollToColumn(column: number): void {
    const firstTabId = this.#model.tabIdsInColumn(column)[0];
    if (firstTabId !== undefined) {
      this.ensureTabVisible(firstTabId);
    }
  }

  // ── 组合根接线(client 事件面)──────────────────────────────────────────

  #onClientChanged(): void {
    this.#detachClientListeners();
    const client = this.client;
    if (client === null) {
      this.#syncConnectionFrom("disconnected", null, 0, null);
      this.#projectionStatus = null;
      this.#revision = null;
      return;
    }
    // 组合根装配(README):数据源 = client.store 的公开档包装。
    this.dataSource = new ProjectionDataSource(client.store);
    this.#attachClientListeners();
    this.#syncConnectionFrom(client.status, null, 0, null);
    this.#syncFromProjection();
    this.#refreshContents();
  }

  #attachClientListeners(): void {
    const client = this.client;
    if (client === null) {
      return;
    }
    const disposers: (() => void)[] = [
      // 投影变更 → 各标签页内容 refresh()(README 接线口径)。
      client.onProjectionChanged(() => {
        this.#syncFromProjection();
        this.#refreshContents();
        this.requestUpdate();
      }),
      client.onConnectionStatus((event: ConnectionStatusEvent) => {
        this.#syncConnectionFrom(event.status, event.reason, event.attempt, event.retryDelayMs);
        this.requestUpdate();
      }),
      client.onActionRejected((error: PublicError) => {
        // 拒绝耦合:userVisibleError 必在(含 explanation 教学解释)。
        this.#lastError = error;
        this.requestUpdate();
      }),
    ];
    this.#listenerDisposers = disposers;
  }

  #detachClientListeners(): void {
    for (const dispose of this.#listenerDisposers) {
      dispose();
    }
    this.#listenerDisposers = [];
  }

  #syncConnectionFrom(
    status: ConnectionStatus,
    reason: DisconnectReason | null,
    attempt: number,
    retryDelayMs: number | null,
  ): void {
    this.#connectionStatus = status;
    this.#disconnectReason = reason;
    this.#reconnectAttempt = attempt;
    this.#retryDelayMs = retryDelayMs;
  }

  #syncFromProjection(): void {
    const projection = this.client?.projection ?? null;
    this.#projectionStatus = projection?.status ?? null;
    this.#revision = projection?.revision ?? null;
  }

  #refreshContents(): void {
    this.#rebuildAnnotationCache();
    for (const content of this.#contents.values()) {
      const refreshable = content as { refresh?: () => void };
      if (typeof refreshable.refresh === "function") {
        refreshable.refresh();
      }
    }
  }

  #rebindContents(): void {
    const dataSource = this.dataSource;
    for (const content of this.#contents.values()) {
      const bindable = content as { dataSource?: MemoryDataSource | null };
      if ("dataSource" in content && bindable.dataSource !== dataSource) {
        bindable.dataSource = dataSource;
      }
    }
  }

  #rebuildAnnotationCache(): void {
    const dataSource = this.dataSource;
    this.#registerHits =
      dataSource === null ? [] : crossAnnotateRegisters(dataSource.registers(), dataSource.regions());
  }

  #tabTypeDescriptor(type: string): WorkspaceTabTypeDescriptor | undefined {
    return this.tabTypes.get(type);
  }

  // ── 菜单动作 ─────────────────────────────────────────────────────────────

  #onMenuAction(event: Event): void {
    const { action } = (event as CustomEvent<WorkspaceMenuActionDetail>).detail;
    switch (action.action) {
      case "step":
        // FE-WS-04a:指令步进 = step 动作(恰执行一条指令后暂停)。
        this.#submitAction({ type: "step", args: {} });
        break;
      case "reset":
        // FE-WS-05(Q5/M11):运行中 = reset;终态菜单已禁用(引导新建)。
        this.#submitAction({ type: "reset", args: {} });
        break;
      case "reconnect":
        // 手动重连(单连接策略:connection-replaced 不自动重连,宿主可点)。
        this.client?.connect();
        break;
      case "new-session":
        // 终态引导动作:close_session(如未关)+ create_session 新流程由
        // 宿主(plugin-dev 壳)执行;工作区只发请求事件。
        this.dispatchEvent(new CustomEvent("new-session-request", { bubbles: true, composed: true }));
        break;
      case "open-tab":
        this.openTab(action.tabType);
        break;
    }
  }

  #submitAction(action: ActionObject): void {
    const client = this.client;
    if (client === null) {
      this.#lastError = { code: "internal_error", message: "尚未连接会话:动作未提交" };
      this.requestUpdate();
      return;
    }
    try {
      client.sendAction(action);
    } catch (error) {
      // sendAction 断线 / 无会话抛 SessionClientError:呈现为可解释错误
      // (不排队、不本地补执行——动作只能经认证 WSS)。
      this.#lastError = {
        code: "internal_error",
        message:
          error instanceof SessionClientError ? error.message : "动作提交失败(客户端侧错误)",
      };
      this.requestUpdate();
    }
  }

  // ── 行装饰(寄存器交叉标注 + 跳转链,FE-RG-04 / FE-ST-07/09 集成)────────

  /**
   * 字节视图行装饰(宿主层追加渲染;不改 F3/F4 已交付组件——挂点经
   * byte-view 的 `rowDecorator` 最小 diff 提供)。虚拟列表只对可视行调用
   * renderItem → 跳转链天然只在可视行挂载(性能约束)。
   */
  readonly #rowDecorator: ByteTabRowDecorator = (row: Row): ByteRowDecoration | null => {
    const dataSource = this.dataSource;
    if (dataSource === null) {
      return null;
    }
    return {
      lead: this.#renderRowRegisterAnnotation(row),
      specialSuffix: this.#renderRowJumpChain(row, dataSource),
    };
  };

  /** 行左缘:寄存器交叉标注(命中地址落在本行区间才产出,FE-RG-04)。 */
  #renderRowRegisterAnnotation(row: Row): unknown {
    if (this.#registerHits.length === 0) {
      return nothing;
    }
    const base = BigInt(row.addressHex);
    const span = BigInt(Math.max(row.cells.length, 1));
    const hits = this.#registerHits.filter((hit) => {
      const target = BigInt(hit.targetAddressHex);
      return target >= base && target < base + span;
    });
    if (hits.length === 0) {
      return nothing;
    }
    return html`<sm-register-annotation .hits=${hits}></sm-register-annotation>`;
  }

  /**
   * 行右段(.row-special 槽位):8 字节小端解释形似地址(可解引用且落回
   * 某可见区域范围)才挂载 `<sm-jump-chain>`(FE-ST-07;窗口外 / 非地址不挂)。
   */
  #renderRowJumpChain(row: Row, dataSource: MemoryDataSource): unknown {
    try {
      const segments = resolveJumpChain(row.addressHex, dataSource, { maxSegments: 1 });
      const first = segments[0];
      if (first === undefined || first.valueHex === undefined || first.targetAddressHex === undefined) {
        return nothing;
      }
    } catch {
      return nothing; // 解析异常按"形似地址不成立"处理,不阻塞行渲染。
    }
    return html`<sm-jump-chain
      class="row-jump-chain"
      .dataSource=${dataSource}
      start-address-hex=${row.addressHex}
    ></sm-jump-chain>`;
  }

  /** viewport-jump(FE-ST-09):窗口内滚动到目标行;窗口外给反馈不报错。 */
  readonly #onViewportJump = (event: Event): void => {
    const detail = (event as CustomEvent<ViewportJumpDetail>).detail;
    if (detail === undefined) {
      return;
    }
    const addressText = formatAddressHex(detail.addressHex, 8);
    const byteTab = event.composedPath().find((node): node is SmByteTab => node instanceof SmByteTab);
    const view = byteTab?.byteView ?? null;
    const moved = detail.withinWindow ? (view?.scrollToAddress(detail.addressHex) ?? false) : false;
    this.#jumpFeedback = moved
      ? `已跳转到 ${addressText}`
      : `${addressText} 在可见窗口之外`;
    this.requestUpdate();
  };

  // ── 拖拽排布(pointer 事件;动画只用 opacity)────────────────────────────

  #onTabBarPointerDown(event: PointerEvent, tabId: string): void {
    // 关闭钮不触发拖拽 / 激活。
    if (event.target instanceof Element && event.target.closest(".tab-close") !== null) {
      return;
    }
    this.#drag = { tabId, startX: event.clientX, startY: event.clientY, moved: false };
  }

  readonly #onPointerMove = (event: PointerEvent): void => {
    const drag = this.#drag;
    if (drag === null || drag.moved) {
      return;
    }
    const moved =
      Math.abs(event.clientX - drag.startX) > DRAG_THRESHOLD_PX ||
      Math.abs(event.clientY - drag.startY) > DRAG_THRESHOLD_PX;
    if (moved) {
      drag.moved = true;
      this.#panelOf(drag.tabId)?.classList.add("dragging");
    }
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    const drag = this.#drag;
    this.#cancelDrag();
    if (drag === null) {
      return;
    }
    if (!drag.moved) {
      // 位移未过阈值 = 激活点击(FE-WS-01 焦点管理)。
      this.#model.activateTab(drag.tabId);
      this.requestUpdate();
      return;
    }
    const target = this.#resolveDropTarget(event);
    if (target !== null) {
      this.#model.moveTab(drag.tabId, target);
      this.requestUpdate();
    }
  };

  readonly #onPointerCancel = (): void => {
    this.#cancelDrag();
  };

  #cancelDrag(): void {
    const drag = this.#drag;
    this.#drag = null;
    if (drag !== null) {
      this.#panelOf(drag.tabId)?.classList.remove("dragging");
    }
  }

  #panelOf(tabId: string): Element | null {
    return this.renderRoot.querySelector(`[data-tab-id="${tabId}"]`);
  }

  /** 指针落点 → 移动目标(列区外 = null 不动;列区空白 = 开新列)。 */
  #resolveDropTarget(event: PointerEvent): MoveTarget | null {
    const element = event.target;
    if (!(element instanceof Element) || element.closest("[data-columns]") === null) {
      return null;
    }
    const tabElement = element.closest("[data-tab-id]");
    if (tabElement !== null) {
      const tabId = tabElement.getAttribute("data-tab-id");
      const position = tabId === null ? null : this.#model.positionOfTab(tabId);
      if (position !== null) {
        // 落点在目标标签页的上/下半 = 插到其前/后(jsdom 固定桩矩形下按
        // clientY 判定;真实浏览器同语义)。
        const rect = tabElement.getBoundingClientRect();
        const after = event.clientY >= rect.top + rect.height / 2;
        return { column: position.column, index: after ? position.index + 1 : position.index };
      }
    }
    const columnElement = element.closest("[data-column-index]");
    if (columnElement !== null) {
      const column = Number(columnElement.getAttribute("data-column-index"));
      if (Number.isFinite(column)) {
        return { column, index: this.#model.tabIdsInColumn(column).length };
      }
    }
    return { column: this.#model.columnCount, index: 0 };
  }

  // ── 渲染 ─────────────────────────────────────────────────────────────────

  protected override render(): unknown {
    const snapshot = this.#model.snapshot;
    return html`
      <sm-workspace-menu
        .tabTypes=${this.tabTypes.list()}
        .connectionStatus=${this.#connectionStatus}
        .disconnectReason=${this.#disconnectReason}
        .reconnectAttempt=${this.#reconnectAttempt}
        .retryDelayMs=${this.#retryDelayMs}
        .projectionStatus=${this.#projectionStatus}
        .revision=${this.#revision}
        .hasSession=${this.client !== null}
        .lastError=${this.#lastError}
        @workspace-menu-action=${this.#onMenuAction}
      ></sm-workspace-menu>
      ${this.#jumpFeedback === null
        ? nothing
        : html`<p class="jump-feedback" role="status">${this.#jumpFeedback}</p>`}
      ${snapshot.columns.length === 0 ? this.#renderEmptyState() : nothing}
      <main class="columns" data-columns aria-label="工作区标签页区域" @viewport-jump=${this.#onViewportJump}>
        ${snapshot.columns.map((column, columnIndex) => html`
          <div class="column" data-column-index=${columnIndex}>
            ${column.tabIds.map((tabId) => this.#renderPanel(tabId))}
          </div>
        `)}
      </main>
    `;
  }

  #renderEmptyState(): unknown {
    return html`<p class="empty" role="status">工作区为空:从顶部菜单「打开」选择一个标签页类型开始</p>`;
  }

  #renderPanel(tabId: string): unknown {
    const info = this.#model.tab(tabId);
    if (info === null) {
      return nothing;
    }
    const content = this.#contents.get(info.id) ?? null;
    const descriptor = this.#tabTypeDescriptor(info.type);
    const focused = this.#model.focusedTabId === info.id;
    return html`
      <section
        class="tab-panel${focused ? " focused" : ""}"
        data-tab-id=${info.id}
        aria-label=${info.title}
      >
        <header
          class="tab-bar"
          @pointerdown=${(event: PointerEvent) => this.#onTabBarPointerDown(event, info.id)}
        >
          <span class="tab-title">${info.title}</span>
          <button
            type="button"
            class="tab-close"
            aria-label="关闭 ${info.title}"
            @pointerdown=${(event: PointerEvent) => event.stopPropagation()}
            @click=${() => this.closeTab(info.id)}
          >
            ×
          </button>
        </header>
        <div class="tab-content">
          ${content ??
          html`<p class="tab-placeholder" role="status">
            ${descriptor?.placeholderNote ?? "该类型暂未提供内容"}
          </p>`}
        </div>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sm-workspace": SmWorkspace;
  }
}

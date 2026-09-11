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
  ActionResponse,
  CheckpointRef,
  ProjectionDelta,
  PublicError,
  VisibleMemoryRegion,
} from "@stackmaster/protocol";

import {
  type ConnectionStatus,
  type ConnectionStatusEvent,
  type DisconnectReason,
  type SessionClient,
} from "../client/session-client.js";
import { SessionClientError } from "../client/session-errors.js";
import {
  createDebugDataSource,
  DebugDataSource,
  type DebugDataSourceChangeEvent,
  type DebugSessionLike,
} from "../datasource/debug-data-source.js";
import { ProjectionDataSource } from "../datasource/projection-data-source.js";
import type { MemoryDataSource, Row } from "../datasource/types.js";
import type { PublicErrorMapping, PublicHint } from "../ed/ed-types.js";
import { buildTimeline, type ActionTimelineRecord } from "../ed/timeline.js";
import type {
  ChallengeStaticFace,
  DescriptorEncodingEntryView,
  DescriptorEncodingOperandView,
} from "../descriptor/challenge-descriptor.js";
import { LocaleController, t } from "../i18n/i18n.js";
import { formatAddressHex } from "../render/hex.js";
import { ensureSmThemeStyles, SM_THEME_ATTRIBUTE, type SmThemeValue } from "../theme/theme-tokens.js";
import { crossAnnotateRegisters, type RegisterHit } from "../views/register/cross-annotation.js";
import { resolveJumpChain } from "../views/chain/resolve.js";
// 模板依赖的自定义元素经 side-effect import 注册(独立入口自包含;
// sm-byte-tab 会级联注册字节视图 / VMA 侧栏,此处补齐跳转链与标注、菜单、
// ED 教学组件——F8 工作区挂接)。
import "../views/chain/sm-jump-chain.js";
import type { ViewportJumpDetail } from "../views/chain/sm-jump-chain.js";
import {
  type ByteRowDecoration,
} from "../views/byte/byte-view.js";
import { SmByteTab, type ByteTabRowDecorator } from "./byte-tab.js";
import "./sm-register-annotation.js";
import "./sm-workspace-menu.js";
import type { WorkspaceMenuActionDetail } from "./sm-workspace-menu.js";
// ED 七组件(F9 契约面)挂接:教学面板(提示 / 错误解释)与 ED 标签页内容。
// 侧作用 import 注册自定义元素;类型经各组件模块导出面引用(见下方 import)。
import "../views/ed/sm-structure-view.js";
import "../views/ed/sm-call-stack.js";
import "../views/ed/sm-memory-diff.js";
import "../views/ed/sm-timeline.js";
import "../views/ed/sm-checkpoints.js";
import "../views/ed/sm-hint-ladder.js";
import "../views/ed/sm-error-explainer.js";
import "../views/instruction/sm-instruction-view.js";
import { pausedReasonText } from "../views/instruction/sm-instruction-view.js";
import type { HighlightJumpDetail } from "../views/ed/sm-structure-view.js";
import {
  defaultTabTypeRegistry,
  PAYLOAD_TAB_TYPE,
  type WorkspaceTabTypeDescriptor,
  type WorkspaceTabTypeRegistry,
} from "./tab-registry.js";
import { WorkspaceLayoutModel, type MoveTarget, type WorkspaceLayoutSnapshot } from "./workspace-model.js";

/** 拖拽启动的位移阈值(px):超过才算拖拽(否则视为激活点击)。 */
const DRAG_THRESHOLD_PX = 3;

/** 工作区模式(FE-WS-06):解题(公开投影)与调试(调试通道)双档。 */
export type WorkspaceMode = "solve" | "debug";

/**
 * 题目公开描述包的教学切面(宿主注入;本地结构类型,对齐锚 = ed-types.ts,
 * 双包 Schema 语义)。WP-54 起宿主(插件装配管线 / dev 壳正式通道)以
 * `fetchChallengeDescriptor` 加载正式下发数据注入;夹具注入保留为 dev 壳
 * 开发通道。浏览器只保存公开投影与 UI 状态——描述包本身 PUBLIC。
 */
export interface WorkspaceChallengeDescriptor {
  /** 提示 ladder(FE-ED-06;revealPolicy 语义在组件本地执行)。 */
  readonly hintLadder?: readonly PublicHint[];
  /** 错误教学注解映射(FE-ED-07;按 errorCode 匹配)。 */
  readonly publicErrorMapping?: readonly PublicErrorMapping[];
}

/** 工作区静态面注入形状(WP-54;= 描述包视图的 ChallengeStaticFace 投影)。 */
export type WorkspaceChallengeStaticFace = ChallengeStaticFace;

/**
 * 描述包接入状态(WP-54 缺席明示纪律:加载失败 ≠ 空数据)——
 *  - `unknown`:宿主未接入描述包(缺省;不渲染任何描述包面,既有装配零影响);
 *  - `loading`:获取进行中(不渲染,晚到即注入);
 *  - `loaded`:已就绪(`challengeDescriptor` / `challengeStatic` 携带数据);
 *  - `absent`:加载失败或未下发(静态面明示缺席,与「题目没有配置提示」区分;
 *    会话不受影响)。
 */
export type WorkspaceDescriptorStatus = "unknown" | "loading" | "loaded" | "absent";

/** 调试档数据源工厂(测试接缝;缺省 = createDebugDataSource 组合根装配)。 */
export type DebugDataSourceFactory = (client: SessionClient) => DebugDataSource | null;

/** 字节视图滚动面(SmByteView 结构子集;解耦视图案与测试替身)。 */
interface SmByteViewLike {
  scrollToAddress(addressHex: string): boolean;
}

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

  /**
   * 调试模式可用性(FE-WS-06):题目 debugMode 声明(plugin-dev 开发壳经
   * 夹具描述包注入)。false = 未启用调试的题目,菜单隐藏模式切换项。
   */
  @property({ type: Boolean, attribute: "debug-mode-available" })
  debugModeAvailable = false;

  /** 题目公开描述包教学切面(提示 ladder / 错误注解;ED 组件挂接数据)。 */
  @property({ attribute: false })
  challengeDescriptor: WorkspaceChallengeDescriptor | null = null;

  /**
   * 题目静态面(WP-54):标题 / 简介 / VM Profile / encodingTable 投影
   * (来自正式下发描述包;`descriptorStatus = "loaded"` 时渲染)。
   */
  @property({ attribute: false })
  challengeStatic: WorkspaceChallengeStaticFace | null = null;

  /**
   * 描述包接入状态(WP-54):缺省 `unknown` = 宿主未接入(零渲染面,既有
   * 装配零影响);`absent` = 静态面缺席明示;`loaded` = briefing 面渲染。
   */
  @property({ attribute: false })
  descriptorStatus: WorkspaceDescriptorStatus = "unknown";

  /**
   * 调试档数据源工厂(测试接缝):缺省 = 组合根装配
   * `createDebugDataSource(client)`(DebugChannelClient 缺省传输);
   * 测试注入假传输 / 替身数据源。返回 null = 会话未创建。
   */
  @property({ attribute: false })
  debugDataSourceFactory: DebugDataSourceFactory | null = null;

  /**
   * 主题属性(WP-53 / Q6 独立使用形态便捷注入面):`light` / `dark` / `auto`
   * (auto = 跟随系统 prefers-color-scheme,CSS media 承担)。设值即转写为
   * 自身 `data-sm-theme`(最近锚优先——显式属性胜过祖先锚);缺省 null =
   * 不写锚,由最近的祖先 `data-sm-theme`(嵌入形态)或 light 缺省决定。
   */
  @property({ type: String, attribute: "theme" })
  theme: SmThemeValue | null = null;

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

  // ── 模式切换与调试档状态(FE-WS-06/07,WP-F8)──
  #mode: WorkspaceMode = "solve";
  #debugDataSource: DebugDataSource | null = null;
  /** 调试档变更退订(切回解题模式 / client 换绑时注销)。 */
  #debugChangeDisposer: (() => void) | null = null;
  /** 调试交互反馈(暂停原因 / attach / 通道错误;菜单下方状态行)。 */
  #debugFeedback: string | null = null;

  // ── 动作账本与教学组件状态(ED 挂接,公开投影 + UI 状态)──
  /** 动作账本(onActionResponse 流 × 发送侧 FIFO 配对;时间线数据源)。 */
  readonly #actionRecords: ActionTimelineRecord[] = [];
  /** 发送侧动作 FIFO(响应无动作本体;教学 UI 不与其他动作入口混用——F6 已登记取舍)。 */
  readonly #pendingActions: ActionObject[] = [];
  /** checkpoint 列表(list_checkpoints REST 刷新;时间线 + checkpoint 页)。 */
  #checkpoints: readonly CheckpointRef[] = [];
  /** 教学失败计数(ActionResponse failed 反馈自账;提示 ladder 解锁依据)。 */
  #failureCount = 0;
  /** 前一投影 visibleRegions(内存 diff 的动作前快照)。 */
  #beforeRegions: readonly VisibleMemoryRegion[] | undefined = undefined;
  /** 最近一次投影增量(内存 diff 的 dirtyRanges 源)。 */
  #lastDelta: ProjectionDelta | null = null;
  /** 最近已知区域快照(store 订阅维护,产出下一动作的前快照)。 */
  #lastRegionsSnapshot: readonly VisibleMemoryRegion[] | undefined = undefined;

  // 拖拽态(pointer 事件;标题栏按下 → 阈值外位移 = 拖拽,否则 = 激活)。
  #drag: { tabId: string; startX: number; startY: number; moved: boolean } | null = null;
  #lastVisibleTabId: string | null = null;

  /** i18n:连接时消费 data-sm-language 锚;locale 变化即重渲染(WP-53)。 */
  readonly #i18n = new LocaleController(this);
  /** theme 属性是否写过自身锚(null 归位时只清理自身写入面)。 */
  #themeAnchorWritten = false;

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-block-size: 24rem;
      border: 1px solid var(--sm-border, rgb(0 0 0 / 15%));
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
      border: 1px solid var(--sm-border, rgb(0 0 0 / 15%));
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
      border-block-end: 1px solid var(--sm-divider, rgb(0 0 0 / 10%));
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
      border: 1px solid var(--sm-border-button, rgb(0 0 0 / 20%));
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
      border-block-end: 1px solid var(--sm-divider, rgb(0 0 0 / 10%));
    }

    /* 调试档状态行(F8):切换 / attach / 暂停反馈(降级文案明示)。 */
    .debug-feedback {
      margin: 0;
      padding: 0.25rem 0.75rem;
      color: canvastext;
      font-size: 0.75rem;
      background: color-mix(in srgb, field 94%, accentcolor 6%);
      border-block-end: 1px solid var(--sm-divider, rgb(0 0 0 / 10%));
    }

    /* 教学面板(F8 ED 挂接,取简 = details 折叠区):提示 ladder + 错误解释。 */
    .teaching-panel {
      border-block-end: 1px solid var(--sm-divider, rgb(0 0 0 / 10%));
      font-size: 0.8125rem;
    }

    .teaching-panel > summary {
      padding: 0.25rem 0.75rem;
      color: graytext;
      cursor: pointer;
      font-size: 0.75rem;
    }

    .teaching-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 0.5rem;
      padding: 0.25rem 0.75rem 0.5rem;
    }

    @media (max-width: 48rem) {
      .teaching-grid {
        grid-template-columns: minmax(0, 1fr);
      }
    }

    /* 题目静态面(WP-54:briefing / vmProfile / encodingTable;沿 teaching-panel
       的 details 折叠取简,零视觉重设计)。 */
    .challenge-panel {
      border-block-end: 1px solid var(--sm-divider, rgb(0 0 0 / 10%));
      font-size: 0.8125rem;
    }

    .challenge-panel > summary {
      padding: 0.25rem 0.75rem;
      color: graytext;
      cursor: pointer;
      font-size: 0.75rem;
    }

    .challenge-body {
      padding: 0.25rem 0.75rem 0.5rem;
      display: grid;
      gap: 0.375rem;
    }

    .challenge-title {
      margin: 0;
      font-size: 0.875rem;
      font-weight: 600;
    }

    .challenge-summary {
      margin: 0;
      overflow-wrap: anywhere;
    }

    .challenge-facts {
      margin: 0;
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 0.125rem 0.75rem;
    }

    .challenge-facts dt {
      color: graytext;
    }

    .challenge-facts dd {
      margin: 0;
      overflow-wrap: anywhere;
    }

    .mono {
      font-family: ui-monospace, monospace;
    }

    .encoding-table {
      margin: 0;
      border-collapse: collapse;
      font-family: ui-monospace, monospace;
      font-size: 0.75rem;
    }

    .encoding-table th,
    .encoding-table td {
      padding: 0.125rem 0.5rem;
      border: 1px solid var(--sm-divider-faint, rgb(0 0 0 / 8%));
      text-align: left;
    }

    .challenge-absent {
      margin: 0;
      padding: 0.25rem 0.75rem 0.5rem;
      color: graytext;
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
    if (changed.has("theme")) {
      this.#syncThemeAnchor();
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
    // LocaleController 经构造副作用注册(Lit addController);显式读点满足 lint。
    void this.#i18n;
    // 主题锚样式表(幂等)+ 独立使用形态的 theme 属性转写(最近锚优先)。
    ensureSmThemeStyles(this.ownerDocument ?? document);
    this.#syncThemeAnchor();
    // pointer 拖拽监听挂在 shadow root 内:避免跨 shadow 边界的 target 重定向。
    this.renderRoot.addEventListener("pointermove", this.#onPointerMove as EventListener);
    this.renderRoot.addEventListener("pointerup", this.#onPointerUp as EventListener);
    this.renderRoot.addEventListener("pointercancel", this.#onPointerCancel as EventListener);
    if (this.client !== null && this.#listenerDisposers.length === 0) {
      this.#attachClientListeners();
    }
  }

  /** 独立使用形态:theme 属性 → 自身 data-sm-theme(最近锚优先,确定性)。 */
  #syncThemeAnchor(): void {
    if (this.theme !== null) {
      this.setAttribute(SM_THEME_ATTRIBUTE, this.theme);
      this.#themeAnchorWritten = true;
    } else if (this.#themeAnchorWritten) {
      // 归位 null:只移除自身经 theme 属性写入的锚,不动外部直接设置的锚。
      this.removeAttribute(SM_THEME_ATTRIBUTE);
      this.#themeAnchorWritten = false;
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
    // 内容元素;字节页注入行装饰挂点(交叉标注 + 跳转链);payload 页等
    // 声明 actionSink 属性的内容(duck-typing,同 dataSource 约定)注入
    // 会话客户端(动作提交面)。
    const content = descriptor.createContent?.({ dataSource: this.dataSource }) ?? null;
    if (content instanceof SmByteTab) {
      content.rowDecorator = this.#rowDecorator;
    }
    this.#bindActionSink(content);
    // 展示名:i18n 键优先(WP-53),按打开时刻 locale 求值(标题固化,登记)。
    const label = descriptor.labelKey !== undefined ? t(descriptor.labelKey) : descriptor.label;
    const id = this.#model.openTab(type, label);
    if (content !== null) {
      this.#contents.set(id, content);
    }
    // ED 组件面:新开标签页立即注入当前投影 / 账本切面(不等下一次投影事件)。
    this.#syncEdContents();
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
    // client 换绑(新会话)= 调试会话失效:确定性退回解题模式(重连 / 重放
    // 对齐语义归新会话的调试通道,旧调试缓存不跨会话复用)。
    this.#teardownDebugSource();
    this.#mode = "solve";
    this.#debugFeedback = null;
    // 动作账本 / 失败计数 / diff 快照随会话作废(UI 状态以会话为界)。
    this.#actionRecords.length = 0;
    this.#pendingActions.length = 0;
    this.#checkpoints = [];
    this.#failureCount = 0;
    this.#beforeRegions = undefined;
    this.#lastDelta = null;
    this.#lastRegionsSnapshot = undefined;
    const client = this.client;
    if (client === null) {
      this.#syncConnectionFrom("disconnected", null, 0, null);
      this.#projectionStatus = null;
      this.#revision = null;
      this.dataSource = null;
      return;
    }
    // 组合根装配(README):数据源 = client.store 的公开档包装(解题模式)。
    this.dataSource = new ProjectionDataSource(client.store);
    this.#lastRegionsSnapshot = client.store.snapshot?.visibleRegions;
    this.#attachClientListeners();
    this.#syncConnectionFrom(client.status, null, 0, null);
    this.#syncFromProjection();
    this.#refreshContents();
    this.#syncEdContents();
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
        this.#syncEdContents();
        this.requestUpdate();
      }),
      client.onConnectionStatus((event: ConnectionStatusEvent) => {
        this.#syncConnectionFrom(event.status, event.reason, event.attempt, event.retryDelayMs);
        this.requestUpdate();
      }),
      client.onActionRejected((error: PublicError) => {
        // 拒绝耦合:userVisibleError 必在(含 explanation 教学解释)。
        this.#lastError = error;
        this.#syncEdContents();
        this.requestUpdate();
      }),
      // 动作账本(ED 时间线 / 失败计数 / checkpoint 刷新时点)。
      client.onActionResponse((response: ActionResponse) => this.#recordActionResponse(response)),
      // store 级订阅:捕获"前一投影 visibleRegions + delta"(内存 diff 前快照;
      // onProjectionChanged 是合帧后通知,拿不到前值,必须在 store 变更点维护)。
      client.store.subscribe((change) => {
        if (change.kind === "delta" && change.delta !== null) {
          this.#beforeRegions = this.#lastRegionsSnapshot;
          this.#lastDelta = change.delta;
        } else if (change.kind === "replace") {
          this.#beforeRegions = undefined;
          this.#lastDelta = null;
        }
        this.#lastRegionsSnapshot = client.store.snapshot?.visibleRegions;
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
      this.#bindActionSink(content);
    }
  }

  /**
   * 动作提交面注入(WP-F6 payload 页;duck-typing 约定同 dataSource):
   * 内容声明 `actionSink` 属性即接收会话客户端(SessionClient 结构兼容
   * `PayloadActionSink`)。client 换绑 → dataSource 变更 → 经此处重绑。
   */
  #bindActionSink(content: HTMLElement | null): void {
    if (content !== null && "actionSink" in content) {
      (content as { actionSink?: unknown }).actionSink = this.client;
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

  // ── 动作账本(ED 时间线 / 失败计数 / checkpoint 刷新时点)────────────────

  /**
   * 响应 → 账本条目:响应不携带动作本体,以发送侧 FIFO 配对(教学 UI 约定
   * payload 运行 / 暂停期间不混用其他动作入口,F6 已登记取舍;队列空时的
   * 响应以 step 占位呈现,不伪造动作参数)。
   */
  #recordActionResponse(response: ActionResponse): void {
    const action = this.#pendingActions.shift() ?? ({ type: "step", args: {} } as ActionObject);
    this.#actionRecords.push({ action, response, at: Date.now() });
    // 教学失败计数(FE-ED-06):failed 状态反馈自账;rejected 是动作非法
    // (不走提示解锁),won / paused / running 不计。
    if (response.status === "failed") {
      this.#failureCount += 1;
    }
    // checkpoint 刷新时点(WP-F9 对接登记):create/checkout 响应到达且
    // 未被拒 → 重拉 list_checkpoints 刷新列表与时间线。
    if (
      (action.type === "create_checkpoint" || action.type === "checkout_checkpoint") &&
      response.status !== "rejected"
    ) {
      void this.#refreshCheckpoints();
    }
    this.#syncEdContents();
    this.requestUpdate();
  }

  async #refreshCheckpoints(): Promise<void> {
    const client = this.client;
    if (client === null) {
      return;
    }
    try {
      const response = await client.listCheckpoints();
      if (response.command === "list_checkpoints") {
        this.#checkpoints = response.payload.checkpoints;
        this.#syncEdContents();
        this.requestUpdate();
      }
    } catch {
      // 列表刷新失败静默(下一次 checkpoint 动作回流重试);零伪造数据。
    }
  }

  // ── 模式切换(FE-WS-06/07,WP-F8)────────────────────────────────────────

  /** 当前工作区模式(诊断 / 测试面)。 */
  get mode(): WorkspaceMode {
    return this.#mode;
  }

  /** 调试档数据源(调试模式;解题模式为 null)。 */
  get debugDataSource(): DebugDataSource | null {
    return this.#debugDataSource;
  }

  #onDebugSourceChange(event: DebugDataSourceChangeEvent): void {
    switch (event.kind) {
      case "paused":
        if (event.paused !== undefined) {
          const reason = pausedReasonText(event.paused.reason);
          this.#debugFeedback = t("debug.pausedAt", {
            reason,
            address: ` @ ${event.paused.addressHex}`,
          });
        }
        break;
      case "attached":
        this.#debugFeedback = t("debug.attachedReady");
        break;
      case "error":
        this.#debugFeedback = t("debug.channelError");
        break;
      case "connection":
        this.#debugFeedback =
          this.#debugDataSource?.connectionStatus === "disconnected"
            ? t("debug.channelDisconnected")
            : null;
        break;
      default:
        break;
    }
    this.requestUpdate();
  }

  /** 切换到调试模式:重绑数据源(DebugDataSource)→ 连接并 attach。 */
  #enterDebugMode(): void {
    const client = this.client;
    if (client === null || client.sessionId === null) {
      this.#debugFeedback = t("debug.noSession");
      this.requestUpdate();
      return;
    }
    this.#teardownDebugSource();
    const factory = this.debugDataSourceFactory ?? ((session: DebugSessionLike) => createDebugDataSource(session));
    const debugSource = factory(client);
    if (debugSource === null) {
      this.#debugFeedback = t("debug.sourceFailed");
      this.requestUpdate();
      return;
    }
    this.#debugDataSource = debugSource;
    this.#debugChangeDisposer = debugSource.onChange((event) => this.#onDebugSourceChange(event));
    this.#mode = "debug";
    // 断点积木双档(FE-WS-07):payload 断点集合并入调试断点(最小接线挂点)。
    this.#mergePayloadBreakpoints(debugSource);
    // 换绑数据源(字节视图换绑即重建 = 锚点/滚动重置,F5 既有验收口径)。
    this.dataSource = debugSource;
    debugSource.attach();
    this.#debugFeedback = t("debug.connecting");
    this.#rebindContents();
    this.#syncEdContents();
    this.requestUpdate();
  }

  /** 切回解题模式:释放调试档 → 重绑公开投影数据源。 */
  #exitDebugMode(): void {
    this.#teardownDebugSource();
    this.#mode = "solve";
    this.#debugFeedback = null;
    const client = this.client;
    this.dataSource = client === null ? null : new ProjectionDataSource(client.store);
    this.#lastRegionsSnapshot = client?.store.snapshot?.visibleRegions;
    this.#rebindContents();
    this.#rebuildAnnotationCache();
    this.#syncEdContents();
    this.requestUpdate();
  }

  #teardownDebugSource(): void {
    this.#debugChangeDisposer?.();
    this.#debugChangeDisposer = null;
    this.#debugDataSource?.dispose();
    this.#debugDataSource = null;
  }

  /**
   * 断点积木双档(FE-WS-07):payload 断点积木在解题模式 = 步进暂停(WP-F6
   * 现状);调试模式 = 断点集合并入调试断点。v1 编译器断点步骤无地址承载
   * (PayloadStep.kind "breakpoint" 无 addressHex 字段),本挂点消费内容元素
   * `breakpointAddresses()` 声明面——v1 payload 页返回空,编译器演进携带地址
   * 后即自动并入(最小接线登记)。
   */
  #mergePayloadBreakpoints(debugSource: DebugDataSource): void {
    for (const content of this.#contents.values()) {
      const provider = (content as { breakpointAddresses?: () => readonly string[] } | null)
        ?.breakpointAddresses;
      if (typeof provider !== "function") {
        continue;
      }
      for (const address of provider.call(content)) {
        debugSource.addBreakpoint(address);
      }
    }
  }

  /** 「运行到断点」可用性:调试模式 && 断点集合非空 && 会话通道可用且未终态。 */
  get #runToBreakpointEnabled(): boolean {
    if (this.#mode !== "debug" || (this.#debugDataSource?.breakpointCount ?? 0) === 0) {
      return false;
    }
    return this.#sessionActionable && !this.#isTerminal;
  }

  get #sessionActionable(): boolean {
    return this.client !== null && this.#connectionStatus === "connected";
  }

  get #isTerminal(): boolean {
    return this.#projectionStatus !== null && ["won", "failed"].includes(this.#projectionStatus);
  }

  // ── 菜单动作 ─────────────────────────────────────────────────────────────

  #onMenuAction(event: Event): void {
    const { action } = (event as CustomEvent<WorkspaceMenuActionDetail>).detail;
    switch (action.action) {
      case "step":
        // FE-WS-04a:指令步进 = step 动作(恰执行一条指令后暂停)。
        this.#submitAction({ type: "step", args: {} });
        break;
      case "payload-step":
        // FE-WS-04b(WP-F6):积木步进 = payload 程序推进一步(一个原子
        // 动作)并暂停;语义由焦点 payload 标签页承载(菜单仅在 payload
        // 标签页激活时可用——本处为防御性 no-op 兜底)。
        this.#stepFocusedPayload();
        break;
      case "reset":
        // FE-WS-05(Q5/M11):运行中 = reset;终态菜单已禁用(引导新建)。
        this.#submitAction({ type: "reset", args: {} });
        break;
      case "run-to-breakpoint":
        // FE-WS-04c(F8):运行到断点 = 调试通道 debug_run_to_breakpoint,
        // 断点集合 = 当前集合(菜单仅调试模式且集合非空时可用;防御性 no-op 兜底)。
        void this.#debugDataSource
          ?.runToBreakpoint()
          .catch(() => {
            // 运行失败(未连接 / 预算)经 onChange(error) 反馈;此处不重复呈现。
          });
        break;
      case "toggle-debug-mode":
        // FE-WS-06(F8):解题/调试模式切换(可用性 = debugModeAvailable)。
        if (this.#mode === "debug") {
          this.#exitDebugMode();
        } else {
          this.#enterDebugMode();
        }
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

  /** 焦点标签页为 payload 页时驱动其单步(FE-WS-04b;否则防御性 no-op)。 */
  #stepFocusedPayload(): void {
    const focusedTabId = this.#model.focusedTabId;
    const content = focusedTabId === null ? null : (this.#contents.get(focusedTabId) ?? null);
    const stepOnce = (content as { stepOnce?: () => void } | null)?.stepOnce;
    if (typeof stepOnce === "function") {
      stepOnce.call(content);
    }
  }

  // ── ED 组件挂接(F9 契约面 × F8 组合根)──────────────────────────────────

  /**
   * ED 内容属性同步(duck-typing 同 dataSource / actionSink 约定):按内容
   * 元素声明的属性注入公开投影 / 账本切面——ED 组件本身只依赖属性
   * (F9 独立组件纪律),组合根承担 client → 属性的装配。
   */
  #syncEdContents(): void {
    const client = this.client;
    const snapshot = client?.store.snapshot ?? null;
    const descriptor = this.challengeDescriptor;
    for (const content of this.#contents.values()) {
      const bindable = content as unknown as Record<string, unknown>;
      if ("highlights" in bindable) {
        bindable["highlights"] = snapshot?.semanticHighlights ?? [];
      }
      if ("frames" in bindable) {
        bindable["frames"] = snapshot?.callStackSummary ?? [];
      }
      if ("beforeRegions" in bindable) {
        bindable["beforeRegions"] = this.#beforeRegions;
      }
      if ("delta" in bindable) {
        bindable["delta"] = this.#lastDelta;
      }
      if ("entries" in bindable) {
        bindable["entries"] = buildTimeline(this.#actionRecords, this.#checkpoints);
      }
      if ("currentRevision" in bindable) {
        bindable["currentRevision"] = client?.store.revision ?? null;
      }
      if ("checkpoints" in bindable) {
        bindable["checkpoints"] = this.#checkpoints;
      }
      if ("sendAction" in bindable) {
        bindable["sendAction"] = (action: ActionObject) => this.#submitAction(action);
      }
      if ("sessionTerminal" in bindable) {
        bindable["sessionTerminal"] = this.#isTerminal;
      }
      if ("hints" in bindable) {
        bindable["hints"] = descriptor?.hintLadder ?? [];
      }
      if ("failures" in bindable) {
        bindable["failures"] = this.#failureCount;
      }
      if ("mappings" in bindable) {
        bindable["mappings"] = descriptor?.publicErrorMapping ?? [];
      }
      if (content.localName === "sm-error-explainer") {
        // 错误解释(FE-ED-07):userVisibleError + 描述包注解(F5 菜单内联
        // 拒绝呈现的增强并存;error 属性名与 sm-checkpoints 的 string 文案面
        // 重合,以元素身份区分注入)。
        bindable["error"] = this.#lastError;
      }
    }
  }

  /** 焦点标签页是否为 payload 页(菜单「积木步进」可用性依据)。 */
  get #payloadStepEnabled(): boolean {
    const focusedTabId = this.#model.focusedTabId;
    return focusedTabId !== null && this.#model.tab(focusedTabId)?.type === PAYLOAD_TAB_TYPE;
  }

  #submitAction(action: ActionObject): void {
    const client = this.client;
    if (client === null) {
      this.#lastError = { code: "internal_error", message: t("workspace.noSessionError") };
      this.requestUpdate();
      return;
    }
    try {
      // 发送侧 FIFO 配对(ED 时间线动作账本;响应不携带动作本体)。
      this.#pendingActions.push(action);
      client.sendAction(action);
    } catch (error) {
      this.#pendingActions.pop();
      // sendAction 断线 / 无会话抛 SessionClientError:呈现为可解释错误
      // (不排队、不本地补执行——动作只能经认证 WSS)。
      this.#lastError = {
        code: "internal_error",
        message:
          error instanceof SessionClientError ? error.message : t("workspace.actionSubmitFailed"),
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
    // 调试档(FE-ST-08/10):DebugDataSource 时呈现「延伸」入口——prefetch
    // 后可解引用延伸(同步 resolveJumpChain 语义保留;延伸反馈归链组件)。
    const debugSource = this.#debugDataSource;
    const extendable = debugSource !== null && dataSource === debugSource;
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
      .extendable=${extendable}
      .extendHandler=${extendable && debugSource !== null
        ? (addressHex: string) => debugSource.prefetchWindow(addressHex)
        : null}
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
    void this.#handleViewportJump(detail.addressHex, view, addressText);
  };

  /**
   * 跳转落点处理:优先滚动;调试档(FE-ST-05 全量口径)滚动失败时自动
   * prefetchWindow 后重试一次,仍不可达 → "窗口外"反馈(解题档维持现状,
   * 不做任何窗口拉取——D3)。
   */
  async #handleViewportJump(addressHex: string, view: SmByteViewLike | null, addressText: string): Promise<void> {
    if (view !== null && view.scrollToAddress(addressHex)) {
      this.#jumpFeedback = t("common.jumpOk", { target: addressText });
      this.requestUpdate();
      return;
    }
    const debugSource = this.#debugDataSource;
    if (this.#mode === "debug" && debugSource !== null && view !== null) {
      try {
        await debugSource.prefetchWindow(addressHex);
        this.#refreshContents();
      } catch {
        // prefetch 失败(通道未连接 / 地址不可达)→ 落回窗口外反馈。
      }
    }
    const movedAfter = view?.scrollToAddress(addressHex) ?? false;
    this.#jumpFeedback = movedAfter
      ? t("common.jumpOk", { target: addressText })
      : t("common.jumpOutside", { target: addressText });
    this.requestUpdate();
  }

  /**
   * highlight-jump(FE-ED-01 结构视图 → 字节视图联动,WP-F8 接线):
   * 定位到高亮条目所在区域 + 滚动到地址行(取第一个字节标签页承载)。
   */
  readonly #onHighlightJump = (event: Event): void => {
    const detail = (event as CustomEvent<HighlightJumpDetail>).detail;
    if (detail === undefined) {
      return;
    }
    const byteTab =
      [...this.#contents.values()].find((content): content is SmByteTab => content instanceof SmByteTab) ?? null;
    if (byteTab === null) {
      this.#jumpFeedback = t("workspace.highlightNoView", { address: detail.addressHex });
      this.requestUpdate();
      return;
    }
    byteTab.byteView?.showRegion(detail.regionId);
    const view = byteTab.byteView;
    const addressText = formatAddressHex(detail.addressHex, 8);
    void this.#handleViewportJump(detail.addressHex, view, addressText);
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
    const descriptor = this.challengeDescriptor;
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
        .payloadStepEnabled=${this.#payloadStepEnabled}
        .runToBreakpointEnabled=${this.#runToBreakpointEnabled}
        .debugModeAvailable=${this.debugModeAvailable}
        .debugModeActive=${this.#mode === "debug"}
        .lastError=${this.#lastError}
        @workspace-menu-action=${this.#onMenuAction}
      ></sm-workspace-menu>
      ${this.#renderDebugFeedback()}
      ${this.#renderChallengePanel()}
      <details class="teaching-panel" part="teaching-panel">
        <summary>${t("workspace.teachingPanel")}</summary>
        <div class="teaching-grid">
          <sm-hint-ladder
            .hints=${descriptor?.hintLadder ?? []}
            .failures=${this.#failureCount}
          ></sm-hint-ladder>
          <sm-error-explainer
            .error=${this.#lastError}
            .mappings=${descriptor?.publicErrorMapping ?? []}
          ></sm-error-explainer>
        </div>
      </details>
      ${this.#jumpFeedback === null
        ? nothing
        : html`<p class="jump-feedback" role="status">${this.#jumpFeedback}</p>`}
      ${snapshot.columns.length === 0 ? this.#renderEmptyState() : nothing}
      <main
        class="columns"
        data-columns
        aria-label=${t("workspace.columnsAria")}
        @viewport-jump=${this.#onViewportJump}
        @highlight-jump=${this.#onHighlightJump}
        @breakpoints-changed=${() => this.requestUpdate()}
      >
        ${snapshot.columns.map((column, columnIndex) => html`
          <div class="column" data-column-index=${columnIndex}>
            ${column.tabIds.map((tabId) => this.#renderPanel(tabId))}
          </div>
        `)}
      </main>
    `;
  }

  /** 调试档状态行(FE-WS-06 切换反馈 / 暂停原因 / 通道降级明示)。 */
  #renderDebugFeedback(): unknown {
    if (this.#mode !== "debug" || this.#debugFeedback === null) {
      return nothing;
    }
    return html`<p class="debug-feedback" role="status">${this.#debugFeedback}</p>`;
  }

  /**
   * 题目静态面(WP-54):`loaded` = briefing(标题 / 简介)+ VM Profile +
   * encodingTable(存在才渲染,缺席不渲染纪律);`absent` = 缺席明示;
   * `unknown` / `loading` = 零渲染面(晚到即注入,loading 中不闪占位)。
   */
  #renderChallengePanel(): unknown {
    if (this.descriptorStatus === "absent") {
      return html`
        <details class="challenge-panel" part="challenge-panel" data-descriptor-status="absent">
          <summary>${t("workspace.challengeAbsentTitle")}</summary>
          <p class="challenge-absent" role="status">${t("workspace.challengeAbsentBody")}</p>
        </details>
      `;
    }
    if (this.descriptorStatus !== "loaded") {
      return nothing;
    }
    const face = this.challengeStatic;
    if (face === null) {
      return nothing;
    }
    const encodingTable = face.encodingTable;
    return html`
      <details class="challenge-panel" part="challenge-panel" data-descriptor-status="loaded" open>
        <summary>${t("workspace.challengePanel")}</summary>
        <div class="challenge-body">
          <h2 class="challenge-title">${face.title}</h2>
          <p class="challenge-summary">${face.summary}</p>
          <dl class="challenge-facts">
            <dt>${t("workspace.challengeDtArch")}</dt>
            <dd class="mono">${face.archBits}</dd>
            <dt>${t("workspace.challengeDtEndianness")}</dt>
            <dd class="mono">${face.endianness}</dd>
            <dt>${t("workspace.challengeDtPageSize")}</dt>
            <dd>${t("ed.bytesSuffix", { count: face.pageSizeBytes })}</dd>
            <dt>${t("workspace.challengeDtRegisters")}</dt>
            <dd class="mono">${face.registerNames.join(", ")}</dd>
            <dt>${t("workspace.challengeDtCanary")}</dt>
            <dd>${face.canaryEnabled ? t("workspace.challengeCanaryOn") : t("workspace.challengeCanaryOff")}</dd>
            ${encodingTable === undefined || encodingTable.length === 0
              ? nothing
              : html`
                  <dt>${t("workspace.challengeDtEncodingTable")}</dt>
                  <dd>${this.#renderEncodingTable(encodingTable)}</dd>
                `}
          </dl>
        </div>
      </details>
    `;
  }

  /** 编码表最小渲染:tokenHex / op / operands 紧凑结构文本(操作数 kind 为协议词不译)。 */
  #renderEncodingTable(entries: readonly DescriptorEncodingEntryView[]): unknown {
    return html`
      <table class="encoding-table">
        <tbody>
          ${entries.map(
            (entry) => html`
              <tr>
                <td class="mono">${entry.tokenHex}</td>
                <td class="mono">${entry.op}</td>
                <td class="mono">${(entry.operands ?? []).map((operand) => this.#operandToText(operand))}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    `;
  }

  /** 操作数紧凑结构文本(数据词不译:寄存器名 / arch / interfaceId 为协议词汇)。 */
  #operandToText(operand: DescriptorEncodingOperandView): string {
    switch (operand.kind) {
      case "register":
        return operand.name;
      case "immediate":
        return "imm:arch";
      case "memory":
        return `[${operand.baseRegister}:arch]`;
      case "interface":
        return `iface:${String(operand.interfaceId)}`;
      default:
        return String(operand);
    }
  }

  #renderEmptyState(): unknown {
    return html`<p class="empty" role="status">${t("workspace.empty")}</p>`;
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
            aria-label=${t("workspace.closeTabAria", { title: info.title })}
            @pointerdown=${(event: PointerEvent) => event.stopPropagation()}
            @click=${() => this.closeTab(info.id)}
          >
            ×
          </button>
        </header>
        <div class="tab-content">
          ${content ??
          html`<p class="tab-placeholder" role="status">
            ${descriptor?.placeholderNote ?? t("common.noContentNote")}
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

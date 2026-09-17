/**
 * <sm-workspace> —— 工作区容器(WP-F5;FE-X-02 唯一主体边界;WP-71 固定窗口集)。
 *
 * 职责 = 容纳、管理、排布工作窗口(FE-WS-01)+ 顶部菜单(FE-WS-03)+
 * 跨视图集成接线(F3/F4 交付能力的组合根):
 *
 *  - **固定窗口集(D-MP-1,WP-71)**:窗口集合 = 注册表登记的全部类型、
 *    **各恰一个实例、常驻**;窗口没有开 / 关状态,只有「视口内 / 暂离
 *    (条带滚出视野)」;窗口集在工作区接入(首帧前)按**当前宽度档预设**
 *    一次性绑定(`#bindWindows`),`tabTypes` 换绑即重绑。**无关闭入口、
 *    无空态引导**(窗口集恒非空);窗口管理动作 = 聚焦导航(本包)+ 移动位置 /
 *    调整大小(WP-72);
 *  - **默认列排布的唯一来源 = `layout-presets.ts` 的三张预设表**(P0 宽屏 5 列 /
 *    P1 中宽 3 列 / P2 窄条单列),经 `WorkspaceLayoutModel.bindWindows(entries,
 *    columns)` 的 `columns` 参数**单点注入**——本文件不持有任何预设字面量;
 *  - **列式滚动平铺**(Q1 定案 v1 + WP-72 相机):工作区 = 列的有序序列,列间
 *    水平滚动(Niri 式);**焦点列居中**由显式相机计算承担(`layout-camera.ts`
 *    纯函数 → `scrollLeft`),相邻列两侧探出;列内按**窗高比例**分配列高
 *    (Hyprland 式);
 *  - **尺寸可调(WP-72)**:列间分隔条(pointer 拖拽 + 方向键)调列宽,同列窗间
 *    分隔条调窗高(单窗列自动占满列高);列宽夹取到 `MIN_COLUMN_WIDTH`
 *    可读性护栏;菜单「布局」组提供 1/4、1/3、1/2、2/3、全宽五档(作用于**焦点
 *    列**)与「重置布局」(清空调整 + 回**当前宽度档**预设);
 *  - **拖拽排布(Niri 三类落点显式化)**:落到同列窗口上 / 下半 = 同列堆叠;
 *    落到另一列窗口 = 跨列移动;落到列间空隙 = 在该列序位置**新建列位**
 *    (`openColumnAt`);落点以 `drop-target` 静态标记指示(零浮动层、零重叠);
 *  - **聚焦导航**:`focusWindow(type)` = 聚焦 + 相机居中到该窗口(菜单「窗口」
 *    分组逐个入口,详见 sm-workspace-menu);标题栏可聚焦,方向键提供列内 /
 *    跨列移动的键盘可达兜底(不承诺全局快捷键);
 *  - **视口外降级渲染**:窗口面板声明 `content-visibility: auto` +
 *    `contain-intrinsic-size`(语义标记 `data-render-degrade="content-visibility"`),
 *    离屏窗口子树由浏览器跳过渲染与绘制,payload / 指令视图等重窗口的挂载成本
 *    随之推迟到进入视口;行级虚拟列表 `sm-window-list` 维持不变;
 *  - **响应式降级**:视口宽变化(宿主 window resize)重测宽度 → 档位变化即按新
 *    档预设重绑列结构(宽度回到宽档即回到 P0);同档内只更新列宽基准。
 *  - **组合根装配**(README §双档数据源纪律):`client` 换绑即
 *    `new ProjectionDataSource(client.store)` 注入各窗口内容;
 *    `client.onProjectionChanged(() => 各内容 refresh())` 驱动视图刷新;
 *  - **跨视图联动**:`vma-select ↔ showRegion ↔ selectedRegionId` 回路在
 *    `<sm-byte-tab>` 内闭环;寄存器交叉标注(FE-RG-04)与跳转链
 *    (FE-ST-07/09)经字节视图行装饰挂点(宿主层追加渲染)落地;
 *  - **菜单动作**:`step`(FE-WS-04a)/ `reset`(FE-WS-05,Q5/M11 终态禁用
 *    + 新建引导)/ 手动重连(connection-replaced);拒绝动作呈现
 *    userVisibleError(含 explanation);断线横幅呈现"最近一次公开投影 +
 *    重连中"(零本地 VM 降级);
 *  - **正式裁决呈现**(阶段六 WP-63,D-API-83 / 84):`submit` 动作受理后
 *    启动裁决重询(pending 确定性呈现 → verdicted 11 值结果类型呈现;非成绩
 *    方向显式重提入口、不自动重试;裁决不可用 ≠ 判负——unavailable 降级
 *    明示,不中断会话);重询经插件 ↔ session-api 直连 HTTP,宿主
 *    postMessage 零权威语义不破(V-9,裁决数据不经嵌入协议帧)。
 *
 * 纪律(CLAUDE.md 第十章 / 中期任务分解 §1.3 硬门槛):浏览器只保存公开投影与
 * UI 状态;动画只用 transform / opacity(拖拽反馈 = opacity,落点指示 = 静态
 * outline);`prefers-reduced-motion` 由相机滚动行为尊重;语义化 DOM;拖拽落点
 * 指示不引入浮动层与重叠;分隔条是可聚焦的 `role="separator"`(方向键可调);
 * 屏幕阅读器信息不只在视觉中(布局变更经 `role="status"` 状态行宣读)。
 *
 * 主题与效果面(WP-74):底色 / 前景 / 次要前景 / 面板底 / 语义色 / 焦点环 /
 * 等宽字体栈全走既有 token(`var(--sm-*, <原字面量>)` 回退值逐字等于原值 ⇒
 * light / dark 视觉零变化);字号下限 13px(`0.75rem` → `0.8125rem`)。
 *
 * 效果面三件(扫描线 overlay / 光标闪烁 / 终端式标题栏角标)为**纯装饰**:
 * 装饰节点 `aria-hidden="true"`、零文本、零可聚焦后代、`pointer-events: none`,
 * 缺席不丢失任何信息;强度 / 周期一律取自既有 token(`--sm-scanline-opacity`
 * 与 `--sm-caret-blink`,light / dark = `0` / `0s` ⇒ 装饰天然不生效),**零新增
 * token**;全部动画声明包在 `@media (prefers-reduced-motion: no-preference)` 内
 * (reduce 下装饰 `display: none` 且 composed 树零 `animation-name`),动画只动
 * opacity(零大面积 glow / text-shadow);终端式标题栏只加 1px 发丝线与角标伪
 * 元素,**不加**按钮 / 交互元素 / `tabindex`(WP-71「标题栏零控件」口径保留)。
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

import { SessionCommandError } from "../client/session-errors.js";

import {
  type ConnectionStatus,
  type ConnectionStatusEvent,
  type DisconnectReason,
  type SessionClient,
} from "../client/session-client.js";
import { SessionClientError } from "../client/session-errors.js";
import { VerdictPoller, type VerdictPresentation } from "../client/verdict-poller.js";
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
import type { PayloadAuthorBlockDecl } from "../payload/compiler/blocks.js";
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
import {
  cameraScrollLeft,
  columnBoxFromRects,
  defaultMatchMedia,
  prefersReducedMotion,
} from "./layout-camera.js";
import {
  columnChromePx,
  columnMinHeightPx,
  columnWidthAfterDrag,
  rowHeightsAfterDrag,
  DIVIDER_KEY_STEP_PX,
  MIN_ROW_HEIGHT_PX,
  ROW_DIVIDER_KEY_STEP,
} from "./layout-divider.js";
import { MIN_COLUMN_WIDTH, selectLayoutPreset, type LayoutPresetId } from "./layout-presets.js";
import {
  WorkspaceLayoutModel,
  type DropTarget,
  type MoveTarget,
  type WorkspaceLayoutSnapshot,
} from "./workspace-model.js";

/** 拖拽启动的位移阈值(px):超过才算拖拽(否则视为激活点击)。 */
const DRAG_THRESHOLD_PX = 3;

/**
 * 成绩方向裁决集(11 值结果类型的呈现分向;非成绩方向 = engine_error /
 * challenge_invalid / replay_mismatch / cancelled——已产生的裁决,呈现
 * 「本次提交未产生成绩」+ 显式重新提交入口,不自动重试,D-API-84)。
 */
const SCORE_VERDICTS: ReadonlySet<string> = new Set([
  "success",
  "wrong_answer",
  "invalid_action",
  "program_crash",
  "memory_fault",
  "resource_limit",
  "timeout",
]);

/** 分隔条拖拽态(WP-72;与窗口拖拽共用 `DRAG_THRESHOLD_PX` 阈值语义与挂点)。 */
type DividerDrag =
  | {
      readonly kind: "column";
      /** 空隙索引 = 该空隙右侧列序(新建列位的插入位置);左列 = gapIndex − 1。 */
      readonly gapIndex: number;
      readonly startX: number;
      readonly startRatio: number;
      moved: boolean;
    }
  | {
      readonly kind: "row";
      readonly column: number;
      /** 分隔条上侧窗口序号(调整 index 与 index + 1 两窗)。 */
      readonly index: number;
      readonly startY: number;
      readonly startHeights: readonly number[];
      /**
       * 按下瞬间的列高(px;像素换算基准)。**整段拖拽共用同一个值**:列高在
       * 溢出列会被本列下限(比例的函数)顶高,若每步重读 `clientHeight`,同样的
       * `startHeights` 会按新自由空间重新摊开 ⇒ 非相邻窗跟着变高、列高比位移长
       * 得更多(实测 +60px 的拖拽把列高顶高 137px)。固定基准后拖拽是
       * `(startHeights, 基准, 位移)` 的纯函数 ⇒ 分隔条严格跟随指针。
       */
      readonly startColumnHeightPx: number;
      moved: boolean;
    };

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
  /**
   * M10/WP-80:出题者积木声明面(公开描述包可选顶层字段 `authorBlocks`)。
   * 缺省 / 空数组 ⇒ Payload 面板与既有一字不差(不追加题目积木分类)。
   */
  readonly authorBlocks?: readonly PayloadAuthorBlockDecl[];
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
   * `createDebugDataSource(client, { projectionProvider: () => client.store.snapshot ?? null })`
   * ——传输面走 DebugChannelClient 缺省实现,投影来源 = 会话公开投影
   * (调试档 VMA / 寄存器 / 行区域归属的结构同构映射唯一来源;WP-70 接线)。
   * 测试注入假传输 / 替身数据源(注意:注入替身即绕开上述缺省装配路径)。
   * 返回 null = 会话未创建。
   */
  @property({ attribute: false })
  debugDataSourceFactory: DebugDataSourceFactory | null = null;

  /**
   * 裁决重询状态机工厂(测试接缝,阶段六 WP-63):缺省 = 组合根装配
   * `new VerdictPoller({ sink: client })`(确定性间隔 + 失败退避 + 断线
   * 暂停重连);测试注入可编排定时器的替身工厂。
   */
  @property({ attribute: false })
  verdictPollerFactory: ((client: SessionClient) => VerdictPoller) | null = null;

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
  /** 已绑定窗口集的注册表实例(换绑即重绑;同实例重渲染不重绑)。 */
  #boundTabTypes: WorkspaceTabTypeRegistry | null = null;
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
  /**
   * 跳转链伪汇编提供者缓存(WP-76):按调试数据源实例缓存,避免每次渲染产生
   * 新函数标识(属性面绑定换标识会无谓触发子组件重渲染)。
   */
  #chainPseudoAsmProviderCache: {
    readonly source: DebugDataSource;
    readonly provider: (addressHex: string) => { readonly text: string } | null;
  } | null = null;

  // ── 模式切换与调试档状态(FE-WS-06/07,WP-F8)──
  #mode: WorkspaceMode = "solve";
  #debugDataSource: DebugDataSource | null = null;
  /** 调试档变更退订(切回解题模式 / client 换绑时注销)。 */
  #debugChangeDisposer: (() => void) | null = null;
  /** 调试交互反馈(暂停原因 / attach / 通道错误;菜单下方状态行)。 */
  #debugFeedback: string | null = null;
  /**
   * payload 客户端步进暂停落点(WP-76 #4;`payload-client-pause` 事件驱动)。
   * 「客户端步进暂停」= 积木执行器停在断点积木上的**本地**暂停,不含服务端
   * 暂停语义 ⇒ 与调试通道 `debug_paused` 严格分面呈现(不伪造服务端原因)。
   */
  #clientPauseAddressHex: string | null = null;

  // ── 正式裁决呈现(阶段六 WP-63;D-API-83 / D-API-84)──
  /**
   * 裁决重询状态机(submit 后跟随 submissionId;verdicted 即停、断线暂停
   * 重连恢复、连续失败触顶 → unavailable 停询)。呈现 = 菜单下方裁决横幅。
   */
  #verdictPoller: VerdictPoller | null = null;
  #verdict: VerdictPresentation = { kind: "idle" };

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
  /** 当前落点候选(拖拽中实时更新;渲染为 `drop-target` 静态指示 + 状态行宣读)。 */
  #dropTarget: { readonly tabId: string; readonly target: DropTarget } | null = null;
  /**
   * 分隔条拖拽态(WP-72;与窗口拖拽共用 `DRAG_THRESHOLD_PX` 阈值语义与
   * renderRoot 上的 pointer 监听挂点):列宽只改左侧列占比,窗高改同列相邻两窗。
   */
  #dividerDrag: DividerDrag | null = null;
  #lastVisibleTabId: string | null = null;
  /** 首帧前建窗 ⇒ 未渲染内容元素的 refresh 延后到首帧之后(WP-71 时序)。 */
  #contentRefreshDeferred = false;

  // ── 布局档位与反馈(WP-72)──
  /** 当前宽度档(接入与 resize 时按视口宽重算;宽屏 = P0)。 */
  #presetId: LayoutPresetId = "P0";
  /**
   * 布局变更反馈(分隔条调整 / 列宽档 / 重置布局 / 落点)。
   * 承载于**常驻** `role="status"` 状态行:live region 必须预先存在于
   * 无障碍树中才可靠宣读(拖拽 / 调整是瞬时事件,故不做条件渲染)。
   */
  #layoutFeedback: string | null = null;

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
      /* 扫描线 overlay 的定位锚(纯装饰层 inset:0;既有绝对定位后代各有自身
         定位锚:sm-window-list 宿主 position:relative、Blockly .injectionDiv
         position:relative ⇒ 零布局影响)。 */
      position: relative;
      background: var(--sm-bg-base, canvas);
      color: var(--sm-fg, canvastext);
      overflow: hidden;
    }

    /* 列式滚动平铺:列间水平滚动(Niri 式),滚动可达任意列。
       纵向同样 auto:列内窗口有**可读高度下限**(MIN_ROW_HEIGHT_PX),列高下限
       是**窗高比例的函数**(columnMinHeightPx,内联为列盒 min-block-size)⇒
       拖高某一窗时列盒随之生长(被减小的窗贴住下限、不再让位),溢出的可见后代
       进入条带滚动区 ⇒ **不压扁窗口,改为滚动**。宿主给工作区定高时滚动发生在
       条带内;宿主未定高时条带被内容撑高、溢出上浮到文档层滚动(见
       test/workspace/sm-workspace-layout.test.ts 的高度下限用例)。 */
    .columns {
      flex: 1;
      display: flex;
      align-items: stretch;
      gap: 0.5rem;
      padding: 0.5rem;
      overflow: auto;
      overscroll-behavior: contain;
      min-block-size: 0;
      /* 动效纪律:不引入 CSS 平滑滚动——条带滚动语义由相机(JS)独占,
         prefers-reduced-motion 在相机侧降级为即时定位。 */
      scroll-behavior: auto;
    }

    @media (prefers-reduced-motion: reduce) {
      .columns {
        scroll-behavior: auto;
      }
    }

    /* 列宽由模型快照的占比即时计算为像素(内联 inline-size);缺省兜底 100%
       (首帧 / 无测量环境时不塌陷)。列高下限由 TS 按列内**窗高比例**内联为像素
       (columnMinHeightPx;同一处也只此一份算式),使列盒 ≥ 内容高度:
       窗高拖拽的像素 ↔ 比例换算基准正确、列间分隔条随内容满高。 */
    .column {
      flex: 0 0 auto;
      inline-size: 100%;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    /* 列间分隔条(相邻列间;pointer 拖拽 + 方向键调整列宽)。 */
    .column-divider {
      flex: 0 0 auto;
      inline-size: 0.75rem;
      align-self: stretch;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: col-resize;
      touch-action: none;
      border: 0;
      border-radius: 6px;
      background: transparent;
      padding: 0;
    }

    .column-divider::before {
      content: "";
      inline-size: 2px;
      block-size: 100%;
      background: var(--sm-divider, rgb(0 0 0 / 12%));
    }

    .column-divider:hover::before,
    .column-divider:focus-visible::before {
      background: var(--sm-warn, highlight);
    }

    .column-divider:focus-visible,
    .row-divider:focus-visible {
      outline: 2px solid var(--sm-focus-ring, accentcolor);
      outline-offset: 1px;
    }

    /* 同列窗间分隔条(调整窗高比例)。 */
    .row-divider {
      flex: 0 0 auto;
      block-size: 0.5rem;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: row-resize;
      touch-action: none;
      border: 0;
      border-radius: 6px;
      background: transparent;
      padding: 0;
    }

    .row-divider::before {
      content: "";
      block-size: 2px;
      inline-size: 100%;
      background: var(--sm-divider, rgb(0 0 0 / 12%));
    }

    .row-divider:hover::before,
    .row-divider:focus-visible::before {
      background: var(--sm-warn, highlight);
    }

    /* 列内按窗高比例分配列高(Hyprland 式):面板 flex-grow 由模型比例内联给值
       (flex: 比例 1 0 ⇒ 高度按比例分配,拖拽期间只改容器比例、列表不重排);
       面板最小高 = 窗高下限 MIN_ROW_HEIGHT_PX(推导见 layout-presets.ts 的
       「块轴(高度)阈值推导」:面板 chrome + 4 个字节行单位):空间充足时比例分配
       照常(像素和守恒),空间不足时被压侧的窗停在下限、列高下限(比例的函数)
       顶高列盒 ⇒ 不再压扁窗口,由条带 / 文档滚动承担。 */
    .tab-panel {
      flex: 1 1 0;
      min-block-size: ${MIN_ROW_HEIGHT_PX}px;
      display: flex;
      flex-direction: column;
      border: 1px solid var(--sm-border, rgb(0 0 0 / 15%));
      border-radius: 8px;
      overflow: hidden;
      background: var(--sm-bg-base, canvas);
      /* 视口外窗口降级渲染(WP-72):离屏子树跳过渲染与绘制;语义标记
         data-render-degrade="content-visibility"(结构断言面)。
         contain-intrinsic-size 以面板最小高为占位,auto 关键字记住上次尺寸,
         避免进入视口时的布局跳动。零新增依赖、零浮动层、零 JS 观察者。 */
      content-visibility: auto;
      contain-intrinsic-size: auto ${MIN_ROW_HEIGHT_PX}px;
    }

    .tab-panel.focused {
      border-color: var(--sm-warn, highlight);
    }

    /* 拖拽反馈:opacity(compositor 友好;零 CSS 动画)。 */
    .tab-panel.dragging {
      opacity: 0.5;
    }

    /* 落点指示(WP-72):静态轮廓 / 背景,不引入浮动层与重叠,不做动画。 */
    .tab-panel.drop-target {
      outline: 2px dashed var(--sm-warn, highlight);
      outline-offset: -2px;
    }

    .column-divider.drop-target,
    .row-divider.drop-target {
      background: color-mix(in srgb, var(--sm-warn, highlight) 22%, transparent);
    }

    .columns.drop-target {
      outline: 2px dashed var(--sm-warn, highlight);
      outline-offset: -2px;
    }

    .tab-bar {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.25rem 0.5rem;
      /* 终端式标题栏 1px 框线 = 既有发丝线(角标与光标装饰的定位锚)。 */
      border-block-end: 1px solid var(--sm-divider, rgb(0 0 0 / 10%));
      position: relative;
      background: var(--sm-bg-panel, color-mix(in srgb, canvas 92%, highlight 8%));
      cursor: grab;
      user-select: none;
      touch-action: none;
    }

    .tab-title {
      font-weight: 600;
      font-size: 0.8125rem;
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

    .tab-placeholder {
      margin: 0;
      padding: 1rem;
      color: var(--sm-fg-dim, graytext);
      font-size: 0.875rem;
    }

    .jump-feedback {
      margin: 0;
      padding: 0.25rem 0.75rem;
      color: var(--sm-fg-dim, graytext);
      font-size: 0.8125rem;
      border-block-end: 1px solid var(--sm-divider, rgb(0 0 0 / 10%));
    }

    /* 布局状态行(WP-72):常驻 role=status 的 live region(布局变更宣读)。 */
    .layout-status {
      margin: 0;
      padding: 0.25rem 0.75rem;
      color: var(--sm-fg-dim, graytext);
      font-size: 0.8125rem;
      min-block-size: 1.1em;
      border-block-end: 1px solid var(--sm-divider, rgb(0 0 0 / 10%));
    }

    /* 调试档状态行(F8):切换 / attach / 暂停反馈(降级文案明示)。 */
    .debug-feedback {
      margin: 0;
      padding: 0.25rem 0.75rem;
      color: var(--sm-fg, canvastext);
      font-size: 0.8125rem;
      background: color-mix(in srgb, var(--sm-bg-inset, field) 94%, var(--sm-focus-ring, accentcolor) 6%);
      border-block-end: 1px solid var(--sm-divider, rgb(0 0 0 / 10%));
    }

    /* 教学面板(F8 ED 挂接,取简 = details 折叠区):提示 ladder + 错误解释。 */
    .teaching-panel {
      border-block-end: 1px solid var(--sm-divider, rgb(0 0 0 / 10%));
      font-size: 0.8125rem;
    }

    .teaching-panel > summary {
      padding: 0.25rem 0.75rem;
      color: var(--sm-fg-dim, graytext);
      cursor: pointer;
      font-size: 0.8125rem;
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
      color: var(--sm-fg-dim, graytext);
      cursor: pointer;
      font-size: 0.8125rem;
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
      color: var(--sm-fg-dim, graytext);
    }

    .challenge-facts dd {
      margin: 0;
      overflow-wrap: anywhere;
    }

    .mono {
      font-family: var(--sm-font-mono, ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, "Noto Sans Mono CJK SC", monospace);
    }

    .encoding-table {
      margin: 0;
      border-collapse: collapse;
      font-family: var(--sm-font-mono, ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, "Noto Sans Mono CJK SC", monospace);
      font-size: 0.8125rem;
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
      color: var(--sm-fg-dim, graytext);
    }

    /* 正式裁决横幅(阶段六 WP-63;零视觉重设计:复用横幅式样的取简变体)。 */
    .verdict-banner {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem 0.75rem;
      margin: 0;
      padding: 0.375rem 0.75rem;
      background: color-mix(in srgb, var(--sm-bg-inset, field) 92%, var(--sm-warn, highlight) 8%);
      border-block-end: 1px solid var(--sm-divider, rgb(0 0 0 / 10%));
      font-size: 0.8125rem;
    }

    .verdict-banner strong {
      color: var(--sm-fg, canvastext);
    }

    .verdict-banner .verdict-state {
      color: var(--sm-fg, canvastext);
      font-weight: 600;
    }

    .verdict-banner.unavailable {
      background: color-mix(in srgb, mark 8%, var(--sm-bg-base, canvas));
    }

    .verdict-banner button {
      padding: 0.125rem 0.5rem;
      border: 1px solid var(--sm-border-button, rgb(0 0 0 / 20%));
      border-radius: 6px;
      background: var(--sm-bg-base, canvas);
      color: var(--sm-fg, canvastext);
      font: inherit;
      cursor: pointer;
    }

    /* ── 效果面(WP-74;契约 C1~C9 见 e2e/helpers/decoration.ts 文件头)─────
       三件装饰全为**纯装饰**:节点 aria-hidden="true"(伪元素天然不入无障碍
       树)、零文本、零可聚焦后代、pointer-events: none;动画只动 opacity;
       缺席不丢失任何信息。参数一律取自既有 effect token,零新增 token:
       扫描线强度 = --sm-scanline-opacity(light / dark = 0,terminal = 0.06),
       光标周期 = --sm-caret-blink(light / dark = 0s,terminal = 1.1s)——
       light / dark 下两者天然不生效 ⇒ 视觉零变化。全部动画声明包在
       @media (prefers-reduced-motion: no-preference) 内;reduce 下装饰
       display: none(C8)且 composed 树零 non-none 动画(C9)。 */

    /* 扫描线 overlay(C1 锚 / C2 形态 / C3 强度 / C4 命中测试 / C7 不承载信息)。
       几何、命中测试与形态是**静态**属性(与动效偏好无关 ⇒ reduce 下同样成立),
       故落在基态规则内;强度由 token 驱动;基态 display: none ⇒ reduce 与非
       no-preference 下装饰不生效(C8,零绘制)。 */
    .sm-scanline {
      display: none;
      position: absolute;
      inset: 0;
      z-index: 1;
      pointer-events: none;
      /* C3:强度由 --sm-scanline-opacity 驱动(light / dark = 0 ⇒ 不可见)。 */
      opacity: var(--sm-scanline-opacity, 0);
      /* C2:形态 = repeating-linear-gradient 覆盖层(1px 线 / 3px 周期)。 */
      background-image: repeating-linear-gradient(
        to bottom,
        var(--sm-fg, canvastext) 0,
        var(--sm-fg, canvastext) 1px,
        transparent 1px,
        transparent 3px
      );
    }

    @media (prefers-reduced-motion: no-preference) {
      .sm-scanline {
        display: block;
      }
    }

    /* 光标闪烁(C5 锚 / C6 steps 动画):终端块状光标,基态不可见 ——
       light / dark 的 --sm-caret-blink = 0s ⇒ 动画不生效 ⇒ 保持基态 opacity 0
       (视觉零变化;不靠 JS 分支主题)。 */
    .sm-caret {
      position: absolute;
      inset-block-start: 50%;
      inset-inline-end: 0.5rem;
      inline-size: 0.375rem;
      block-size: 0.75rem;
      margin-block-start: -0.375rem;
      background: var(--sm-fg, canvastext);
      opacity: 0;
      pointer-events: none;
    }

    @media (prefers-reduced-motion: no-preference) {
      .sm-caret {
        /* C6:阶跃闪烁(steps,非平滑淡入淡出),周期解析自 --sm-caret-blink。 */
        animation-name: sm-caret-blink;
        animation-duration: var(--sm-caret-blink, 0s);
        animation-timing-function: steps(1, end);
        animation-iteration-count: infinite;
      }
    }

    @keyframes sm-caret-blink {
      0% {
        opacity: 1;
      }

      50% {
        opacity: 0;
      }

      100% {
        opacity: 1;
      }
    }

    /* 终端式窗口标题栏:1px 框线 = .tab-bar 既有发丝线;角标 = 伪元素纯装饰
       (零控件、零 tabindex、零文本)。基态 content: none ⇒ light / dark 与
       reduce 下整体缺席(视觉零变化)。 */
    .tab-bar::before,
    .tab-bar::after {
      content: none;
    }

    @media (prefers-reduced-motion: no-preference) {
      .tab-bar::before,
      .tab-bar::after {
        content: "";
        position: absolute;
        inline-size: 0.375rem;
        block-size: 0.375rem;
        pointer-events: none;
        /* 角标强度 = 效果面开关的数值代理:light / dark 的
           --sm-scanline-opacity = 0 ⇒ 完全透明;terminal = 0.06 ⇒ 放大到
           不透明度上限 1(既有 token 复用,不新增 token)。 */
        opacity: calc(var(--sm-scanline-opacity, 0) * 20);
      }

      .tab-bar::before {
        inset-block-start: 0.125rem;
        inset-inline-start: 0.25rem;
        border-block-start: 1px solid var(--sm-fg-dim, graytext);
        border-inline-start: 1px solid var(--sm-fg-dim, graytext);
      }

      .tab-bar::after {
        inset-block-end: 0.125rem;
        inset-inline-end: 0.25rem;
        border-block-end: 1px solid var(--sm-fg-dim, graytext);
        border-inline-end: 1px solid var(--sm-fg-dim, graytext);
      }
    }

    /* reduce 等价覆盖(C8 / C9):装饰整体 display: none,节点数不为零但零绘制;
       零动画声明(上方动画全在 no-preference 内 ⇒ reduce 下 composed 树
       animation-name 恒为 none)。 */
    @media (prefers-reduced-motion: reduce) {
      .sm-scanline,
      .sm-caret {
        display: none;
      }
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
    if (changed.has("tabTypes") && this.tabTypes !== this.#boundTabTypes) {
      // 注册表换绑(宿主替换工厂 / 文案 / 追加登记)= 窗口集重绑。
      this.#bindWindows();
    }
    if (changed.has("theme")) {
      this.#syncThemeAnchor();
    }
    if (changed.has("challengeDescriptor")) {
      // M10/WP-80:描述包**晚到**(WP-54 异步下发通道:先建窗、后注入)时,
      // 注册表内容元素的 duck-typing 注入面必须补一次同步——模板直连的
      // ED 组件(`.hints` / `.mappings`)由 Lit 响应式绑定覆盖,而注册表内容
      // (payload 惰性宿主等)没有模板绑定,只能在描述包变更时显式补注入。
      this.#syncEdContents();
    }
  }

  protected override updated(): void {
    // 焦点变化 → 滚动使焦点窗口可见(列间水平滚动可达,验收底线)。
    const focusedTabId = this.#model.focusedTabId;
    if (focusedTabId !== this.#lastVisibleTabId) {
      this.#lastVisibleTabId = focusedTabId;
      if (focusedTabId !== null) {
        this.ensureTabVisible(focusedTabId);
      }
    }
    if (this.#contentRefreshDeferred) {
      // 首帧前建窗的内容元素此刻已渲染(renderRoot 就绪)→ 补一次 refresh。
      this.#contentRefreshDeferred = false;
      this.#refreshContents();
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // LocaleController 经构造副作用注册(Lit addController);显式读点满足 lint。
    void this.#i18n;
    // 主题锚样式表(幂等)+ 独立使用形态的 theme 属性转写(最近锚优先)。
    ensureSmThemeStyles(this.ownerDocument ?? document);
    this.#syncThemeAnchor();
    // 窗口集绑定(D-MP-1:登记集合各恰一实例、常驻;首帧前按当前宽度档预设建列)。
    this.#bindWindows();
    // 响应式降级驱动:宿主 window resize(嵌入形态 iframe 尺寸变化即宿主 window
    // resize);同档内只更新列宽基准,跨档才重绑列结构。
    (this.ownerDocument?.defaultView ?? null)?.addEventListener("resize", this.#onViewportResize);
    // pointer 拖拽监听挂在 shadow root 内:避免跨 shadow 边界的 target 重定向。
    this.renderRoot.addEventListener("pointermove", this.#onPointerMove as EventListener);
    this.renderRoot.addEventListener("pointerup", this.#onPointerUp as EventListener);
    this.renderRoot.addEventListener("pointercancel", this.#onPointerCancel as EventListener);
    if (this.client !== null && this.#listenerDisposers.length === 0) {
      this.#attachClientListeners();
    }
    if (this.client !== null && this.#verdictPoller === null) {
      // 重连装配(disconnectedCallback 已释放重询;呈现状态回到 idle——
      // 裁决呈现随会话生命周期,重新提交即重新跟随)。
      const verdictPoller = this.verdictPollerFactory !== null
        ? this.verdictPollerFactory(this.client)
        : new VerdictPoller({ sink: this.client });
      verdictPoller.onChange((presentation) => {
        this.#verdict = presentation;
        this.requestUpdate();
      });
      this.#verdictPoller = verdictPoller;
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
    (this.ownerDocument?.defaultView ?? null)?.removeEventListener("resize", this.#onViewportResize);
    this.renderRoot.removeEventListener("pointermove", this.#onPointerMove as EventListener);
    this.renderRoot.removeEventListener("pointerup", this.#onPointerUp as EventListener);
    this.renderRoot.removeEventListener("pointercancel", this.#onPointerCancel as EventListener);
    this.#detachClientListeners();
    // 裁决重询随元素移除终止(停定时器;重连装配由 client 换绑路径重建)。
    this.#verdictPoller?.dispose();
    this.#verdictPoller = null;
    super.disconnectedCallback();
  }

  // ── 公共 API(宿主 / 测试接线面)─────────────────────────────────────────

  /** 布局快照(测试断言与宿主诊断面)。 */
  get layoutSnapshot(): WorkspaceLayoutSnapshot {
    return this.#model.snapshot;
  }

  /** 当前宽度档(WP-72:宽屏 P0 / 中宽 P1 / 窄条 P2;诊断与 E2E 断言面)。 */
  get layoutPresetId(): LayoutPresetId {
    return this.#presetId;
  }

  /** 焦点窗口所在列(无焦点为 null;诊断 / 断言面)。 */
  get focusedColumnIndex(): number | null {
    return this.#model.focusedColumnIndex;
  }

  /**
   * 窗口集绑定(D-MP-1 固定窗口集,WP-71;WP-72 起按**当前宽度档预设**)——
   *
   *  - 每种登记类型恰一实例(窗口 id ≡ 类型键;单实例为结构性保证);
   *  - **列排布 = `layout-presets.ts` 的预设表**(宽屏 P0 / 中宽 P1 / 窄条 P2),
   *    经 `WorkspaceLayoutModel.bindWindows(entries, columns)` 的 `columns`
   *    参数**单点注入**——默认列排布不在本文件出现第二份字面量;
   *  - 内容元素按各描述项 `createContent` 产出(字节窗口注入行装饰挂点;
   *    声明 `actionSink` 的内容按 duck-typing 注入会话客户端);
   *  - 触发点 = 工作区接入(connectedCallback,首帧前)+ `tabTypes` 换绑;
   *    **与「接入会话」无关**——窗口集是结构,数据面由 `dataSource` 换绑注入
   *    (解题 ↔ 调试模式切换只换数据源,布局零副作用)。
   */
  #bindWindows(): void {
    this.#boundTabTypes = this.tabTypes;
    const descriptors = this.tabTypes.list();
    this.#contents.clear();
    const viewportWidth = this.#measureViewportWidth();
    const preset = selectLayoutPreset(viewportWidth);
    this.#presetId = preset.id;
    this.#model.setViewportWidth(viewportWidth);
    this.#model.bindWindows(
      descriptors.map((descriptor) => ({
        type: descriptor.type,
        // 展示名:i18n 键优先(WP-53),按**绑定时刻** locale 求值固化
        // (窗口标题不随语言切换追溯——WP-F5 登记口径保留)。
        label: descriptor.labelKey !== undefined ? t(descriptor.labelKey) : descriptor.label,
      })),
      preset.columns,
    );
    for (const descriptor of descriptors) {
      const content = descriptor.createContent?.({ dataSource: this.dataSource }) ?? null;
      if (content instanceof SmByteTab) {
        content.rowDecorator = this.#rowDecorator;
      }
      this.#bindActionSink(content);
      if (content !== null) {
        this.#contents.set(descriptor.type, content);
      }
    }
    // ED 组件面:绑定即注入当前投影 / 账本切面(不等下一次投影事件)。
    this.#syncEdContents();
    // WP-75 #6 / WP-76:指令视图注解与客户端暂停注入面同样绑定即注入。
    this.#syncInstructionViewBindings();
    this.requestUpdate();
  }

  /**
   * 聚焦指定类型窗口(D-MP-1 三类管理动作之「聚焦导航」):聚焦 + 相机居中到
   * 该窗口;未登记类型返回 false(不改变布局与焦点)。窗口集常驻,本方法
   * **不创建实例**——窗口实例数在绑定后恒定。
   */
  focusWindow(type: string): boolean {
    if (!this.#model.focusWindow(type)) {
      return false;
    }
    // 焦点滚动由本方法独占触发(置 `#lastVisibleTabId` 让 `updated()` 不重复
    // 计算相机;平滑滚动途中重复计算会与自身竞争)。
    this.#lastVisibleTabId = type;
    this.ensureTabVisible(type);
    this.requestUpdate();
    return true;
  }

  /** 激活窗口(焦点跟随 + 相机居中;不存在的 id 为 no-op)。 */
  activateTab(tabId: string): void {
    this.#model.activateTab(tabId);
    this.requestUpdate();
  }

  /**
   * 使标签页可达(WP-72 起 = 相机):
   *  1. **纵向兜底** —— 焦点窗口在列内超出可视高时滚到最近边
   *     (`scrollIntoView` 只管纵向;P2 单列 10 窗形态必需);
   *  2. **横向权威** —— 相机计算把焦点列居中(相邻列两侧探出),相机在最后
   *     执行以免被纵向兜底的即时滚动覆盖。
   * jsdom 无布局环境:两路均静默(结构断言由纯函数单测承载)。
   */
  ensureTabVisible(tabId: string): void {
    const column = this.#model.columnIndexOfTab(tabId);
    if (column === null) {
      return;
    }
    const panel = this.#panelOf(tabId);
    if (panel !== null && typeof panel.scrollIntoView === "function") {
      try {
        panel.scrollIntoView({ block: "nearest", inline: "nearest" });
      } catch {
        // 无布局环境(jsdom):滚动增强失败静默,不影响可达性语义。
      }
    }
    this.#centerColumnOnFocus(column);
  }

  /** 列间水平滚动到目标列(Niri 式可达任意列;相机把该列居中)。 */
  scrollToColumn(column: number): void {
    const firstTabId = this.#model.tabIdsInColumn(column)[0];
    if (firstTabId !== undefined) {
      this.ensureTabVisible(firstTabId);
    }
  }

  /**
   * 焦点列居中(相机跟随;`layout-camera.ts` 纯函数 → `scrollLeft`)。
   * 平滑滚动按 `prefers-reduced-motion` 降级为即时定位;无 `scrollTo` 的环境
   * (jsdom)直接赋 `scrollLeft`(同一目标值,便于结构断言)。
   */
  #centerColumnOnFocus(column: number): void {
    const container = this.renderRoot.querySelector("[data-columns]");
    const target = this.renderRoot.querySelector(`[data-column-index="${column}"]`);
    if (!(container instanceof HTMLElement) || !(target instanceof HTMLElement)) {
      return;
    }
    try {
      const box = columnBoxFromRects(
        container.getBoundingClientRect(),
        target.getBoundingClientRect(),
        container.scrollLeft,
      );
      const left = cameraScrollLeft(box, container.clientWidth, { scrollWidth: container.scrollWidth });
      if (typeof container.scrollTo === "function") {
        container.scrollTo({
          left,
          behavior: prefersReducedMotion(defaultMatchMedia()) ? "auto" : "smooth",
        });
        return;
      }
      container.scrollLeft = left;
    } catch {
      // 无布局环境:相机静默(不影响可达性语义)。
    }
  }

  // ── 布局尺寸动作(WP-72:列宽 / 窗高 / 重置)──────────────────────────────

  /**
   * 设置**焦点列**列宽(视口占比;菜单列宽预设档入口的公共 API 同路)。
   * 夹取护栏由模型承担;返回 false(无焦点列 / 非法占比)时零变化。
   */
  setFocusedColumnWidth(widthRatio: number): boolean {
    const column = this.#model.focusedColumnIndex;
    if (column === null) {
      return false;
    }
    if (!this.#model.setColumnWidth(column, widthRatio)) {
      return false;
    }
    const effective = this.#model.snapshot.columns[column]?.widthRatio ?? widthRatio;
    this.#layoutFeedback = t("workspace.layoutWidthPresetApplied", {
      percent: Math.round(effective * 100),
    });
    this.requestUpdate();
    return true;
  }

  /**
   * 重置布局(WP-72 逃生门):清空列宽 / 窗高调整并应用**当前视口宽对应的
   * 预设**(宽屏下即回到 P0;窄屏下回到该宽度的降级形态)。焦点保持。
   */
  resetLayout(): void {
    this.#model.setViewportWidth(this.#measureViewportWidth());
    this.#model.resetLayout();
    this.#presetId = selectLayoutPreset(this.#model.viewportWidth).id;
    this.#layoutFeedback = t("workspace.layoutResetDone", { preset: this.#presetId });
    this.requestUpdate();
  }

  /** 视口宽测量(px):优先自身内联尺寸(嵌入形态 = iframe 宽);无布局环境回落 window 视口宽。 */
  #measureViewportWidth(): number {
    const own = this.clientWidth;
    if (Number.isFinite(own) && own > 0) {
      return own;
    }
    const view = this.ownerDocument?.defaultView ?? null;
    const inner = view?.innerWidth ?? 0;
    return Number.isFinite(inner) && inner > 0 ? inner : 0;
  }

  /**
   * 响应式降级(WP-72):重测视口宽 → 档位变化(跨断点)即按新档预设重绑列
   * 结构;同档内只更新列宽基准(占比语义 ⇒ 列宽随容器按比例随动)。
   */
  #syncViewportLayout(): void {
    const width = this.#measureViewportWidth();
    const preset = selectLayoutPreset(width);
    const crossedBand = preset.id !== this.#presetId;
    this.#model.setViewportWidth(width);
    if (crossedBand) {
      this.#presetId = preset.id;
      this.#model.applyPreset(preset.columns);
      this.#layoutFeedback = t("workspace.layoutDegraded", {
        preset: preset.id,
        count: preset.columns.length,
      });
    }
    this.requestUpdate();
  }

  readonly #onViewportResize = (): void => {
    this.#syncViewportLayout();
  };


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
    // 裁决重询随会话作废(裁决以 submissionId 为界;新会话 = 新提交域)。
    this.#verdictPoller?.dispose();
    this.#verdictPoller = null;
    this.#verdict = { kind: "idle" };
    const client = this.client;
    if (client === null) {
      this.#syncConnectionFrom("disconnected", null, 0, null);
      this.#projectionStatus = null;
      this.#revision = null;
      this.dataSource = null;
      return;
    }
    // 裁决重询状态机(组合根装配;工厂测试接缝):呈现变更即重渲染(D-API-83 / 84)。
    const verdictPoller = this.verdictPollerFactory !== null
      ? this.verdictPollerFactory(client)
      : new VerdictPoller({ sink: client });
    verdictPoller.onChange((presentation) => {
      this.#verdict = presentation;
      this.requestUpdate();
    });
    this.#verdictPoller = verdictPoller;
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
    let deferred = false;
    for (const content of this.#contents.values()) {
      const refreshable = content as { refresh?: () => void; renderRoot?: ShadowRoot | undefined };
      if (typeof refreshable.refresh !== "function") {
        continue;
      }
      if (refreshable.renderRoot === undefined) {
        // WP-71 时序:窗口集在首帧前绑定,内容元素在**首帧渲染前**尚无
        // renderRoot(Lit 未首渲染)——对未就绪元素调用 refresh() 会因其内部
        // querySelector 取空而抛错。延后到 updated() 之后补刷新。
        deferred = true;
        continue;
      }
      refreshable.refresh();
    }
    this.#contentRefreshDeferred = deferred;
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
    // WP-75 #6:同一份命中集同步进指令视图行左缘标注(WP-76 落点)。
    this.#syncInstructionViewBindings();
  }

  /**
   * 指令视图注入面(WP-75 #6 / WP-76 #4;duck-typing 约定同 `dataSource` /
   * `actionSink`,不动 `tab-registry` 的工厂签名——工厂上下文只携带数据源):
   * 内容元素声明 `registerHits` / `clientPauseAddressHex` 即接收工作区注解
   * 缓存与 payload 客户端暂停落点。命中集是**同一份缓存**(单一来源),指令
   * 视图按行地址精确匹配,不做第二次交叉标注计算。
   */
  #syncInstructionViewBindings(): void {
    for (const content of this.#contents.values()) {
      if ("registerHits" in content) {
        (content as { registerHits?: readonly RegisterHit[] }).registerHits = this.#registerHits;
      }
      if ("clientPauseAddressHex" in content) {
        (content as { clientPauseAddressHex?: string | null }).clientPauseAddressHex =
          this.#clientPauseAddressHex;
      }
    }
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
    const factory =
      this.debugDataSourceFactory ??
      ((session: DebugSessionLike) =>
        createDebugDataSource(session, {
          // 投影来源 = 会话公开投影(WP-70:`regions()` / `registers()` / 行区域
          // 归属的结构同构映射唯一来源;调试档零私有信息推导,ADR-DC1 what-if
          // 纪律)。每次调用读最新快照,投影前进即随动。
          projectionProvider: () => session.store.snapshot ?? null,
        }));
    const debugSource = factory(client);
    if (debugSource === null) {
      this.#debugFeedback = t("debug.sourceFailed");
      this.requestUpdate();
      return;
    }
    this.#debugDataSource = debugSource;
    this.#debugChangeDisposer = debugSource.onChange((event) => this.#onDebugSourceChange(event));
    this.#mode = "debug";
    // 模式切换 = 呈现面重置:payload 客户端暂停落点不跨模式保留(新档无该语义)。
    this.#clientPauseAddressHex = null;
    // 断点积木双档(FE-WS-07):payload 断点集合并入调试断点(最小接线挂点)。
    this.#mergePayloadBreakpoints(debugSource);
    // 换绑数据源(字节视图换绑即重建 = 锚点/滚动重置,F5 既有验收口径)。
    this.dataSource = debugSource;
    debugSource.attach();
    this.#debugFeedback = t("debug.connecting");
    this.#rebindContents();
    this.#syncEdContents();
    this.#syncInstructionViewBindings();
    this.requestUpdate();
  }

  /** 切回解题模式:释放调试档 → 重绑公开投影数据源。 */
  #exitDebugMode(): void {
    this.#teardownDebugSource();
    this.#mode = "solve";
    this.#debugFeedback = null;
    this.#clientPauseAddressHex = null;
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
    this.#chainPseudoAsmProviderCache = null;
  }

  /**
   * 断点积木双档(FE-WS-07 / WP-76):payload 断点积木在解题模式 = 步进暂停
   * (WP-F6 现状);调试模式 = 断点集合并入调试断点。挂点 = 内容元素
   * `breakpointAddresses()` 声明面(WP-76 起编译器断点步骤携带 `addressHex`)
   * ——payload 页返回**真实地址集**,并入即生效。
   *
   * 并入语义(登记):
   *  - **只并入可解析地址**:编译器不可解析(无公开投影 / 无 `rip`)的断点
   *    步骤不产出地址,此处自然跳过(不伪造地址、不推断);
   *  - **add-only 幂等**:`DebugDataSource.addBreakpoint` 对重复地址为 no-op;
   *    payload 程序变更后**不自动移除**旧地址(避免误删用户在指令视图手动添加
   *    的同地址断点)——移除入口 = 指令视图行断点(FE-IN-08);
   *  - 触发点 = 进入调试模式 + payload 程序编译完成事件
   *    (`payload-breakpoints-changed`),两处都是幂等调用。
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

  /**
   * payload 页编译产出新程序(WP-76):调试档下重并入断点积木地址(add-only
   * 幂等),使「调试模式内改积木 → 运行到断点」不必重进调试模式。
   */
  #onPayloadBreakpointsChanged(): void {
    const debugSource = this.#debugDataSource;
    if (this.#mode !== "debug" || debugSource === null) {
      return;
    }
    this.#mergePayloadBreakpoints(debugSource);
    this.requestUpdate();
  }

  /**
   * payload 客户端步进暂停(WP-76 #4):积木执行器停在断点积木上 = **客户端
   * 本地暂停**,不含服务端断点语义 ⇒ 只作"客户端步进暂停"分面呈现(指令视图
   * 锚点 + 文案),不写调试通道暂停态、不伪造 `debug_paused`。
   */
  #onPayloadClientPause(event: Event): void {
    const detail = (event as CustomEvent<{ readonly addressHex?: string | null }>).detail;
    const addressHex = detail?.addressHex ?? null;
    if (this.#clientPauseAddressHex === addressHex) {
      return;
    }
    this.#clientPauseAddressHex = addressHex;
    this.#syncInstructionViewBindings();
    this.requestUpdate();
  }

  /**
   * 指令视图行断点增删(FE-IN-08)回流:断点集合的**所有者是调试数据源**
   * (视图直接 `toggleBreakpoint`——同一实例,无第二份状态),本挂点只刷新
   * 「运行到断点」可用性与相关呈现(不重放集合、不重复并入 payload 地址)。
   */
  #onBreakpointsChanged(): void {
    this.requestUpdate();
  }

  /**
   * 跳转链伪汇编提供者(WP-76 §2.3 #2):调试档注入 = 调试通道已下发的指令流
   * 查表(`instructionAt`,推送覆盖面内命中);解题档 = null ⇒ 组件按登记形态
   * 降级为引导文案(**无第二数据通道**:仅消费既有调试通道推送)。
   */
  #chainPseudoAsmProvider(
    dataSource: MemoryDataSource,
  ): ((addressHex: string) => { readonly text: string } | null) | null {
    const debugSource = this.#debugDataSource;
    if (debugSource === null || dataSource !== debugSource) {
      return null;
    }
    const cached = this.#chainPseudoAsmProviderCache;
    if (cached !== null && cached.source === debugSource) {
      return cached.provider;
    }
    const provider = (addressHex: string): { readonly text: string } | null =>
      debugSource.instructionAt(addressHex);
    this.#chainPseudoAsmProviderCache = { source: debugSource, provider };
    return provider;
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
      case "submit":
        // 阶段六 WP-63(D-API-84):submit → 裁决重询(pending 确定性呈现 →
        // verdicted 11 值结果呈现;非成绩方向显式重提入口也经此处)。
        void this.#submitForVerdict();
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
      case "focus-window":
        // D-MP-1 聚焦导航(WP-71):菜单「窗口」分组 = 聚焦 + 滚动到该窗口
        // (替代原「打开标签」;窗口集常驻,不存在开 / 关语义)。
        this.focusWindow(action.windowType);
        break;
      case "set-column-width":
        // WP-72 列宽预设档(1/4、1/3、1/2、2/3、全宽):作用于焦点列,
        // 夹取到最小可读宽护栏(菜单入口为唯一入口,标题栏不再新增控件)。
        this.setFocusedColumnWidth(action.ratio);
        break;
      case "reset-layout":
        // WP-72 「重置布局」:清空列宽 / 窗高调整 + 回当前宽度档预设。
        this.resetLayout();
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

  // ── 正式裁决呈现(阶段六 WP-63;D-API-83 / D-API-84)──────────────────────

  /**
   * submit 受理后启动裁决重询(显式重提入口同路:新 submit → 新
   * submissionId → 新 pending;旧 submission 与旧裁决不动)。被拒(限流 /
   * 终态 / 存储不可用)呈现为既有错误条(冻结 PublicError,零新增呈现面)。
   */
  async #submitForVerdict(): Promise<void> {
    const client = this.client;
    if (client === null) {
      return;
    }
    try {
      const response = await client.submit();
      this.#verdictPoller?.follow(response.payload.submissionId);
    } catch (error) {
      if (error instanceof SessionCommandError) {
        this.#lastError = error.publicError;
        this.requestUpdate();
        return;
      }
      this.#lastError = {
        code: "internal_error",
        message: error instanceof SessionClientError ? error.message : t("workspace.actionSubmitFailed"),
      };
      this.requestUpdate();
    }
  }

  #renderVerdictBanner(): unknown {
    const verdict = this.#verdict;
    if (verdict.kind === "idle") {
      return nothing;
    }
    if (verdict.kind === "pending") {
      return html`
        <p
          class="verdict-banner"
          role="status"
          data-testid="sm-verdict"
          data-verdict-state="pending"
        >
          <strong>${t("verdict.heading")}</strong>
          <span class="verdict-state">${t("verdict.pending")}</span>
          <span>${t("verdict.pendingNote")}</span>
        </p>
      `;
    }
    if (verdict.kind === "verdicted") {
      const result = verdict.verdict;
      // 成绩方向(success / 6 个失败方向)与非成绩方向(engine_error /
      // challenge_invalid / replay_mismatch / cancelled)同构呈现——11 值字面
      // 为唯一公开承载,零部分匹配信息;非成绩方向附显式重新提交入口
      // (不自动重试,D-API-84)。裁决不可用 ≠ 判负:pending / unavailable
      // 态零成绩语义。
      const score = SCORE_VERDICTS.has(result);
      return html`
        <p
          class="verdict-banner verdicted"
          role="status"
          data-testid="sm-verdict"
          data-verdict-state="verdicted"
          data-verdict-result=${result}
        >
          <strong>${t("verdict.heading")}</strong>
          <span class="verdict-state">
            ${result === "success"
              ? t("verdict.scorePassed", { verdict: result })
              : score
                ? t("verdict.scoreFailed", { verdict: result })
                : t("verdict.nonScore", { verdict: result })}
          </span>
          ${score
            ? nothing
            : html`
                <span>${t("verdict.nonScoreNote")}</span>
                <button type="button" class="verdict-resubmit" @click=${() => void this.#submitForVerdict()}>
                  ${t("verdict.resubmit")}
                </button>
              `}
        </p>
      `;
    }
    // unavailable(重询连续失败触顶;降级明示,复用 pwn-degraded 语义锚
    // 纪律——确定性 testid + 原因属性;不中断会话、不判负)。
    return html`
      <p
        class="verdict-banner unavailable"
        role="status"
        data-testid="sm-verdict"
        data-verdict-state="unavailable"
        data-pwn-reason="verdict-unavailable"
      >
        <strong>${t("verdict.unavailable")}</strong>
        <span>${t("verdict.unavailableNote")}</span>
      </p>
    `;
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
      if ("authorBlocks" in bindable) {
        // M10/WP-80:出题者积木声明面(公开描述包可选顶层字段)→ Payload 面板。
        // 缺省(题目未声明 / 未接入描述包)= 空数组 ⇒ 面板与既有一字不差。
        bindable["authorBlocks"] = descriptor?.authorBlocks ?? [];
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
   *
   * **既有缺陷修复登记(M2 / WP-75 #5 交叉核对发现,WP-76 修复)**:链起始
   * 地址此前以裸属性面 `start-address-hex` 绑定,而 `<sm-jump-chain>` 的
   * `startAddressHex` 未声明 `attribute:`,Lit 观察的属性名是其**全小写**形态
   * (`startaddresshex`)⇒ 组件 `startAddressHex` 恒为空、`render()` 直接空渲染:
   * 栈视图 / 自由视图行右段跳转链**恒不出现**(调试档「延伸」入口随之不可达,
   * 伪汇编延伸亦无宿主)。修法 = 与同模板 `dataSource` / `extendable` /
   * `extendHandler` 一致改**属性面**绑定(组件对外属性面 API 与既有测试不变)。
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
      .startAddressHex=${row.addressHex}
      .pseudoAsmProvider=${this.#chainPseudoAsmProvider(dataSource)}
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

  // ── 拖拽排布(pointer 事件;动画只用 opacity)+ 分隔条(WP-72)──────────────

  #onTabBarPointerDown(event: PointerEvent, tabId: string): void {
    // 标题栏 = 拖拽把手(无关闭钮等交互子元素;尺寸控件在菜单「布局」组,
    // 不移入标题栏 —— 保持 WP-71「标题栏零按钮」口径)。
    this.#drag = { tabId, startX: event.clientX, startY: event.clientY, moved: false };
  }

  /** 列间分隔条按下(WP-72;gapIndex = 空隙右侧列序 = 新建列位插入位置)。 */
  #onColumnDividerPointerDown(event: PointerEvent, gapIndex: number): void {
    const left = this.#model.snapshot.columns[gapIndex - 1];
    if (left === undefined) {
      return;
    }
    this.#dividerDrag = {
      kind: "column",
      gapIndex,
      startX: event.clientX,
      startRatio: left.widthRatio,
      moved: false,
    };
  }

  /** 同列窗间分隔条按下(index = 上侧窗口序号;调整 index 与 index+1 两窗)。 */
  #onRowDividerPointerDown(event: PointerEvent, column: number, index: number): void {
    const heights = this.#model.snapshot.columns[column]?.rowHeights;
    if (heights === undefined) {
      return;
    }
    this.#dividerDrag = {
      kind: "row",
      column,
      index,
      startY: event.clientY,
      startHeights: [...heights],
      // 像素基准在按下瞬间冻结:拖拽期间列高会随比例长高(见 DividerDrag 注释)。
      startColumnHeightPx: this.#columnElement(column)?.clientHeight ?? 0,
      moved: false,
    };
  }

  readonly #onPointerMove = (event: PointerEvent): void => {
    const divider = this.#dividerDrag;
    if (divider !== null) {
      this.#onDividerPointerMove(event, divider);
      return;
    }
    const drag = this.#drag;
    if (drag === null) {
      return;
    }
    if (!drag.moved) {
      const moved =
        Math.abs(event.clientX - drag.startX) > DRAG_THRESHOLD_PX ||
        Math.abs(event.clientY - drag.startY) > DRAG_THRESHOLD_PX;
      if (!moved) {
        return;
      }
      drag.moved = true;
      this.#panelOf(drag.tabId)?.classList.add("dragging");
    }
    // 拖拽中实时解析落点(三类 Niri 落点显式化 + 静态指示 + 状态行宣读)。
    this.#updateDropTarget(event, drag.tabId);
  };

  /** 分隔条拖拽(与窗口拖拽共用阈值语义:位移未过阈值 = 不算拖拽)。 */
  #onDividerPointerMove(event: PointerEvent, divider: DividerDrag): void {
    const deltaPx =
      divider.kind === "column" ? event.clientX - divider.startX : event.clientY - divider.startY;
    if (Math.abs(deltaPx) <= DRAG_THRESHOLD_PX) {
      return;
    }
    divider.moved = true;
    if (divider.kind === "column") {
      const ratio = columnWidthAfterDrag({
        startRatio: divider.startRatio,
        deltaPx,
        viewportWidth: this.#model.viewportWidth,
        minWidthPx: MIN_COLUMN_WIDTH,
      });
      if (this.#model.setColumnWidth(divider.gapIndex - 1, ratio)) {
        this.#layoutFeedback = t("workspace.layoutWidthAdjusted", { percent: this.#columnWidthPercent(divider.gapIndex - 1) });
        this.requestUpdate();
      }
      return;
    }
    const heights = rowHeightsAfterDrag({
      heights: divider.startHeights,
      index: divider.index,
      deltaPx,
      columnHeightPx: divider.startColumnHeightPx,
      minHeightPx: MIN_ROW_HEIGHT_PX,
    });
    if (this.#model.setRowHeights(divider.column, heights)) {
      this.#layoutFeedback = t("workspace.layoutHeightAdjusted", {
        percent: this.#columnHeightPercent(divider.column, divider.index),
      });
      this.requestUpdate();
    }
  }

  /** 列宽百分比(四舍五入整数;状态行与分隔条 aria-valuenow 共用)。 */
  #columnWidthPercent(column: number): number {
    return Math.round((this.#model.snapshot.columns[column]?.widthRatio ?? 0) * 100);
  }

  /** 窗高百分比(四舍五入整数;上侧窗口）。 */
  #columnHeightPercent(column: number, index: number): number {
    return Math.round((this.#model.snapshot.columns[column]?.rowHeights[index] ?? 0) * 100);
  }

  /**
   * 分隔条方向键(WP-72 键盘可达兜底):列宽分隔条左右键 ±`DIVIDER_KEY_STEP_PX`;
   * 窗高分隔条上下键 ±`ROW_DIVIDER_KEY_STEP`。真实可聚焦元素 + `role="separator"`,
   * 反馈经常驻 `role="status"` 状态行宣读(不只在视觉中)。
   */
  #onColumnDividerKeyDown(event: KeyboardEvent, gapIndex: number): void {
    const step = event.key === "ArrowLeft" ? -DIVIDER_KEY_STEP_PX : event.key === "ArrowRight" ? DIVIDER_KEY_STEP_PX : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const left = gapIndex - 1;
    const startRatio = this.#model.snapshot.columns[left]?.widthRatio ?? 0;
    const ratio = columnWidthAfterDrag({
      startRatio,
      deltaPx: step,
      viewportWidth: this.#model.viewportWidth,
      minWidthPx: MIN_COLUMN_WIDTH,
    });
    if (this.#model.setColumnWidth(left, ratio)) {
      this.#layoutFeedback = t("workspace.layoutWidthAdjusted", { percent: this.#columnWidthPercent(left) });
      this.requestUpdate();
    }
  }

  #onRowDividerKeyDown(event: KeyboardEvent, column: number, index: number): void {
    const step = event.key === "ArrowUp" ? -ROW_DIVIDER_KEY_STEP : event.key === "ArrowDown" ? ROW_DIVIDER_KEY_STEP : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const heights = this.#model.snapshot.columns[column]?.rowHeights;
    if (heights === undefined) {
      return;
    }
    // 比例步进成对调整(上窗 +step / 下窗 −step,和恒为 1);列高已知时以
    // `MIN_ROW_HEIGHT_PX` 为窗高下限,未知(jsdom / 未布局)时退化为纯比例步进
    // ——后者把「自由空间」记作 1px(列高 = chrome + 1)且下限记 0,于是
    // `deltaPx = step` 在像素语义下等价于占比 ±step(见 rowHeightsAfterDrag)。
    const columnHeightPx = this.#columnElement(column)?.clientHeight ?? 0;
    const known = Number.isFinite(columnHeightPx) && columnHeightPx > 0;
    const next = rowHeightsAfterDrag({
      heights,
      index,
      deltaPx: step * (known ? columnHeightPx : 1),
      columnHeightPx: known ? columnHeightPx : columnChromePx(heights.length) + 1,
      minHeightPx: known ? MIN_ROW_HEIGHT_PX : 0,
    });
    if (this.#model.setRowHeights(column, next)) {
      this.#layoutFeedback = t("workspace.layoutHeightAdjusted", {
        percent: this.#columnHeightPercent(column, index),
      });
      this.requestUpdate();
    }
  }

  /**
   * 标题栏键盘兜底(WP-72 键盘可达性):标题栏可聚焦(`tabindex=0`),
   * 方向键 = 列内上下重排 / 跨列移动(至少保证焦点可移动与顺序可达,
   * **不承诺**全局快捷键增量);Enter / Space = 激活该窗口(与点击同义)。
   */
  #onTabBarKeyDown(event: KeyboardEvent, tabId: string): void {
    const position = this.#model.positionOfTab(tabId);
    if (position === null) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.activateTab(tabId);
      return;
    }
    const columnLength = this.#model.tabIdsInColumn(position.column).length;
    let target: MoveTarget | null;
    switch (event.key) {
      case "ArrowUp":
        // 列内上移一位:插入位 = 自身序号 − 1(moveTab 语义)。
        target = position.index > 0 ? { column: position.column, index: position.index - 1 } : null;
        break;
      case "ArrowDown":
        // 列内下移一位:插入位 = 自身序号 + 2(先摘除后插入的位序修正)。
        target = position.index < columnLength - 1 ? { column: position.column, index: position.index + 2 } : null;
        break;
      case "ArrowLeft":
        target =
          position.column > 0
            ? { column: position.column - 1, index: this.#model.tabIdsInColumn(position.column - 1).length }
            : null;
        break;
      case "ArrowRight":
        target =
          position.column < this.#model.columnCount - 1 ? { column: position.column + 1, index: 0 } : null;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (target === null) {
      return;
    }
    this.#model.moveTab(tabId, target);
    this.#lastVisibleTabId = tabId;
    const landed = this.#model.positionOfTab(tabId);
    this.#layoutFeedback = t("workspace.windowMoved", {
      title: this.#model.tab(tabId)?.title ?? tabId,
      column: (landed?.column ?? 0) + 1,
      index: (landed?.index ?? 0) + 1,
    });
    this.requestUpdate();
  }

  readonly #onPointerUp = (event: PointerEvent): void => {
    // 先取态再收尾(收尾会清空拖拽态)。
    const divider = this.#dividerDrag;
    const drag = this.#drag;
    this.#cancelDrag();
    if (divider !== null) {
      return; // 分隔条拖拽在 pointerup 只收尾(调整已在 move 中生效)。
    }
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
    if (target === null) {
      // 列区之外松开:不移动,状态行明示(拖拽取消的可宣读反馈)。
      this.#layoutFeedback = t("workspace.dropOutside");
      this.requestUpdate();
      return;
    }
    this.#applyDrop(drag.tabId, target);
    this.requestUpdate();
  };

  readonly #onPointerCancel = (): void => {
    this.#cancelDrag();
  };

  #cancelDrag(): void {
    const drag = this.#drag;
    this.#drag = null;
    this.#dropTarget = null;
    this.#dividerDrag = null;
    if (drag !== null) {
      this.#panelOf(drag.tabId)?.classList.remove("dragging");
    }
    this.requestUpdate();
  }

  #panelOf(tabId: string): Element | null {
    return this.renderRoot.querySelector(`[data-tab-id="${tabId}"]`);
  }

  #columnElement(column: number): HTMLElement | null {
    const element = this.renderRoot.querySelector(`[data-column-index="${column}"]`);
    return element instanceof HTMLElement ? element : null;
  }

  /** 落点候选实时更新(指示 + 状态行宣读;拖拽未过阈值时不解析)。 */
  #updateDropTarget(event: PointerEvent, tabId: string): void {
    if (this.#drag?.moved !== true) {
      return;
    }
    const target = this.#resolveDropTarget(event);
    const previous = this.#dropTarget;
    if (target === null) {
      // 落点在列区之外(条带外 / 无落点):不留残留指示,状态行明示「不移动」。
      this.#dropTarget = null;
      this.#layoutFeedback = t("workspace.dropOutside");
      if (previous !== null) {
        this.requestUpdate();
      }
      return;
    }
    this.#dropTarget = { tabId, target };
    this.#layoutFeedback = this.#dropFeedback(target);
    const changed =
      previous === null ||
      previous.target.kind !== target.kind ||
      previous.target.column !== target.column ||
      previous.target.index !== target.index;
    if (changed) {
      this.requestUpdate();
    }
  }

  /** 落点语义 → 状态行文案(屏幕阅读器信息不只在视觉中)。 */
  #dropFeedback(target: DropTarget): string {
    if (target.kind === "new-column") {
      return t("workspace.dropNewColumn", { column: target.column + 1 });
    }
    const ids = this.#model.tabIdsInColumn(target.column);
    const before = ids[target.index];
    if (before !== undefined) {
      return t("workspace.dropBefore", { title: this.#model.tab(before)?.title ?? before });
    }
    const last = ids.at(-1);
    return last === undefined
      ? t("workspace.dropNewColumn", { column: target.column + 1 })
      : t("workspace.dropAfter", { title: this.#model.tab(last)?.title ?? last });
  }

  /**
   * 指针落点 → 三类 Niri 落点(WP-72 显式化):
   *  - **列间空隙**(分隔条)/ 列区空白 → `new-column`(在该列序位置新建列位);
   *  - 落到窗口上 / 下半 = 插到其前 / 后;同列 → `stack`(同列堆叠),
   *    跨列 → `cross-column`(跨列移动);
   *  - 落到列(非窗口)→ 该列尾插(同列 / 跨列同上);列区之外 → null(不移动)。
   */
  #resolveDropTarget(event: PointerEvent): DropTarget | null {
    const element = event.target;
    if (!(element instanceof Element) || element.closest("[data-columns]") === null) {
      return null;
    }
    const draggedId = this.#drag?.tabId ?? null;
    const from = draggedId === null ? null : this.#model.positionOfTab(draggedId);
    const gapElement = element.closest("[data-gap-index]");
    if (gapElement !== null) {
      const gap = Number(gapElement.getAttribute("data-gap-index"));
      if (Number.isFinite(gap)) {
        return { kind: "new-column", column: gap, index: 0 };
      }
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
        return {
          kind: from !== null && from.column === position.column ? "stack" : "cross-column",
          column: position.column,
          index: after ? position.index + 1 : position.index,
        };
      }
    }
    const columnElement = element.closest("[data-column-index]");
    if (columnElement !== null) {
      const column = Number(columnElement.getAttribute("data-column-index"));
      if (Number.isFinite(column)) {
        return {
          kind: from !== null && from.column === column ? "stack" : "cross-column",
          column,
          index: this.#model.tabIdsInColumn(column).length,
        };
      }
    }
    // 列区空白(条带末尾)= 在末位新建列位(Niri 语义,与此前「开新列尾插」等价)。
    return { kind: "new-column", column: this.#model.columnCount, index: 0 };
  }

  /** 落点应用:同列堆叠 / 跨列移动 → `moveTab`;新建列位 → `openColumnAt`。 */
  #applyDrop(tabId: string, target: DropTarget): void {
    if (target.kind === "new-column") {
      this.#model.openColumnAt(tabId, target.column);
      return;
    }
    this.#model.moveTab(tabId, { column: target.column, index: target.index });
  }

  /** 指定渲染位置的落点标记(仅静态 class / data 属性;零浮动层)。 */
  #dropMarkingForPanel(column: number, index: number, columnLength: number): string | null {
    const target = this.#dropTarget?.target;
    if (target === undefined || target.kind === "new-column" || target.column !== column) {
      return null;
    }
    if (target.index === index) {
      return "before";
    }
    if (target.index >= columnLength && index === columnLength - 1) {
      return "after";
    }
    return null;
  }

  #isGapDropTarget(gapIndex: number): boolean {
    const target = this.#dropTarget?.target;
    return target !== undefined && target.kind === "new-column" && target.column === gapIndex;
  }

  #isTailDropTarget(columnCount: number): boolean {
    const target = this.#dropTarget?.target;
    return target !== undefined && target.kind === "new-column" && target.column >= columnCount;
  }

  // ── 渲染 ─────────────────────────────────────────────────────────────────

  protected override render(): unknown {
    const snapshot = this.#model.snapshot;
    const descriptor = this.challengeDescriptor;
    return html`
      <div
        class="sm-scanline"
        part="scanline"
        data-sm-decoration="scanline"
        aria-hidden="true"
      ></div>
      <sm-workspace-menu
        .tabTypes=${this.tabTypes.list()}
        .focusedWindowType=${snapshot.focusedTabId}
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
        .layoutPresetId=${this.#presetId}
        .focusedColumnWidthRatio=${this.#model.focusedColumnIndex === null
          ? null
          : (snapshot.columns[this.#model.focusedColumnIndex]?.widthRatio ?? null)}
        .lastError=${this.#lastError}
        @workspace-menu-action=${this.#onMenuAction}
      ></sm-workspace-menu>
      ${this.#renderVerdictBanner()}
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
      <p class="layout-status" role="status" data-layout-feedback>${this.#layoutFeedback ?? ""}</p>
      <main
        class="columns${this.#isTailDropTarget(snapshot.columns.length) ? " drop-target" : ""}"
        data-columns
        aria-label=${t("workspace.columnsAria")}
        @viewport-jump=${this.#onViewportJump}
        @highlight-jump=${this.#onHighlightJump}
        @breakpoints-changed=${this.#onBreakpointsChanged}
        @payload-breakpoints-changed=${this.#onPayloadBreakpointsChanged}
        @payload-client-pause=${this.#onPayloadClientPause}
      >
        ${snapshot.columns.map((column, columnIndex) => this.#renderColumn(column, columnIndex, snapshot.columns.length))}
      </main>
    `;
  }

  /**
   * 单列渲染(列宽 / 列高下限内联为像素 + 列内窗口 / 窗高分隔条交替)。
   * 列高下限 = `columnMinHeightPx(列内窗高比例)`:列盒随比例长高,使每个面板都
   * 不低于 `MIN_ROW_HEIGHT_PX` ⇒ 溢出列的窗高拖拽有效(增大的窗真的变大、被减小的
   * 窗贴下限停住、列总高随之增长),条带 / 文档滚动承载溢出(见 `.columns`)。
   */
  #renderColumn(
    column: WorkspaceLayoutSnapshot["columns"][number],
    columnIndex: number,
    columnCount: number,
  ): unknown {
    const children: unknown[] = [];
    column.tabIds.forEach((tabId, index) => {
      if (index > 0) {
        children.push(this.#renderRowDivider(columnIndex, index - 1, column));
      }
      children.push(
        this.#renderPanel(tabId, columnIndex, index, column.tabIds.length, column.rowHeights[index] ?? 1),
      );
    });
    const minBlockSizePx = columnMinHeightPx(column.rowHeights);
    return html`
      <div
        class="column"
        data-column-index=${columnIndex}
        style="inline-size: ${this.#columnWidthPx(column.widthRatio)}px; min-block-size: ${minBlockSizePx}px"
      >
        ${children}
      </div>
      ${columnIndex < columnCount - 1 ? this.#renderColumnDivider(columnIndex + 1, column) : nothing}
    `;
  }

  /**
   * 列宽像素(列宽占比 × 视口宽,**不低于最小可读宽护栏**):
   * 护栏在此再兜一次(模型已夹取;视口宽未知时占比可能小于护栏的像素等价)。
   */
  #columnWidthPx(widthRatio: number): number {
    const viewportWidth = this.#model.viewportWidth;
    const raw = viewportWidth > 0 ? widthRatio * viewportWidth : MIN_COLUMN_WIDTH;
    const bounded = Math.max(raw, MIN_COLUMN_WIDTH);
    return Math.round(bounded * 100) / 100;
  }

  /**
   * 列间分隔条(相邻列之间;`data-gap-index` = 新建列位的插入列序)。
   * 真实可聚焦元素 + `role="separator"` + aria 值;方向键调整(键盘可达)。
   */
  #renderColumnDivider(gapIndex: number, leftColumn: WorkspaceLayoutSnapshot["columns"][number]): unknown {
    const percent = Math.round(leftColumn.widthRatio * 100);
    const minPercent = Math.round(
      (this.#model.viewportWidth > 0 ? Math.min(1, MIN_COLUMN_WIDTH / this.#model.viewportWidth) : 0) * 100,
    );
    return html`
      <div
        class="column-divider${this.#isGapDropTarget(gapIndex) ? " drop-target" : ""}"
        role="separator"
        aria-orientation="vertical"
        aria-label=${t("workspace.columnDividerAria")}
        aria-valuemin=${minPercent}
        aria-valuemax="100"
        aria-valuenow=${percent}
        tabindex="0"
        data-column-divider=${gapIndex}
        data-gap-index=${gapIndex}
        data-drop-kind=${this.#isGapDropTarget(gapIndex) ? "new-column" : nothing}
        @pointerdown=${(event: PointerEvent) => this.#onColumnDividerPointerDown(event, gapIndex)}
        @keydown=${(event: KeyboardEvent) => this.#onColumnDividerKeyDown(event, gapIndex)}
      ></div>
    `;
  }

  /** 同列窗间分隔条(`data-row-divider` = `列序:上侧窗口序号`;调整窗高比例)。 */
  #renderRowDivider(
    columnIndex: number,
    index: number,
    column: WorkspaceLayoutSnapshot["columns"][number],
  ): unknown {
    const percent = Math.round((column.rowHeights[index] ?? 0) * 100);
    return html`
      <div
        class="row-divider"
        role="separator"
        aria-orientation="horizontal"
        aria-label=${t("workspace.rowDividerAria")}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow=${percent}
        tabindex="0"
        data-row-divider="${columnIndex}:${index}"
        @pointerdown=${(event: PointerEvent) => this.#onRowDividerPointerDown(event, columnIndex, index)}
        @keydown=${(event: KeyboardEvent) => this.#onRowDividerKeyDown(event, columnIndex, index)}
      ></div>
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

  /**
   * 窗口面板渲染:
   *  - `data-render-degrade="content-visibility"` = 视口外降级渲染语义标记
   *    (样式侧 `content-visibility: auto` + `contain-intrinsic-size`);
   *  - `style="flex-grow: <窗高比例>; …"` = **窗高比例的唯一呈现路径**(Hyprland 式:
   *    同列窗口按比例分配列高;单窗列比例恒 1 = 占满列高)。拖拽分隔条只改这个
   *    内联比例,不重建面板内容(虚拟列表维持);
   *  - 落点指示(`drop-target` + `data-drop-kind` / `data-drop-position`)只在
   *    拖拽中出现在**命中落点的那一个**面板上(静态 class,零浮动层);
   *  - 标题栏 = 拖拽把手 + 键盘可达入口(`tabindex=0`,方向键重排 / 移动),
   *    **零控件**(无按钮 / 无交互元素,WP-71 口径保留);终端式装饰(角标伪
   *    元素 + 块状光标)为纯装饰、绝对定位、`aria-hidden`、零文本、零可聚焦
   *    后代,不承载信息(缺席不丢失任何信息,WP-74 效果面)。
   */
  #renderPanel(
    tabId: string,
    columnIndex: number,
    index: number,
    columnLength: number,
    rowHeight: number,
  ): unknown {
    const info = this.#model.tab(tabId);
    if (info === null) {
      return nothing;
    }
    const content = this.#contents.get(info.id) ?? null;
    const descriptor = this.#tabTypeDescriptor(info.type);
    const focused = this.#model.focusedTabId === info.id;
    const dropPosition = this.#dropMarkingForPanel(columnIndex, index, columnLength);
    const dropKind = dropPosition === null ? undefined : this.#dropTarget?.target.kind;
    return html`
      <section
        class="tab-panel${focused ? " focused" : ""}${dropPosition === null ? "" : " drop-target"}"
        data-tab-id=${info.id}
        data-render-degrade="content-visibility"
        data-drop-position=${dropPosition ?? nothing}
        data-drop-kind=${dropPosition === null ? nothing : dropKind}
        style="flex-grow: ${rowHeight}; flex-shrink: 1; flex-basis: 0"
        aria-label=${info.title}
      >
        <header
          class="tab-bar"
          tabindex="0"
          @pointerdown=${(event: PointerEvent) => this.#onTabBarPointerDown(event, info.id)}
          @keydown=${(event: KeyboardEvent) => this.#onTabBarKeyDown(event, info.id)}
        >
          <span class="tab-title">${info.title}</span>
          <span
            class="sm-caret"
            part="caret"
            data-sm-decoration="caret"
            aria-hidden="true"
          ></span>
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

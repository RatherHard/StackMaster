/**
 * <sm-workspace> —— 工作区容器(WP-F5;FE-X-02 唯一主体边界;WP-71 固定窗口集;
 * **2026-09-18 整页布局改版 = D-API-153 / D-UI-1 ~ D-UI-7**)。
 *
 * 职责 = 工作区即**页面主体**(FE-WS-01 整页布局)+ 顶部菜单(FE-WS-03)+
 * 跨视图集成接线(F3/F4 交付能力的组合根):
 *
 *  - **整页布局(FE-WS-01 / D-UI-1)**:工作区自身即页面主体(`display: grid` +
 *    `block-size: 100dvh` / `100%`),**不依赖宿主 / 壳给出高度**,溢出**不上浮到
 *    文档层**;左右两分 = `grid-template-columns: 1fr 1fr`(固定 1:1,**不可调**、
 *    **无分界拖拽手柄**)、**无 gap、无 border、无 divider**;窄屏时左半侧取
 *    `min-width: SIDE_PANEL_MIN_WIDTH_PX`(452.4px,D-UI-5)⇒ 页面横向滚动。
 *  - **右半侧 = payload 搭建窗口(固定)**:从 `#contents` 里把 payload 内容元素
 *    **同一实例**挂到右半侧(不重建 —— payload 状态跨模式 / 跨渲染必须保留,
 *    FE-WS-07 的 `#contents` 生命周期约定是既有不变量);右半侧不随左侧滚动移动。
 *  - **左半侧 = 视图管理窗口**:列表按钮(可展开 / 收起:勾选 + 拖拽排序,
 *    **唯一入口**)在上,视图位纵向堆叠在下;`.ws-stack` 是**滚动容器**
 *    (`overflow-y: auto` + `scroll-behavior: smooth`;`prefers-reduced-motion:
 *    reduce` 下退化为 `auto`)。**只滚动、不压缩** —— 每个视图位高度由
 *    `viewSlotHeightPx()` 给出确定值(等于左半侧可视高等分,下限 = chrome +
 *    `VIEW_SLOT_MIN_VISIBLE_HEX_ROWS` 个行单位),空间不足时多余部分由滚动承载。
 *  - **视图类型名写在视图内左上角**(FE-WS-11):`.view-label` 是面板内第一个
 *    元素、**不是独立标题栏**(原 `.tab-bar` 整条退场);面板地标名**保持原样**
 *    `aria-label=${info.title}`(D-UI-7 ①:不因标题栏消失而改名,避免二次 axe
 *    地标重名回归)。
 *  - **固定窗口集(D-MP-1 不修订)**:视图集合 = 注册表登记的全部类型、**各恰一个
 *    实例、常驻**;**没有开 / 关状态**;未勾选 = 不显示 = 「暂离」的**第二种成因**
 *    (第一种仍是滚出可视区)。无关闭入口、无空态引导。
 *  - **键盘(D-UI-3)**:`Ctrl + ArrowUp` / `Ctrl + ArrowDown` 在**左半侧容器**上
 *    `keydown` 捕获并 `preventDefault()`(覆盖浏览器页面滚动默认),切换一格
 *    **可见**视图位、**边界不环绕**;当前视图名经常驻 `role="status"` 宣读。
 *  - **列表按钮的键盘等价路径(D-UI-4 / D-UI-7 ③)**:原生 `<input type=
 *    "checkbox">` 承载勾选(`Space` 原生可用);列表项可聚焦,`Alt + ↑ / ↓` 在
 *    列表内上下移动该条目(`preventDefault`);`aria-live="polite"` 播报
 *    「已显示 / 已隐藏 / 已移动到第 N 位」。
 *  - **拖拽排序(D-UI-4)**:只保留**列表内重排**一种落点语义(原三类 Niri 落点
 *    同列堆叠 / 跨列移动 / 列间空隙新建列位整体废止);拖拽反馈 = 静态 class
 *    (`drop-before` / `drop-after`) + `dragging`(opacity),零动画、零浮动层。
 *  - **视口外降级渲染(保留)**:视图位声明 `content-visibility: auto` +
 *    `contain-intrinsic-size: auto ${VIEW_SLOT_INTRINSIC_PX}px`(语义标记
 *    `data-render-degrade="content-visibility"`),离屏子树由浏览器跳过渲染与绘制。
 *  - **组合根装配**(README §双档数据源纪律):`client` 换绑即
 *    `new ProjectionDataSource(client.store)` 注入各视图内容;
 *    `client.onProjectionChanged(() => 各内容 refresh())` 驱动视图刷新。
 *  - **跨视图联动**:`vma-select ↔ showRegion ↔ selectedRegionId` 回路在
 *    `<sm-byte-tab>` 内闭环;寄存器交叉标注(FE-RG-04)与跳转链
 *    (FE-ST-07/09)经字节视图行装饰挂点(宿主层追加渲染)落地。
 *  - **菜单动作**:`step`(FE-WS-04a)/ `reset`(FE-WS-05,Q5/M11 终态禁用
 *    + 新建引导)/ 手动重连(connection-replaced);拒绝动作呈现
 *    userVisibleError(含 explanation);断线横幅呈现"最近一次公开投影 +
 *    重连中"(零本地 VM 降级)。菜单的「视图」组 = **聚焦导航**(点击 = 聚焦 +
 *    滚动到该视图),**不承载勾选 / 排序**(D-UI-7 补充:唯一入口 = 左半侧列表按钮)。
 *  - **正式裁决呈现**(阶段六 WP-63,D-API-83 / 84):`submit` 动作受理后
 *    启动裁决重询(pending 确定性呈现 → verdicted 11 值结果类型呈现;非成绩
 *    方向显式重提入口、不自动重试;裁决不可用 ≠ 判负——unavailable 降级
 *    明示,不中断会话)。
 *
 * **本版废止(整条退出,不留兼容别名)**:Niri 式列条带(列间水平滚动、列内二叉
 * 分割、视口宽预设 P0 / P1 / P2 与阈值表、列宽五档、列间与窗间分隔条
 * (`role="separator"` + 方向键)、三类拖拽落点、「重置布局」、焦点列居中相机
 * (`layout-camera.ts` 已删除)、窗高下限 `MIN_ROW_HEIGHT_PX` / `columnMinHeightPx`
 * / `columnChromePx` / 拖拽像素语义(`layout-divider.ts` 已删除))。
 * **D-API-152 条目本身是历史决策,不得删除**。
 *
 * 纪律(CLAUDE.md 第十章):浏览器只保存公开投影与 UI 状态;动画只用
 * transform / opacity 或 `scroll-behavior`(丝滑滚动,**`prefers-reduced-motion`
 * 下降级为 `auto`**);语义化 DOM;屏幕阅读器信息不只在视觉中(视图切换 / 列表
 * 操作 / 落点均经 `aria-live` 或常驻 `role="status"` 宣读)。
 *
 * 主题与效果面(WP-74;2026-09-18 单主题):底色 / 前景 / 次要前景 / 面板底 /
 * 语义色 / 焦点环 / 等宽字体栈全走既有 token;`light` / `dark` 退役后
 * **`var(--sm-*)` 的回退值一律不得是浅色字面量**(token 缺失时会静默回落成浅色
 * —— 本仓反复踩过的「看起来生效」失败模式);字号下限 13px。
 *
 * 效果面两件(扫描线 overlay / 光标闪烁)为**纯装饰**:节点 `aria-hidden="true"`、
 * 零文本、零可聚焦后代、`pointer-events: none`,缺席不丢失任何信息;全部动画声明
 * 包在 `@media (prefers-reduced-motion: no-preference)` 内(reduce 下装饰
 * `display: none` 且 composed 树零 `animation-name`),动画只动 opacity。
 * (原「终端式标题栏角标」随 `.tab-bar` 退场 —— 类型名已移入视图内左上角。)
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
  HEX_ROW_HEIGHT_PX,
  SIDE_PANEL_MIN_WIDTH_PX,
  VIEW_PANEL_CHROME_HEIGHT_PX,
  VIEW_SLOT_MIN_VISIBLE_HEX_ROWS,
  orderByDefault,
  viewSlotHeightPx,
} from "./layout-presets.js";
import { WorkspaceLayoutModel, type WorkspaceLayoutSnapshot } from "./workspace-model.js";

/** 拖拽启动的位移阈值(px):超过才算拖拽(否则视为激活点击)。 */
const DRAG_THRESHOLD_PX = 3;

/**
 * 视图管理窗口列表项的稳定选择器(`data-view-type` 承载类型键;拖拽落点解析
 * 与列表导航共用)。列表项放在 `renderRoot`(shadow)内,指针事件经
 * `event.composedPath()` 取真实目标(跨 shadow 边界 `event.target` 会被重定向)。
 */
const VIEW_ITEM_SELECTOR = "[data-view-type]";

/**
 * 单个视图位的 `contain-intrinsic-size` 占位高(px):取「chrome + 最小可见行数」
 * 下限 —— 与 `viewSlotHeightPx()` 的下限同式同源,避免进入视口时的布局跳动。
 * **不是布局下限**(压缩机制已整条移除),只是 `content-visibility: auto` 的
 * 占位估算值。
 */
const VIEW_SLOT_INTRINSIC_PX = Math.ceil(
  VIEW_PANEL_CHROME_HEIGHT_PX + VIEW_SLOT_MIN_VISIBLE_HEX_ROWS * HEX_ROW_HEIGHT_PX,
);

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

/**
 * 视图管理窗口列表项拖拽态(D-UI-4:**只保留列表内重排**一种落点语义)。
 * 与原 Niri 三类落点无继承关系 —— 后者随列条带整体废止(它们依赖列结构)。
 */
interface ViewListDrag {
  /** 被拖拽条目的类型键。 */
  readonly type: string;
  readonly startX: number;
  readonly startY: number;
  /** 位移是否已过 `DRAG_THRESHOLD_PX`(未过 = 视为点击,不进入拖拽态)。 */
  moved: boolean;
}

/** 列表内重排落点(目标序号 + 上 / 下半语义;渲染为静态 class,零浮动层)。 */
interface ViewListDropTarget {
  readonly index: number;
  /** true = 插到目标条目**之后**(下半),false = 之前(上半)。 */
  readonly after: boolean;
}

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
  /**
   * 当前已装配的会话客户端(组合根接线判据;null = 未装配)。
   * 用途:区分「从未有过会话」与「会话被卸下」——
   * 前者**不得**清空外部注入的 `dataSource`(见 `#onClientChanged`)。
   */
  #boundClient: SessionClient | null = null;
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

  // 拖拽态(pointer 事件;仅用于**视图管理窗口列表项**的列表内重排,D-UI-4)。
  #viewDrag: ViewListDrag | null = null;
  /** 当前列表落点候选(拖拽中实时更新;渲染为静态 `drop-before` / `drop-after`)。 */
  #viewDropTarget: ViewListDropTarget | null = null;
  /**
   * 焦点滚动去重锚(WP-72 语义保留):`focusWindow()` 自行触发滚动后置位,
   * 使 `updated()` 不重复计算。
   */
  #lastVisibleTabId: string | null = null;
  /** 首帧前建窗 ⇒ 未渲染内容元素的 refresh 延后到首帧之后(WP-71 时序)。 */
  #contentRefreshDeferred = false;

  /**
   * 视图管理 / 键盘切换 / 列表操作的**可宣读反馈**。
   * 承载于**常驻** `role="status"` 状态行:live region 必须预先存在于
   * 无障碍树中才可靠宣读(切换 / 拖拽是瞬时事件,故不做条件渲染)。
   */
  #layoutFeedback: string | null = null;
  /**
   * 上一次视图位高度算式的输入(左半侧可视高,px)—— `updated()` 用它判「测量
   * 补正」是否必要(值变了才补一次渲染,避免渲染循环)。
   */
  #lastSlotInputHeight = 0;
  /**
   * 视图列表的 `aria-live="polite"` 播报文本(D-UI-7 ③:「已显示 / 已隐藏 /
   * 已移动到第 N 位」)。与上者分面:上者宣读切换 / 拖拽落点,本面宣读**勾选
   * 与列表内移动的结果**;仿既有修法,不用 `role="log"`(M1 已登记的 axe 违规)。
   */
  #viewListAnnouncement = "";

  /** i18n:连接时消费 data-sm-language 锚;locale 变化即重渲染(WP-53)。 */
  readonly #i18n = new LocaleController(this);
  /** theme 属性是否写过自身锚(null 归位时只清理自身写入面)。 */
  #themeAnchorWritten = false;

  static override styles = css`
    /* ── 整页布局(FE-WS-01 / D-UI-1)────────────────────────────────────────
       工作区 = 页面主体:自身即视口高(100dvh),**不依赖宿主 / 壳给出高度**,
       内层滚动**不上浮到文档层**。
       ① 自身不设 min-block-size 固定高(原 24rem 随「压缩以适配」一并退场);
       ② 无 border / 无 border-radius / 无 gap / 无 divider(「无边框、紧密贴合的
          矩形」;outline 不用作装饰,只在 :focus-visible 出现);
       ③ 100dvh 优先、100% 兜底(宿主给出定高链时 100% 生效;无链时 dvh 生效)。 */
    :host {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      block-size: 100dvh;
      block-size: 100%;
      min-block-size: 0;
      /* 扫描线 overlay 的定位锚(纯装饰层 inset:0;既有绝对定位后代各有自身
         定位锚:sm-window-list 宿主 position:relative、Blockly .injectionDiv
         position:relative ⇒ 零布局影响)。 */
      position: relative;
      background: var(--sm-bg-base, #0b0f0b);
      color: var(--sm-fg, #b9ffc4);
      /* ⚠ **刻意不设 overflow**:窄屏(D-UI-5:两半侧各保底 452.4px)下网格
         宽于视口,若此处 overflow: hidden 会把右半侧裁掉且**页面不出现横向
         滚动条**(右半侧不可达)。纵向由 block-size: 100dvh + 内层
         minmax(0, 1fr) 约束(内层滚动承载溢出),故无需 overflow 兜底。 */
    }

    /* 左右两分(固定 1:1;D-UI-1:不可调、无分界拖拽手柄)。
       **两侧同底线**(minmax(SIDE_PANEL_MIN_WIDTH_PX, 1fr)):
       视口足够宽时两列等分(1:1);窄屏时各列保底 452.4px(D-UI-5:左半侧宽
       底线改挂载体)⇒ **页面横向滚动**(形态不改变;否决隐藏右半侧 / 上下堆叠)。
       无 gap、无 border(「无边框、紧密贴合的矩形」)。
       overflow: visible 是 D-UI-5 的承载条件(见 :host 的说明)。 */
    .ws-body {
      display: grid;
      grid-template-columns: repeat(2, minmax(${SIDE_PANEL_MIN_WIDTH_PX}px, 1fr));
      min-block-size: 0;
      overflow: visible;
    }

    /* 左半侧 = 视图管理窗口:列表按钮在上(自适应高),视图位滚动区在下。
       min-inline-size = D-UI-5 的左半侧宽度底线(452.4px);窄屏时右半侧被
       挤到视口之外 ⇒ **页面横向滚动**(形态不改变:否决隐藏右半侧 / 上下堆叠)。 */
    .ws-left {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      min-inline-size: ${SIDE_PANEL_MIN_WIDTH_PX}px;
      min-block-size: 0;
      overflow: hidden;
      background: var(--sm-bg-panel, #101610);
    }

    /* 右半侧 = payload 搭建窗口(固定;不随左侧滚动移动)。 */
    .ws-right {
      display: grid;
      grid-template-rows: minmax(0, 1fr);
      min-block-size: 0;
      min-inline-size: 0;
      overflow: hidden;
      background: var(--sm-bg-base, #0b0f0b);
    }

    /* 视图管理窗口的列表按钮:可展开 / 收起(<details> 天然可聚焦,零 JS
       展开状态;条目自绘 —— 勾选用原生 input,排序用 Alt+↑/↓ 与 pointer 拖拽)。 */
    .view-list-button {
      border-block-end: 1px solid var(--sm-divider, rgb(125 255 156 / 16%));
      font-size: 0.8125rem;
    }

    .view-list-button > summary {
      padding: 0.25rem 0.5rem;
      color: var(--sm-fg-dim, #6dd47f);
      cursor: pointer;
      font-size: 0.8125rem;
    }

    .view-list-button > summary:focus-visible {
      outline: 2px solid var(--sm-focus-ring, #a9ffb8);
      outline-offset: -2px;
    }

    .view-list {
      margin: 0;
      padding: 0 0 0.25rem;
      list-style: none;
      display: grid;
      gap: 0;
    }

    .view-list-item {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.125rem 0.5rem;
      font-size: 0.8125rem;
      cursor: grab;
      touch-action: none;
    }

    .view-list-item:focus-visible {
      outline: 2px solid var(--sm-focus-ring, #a9ffb8);
      outline-offset: -2px;
    }

    /* 拖拽反馈:静态 class(不做动画);落点指示 = 既有边框族的静态上 / 下边线。 */
    .view-list-item.dragging {
      opacity: 0.5;
    }

    .view-list-item.drop-before {
      box-shadow: inset 0 2px 0 var(--sm-warn, #ffc857);
    }

    .view-list-item.drop-after {
      box-shadow: inset 0 -2px 0 var(--sm-warn, #ffc857);
    }

    .view-list-order {
      color: var(--sm-fg-dim, #6dd47f);
      font-variant-numeric: tabular-nums;
    }

    /* 视图位滚动区(左半侧;纵向堆叠 —— 任一时刻可见两个视图位,超出者滚动)。 */
    .ws-stack {
      display: grid;
      grid-auto-rows: auto;
      align-content: start;
      gap: 0.5rem;
      margin-block: 0.5rem;
      padding: 0;
      min-block-size: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      /* 丝滑滚动动画(FE-WS-09):需求要求滚动带丝滑动画 ⇒ 由本容器承担;
         reduce 动效偏好下退化为 auto(见下)。 */
      scroll-behavior: smooth;
    }

    @media (prefers-reduced-motion: reduce) {
      .ws-stack {
        scroll-behavior: auto;
      }
    }

    /* 单个视图位:无边框、无圆角、与相邻视图位仅由几何贴合(无间隙 / 无描边 /
       无分隔条)。高度由 TS 按 viewSlotHeightPx() 内联为像素 ⇒ **确定高度**
       (可读性载体)⇒ **不出现「视图被压到装不下一行字节」**;空间不足时多余的
       部分由 .ws-stack 纵向滚动承载(**只滚动、不压缩**)。 */
    .ws-view {
      display: flex;
      flex-direction: column;
      min-block-size: 0;
      overflow: hidden;
      background: var(--sm-bg-base, #0b0f0b);
      /* 视口外降级渲染(保留):离屏子树跳过渲染与绘制;语义标记
         data-render-degrade="content-visibility"(结构断言面)。
         contain-intrinsic-size 取下限占位(auto 关键字记住上次尺寸),
         避免进入视口时的布局跳动。零新增依赖、零浮动层、零 JS 观察者。 */
      content-visibility: auto;
      contain-intrinsic-size: auto ${VIEW_SLOT_INTRINSIC_PX}px;
    }

    /* 焦点视图位:仅以 view-label 前景色区分(**不画边框** —— 无描边硬约束)。 */
    .ws-view.focused .view-label {
      color: var(--sm-warn, #ffc857);
    }

    /* 视图类型名写在视图内左上角(FE-WS-11):**不是独立标题栏**(无边框、无背景
       条、零控件、不承载交互);它是面板内第一个元素,故**不遮挡内容**。 */
    .view-label {
      display: block;
      flex: 0 0 auto;
      padding: 0.125rem 0.5rem;
      color: var(--sm-fg-dim, #6dd47f);
      font-size: 0.8125rem;
      font-weight: 600;
    }

    .ws-view-slot {
      display: grid;
      min-block-size: 0;
    }

    .tab-content {
      flex: 1;
      min-block-size: 0;
      display: flex;
      flex-direction: column;
      /* **视图位胜出**(可读性纪律的承载条件):内容超出时由**视图位裁剪**
         (「.ws-view」 的 「overflow: hidden」),而不是在视图位内部再生一个滚动条 ——
         内层滚动会把「字节视图内容盒下限」的语义抵消掉(真机实测:内层滚动下
         768 宽档的字节数据行只剩 1 行)。 */
      overflow: visible;
    }

    .tab-content > * {
      flex: 1;
    }

    .tab-placeholder {
      margin: 0;
      padding: 1rem;
      color: var(--sm-fg-dim, #6dd47f);
      font-size: 0.875rem;
    }

    .jump-feedback {
      margin: 0;
      padding: 0.25rem 0.75rem;
      color: var(--sm-fg-dim, #6dd47f);
      font-size: 0.8125rem;
      border-block-end: 1px solid var(--sm-divider, rgb(125 255 156 / 16%));
    }

    /* 视图切换 / 列表操作状态行:常驻 role=status 的 live region。 */
    .layout-status {
      margin: 0;
      padding: 0.25rem 0.75rem;
      color: var(--sm-fg-dim, #6dd47f);
      font-size: 0.8125rem;
      min-block-size: 1.1em;
      border-block-end: 1px solid var(--sm-divider, rgb(125 255 156 / 16%));
    }

    /* 调试档状态行(F8):切换 / attach / 暂停反馈(降级文案明示)。 */
    .debug-feedback {
      margin: 0;
      padding: 0.25rem 0.75rem;
      color: var(--sm-fg, #b9ffc4);
      font-size: 0.8125rem;
      background: color-mix(in srgb, var(--sm-bg-inset, #070907) 94%, var(--sm-focus-ring, #a9ffb8) 6%);
      border-block-end: 1px solid var(--sm-divider, rgb(125 255 156 / 16%));
    }

    /* 教学面板(F8 ED 挂接,取简 = details 折叠区):提示 ladder + 错误解释。 */
    .teaching-panel {
      border-block-end: 1px solid var(--sm-divider, rgb(125 255 156 / 16%));
      font-size: 0.8125rem;
    }

    .teaching-panel > summary {
      padding: 0.25rem 0.75rem;
      color: var(--sm-fg-dim, #6dd47f);
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
      border-block-end: 1px solid var(--sm-divider, rgb(125 255 156 / 16%));
      font-size: 0.8125rem;
    }

    .challenge-panel > summary {
      padding: 0.25rem 0.75rem;
      color: var(--sm-fg-dim, #6dd47f);
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
      color: var(--sm-fg-dim, #6dd47f);
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
      border: 1px solid var(--sm-divider-faint, rgb(125 255 156 / 12%));
      text-align: left;
    }

    .challenge-absent {
      margin: 0;
      padding: 0.25rem 0.75rem 0.5rem;
      color: var(--sm-fg-dim, #6dd47f);
    }

    /* 正式裁决横幅(阶段六 WP-63;零视觉重设计:复用横幅式样的取简变体)。 */
    .verdict-banner {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem 0.75rem;
      margin: 0;
      padding: 0.375rem 0.75rem;
      background: color-mix(in srgb, var(--sm-bg-inset, #070907) 92%, var(--sm-warn, #ffc857) 8%);
      border-block-end: 1px solid var(--sm-divider, rgb(125 255 156 / 16%));
      font-size: 0.8125rem;
    }

    .verdict-banner strong {
      color: var(--sm-fg, #b9ffc4);
    }

    .verdict-banner .verdict-state {
      color: var(--sm-fg, #b9ffc4);
      font-weight: 600;
    }

    .verdict-banner.unavailable {
      background: color-mix(in srgb, var(--sm-warn, #ffc857) 8%, var(--sm-bg-base, #0b0f0b));
    }

    .verdict-banner button {
      padding: 0.125rem 0.5rem;
      border: 1px solid var(--sm-border-button, rgb(125 255 156 / 34%));
      border-radius: 6px;
      background: var(--sm-bg-base, #0b0f0b);
      color: var(--sm-fg, #b9ffc4);
      font: inherit;
      cursor: pointer;
    }

    /* ── 效果面(WP-74;契约 C1~C9 见 e2e/helpers/decoration.ts 文件头)─────
       装饰全为**纯装饰**:节点 aria-hidden="true"(伪元素天然不入无障碍
       树)、零文本、零可聚焦后代、pointer-events: none;动画只动 opacity;
       缺席不丢失任何信息。参数一律取自 effect token,零新增 token:
       扫描线强度 = --sm-scanline-opacity(单主题恒 0.06),
       光标周期 = --sm-caret-blink(单主题恒 1.1s)。全部动画声明包在
       @media (prefers-reduced-motion: no-preference) 内;reduce 下装饰
       display: none(C8)且 composed 树零 non-none 动画(C9)。
       (原「终端式标题栏角标」随 .tab-bar 退场 —— 类型名已移入视图内左上角。) */

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
        var(--sm-fg, #b9ffc4) 0,
        var(--sm-fg, #b9ffc4) 1px,
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
      background: var(--sm-fg, #b9ffc4);
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
    // **视图位高度的测量补正**(2026-09-18 真机取证):`render()` 里读的是
    // **上一帧**的几何,而首帧的 `.ws-left` 在渲染前不存在 ⇒ 首帧只能用
    // `window.innerHeight` 估算。若此后测得的左半侧可视高与上一次算式输入不同,
    // 必须补一次渲染把视图位高度改到正确值(否则视位高会永远停在首帧估算值上)。
    const measured = this.#measureLeftRole().height;
    if (measured > 0 && measured !== this.#lastSlotInputHeight) {
      this.#lastSlotInputHeight = measured;
      this.requestUpdate();
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // LocaleController 经构造副作用注册(Lit addController);显式读点满足 lint。
    void this.#i18n;
    // 主题锚样式表(幂等)+ 独立使用形态的 theme 属性转写(最近锚优先)。
    ensureSmThemeStyles(this.ownerDocument ?? document);
    this.#syncThemeAnchor();
    // 视图集绑定(D-MP-1 不修订:登记集合各恰一实例、常驻;首帧前绑定)。
    this.#bindWindows();
    // 视图位高度的测量驱动 = 自身与 window 的尺寸变化(零 ResizeObserver:
    // 需求未要求,且本组件的容器链由宿主定高链承担)。
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

  /**
   * 独立使用形态:theme 属性 → 自身 `data-sm-theme`(D-UI-6:值域收敛为
   * **终端单值** ⇒ 本属性只剩 `"terminal"` 一个合法值,写锚即终端;
   * 归位 null 时只清理自身写入的锚,不动外部直接设置的锚)。
   */
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

  /**
   * 左半侧实际宽度(px;0 = 未知)—— D-UI-5 的 `SIDE_PANEL_MIN_WIDTH_PX`
   * 底线核对面(取代已废止的「视口宽」语义)。
   */
  get leftRoleWidth(): number {
    return this.#model.leftRoleWidth;
  }

  /** `Ctrl + ↑/↓` 当前切换落点(可见视图类型;无落点为 null;诊断 / 断言面)。 */
  get activeViewType(): string | null {
    return this.#model.activeType;
  }

  /**
   * 视图集绑定(D-MP-1 固定窗口集,**本版按新模型**)——
   *
   *  - 每种登记类型恰一实例(视图 id ≡ 类型键;单实例为结构性保证);
   *  - **顺序 = `layout-presets.ts` 的 `DEFAULT_VIEW_ORDER`**(默认顺序的唯一
   *    来源,经 `orderByDefault` 单点注入)——本文件不持有任何默认顺序字面量;
   *  - **可见性初始全选**(勾选态属于用户调整;`tabTypes` 换绑即重绑);
   *  - 内容元素按各描述项 `createContent` 产出(字节视图注入行装饰挂点;
   *    声明 `actionSink` 的内容按 duck-typing 注入会话客户端);
   *  - 触发点 = 工作区接入(connectedCallback,首帧前)+ `tabTypes` 换绑;
   *    **与「接入会话」无关**——视图集是结构,数据面由 `dataSource` 换绑注入
   *    (解题 ↔ 调试模式切换只换数据源,布局零副作用)。
   */
  #bindWindows(): void {
    this.#boundTabTypes = this.tabTypes;
    const descriptors = this.tabTypes.list();
    this.#contents.clear();
    this.#model.bindWindows(
      descriptors.map((descriptor) => ({
        type: descriptor.type,
        // 展示名:i18n 键优先(WP-53),按**绑定时刻** locale 求值固化
        // (视图类型名不随语言切换追溯——WP-F5 登记口径保留)。
        label: descriptor.labelKey !== undefined ? t(descriptor.labelKey) : descriptor.label,
      })),
      orderByDefault(descriptors.map((descriptor) => descriptor.type)),
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
   * 聚焦指定类型视图(D-MP-1 三类管理动作之「聚焦导航」):聚焦 + 滚动到该视图
   * (菜单「视图」组的既有语义);未登记类型返回 false(不改变布局与焦点)。
   * 视图集常驻,本方法**不创建实例**——实例数在绑定后恒定。
   */
  focusWindow(type: string): boolean {
    if (!this.#model.focusWindow(type)) {
      return false;
    }
    // 焦点滚动由本方法独占触发(置 `#lastVisibleTabId` 让 `updated()` 不重复触发)。
    this.#lastVisibleTabId = type;
    this.ensureTabVisible(type);
    this.requestUpdate();
    return true;
  }

  /** 激活视图(焦点跟随;不存在的 id 为 no-op)。 */
  activateTab(tabId: string): void {
    this.#model.activateTab(tabId);
    this.requestUpdate();
  }

  /**
   * 使视图位可达(**取代原「相机 + 列间水平滚动」**):滚到最近边
   * (`scrollIntoView({block:"nearest"})`;左半侧纵向滚动作 carriers 承载溢出)。
   * 不可见视图(未勾选)无 DOM 面板 ⇒ 静默;jsdom 无布局环境亦静默。
   */
  ensureTabVisible(tabId: string): void {
    const panel = this.#panelOf(tabId);
    if (panel === null || typeof panel.scrollIntoView !== "function") {
      return;
    }
    try {
      panel.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch {
      // 无布局环境(jsdom):滚动增强失败静默,不影响可达性语义。
    }
  }

  // ── 视图管理动作(勾选 / 排序 / 重置视图;唯一入口 = 左半侧列表按钮)────────

  /**
   * 设置视图可见性(左半侧列表按钮的「勾选」;**唯一入口**,D-UI-7 补充裁定
   * 明确菜单「视图」组**不承载勾选 / 排序**)。返回是否发生变化。
   *
   * 语义纪律(D-MP-1 不修订):未勾选 = **不显示** = 「暂离」的第二种成因
   * (第一种仍是滚出可视区),**不是「关闭」** —— 视图仍全部常驻。
   * 播报经 `aria-live="polite"`(D-UI-7 ③)。
   */
  setViewVisible(type: string, visible: boolean): boolean {
    const title = this.#model.view(type)?.title ?? type;
    if (!this.#model.setViewVisible(type, visible)) {
      return false;
    }
    this.#viewListAnnouncement = t(
      visible ? "workspace.viewShown" : "workspace.viewHidden",
      { title },
    );
    this.requestUpdate();
    return true;
  }

  /**
   * 列表内重排(视图管理窗口的**拖拽排序**;D-UI-4:只保留这一种落点语义)。
   * 播报「已移动到第 N 位」(D-UI-7 ③)。返回是否发生变化。
   */
  moveView(type: string, targetIndex: number): boolean {
    if (!this.#model.moveView(type, targetIndex)) {
      return false;
    }
    const title = this.#model.view(type)?.title ?? type;
    const position = (this.#model.indexOfView(type) ?? 0) + 1;
    this.#viewListAnnouncement = t("workspace.viewMoved", { title, index: position, count: position });
    this.requestUpdate();
    return true;
  }

  /**
   * **重置视图**(取代已废止的「重置布局」):恢复默认顺序 + 全选(全部可见)。
   * 焦点与 `Ctrl + ↑/↓` 落点复位;**视图集不变**(D-MP-1)。
   */
  resetViews(): void {
    this.#model.resetViews();
    this.#layoutFeedback = t("workspace.viewResetDone");
    this.requestUpdate();
  }

  /**
   * 左半侧尺寸测量(视图位高度的算式输入):
   *  - `leftRoleHeight`:左半侧实际高(`.ws-left` 的 `clientHeight`);无布局环境
   *    回落到 `window.innerHeight`(整页布局下两者语义一致 —— 工作区占满视口);
   *  - `leftRoleWidth`:左半侧实际宽(D-UI-5 底线核对面)。
   * 无布局环境(jsdom)`clientHeight` = 0 ⇒ 高度回落 `innerHeight`(jsdom 缺省
   * 768),故 `viewSlotHeightPx()` 在两种环境下都给出有限确定值,不抛错。
   */
  #measureLeftRole(): { readonly height: number; readonly width: number } {
    const element = this.renderRoot.querySelector(".ws-left");
    const measuredWidth = element instanceof HTMLElement ? element.clientWidth : 0;
    const measuredHeight = element instanceof HTMLElement ? element.clientHeight : 0;
    const view = this.ownerDocument?.defaultView ?? null;
    const fallbackWidth = view?.innerWidth ?? 0;
    const fallbackHeight = view?.innerHeight ?? 0;
    const ownWidth = Number.isFinite(measuredWidth) && measuredWidth > 0 ? measuredWidth : fallbackWidth;
    // 整页布局:左半侧高 ≈ 页面可视高 − 菜单 / 状态行等顶部面(无法在 jsdom 测量
    // 时以 `innerHeight` 作上界估算;真机读数由 WP-95 几何断言给出)。
    const ownHeight = Number.isFinite(measuredHeight) && measuredHeight > 0 ? measuredHeight : fallbackHeight;
    return {
      width: Number.isFinite(ownWidth) && ownWidth > 0 ? ownWidth : 0,
      height: Number.isFinite(ownHeight) && ownHeight > 0 ? ownHeight : 0,
    };
  }

  /**
   * 尺寸变化驱动:重测左半侧宽 / 高并刷新视图位高度。
   * **本版无任何「跨档重绑」语义** —— 窄屏形态不改变(D-UI-5:左半侧
   * `min-width` 底线 + 页面横向滚动),故 resize 只更新测量值与快照面。
   */
  #syncViewportLayout(): void {
    const { width } = this.#measureLeftRole();
    this.#model.setLeftRoleWidth(width);
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
      // ⚠ 既有缺陷修复(2026-09-18 改版真机几何取证暴露):`client` 的**首次**
      // 变更(初始 null → 仍为 null,无会话形态)也会走到这里,而此处原先无条件
      // `this.dataSource = null` ⇒ **把外部注入的 dataSource 抹掉**。公开 API
      // 文档明确"数据源直接注入(测试 / 无 client 装配;client 换绑时被组合根
      // 装配覆盖)"⇒ 仅在**确实卸下过已装配的 client 接线**时才清空数据源。
      if (this.#boundClient !== null) {
        this.dataSource = null;
        this.#boundClient = null;
      }
      return;
    }
    this.#boundClient = client;
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
    // 固定窗口集(D-MP-1):内容元素**实例恒定**(payload 状态跨模式 / 跨渲染保留;
    // FE-WS-07 的 `#contents` 生命周期约定),重绑只换数据面属性、**不重建元素**。
    for (const content of this.#contents.values()) {
      const bindable = content as { dataSource?: MemoryDataSource | null };
      if ("dataSource" in content) {
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
        // D-MP-1 聚焦导航:菜单「视图」分组 = 聚焦 + 滚动到该视图(D-UI-7 补充
        // 裁定:本组只承载**聚焦导航**,不承载勾选 / 排序 —— 后者唯一入口 =
        // 左半侧列表按钮)。视图集常驻,不存在开 / 关语义。
        this.focusWindow(action.windowType);
        break;
      case "reset-views":
        // 「重置视图」= 恢复默认顺序 + 全选(**取代**已废止的「重置布局」)。
        this.resetViews();
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

  // ── 视图管理窗口的列表(pointer 拖拽排序 + 键盘等价路径)────────────────────

  /** 列表项按下(拖拽把手 = 条目自身;零浮动层、零额外控件)。 */
  #onViewItemPointerDown(event: PointerEvent, type: string): void {
    this.#viewDrag = { type, startX: event.clientX, startY: event.clientY, moved: false };
  }

  readonly #onPointerMove = (event: PointerEvent): void => {
    const drag = this.#viewDrag;
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
      this.#viewItemElement(drag.type)?.classList.add("dragging");
    }
    // 拖拽中实时解析列表内落点(D-UI-4:只此一种落点语义)。
    this.#updateViewDropTarget(event);
  };

  readonly #onPointerUp = (): void => {
    const drag = this.#viewDrag;
    const target = this.#viewDropTarget;
    this.#cancelViewDrag();
    if (drag === null || !drag.moved) {
      return; // 位移未过阈值 = 点击(列表项无激活语义,零副作用)。
    }
    if (target === null) {
      // 落点在列表之外:不移动,状态行明示(与旧 Niri 落点口径同精神)。
      this.#viewListAnnouncement = t("workspace.viewDropOutside");
      this.requestUpdate();
      return;
    }
    const from = this.#model.indexOfView(drag.type);
    if (from === null) {
      return;
    }
    // 落点语义:目标条目上 / 下半 ⇒ 插到其前 / 后;「先摘除再插入」的位序修正
    // 与 `moveView` 的夹取语义一致(源条目在目标之前则目标序号减一)。
    const raw = target.index + (target.after ? 1 : 0);
    this.moveView(drag.type, from < raw ? raw - 1 : raw);
  };

  readonly #onPointerCancel = (): void => {
    this.#cancelViewDrag();
  };

  #cancelViewDrag(): void {
    const drag = this.#viewDrag;
    this.#viewDrag = null;
    this.#viewDropTarget = null;
    if (drag !== null) {
      this.#viewItemElement(drag.type)?.classList.remove("dragging");
    }
    this.requestUpdate();
  }

  #viewItemElement(type: string): Element | null {
    return this.renderRoot.querySelector(`[data-view-type="${type}"]`);
  }

  /** 列表内落点候选实时更新(静态 class 指示;拖拽未过阈值时不解析)。 */
  #updateViewDropTarget(event: PointerEvent): void {
    const target = this.#resolveViewDropTarget(event);
    const previous = this.#viewDropTarget;
    if (target === null) {
      this.#viewDropTarget = null;
      if (previous !== null) {
        this.requestUpdate();
      }
      return;
    }
    this.#viewDropTarget = target;
    const changed = previous === null || previous.index !== target.index || previous.after !== target.after;
    if (changed) {
      this.requestUpdate();
    }
  }

  /**
   * 指针落点 → **列表内重排**目标(D-UI-4:只保留这一种落点语义)。
   * 落点在列表项上 / 下半 = 插到其前 / 后;列表之外 → null(不移动)。
   * 跨 shadow 边界取真实目标:`event.composedPath()`(pointer 事件的
   * `event.target` 会被重定向到宿主)。
   */
  #resolveViewDropTarget(event: PointerEvent): ViewListDropTarget | null {
    const item = this.#composedViewItem(event);
    if (item === null) {
      return null;
    }
    const index = Number(item.getAttribute("data-view-index"));
    if (!Number.isFinite(index)) {
      return null;
    }
    const rect = item.getBoundingClientRect();
    const after = event.clientY >= rect.top + rect.height / 2;
    return { index, after };
  }

  /** 指针事件路径上的列表项(跨 shadow 重定向免疫)。 */
  #composedViewItem(event: PointerEvent): Element | null {
    for (const node of event.composedPath()) {
      if (node instanceof Element && node.matches(VIEW_ITEM_SELECTOR)) {
        return node;
      }
    }
    return null;
  }

  // ── `Ctrl + ↑ / ↓` 视图切换(D-UI-3)与列表键盘等价路径(D-UI-4)──────────

  /**
   * 左半侧键盘面:
   *  - **`Ctrl + ArrowUp` / `Ctrl + ArrowDown`**(D-UI-3):在**左半侧容器**上
   *    捕获并 `preventDefault()`(覆盖浏览器页面滚动默认)⇒ 切换一个可见视图位、
   *    **边界不环绕**;当前视图名经常驻 `role="status"` 宣读(不只是视觉);
   *  - **`Alt + ArrowUp` / `Alt + ArrowDown`**(D-UI-4 键盘等价路径)在列表项上
   *    处理(见 `#onViewItemKeyDown`),此处不介入。
   */
  #onLeftRoleKeyDown(event: KeyboardEvent): void {
    if (!event.ctrlKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) {
      return;
    }
    event.preventDefault();
    const moved = this.#model.stepActiveView(event.key === "ArrowUp" ? -1 : 1, (type) =>
      this.#isLeftRoleView(type),
    );
    const active = this.#model.activeType;
    this.#layoutFeedback = t("workspace.viewSwitchCurrent", {
      title: active === null ? t("workspace.viewNone") : (this.#model.view(active)?.title ?? active),
    });
    if (moved && active !== null) {
      this.ensureTabVisible(active);
    }
    this.requestUpdate();
  }

  /**
   * 该类型是否是**左半侧的视图位**(切换域判据):payload 固定承载于右半侧
   * (D-UI-1 / 需求原文),故不在 `Ctrl + ↑/↓` 的序列内 —— 否则切换会停在
   * 「左半侧没有对应视图位」的视图上(看起来无反应)。
   */
  #isLeftRoleView(type: string): boolean {
    return type !== this.#payloadViewType();
  }

  /** 列表项键盘等价路径:`Alt + ↑ / ↓` 在列表内上下移动该条目(D-UI-4)。 */
  #onViewItemKeyDown(event: KeyboardEvent, type: string): void {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) {
      return;
    }
    const from = this.#model.indexOfView(type);
    if (from === null) {
      return;
    }
    event.preventDefault();
    this.moveView(type, from + (event.key === "ArrowUp" ? -1 : 1));
  }

  #panelOf(tabId: string): Element | null {
    return this.renderRoot.querySelector(`[data-view-panel="${tabId}"]`);
  }

  // ── 渲染 ─────────────────────────────────────────────────────────────────

  /**
   * 整页布局渲染(FE-WS-01 / D-UI-1 ~ D-UI-7):
   *
   * ```
   * :host(grid: auto / 1fr, block-size: 100dvh)
   *   ├─ sm-workspace-menu        (顶部菜单,常驻)
   *   ├─ 横幅 / 状态行 / 教学面   (既有呈现面,零语义变化)
   *   └─ .ws-body(grid: 1fr 1fr,无 gap / 无 border)
   *        ├─ .ws-left(视图管理窗口)
   *        │    ├─ <details class="view-list-button"> 勾选 + 拖拽排序(唯一入口)
   *        │    └─ .ws-stack(overflow-y: auto + scroll-behavior: smooth)
   *        │         └─ .ws-view[data-view-panel] × 可见视图(纵向堆叠)
   *        └─ .ws-right(payload 搭建窗口;固定,不随左侧滚动)
   *             └─ payload 内容元素(**同一实例**,FE-WS-07)
   * ```
   *
   * **纪律**:左右两分是 `1fr 1fr` 固定比例(D-UI-1:不可调、无分界拖拽手柄);
   * 视图位高度由 `viewSlotHeightPx()` 内联为像素 ⇒ **确定高度**、**只滚动不压缩**
   * (D-UI-2 / FE-WS-15)。
   */
  protected override render(): unknown {
    const snapshot = this.#model.snapshot;
    const descriptor = this.challengeDescriptor;
    const payloadType = this.#payloadViewType();
    /**
     * **左半侧可见视图位**(= 可见视图 **− payload**):
     * payload 搭建窗口是右半侧的**固定**呈现位(D-UI-1 / 需求原文「右半侧 = payload
     * 搭建窗口(固定)」)⇒ 左半侧不再渲染第二个同名面板 —— 否则会同时产生
     * 「同一内容元素被两处 ChildPart 争夺(后提交者赢得节点,左半侧留空面板)」与
     * 「两处同名地标(axe `landmark-unique` 违规)」两个缺陷(D-UI-7 ①:地标名不得
     * 重复)。**模型层仍登记 payload**(`visible` 标志保留、列表按钮仍可勾选)——
     * D-MP-1「视图全部常驻」不受影响,改变的只是「payload 呈现在哪半侧」。
     */
    const visible = snapshot.views.filter(
      (view) => view.visible && view.type !== payloadType,
    );
    const payloadContent = payloadType === null ? null : (this.#contents.get(payloadType) ?? null);
    const slotHeight = viewSlotHeightPx(this.#measureLeftRole().height);
    const activeType = snapshot.activeType;
    return html`
      <div
        class="sm-scanline"
        part="scanline"
        data-sm-decoration="scanline"
        aria-hidden="true"
      ></div>
      <sm-workspace-menu
        .tabTypes=${this.tabTypes.list()}
        .focusedWindowType=${snapshot.focusedType}
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
      <p
        class="layout-status"
        role="status"
        data-layout-feedback
        data-active-view=${activeType ?? nothing}
      >${this.#layoutFeedback ?? ""}</p>
      <div
        class="ws-body"
        data-workspace-body
        @viewport-jump=${this.#onViewportJump}
        @highlight-jump=${this.#onHighlightJump}
        @breakpoints-changed=${this.#onBreakpointsChanged}
        @payload-breakpoints-changed=${this.#onPayloadBreakpointsChanged}
        @payload-client-pause=${this.#onPayloadClientPause}
      >
        <!-- 事件挂点纪律(2026-09-18 改版):workspace 级监听一律挂**共同祖先**
             .ws-body,不挂 .ws-left —— payload 的内容元素固定在右半侧
             (.ws-left 的**兄弟**),DOM 冒泡只沿祖先链 ⇒ 挂在左半侧的
             payload 监听会变成死监听(payload-breakpoints-changed /
             payload-client-pause 回归)。@keydown 例外:它必须落在**左半侧
             容器**上(D-UI-3 明确「作用域 = 左半侧,避免与 payload 画布冲突」)。 -->
        <section
          class="ws-left"
          data-view-role="left"
          aria-label=${t("workspace.viewManagerAria")}
          @keydown=${this.#onLeftRoleKeyDown}
        >
          ${this.#renderViewListButton(snapshot)}
          <div class="ws-stack" data-view-stack>
            ${visible.map((view) =>
              this.#renderPanel(view.type, view.title, slotHeight, view.type === snapshot.focusedType),
            )}
          </div>
        </section>
        <section
          class="ws-right"
          data-view-role="right"
          aria-label=${payloadType === null
            ? t("common.noContentNote")
            : (this.#viewTitle(payloadType) ?? t("common.noContentNote"))}
        >
          ${payloadContent ??
          html`<p class="tab-placeholder" role="status">${t("common.noContentNote")}</p>`}
        </section>
      </div>
      <p class="view-list-status" aria-live="polite" data-view-list-status>
        ${this.#viewListAnnouncement}
      </p>
    `;
  }

  /**
   * payload 视图类型(**固定承载于右半侧**的那个视图位;D-UI-1 / 需求原文
   * 「右半侧 = payload 搭建窗口(固定)」):
   *  - 注册表声明了 `PAYLOAD_TAB_TYPE` ⇒ 就是它;
   *  - 否则(宿主用自定义注册表、改过类型键)⇒ 缺省注册表的类型键里挑一个
   *    存在的;再退化为**序首**(保证右半侧恒有内容位,不出现空半侧)。
   */
  #payloadViewType(): string | null {
    if (this.tabTypes.has(PAYLOAD_TAB_TYPE)) {
      return PAYLOAD_TAB_TYPE;
    }
    const registered = this.#model.orderedViews().map((view) => view.type);
    if (registered.length === 0) {
      return null;
    }
    const declared = this.tabTypes.list().find((descriptor) => descriptor.type === PAYLOAD_TAB_TYPE);
    return declared?.type ?? registered[0] ?? null;
  }

  /** 视图展示名(绑定时刻固化的 title;状态行 / 地标名共用)。 */
  #viewTitle(type: string): string | null {
    return this.#model.view(type)?.title ?? this.#tabTypeDescriptor(type)?.label ?? null;
  }

  /**
   * 视图管理窗口的列表按钮(可展开 / 收起;D-UI-7 补充裁定的**唯一入口**:
   * 勾选 + 拖拽排序)。用 `<details>` + `<summary>`:展开 / 收起天然可聚焦
   * (`aria-expanded` 语义由 `<details>` 原生承担)、零 JS 展开状态;勾选与拖拽
   * 必须自绘(原生 `<details>` 不提供)—— 勾选用**原生 `<input type="checkbox">`
   * 包在 `<label>` 里(无障碍最稳,`Space` 原生可用),排序用 pointer 拖拽 +
   * `Alt + ↑ / ↓` 键盘等价路径。
   */
  #renderViewListButton(snapshot: WorkspaceLayoutSnapshot): unknown {
    return html`
      <details class="view-list-button" part="view-list-button">
        <summary>${t("workspace.viewListToggle")}</summary>
        <ul class="view-list" aria-label=${t("workspace.viewListAria")}>
          ${snapshot.views.map((view, index) => this.#renderViewListItem(view, index))}
        </ul>
      </details>
    `;
  }

  /**
   * 单个列表条目:序号 + 勾选框(原生 input)+ 视图类型名。
   *
   * 键盘等价路径(D-UI-4 / D-UI-7 ③):条目可聚焦(`tabindex="0"`),
   * `Space` 切换勾选(原生 input 自带),`Alt + ↑ / ↓` 在列表内上下移动该条目;
   * 焦点顺序 = 视觉顺序(渲染顺序即 DOM 顺序)。
   */
  #renderViewListItem(view: WorkspaceLayoutSnapshot["views"][number], index: number): unknown {
    const drop = this.#viewDropTarget;
    const dropClass =
      drop !== null && drop.index === index ? (drop.after ? " drop-after" : " drop-before") : "";
    const dragging = this.#viewDrag?.type === view.type && this.#viewDrag.moved ? " dragging" : "";
    const checkboxId = `sm-view-visible-${view.type}`;
    return html`
      <li
        class="view-list-item${dropClass}${dragging}"
        data-view-type=${view.type}
        data-view-index=${index}
        tabindex="0"
        @pointerdown=${(event: PointerEvent) => this.#onViewItemPointerDown(event, view.type)}
        @keydown=${(event: KeyboardEvent) => this.#onViewItemKeyDown(event, view.type)}
      >
        <span class="view-list-order" aria-hidden="true">${index + 1}</span>
        <input
          id=${checkboxId}
          type="checkbox"
          class="view-list-checkbox"
          .checked=${view.visible}
          data-view-visible=${view.type}
          @change=${(event: Event) => {
            this.setViewVisible(view.type, (event.target as HTMLInputElement).checked);
          }}
        />
        <label class="view-list-label" for=${checkboxId}>${view.title}</label>
      </li>
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
   * 单个视图位渲染:
   *  - `data-view-panel` = 面板身份锚(滚动定位 / 测试断言面);
   *  - `data-render-degrade="content-visibility"` = 视口外降级渲染语义标记
   *    (样式侧 `content-visibility: auto` + `contain-intrinsic-size`);
   *  - `style="block-size: …px"` = **视图位确定高度**(可读性载体:由
   *    `viewSlotHeightPx()` 按左半侧可视高等分,下限 = chrome + N 个行单位 ⇒
   *    **只滚动、不压缩**);
   *  - **类型名在视图内左上角**(`.view-label`,面板内第一个元素)⇒ **无独立
   *    标题栏**(原 `.tab-bar` 退场);
   *  - `aria-label=${title}` **保持不变**(D-UI-7 ①:标题栏消失不改地标名,
   *    避免二次 axe 地标重名回归);视图位是独立 `region`,**不得**用
   *    `role="presentation"` / `aria-hidden` 简化掉(D-UI-7 ②)。
   */
  #renderPanel(type: string, title: string, slotHeightPx: number, focused: boolean): unknown {
    const content = this.#contents.get(type) ?? null;
    const descriptor = this.#tabTypeDescriptor(type);
    return html`
      <section
        class="ws-view${focused ? " focused" : ""}"
        data-view-panel=${type}
        data-render-degrade="content-visibility"
        style="block-size: ${slotHeightPx}px"
        aria-label=${title}
      >
        <span class="view-label">${title}</span>
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

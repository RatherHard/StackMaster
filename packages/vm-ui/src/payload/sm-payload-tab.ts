/**
 * <sm-payload-tab> —— Payload 搭建标签页(WP-F6 / FE-PB-01/02/03/05/06)。
 *
 * **三区布局**(FE-PB-01):
 *  - 左 = Blockly 画布(积木列表侧栏 = Blockly 分类工具箱飞出 + 搭建空间);
 *  - 右上 = 程序区(编译产物原子步骤列表,当前步高亮——Q3:每个原子动作
 *    = 一步);
 *  - 右下 = 输出区(执行日志:每步动作摘要 + 响应状态 + 可解释错误)。
 *
 * **shadow DOM 适配定案(实测登记)**:Blockly 官方对 shadow DOM 支持有限
 * (其样式注入 document 头、几何计算依赖 light 树),画布容器以 **light DOM**
 * 挂载——组件把画布宿主 div 挂到自身轻 DOM 子节点并经 `<slot name="canvas">`
 * 布局;右栏(程序/输出/工具栏)留在 shadow DOM。jsdom 实测:inject 与序列化
 * 均可运行(无布局引擎,渲染退化为零几何,不影响结构冒烟);真实渲染验证
 * 归 WP-F7 Playwright。
 *
 * **数据纪律**:组件只依赖 `MemoryDataSource` 接口(求值环境 = 公开投影
 * 只读快照);动作提交经 `actionSink`(`PayloadActionSink`,SessionClient
 * 结构兼容,工作区组合根注入)。积木程序是 UI 状态,可保存;求值数据源
 * 仅公开投影。动画只用 transform / opacity。
 *
 * **FE-WS-04b 接线**:工作区菜单「积木步进」→ `stepOnce()`(编译 + 单步);
 * 组件实现 `refresh?()` 约定:投影更新 → 重建求值环境并重编译。
 *
 * **执行日志的无障碍语义(WP-74 前置修复;WP-71 固定窗口集后真机 axe 抓出)**:
 * live region 语义由 `<ol class="output-log" aria-live="polite">` 承载——
 * 在其上声明 `role="log"` 对 `<ol>` 非法(axe `aria-allowed-role`,minor),
 * 且 role=log 会覆盖 `<ol>` 的隐式 list 角色,使每一行 `<li>` 失去 list 父级
 * (axe `listitem`,serious,逐行命中)。日志行的列表语义是更真实的读屏收益
 * (逐行可定位、条数可报),故以「去掉 role=log、保留 aria-live」定案;
 * 备选修法(外层包 `<div role="log">` 保留 role=log)被否决的理由见
 * WP-74 前置修复报告:输出区为 flex 布局且 `<ol>` 自身即滚动容器
 * (`.pane ol { flex: 1; overflow: auto }`),引入包裹元素须连带改 CSS 几何,
 * 与「本包只调语义属性、视觉零变化」相冲突。
 */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import * as Blockly from "blockly";

import type { MemoryDataSource } from "../datasource/types.js";
import { LocaleController, t } from "../i18n/i18n.js";
import { addressToHex, parseAddressHex } from "../render/hex.js";
import { ensureSmThemeStyles } from "../theme/theme-tokens.js";
import {
  PAYLOAD_BLOCKLY_THEME,
  PAYLOAD_CANVAS_HOST_CLASS,
  ensurePayloadCanvasStyles,
} from "./blockly-theme.js";
import { createPublicEvalEnvironment } from "./compiler/eval.js";
import {
  PAYLOAD_START_BLOCK_TYPE,
  buildPayloadToolbox,
  registerPayloadBlocks,
} from "./compiler/blocks.js";
import { compilePayload } from "./compiler/compile.js";
import type {
  BlocklySerializedState,
  CompilePayloadResult,
  PayloadCompileError,
  PayloadProgram,
} from "./compiler/types.js";
import {
  PayloadStepExecutor,
  type PayloadActionSink,
  type PayloadExecutorErrorEvent,
  type PayloadExecutorStatus,
} from "./executor.js";

/** 输出日志行(执行日志面)。 */
interface PayloadLogLine {
  readonly kind: "info" | "step" | "error";
  readonly text: string;
}

/**
 * `payload-breakpoints-changed` 事件 detail(WP-76;编译产出断点积木地址集)。
 * 消费者(工作区)可直接用本 detail,也可回调 `breakpointAddresses()` 自取
 * (两者同源)。
 */
export interface PayloadBreakpointsChangedDetail {
  /** 断点积木解析出的地址集(去重、首次出现序;不可解析的断点不产出)。 */
  readonly addresses: readonly string[];
}

/**
 * `payload-client-pause` 事件 detail(WP-76 #4):积木执行器的**客户端**暂停
 * (断点积木 / 单步 / 手动暂停);`addressHex` 仅断点积木且编译期可解析时非空。
 */
export interface PayloadClientPauseDetail {
  readonly reason: "breakpoint" | "user" | "step";
  readonly stepIndex: number;
  readonly addressHex: string | null;
}

/** 日志上限(内存有界;超出丢弃最旧行)。 */
const PAYLOAD_LOG_LIMIT = 200;

/** 地址归一化兜底(编译器产物 → 归一化小写键;非法返回 null,渲染层不抛错)。 */
function normalizeAddressSafe(addressHex: string): string | null {
  try {
    return addressToHex(parseAddressHex(addressHex));
  } catch {
    return null;
  }
}

/** 画布预置状态:唯一起始积木(FE-PB-03;deletable=false 由组件补设)。 */
function seedState(): BlocklySerializedState {
  return {
    blocks: {
      languageVersion: 0,
      blocks: [{ type: PAYLOAD_START_BLOCK_TYPE, deletable: false, movable: true, x: 24, y: 24 }],
    },
  };
}

@customElement("sm-payload-tab")
export class SmPayloadTab extends LitElement {
  // ── 注入面(工作区组合根 / 宿主)─────────────────────────────────────────

  /** 数据源(视图唯一依赖面;换绑即重建求值环境并重编译)。 */
  @property({ attribute: false })
  dataSource: MemoryDataSource | null = null;

  /**
   * 动作提交面(SessionClient 结构兼容;工作区注入)。null = 未接会话
   * (运行/单步禁用)。
   */
  @property({ attribute: false })
  actionSink: PayloadActionSink | null = null;

  /** 题目 allowedActions 白名单(缺省 null = 12 动作裁去 run_to_event)。 */
  @property({ attribute: false })
  allowedActions: readonly string[] | null = null;

  // ── 内部状态 ─────────────────────────────────────────────────────────────

  /** 轻 DOM 画布宿主(Blockly inject 容器;shadow DOM 适配定案)。 */
  #canvasHost: HTMLDivElement | null = null;
  #workspace: Blockly.WorkspaceSvg | null = null;
  /** inject 失败兜底(jsdom 极端环境;画布容器仍存在)。 */
  #canvasUnavailable = false;

  /** 宿主/测试注入的序列化状态(无画布时的编译输入)。 */
  #manualState: BlocklySerializedState | null = null;
  /** 画布结构变更 → 程序过期(运行/单步前自动重编译,游标复位——定案语义)。 */
  #programStale = true;
  #program: PayloadProgram | null = null;
  #compileErrors: readonly PayloadCompileError[] = [];
  #executor: PayloadStepExecutor | null = null;
  #executorSink: PayloadActionSink | null = null;
  readonly #log: PayloadLogLine[] = [];
  #executorStatus: PayloadExecutorStatus = "idle";
  #executorCursor = 0;
  /** Blockly 结构事件抑制(预置/编程性装载不触发过期标记)。 */
  #suppressStructureEvents = false;

  /** i18n:连接时消费 data-sm-language 锚;locale 变化即重渲染(WP-53)。 */
  readonly #i18n = new LocaleController(this);

  static override styles = css`
    :host {
      display: block;
      min-block-size: 24rem;
      font-family: system-ui, sans-serif;
      font-size: 0.8125rem;
      color: var(--sm-fg, canvastext);
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(18rem, 1.2fr) minmax(14rem, 1fr);
      gap: 0.5rem;
      block-size: 100%;
      min-block-size: 24rem;
    }

    /* 左区:画布(积木列表侧栏 = Blockly 工具箱飞出 + 搭建空间)。 */
    .canvas-pane {
      display: flex;
      min-block-size: 24rem;
      border: 1px solid var(--sm-border, rgb(0 0 0 / 15%));
      border-radius: 8px;
      overflow: hidden;
    }

    ::slotted(.payload-canvas-host) {
      flex: 1;
      inline-size: 100%;
      block-size: 100%;
      min-block-size: 24rem;
    }

    .canvas-fallback {
      margin: 0;
      padding: 1rem;
      color: var(--sm-fg-dim, graytext);
    }

    /* 右区:工具栏 + 程序区 + 输出区(纵向分割)。 */
    .side {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      min-block-size: 0;
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.375rem;
    }

    .toolbar button {
      padding: 0.125rem 0.5rem;
      border: 1px solid var(--sm-border-button, rgb(0 0 0 / 20%));
      border-radius: 6px;
      background: var(--sm-bg-base, canvas);
      color: var(--sm-fg, canvastext);
      font: inherit;
      cursor: pointer;
    }

    .toolbar button:disabled {
      color: var(--sm-fg-dim, graytext);
      cursor: not-allowed;
    }

    .executor-status {
      margin-inline-start: auto;
      color: var(--sm-fg-dim, graytext);
      font-size: 0.8125rem;
    }

    .pane {
      display: flex;
      flex-direction: column;
      min-block-size: 0;
      border: 1px solid var(--sm-border, rgb(0 0 0 / 15%));
      border-radius: 8px;
      overflow: hidden;
    }

    .program-pane {
      flex: 1 1 50%;
    }

    .output-pane {
      flex: 1 1 50%;
    }

    /* 面板标题条底(原为 canvas 92% + highlight 8% 淡染):按「基底关键词原样
       落回退位」的嵌套写法消费——本处基底是 canvas,故用 --sm-bg-base(其
       light / dark 值即 canvas ⇒ 明暗逐像素不变,terminal 下自动换档);
       不可改用 --sm-bg-inset(值为 field,会改掉 light 底)。 */
    .pane h3 {
      margin: 0;
      padding: 0.25rem 0.5rem;
      border-block-end: 1px solid var(--sm-divider, rgb(0 0 0 / 10%));
      background: color-mix(in srgb, var(--sm-bg-base, canvas) 92%, var(--sm-warn, highlight) 8%);
      font-size: 0.8125rem;
      font-weight: 600;
    }

    .pane ol {
      flex: 1;
      margin: 0;
      padding: 0.25rem 0.5rem 0.25rem 1.5rem;
      overflow: auto;
      font-size: 0.8125rem;
    }

    .program-list li.current {
      font-weight: 700;
      color: var(--sm-warn, highlight);
    }

    .program-list li.breakpoint {
      color: var(--sm-danger, crimson);
    }

    .stale-note,
    .compile-errors {
      margin: 0;
      padding: 0.25rem 0.5rem;
      color: var(--sm-danger, crimson);
      font-size: 0.8125rem;
    }

    .empty {
      margin: 0;
      padding: 0.5rem;
      color: var(--sm-fg-dim, graytext);
      font-size: 0.8125rem;
    }

    .output-log li.error {
      color: var(--sm-danger, crimson);
    }
  `;

  // ── 生命周期 ─────────────────────────────────────────────────────────────

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("dataSource")) {
      // 数据源换绑 → 重建求值环境并重编译(投影快照口径)。
      this.#markStale();
      this.refresh();
    }
    if (changed.has("actionSink")) {
      this.#rebuildExecutor();
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // LocaleController 经构造副作用注册(Lit addController);显式读点满足 lint。
    void this.#i18n;
    // 主题锚消费(i18n)由 LocaleController 承担;此处确保主题锚样式表在场。
    ensureSmThemeStyles(this.ownerDocument ?? document);
    // 轻 DOM 画布宿主(shadow DOM 适配定案;slot 承接布局)。
    if (this.#canvasHost === null) {
      const host = document.createElement("div");
      // 类名 = 画布样式作用域锚(与 blockly-theme.ts 的样式表同源,避免漂移)。
      host.className = PAYLOAD_CANVAS_HOST_CLASS;
      host.setAttribute("slot", "canvas");
      host.setAttribute("data-payload-canvas", "");
      this.appendChild(host);
      this.#canvasHost = host;
    }
    // 画布内部样式表(主题 token 覆盖 Blockly 自带字面色值;幂等,见
    // blockly-theme.ts):须在 inject 前在场,避免首帧闪现 Blockly 默认浅底。
    ensurePayloadCanvasStyles(this.#canvasHost);
    this.#mountBlockly();
  }

  override disconnectedCallback(): void {
    this.#workspace?.dispose();
    this.#workspace = null;
    this.#canvasHost?.remove();
    this.#canvasHost = null;
    super.disconnectedCallback();
  }

  // ── 公共 API(工作区接线 / 宿主 / 测试)──────────────────────────────────

  /** Blockly 工作区(inject 失败 / 未挂载为 null)。 */
  get workspace(): Blockly.WorkspaceSvg | null {
    return this.#workspace;
  }

  /** 最近一次编译产物(未编译 / 编译失败为 null)。 */
  get program(): PayloadProgram | null {
    return this.#program;
  }

  /** 最近一次编译错误(成功为空数组)。 */
  get compileErrors(): readonly PayloadCompileError[] {
    return this.#compileErrors;
  }

  /** 画布是否不可用(inject 失败兜底态)。 */
  get canvasUnavailable(): boolean {
    return this.#canvasUnavailable;
  }

  /**
   * 注入序列化状态作为编译输入(宿主恢复程序 / 测试驱动;画布存在时以
   * 画布内容为准)。调用后程序过期,由编译动作收敛。
   */
  loadWorkspaceState(state: BlocklySerializedState): void {
    this.#manualState = state;
    if (this.#workspace !== null) {
      this.#suppressStructureEvents = true;
      try {
        this.#workspace.clear();
        Blockly.serialization.workspaces.load(state as never, this.#workspace);
        this.#protectStartBlock();
      } finally {
        this.#suppressStructureEvents = false;
      }
    }
    this.#markStale();
  }

  /** 投影更新约定(工作区接线):重建求值环境并重编译。 */
  refresh(): void {
    this.compileNow();
  }

  /** 立即编译(当前画布 / 注入状态 → 原子步骤序列;错误带 blockId 标注)。 */
  compileNow(): CompilePayloadResult | null {
    const state = this.#currentSerializedState();
    if (state === null) {
      this.#appendLog("info", t("payload.logCanvasUnavailable"));
      return null;
    }
    const environment = this.dataSource === null ? undefined : createPublicEvalEnvironment(this.dataSource);
    const result = compilePayload(state, {
      allowedActions: this.allowedActions ?? undefined,
      environment,
    });
    this.#programStale = false;
    if (result.ok) {
      this.#program = result.program;
      this.#compileErrors = [];
      this.#appendLog(
        "info",
        t("payload.logCompiled", { count: result.program.steps.length }),
      );
      this.#executor?.load(result.program);
    } else {
      this.#program = null;
      this.#compileErrors = result.errors;
      this.#appendLog(
        "error",
        t("payload.logCompileFailed", {
          messages: result.errors.map((error) => error.message).join(";"),
        }),
      );
    }
    this.#applyBlockWarnings(result);
    this.requestUpdate();
    // WP-76:编译产出新程序即广播断点积木地址集(工作区调试档据此重并入;
    // 详情面与 `breakpointAddresses()` 同源,消费者可自取)。
    this.#emitBreakpointsChanged();
    return result;
  }

  /**
   * 断点积木地址集变更广播(WP-76;bubbles + composed,挂点 = 工作区
   * `<main>`):调试档下工作区据此**重并入**地址集(add-only 幂等),使
   * 「调试模式内改积木 → 运行到断点」不必重进调试模式;解题档工作区不消费。
   */
  #emitBreakpointsChanged(): void {
    this.dispatchEvent(
      new CustomEvent<PayloadBreakpointsChangedDetail>("payload-breakpoints-changed", {
        detail: { addresses: this.breakpointAddresses() },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** 运行(FE-WS-04b 运行选项的连续形态):自动编译后从当前游标推进。 */
  runProgram(): void {
    if (!this.#ensureExecutorReady()) {
      return;
    }
    this.#executor?.run();
  }

  /** 单步(FE-WS-04b 积木步进;工作区菜单「积木步进」接线点):自动编译后推进一个原子动作。 */
  stepOnce(): void {
    if (!this.#ensureExecutorReady()) {
      return;
    }
    this.#executor?.stepOnce();
  }

  /** 暂停(停在下一个原子边界;协作式)。 */
  pauseProgram(): void {
    this.#executor?.pause();
  }

  /** 复位步进(游标回零;程序不重编译——画布未变时语义不变)。 */
  resetProgram(): void {
    if (this.#program !== null && this.#executor !== null) {
      this.#executor.load(this.#program);
      this.#appendLog("info", t("payload.logReset"));
      this.requestUpdate();
    }
  }

  /**
   * 断点积木地址并入口(FE-WS-07 / WP-76 最小接线挂点):断点积木双档——
   * 解题模式 = 步进暂停(执行器现状);调试模式 = 断点集合并入调试断点
   * (工作区切调试模式时 duck-typing 调用本面)。
   *
   * WP-76 起编译器断点步骤携带**编译期可解析地址**(`PayloadStep.addressHex`,
   * 见 compiler/types.ts 的语义与边界登记),本面返回**真实地址集**:
   *  - 去重(同一编译期投影 `rip` 可被多个断点积木解析为同一地址),保持
   *    首次出现序(与程序步序一致,便于对读输出区);
   *  - 不可解析的断点步骤(无地址形态)**不产出**条目——不猜测、不补 0;
   *  - 地址形态再校验一次(非法即跳过:地址来自编译器,契约面不会出现非法值,
   *    此处只做渲染层同款的防御性收口)。
   */
  breakpointAddresses(): readonly string[] {
    const steps = this.#program?.steps ?? [];
    const addresses: string[] = [];
    for (const step of steps) {
      if (step.kind !== "breakpoint" || step.addressHex === undefined) {
        continue;
      }
      const address = normalizeAddressSafe(step.addressHex);
      if (address !== null && !addresses.includes(address)) {
        addresses.push(address);
      }
    }
    return addresses;
  }

  // ── 内部:画布与编译 ─────────────────────────────────────────────────────

  #currentSerializedState(): BlocklySerializedState | null {
    if (this.#workspace !== null) {
      return Blockly.serialization.workspaces.save(this.#workspace) as BlocklySerializedState;
    }
    return this.#manualState;
  }

  #mountBlockly(): void {
    const host = this.#canvasHost;
    if (host === null || this.#workspace !== null) {
      return;
    }
    registerPayloadBlocks();
    try {
      const workspace = Blockly.inject(host, {
        // 工具箱定义为 readonly 常量;Blockly Options 面要求可变数组(注入
        // 后不改写),此处单点窄化。
        toolbox: buildPayloadToolbox() as never,
        trashcan: true,
        scrollbars: true,
        // 画布配色 = StackMaster 主题 token(WP-74 前置修复:暗色对比度;见
        // blockly-theme.ts 的根因与映射理由)。
        theme: PAYLOAD_BLOCKLY_THEME,
      });
      this.#workspace = workspace;
      workspace.addChangeListener((event) => {
        if (this.#suppressStructureEvents || event.isUiEvent) {
          return;
        }
        // 结构变更(增删改/移动)→ 程序过期;运行/单步前自动重编译并复位
        // 游标(确定性语义:编辑即复位步进)。
        this.#markStale();
      });
      this.loadWorkspaceState(seedState());
      this.#canvasUnavailable = false;
    } catch {
      // Blockly 环境不可用(极端嵌入环境):画布容器保留,呈兜底文案。
      this.#canvasUnavailable = true;
      this.#workspace = null;
      host.textContent = t("payload.canvasUnavailableText");
    }
  }

  /** 起始积木保护:不可删除(FE-PB-03 唯一入口)。 */
  #protectStartBlock(): void {
    const workspace = this.#workspace;
    if (workspace === null) {
      return;
    }
    for (const block of workspace.getTopBlocks(false)) {
      if (block.type === PAYLOAD_START_BLOCK_TYPE) {
        block.setDeletable(false);
      }
    }
  }

  #markStale(): void {
    this.#programStale = true;
  }

  /** 编译错误 → 积木警示气泡(blockId 标红反馈面;旧警示先清空)。 */
  #applyBlockWarnings(result: CompilePayloadResult): void {
    const workspace = this.#workspace;
    if (workspace === null) {
      return;
    }
    for (const block of workspace.getAllBlocks(false)) {
      block.setWarningText(null);
    }
    if (!result.ok) {
      for (const error of result.errors) {
        if (error.blockId !== null) {
          workspace.getBlockById(error.blockId)?.setWarningText(error.message);
        }
      }
    }
  }

  // ── 内部:执行器 ─────────────────────────────────────────────────────────

  #rebuildExecutor(): void {
    const sink = this.actionSink;
    if (sink === null) {
      this.#executor = null;
      this.#executorSink = null;
      return;
    }
    if (this.#executor !== null && this.#executorSink === sink) {
      return;
    }
    const executor = new PayloadStepExecutor(sink);
    executor.onStateChange((event) => {
      this.#executorStatus = event.status;
      this.#executorCursor = event.cursor;
      this.requestUpdate();
    });
    executor.onStepAccepted((event) => {
      this.#executorCursor = event.index + 1;
      this.#appendLog(
        "step",
        t("payload.logStepExecuted", {
          index: event.index + 1,
          label: event.step.label,
          revision: event.response.revision,
          status: event.response.status,
        }),
      );
      this.requestUpdate();
    });
    executor.onPaused((event) => {
      this.#executorCursor = event.index;
      const step = this.#program?.steps[event.index] ?? null;
      // 地址只在**真实停断点积木**时呈现(reason = breakpoint):单步 / 手动
      // 暂停时游标可能恰好落在断点步骤上,但那是"执行完上一步"的暂停,不是
      // 断点暂停——语义不可混同(登记)。
      const addressHex =
        event.reason === "breakpoint" && step !== null && step.kind === "breakpoint"
          ? (step.addressHex ?? null)
          : null;
      if (event.reason === "breakpoint") {
        // WP-76 #4:断点积木暂停 = **客户端步进暂停**(本地暂停点,不含服务端
        // 断点语义;解题档既有变通语义原样保留)。地址可解析时一并宣读。
        this.#appendLog(
          "info",
          t("payload.logPausedBreakpointClient", {
            index: event.index + 1,
            address: addressHex === null ? t("payload.pausedNoAddress") : ` @ ${addressHex}`,
          }),
        );
      } else {
        const reason =
          event.reason === "user" ? t("payload.pauseReasonUser") : t("payload.pauseReasonStep");
        this.#appendLog("info", t("payload.logPaused", { index: event.index + 1, reason }));
      }
      // 客户端暂停广播(工作区 → 指令视图按「客户端步进暂停」形态呈现锚点)。
      this.dispatchEvent(
        new CustomEvent<PayloadClientPauseDetail>("payload-client-pause", {
          detail: { reason: event.reason, stepIndex: event.index, addressHex },
          bubbles: true,
          composed: true,
        }),
      );
      this.requestUpdate();
    });
    executor.onError((event: PayloadExecutorErrorEvent) => {
      this.#executorCursor = event.index;
      const code = event.error?.code ?? "client_error";
      const detail = event.error?.message ?? event.message ?? t("payload.unknownError");
      this.#appendLog(
        "error",
        t("payload.logRejected", {
          index: event.index + 1,
          label: this.#program?.steps[event.index]?.label ?? "",
          code,
          detail,
        }),
      );
      this.requestUpdate();
    });
    this.#executor = executor;
    this.#executorSink = sink;
    if (this.#program !== null) {
      executor.load(this.#program);
    }
    this.requestUpdate();
  }

  /** 运行/单步前置:程序就绪(过期即重编译)+ 执行器就绪(有动作通道)。 */
  #ensureExecutorReady(): boolean {
    if (this.actionSink === null) {
      this.#appendLog("error", t("payload.logNoSink"));
      this.requestUpdate();
      return false;
    }
    if (this.#executor === null) {
      this.#rebuildExecutor();
    }
    if (this.#programStale) {
      const result = this.compileNow();
      if (result === null || !result.ok) {
        this.requestUpdate();
        return false;
      }
    }
    return this.#executor !== null;
  }

  #appendLog(kind: PayloadLogLine["kind"], text: string): void {
    this.#log.push({ kind, text });
    if (this.#log.length > PAYLOAD_LOG_LIMIT) {
      this.#log.splice(0, this.#log.length - PAYLOAD_LOG_LIMIT);
    }
  }

  // ── 渲染 ─────────────────────────────────────────────────────────────────

  protected override render(): unknown {
    const steps = this.#program?.steps ?? [];
    const total = steps.length;
    const sinkReady = this.actionSink !== null;
    const programReady = this.#program !== null && !this.#programStale;
    const status = this.#executorStatus;
    return html`
      <div class="layout">
        <section class="canvas-pane" aria-label=${t("payload.canvasAria")}>
          <slot name="canvas"></slot>
        </section>
        <div class="side">
          <div class="toolbar" role="toolbar" aria-label=${t("payload.toolbarAria")}>
            <button
              type="button"
              class="compile-button"
              @click=${() => this.compileNow()}
            >
              ${t("payload.compile")}
            </button>
            <button
              type="button"
              class="run-button"
              ?disabled=${!programReady || !sinkReady || status === "running" || total === 0}
              @click=${() => this.runProgram()}
            >
              ${t("payload.run")}
            </button>
            <button
              type="button"
              class="step-button"
              ?disabled=${!programReady || !sinkReady || status === "running" || status === "done" || total === 0}
              @click=${() => this.stepOnce()}
            >
              ${t("payload.step")}
            </button>
            <button
              type="button"
              class="pause-button"
              ?disabled=${status !== "running"}
              @click=${() => this.pauseProgram()}
            >
              ${t("payload.pause")}
            </button>
            <button
              type="button"
              class="reset-button"
              ?disabled=${this.#executor === null || this.#executorCursor === 0}
              @click=${() => this.resetProgram()}
            >
              ${t("payload.reset")}
            </button>
            <span class="executor-status" role="status">
              ${t("payload.statusLabel", { status: this.#executorStatus })}
              ${total === 0
                ? nothing
                : html`${t("payload.stepPosition", { cursor: Math.min(this.#executorCursor, total), total })}`}
            </span>
          </div>
          <section class="pane program-pane" aria-label=${t("payload.programAria")}>
            <h3>${t("payload.programHeading")}</h3>
            ${this.#programStale
              ? html`<p class="stale-note" role="status">${t("payload.staleNote")}</p>`
              : nothing}
            ${this.#compileErrors.length > 0
              ? html`<p class="compile-errors" role="alert">
                  ${this.#compileErrors.map((error) => html`<span>${error.message}</span>`)}
                </p>`
              : nothing}
            ${total === 0
              ? html`<p class="empty">${t("payload.programEmpty")}</p>`
              : html`
                  <ol class="program-list">
                    ${steps.map((step, index) => {
                      const isCurrent =
                        index === this.#executorCursor &&
                        (status === "running" || status === "paused" || status === "error");
                      const classes = [
                        step.kind === "breakpoint" ? "breakpoint" : "",
                        isCurrent ? "current" : "",
                      ]
                        .filter((entry) => entry !== "")
                        .join(" ");
                      return html`
                        <li
                          class=${classes === "" ? nothing : classes}
                          data-step-index=${index}
                          title=${step.label}
                        >
                          ${step.kind === "breakpoint" ? "🔴 " : ""}${step.label}
                        </li>
                      `;
                    })}
                  </ol>
                `}
          </section>
          <section class="pane output-pane" aria-label=${t("payload.outputAria")}>
            <h3>${t("payload.outputHeading")}</h3>
            ${this.#log.length === 0
              ? html`<p class="empty">${t("payload.outputEmpty")}</p>`
              : html`
                  <ol class="output-log" aria-live="polite">
                    ${this.#log.map(
                      (line) => html`<li class=${line.kind === "error" ? "error" : nothing}>${line.text}</li>`,
                    )}
                  </ol>
                `}
          </section>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sm-payload-tab": SmPayloadTab;
  }
}

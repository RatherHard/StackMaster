/**
 * <sm-workspace-menu> —— 工作区顶部菜单(WP-F5 / FE-WS-03)。
 *
 * 职责:作用于工作区/标签页**整体**(而非单个标签页内部)的常驻菜单与状态面:
 *  - **打开标签页**:按注册表条目渲染打开项(可扩展结构——payload 等
 *    新类型登记后自动出现);
 *  - **指令步进**(FE-WS-04a)= `step` 动作;**积木步进**(FE-WS-04b,WP-F6)
 *    = `payload-step` 动作——仅 payload 标签页激活时可用,语义(编译 + 推进
 *    一个原子动作)由 payload 标签页承载;
 *  - **提交**(阶段六 WP-63,D-API-84)= `submit` 动作:正式裁决呈现入口
 *    (submit → pending → verdicted;禁用矩阵与 step 同形);
 *  - **重启测试环境**(FE-WS-05,Q5 / M11 口径):运行中可点 = `reset` 动作;
 *    **终态(won/failed)禁用**并呈现引导"测试环境已结束,请新建会话";
 *  - **运行到断点**(FE-WS-04c,WP-F8):调试模式原生暂停点——由宿主经
 *    `runToBreakpointEnabled` 注入可用性(调试模式 && 断点集合非空 && 通道
 *    可用),动作语义 = `debug_run_to_breakpoint`(断点集合 = 当前集合),
 *    由宿主(sm-workspace)执行;
 *  - **解题/调试模式切换**(FE-WS-06,WP-F8):`toggle-debug-mode` 动作;
 *    **调试可用性由题目声明**(`debugModeAvailable`,plugin-dev 开发壳经
 *    夹具描述包注入)——未启用的题目**隐藏切换项**(FE-WS-06);
 *  - **what-if 纪律横幅**(ADR-DC1 条款 7):调试模式下常驻显式呈现
 *    "调试通过 ≠ 提交通过(裁决以提交为准)"+ ASLR 地址差异提示语,
 *    调试结果不得被误读为权威结论;
 *  - **会话状态显示**:status + revision + 连接状态机(connecting/connected/
 *    reconnecting/disconnected);reconnecting 呈现 attempt / retryDelayMs;
 *    connection-replaced 提示可手动重连;
 *  - **断线横幅**:断线时整体呈现"最近一次公开投影 + 重连中"(硬门槛:禁止
 *    本地 VM 降级——本菜单不提供任何本地执行入口);
 *  - **拒绝呈现**:动作被拒(onActionRejected)呈现 userVisibleError,含
 *    explanation 教学解释(不只 code;F8 起与教学面板 sm-error-explainer
 *    增强并存)。
 *
 * 本组件是纯呈现 + 事件出站面:动作语义由宿主(sm-workspace)执行。
 * 动画纪律:零动画;语义化 DOM(nav / button / role=status / role=alert)。
 */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import type { ConnectionStatus, DisconnectReason } from "../client/session-client.js";
import type { PublicError } from "@stackmaster/protocol";
import { LocaleController, t } from "../i18n/i18n.js";
import { ensureSmThemeStyles } from "../theme/theme-tokens.js";
import type { WorkspaceTabTypeDescriptor } from "./tab-registry.js";

/** 菜单动作(出站事件 detail;执行归宿主)。 */
export type WorkspaceMenuAction =
  | { readonly action: "step" }
  | { readonly action: "reset" }
  | { readonly action: "reconnect" }
  | { readonly action: "new-session" }
  /**
   * 提交(阶段六 WP-63,D-API-84):正式裁决呈现入口——submit 受理后由宿主
   * 启动裁决重询(pending 确定性呈现 → verdicted 呈现 11 值结果类型)。
   */
  | { readonly action: "submit" }
  /** 积木步进(FE-WS-04b,WP-F6):payload 程序推进一步(一个原子动作)并暂停。 */
  | { readonly action: "payload-step" }
  /** 运行到断点(FE-WS-04c,WP-F8):调试通道 debug_run_to_breakpoint(断点 = 当前集合)。 */
  | { readonly action: "run-to-breakpoint" }
  /** 解题/调试模式切换(FE-WS-06,WP-F8;可用性 = debugModeAvailable 题目声明)。 */
  | { readonly action: "toggle-debug-mode" }
  | { readonly action: "open-tab"; readonly tabType: string };

/** `workspace-menu-action` 事件 detail。 */
export interface WorkspaceMenuActionDetail {
  readonly action: WorkspaceMenuAction;
}

/** 终态投影状态(reset 禁用 + 引导,Q5 定案)。 */
const TERMINAL_STATUSES: readonly string[] = ["won", "failed"];

@customElement("sm-workspace-menu")
export class SmWorkspaceMenu extends LitElement {
  /** 注册表条目(「打开」分组;可扩展类型的呈现面)。 */
  @property({ attribute: false })
  tabTypes: readonly WorkspaceTabTypeDescriptor[] = [];

  /** 连接状态机当前态。 */
  @property({ type: String })
  connectionStatus: ConnectionStatus = "disconnected";

  /** 语义化断线原因(close 路径携带;connection-replaced 时提示手动重连)。 */
  @property({ type: String, attribute: false })
  disconnectReason: DisconnectReason | null = null;

  /** 重连尝试序(reconnecting 态呈现)。 */
  @property({ type: Number })
  reconnectAttempt = 0;

  /** 下一次重连退避延迟 ms(reconnecting 态呈现)。 */
  @property({ type: Number, attribute: false })
  retryDelayMs: number | null = null;

  /** 公开投影 status(running/paused/won/failed;无投影为 null)。 */
  @property({ type: String, attribute: false })
  projectionStatus: string | null = null;

  /** 最近一次公开投影 revision(状态面 + 断线横幅展示)。 */
  @property({ type: Number, attribute: false })
  revision: number | null = null;

  /** 是否已有会话(未建会话时动作项禁用)。 */
  @property({ type: Boolean, attribute: "has-session" })
  hasSession = false;

  /**
   * 积木步进可用性(WP-F6 / FE-WS-04b):**仅 payload 标签页激活时可用**
   * (由宿主按焦点标签页类型计算注入;本组件不感知注册表语义)。
   */
  @property({ type: Boolean, attribute: "payload-step-enabled" })
  payloadStepEnabled = false;

  /**
   * 运行到断点可用性(WP-F8 / FE-WS-04c):调试模式 && 断点集合非空 &&
   * 会话通道可用(宿主计算注入;本组件不感知调试通道状态)。
   */
  @property({ type: Boolean, attribute: "run-to-breakpoint-enabled" })
  runToBreakpointEnabled = false;

  /**
   * 调试模式可用性(FE-WS-06):题目 debugMode 声明(plugin-dev 开发壳经
   * 夹具描述包注入)。false = 未启用调试的题目,**隐藏模式切换项**。
   */
  @property({ type: Boolean, attribute: "debug-mode-available" })
  debugModeAvailable = false;

  /** 当前是否处于调试模式(what-if 横幅显隐 + 切换项文案)。 */
  @property({ type: Boolean, attribute: "debug-mode-active" })
  debugModeActive = false;

  /** 最近一次被拒动作的用户可见错误(onActionRejected 呈现)。 */
  @property({ type: Object, attribute: false })
  lastError: PublicError | null = null;

  /** 错误条本地消隐态(新错误到达时复位)。 */
  @state()
  private errorDismissed = false;

  /** i18n:连接时消费 data-sm-language 锚;locale 变化即重渲染(WP-53)。 */
  readonly #i18n = new LocaleController(this);

  static override styles = css`
    :host {
      display: block;
      border-block-end: 1px solid var(--sm-divider, rgb(0 0 0 / 10%));
      font-family: system-ui, sans-serif;
      font-size: 0.8125rem;
    }

    nav {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 1rem;
      padding: 0.375rem 0.75rem;
    }

    .group {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
    }

    .group-label {
      color: graytext;
      font-size: 0.75rem;
    }

    button {
      padding: 0.125rem 0.5rem;
      border: 1px solid var(--sm-border-button, rgb(0 0 0 / 20%));
      border-radius: 6px;
      background: canvas;
      color: canvastext;
      font: inherit;
      cursor: pointer;
    }

    button:disabled {
      color: graytext;
      cursor: not-allowed;
    }

    button:focus-visible {
      outline: 2px solid accentcolor;
      outline-offset: 1px;
    }

    .status {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.375rem;
      margin-inline-start: auto;
      color: graytext;
      font-size: 0.75rem;
    }

    .status dd {
      margin: 0;
    }

    .status strong {
      color: canvastext;
      font-weight: 600;
    }

    /* 断线横幅:整体呈现"最近一次公开投影 + 重连中"(零本地 VM 降级)。 */
    .banner {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      margin: 0;
      padding: 0.375rem 0.75rem;
      background: color-mix(in srgb, field 92%, highlight 8%);
      border-block-end: 1px solid var(--sm-divider, rgb(0 0 0 / 10%));
      font-size: 0.75rem;
    }

    /* what-if 纪律横幅(F8):调试模式常驻(ADR-DC1 条款 7)。 */
    .whatif-banner {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem 0.75rem;
      margin: 0;
      padding: 0.375rem 0.75rem;
      background: color-mix(in srgb, field 94%, accentcolor 6%);
      border-block-end: 1px solid var(--sm-divider, rgb(0 0 0 / 10%));
      font-size: 0.75rem;
    }

    .whatif-banner strong {
      color: canvastext;
    }

    .whatif-banner span {
      color: graytext;
    }

    .banner[role="alert"] {
      background: color-mix(in srgb, mark 12%, canvas);
    }

    /* 终态引导 + 拒绝错误条。 */
    .guidance,
    .error {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      margin: 0;
      padding: 0.375rem 0.75rem;
      font-size: 0.75rem;
    }

    .guidance {
      background: color-mix(in srgb, field 92%, highlight 8%);
    }

    .error {
      background: color-mix(in srgb, mark 12%, canvas);
    }

    .error pre {
      margin: 0;
      font: inherit;
      white-space: pre-wrap;
    }

    .error-details {
      margin: 0;
      padding-inline-start: 1rem;
    }
  `;

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("lastError")) {
      this.errorDismissed = false;
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // LocaleController 经构造副作用注册(Lit addController);显式读点满足 lint。
    void this.#i18n;
    // 主题锚样式表(幂等):变量经 data-sm-theme 宿主锚继承穿透 shadow DOM。
    ensureSmThemeStyles(this.ownerDocument ?? document);
  }

  protected override render(): unknown {
    return html`
      <nav aria-label=${t("menu.aria")} part="nav">
        <span class="group">
          <span class="group-label">${t("menu.openGroup")}</span>
          ${this.tabTypes.map((descriptor) => this.#renderOpenButton(descriptor))}
        </span>
        <span class="group">
          <span class="group-label">${t("menu.modeGroup")}</span>
          <strong class="mode-indicator"
            >${this.debugModeActive ? t("menu.modeDebug") : t("menu.modeSolve")}</strong
          >
        </span>
        <span class="group">
          <span class="group-label">${t("menu.runGroup")}</span>
          <button
            type="button"
            class="step-button"
            ?disabled=${this.#stepDisabled}
            @click=${() => this.#emit({ action: "step" })}
          >
            ${t("menu.step")}
          </button>
          <button
            type="button"
            class="payload-step-button"
            ?disabled=${!this.payloadStepEnabled}
            title=${this.payloadStepEnabled
              ? t("menu.payloadStepTitleOn")
              : t("menu.payloadStepTitleOff")}
            @click=${() => this.#emit({ action: "payload-step" })}
          >
            ${t("menu.payloadStep")}
          </button>
          <!-- FE-WS-04c(F8):运行到断点 = 调试通道原生暂停点(断点集合 = 当前集合)。 -->
          <button
            type="button"
            class="run-to-breakpoint-button"
            ?disabled=${!this.runToBreakpointEnabled}
            title=${this.runToBreakpointEnabled
              ? t("menu.runToBreakpointTitleOn")
              : this.debugModeActive
                ? t("menu.runToBreakpointTitleDebugOff")
                : t("menu.runToBreakpointTitleSolve")}
            @click=${() => this.#emit({ action: "run-to-breakpoint" })}
          >
            ${t("menu.runToBreakpoint")}
          </button>
          <!-- FE-WS-06(F8):解题/调试模式切换;未启用调试的题目隐藏本项。 -->
          ${this.debugModeAvailable
            ? html`
                <button
                  type="button"
                  class="mode-toggle-button"
                  title=${this.debugModeActive
                    ? t("menu.modeToggleTitleToSolve")
                    : t("menu.modeToggleTitleToDebug")}
                  @click=${() => this.#emit({ action: "toggle-debug-mode" })}
                >
                  ${this.debugModeActive ? t("menu.modeToggleToSolve") : t("menu.modeToggleToDebug")}
                </button>
              `
            : nothing}
          <button
            type="button"
            class="submit-button"
            ?disabled=${this.#submitDisabled}
            title=${this.#submitDisabledTitle}
            @click=${() => this.#emit({ action: "submit" })}
          >
            ${t("menu.submit")}
          </button>
          <button
            type="button"
            class="reset-button"
            ?disabled=${this.#resetDisabled}
            title=${this.#resetDisabledTitle}
            @click=${() => this.#emit({ action: "reset" })}
          >
            ${t("menu.reset")}
          </button>
        </span>
        ${this.#renderStatus()}
      </nav>
      ${this.#renderWhatIfBanner()} ${this.#renderBanner()} ${this.#renderGuidance()} ${this.#renderError()}
    `;
  }

  /**
   * what-if 纪律横幅(ADR-DC1 条款 7,WP-F8):调试模式下常驻——"调试通过
   * ≠ 提交通过"不可误读 + ASLR 地址差异教学提示语。role=status 非警示:
   * what-if 是常驻教学语境,不是异常。
   */
  #renderWhatIfBanner(): unknown {
    if (!this.debugModeActive) {
      return nothing;
    }
    return html`
      <p class="whatif-banner" role="status" data-testid="whatif-banner">
        <strong>${t("menu.whatifTitle")}</strong>
        <span>
          ${t("menu.whatifBody")}
        </span>
      </p>
    `;
  }

  #renderOpenButton(descriptor: WorkspaceTabTypeDescriptor): unknown {
    return html`
      <button
        type="button"
        class="open-tab"
        data-tab-type=${descriptor.type}
        title=${descriptor.createContent === undefined
          ? (descriptor.placeholderNote ?? t("common.noContentNote"))
          : this.#tabLabel(descriptor)}
        @click=${() => this.#emit({ action: "open-tab", tabType: descriptor.type })}
      >
        ${this.#tabLabel(descriptor)}
      </button>
    `;
  }

  /** 展示名解析:登记了 labelKey(默认注册表)的按当前 locale 取词。 */
  #tabLabel(descriptor: WorkspaceTabTypeDescriptor): string {
    return descriptor.labelKey !== undefined ? t(descriptor.labelKey) : descriptor.label;
  }

  #renderStatus(): unknown {
    return html`
      <span class="status" role="status" aria-label=${t("menu.sessionStatusLabel")}>
        ${t("menu.sessionStatusLabel")}
        <strong class="session-status">${this.projectionStatus ?? t("menu.noSession")}</strong>
        revision
        <strong class="revision">${this.revision === null ? "—" : this.revision}</strong>
        ${t("menu.connectionLabel")}
        <strong class="connection-status">${this.connectionStatus}</strong>
        ${this.connectionStatus === "reconnecting"
          ? html`<span class="reconnect-detail">
              ${this.retryDelayMs === null
                ? t("menu.retryAttempt", { attempt: this.reconnectAttempt })
                : t("menu.retryDetail", { attempt: this.reconnectAttempt, delay: this.retryDelayMs })}
            </span>`
          : nothing}
      </span>
    `;
  }

  /** 断线横幅:disconnected / reconnecting 呈现(保留最近投影,只展示)。 */
  #renderBanner(): unknown {
    const alertLike = this.disconnectReason === "connection-replaced";
    if (this.connectionStatus !== "disconnected" && this.connectionStatus !== "reconnecting") {
      return nothing;
    }
    return html`
      <p class="banner" role=${alertLike ? "alert" : "status"}>
        ${alertLike
          ? html`<strong>${t("menu.replacedTitle")}</strong>`
          : this.connectionStatus === "reconnecting"
            ? html`<strong>${t("menu.reconnectingTitle")}</strong>`
            : html`<strong>${t("menu.disconnectedTitle")}</strong>`}
        <span>
          ${t("menu.bannerBody", {
            revision: this.revision === null ? "" : `(revision ${this.revision})`,
          })}
        </span>
        ${this.connectionStatus === "reconnecting" && this.retryDelayMs !== null
          ? html`<span>${t("menu.retryDetail", { attempt: this.reconnectAttempt, delay: this.retryDelayMs })}</span>`
          : nothing}
        <button type="button" class="reconnect-button" @click=${() => this.#emit({ action: "reconnect" })}>
          ${t("menu.reconnect")}
        </button>
      </p>
    `;
  }

  /** 终态引导(Q5):reset 被服务端确定性拒绝,呈现新建会话入口。 */
  #renderGuidance(): unknown {
    if (!this.#isTerminal || !this.hasSession) {
      return nothing;
    }
    return html`
      <p class="guidance" role="status">
        ${t("menu.guidanceTerminal")}
        <button type="button" class="new-session-button" @click=${() => this.#emit({ action: "new-session" })}>
          ${t("menu.newSession")}
        </button>
      </p>
    `;
  }

  /** 拒绝呈现:code + message + explanation(不只 code;可解释性反馈)。 */
  #renderError(): unknown {
    const error = this.lastError;
    if (error === null || this.errorDismissed) {
      return nothing;
    }
    const explanation = error.explanation;
    return html`
      <p class="error" role="alert">
        <strong>${t("menu.actionRejected")}</strong>
        <span class="error-code">[${error.code}]</span>
        <span class="error-message">${error.message}</span>
        ${explanation === undefined
          ? nothing
          : html`<span class="error-explanation">
              ${explanation.hints === undefined
                ? nothing
                : html`<pre>${explanation.hints.join("\n")}</pre>`}
              ${this.#explanationFacts(explanation)}
            </span>`}
        <button
          type="button"
          class="error-dismiss"
          aria-label=${t("menu.dismissAria")}
          @click=${() => {
            this.errorDismissed = true;
          }}
        >
          ${t("menu.dismiss")}
        </button>
      </p>
    `;
  }

  /** explanation 的结构化事实字段(逐项呈现,零自由文本拼接)。 */
  #explanationFacts(explanation: NonNullable<PublicError["explanation"]>): unknown {
    const facts: string[] = [];
    if (explanation.regionId !== undefined) {
      facts.push(t("menu.factRegion", { id: explanation.regionId }));
    }
    if (explanation.permissions !== undefined) {
      facts.push(t("menu.factPermissions", { value: explanation.permissions }));
    }
    if (explanation.valueHex !== undefined) {
      facts.push(t("menu.factValue", { value: explanation.valueHex }));
    }
    if (explanation.interpretedAs !== undefined) {
      facts.push(t("menu.factInterpretedAs", { value: explanation.interpretedAs }));
    }
    if (explanation.alignmentBytes !== undefined) {
      facts.push(t("menu.factAlignment", { count: explanation.alignmentBytes }));
    }
    if (explanation.expectedBytesLength !== undefined) {
      facts.push(t("menu.factExpected", { count: explanation.expectedBytesLength }));
    }
    if (explanation.actualBytesLength !== undefined) {
      facts.push(t("menu.factActual", { count: explanation.actualBytesLength }));
    }
    if (facts.length === 0) {
      return nothing;
    }
    return html`<span class="error-facts">${facts.join(" · ")}</span>`;
  }

  // ── 派生态 ────────────────────────────────────────────────────────────────

  get #isTerminal(): boolean {
    return this.projectionStatus !== null && TERMINAL_STATUSES.includes(this.projectionStatus);
  }

  get #sessionActionable(): boolean {
    return this.hasSession && this.connectionStatus === "connected";
  }

  get #stepDisabled(): boolean {
    // 指令步进(FE-WS-04a):仅运行中会话可步进;终态步进必被
    // session_terminal 拒绝,提前禁用(断线期 sendAction 亦不可投递)。
    return !this.#sessionActionable || this.#isTerminal;
  }

  get #resetDisabled(): boolean {
    // 重启(FE-WS-05,Q5/M11):运行中(running/paused)可点;终态禁用 + 引导。
    return !this.#sessionActionable || this.#isTerminal;
  }

  get #resetDisabledTitle(): string {
    if (this.#isTerminal) {
      return t("menu.resetTitleTerminal");
    }
    if (!this.hasSession) {
      return t("menu.resetTitleNoSession");
    }
    if (this.connectionStatus !== "connected") {
      return t("menu.resetTitleDisconnected");
    }
    return t("menu.resetTitleDefault");
  }

  // 提交(阶段六 WP-63):禁用矩阵与 step / reset 同形(会话可操作且未终态);
  // 终态会话的提交必被 session_terminal 拒绝,提前禁用 + 引导文案。
  get #submitDisabled(): boolean {
    return !this.#sessionActionable || this.#isTerminal;
  }

  get #submitDisabledTitle(): string {
    if (this.#isTerminal) {
      return t("menu.submitTitleTerminal");
    }
    if (!this.hasSession) {
      return t("menu.submitTitleNoSession");
    }
    if (this.connectionStatus !== "connected") {
      return t("menu.submitTitleDisconnected");
    }
    return t("menu.submitTitleDefault");
  }

  #emit(action: WorkspaceMenuAction): void {
    this.dispatchEvent(
      new CustomEvent<WorkspaceMenuActionDetail>("workspace-menu-action", {
        detail: { action },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sm-workspace-menu": SmWorkspaceMenu;
  }
}

/**
 * <sm-workspace-menu> —— 工作区顶部菜单(WP-F5 / FE-WS-03)。
 *
 * 职责:作用于工作区/标签页**整体**(而非单个标签页内部)的常驻菜单与状态面:
 *  - **打开标签页**:按注册表条目渲染打开项(可扩展结构——payload 等
 *    新类型登记后自动出现);
 *  - **指令步进**(FE-WS-04a)= `step` 动作;**积木步进**(FE-WS-04b,WP-F6)
 *    = `payload-step` 动作——仅 payload 标签页激活时可用,语义(编译 + 推进
 *    一个原子动作)由 payload 标签页承载;**运行到断点归 WP-F8**
 *    (FE-WS-04c / FE-WS-04a 注:断点由调试通道承载);
 *  - **重启测试环境**(FE-WS-05,Q5 / M11 口径):运行中(running/paused)可点
 *    = `reset` 动作;**终态(won/failed)禁用**并呈现引导
 *    "测试环境已结束,请新建会话"(引导动作 = new-session 事件:宿主 close_session
 *    + create_session 新流程);
 *  - **会话状态显示**:status + revision + 连接状态机(connecting/connected/
 *    reconnecting/disconnected);reconnecting 呈现 attempt / retryDelayMs;
 *    connection-replaced 提示可手动重连;
 *  - **断线横幅**:断线时整体呈现"最近一次公开投影 + 重连中"(硬门槛:禁止
 *    本地 VM 降级——本菜单不提供任何本地执行入口);
 *  - **拒绝呈现**:动作被拒(onActionRejected)呈现 userVisibleError,含
 *    explanation 教学解释(不只 code);
 *  - **模式切换挂点(注释位,WP-F8)**:解题/调试模式切换项在 FE-WS-06/07
 *    落地时加入本菜单(FE-WS-03"菜单项可扩展");本 WP 只留注册位。
 *
 * 本组件是纯呈现 + 事件出站面:动作语义由宿主(sm-workspace)执行。
 * 动画纪律:零动画;语义化 DOM(nav / button / role=status / role=alert)。
 */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import type { ConnectionStatus, DisconnectReason } from "../client/session-client.js";
import type { PublicError } from "@stackmaster/protocol";
import type { WorkspaceTabTypeDescriptor } from "./tab-registry.js";

/** 菜单动作(出站事件 detail;执行归宿主)。 */
export type WorkspaceMenuAction =
  | { readonly action: "step" }
  | { readonly action: "reset" }
  | { readonly action: "reconnect" }
  | { readonly action: "new-session" }
  /** 积木步进(FE-WS-04b,WP-F6):payload 程序推进一步(一个原子动作)并暂停。 */
  | { readonly action: "payload-step" }
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

  /** 最近一次被拒动作的用户可见错误(onActionRejected 呈现)。 */
  @property({ type: Object, attribute: false })
  lastError: PublicError | null = null;

  /** 错误条本地消隐态(新错误到达时复位)。 */
  @state()
  private errorDismissed = false;

  static override styles = css`
    :host {
      display: block;
      border-block-end: 1px solid rgb(0 0 0 / 10%);
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
      border: 1px solid rgb(0 0 0 / 20%);
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
      border-block-end: 1px solid rgb(0 0 0 / 10%);
      font-size: 0.75rem;
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

  protected override render(): unknown {
    return html`
      <nav aria-label="工作区菜单" part="nav">
        <span class="group">
          <span class="group-label">打开</span>
          ${this.tabTypes.map((descriptor) => this.#renderOpenButton(descriptor))}
        </span>
        <span class="group">
          <span class="group-label">运行</span>
          <button
            type="button"
            class="step-button"
            ?disabled=${this.#stepDisabled}
            @click=${() => this.#emit({ action: "step" })}
          >
            指令步进
          </button>
          <button
            type="button"
            class="payload-step-button"
            ?disabled=${!this.payloadStepEnabled}
            title=${this.payloadStepEnabled
              ? "Payload 积木程序推进一步(一个原子动作)并暂停"
              : "仅 Payload 标签页激活时可用"}
            @click=${() => this.#emit({ action: "payload-step" })}
          >
            积木步进
          </button>
          <!-- 模式切换挂点(WP-F8):解题/调试模式切换项(FE-WS-06/07)在此加入;
               运行到断点(FE-WS-04c)归 WP-F8(断点由调试通道承载,ADR-DC1)。 -->
          <button
            type="button"
            class="reset-button"
            ?disabled=${this.#resetDisabled}
            title=${this.#resetDisabledTitle}
            @click=${() => this.#emit({ action: "reset" })}
          >
            重启测试环境
          </button>
        </span>
        ${this.#renderStatus()}
      </nav>
      ${this.#renderBanner()} ${this.#renderGuidance()} ${this.#renderError()}
    `;
  }

  #renderOpenButton(descriptor: WorkspaceTabTypeDescriptor): unknown {
    return html`
      <button
        type="button"
        class="open-tab"
        data-tab-type=${descriptor.type}
        title=${descriptor.createContent === undefined
          ? (descriptor.placeholderNote ?? "该类型暂未提供内容")
          : descriptor.label}
        @click=${() => this.#emit({ action: "open-tab", tabType: descriptor.type })}
      >
        ${descriptor.label}
      </button>
    `;
  }

  #renderStatus(): unknown {
    return html`
      <span class="status" role="status" aria-label="会话状态">
        会话状态
        <strong class="session-status">${this.projectionStatus ?? "无会话"}</strong>
        revision
        <strong class="revision">${this.revision === null ? "—" : this.revision}</strong>
        连接
        <strong class="connection-status">${this.connectionStatus}</strong>
        ${this.connectionStatus === "reconnecting"
          ? html`<span class="reconnect-detail">
              第 ${this.reconnectAttempt} 次重试${this.retryDelayMs === null ? "" : ` · 约 ${this.retryDelayMs} ms 后重试`}
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
          ? html`<strong>连接已被同一会话的新连接取代</strong>`
          : this.connectionStatus === "reconnecting"
            ? html`<strong>连接中断,正在重连</strong>`
            : html`<strong>连接已断开</strong>`}
        <span>
          正在呈现最近一次公开投影${this.revision === null ? "" : `(revision ${this.revision})`}
          ——重连后自动 sync 对齐;本工作区不做任何本地 VM 执行降级。
        </span>
        ${this.connectionStatus === "reconnecting" && this.retryDelayMs !== null
          ? html`<span>第 ${this.reconnectAttempt} 次重试 · 约 ${this.retryDelayMs} ms 后重试</span>`
          : nothing}
        <button type="button" class="reconnect-button" @click=${() => this.#emit({ action: "reconnect" })}>
          手动重连
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
        测试环境已结束,请新建会话。
        <button type="button" class="new-session-button" @click=${() => this.#emit({ action: "new-session" })}>
          新建会话
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
        <strong>动作被拒绝</strong>
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
          aria-label="关闭错误提示"
          @click=${() => {
            this.errorDismissed = true;
          }}
        >
          知道了
        </button>
      </p>
    `;
  }

  /** explanation 的结构化事实字段(逐项呈现,零自由文本拼接)。 */
  #explanationFacts(explanation: NonNullable<PublicError["explanation"]>): unknown {
    const facts: string[] = [];
    if (explanation.regionId !== undefined) {
      facts.push(`区域 ${explanation.regionId}`);
    }
    if (explanation.permissions !== undefined) {
      facts.push(`权限 ${explanation.permissions}`);
    }
    if (explanation.valueHex !== undefined) {
      facts.push(`值 ${explanation.valueHex}`);
    }
    if (explanation.interpretedAs !== undefined) {
      facts.push(`按 ${explanation.interpretedAs} 解释`);
    }
    if (explanation.alignmentBytes !== undefined) {
      facts.push(`对齐 ${explanation.alignmentBytes} B`);
    }
    if (explanation.expectedBytesLength !== undefined) {
      facts.push(`期望 ${explanation.expectedBytesLength} B`);
    }
    if (explanation.actualBytesLength !== undefined) {
      facts.push(`实际 ${explanation.actualBytesLength} B`);
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
      return "测试环境已结束,请新建会话";
    }
    if (!this.hasSession) {
      return "尚未创建会话";
    }
    if (this.connectionStatus !== "connected") {
      return "动作通道未连接,等待重连";
    }
    return "重置会话到题目初始状态";
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

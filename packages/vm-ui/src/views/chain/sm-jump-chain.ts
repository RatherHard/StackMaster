/**
 * <sm-jump-chain> —— 跳转链视图(WP-F4 / FE-ST-07/09/10 窗口内部分)。
 *
 * 职责:
 *  - FE-ST-07:横向渲染跳转链,默认 ≤3 段(`JUMP_CHAIN_HORIZONTAL_LIMIT`);
 *    检测到循环时以 SVG 回环箭头打回(`loopBack` 段);超过 3 段提供
 *    "展开完整链"入口,点击后**在下方展开竖向完整链**(可收起);
 *  - FE-ST-09:链上每个地址可点击 → 发出 `viewport-jump` 事件——**组件只发
 *    事件**:落点窗口内由宿主处理滚动,窗口外宿主给"窗口外"反馈
 *    (`detail.withinWindow` 为组件侧提示,宿主可自行复核);
 *  - FE-ST-10:链末地址内容为可见字符时,追加引号可见字符延伸
 *    (复用 views/chain/visible-run 与 render/special-display 语义)。
 *
 * 解析语义(端序 = 小端、窗口外截断、循环检测)见 views/chain/resolve.ts。
 *
 * 纪律(CLAUDE.md 第十章):只依赖 `MemoryDataSource` 接口;控制流标记用
 * SVG(回环箭头);语义化 DOM(ol + button);动画只用 transform / opacity。
 */
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";

import type { MemoryDataSource } from "../../datasource/types.js";
import {
  JUMP_CHAIN_EXPANDED_LIMIT,
  JUMP_CHAIN_HORIZONTAL_LIMIT,
  chainLimitReached,
  resolveJumpChain,
  type JumpChainSegment,
} from "./resolve.js";
import { renderVisibleRun, visibleRunAt } from "./visible-run.js";

/** `viewport-jump` 事件 detail(FE-ST-09 视角跳转请求)。 */
export interface ViewportJumpDetail {
  /** 请求跳转的目标地址(0x + 小写)。 */
  readonly addressHex: string;
  /** 组件侧窗口内提示:链段可解引用 = true;窗口外段 = false(宿主可据此给"窗口外"反馈)。 */
  readonly withinWindow: boolean;
}

@customElement("sm-jump-chain")
export class SmJumpChain extends LitElement {
  /** 链起始地址(`0x` 前缀十六进制;空串 / 非法时静默空渲染)。 */
  @property({ type: String })
  startAddressHex = "";

  /** 数据源(视图唯一依赖面:MemoryDataSource 接口)。 */
  @property({ attribute: false })
  dataSource: MemoryDataSource | null = null;

  /** 竖向完整链展开态(展开入口仅当链超横向段数上限时提供)。 */
  @property({ type: Boolean })
  expanded = false;

  /**
   * 链延伸可用性(WP-F8 / FE-ST-08/10 调试档):宿主对调试数据源置 true——
   * 链末段窗口外时呈现「延伸」入口;解题档(false)维持窗口外截断现状。
   */
  @property({ type: Boolean })
  extendable = false;

  /**
   * 延伸处理器(WP-F8;宿主注入):点击「延伸」→ 宿主 prefetchWindow 目标段
   * 地址并入缓存 → 组件重解析(同步 resolveJumpChain 语义保留)。缺席 =
   * 不呈现延伸入口(解题档)。
   */
  @property({ attribute: false })
  extendHandler: ((addressHex: string) => Promise<void>) | null = null;

  /** 延伸进行中(按钮 aria-busy;防重入)。 */
  #extending = false;
  /** 延伸反馈(已延伸至缓存边界 / 失败文案;短暂承载)。 */
  #extendStatus: string | null = null;

  static override styles = css`
    :host {
      display: block;
      font-family: ui-monospace, monospace;
      font-size: 0.8125rem;
    }

    .chain {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem;
    }

    .chain-arrow {
      color: graytext;
    }

    .chain-address {
      padding: 0 0.25rem;
      border: 1px solid rgb(0 0 0 / 15%);
      border-radius: 4px;
      background: canvas;
      color: linktext;
      font: inherit;
      cursor: pointer;
    }

    .chain-address:hover {
      text-decoration: underline;
    }

    .chain-address:focus-visible,
    .chain-expand:focus-visible,
    .chain-extend-button:focus-visible {
      outline: 2px solid accentcolor;
      outline-offset: 1px;
    }

    .chain-loop {
      display: inline-flex;
      align-items: center;
      color: colortext;
    }

    .chain-expand {
      padding: 0 0.375rem;
      border: 1px solid rgb(0 0 0 / 15%);
      border-radius: 4px;
      background: none;
      color: graytext;
      font: inherit;
      font-size: 0.75rem;
      cursor: pointer;
    }

    /* 延伸入口 + 反馈(WP-F8 调试档;FE-ST-08/10)。 */
    .chain-extend-button {
      padding: 0 0.375rem;
      border: 1px solid rgb(0 0 0 / 20%);
      border-radius: 4px;
      background: canvas;
      color: linktext;
      font: inherit;
      font-size: 0.75rem;
      cursor: pointer;
    }

    .chain-extend-button:disabled {
      color: graytext;
      cursor: not-allowed;
    }

    .chain-extend-status {
      color: graytext;
      font-family: system-ui, sans-serif;
      font-size: 0.75rem;
    }

    /* 竖向完整链(展开态):一行一段,段号 + 地址 + 值。 */
    .chain-vertical {
      margin: 0.25rem 0 0;
      padding-inline-start: 1.25rem;
    }

    .chain-vertical li {
      padding-block: 0.125rem;
    }

    .chain-value,
    .chain-outside {
      margin-inline-start: 0.5rem;
      color: graytext;
      font-family: system-ui, sans-serif;
      font-size: 0.75rem;
    }

    .visible-run {
      margin-inline-start: 0.25rem;
      color: colortext;
    }
  `;

  protected override render(): TemplateResult | typeof nothing {
    if (this.dataSource === null || this.startAddressHex === "") {
      return nothing;
    }
    const horizontal = this.#resolve(JUMP_CHAIN_HORIZONTAL_LIMIT);
    if (horizontal === null) {
      return nothing;
    }
    const limitReached = chainLimitReached(horizontal, JUMP_CHAIN_HORIZONTAL_LIMIT);
    const full = this.expanded ? this.#resolve(JUMP_CHAIN_EXPANDED_LIMIT) : null;
    // 链末可见字符延伸按当前展示链的末段地址读取(FE-ST-10)。
    const visibleRun = this.#chainEndRun(full ?? horizontal);
    return html`
      <div class="chain" part="chain">
        <span class="chain-horizontal">
          ${horizontal.map((segment, index) => this.#renderSegment(segment, index))}
          ${limitReached ? this.#renderTrailingTarget(horizontal) : nothing}
        </span>
        ${this.#renderExtendEntry(horizontal)} ${visibleRun === "" ? nothing : renderVisibleRun(visibleRun)}
        ${limitReached ? this.#renderExpandToggle() : nothing}
        ${full === null ? nothing : this.#renderVertical(full)}
      </div>
    `;
  }

  /**
   * 延伸入口(WP-F8 / FE-ST-08/10 调试档骨架):链末段窗口外 + 宿主注入
   * 延伸处理器时呈现;点击 → prefetch → 重解析,呈现"已延伸至缓存边界"
   * 反馈(仍窗口外)或继续延伸后的新链。
   */
  #renderExtendEntry(segments: readonly JumpChainSegment[]): TemplateResult | typeof nothing {
    const last = segments.at(-1);
    if (
      !this.extendable ||
      this.extendHandler === null ||
      last === undefined ||
      last.outsideWindow !== true
    ) {
      return nothing;
    }
    return html`
      <button
        type="button"
        class="chain-extend-button"
        data-extend-address=${last.addressHex}
        ?disabled=${this.#extending}
        aria-busy=${this.#extending ? "true" : "false"}
        title="请求该地址窗口并延伸链(调试模式)"
        @click=${() => this.#runExtend(last.addressHex)}
      >
        ${this.#extending ? "延伸中…" : "延伸"}
      </button>
      ${this.#extendStatus === null
        ? nothing
        : html`<span class="chain-extend-status" role="status">${this.#extendStatus}</span>`}
    `;
  }

  async #runExtend(addressHex: string): Promise<void> {
    const handler = this.extendHandler;
    if (handler === null || this.#extending) {
      return;
    }
    this.#extending = true;
    this.#extendStatus = null;
    this.requestUpdate();
    try {
      await handler(addressHex);
      const resolved = this.#resolve(JUMP_CHAIN_HORIZONTAL_LIMIT);
      const stillOutside = resolved?.at(-1)?.outsideWindow === true;
      this.#extendStatus = stillOutside ? "已延伸至缓存边界" : null;
    } catch {
      this.#extendStatus = "延伸失败(调试通道未连接或地址不可达)";
    } finally {
      this.#extending = false;
      this.requestUpdate();
    }
  }

  /** 解析链:起始地址非法等解析失败 → null(静默空渲染,不抛错)。 */
  #resolve(maxSegments: number): JumpChainSegment[] | null {
    if (this.dataSource === null) {
      return null;
    }
    try {
      return resolveJumpChain(this.startAddressHex, this.dataSource, { maxSegments });
    } catch {
      return null;
    }
  }

  /** 单段:段前箭头 + 地址芯片(点击 → viewport-jump)+ 回环标记。 */
  #renderSegment(segment: JumpChainSegment, index: number): TemplateResult {
    return html`
      ${index > 0 ? html`<span class="chain-arrow" aria-hidden="true">→</span>` : nothing}
      ${this.#renderAddressChip(segment.addressHex, segment.outsideWindow !== true)}
      ${segment.loopBack === true ? this.#renderLoopMark(segment) : nothing}
    `;
  }

  /** 地址芯片(链上每个地址可点击,FE-ST-09)。 */
  #renderAddressChip(addressHex: string, withinWindow: boolean): TemplateResult {
    return html`<button
      type="button"
      class="chain-address"
      data-address="${addressHex}"
      title="跳转到 ${addressHex}${withinWindow ? "" : "(窗口外)"}"
      @click=${() => this.#emitJump(addressHex, withinWindow)}
    >${addressHex}</button>`;
  }

  /** 回环箭头(SVG,FE-ST-07"循环显示时箭头打回";屏幕阅读器可感知)。 */
  #renderLoopMark(segment: JumpChainSegment): TemplateResult {
    return html`<span
      class="chain-loop"
      role="img"
      aria-label="回环:目标 ${segment.targetAddressHex ?? segment.addressHex} 已在链中出现"
      title="回环:该地址已在链中出现"
    >
      <svg
        class="chain-loop-icon"
        viewBox="0 0 16 16"
        width="12"
        height="12"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M13.2 8.6a5.2 5.2 0 1 1-1.5-4.2"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
        <path
          d="M13.8 1.4v3.4h-3.4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </span>`;
  }

  /** 横向截断时的尾随目标芯片(第 maxSegments+1 跳地址,可点击跳转)。 */
  #renderTrailingTarget(segments: readonly JumpChainSegment[]): TemplateResult | typeof nothing {
    const last = segments.at(-1);
    const target = last?.targetAddressHex;
    if (last === undefined || target === undefined) {
      return nothing;
    }
    return html`
      <span class="chain-arrow" aria-hidden="true">→</span>
      ${this.#renderAddressChip(target, true)}
    `;
  }

  /** 展开 / 收起入口(仅链超横向段数上限时渲染)。 */
  #renderExpandToggle(): TemplateResult {
    return html`<button
      type="button"
      class="chain-expand"
      aria-expanded="${this.expanded}"
      @click=${() => {
        this.expanded = !this.expanded;
      }}
    >
      ${this.expanded ? "收起" : "展开完整链"}
    </button>`;
  }

  /** 竖向完整链(展开态):一行一段,段地址可点击 + 值 / 窗口外 / 回环标记。 */
  #renderVertical(segments: readonly JumpChainSegment[]): TemplateResult {
    return html`<ol class="chain-vertical">
      ${segments.map(
        (segment, index) => html`<li data-index="${index}">
          ${this.#renderAddressChip(segment.addressHex, segment.outsideWindow !== true)}
          ${segment.valueHex === undefined
            ? nothing
            : html`<span class="chain-value">值 ${segment.valueHex}</span>`}
          ${segment.loopBack === true
            ? html`<span class="chain-value">(回环)</span>`
            : nothing}
          ${segment.outsideWindow === true
            ? html`<span class="chain-outside">(窗口外)</span>`
            : nothing}
        </li>`,
      )}
    </ol>`;
  }

  /** 链末可见字符延伸(FE-ST-10):按展示链末段地址读取;不可读 → 空串。 */
  #chainEndRun(segments: readonly JumpChainSegment[]): string {
    const last = segments.at(-1);
    if (last === undefined || this.dataSource === null) {
      return "";
    }
    try {
      return visibleRunAt(this.dataSource, last.addressHex);
    } catch {
      return "";
    }
  }

  /** 发出视角跳转请求(FE-ST-09):组件只发事件,滚动 / 反馈归宿主。 */
  #emitJump(addressHex: string, withinWindow: boolean): void {
    this.dispatchEvent(
      new CustomEvent<ViewportJumpDetail>("viewport-jump", {
        detail: { addressHex, withinWindow },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sm-jump-chain": SmJumpChain;
  }
}

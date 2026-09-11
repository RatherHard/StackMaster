/**
 * <sm-instruction-view> —— 指令视图(WP-F8 / FE-IN-01~08,调试模式档)。
 *
 * 数据源 = 调试通道缓存(DebugDataSource;公开档 ProjectionDataSource 无
 * `instructionStream`,本视图对公开档呈现"仅在调试模式可用"引导,不伪造):
 *  - **FE-IN-01**:纵向一行一条指令,地址升序(低地址在上),虚拟列表;
 *  - **FE-IN-02** 三段布局:左 = 指令最低位字节地址;中 = 伪机器码 bytesHex
 *    (推送条目可选字段,缺席呈现"—"而非占位伪造);右 = 伪汇编文本
 *    (独立对齐);
 *  - **FE-IN-03**:jumpTargetHex(仅控制转移条目出现)延展显示,点击跳转
 *    (覆盖面内滚动;覆盖面外走 FE-IN-06 同一 prefetch-重试管线);
 *  - **FE-IN-04** 函数表面板:attach 推送(debug_function_table),按地址
 *    有序,点击跳转到函数位置;
 *  - **FE-IN-05** rip 锚点:最新暂停地址(attach paused / debug_paused /
 *    RIP 寄存器回退)行高亮 + 回锚;
 *  - **FE-IN-06** 地址跳转:推送覆盖面内滚动定位;超出覆盖面 → 自动
 *    `prefetchWindow` 后重试一次,仍不可达 → "窗口外"反馈(协议 v1 无
 *    C→S 拉取帧,指令流只由暂停推送,窗口拉取补的是数据字节面);
 *  - **FE-IN-07** 检索双入口分开呈现:字节检索 = `debug_search` 全内存
 *    (异步,命中点击跳转);指令文本检索 = 缓存指令流过滤(命中即滚动);
 *  - **FE-IN-08** 行断点:断点集合 = 调试档 UI 状态,行上添加/移除;
 *    "运行到断点"由工作区菜单承载(FE-WS-04c,断点集合 = 当前集合)。
 *
 * 暂停原因呈现(debug_paused):step = 单步落点;breakpoint = 断点命中;
 * program_halt = 程序自行停机;budget = 预算耗尽确定性暂停(各自文案)。
 *
 * 数据纪律:只依赖 MemoryDataSource 接口 + DebugDataSource 调试档扩展面
 * (duck-typing 探测 `instructionStream` / `instructions` / `prefetchWindow`);
 * 变更通知经 `dataSource.onChange`(调试通道推送异步到达,视图自订阅;
 * 公开投影的合帧仍归 SessionClient,本视图不接触 client/store)。
 * 动画纪律:零动画;语义化 DOM(role=table/row + 原生 button/input)。
 */
import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { SmWindowList } from "../virtual/sm-window-list.js";

import type { DebugPauseReason } from "@stackmaster/protocol";

import { LocaleController, t } from "../../i18n/i18n.js";
import type { DebugDataSource, DebugInstructionEntry, DebugMemorySearchHit } from "../../datasource/debug-data-source.js";
import type { MemoryDataSource } from "../../datasource/types.js";
import {
  addressToHex,
  formatAddressHex,
  normalizeBytesHex,
  parseAddressHex,
} from "../../render/hex.js";
import { ensureSmThemeStyles } from "../../theme/theme-tokens.js";

/** 十六进制段分组宽度(4 字节一组,与字节视图一致)。 */
const HEX_GROUP_BYTES = 4;
/** 左段地址展示宽度(32 位习惯;超宽不截断)。 */
const ADDRESS_MIN_DIGITS = 8;
/** 检索命中列表展示上限(字节 / 文本两入口共用)。 */
const SEARCH_DISPLAY_LIMIT = 8;
/** 地址跳转 / 跳转目标点击的窗口拉取字节数。 */
const JUMP_PREFETCH_BYTES = 64;

/** `breakpoints-changed` 事件 detail(工作区更新"运行到断点"可用性)。 */
export interface BreakpointsChangedDetail {
  readonly breakpoints: readonly string[];
}

/**
 * 暂停原因 → 呈现文案(debug_paused 封闭四值;不含任何权威结论)。
 * 当前 locale 取词(WP-53;i18n 键 debug.paused*,zh-CN 值 = 现行文案原样)。
 */
export function pausedReasonText(reason: DebugPauseReason): string {
  switch (reason) {
    case "step":
      return t("debug.pausedStep");
    case "breakpoint":
      return t("debug.pausedBreakpoint");
    case "program_halt":
      return t("debug.pausedHalt");
    case "budget":
      return t("debug.pausedBudget");
  }
}

/** 调试档数据源切面(duck-typing 探测结果;非 DebugDataSource 时为 null)。 */
function asDebugDataSource(dataSource: MemoryDataSource | null): DebugDataSource | null {
  if (
    dataSource !== null &&
    typeof (dataSource as Partial<DebugDataSource>).instructionStream === "function" &&
    typeof (dataSource as Partial<DebugDataSource>).instructions === "function" &&
    typeof (dataSource as Partial<DebugDataSource>).prefetchWindow === "function"
  ) {
    return dataSource as DebugDataSource;
  }
  return null;
}

@customElement("sm-instruction-view")
export class SmInstructionView extends LitElement {
  /** 数据源(调试档 = DebugDataSource;公开档 / null → 调试模式引导空态)。 */
  @property({ attribute: false })
  dataSource: MemoryDataSource | null = null;

  // ── 内部状态(rebuild 填充;非响应式)──
  #debug: DebugDataSource | null = null;
  #rows: readonly DebugInstructionEntry[] = [];
  #pausedAddress: string | null = null;
  #pausedReason: DebugPauseReason | null = null;
  #attachedStatus: string | null = null;
  #functions: readonly { readonly label: string; readonly startAddressHex: string }[] = [];
  #status: string | null = null;
  #byteHits: readonly DebugMemorySearchHit[] = [];
  #byteHitsTruncated = false;
  #textHits: readonly DebugInstructionEntry[] = [];
  /** 待消费滚动地址(updated 里消费;行索引由 rebuild 后重查)。 */
  #pendingScrollAddress: string | null = null;
  #unsubscribe: (() => void) | null = null;

  /** i18n:连接时消费 data-sm-language 锚;locale 变化即重渲染(WP-53)。 */
  readonly #i18n = new LocaleController(this);

  static override styles = css`
    :host {
      display: block;
      block-size: 24rem;
      border: 1px solid var(--sm-border, rgb(0 0 0 / 15%));
      border-radius: 8px;
      background: canvas;
      color: canvastext;
      font-family: ui-monospace, "Cascadia Mono", "Source Code Pro", Menlo, Consolas, monospace;
      font-size: 0.8125rem;
    }

    .layout {
      display: flex;
      flex-direction: column;
      block-size: 100%;
    }

    .toolbar {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      padding: 0.5rem 0.75rem;
      border-block-end: 1px solid var(--sm-divider, rgb(0 0 0 / 10%));
    }

    .toolbar-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .heading {
      margin: 0;
      font-size: 0.95rem;
      font-weight: 600;
    }

    button,
    input {
      font: inherit;
    }

    .anchor-chip {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
    }

    .paused-line {
      margin: 0;
      font-size: 0.75rem;
      color: canvastext;
    }

    .status-line {
      margin: 0;
      min-block-size: 1.1em;
      font-size: 0.75rem;
      color: graytext;
    }

    .table {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-block-size: 0;
    }

    sm-window-list.instruction-list {
      flex: 1;
      min-block-size: 0;
      overscroll-behavior: contain;
    }

    .instruction-row {
      display: grid;
      grid-template-columns: 14ch 18ch 1fr;
      align-items: baseline;
      column-gap: 1ch;
      padding-inline: 0.75rem;
      line-height: 1.6;
    }

    .instruction-row.paused-row {
      background: color-mix(in srgb, highlight 14%, transparent);
    }

    .row-address {
      white-space: pre;
    }

    .row-bytes {
      white-space: pre;
      color: graytext;
    }

    .row-text {
      white-space: pre-wrap;
    }

    .jump-target {
      margin-inline-start: 1ch;
      padding: 0 0.25rem;
      border: 1px solid var(--sm-border, rgb(0 0 0 / 15%));
      border-radius: 4px;
      background: canvas;
      color: linktext;
      font: inherit;
      font-size: 0.75rem;
      cursor: pointer;
    }

    .jump-target:focus-visible,
    .breakpoint-toggle:focus-visible,
    .function-jump:focus-visible,
    .anchor-rewind:focus-visible,
    .search-hit:focus-visible {
      outline: 2px solid accentcolor;
      outline-offset: 1px;
    }

    .breakpoint-toggle {
      margin-inline-end: 0.5ch;
      padding: 0 0.25rem;
      border: 1px solid var(--sm-border, rgb(0 0 0 / 15%));
      border-radius: 4px;
      background: canvas;
      color: canvastext;
      cursor: pointer;
      line-height: 1.2;
    }

    .breakpoint-toggle[aria-pressed="true"] {
      color: var(--sm-danger, crimson);
      border-color: var(--sm-danger, crimson);
    }

    .function-panel,
    .search-panel {
      margin: 0;
      padding: 0.25rem 0.75rem;
      border-block-start: 1px solid var(--sm-divider, rgb(0 0 0 / 10%));
      font-size: 0.75rem;
    }

    .function-panel summary,
    .search-panel summary {
      cursor: pointer;
      color: graytext;
    }

    .function-list,
    .search-hits {
      margin: 0.25rem 0 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
    }

    .function-jump,
    .search-hit {
      display: inline-flex;
      gap: 0.375rem;
      padding: 0 0.25rem;
      border: none;
      background: none;
      color: linktext;
      font: inherit;
      cursor: pointer;
      text-align: start;
    }

    .hit-bytes {
      color: graytext;
    }

    .empty,
    .guide {
      margin: 0;
      padding: 1rem;
      color: graytext;
    }
  `;

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("dataSource")) {
      this.#detachSourceListener();
      this.#debug = asDebugDataSource(this.dataSource);
      this.#attachSourceListener();
      this.#rebuild();
    }
  }

  protected override updated(): void {
    if (this.#pendingScrollAddress !== null) {
      const address = this.#pendingScrollAddress;
      this.#pendingScrollAddress = null;
      this.#scrollAddressToView(address);
    }
  }

  override disconnectedCallback(): void {
    this.#detachSourceListener();
    super.disconnectedCallback();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // LocaleController 经构造副作用注册(Lit addController);显式读点满足 lint。
    void this.#i18n;
    // 主题锚样式表(幂等):变量经 data-sm-theme 宿主锚继承穿透 shadow DOM。
    ensureSmThemeStyles(this.ownerDocument ?? document);
  }

  // ── 公共 API(工作区接线面)──────────────────────────────────────────────

  /** 宿主驱动刷新(与 sm-byte-view 同约定;onChange 订阅外的手动入口)。 */
  refresh(): void {
    this.#rebuild();
    this.requestUpdate();
  }

  /**
   * 跳转到目标地址(FE-IN-06 管线;函数表 / 检索命中 / jumpTarget 共用):
   * 覆盖面内滚动;否则 prefetchWindow 后重试一次;仍不可达 → 窗口外反馈。
   * 异步(prefetch 路径);fire-and-forget,状态行承载结果。
   */
  jumpToAddress(addressHex: string): void {
    void this.#jumpToAddressAsync(addressHex);
  }

  // ── 数据源事件与重建 ─────────────────────────────────────────────────────

  #attachSourceListener(): void {
    const debug = this.#debug;
    if (debug === null) {
      return;
    }
    this.#unsubscribe = debug.onChange(() => {
      this.#rebuild();
      this.requestUpdate();
    });
  }

  #detachSourceListener(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  #rebuild(): void {
    const debug = this.#debug;
    if (debug === null) {
      this.#rows = [];
      this.#functions = [];
      return;
    }
    this.#rows = [...debug.instructions()];
    this.#functions = [...debug.functions].map((entry) => ({
      label: entry.label,
      startAddressHex: entry.startAddressHex,
    }));
    const paused = debug.paused;
    this.#pausedReason = paused === null || paused === undefined ? null : paused.reason;
    // rip 锚点三级回退:debug_paused → attach 携带 paused → RIP 寄存器公开值。
    const ripFromRegister = debug
      .registers()
      .find((register) => register.name.toLowerCase() === "rip");
    this.#pausedAddress =
      (debug.pausedAddressHex ?? normalizeAddressSafe(ripFromRegister?.valueHex ?? null)) ?? null;
    this.#attachedStatus = debug.attached?.status ?? null;
  }

  // ── 交互 ─────────────────────────────────────────────────────────────────

  async #jumpToAddressAsync(addressHex: string): Promise<void> {
    const debug = this.#debug;
    if (debug === null) {
      return;
    }
    let target: string;
    try {
      target = formatAddressHex(addressHex, ADDRESS_MIN_DIGITS);
    } catch {
      this.#status = t("instr.jumpUnrecognized");
      this.requestUpdate();
      return;
    }
    if (this.#locateAndScroll(addressHex)) {
      this.#status = t("common.jumpOk", { target });
      this.requestUpdate();
      return;
    }
    // 覆盖面外:自动 prefetchWindow 后重试一次(FE-IN-06 定案)。
    this.#status = t("instr.prefetching", { target });
    this.requestUpdate();
    try {
      await debug.prefetchWindow(addressHex, JUMP_PREFETCH_BYTES);
    } catch {
      this.#status = t("common.prefetchFailed", { target });
      this.requestUpdate();
      return;
    }
    this.#rebuild();
    this.requestUpdate();
    if (this.#locateAndScroll(addressHex)) {
      this.#status = t("common.jumpOk", { target });
    } else {
      // 指令流只由暂停推送(协议 v1 无拉取帧);窗口字节已入缓存,字节视图可看。
      this.#status = t("instr.outOfCoverage", { target });
    }
    this.requestUpdate();
  }

  /** 覆盖面内定位:命中行滚动;数据字节未缓存时返回 false(交 prefetch 管线)。 */
  #locateAndScroll(addressHex: string): boolean {
    const debug = this.#debug;
    if (debug === null) {
      return false;
    }
    try {
      const normalized = formatAddressHex(addressHex, 1);
      const hit = debug.instructions().some((entry) => entry.addressHex === normalized);
      if (!hit) {
        return false;
      }
      this.#pendingScrollAddress = normalized;
      this.requestUpdate();
      return true;
    } catch {
      return false;
    }
  }

  #scrollAddressToView(addressHex: string): void {
    const index = this.#rows.findIndex((entry) => entry.addressHex === addressHex);
    if (index < 0) {
      return;
    }
    const list = this.renderRoot.querySelector("sm-window-list") as SmWindowList | null;
    if (list === null) {
      return;
    }
    try {
      list.scrollToIndex(index, "center");
    } catch {
      // 无布局环境(jsdom)滚动增强失败静默(与字节视图同口径)。
    }
  }

  #onJumpSubmit(event: SubmitEvent): void {
    event.preventDefault();
    const input = this.renderRoot.querySelector<HTMLInputElement>(".jump-input");
    if (input === null) {
      return;
    }
    void this.#jumpToAddressAsync(input.value.trim());
  }

  #onByteSearchSubmit(event: SubmitEvent): void {
    event.preventDefault();
    const input = this.renderRoot.querySelector<HTMLInputElement>(".byte-search-input");
    const debug = this.#debug;
    if (input === null || debug === null) {
      return;
    }
    let pattern: string;
    try {
      pattern = normalizeBytesHex(input.value.trim());
    } catch {
      this.#status = t("common.searchInvalidPattern");
      this.requestUpdate();
      return;
    }
    void debug
      .searchAllMemory(pattern)
      .then((result) => {
        this.#byteHits = result.hits.slice(0, SEARCH_DISPLAY_LIMIT);
        this.#byteHitsTruncated = result.truncated;
        this.#status =
          result.hits.length === 0
            ? t("instr.searchNoHits")
            : t("instr.searchHits", {
                count: result.hits.length,
                truncated: result.truncated ? t("instr.searchTruncatedSuffix") : "",
              });
        this.requestUpdate();
      })
      .catch(() => {
        this.#status = t("instr.searchFailed");
        this.requestUpdate();
      });
    this.#status = t("instr.searching");
    this.requestUpdate();
  }

  #onTextSearchSubmit(event: SubmitEvent): void {
    event.preventDefault();
    const input = this.renderRoot.querySelector<HTMLInputElement>(".text-search-input");
    if (input === null) {
      return;
    }
    const needle = input.value.trim().toLowerCase();
    if (needle.length === 0) {
      this.#textHits = [];
      this.#status = t("instr.textSearchEmpty");
      this.requestUpdate();
      return;
    }
    // 指令文本检索 = 缓存指令流过滤(推送覆盖面内;FE-IN-07 第二入口)。
    this.#textHits = this.#rows
      .filter((entry) => entry.text.toLowerCase().includes(needle))
      .slice(0, SEARCH_DISPLAY_LIMIT);
    this.#status =
      this.#textHits.length === 0 ? t("instr.textSearchNoHits") : null;
    this.requestUpdate();
  }

  #onBreakpointToggle(addressHex: string): void {
    this.#debug?.toggleBreakpoint(addressHex);
    // 断点集合变化经 onChange 事件回流 → rebuild;此处补发工作区同步事件。
    const breakpoints = this.#debug?.breakpoints ?? [];
    this.dispatchEvent(
      new CustomEvent<BreakpointsChangedDetail>("breakpoints-changed", {
        detail: { breakpoints },
        bubbles: true,
        composed: true,
      }),
    );
  }

  #renderRows(): TemplateResult {
    const breakpoints = new Set(this.#debug?.breakpoints ?? []);
    return html`<sm-window-list
      class="instruction-list"
      role="rowgroup"
      .items=${this.#rows}
      .renderItem=${(entry: DebugInstructionEntry) =>
        this.#renderRow(entry, breakpoints.has(entry.addressHex))}
    ></sm-window-list>`;
  }

  #renderRow(entry: DebugInstructionEntry, isBreakpoint: boolean): TemplateResult {
    const pausedRow = this.#pausedAddress !== null && entry.addressHex === this.#pausedAddress;
    const jumpTargetHex = entry.jumpTargetHex;
    return html`
      <div
        class="instruction-row${pausedRow ? " paused-row" : ""}"
        role="row"
        data-instruction-address=${entry.addressHex}
      >
        <span class="row-address" role="cell">
          <button
            type="button"
            class="breakpoint-toggle"
            data-breakpoint-address=${entry.addressHex}
            aria-pressed=${isBreakpoint ? "true" : "false"}
            aria-label=${t("instr.breakpointAria", {
              address: formatAddressHex(entry.addressHex, ADDRESS_MIN_DIGITS),
            })}
            title=${isBreakpoint ? t("instr.breakpointRemove") : t("instr.breakpointAdd")}
            @click=${() => this.#onBreakpointToggle(entry.addressHex)}
          >
            ${isBreakpoint ? "●" : "○"}
          </button>${formatAddressHex(entry.addressHex, ADDRESS_MIN_DIGITS)}
        </span>
        <span class="row-bytes" role="cell">
          ${entry.bytesHex === undefined
            ? html`<span class="bytes-absent">—</span>`
            : formatBytesHexGroupedSafe(entry.bytesHex, HEX_GROUP_BYTES)}
        </span>
        <span class="row-text" role="cell"
          >${entry.text}${jumpTargetHex === undefined
            ? nothing
            : html`<button
                type="button"
                class="jump-target"
                data-jump-target=${jumpTargetHex}
                title=${t("instr.jumpTargetTitle", { target: safeFormat(jumpTargetHex, ADDRESS_MIN_DIGITS) })}
                @click=${() => this.jumpToAddress(jumpTargetHex)}
              >
                → ${safeFormat(jumpTargetHex, ADDRESS_MIN_DIGITS)}
              </button>`}</span
        >
      </div>
    `;
  }

  protected override render(): unknown {
    if (this.#debug === null) {
      return html`
        <section class="instruction-view" aria-label=${t("instr.aria")}>
          <header class="toolbar">
            <h3 class="heading">${t("tab.instruction")}</h3>
          </header>
          <p class="guide" role="status">
            ${t("instr.guide")}
          </p>
        </section>
      `;
    }
    return html`
      <section class="instruction-view" aria-label=${t("instr.aria")}>
        <header class="toolbar">
          <div class="toolbar-row">
            <h3 class="heading">${t("tab.instruction")}</h3>
            ${this.#renderAnchor()}
          </div>
          <div class="toolbar-row">
            <form class="jump-form" @submit=${this.#onJumpSubmit}>
              <input
                class="jump-input"
                type="text"
                aria-label=${t("instr.jumpAria")}
                placeholder=${t("instr.jumpPlaceholder")}
              />
              <button type="submit">${t("common.jumpButton")}</button>
            </form>
            <form class="byte-search-form" @submit=${this.#onByteSearchSubmit}>
              <input
                class="byte-search-input"
                type="text"
                aria-label=${t("instr.byteSearchAria")}
                placeholder=${t("instr.byteSearchPlaceholder")}
              />
              <button type="submit">${t("instr.byteSearchButton")}</button>
            </form>
            <form class="text-search-form" @submit=${this.#onTextSearchSubmit}>
              <input
                class="text-search-input"
                type="text"
                aria-label=${t("instr.textSearchAria")}
                placeholder=${t("instr.textSearchPlaceholder")}
              />
              <button type="submit">${t("instr.textSearchButton")}</button>
            </form>
          </div>
          ${this.#renderPausedLine()}
          <p class="status-line" role="status">${this.#status ?? ""}</p>
        </header>
        ${this.#rows.length === 0
          ? html`<p class="empty" role="status">
              ${t("instr.emptyStream")}
            </p>`
          : html`<div class="table" role="table" aria-label=${t("instr.tableAria")}>
              <div class="instruction-row header-row" role="row">
                <span class="row-address" role="columnheader">${t("instr.colAddress")}</span>
                <span class="row-bytes" role="columnheader">${t("instr.colBytes")}</span>
                <span class="row-text" role="columnheader">${t("instr.colText")}</span>
              </div>
              ${this.#renderRows()}
            </div>`}
        ${this.#renderByteHits()}
        ${this.#renderTextHits()}
        ${this.#renderFunctionPanel()}
      </section>
    `;
  }

  #renderAnchor(): unknown {
    const paused = this.#pausedAddress;
    if (paused === null) {
      return html`<span class="anchor-chip">${t("instr.noPauseAddress")}</span>`;
    }
    const display = safeFormat(paused, ADDRESS_MIN_DIGITS);
    return html`
      <span class="anchor-chip">
        <span class="anchor-value">${t("instr.ripAnchor", { address: display })}</span>
        <button
          type="button"
          class="anchor-rewind"
          aria-label=${t("instr.anchorRewindAria")}
          @click=${() => this.jumpToAddress(paused)}
        >
          ${t("instr.anchorRewind")}
        </button>
      </span>
    `;
  }

  #renderPausedLine(): unknown {
    const reason = this.#pausedReason;
    if (reason === null) {
      return this.#attachedStatus === null
        ? html`<p class="paused-line" role="status">${t("instr.notAttached")}</p>`
        : html`<p class="paused-line" role="status">
            ${t("instr.attachedStatus", { status: this.#attachedStatus })}
          </p>`;
    }
    const address =
      this.#pausedAddress === null ? "" : ` @ ${safeFormat(this.#pausedAddress, ADDRESS_MIN_DIGITS)}`;
    return html`<p class="paused-line" role="status">
      ${t("debug.pausedAt", { reason: pausedReasonText(reason), address })}
    </p>`;
  }

  #renderByteHits(): unknown {
    if (this.#byteHits.length === 0) {
      return nothing;
    }
    return html`
      <details class="search-panel" open>
        <summary>${t("instr.byteHitsSummary")}</summary>
        <ul class="search-hits">
          ${this.#byteHits.map(
            (hit) => html`
              <li>
                <button
                  type="button"
                  class="search-hit"
                  data-hit-address=${hit.addressHex}
                  @click=${() => this.jumpToAddress(hit.addressHex)}
                >
                  ${safeFormat(hit.addressHex, ADDRESS_MIN_DIGITS)}
                  <span class="hit-bytes">${hit.matchedHex}</span>
                </button>
              </li>
            `,
          )}
        </ul>
        ${this.#byteHitsTruncated ? html`<p class="status-line">${t("instr.hitsTruncated")}</p>` : nothing}
      </details>
    `;
  }

  #renderTextHits(): unknown {
    if (this.#textHits.length === 0) {
      return nothing;
    }
    return html`
      <details class="search-panel" open>
        <summary>${t("instr.textHitsSummary")}</summary>
        <ul class="search-hits">
          ${this.#textHits.map(
            (entry) => html`
              <li>
                <button
                  type="button"
                  class="search-hit"
                  data-text-hit-address=${entry.addressHex}
                  @click=${() => this.jumpToAddress(entry.addressHex)}
                >
                  ${safeFormat(entry.addressHex, ADDRESS_MIN_DIGITS)}
                  <span class="hit-bytes">${entry.text}</span>
                </button>
              </li>
            `,
          )}
        </ul>
      </details>
    `;
  }

  #renderFunctionPanel(): unknown {
    if (this.#functions.length === 0) {
      return nothing;
    }
    return html`
      <details class="function-panel">
        <summary>${t("instr.functionTable", { count: this.#functions.length })}</summary>
        <ul class="function-list">
          ${this.#functions.map(
            (entry) => html`
              <li>
                <button
                  type="button"
                  class="function-jump"
                  data-function-address=${entry.startAddressHex}
                  @click=${() => this.jumpToAddress(entry.startAddressHex)}
                >
                  ${safeFormat(entry.startAddressHex, ADDRESS_MIN_DIGITS)}
                  <span>${entry.label}</span>
                </button>
              </li>
            `,
          )}
        </ul>
      </details>
    `;
  }
}

/** 展示层格式化兜底(非法地址原样呈现,渲染层不抛错)。 */
function safeFormat(addressHex: string, minDigits: number): string {
  try {
    return formatAddressHex(addressHex, minDigits);
  } catch {
    return addressHex;
  }
}

/** 地址归一化兜底(寄存器值等外部输入 → 缓存键同形;非法原样小写返回)。 */
function normalizeAddressSafe(addressHex: string | null): string | null {
  if (addressHex === null) {
    return null;
  }
  try {
    return addressToHex(parseAddressHex(addressHex));
  } catch {
    return addressHex.toLowerCase();
  }
}

/** bytesHex 分组展示兜底(非法形态原样呈现)。 */
function formatBytesHexGroupedSafe(bytesHex: string, groupBytes: number): string {
  try {
    return groupBytesHex(bytesHex, groupBytes);
  } catch {
    return bytesHex;
  }
}

/** bytesHex 分组(每 groupBytes 字节一组,组间空格)。 */
function groupBytesHex(bytesHex: string, groupBytes: number): string {
  const normalized = normalizeBytesHex(bytesHex);
  const totalBytes = normalized.length / 2;
  const groups: string[] = [];
  for (let start = 0; start < totalBytes; start += groupBytes) {
    groups.push(normalized.slice(start * 2, Math.min(start + groupBytes, totalBytes) * 2));
  }
  return groups.join(" ");
}

declare global {
  interface HTMLElementTagNameMap {
    "sm-instruction-view": SmInstructionView;
  }
}

/**
 * <sm-byte-view> —— 字节视图本体(WP-F3;栈视图与自由视图共用默认形态)。
 *
 * FE-ST-01/02/03/04/06 与 FE-FV-01/02/03 的公开视图档口径:
 *  - **三段布局**(FE-ST-02):左段 = 行基址(`formatAddressHex(hex, 8)`),
 *    中段 = 十六进制字节(`formatBytesHexGrouped`,含窗口外 cell 时逐 cell
 *    退化为 `cell-outside` 标记),右段 = 特殊显示逐 cell
 *    (`renderSpecialDisplayCell`,窗口外 cell 自动携带 `cell-outside`);
 *  - **高地址在下**(FE-ST-01):行按地址升序渲染(低地址在视口上方);
 *  - **语义化 DOM + 虚拟列表**(硬门槛):role=table/row/cell 的 DOM 行 +
 *    `<lit-virtualizer>` 虚拟化——区域窗口最大 4096 B = 512 行(网格外扩
 *    至多 513 行),虚拟化必须真实生效;
 *  - **rsp/rbp 视角锚点**(FE-ST-04 公开档):进入视图/切区域时视口锚定
 *    rsp(否则顶部);锚点行高亮 + 回锚按钮;值在窗口外 → 明示
 *    「<寄存器> 内容不在可见窗口」(M13:不渲染空白、不报错);
 *  - **对齐偏移可调**(FE-ST-03 / FE-FV-03):偏移 0..7,行切分见
 *    alignment.ts(窗口内重排,越窗口地址以窗口外 cell 呈现);
 *  - **窗口内导航与检索**(FE-ST-06 公开档,M3 口径):地址/偏移跳转仅窗口内
 *    可达(窗口外输入给反馈不报错);检索调 `dataSource.search()`(仅已下发
 *    窗口字节),命中点击滚动到行,跨区域命中先切区域。
 *
 * **数据纪律(评审解耦的关键约束)**:本组件只依赖 `MemoryDataSource` 接口
 * (regions/registers/bytesRows/search 全是快照纯读),禁止绕过接口直读
 * SessionClient / ProjectionStore。变更通知由宿主(WP-F5 工作区)驱动:
 * 调 `refresh()`,或换绑新的 dataSource 引用;组件**不内部订阅** client。
 *
 * 标签页类型:`view-kind="stack"|"free"` 只决定标题(栈视图/自由视图)——
 * 默认区域共用同一规则(见 view-model.ts pickDefaultRegion:含 rsp 值的区域,
 * 否则第一个区域),自由视图不重复实现行布局(FE-FV-01/02)。
 *
 * 动画纪律:样式不产生动画;如后续引入过渡,只允许 transform / opacity。
 */
import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LitVirtualizer } from "@lit-labs/virtualizer";

import {
  byteViewQueryRange,
  clampAlignmentOffset,
  offsetGridRowSpans,
  regroupRows,
  type ByteRowSpan,
} from "./alignment.js";
import {
  ANCHOR_REGISTERS,
  parseJumpInput,
  pickDefaultRegion,
  resolveAnchor,
  rowIndexForAddress,
  type AnchorRegister,
  type AnchorState,
} from "./view-model.js";
import type {
  AddrRange,
  Hit,
  MemoryDataSource,
  RegisterRow,
  Row,
  VmaEntry,
  VmaList,
} from "../../datasource/types.js";
import { addressToHex, formatAddressHex, formatBytesHexGrouped, parseAddressHex } from "../../render/hex.js";
import { renderSpecialDisplayCell } from "../../render/special-display.js";

/** 十六进制段分组宽度(4 字节一组,展示层惯例)。 */
const HEX_GROUP_BYTES = 4;
/** 命中列表最大展示条数(超出给汇总提示,避免超长列表挤占视口)。 */
const SEARCH_HIT_DISPLAY_LIMIT = 8;
/** 左段地址展示宽度(32 位习惯;超宽地址不截断)。 */
const ADDRESS_MIN_DIGITS = 8;

/** 视图类型:stack = 栈视图(默认),free = 自由视图。 */
export type ByteViewKind = "stack" | "free";

/**
 * 宿主层行装饰(WP-F5 集成挂点,最小 diff 登记):工作区按行追加渲染——
 *  - `lead`:行左缘槽位(寄存器交叉标注,FE-RG-04);
 *  - `specialSuffix`:行右段 `.row-special` 末尾槽位(按行挂 `<sm-jump-chain>`,
 *    FE-ST-07/09 窗口内部分;虚拟列表只对可视行调用,天然限挂载量)。
 * 返回 null / undefined = 本行无装饰。
 */
export interface ByteRowDecoration {
  readonly lead?: unknown;
  readonly specialSuffix?: unknown;
}

@customElement("sm-byte-view")
export class SmByteView extends LitElement {
  /**
   * 宿主层行装饰回调(WP-F5;组件自身零依赖链组件/标注组件——宿主经此挂接,
   * 本组件不 import 任何 F4 视图)。变更即重建行渲染器,虚拟列表以 renderItem
   * 身份变化重渲染可视行。
   */
  @property({ attribute: false })
  rowDecorator: ((row: Row, index: number) => ByteRowDecoration | null | undefined) | null = null;
  /** 数据源(视图唯一依赖面;快照引用变化即触发重建,或由宿主调 refresh())。 */
  @property({ type: Object, attribute: false })
  dataSource: MemoryDataSource | null = null;

  /** 视图类型(决定标题;行布局与默认区域规则两视图共用)。 */
  @property({ type: String, attribute: "view-kind" })
  viewKind: ByteViewKind = "stack";

  /** 8 字节对齐偏移(0..7;非 0..7 的赋值在重建时夹取)。 */
  @property({ type: Number, attribute: "alignment-offset" })
  alignmentOffset = 0;

  /** 当前区域 id(null = 按默认规则选取;宿主/侧栏可写以切区域)。 */
  @property({ type: String, attribute: "active-region-id" })
  activeRegionId: string | null = null;

  // ── 重建态(rebuild 填充;非响应式,变更经 requestUpdate 呈现)──
  #regions: VmaList = [];
  #registers: RegisterRow[] = [];
  #region: VmaEntry | null = null;
  #windowRange: AddrRange | null = null;
  #spans: ByteRowSpan[] = [];
  #rows: Row[] = [];
  #anchors: AnchorState[] = [];
  /** 行索引 → 锚点寄存器名(行高亮标记)。 */
  #anchorMarkers = new Map<number, AnchorRegister[]>();
  #searchHits: readonly Hit[] = [];
  #searchStatus: string | null = null;
  #searchSummary: string | null = null;
  #jumpStatus: string | null = null;
  /** 待消费滚动行索引(updated 里消费;无布局环境滚动失败静默)。 */
  #pendingScrollIndex: number | null = null;
  /** 进入视图 / 切区域后首次重建时锚定 rsp(FE-ST-04)。 */
  #pendingInitialAnchor = true;

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("dataSource") || changed.has("activeRegionId")) {
      // 进入视图(首次数据)或切换区域 → 视口锚定 rsp(FE-ST-04)。
      this.#pendingInitialAnchor = true;
    }
    if (changed.has("dataSource") || changed.has("alignmentOffset") || changed.has("activeRegionId")) {
      this.#rebuild();
    }
    if (changed.has("rowDecorator")) {
      // 装饰器换绑:重建行渲染器(lit-virtualizer 以 renderItem 身份变化
      // 重渲染可视行;不触发数据重建——装饰纯呈现)。
      this.#rowRenderer = this.#makeRowRenderer();
    }
  }

  protected override updated(): void {
    if (this.#pendingScrollIndex !== null) {
      const index = this.#pendingScrollIndex;
      this.#pendingScrollIndex = null;
      this.#scrollRowToView(index);
    }
  }

  /**
   * 宿主驱动刷新(WP-F5 接线:`client.onProjectionChanged(() => view.refresh())`)。
   * 全量重读数据源快照(regions/registers/bytesRows 纯读),同步重建视图态。
   */
  refresh(): void {
    this.#rebuild();
    this.requestUpdate();
  }

  /**
   * 切换区域(VMA 侧栏 / 宿主接线):重建行并按进入视图口径锚定
   * (rsp 在窗口内 → rsp 行;否则顶部);向外派发 `region-change` 事件。
   */
  showRegion(regionId: string): void {
    this.#setActiveRegion(regionId);
  }

  /**
   * 宿主接线(WP-F5,最小 diff 登记):滚动到目标地址所在行(跳转链
   * viewport-jump 的窗口内落点)。命中返回 true;地址不在当前区域窗口
   * (含无数据)返回 false 且不滚动。
   */
  scrollToAddress(addressHex: string): boolean {
    const index = rowIndexForAddress(this.#spans, addressHex);
    if (index === null) {
      return false;
    }
    this.#pendingScrollIndex = index;
    this.requestUpdate();
    return true;
  }

  // ── 重建(数据源快照 → 视图态;同步、纯读)──

  #rebuild(): void {
    const dataSource = this.dataSource;
    this.#regions = dataSource?.regions() ?? [];
    this.#registers = dataSource?.registers() ?? [];
    const matched = this.#regions.find((region) => region.regionId === this.activeRegionId);
    this.#region = matched ?? pickDefaultRegion(this.#regions, this.#registers);
    this.#anchors = [];
    this.#anchorMarkers = new Map();
    this.#rows = [];
    this.#spans = [];
    this.#windowRange = null;

    const region = this.#region;
    if (dataSource === null || region === null) {
      return;
    }
    const offset = clampAlignmentOffset(this.alignmentOffset);
    const windowStart = region.startAddressHex;
    // D3:窗口 = 区域起点前缀 windowByteLength(min(区域长, maxBytesPerRange))。
    const windowEnd = addressToHex(parseAddressHex(windowStart) + BigInt(region.windowByteLength));
    const windowRange: AddrRange = { startAddressHex: windowStart, endAddressHex: windowEnd };
    this.#windowRange = windowRange;
    this.#spans = offsetGridRowSpans(windowStart, windowEnd, offset);
    const sourceRows = dataSource.bytesRows(byteViewQueryRange(windowStart, windowEnd, offset));
    this.#rows = regroupRows(sourceRows, this.#spans);

    for (const registerName of ANCHOR_REGISTERS) {
      const anchor = resolveAnchor(this.#registers, registerName, windowRange, this.#spans);
      if (anchor === null) {
        continue;
      }
      this.#anchors.push(anchor);
      if (anchor.placement === "in-window" && anchor.rowIndex !== null) {
        const markers = this.#anchorMarkers.get(anchor.rowIndex) ?? [];
        this.#anchorMarkers.set(anchor.rowIndex, [...markers, anchor.register]);
      }
    }

    if (this.#pendingInitialAnchor) {
      const rsp = this.#anchors.find((anchor) => anchor.register === "rsp");
      const anchorRow =
        rsp !== undefined && rsp.placement === "in-window" && rsp.rowIndex !== null ? rsp.rowIndex : 0;
      this.#pendingScrollIndex = this.#rows.length > 0 ? anchorRow : null;
      this.#pendingInitialAnchor = false;
    }
  }

  #setActiveRegion(regionId: string): void {
    if (this.activeRegionId === regionId) {
      return;
    }
    this.activeRegionId = regionId;
    this.#pendingInitialAnchor = true;
    // 同步重建(willUpdate 会对同一属性变更再跑一次,纯读幂等),保证调用方
    // 在返回后即可按新行序计算滚动目标(检索跨区域命中路径依赖此语义)。
    this.#rebuild();
    this.dispatchEvent(
      new CustomEvent("region-change", { detail: { regionId }, bubbles: true, composed: true }),
    );
  }

  #scrollRowToView(index: number): void {
    const list = this.renderRoot.querySelector("lit-virtualizer") as LitVirtualizer<Row> | null;
    if (list === null) {
      return;
    }
    try {
      // 无布局环境(jsdom)或布局未完成时滚动增强失败 → 静默(M13 不报错口径)。
      list.scrollToIndex(index, "center");
    } catch {
      // 忽略滚动增强失败;行内容仍完整呈现。
    }
  }

  // ── 交互处理 ──

  #onRegionSelect(event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.#setActiveRegion(select.value);
  }

  #onOffsetStep(delta: number): void {
    const next = clampAlignmentOffset(this.alignmentOffset + delta);
    if (next !== this.alignmentOffset) {
      this.alignmentOffset = next;
    }
  }

  #rewindToAnchor(anchor: AnchorState): void {
    if (anchor.rowIndex !== null) {
      this.#pendingScrollIndex = anchor.rowIndex;
      this.requestUpdate();
    }
  }

  #onJumpSubmit(event: SubmitEvent): void {
    event.preventDefault();
    const input = this.renderRoot.querySelector<HTMLInputElement>(".jump-input");
    const windowRange = this.#windowRange;
    if (input === null || windowRange === null) {
      return;
    }
    const resolution = parseJumpInput(input.value, windowRange);
    if (resolution.status === "in-window") {
      const index = rowIndexForAddress(this.#spans, resolution.addressHex);
      if (index !== null) {
        this.#jumpStatus = `已跳转到 ${formatAddressHex(resolution.addressHex, ADDRESS_MIN_DIGITS)}`;
        this.#pendingScrollIndex = index;
      } else {
        this.#jumpStatus = `${formatAddressHex(resolution.addressHex, ADDRESS_MIN_DIGITS)} 在可见窗口之外`;
      }
    } else if (resolution.status === "outside-window") {
      this.#jumpStatus = `${formatAddressHex(resolution.addressHex, ADDRESS_MIN_DIGITS)} 在可见窗口之外(仅窗口内可达)`;
    } else {
      this.#jumpStatus = "无法识别的跳转目标(支持 0x 十六进制地址或十进制窗口偏移)";
    }
    this.requestUpdate();
  }

  #onSearchSubmit(event: SubmitEvent): void {
    event.preventDefault();
    const input = this.renderRoot.querySelector<HTMLInputElement>(".search-input");
    const dataSource = this.dataSource;
    if (input === null || dataSource === null) {
      return;
    }
    const pattern = input.value.trim().toLowerCase();
    if (!/^[0-9a-f]+$/.test(pattern) || pattern.length % 2 !== 0) {
      this.#searchHits = [];
      this.#searchSummary = null;
      this.#searchStatus = "检索模式须为非空偶数长度十六进制(如 0102)";
      this.requestUpdate();
      return;
    }
    // M3 口径:检索语义 = 仅已下发窗口字节(数据源契约负责,视图只透传)。
    const hits = dataSource.search({ patternHex: pattern });
    this.#searchHits = hits.slice(0, SEARCH_HIT_DISPLAY_LIMIT);
    this.#searchStatus = hits.length === 0 ? "窗口内无命中" : null;
    this.#searchSummary =
      hits.length > SEARCH_HIT_DISPLAY_LIMIT
        ? `共 ${hits.length} 处命中,显示前 ${SEARCH_HIT_DISPLAY_LIMIT} 处`
        : null;
    this.requestUpdate();
  }

  #onHitClick(hit: Hit): void {
    if (this.#region !== null && hit.regionId !== this.#region.regionId) {
      // 跨区域命中:先切区域(重建行序),再滚动到命中行。
      this.#setActiveRegion(hit.regionId);
    }
    const index = rowIndexForAddress(this.#spans, hit.addressHex);
    if (index !== null) {
      this.#pendingScrollIndex = index;
    } else {
      this.#jumpStatus = `命中 ${formatAddressHex(hit.addressHex, ADDRESS_MIN_DIGITS)} 不在当前区域窗口内`;
    }
    this.requestUpdate();
  }

  // ── 渲染 ──

  protected override render(): unknown {
    const heading = this.viewKind === "free" ? "自由视图" : "栈视图";
    if (this.#region === null) {
      return html`
        <section class="byte-view" aria-label="${heading}">
          <header class="toolbar" part="toolbar">
            <h3 class="heading">${heading}</h3>
          </header>
          <p class="empty" role="status">暂无可见内存区域</p>
        </section>
      `;
    }
    return html`
      <section class="byte-view" aria-label="${heading}">
        <header class="toolbar" part="toolbar">${this.#renderToolbar(heading)}</header>
        <div class="table" role="table" aria-label="内存十六进制字节(8 字节一行,高地址在下)">
          <div class="byte-row header-row" role="row">
            <span class="row-address" role="columnheader">地址</span>
            <span class="row-hex" role="columnheader">十六进制</span>
            <span class="row-special" role="columnheader">特殊显示</span>
          </div>
          <lit-virtualizer
            class="byte-list"
            role="rowgroup"
            .items=${this.#rows}
            .renderItem=${this.#rowRenderer}
          ></lit-virtualizer>
        </div>
        ${this.#rows.length === 0 ? html`<p class="empty" role="status">窗口内暂无字节</p>` : nothing}
      </section>
    `;
  }

  #renderToolbar(heading: string): unknown {
    const region = this.#region as VmaEntry;
    const offset = clampAlignmentOffset(this.alignmentOffset);
    return html`
      <div class="toolbar-row">
        <h3 class="heading">${heading}</h3>
        ${this.#regions.length > 1
          ? html`
              <label class="region-label">
                区域
                <select class="region-select" aria-label="选择内存区域" @change=${this.#onRegionSelect}>
                  ${this.#regions.map(
                    (entry) => html`
                      <option value=${entry.regionId} ?selected=${entry.regionId === region.regionId}>
                        ${entry.label}(${entry.regionId})
                      </option>
                    `,
                  )}
                </select>
              </label>
            `
          : nothing}
        <div class="offset-controls" role="group" aria-label="8 字节对齐偏移">
          <span class="offset-label">对齐偏移</span>
          <button
            type="button"
            class="offset-decrease"
            aria-label="减小对齐偏移"
            ?disabled=${offset === 0}
            @click=${() => this.#onOffsetStep(-1)}
          >
            −
          </button>
          <span class="offset-value">${offset}</span>
          <button
            type="button"
            class="offset-increase"
            aria-label="增大对齐偏移"
            ?disabled=${offset === 7}
            @click=${() => this.#onOffsetStep(1)}
          >
            +
          </button>
        </div>
        <p class="window-caption">
          窗口 ${formatAddressHex(region.startAddressHex, ADDRESS_MIN_DIGITS)}–${formatAddressHex(
            this.#windowRange?.endAddressHex ?? region.startAddressHex,
            ADDRESS_MIN_DIGITS,
          )}
          · ${region.windowByteLength} B / 区域 ${region.byteLength} B${region.truncated ? " · 已截断" : ""}
        </p>
      </div>
      <div class="toolbar-row">
        <form class="jump-form" @submit=${this.#onJumpSubmit}>
          <input
            class="jump-input"
            type="text"
            aria-label="跳转地址或窗口内偏移"
            placeholder="0x1004 或偏移(十进制)"
          />
          <button type="submit">跳转</button>
        </form>
        <form class="search-form" @submit=${this.#onSearchSubmit}>
          <input
            class="search-input"
            type="text"
            aria-label="字节检索模式"
            placeholder="十六进制字节(如 0102)"
          />
          <button type="submit">检索</button>
        </form>
      </div>
      <div class="anchor-bar">${this.#anchors.map((anchor) => this.#renderAnchor(anchor))}</div>
      <p class="jump-status" role="status">${this.#jumpStatus ?? ""}</p>
      ${this.#searchStatus === null ? nothing : html`<p class="search-status" role="status">${this.#searchStatus}</p>`}
      ${this.#searchSummary === null
        ? nothing
        : html`<p class="search-summary" role="status">${this.#searchSummary}(仅已下发窗口字节)</p>`}
      ${this.#searchHits.length === 0 ? nothing : this.#renderHits()}
    `;
  }

  #renderAnchor(anchor: AnchorState): unknown {
    if (anchor.placement === "outside-window") {
      // M13 口径:明示窗口外,不渲染空白、不报错。
      return html`
        <span class="anchor-chip anchor-outside">
          ${anchor.register} 内容不在可见窗口(${formatAddressHex(anchor.valueHex, ADDRESS_MIN_DIGITS)})
        </span>
      `;
    }
    return html`
      <span class="anchor-chip">
        <span class="anchor-name">${anchor.register}</span>
        <span class="anchor-value">${formatAddressHex(anchor.valueHex, ADDRESS_MIN_DIGITS)}</span>
        <button
          type="button"
          class="anchor-rewind"
          aria-label="滚动回 ${anchor.register} 锚点行"
          @click=${() => this.#rewindToAnchor(anchor)}
        >
          回锚 ${anchor.register}
        </button>
      </span>
    `;
  }

  #renderHits(): unknown {
    return html`
      <ul class="search-hits">
        ${this.#searchHits.map(
          (hit) => html`
            <li>
              <button
                type="button"
                class="search-hit"
                data-hit-address=${hit.addressHex}
                @click=${() => this.#onHitClick(hit)}
              >
                ${this.#regionLabel(hit.regionId)} @ ${formatAddressHex(hit.addressHex, ADDRESS_MIN_DIGITS)}
                <span class="hit-bytes">${hit.matchedHex}</span>
              </button>
            </li>
          `,
        )}
      </ul>
    `;
  }

  #regionLabel(regionId: string): string {
    const region = this.#regions.find((entry) => entry.regionId === regionId);
    return region === undefined ? regionId : `${region.label}(${regionId})`;
  }

  /** 行渲染器(willUpdate 在 rowDecorator 换绑时重建,驱动可视行重渲染)。 */
  #rowRenderer: (row: Row, index: number) => TemplateResult = this.#makeRowRenderer();

  #makeRowRenderer(): (row: Row, index: number) => TemplateResult {
    return (row: Row, index: number): TemplateResult => {
      const markers = this.#anchorMarkers.get(index) ?? [];
      const anchorClass = markers.length > 0 ? " anchor-row" : "";
      // 宿主层行装饰(WP-F5):lead 渲染在行左缘(地址段之前),
      // specialSuffix 追加在行右段(.row-special)末尾。
      const decoration = this.rowDecorator?.(row, index) ?? null;
      return html`
        <div class="byte-row${anchorClass}" role="row" data-row-address=${row.addressHex}>
          <span class="row-address" role="cell">
            ${decoration?.lead ?? nothing}${formatAddressHex(row.addressHex, ADDRESS_MIN_DIGITS)}${markers.map(
              (marker) => html`<em class="anchor-marker">${marker}</em>`,
            )}
          </span>
          <span class="row-hex" role="cell">${this.#renderHexSegment(row)}</span>
          <span class="row-special" role="cell"
            >${row.cells.map((cell) => renderSpecialDisplayCell(cell.byte))}${decoration?.specialSuffix ??
            nothing}</span
          >
        </div>
      `;
    };
  }

  /** 十六进制段:整行窗口内 → 分组格式化;含窗口外 cell → 逐 cell 退化呈现。 */
  #renderHexSegment(row: Row): TemplateResult {
    const cells = row.cells;
    if (cells.every((cell) => cell.byteHex !== null)) {
      const bytesHex = cells.flatMap((cell) => (cell.byteHex !== null ? [cell.byteHex] : [])).join("");
      return html`<span class="hex-grouped">${formatBytesHexGrouped(bytesHex, HEX_GROUP_BYTES)}</span>`;
    }
    return html`${cells.map(
      (cell) =>
        cell.byteHex === null
          ? html`<span class="cell-hex cell-outside" data-outside>??</span>`
          : html`<span class="cell-hex" data-byte=${cell.byteHex}>${cell.byteHex}</span>`,
    )}`;
  }

  static override styles = css`
    :host {
      display: block;
      block-size: 24rem;
      border: 1px solid rgb(0 0 0 / 15%);
      border-radius: 8px;
      background: canvas;
      color: canvastext;
      font-family: ui-monospace, "Cascadia Mono", "Source Code Pro", Menlo, Consolas, monospace;
      font-size: 0.8125rem;
    }

    .byte-view {
      display: flex;
      flex-direction: column;
      block-size: 100%;
    }

    .toolbar {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      padding: 0.5rem 0.75rem;
      border-block-end: 1px solid rgb(0 0 0 / 10%);
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

    .window-caption {
      margin: 0;
      color: graytext;
      font-size: 0.75rem;
    }

    .offset-controls {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
    }

    .offset-value {
      min-inline-size: 1.5ch;
      text-align: center;
    }

    button {
      font: inherit;
    }

    input {
      font: inherit;
    }

    .table {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-block-size: 0;
    }

    lit-virtualizer.byte-list {
      display: block;
      flex: 1;
      min-block-size: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
    }

    .byte-row {
      display: grid;
      grid-template-columns: 16ch 26ch 1fr;
      align-items: baseline;
      column-gap: 1ch;
      padding-inline: 0.75rem;
      line-height: 1.6;
    }

    .header-row {
      color: graytext;
      border-block-end: 1px solid rgb(0 0 0 / 10%);
    }

    .anchor-row {
      background: color-mix(in srgb, highlight 14%, transparent);
    }

    .anchor-marker {
      margin-inline-start: 0.5ch;
      font-style: normal;
      font-weight: 600;
      color: highlight;
    }

    .hex-grouped {
      white-space: pre;
    }

    .cell-hex {
      margin-inline-end: 0.5ch;
      white-space: pre;
    }

    .cell-outside,
    .hex-grouped .cell-outside {
      color: graytext;
    }

    .row-special .cell-special {
      margin-inline-end: 0.25ch;
      white-space: pre;
    }

    .anchor-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .anchor-chip {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
    }

    .anchor-outside {
      color: graytext;
    }

    .anchor-name,
    .anchor-value {
      font-weight: 600;
    }

    .jump-status,
    .search-status,
    .search-summary {
      margin: 0;
      min-block-size: 1.1em;
      font-size: 0.75rem;
      color: graytext;
    }

    .search-hits {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
    }

    .search-hit {
      display: inline-flex;
      gap: 0.375rem;
      cursor: pointer;
    }

    .hit-bytes {
      color: graytext;
    }

    .empty {
      margin: 0;
      padding: 1rem;
      color: graytext;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "sm-byte-view": SmByteView;
  }
}

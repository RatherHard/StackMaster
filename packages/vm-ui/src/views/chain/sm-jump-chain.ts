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
import { LocaleController, t } from "../../i18n/i18n.js";
import { ensureSmThemeStyles } from "../../theme/theme-tokens.js";
import {
  JUMP_CHAIN_EXPANDED_LIMIT,
  JUMP_CHAIN_HORIZONTAL_LIMIT,
  chainCodeEndAddress,
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

  /**
   * 伪汇编查询面(WP-76 §2.3 #2;宿主注入,**无第二数据通道**):
   * 链延伸落点落在代码区时,组件向本面查该地址的伪汇编展示条目
   * (调试档 = 宿主按调试通道**已下发**的指令流缓存查表;返回值缺席 = 该地址
   * 不在已推送覆盖面内)。**属性面缺席 = 解题档**:无指令流数据,组件按登记
   * 形态降级为引导文案(不伪造指令、不推断)。
   *
   * 登记语义(本 WP):chip **不可点击**——链上地址芯片已承载跳转,伪汇编 chip
   * 只做展示(避免与既有链段跳转语义重叠,且不新增可交互面)。
   */
  @property({ attribute: false })
  pseudoAsmProvider: ((addressHex: string) => { readonly text: string } | null) | null = null;

  /**
   * 只读复制形态(WP-75#5 / D-MP-3;M3 遗留-5 ②):宿主(寄存器视图特殊显示列)
   * 复用本组件时**截停** `viewport-jump` 并把点击改为**复制该地址**,故链上地址
   * 芯片的 tooltip 取 `chain.copyTitle`(默认跳转形态取 `chain.jumpTitle`)——
   * 文案与真实行为一致。
   *
   * **组件行为零变化**:本属性只决定 tooltip 取词,仍只发 `viewport-jump` 事件,
   * 复制由宿主实现(组件内不接触剪贴板)。
   */
  @property({ type: Boolean })
  copyMode = false;

  /** 延伸进行中(按钮 aria-busy;防重入)。 */
  #extending = false;

  /** 延伸反馈(已延伸至缓存边界 / 失败文案;短暂承载)。 */
  #extendStatus: string | null = null;

  /** i18n:连接时消费 data-sm-language 锚;locale 变化即重渲染(WP-53)。 */
  readonly #i18n = new LocaleController(this);

  override connectedCallback(): void {
    super.connectedCallback();
    // LocaleController 经构造副作用注册(Lit addController);显式读点满足 lint。
    void this.#i18n;
    ensureSmThemeStyles(this.ownerDocument ?? document);
  }

  static override styles = css`
    :host {
      display: block;
      font-family: var(--sm-font-mono, ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, "Noto Sans Mono CJK SC", monospace);
      font-size: 0.8125rem;
    }

    .chain {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem;
    }

    .chain-arrow {
      color: var(--sm-fg-dim, graytext);
    }

    .chain-address {
      padding: 0 0.25rem;
      border: 1px solid var(--sm-border, rgb(0 0 0 / 15%));
      border-radius: 4px;
      background: var(--sm-bg-base, canvas);
      color: var(--sm-accent, linktext);
      font: inherit;
      cursor: pointer;
    }

    .chain-address:hover {
      text-decoration: underline;
    }

    .chain-address:focus-visible,
    .chain-expand:focus-visible,
    .chain-extend-button:focus-visible {
      outline: 2px solid var(--sm-focus-ring, accentcolor);
      outline-offset: 1px;
    }

    /* 原为无效 CSS 颜色关键词 colortext(系统色只有 CanvasText):该声明被浏览器
       整条丢弃 ⇒ 有效计算值本就是「继承父级」。此处归一为显式 color: inherit
       (与有效计算值完全等价、零像素变化),并登记事实:本处语义 = 继承父级色
       (寄存器视图内为 linktext,工作区字节视图行右段内为该视图前景)。 */
    .chain-loop {
      display: inline-flex;
      align-items: center;
      color: inherit;
    }

    .chain-expand {
      padding: 0 0.375rem;
      border: 1px solid var(--sm-border, rgb(0 0 0 / 15%));
      border-radius: 4px;
      background: none;
      color: var(--sm-fg-dim, graytext);
      font: inherit;
      font-size: 0.8125rem;
      cursor: pointer;
    }

    /* 延伸入口 + 反馈(WP-F8 调试档;FE-ST-08/10)。 */
    .chain-extend-button {
      padding: 0 0.375rem;
      border: 1px solid var(--sm-border-button, rgb(0 0 0 / 20%));
      border-radius: 4px;
      background: var(--sm-bg-base, canvas);
      color: var(--sm-accent, linktext);
      font: inherit;
      font-size: 0.8125rem;
      cursor: pointer;
    }

    .chain-extend-button:disabled {
      color: var(--sm-fg-dim, graytext);
      cursor: not-allowed;
    }

    .chain-extend-status {
      color: var(--sm-fg-dim, graytext);
      font-family: system-ui, sans-serif;
      font-size: 0.8125rem;
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
      color: var(--sm-fg-dim, graytext);
      font-family: system-ui, sans-serif;
      font-size: 0.8125rem;
    }

    /* 可见字符延伸段:同 .chain-loop,原为无效关键词 colortext ⇒ 归一为 inherit
       (继承父级色,零像素变化;事实登记见上)。 */
    .visible-run {
      margin-inline-start: 0.25rem;
      color: inherit;
    }

    /* 伪汇编 chip(WP-76 §2.3 #2):链延伸落到代码区时追加一条指令语句展示。
       只读展示面(非交互):链上地址芯片已承载跳转。
       底:原字面量 canvas 92% + highlight 8% 逐字等于 --sm-bg-panel 的 light /
       dark 值 ⇒ 直接归该 token(明暗逐像素不变,terminal 取设计好的面板色
       #101610);嵌套重组写法只用于「字面量不等于任何 token 值」的 field 基底淡染。 */
    .pseudo-asm {
      margin-inline-start: 0.375rem;
      padding: 0 0.25rem;
      border: 1px solid var(--sm-border, rgb(0 0 0 / 15%));
      border-radius: 4px;
      background: var(--sm-bg-panel, color-mix(in srgb, canvas 92%, highlight 8%));
      color: var(--sm-fg, canvastext);
      font-family: var(--sm-font-mono, ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, "Noto Sans Mono CJK SC", monospace);
      font-size: 0.8125rem;
      white-space: nowrap;
    }

    /* 降级形态(解题档无指令流 / 调试档推送覆盖面外):引导文案,不冒充指令。
       用系统字体 + 「(暂无伪汇编数据)」标题与真指令区分即可,**不再降前景色**:
       真机 axe 实测 graytext(#808080)落在 .pseudo-asm 的底
       (--sm-bg-panel,dark #131921 / light 近白)上只有 **4.47:1**,低于正文
       4.5:1 门槛(solve 形态「切换调试模式查看指令」命中 color-contrast/serious)
       —— 且 graytext 在浅底上同样不达标(≈3.9:1),故唯一稳健修法是取正文
       前景 --sm-fg(继承自基态规则,与之同源)。红点只在新链右段才可达:
       WP-76 修掉跳转链死绑定(D-API-117)后这枚 chip 才第一次真机渲染。
       注:本注释内**禁用反引号** —— css 模板字面量里出现反引号会提前闭合并
       让整份样式表语法失效(TS1005 连锁错;本包已踩过一次,登记于此)。 */
    .pseudo-asm[data-pseudo-asm-source="solve"],
    .pseudo-asm[data-pseudo-asm-source="no-coverage"] {
      color: var(--sm-fg, canvastext);
      font-family: system-ui, sans-serif;
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
        ${this.#renderPseudoAsmChip(full ?? horizontal)}
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
        title=${t("chain.extendTitle")}
        @click=${() => this.#runExtend(last.addressHex)}
      >
        ${this.#extending ? t("chain.extending") : t("chain.extend")}
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
      this.#extendStatus = stillOutside ? t("chain.extendedToBoundary") : null;
    } catch {
      this.#extendStatus = t("chain.extendFailed");
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

  /** 地址芯片(链上每个地址可点击,FE-ST-09);tooltip 取词随宿主形态(见 `copyMode`)。 */
  #renderAddressChip(addressHex: string, withinWindow: boolean): TemplateResult {
    const address = addressHex + (withinWindow ? "" : t("chain.outsideSuffix"));
    return html`<button
      type="button"
      class="chain-address"
      data-address="${addressHex}"
      title=${this.copyMode ? t("chain.copyTitle", { address }) : t("chain.jumpTitle", { address })}
      @click=${() => this.#emitJump(addressHex, withinWindow)}
    >${addressHex}</button>`;
  }

  /** 回环箭头(SVG,FE-ST-07"循环显示时箭头打回";屏幕阅读器可感知)。 */
  #renderLoopMark(segment: JumpChainSegment): TemplateResult {
    return html`<span
      class="chain-loop"
      role="img"
      aria-label=${t("chain.loopAria", { target: segment.targetAddressHex ?? segment.addressHex })}
      title=${t("chain.loopTitle")}
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
      ${this.expanded ? t("chain.collapse") : t("chain.expand")}
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
            : html`<span class="chain-value">${t("chain.value", { value: segment.valueHex })}</span>`}
          ${segment.loopBack === true
            ? html`<span class="chain-value">${t("chain.loopMark")}</span>`
            : nothing}
          ${segment.outsideWindow === true
            ? html`<span class="chain-outside">${t("chain.outsideMark")}</span>`
            : nothing}
        </li>`,
      )}
    </ol>`;
  }

  /**
   * 伪汇编延伸 chip(WP-76 §2.3 #2;FE-ST-08 伪汇编落点):
   *  - 落点判定 = `chainCodeEndAddress`(链序中最后一个落在可执行区域的地址);
   *    不在代码区 → 不追加(返回 nothing);
   *  - `pseudoAsmProvider` 缺席(**解题档**)= 无指令流数据 ⇒ 登记降级形态:
   *    引导文案「切换调试模式查看指令」(`data-pseudo-asm-source="solve"`);
   *  - provider 返回 null(**调试档** · 该地址不在已推送覆盖面内)⇒ 引导文案
   *    「暂无指令流覆盖」(source = `no-coverage`);
   *  - provider 命中 ⇒ 真实伪汇编展示文本(`地址 语句`;source = `debug`,
   *    数据来源 = 调试通道已下发的 `debug_instruction_stream`,零新增通道)。
   */
  #renderPseudoAsmChip(segments: readonly JumpChainSegment[]): TemplateResult | typeof nothing {
    const dataSource = this.dataSource;
    if (dataSource === null) {
      return nothing;
    }
    let addressHex: string | null;
    try {
      addressHex = chainCodeEndAddress(segments, dataSource.regions());
    } catch {
      return nothing; // 区域面异常按"非代码区落点"处理,不阻塞链渲染。
    }
    if (addressHex === null) {
      return nothing;
    }
    const provider = this.pseudoAsmProvider;
    let source: "debug" | "no-coverage" | "solve";
    let text: string;
    if (provider === null) {
      source = "solve";
      text = t("chain.pseudoAsmSolveHint");
    } else {
      const entry = provider(addressHex);
      if (entry === null) {
        source = "no-coverage";
        text = t("chain.pseudoAsmNoCoverage");
      } else {
        source = "debug";
        text = `${addressHex} ${entry.text}`;
      }
    }
    const title =
      source === "debug"
        ? t("chain.pseudoAsmTitle", { address: addressHex })
        : t("chain.pseudoAsmTitleFallback", { address: addressHex });
    return html`<span
      class="pseudo-asm"
      data-pseudo-asm
      data-pseudo-asm-address=${addressHex}
      data-pseudo-asm-source=${source}
      title=${title}
      >${text}</span
    >`;
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

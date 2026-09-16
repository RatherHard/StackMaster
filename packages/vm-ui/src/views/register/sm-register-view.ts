/**
 * <sm-register-view> —— 寄存器视图(WP-F4 / FE-RG-01/02/03,公开视图档)。
 *
 * 职责:
 *  - FE-RG-01:纵向显示**所有**白名单寄存器——"所有"由服务端白名单结构性
 *    保证(M14:FLAG 等秘密寄存器不可见),前端不为白名单外寄存器留占位;
 *  - FE-RG-02:行三段布局 = 寄存器名 / valueHex(恒 `0x` + 大写,
 *    `normalizeValueHex` 归一化)/ 特殊显示列(值命中可见区域窗口 →
 *    区域引用 `→ regionId` + **复用 `<sm-jump-chain>` 只读形态**,与栈视图
 *    行右段同族;交叉判定复用 cross-annotation);
 *  - FE-RG-03:点击值 / 点击链上地址 = 写入剪贴板(**不发生视角跳转**)——
 *    链组件发出的 `viewport-jump` 在本视图就地截停(不冒泡到工作区,
 *    故"点击不跳转"),改以该地址为复制目标;`navigator.clipboard`
 *    不可用或写入被拒时按 Q8 定案降级:选中文本节点 + 行内提示
 *    "已就绪手动复制"(自动消隐);剪贴板调用可注入(`copyToClipboard`);
 *  - 键盘基线:行可聚焦(tabindex),Enter 触发复制;完整无障碍横切归 F9。
 *
 * 纪律(CLAUDE.md 第十章):只依赖 `MemoryDataSource` 接口(禁止直读
 * SessionClient / ProjectionStore);动画只用 transform / opacity;
 * 语义化 DOM(table,屏幕阅读器可感知)。
 */
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import type { MemoryDataSource, RegisterRow } from "../../datasource/types.js";
import { LocaleController, t } from "../../i18n/i18n.js";
import { normalizeValueHex } from "../../render/hex.js";
import { ensureSmThemeStyles } from "../../theme/theme-tokens.js";
// 只读形态复用:链组件自带 shadow 样式与链解析(视觉与栈视图同族,WP-75#5)。
import "../chain/sm-jump-chain.js";
import type { SmJumpChain, ViewportJumpDetail } from "../chain/sm-jump-chain.js";
import { crossAnnotateRegisters } from "./cross-annotation.js";

/** 剪贴板写入器:resolve = 复制成功;reject = 调用方走 Q8 降级。 */
export type ClipboardWriter = (text: string) => Promise<void>;

/**
 * 复制成功反馈文案(可见反馈,FE-RG-03)。导出常量 = zh-CN 快照(既有测试
 * 与公开 API 面);组件渲染经 i18n 键 `reg.copied`(WP-53)。
 */
export const COPY_SUCCESS_TEXT = "已复制";

/**
 * Q8 降级反馈文案(navigator.clipboard 不可用 / 写入被拒)。导出常量 =
 * zh-CN 快照;组件渲染经 i18n 键 `reg.copyFallback`。
 */
export const COPY_FALLBACK_TEXT = "已就绪手动复制";

/** 行内复制反馈的自动消隐时长(毫秒)。 */
export const COPY_FEEDBACK_HIDE_MS = 2000;

/**
 * 默认剪贴板写入器:`navigator.clipboard.writeText`(生产 HTTPS 主路径)。
 * API 不可用(非安全上下文,如 HTTP 联调环境)或写入被拒时 reject,
 * 由组件降级为"选中文本 + 手动复制提示"(Q8 定案)。
 */
export function defaultClipboardWriter(text: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== "function") {
    return Promise.reject(new Error("navigator.clipboard 不可用(Q8:降级为手动复制)"));
  }
  return clipboard.writeText(text);
}

/** 把元素的文本内容置入选区(Q8 降级:用户可直接 Ctrl+C);无目标节点即跳过。 */
function selectElementText(element: Element | null): void {
  if (element === null) {
    return;
  }
  try {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    if (selection === null) {
      return;
    }
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    // 选区失败不影响降级提示的呈现(环境差异兜底)。
  }
}

/**
 * 行内复制反馈状态。`source` 区分复制来源(值单元格 / 特殊显示列的链上地址),
 * 反馈只渲染在来源单元格内 ⇒ 同一行同刻至多一条 `role="status"`(不重复播报)。
 */
interface CopyFeedback {
  readonly registerName: string;
  readonly source: "value" | "address";
  readonly kind: "copied" | "fallback";
}

@customElement("sm-register-view")
export class SmRegisterView extends LitElement {
  /** 数据源(视图唯一依赖面:MemoryDataSource 接口)。 */
  @property({ attribute: false })
  dataSource: MemoryDataSource | null = null;

  /** 剪贴板写入器(可注入;默认 navigator.clipboard,rejection → Q8 降级)。 */
  @property({ attribute: false })
  copyToClipboard: ClipboardWriter = defaultClipboardWriter;

  @state()
  private feedback: CopyFeedback | null = null;

  /** i18n:连接时消费 data-sm-language 锚;locale 变化即重渲染(WP-53)。 */
  readonly #i18n = new LocaleController(this);

  override connectedCallback(): void {
    super.connectedCallback();
    // LocaleController 经构造副作用注册(Lit addController);显式读点满足 lint。
    void this.#i18n;
    ensureSmThemeStyles(this.ownerDocument ?? document);
  }

  #feedbackTimer: ReturnType<typeof setTimeout> | undefined;

  static override styles = css`
    :host {
      display: block;
      font-family: system-ui, sans-serif;
    }

    table {
      inline-size: 100%;
      border-collapse: collapse;
    }

    th,
    td {
      padding: 0.25rem 0.5rem;
      text-align: left;
      border-block-end: 1px solid rgb(0 0 0 / 8%);
    }

    thead th {
      color: graytext;
      font-size: 0.75rem;
      font-weight: 600;
    }

    tbody tr:focus-visible {
      outline: 2px solid accentcolor;
      outline-offset: -2px;
    }

    .value-button {
      display: inline-block;
      inline-size: 100%;
      padding: 0;
      border: none;
      background: none;
      color: inherit;
      font: inherit;
      font-family: ui-monospace, monospace;
      text-align: left;
      cursor: copy;
    }

    .value-button:focus-visible {
      outline: 2px solid accentcolor;
      outline-offset: 1px;
    }

    /* 特殊显示列:区域引用 + 跳转链只读形态(D-MP-3)。链组件自带 shadow
       样式(芯片 / 箭头 / 可见字符段),此处只负责槽位排布与同族字体。 */
    .cell-special {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem;
      font-family: ui-monospace, monospace;
      color: linktext;
    }

    .cell-chain {
      display: inline-block;
    }

    /* 复制反馈:行内 status,透明度过渡(compositor 友好)。 */
    .copy-feedback {
      margin-inline-start: 0.5rem;
      font-size: 0.75rem;
      color: graytext;
      opacity: 1;
      transition: opacity 150ms ease;
    }

    .empty {
      margin: 0;
      padding: 0.5rem 0.75rem;
      color: graytext;
      font-size: 0.875rem;
    }
  `;

  protected override render(): TemplateResult {
    const rows = this.dataSource?.registers() ?? [];
    if (rows.length === 0) {
      return html`<p class="empty" role="status">${t("reg.empty")}</p>`;
    }
    const regions = this.dataSource?.regions() ?? [];
    const hitsByName = new Map(
      crossAnnotateRegisters(rows, regions).map((hit) => [hit.registerName, hit]),
    );
    return html`
      <table class="registers" part="table" aria-label=${t("reg.aria")}>
        <thead>
          <tr>
            <th scope="col">${t("reg.colName")}</th>
            <th scope="col">${t("reg.colValue")}</th>
            <th scope="col">${t("reg.colSpecial")}</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => this.#renderRow(row, hitsByName.get(row.name)))}
        </tbody>
      </table>
    `;
  }

  /** 单行三段布局(名 / 值 / 特殊显示;行可聚焦,Enter 触发复制)。 */
  #renderRow(row: RegisterRow, hit: ReturnType<typeof crossAnnotateRegisters>[number] | undefined): TemplateResult {
    const valueHex = normalizeValueHex(row.valueHex);
    const feedback = this.feedback?.registerName === row.name ? this.feedback : null;
    const valueFeedback = feedback?.source === "value" ? feedback : null;
    const addressFeedback = feedback?.source === "address" ? feedback : null;
    return html`
      <tr
        class="register-row"
        tabindex="0"
        data-register="${row.name}"
        aria-label="${row.name} = ${valueHex}"
        @keydown=${(event: KeyboardEvent) => this.#onRowKeyDown(event, row)}
      >
        <th scope="row" class="name">${row.name}</th>
        <td class="value">
          <button
            type="button"
            class="value-button"
            title=${t("reg.copyTitle", { value: valueHex })}
            @click=${() => void this.#copyValue(row)}
          >${valueHex}</button>
          ${valueFeedback === null ? nothing : this.#renderFeedback(valueFeedback)}
        </td>
        <td class="special">
          ${hit === undefined
            ? nothing
            : html`<span class="cell-special cell-region-ref" data-region="${hit.regionId}"
                >→ ${hit.regionId}</span
              >
              <sm-jump-chain
                class="cell-special cell-chain"
                .dataSource=${this.dataSource}
                .startAddressHex=${hit.targetAddressHex}
                @viewport-jump=${(event: CustomEvent<ViewportJumpDetail>) =>
                  this.#onChainAddressClick(event, row)}
              ></sm-jump-chain>
              ${addressFeedback === null ? nothing : this.#renderFeedback(addressFeedback)}`}
        </td>
      </tr>
    `;
  }

  /** 行内复制反馈(`role="status"`,来源单元格内呈现;自动消隐)。 */
  #renderFeedback(feedback: CopyFeedback): TemplateResult {
    return html`<span
      class="copy-feedback copy-${feedback.kind}"
      data-copy-source=${feedback.source}
      role="status"
      >${feedback.kind === "copied" ? t("reg.copied") : t("reg.copyFallback")}</span
    >`;
  }

  /** 行级键盘:Enter 触发复制;事件源自行内按钮时跳过(按钮 click 路径,防双发)。 */
  #onRowKeyDown(event: KeyboardEvent, row: RegisterRow): void {
    if (event.key !== "Enter" || event.target !== event.currentTarget) {
      return;
    }
    event.preventDefault();
    void this.#copyValue(row);
  }

  /**
   * 链上地址点击(只读形态复用,D-MP-3 / 设计文档「点击地址不会发生跳转,
   * 而会将地址复制到剪切板」):就地截停 `viewport-jump`——该事件原本冒泡到
   * 工作区触发**视角跳转**,此处 `stopPropagation()` 使其不再上浮(工作表
   * 跳转处理器收不到),改为复制被点击的地址。
   */
  #onChainAddressClick(event: CustomEvent<ViewportJumpDetail>, row: RegisterRow): void {
    event.stopPropagation();
    const addressHex = event.detail?.addressHex;
    if (typeof addressHex !== "string" || addressHex === "") {
      return;
    }
    void this.#copyAddress(row, addressHex);
  }

  /**
   * 复制寄存器值(FE-RG-03):成功 → 可见反馈;失败或 API 不可用 → Q8 降级
   * (选中行内值文本 + "已就绪手动复制"提示)。反馈自动消隐。
   */
  async #copyValue(row: RegisterRow): Promise<void> {
    const valueHex = normalizeValueHex(row.valueHex);
    try {
      await this.copyToClipboard(valueHex);
      this.#showFeedback(row.name, "value", "copied");
    } catch {
      selectElementText(
        this.shadowRoot?.querySelector(`tr[data-register="${row.name}"] td.value`) ?? null,
      );
      this.#showFeedback(row.name, "value", "fallback");
    }
  }

  /**
   * 复制链上地址(D-MP-3 特殊显示列):成功 / 失败语义与值复制一致(Q8 降级
   * = 选中该地址芯片文本 + 提示;**不静默失败**)。地址文本由 `<sm-jump-chain>`
   * 的 shadow 根渲染,降级选区落到该芯片;芯片缺席(链被截断 / 未升级)时
   * 退化为提示本身("已就绪手动复制")。
   */
  async #copyAddress(row: RegisterRow, addressHex: string): Promise<void> {
    try {
      await this.copyToClipboard(addressHex);
      this.#showFeedback(row.name, "address", "copied");
    } catch {
      selectElementText(this.#chainAddressChip(row, addressHex));
      this.#showFeedback(row.name, "address", "fallback");
    }
  }

  /** 行内链组件的地址芯片(跨一层 shadow 根查询;缺席 / 选择器异常 → null)。 */
  #chainAddressChip(row: RegisterRow, addressHex: string): Element | null {
    try {
      const chain = this.shadowRoot?.querySelector<SmJumpChain>(
        `tr[data-register="${row.name}"] sm-jump-chain`,
      );
      const shadow = chain?.shadowRoot ?? null;
      return shadow?.querySelector(`.chain-address[data-address="${addressHex}"]`) ?? null;
    } catch {
      return null; // 非本组件产出的地址形态不阻断降级提示(提示本身仍呈现)。
    }
  }

  #showFeedback(
    registerName: string,
    source: CopyFeedback["source"],
    kind: CopyFeedback["kind"],
  ): void {
    this.#clearFeedbackTimer();
    this.feedback = { registerName, source, kind };
    this.#feedbackTimer = setTimeout(() => {
      if (this.feedback?.registerName === registerName) {
        this.feedback = null;
      }
    }, COPY_FEEDBACK_HIDE_MS);
  }

  #clearFeedbackTimer(): void {
    if (this.#feedbackTimer !== undefined) {
      clearTimeout(this.#feedbackTimer);
      this.#feedbackTimer = undefined;
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#clearFeedbackTimer();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sm-register-view": SmRegisterView;
  }
}

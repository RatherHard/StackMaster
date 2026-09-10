/**
 * <sm-register-view> —— 寄存器视图(WP-F4 / FE-RG-01/02/03,公开视图档)。
 *
 * 职责:
 *  - FE-RG-01:纵向显示**所有**白名单寄存器——"所有"由服务端白名单结构性
 *    保证(M14:FLAG 等秘密寄存器不可见),前端不为白名单外寄存器留占位;
 *  - FE-RG-02:行三段布局 = 寄存器名 / valueHex(恒 `0x` + 大写,
 *    `normalizeValueHex` 归一化)/ 特殊显示列(值命中可见区域窗口 →
 *    "→ regionId" 引用,复用 render 原语风格;交叉判定复用 cross-annotation);
 *  - FE-RG-03:点击值 = 写入剪贴板(**不发生视角跳转**)——`navigator.clipboard`
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
import { normalizeValueHex } from "../../render/hex.js";
import { crossAnnotateRegisters } from "./cross-annotation.js";

/** 剪贴板写入器:resolve = 复制成功;reject = 调用方走 Q8 降级。 */
export type ClipboardWriter = (text: string) => Promise<void>;

/** 复制成功反馈文案(可见反馈,FE-RG-03)。 */
export const COPY_SUCCESS_TEXT = "已复制";

/** Q8 降级反馈文案(navigator.clipboard 不可用 / 写入被拒)。 */
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

/** 把元素的文本内容置入选区(Q8 降级:用户可直接 Ctrl+C)。 */
function selectElementText(element: Element): void {
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

/** 行内复制反馈状态。 */
interface CopyFeedback {
  readonly registerName: string;
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

    /* 特殊显示列:复用 render/special-display 原语的类名风格。 */
    .cell-special {
      font-family: ui-monospace, monospace;
      color: linktext;
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
      return html`<p class="empty" role="status">暂无寄存器数据(等待公开投影)</p>`;
    }
    const regions = this.dataSource?.regions() ?? [];
    const hitsByName = new Map(
      crossAnnotateRegisters(rows, regions).map((hit) => [hit.registerName, hit]),
    );
    return html`
      <table class="registers" part="table" aria-label="寄存器">
        <thead>
          <tr>
            <th scope="col">寄存器</th>
            <th scope="col">值</th>
            <th scope="col">特殊显示</th>
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
            title="点击复制 ${valueHex}"
            @click=${() => void this.#copyValue(row)}
          >${valueHex}</button>
          ${feedback === null
            ? nothing
            : html`<span class="copy-feedback copy-${feedback.kind}" role="status">
                ${feedback.kind === "copied" ? COPY_SUCCESS_TEXT : COPY_FALLBACK_TEXT}
              </span>`}
        </td>
        <td class="special">
          ${hit === undefined
            ? nothing
            : html`<span class="cell-special cell-region-ref" data-region="${hit.regionId}"
                >→ ${hit.regionId}</span
              >`}
        </td>
      </tr>
    `;
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
   * 复制寄存器值(FE-RG-03):成功 → 可见反馈;失败或 API 不可用 → Q8 降级
   * (选中行内值文本 + "已就绪手动复制"提示)。反馈自动消隐。
   */
  async #copyValue(row: RegisterRow): Promise<void> {
    const valueHex = normalizeValueHex(row.valueHex);
    try {
      await this.copyToClipboard(valueHex);
      this.#showFeedback(row.name, "copied");
    } catch {
      const valueCell = this.shadowRoot?.querySelector(
        `tr[data-register="${row.name}"] td.value`,
      );
      if (valueCell !== null && valueCell !== undefined) {
        selectElementText(valueCell);
      }
      this.#showFeedback(row.name, "fallback");
    }
  }

  #showFeedback(registerName: string, kind: CopyFeedback["kind"]): void {
    this.#clearFeedbackTimer();
    this.feedback = { registerName, kind };
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

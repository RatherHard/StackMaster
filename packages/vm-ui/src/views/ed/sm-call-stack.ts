/**
 * <sm-call-stack> —— 调用栈视图(WP-F9 / FE-ED-02,计划书阶段四范围)。
 *
 * `callStackSummary` 渲染(协议 PublicCallFrame:{index, functionLabel,
 * returnAddressHex, truncated?}):
 *  - index 0 = **最内帧**(当前函数;投影语义规约 §3.2 / D-P3)——行内明示
 *    "最内帧(当前函数)";
 *  - 截断:深度 > 64 时引擎保留最内 64 帧并在展示的最后一帧(index 63)打
 *    presence-only `truncated` 标记;视图以明示文案"仅显示最内 64 帧"呈现,
 *    **不得**以"+N 帧"计数表达(D2:计数是隐藏控制流深度的信号),也不渲染空白;
 *  - 空栈(callStackSummary 为空数组,如程序未进入任何调用)→ 空态明示。
 *
 * 数据面:属性驱动(`frames`),宿主从公开投影快照注入(整体替换语义:
 * ProjectionDelta.callStackSummary 存在即整体替换,由 store 承担,组件只收
 * 最新数组);视图禁止直读 client/store(README 纪律)。
 *
 * FE-ED-08 无障碍基线:语义化 table(caption + scope)+ 截断/最内帧以文本
 * 承载(屏幕阅读器不以视觉为唯一载体),地址为文本可选复制,无 Canvas。
 */
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";

import type { PublicCallFrame } from "@stackmaster/protocol";

import { LocaleController, t } from "../../i18n/i18n.js";
import { formatAddressHex } from "../../render/hex.js";
import { ensureSmThemeStyles } from "../../theme/theme-tokens.js";

/**
 * 截断明示文案(D-P3:存在性 = (可见深度, 公开常量 64) 的确定性函数)。
 * 导出常量 = zh-CN 快照(既有测试与公开 API 面);组件渲染经 i18n 键
 * `ed.callStackTruncated`(WP-53;zh-CN 值与此常量一字不差)。
 */
export const CALL_STACK_TRUNCATED_TEXT = "仅显示最内 64 帧";

@customElement("sm-call-stack")
export class SmCallStack extends LitElement {
  /** 调用栈摘要帧(公开投影 callStackSummary;空数组 → 空态)。 */
  @property({ attribute: false })
  frames: readonly PublicCallFrame[] = [];

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
      font-family: system-ui, sans-serif;
    }

    table {
      inline-size: 100%;
      border-collapse: collapse;
    }

    caption {
      padding-block: 0.25rem;
      text-align: start;
      font-size: 0.75rem;
      color: graytext;
    }

    th,
    td {
      padding: 0.25rem 0.5rem;
      text-align: start;
      border-block-end: 1px solid var(--sm-divider-faint, rgb(0 0 0 / 8%));
    }

    thead th {
      font-size: 0.75rem;
      font-weight: 600;
      color: graytext;
    }

    .index-cell {
      font-family: ui-monospace, monospace;
    }

    .addr {
      font-family: ui-monospace, monospace;
    }

    .innermost {
      margin-inline-start: 0.5rem;
      padding: 0 0.35rem;
      border-radius: 999px;
      background: var(--sm-badge-bg, rgb(0 0 0 / 8%));
      font-size: 0.75rem;
    }

    .truncated-note {
      margin: 0.25rem 0 0;
      padding: 0.25rem 0.5rem;
      font-size: 0.8125rem;
      color: graytext;
    }

    .empty {
      margin: 0;
      padding: 0.5rem 0.75rem;
      color: graytext;
      font-size: 0.875rem;
    }
  `;

  protected override render(): TemplateResult {
    if (this.frames.length === 0) {
      return html`<p class="empty" role="status">${t("ed.callStackEmpty")}</p>`;
    }
    const truncated = this.frames.some((frame) => frame.truncated === true);
    return html`
      <div>
        <table part="table" aria-label=${t("ed.callStackAria")}>
          <caption>
            ${t("ed.callStackCaption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">${t("ed.colIndex")}</th>
              <th scope="col">${t("ed.colFunction")}</th>
              <th scope="col">${t("ed.colReturnAddress")}</th>
            </tr>
          </thead>
          <tbody>
            ${this.frames.map((frame) => this.#renderFrame(frame))}
          </tbody>
        </table>
        ${truncated
          ? html`<p class="truncated-note" role="note">${t("ed.callStackTruncated")}</p>`
          : nothing}
      </div>
    `;
  }

  #renderFrame(frame: PublicCallFrame): TemplateResult {
    return html`
      <tr>
        <th scope="row" class="index-cell">
          ${frame.index}${frame.index === 0
            ? html`<span class="innermost">${t("ed.innermostFrame")}</span>`
            : nothing}
        </th>
        <td>${frame.functionLabel}</td>
        <td class="addr">${formatAddressHex(frame.returnAddressHex)}</td>
      </tr>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sm-call-stack": SmCallStack;
  }
}

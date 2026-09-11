/**
 * <sm-error-explainer> —— 错误解释展示(WP-F9 / FE-ED-07,计划书阶段四范围)。
 *
 * `PublicError`(protocol 冻结契约)+ `PublicErrorMapping[]`(本地结构类型,
 * 对齐 challenge-schema publicErrorMapping,锚 = src/ed/ed-types.ts)的
 * 可解释性反馈呈现:
 *  - code 徽标 + message(协议 E-5 静态最小文案);
 *  - **能力矩阵缺席形态**(纪律:缺席就不渲染,不以 null/空串区分):
 *    `addressHex` 缺席或 null(forbidden / null-only 形态,投影语义规约 §5.1、
 *    I-9)不渲染地址行;`explanation` 缺席(forbidden 码:E-4 / I-7 零解释)
 *    不渲染解释段;explanation 子字段逐键"存在才渲染"(strictObject 下
 *    缺席 = 键整体缺席,不存在空串/null 占位形态);
 *  - **teachingNote**:按 `errorCode` 匹配题目映射;无匹配给默认教学文案
 *    "该错误暂无教学注解"(规约口径,见 ed-types.ts DEFAULT_TEACHING_NOTE)。
 *
 * 数据面:属性驱动;error 由宿主接 onActionRejected / userVisibleError 注入,
 * mappings 由公开描述包 `publicErrorMapping` 注入(接线归 WP-F8)。
 *
 * FE-ED-08 无障碍基线:section + aria-label、dl 语义(字段名-值对)、教学
 * 注解与默认文案均为文本(不以视觉为唯一载体)。
 */
import { LitElement, css, html, nothing, type TemplateResult } from "lit";

/** 渲染返回面:模板或 nothing(缺席不渲染)。 */
type Renderable = TemplateResult | typeof nothing;
import { customElement, property } from "lit/decorators.js";

import type { PublicError } from "@stackmaster/protocol";

import { DEFAULT_TEACHING_NOTE, type PublicErrorMapping } from "../../ed/ed-types.js";
import { normalizeValueHex } from "../../render/hex.js";

@customElement("sm-error-explainer")
export class SmErrorExplainer extends LitElement {
  /** 用户可见错误(缺省 = 当前无错误,呈现空态)。 */
  @property({ attribute: false })
  error: PublicError | null = null;

  /** 题目错误教学注解映射(公开描述包 publicErrorMapping)。 */
  @property({ attribute: false })
  mappings: readonly PublicErrorMapping[] = [];

  static override styles = css`
    :host {
      display: block;
      font-family: system-ui, sans-serif;
    }

    .code-line {
      display: flex;
      gap: 0.5rem;
      align-items: baseline;
      margin: 0 0 0.25rem;
    }

    .code-badge {
      flex: none;
      padding: 0 0.35rem;
      border-radius: 999px;
      background: rgb(0 0 0 / 8%);
      font-family: ui-monospace, monospace;
      font-size: 0.75rem;
    }

    dl {
      margin: 0.25rem 0;
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 0.125rem 0.75rem;
      font-size: 0.875rem;
    }

    dt {
      color: graytext;
    }

    dd {
      margin: 0;
      overflow-wrap: anywhere;
    }

    .mono {
      font-family: ui-monospace, monospace;
    }

    .teaching-note {
      margin: 0.5rem 0 0;
      padding: 0.25rem 0.5rem;
      border-inline-start: 3px solid rgb(0 0 0 / 20%);
      font-size: 0.875rem;
    }

    .empty {
      margin: 0;
      padding: 0.5rem 0.75rem;
      color: graytext;
      font-size: 0.875rem;
    }
  `;

  protected override render(): TemplateResult {
    const error = this.error;
    if (error === null) {
      return html`<p class="empty" role="status">当前没有错误</p>`;
    }
    const teachingNote =
      this.mappings.find((mapping) => mapping.errorCode === error.code)?.teachingNote ??
      DEFAULT_TEACHING_NOTE;
    return html`
      <section aria-label="错误解释" part="panel">
        <p class="code-line">
          <span class="code-badge">${error.code}</span>
          <span class="message">${error.message}</span>
        </p>
        ${this.#renderAddress(error)} ${this.#renderExplanation(error)}
        <p class="teaching-note">教学注解:${teachingNote}</p>
      </section>
    `;
  }

  /** 地址行:能力矩阵缺席形态——undefined / null / 空串一律不渲染。 */
  #renderAddress(error: PublicError): Renderable {
    const addressHex = error.addressHex;
    if (addressHex === undefined || addressHex === null || addressHex === "") {
      return nothing;
    }
    return html`
      <dl>
        <dt>地址</dt>
        <dd class="mono">${addressHex}</dd>
      </dl>
    `;
  }

  /** 解释段:explanation 缺席不渲染;子字段逐键"存在才渲染"。 */
  #renderExplanation(error: PublicError): Renderable {
    const explanation = error.explanation;
    if (explanation === undefined) {
      return nothing;
    }
    return html`
      <dl>
        ${explanation.regionId === undefined
          ? nothing
          : html`<dt>区域</dt><dd class="mono">${explanation.regionId}</dd>`}
        ${explanation.permissions === undefined
          ? nothing
          : html`<dt>区域权限</dt><dd class="mono">${explanation.permissions}</dd>`}
        ${explanation.valueHex === undefined
          ? nothing
          : html`<dt>涉及的值</dt><dd class="mono">${normalizeValueHex(explanation.valueHex)}</dd>`}
        ${explanation.interpretedAs === undefined
          ? nothing
          : html`<dt>值被解释为</dt><dd class="mono">${explanation.interpretedAs}</dd>`}
        ${explanation.alignmentBytes === undefined
          ? nothing
          : html`<dt>对齐要求</dt><dd>${explanation.alignmentBytes} 字节</dd>`}
        ${explanation.expectedBytesLength === undefined
          ? nothing
          : html`<dt>期望长度</dt><dd>${explanation.expectedBytesLength} 字节</dd>`}
        ${explanation.actualBytesLength === undefined
          ? nothing
          : html`<dt>实际长度</dt><dd>${explanation.actualBytesLength} 字节</dd>`}
        ${explanation.hints === undefined
          ? nothing
          : html`<dt>提示</dt><dd>${this.#renderHints(explanation.hints)}</dd>`}
      </dl>
    `;
  }

  #renderHints(hints: readonly string[]): TemplateResult {
    return html`<ul class="hint-list">
      ${hints.map((hint) => html`<li>${hint}</li>`)}
    </ul>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sm-error-explainer": SmErrorExplainer;
  }
}

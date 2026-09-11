/**
 * <sm-structure-view> —— 结构视图(WP-F9 / FE-ED-01,计划书阶段四范围)。
 *
 * `semanticHighlights` 教学标注呈现:把"buffer 起点 / 返回地址槽 / saved RBP
 * 槽 / canary 槽 / 自定义"等教学概念(协议 SemanticHighlightKind 冻结枚举)
 * 按 kind 分组列表呈现;每条显示 label + kind 徽标 + 目标区域与起始地址 +
 * 字节长度;点击条目发出 `highlight-jump` 事件(detail {regionId, addressHex},
 * bubbles + composed)——组件只发事件,滚动/定位由宿主(F8)接线。
 *
 * 数据面:属性驱动(`highlights`),宿主从公开投影快照
 * (`PublicStateProjection.semanticHighlights`)注入——semanticHighlights 是
 * 静态声明面(投影语义规约 §3.4:增量恒缺席),只在初始投影 / sync 全量变化;
 * 视图禁止直读 client/store(README 纪律)。
 *
 * FE-ED-08 无障碍基线:语义化嵌套列表(kind 分组 = ul > li > ul)、条目为
 * 原生 button(Enter/Space 激活、焦点可见)、aria-label 承载完整教学信息
 * (徽标 / 区域 / 地址 / 长度不以视觉为唯一载体)、空态明示。
 */
import { LitElement, css, html, nothing, type TemplateResult } from "lit";

/** 渲染返回面:模板或 nothing(缺席不渲染)。 */
type Renderable = TemplateResult | typeof nothing;
import { customElement, property } from "lit/decorators.js";

import type { SemanticHighlight, SemanticHighlightKind } from "@stackmaster/protocol";

/** `highlight-jump` 事件 detail(宿主接线:定位到 regionId @ addressHex)。 */
export interface HighlightJumpDetail {
  readonly regionId: string;
  readonly addressHex: string;
}

/** kind 分组呈现序与分组标签(冻结枚举全量,不新增不遗漏)。 */
const KIND_GROUPS: readonly { readonly kind: SemanticHighlightKind; readonly label: string }[] = [
  { kind: "buffer_start", label: "buffer 起点" },
  { kind: "return_address_slot", label: "返回地址槽" },
  { kind: "saved_rbp_slot", label: "saved RBP 槽" },
  { kind: "canary_slot", label: "canary 槽" },
  { kind: "custom", label: "自定义标注" },
];

@customElement("sm-structure-view")
export class SmStructureView extends LitElement {
  /** 语义高亮列表(公开投影 semanticHighlights;空/缺省 → 空态)。 */
  @property({ attribute: false })
  highlights: readonly SemanticHighlight[] = [];

  static override styles = css`
    :host {
      display: block;
      font-family: system-ui, sans-serif;
    }

    ul,
    li {
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .group > .group-label {
      display: block;
      margin-block: 0.5rem 0.25rem;
      font-size: 0.75rem;
      font-weight: 600;
      color: graytext;
    }

    .group > ul {
      margin-inline-start: 0.25rem;
    }

    .entry-button {
      display: inline-flex;
      gap: 0.5rem;
      align-items: baseline;
      inline-size: 100%;
      margin-block: 2px;
      padding: 0.25rem 0.5rem;
      border: 1px solid rgb(0 0 0 / 15%);
      border-radius: 4px;
      background: none;
      color: inherit;
      font: inherit;
      text-align: start;
      cursor: pointer;
    }

    .entry-button:focus-visible {
      outline: 2px solid accentcolor;
      outline-offset: 1px;
    }

    .kind-badge {
      flex: none;
      padding: 0 0.35rem;
      border-radius: 999px;
      background: rgb(0 0 0 / 8%);
      font-size: 0.75rem;
    }

    .entry-label {
      font-weight: 600;
    }

    .entry-meta {
      font-family: ui-monospace, monospace;
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
    if (this.highlights.length === 0) {
      return html`<p class="empty" role="status">
        暂无结构标注(semanticHighlights 随初始公开投影或同步下发)
      </p>`;
    }
    return html`
      <ul aria-label="内存结构教学标注">
        ${KIND_GROUPS.map((group) => this.#renderGroup(group.kind, group.label))}
      </ul>
    `;
  }

  /** 单 kind 分组:组内条目为原生按钮(点击 → highlight-jump);空组不渲染。 */
  #renderGroup(kind: SemanticHighlightKind, groupLabel: string): Renderable {
    const entries = this.highlights.filter((highlight) => highlight.kind === kind);
    if (entries.length === 0) {
      return nothing;
    }
    return html`
      <li class="group">
        <span class="group-label">${groupLabel}</span>
        <ul aria-label="${groupLabel}">
          ${entries.map((entry) => this.#renderEntry(entry, groupLabel))}
        </ul>
      </li>
    `;
  }

  #renderEntry(entry: SemanticHighlight, groupLabel: string): TemplateResult {
    return html`
      <li>
        <button
          type="button"
          class="entry-button"
          @click=${() => this.#emitJump(entry)}
        >
          <span class="kind-badge" aria-hidden="true">${groupLabel}</span>
          <span class="entry-label">${entry.label}</span>
          <span class="entry-meta">
            ${entry.targetRegionId} @ ${entry.startAddressHex} · ${entry.byteLength}B
          </span>
        </button>
      </li>
    `;
  }

  /** 点击条目 → highlight-jump 事件(bubbles + composed;组件只发事件)。 */
  #emitJump(entry: SemanticHighlight): void {
    this.dispatchEvent(
      new CustomEvent<HighlightJumpDetail>("highlight-jump", {
        detail: { regionId: entry.targetRegionId, addressHex: entry.startAddressHex },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sm-structure-view": SmStructureView;
  }
}

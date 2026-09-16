/**
 * <sm-register-annotation> —— 字节视图行左缘寄存器交叉标注(WP-F5 集成组件)。
 *
 * FE-RG-04 集成口径:字节视图行左缘出现寄存器名标注(数据 =
 * `crossAnnotateRegisters` 命中集,**按行 `rowBaseAddressHex` 对齐**后由工作区
 * 传入);点击标注 → 行内展开寄存器值列表(展开条),再点收起。
 *
 * 实现形态:宿主层(sm-workspace 行装饰)渲染本组件进字节视图行左缘槽位,
 * **不修改 F3/F4 已交付组件**;按钮面复用 F4 的
 * `renderRegisterAnnotationCell(hits)`(`.reg-annotation` + data-registers),
 * 展开行为(宿主层)在本组件内闭环——展开态由组件自持,无需与工作区同步。
 *
 * 动画纪律:零动画;语义化 DOM(button + 展开 detail 列表)。
 *
 * 主题消费(WP-74):标注面原色 `highlight` 归 `--sm-warn`(其 light / dark 值
 * 即 `highlight` 原样 ⇒ 明暗零变化,terminal 下转为琥珀);前景 / 焦点环 / 等宽
 * 字体同走 token。该标注**不可归入 `--sm-accent`(青绿 = 可点击地址)**:其
 * light 值为 `linktext`,替换会改变 light / dark 渲染(与「零变化」硬约束冲突)。
 */
import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { ensureSmThemeStyles } from "../theme/theme-tokens.js";
import { renderRegisterAnnotationCell, type RegisterHit } from "../views/register/cross-annotation.js";

@customElement("sm-register-annotation")
export class SmRegisterAnnotation extends LitElement {
  /** 命中本行的寄存器标注(crossAnnotateRegisters 的行过滤结果)。 */
  @property({ attribute: false })
  hits: readonly RegisterHit[] = [];

  /** 展开态(点击标注按钮切换;值列表行内呈现)。 */
  @state()
  private expanded = false;

  override connectedCallback(): void {
    super.connectedCallback();
    // 主题锚样式表(幂等,WP-74):变量经 data-sm-theme 宿主锚继承穿透 shadow DOM
    // (独立使用形态亦正确;宿主层形态下与 sm-workspace 的注入同源无害)。
    ensureSmThemeStyles(this.ownerDocument ?? document);
  }

  static override styles = css`
    :host {
      display: inline-flex;
      flex-direction: column;
      align-items: flex-start;
      margin-inline-end: 0.5ch;
      vertical-align: baseline;
      font-family: var(--sm-font-mono, ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, "Noto Sans Mono CJK SC", monospace);
      font-size: 0.8125rem;
    }

    .reg-annotation {
      padding: 0 0.25rem;
      border: 1px solid color-mix(in srgb, var(--sm-warn, highlight) 40%, transparent);
      border-radius: 4px;
      background: color-mix(in srgb, var(--sm-warn, highlight) 10%, transparent);
      color: var(--sm-warn, highlight);
      font: inherit;
      cursor: pointer;
    }

    .reg-annotation:focus-visible {
      outline: 2px solid var(--sm-focus-ring, accentcolor);
      outline-offset: 1px;
    }

    /* 展开条:行内寄存器值列表(点击展开的宿主层落地)。 */
    .reg-values {
      margin: 0.125rem 0 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 0.0625rem;
      white-space: nowrap;
    }

    .reg-values li {
      color: var(--sm-fg, canvastext);
    }

    .reg-value {
      font-weight: 600;
    }
  `;

  protected override render(): unknown {
    if (this.hits.length === 0) {
      return nothing;
    }
    return html`
      <!-- 展开态语义(aria-expanded)由 renderRegisterAnnotationCell 落在
           真实 button 上(WP-55 axe 真机修正);外层容器保持 generic。 -->
      <span class="annotation" @click=${this.#onToggle}>
        ${renderRegisterAnnotationCell(this.hits, { expanded: this.expanded })}
        ${this.expanded ? this.#renderValues() : nothing}
      </span>
    `;
  }

  #renderValues(): unknown {
    return html`
      <ul class="reg-values" role="list">
        ${this.hits.map(
          (hit) => html`
            <li class="reg-value-row" data-register=${hit.registerName}>
              <span class="reg-name">${hit.registerName}</span> =
              <span class="reg-value">${hit.valueHex}</span>
              <span class="reg-target">(→ ${hit.targetAddressHex})</span>
            </li>
          `,
        )}
      </ul>
    `;
  }

  /**
   * 点击标注按钮 → 切换展开(模板内监听:同 shadow 树内 target 不重定向,
   * 复用 F4 无按钮逻辑的渲染辅助;展开条内点击不收起,便于选中复制)。
   * 键盘激活由真实 button 原生承担(WP-55 axe 真机修正)。
   */
  readonly #onToggle = (event: Event): void => {
    const target = event.target;
    if (target instanceof Element && target.closest(".reg-annotation") !== null) {
      this.expanded = !this.expanded;
    }
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "sm-register-annotation": SmRegisterAnnotation;
  }
}

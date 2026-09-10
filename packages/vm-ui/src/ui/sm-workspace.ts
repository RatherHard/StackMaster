/**
 * <sm-workspace> —— 工作区空壳组件(WP-F1 占位)。
 *
 * 职责:提供插件开发壳(apps/plugin-dev)可挂载的空标签页区域,作为
 * WP-F5"工作区容器与菜单"(列式滚动平铺、标签页生命周期)的实现锚点。
 * 本组件刻意保持零业务逻辑:不依赖任何数据源,只渲染语义化占位结构。
 *
 * 纪律(CLAUDE.md 第十章):
 *  - 浏览器只保存公开投影与 UI 状态——本组件不持有任何会话数据;
 *  - 语义化 DOM:header/main/section 承载结构,屏幕阅读器可感知占位状态;
 *  - 动画只用 compositor 友好属性(当前占位无动画,后续视图遵守同款约束)。
 */
import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("sm-workspace")
export class SmWorkspace extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-block-size: 12rem;
      border: 1px solid rgb(0 0 0 / 15%);
      border-radius: 8px;
      background: canvas;
      color: canvastext;
    }

    header {
      padding: 0.5rem 0.75rem;
      border-block-end: 1px solid rgb(0 0 0 / 10%);
    }

    .heading {
      margin: 0;
      font-size: 1rem;
      font-weight: 600;
    }

    .tab-area {
      flex: 1;
      display: grid;
      place-items: center;
      padding: 1rem;
    }

    .tab-placeholder {
      margin: 0;
      color: graytext;
      font-size: 0.875rem;
    }
  `;

  /** 工作区标题(WP-F5 工作区容器接手前的展示位)。 */
  @property({ type: String })
  heading = "StackMaster Workspace";

  protected override render(): unknown {
    return html`
      <header part="header">
        <h2 class="heading">${this.heading}</h2>
      </header>
      <section class="tab-area" part="tab-area" aria-label="工作区标签页区域">
        <p class="tab-placeholder" role="status">
          sm-workspace:空标签页区域(占位;工作区容器归 WP-F5)
        </p>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sm-workspace": SmWorkspace;
  }
}

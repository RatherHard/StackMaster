/**
 * <pwn-memory-vm> —— 占位桩组件(阶段四 WP-F1,**占位零实现**)。
 *
 * 阶段四边界(阶段四任务分解 §一裁决 3):iframe / postMessage / 宿主协议、
 * embed token 浏览器面、自适应高度/主题/语言全部归阶段五;本阶段本包仅建包
 * 占位,导出一个最小 LitElement 桩渲染占位内容,**不实现任何视图**。
 *
 * 依赖纪律:对工作区包只允许依赖 @stackmaster/protocol 公开入口
 * (dependency-cruiser browser-packages-only-depend-on-protocol 规则);
 * 占位阶段尚无 protocol 运行时消费,依赖仅为声明依赖方向与 turbo 构建序。
 */
import { LitElement, css, html } from "lit";
import { customElement } from "lit/decorators.js";

@customElement("pwn-memory-vm")
export class PwnMemoryVm extends LitElement {
  static override styles = css`
    :host {
      display: block;
      border: 1px dashed rgb(0 0 0 / 25%);
      border-radius: 8px;
      padding: 1rem;
      background: canvas;
      color: canvastext;
    }

    .placeholder {
      margin: 0;
      font-size: 0.875rem;
      color: graytext;
    }
  `;

  protected override render(): unknown {
    return html`<p class="placeholder" role="status">pwn-memory-vm placeholder</p>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "pwn-memory-vm": PwnMemoryVm;
  }
}

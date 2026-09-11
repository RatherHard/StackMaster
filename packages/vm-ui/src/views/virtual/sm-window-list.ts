/**
 * <sm-window-list> —— 自研窗口化虚拟列表(阶段四 WP-F7 收口引入)。
 *
 * 引入原因:@lit-labs/virtualizer 2.1.1 在本仓库实际环境(Vite 8/rolldown
 * 构建产物 + 嵌套 shadow DOM 挂载)下存在确定性缺陷——scroller 模式的
 * rangeChanged 不触发,行不渲染且带偶发首实例才渲染的时序性(最小复现与
 * 证据见 packages/vm-ui/README.md「第三方依赖审计」)。字节/指令视图窗口
 * 上限 512 行,本组件以约百行实现确定性虚拟化:
 *
 *  - 元素自身即滚动容器(position:relative + overflow-y:auto);
 *  - 流内 sizer 撑出总滚动高度,可见切片以 translateY 定位(light DOM
 *    渲染,宿主视图的 shadow 样式可正常作用于行内容);
 *  - 行高 = 首行实测高度优先,回退 rowHeight 属性(jsdom 等无布局环境
 *    实测为 0,自动退化为全量渲染——测试与打印路径零特殊处理);
 *  - scroll / ResizeObserver 触发,rAF 合帧重算窗口。
 */
import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";

/** 可见切片渲染回调(返回宿主视图的 Lit 模板;light DOM 渲染保样式)。 */
export type WindowListItemRenderer = (item: unknown, index: number) => unknown;

/** 无布局环境(clientHeight=0)下的回退视口行数:窗口化在任何环境有界。 */
const FALLBACK_VIEWPORT_ROWS = 16;

@customElement("sm-window-list")
export class SmWindowList extends LitElement {
  /** 列表数据(只读快照;换绑即整体重建)。 */
  @property({ attribute: false })
  items: readonly unknown[] = [];

  /** 行渲染回调(必填;语义与 lit-virtualizer 的 renderItem 一致)。 */
  @property({ attribute: false })
  renderItem: WindowListItemRenderer | null = null;

  /** 行高估值(px);首行实测值可用时以实测为准。 */
  @property({ type: Number })
  rowHeight = 24;

  /** 视口上下各多渲染的行数(滚动平滑垫片)。 */
  @property({ type: Number })
  overscan = 8;

  /** 当前窗口(渲染期由 #updateWindow 以有界视口计算;初值 = 回退视口量级)。 */
  #first = 0;
  #last = 31;
  #measuredRowHeight = 0;
  #resizeObserver: ResizeObserver | null = null;
  #rafHandle = 0;
  readonly #onScroll = (): void => {
    this.#scheduleWindowUpdate();
  };

  static override styles = css`
    :host {
      display: block;
      position: relative;
      overflow-y: auto;
    }
    .sizer {
      /* 流内撑高:滚动条几何 = items × 行高;空元素无绘制成本。 */
      width: 1px;
    }
    .window {
      position: absolute;
      inset-inline: 0;
      top: 0;
      will-change: transform;
    }
  `;

  /** light DOM 渲染(照 lit-virtualizer 同款架构):宿主视图的 shadow 样式直接作用于行内容。 */
  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (typeof ResizeObserver !== "undefined") {
      this.#resizeObserver = new ResizeObserver(() => this.#scheduleWindowUpdate());
      this.#resizeObserver.observe(this);
    }
    this.addEventListener("scroll", this.#onScroll, { passive: true });
  }

  override disconnectedCallback(): void {
    this.removeEventListener("scroll", this.#onScroll);
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    if (this.#rafHandle !== 0) {
      cancelAnimationFrame(this.#rafHandle);
      this.#rafHandle = 0;
    }
    super.disconnectedCallback();
  }

  override updated(): void {
    this.#measureFirstRow();
  }

  override render(): unknown {
    const rowH = this.#effectiveRowHeight;
    const total = this.items.length * rowH;
    const last = Number.isFinite(this.#last) ? Math.min(this.#last, this.items.length - 1) : this.items.length - 1;
    const slice: unknown[] = [];
    for (let index = this.#first; index <= last; index += 1) {
      const rendered = this.renderItem?.(this.items[index], index);
      if (rendered !== undefined) {
        slice.push(rendered);
      }
    }
    return html`
      <div class="sizer" aria-hidden="true" style="height:${total}px"></div>
      <div class="window" style="transform:translateY(${this.#first * rowH}px)">${slice}</div>
    `;
  }

  /** 滚动到指定行(语义对齐 lit-virtualizer 的 scrollToIndex;无布局环境静默)。 */
  scrollToIndex(index: number, position: "start" | "center" | "end" = "start"): void {
    const rowH = this.#effectiveRowHeight;
    const clamped = Math.max(0, Math.min(index, this.items.length - 1));
    const viewport = this.clientHeight;
    let target = clamped * rowH;
    if (position === "center") {
      target -= (viewport - rowH) / 2;
    } else if (position === "end") {
      target -= viewport - rowH;
    }
    this.scrollTop = Math.max(0, target);
    this.#scheduleWindowUpdate();
  }

  /** 实测行高优先(jsdom 无布局 → 实测 0 → 回退 rowHeight 属性)。 */
  get #effectiveRowHeight(): number {
    return this.#measuredRowHeight > 0 ? this.#measuredRowHeight : this.rowHeight;
  }

  #scheduleWindowUpdate(): void {
    if (this.#rafHandle !== 0) {
      return;
    }
    this.#rafHandle = requestAnimationFrame(() => {
      this.#rafHandle = 0;
      this.#updateWindow();
    });
  }

  #updateWindow(): void {
    const rowH = this.#effectiveRowHeight;
    if (rowH <= 0 || this.items.length === 0) {
      this.#first = 0;
      this.#last = Number.POSITIVE_INFINITY;
      this.requestUpdate();
      return;
    }
    // 无布局环境(jsdom / display:none)clientHeight=0:以有界回退视口窗口化
    // (硬门槛"虚拟化真实生效"在任何环境下都成立,不退化为全量渲染)。
    const viewport = this.clientHeight > 0 ? this.clientHeight : rowH * FALLBACK_VIEWPORT_ROWS;
    const first = Math.max(0, Math.floor(this.scrollTop / rowH) - this.overscan);
    const visible = Math.ceil(viewport / rowH) + 2 * this.overscan;
    const last = Math.min(this.items.length - 1, first + visible);
    if (first !== this.#first || last !== this.#last) {
      this.#first = first;
      this.#last = last;
      this.requestUpdate();
    }
  }

  #measureFirstRow(): void {
    if (this.#measuredRowHeight > 0) {
      return;
    }
    const firstRow = this.renderRoot.querySelector(".window")?.firstElementChild as HTMLElement | null;
    const measured = firstRow?.offsetHeight ?? 0;
    if (measured > 0) {
      this.#measuredRowHeight = measured;
      this.#updateWindow();
    }
  }
}

/** 供测试/工具断言的注册态探测(不进公开 API 面)。 */
export const SM_WINDOW_LIST_TAG = "sm-window-list";

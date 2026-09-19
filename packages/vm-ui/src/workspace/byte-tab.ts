/**
 * <sm-byte-tab> —— 字节视图标签页(WP-F5;栈视图 / 自由视图标签页的组合页)。
 *
 * 职责 = **跨视图联动接线**(FE-FV-06 × FE-ST-09 的宿主层落地):
 *  - 布局:左侧 `<sm-byte-view>` 主体 + 右侧 `<sm-vma-list>` 侧栏;
 *  - `vma-select` → `byteView.showRegion(regionId)`(VMA 跳转到区域头部);
 *  - `region-change` → 回写 `vmaList.selectedRegionId`(选择高亮回路);
 *  - `rowDecorator` 透传字节视图(工作区在此挂寄存器交叉标注与跳转链,
 *    见 sm-workspace.ts;本组件只做转发,不理解装饰语义);
 *  - `refresh()`:投影变更驱动(工作区 onProjectionChanged 时调用)。
 *
 * **地标维度注入(WP-74 前置修复)**:本组件是「窗口标题 → 内层视图地标名」
 * 的唯一转发点:VMA 侧栏地标名 = `viewLabel`(栈视图 / 自由视图)+ 侧栏部件名,
 * 使两个常驻字节窗口的侧栏不再同名(axe `landmark-unique`);窗口面板自身的
 * 可达名称仍是窗口标题(WP-71「标题栏与 aria-label 同源」承诺不动)。
 *
 * 数据纪律:只依赖 `MemoryDataSource` 接口;不接触 SessionClient。
 * 动画纪律:零动画(如引入过渡只允许 transform / opacity)。
 */
import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";

import {
  SmByteView,
  type ByteRowDecoration,
  type ByteViewKind,
} from "../views/byte/byte-view.js";
import { SmVmaList } from "../views/byte/vma-list.js";
import { LocaleController, t } from "../i18n/i18n.js";
import type { MemoryDataSource, Row } from "../datasource/types.js";

/** 行装饰回调形态(与 SmByteView.rowDecorator 一致的透传面)。 */
export type ByteTabRowDecorator = (
  row: Row,
  index: number,
) => ByteRowDecoration | null | undefined;

@customElement("sm-byte-tab")
export class SmByteTab extends LitElement {
  /** 数据源(工作区组合根注入;换绑透传两个子视图)。 */
  @property({ attribute: false })
  dataSource: MemoryDataSource | null = null;

  /** 字节视图形态(stack = 栈视图 / free = 自由视图;F3:只决定标题)。 */
  @property({ type: String, attribute: "view-kind" })
  viewKind: ByteViewKind = "stack";

  /** 行装饰回调(工作区注入;透传字节视图)。 */
  @property({ attribute: false })
  rowDecorator: ByteTabRowDecorator | null = null;

  /** i18n:窗口维度名(标签页标题)随 locale 求值 → 侧栏地标名前缀同步刷新。 */
  readonly #i18n = new LocaleController(this);

  override connectedCallback(): void {
    super.connectedCallback();
    // LocaleController 经构造副作用注册;显式读点满足 lint(同 vma-list 惯例)。
    void this.#i18n;
  }

  /** 窗口维度名(= 该字节标签页对应窗口的标题;WP-74 前置修复的地标去重维度)。 */
  get viewLabel(): string {
    return this.viewKind === "free" ? t("tab.free") : t("tab.stack");
  }

  static override styles = css`
    :host {
      display: block;
      block-size: 100%;
      min-block-size: 0;
      /* 内联轴尺寸隔离 + 建容器(WP-95a / 遗留 #39 修法第一层)。
         见下方「容器查询:窄档折叠 VMA 侧栏」的推导。 */
      contain: inline-size;
      container-type: inline-size;
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 14rem;
      gap: 0.5rem;
      block-size: 100%;
      /* 整页布局改版(2026-09-18 / D-API-153):视图位高度由工作区给定时,
         本网格必须**恰占满且不撑高**(min-block-size: 0 松开内容最小高),
         否则字节视图会被自己的固定高顶出视图位。 */
      min-block-size: 0;
    }

    sm-byte-view {
      min-block-size: 0;
      min-inline-size: 0;
    }

    .aside {
      min-block-size: 0;
      overflow-y: auto;
    }

    /* ── 容器查询:窄档折叠 VMA 侧栏(WP-95a;判据 = D-UI-2 补 ③)─────────────

       **为什么必须按容器宽而不是视口宽**(遗留 #39 的根因第一层):本组件被放在
       「半页」视图位里,而 <sm-byte-view> 自带 14rem(224px)侧栏 + 0.5rem 列距
       ⇒ 容器宽 W 下主体只有 W − 232px。旧实现用 @media (max-width: 40rem)
       判定,**按视口宽**:

         | 视口 | 容器宽 | 主体宽 | 旧 media 判定(视口 ≤ 640px?) |
         |---|---|---|---|
         | 1440 | 720 | 488 | 否 ⇒ 侧栏在 |
         | 1024 | 512 | **280** | **否 ⇒ 侧栏在(类别错误)** |
         | 768  | 452 | **220** | **否 ⇒ 侧栏在(类别错误)** |
         | 375  | 452 | 452 | 是 ⇒ 折叠(巧合对了) |

       ⇒ 1024 / 768 档侧栏**在场**,主体被压到 280 / 220px,而 .byte-row 的
       地址 + 十六进制两轨就占 320px ⇒ 第三列被压到 14px、「特殊显示」列头折
       4 行(21.8 → 83.19px),chrome 反超视图位高 ⇒ 数据行整块落到可视区之下
       (真机实测:完整可见数据行 **0**)。

       **阈值推导(40rem = 640px;按主体所需宽度取整上推)**:
       - 主体需要装下「地址 16ch + 间隙 1.5ch + 十六进制 26ch」= 44.5ch ≈ 347px
         (13px × 0.6em = 7.8px/ch),再加「特殊显示」列头实宽(4 字 ≈ 52px)
         ⇒ 主体舒适宽 ≈ **400px**;
       - 主体宽 = W − 224 − 8 ⇒ W ≈ 632px ⇒ 上取整到 **40rem(640px)**;
       - 40rem 也是**原媒体查询断点** —— 只把判定轴从「视口」改为「容器」,
         不新造断点族(docs/develop/decisions-分发改版与UI重设计.md 的 §四·补.1
         第 1 条:窄档折叠可折叠辅助面是正解;D-UI-5 补明文接受该降级)。

       **闭环核对(改后真机读数,见 apps/page-app/e2e/geometry-guard.spec.ts)**:
       1440(720 ⇒ 侧栏**在**,主体 488px)/ 1024(512 ⇒ **折叠**,主体 512px)/
       768(452 ⇒ **折叠**,主体 452px)/ 375(452 ⇒ **折叠**,主体 452px)
       ⇒ 主体恒 ≥ 452px > 400px,**四个视口档的字节视图都不再被压扁**。 */
    @container (max-width: 40rem) {
      .layout {
        grid-template-columns: minmax(0, 1fr);
      }
      .aside {
        display: none;
      }
    }

    /* 更窄容器(36rem = 576px;对应 375 档的 452px 主体):列距收紧,
       给字节视图多让 8px。与上一条同轴(容器宽),不引入视口断点。 */
    @container (max-width: 36rem) {
      .layout {
        gap: 0.25rem;
      }
    }
  `;

  protected override updated(): void {
    // 属性透传(渲染收敛后同步;子元素经首次 render 存在)。
    const view = this.#viewElement();
    const list = this.#listElement();
    if (view !== null) {
      if (view.dataSource !== this.dataSource) {
        view.dataSource = this.dataSource;
      }
      view.viewKind = this.viewKind;
      const decorator = this.rowDecorator as SmByteView["rowDecorator"];
      if (view.rowDecorator !== decorator) {
        view.rowDecorator = decorator;
      }
    }
    if (list !== null && list.dataSource !== this.dataSource) {
      list.dataSource = this.dataSource;
    }
  }

  /** 字节视图本体(工作区 viewport-jump 滚动接线的定位面)。 */
  get byteView(): SmByteView | null {
    return this.#viewElement();
  }

  /** VMA 侧栏(测试与宿主接线面)。 */
  get vmaList(): SmVmaList | null {
    return this.#listElement();
  }

  /** 投影变更驱动刷新(工作区 onProjectionChanged 接线点)。 */
  refresh(): void {
    this.#viewElement()?.refresh();
    this.#listElement()?.refresh();
  }

  #viewElement(): SmByteView | null {
    return this.renderRoot.querySelector("sm-byte-view");
  }

  #listElement(): SmVmaList | null {
    return this.renderRoot.querySelector("sm-vma-list");
  }

  protected override render(): unknown {
    return html`
      <div class="layout">
        <sm-byte-view
          view-kind=${this.viewKind}
          @region-change=${(event: CustomEvent<{ regionId: string }>) => {
            // 选择高亮回路:字节视图切区域 → 回写 VMA 侧栏选中态。
            const list = this.#listElement();
            if (list !== null) {
              list.selectedRegionId = event.detail.regionId;
            }
          }}
        ></sm-byte-view>
        <sm-vma-list
          class="aside"
          .viewLabel=${this.viewLabel}
          @vma-select=${(event: CustomEvent<{ regionId: string }>) => {
            // VMA 跳转回路:点击侧栏条目 → 字节视图切区域并锚定区域头部。
            this.#viewElement()?.showRegion(event.detail.regionId);
          }}
        ></sm-vma-list>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sm-byte-tab": SmByteTab;
  }
}

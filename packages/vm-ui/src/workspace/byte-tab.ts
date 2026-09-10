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

  static override styles = css`
    :host {
      display: block;
      block-size: 100%;
      min-block-size: 0;
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 14rem;
      gap: 0.5rem;
      block-size: 100%;
    }

    sm-byte-view {
      min-block-size: 0;
      min-inline-size: 0;
    }

    .aside {
      min-block-size: 0;
      overflow-y: auto;
    }

    @media (max-width: 40rem) {
      .layout {
        grid-template-columns: minmax(0, 1fr);
      }
      .aside {
        display: none;
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

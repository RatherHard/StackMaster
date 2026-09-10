/**
 * <sm-vma-list> —— VMA 列表侧栏(WP-F3;FE-FV-06 公开档口径)。
 *
 * 数据 = `dataSource.regions()` 直读(visibleRegions 公开布局 + D3 锚定窗口
 * 交付尺寸);展示每区域的 regionId / label / 起址 / 长度 / 权限(rwx 规范序)/
 * 窗口字节数(截断标记)。FE-FV-06:列表**按地址有序**;点击条目派发
 * `vma-select` 事件(detail = {regionId}),由宿主(F5)或字节视图接线完成
 * 「跳转到该 VMA 头部位置」。
 *
 * 数据纪律:与字节视图同款——只依赖 `MemoryDataSource` 接口,禁止直读
 * SessionClient / ProjectionStore;变更由宿主调 `refresh()` 或换绑
 * dataSource 引用驱动。
 */
import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";

import type { MemoryDataSource, VmaEntry, VmaList } from "../../datasource/types.js";
import { formatAddressHex, parseAddressHex } from "../../render/hex.js";

/** 左段地址展示宽度(与字节视图一致,32 位习惯)。 */
const ADDRESS_MIN_DIGITS = 8;

/** 权限规范序(r < w < x;非 r/w/x 字符剔除,重复剔除)。 */
export function normalizePermissions(permissions: string): string {
  const present = new Set(permissions);
  return ["r", "w", "x"].filter((flag) => present.has(flag)).join("");
}

/** 按起始地址升序(FE-FV-06:VMA 列表按地址排列)。 */
export function sortRegionsByAddress(regions: VmaList): VmaEntry[] {
  return [...regions].sort((left, right) => {
    const diff = parseAddressHex(left.startAddressHex) - parseAddressHex(right.startAddressHex);
    return diff < 0n ? -1 : diff > 0n ? 1 : 0;
  });
}

@customElement("sm-vma-list")
export class SmVmaList extends LitElement {
  /** 数据源(视图唯一依赖面;快照引用变化触发重读,或由宿主调 refresh())。 */
  @property({ type: Object, attribute: false })
  dataSource: MemoryDataSource | null = null;

  /** 当前选中区域(受控属性;高亮由宿主/字节视图状态驱动)。 */
  @property({ type: String, attribute: "selected-region-id" })
  selectedRegionId: string | null = null;

  #regions: VmaEntry[] = [];

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("dataSource")) {
      this.#regions = sortRegionsByAddress(this.dataSource?.regions() ?? []);
    }
  }

  /** 宿主驱动刷新(纯快照重读)。 */
  refresh(): void {
    this.#regions = sortRegionsByAddress(this.dataSource?.regions() ?? []);
    this.requestUpdate();
  }

  protected override render(): unknown {
    if (this.#regions.length === 0) {
      return html`<section class="vma-list" aria-label="VMA 列表">
        <h3 class="heading">内存区域</h3>
        <p class="empty" role="status">暂无可见内存区域</p>
      </section>`;
    }
    return html`
      <section class="vma-list" aria-label="VMA 列表">
        <h3 class="heading">内存区域</h3>
        <ul class="regions">
          ${this.#regions.map((region) => this.#renderRegion(region))}
        </ul>
      </section>
    `;
  }

  #renderRegion(region: VmaEntry): unknown {
    const selected = region.regionId === this.selectedRegionId;
    return html`
      <li>
        <button
          type="button"
          class="region${selected ? " selected" : ""}"
          aria-pressed=${selected ? "true" : "false"}
          @click=${() => this.#onSelect(region)}
        >
          <span class="region-label">${region.label}</span>
          <span class="region-id">${region.regionId}</span>
          <span class="region-address">${formatAddressHex(region.startAddressHex, ADDRESS_MIN_DIGITS)}</span>
          <span class="region-length">${region.byteLength} B</span>
          <span class="region-permissions" aria-label="权限">${normalizePermissions(region.permissions)}</span>
          <span class="region-window">
            窗口 ${region.windowByteLength} B${region.truncated ? " · 已截断" : " · 完整"}
          </span>
        </button>
      </li>
    `;
  }

  #onSelect(region: VmaEntry): void {
    this.dispatchEvent(
      new CustomEvent("vma-select", { detail: { regionId: region.regionId }, bubbles: true, composed: true }),
    );
  }

  static override styles = css`
    :host {
      display: block;
      border: 1px solid rgb(0 0 0 / 15%);
      border-radius: 8px;
      background: canvas;
      color: canvastext;
      font-family: ui-monospace, "Cascadia Mono", "Source Code Pro", Menlo, Consolas, monospace;
      font-size: 0.8125rem;
    }

    .vma-list {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      padding: 0.5rem 0.75rem;
    }

    .heading {
      margin: 0;
      font-size: 0.95rem;
      font-weight: 600;
    }

    .regions {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    button.region {
      display: grid;
      grid-template-columns: minmax(6ch, auto) minmax(10ch, auto) 1fr;
      gap: 0.125rem 0.75rem;
      text-align: start;
      padding: 0.375rem 0.5rem;
      border: 1px solid rgb(0 0 0 / 10%);
      border-radius: 6px;
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }

    button.region:hover {
      border-color: rgb(0 0 0 / 25%);
    }

    button.region.selected {
      background: color-mix(in srgb, highlight 14%, transparent);
      border-color: highlight;
    }

    .region-label {
      font-weight: 600;
    }

    .region-id {
      color: graytext;
    }

    .region-address {
      text-align: end;
    }

    .region-permissions {
      font-weight: 600;
    }

    .region-window {
      color: graytext;
    }

    .empty {
      margin: 0;
      color: graytext;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "sm-vma-list": SmVmaList;
  }
}

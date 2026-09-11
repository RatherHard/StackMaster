/**
 * <sm-memory-diff> —— 内存 diff 视图(WP-F9 / FE-ED-03,计划书阶段四范围)。
 *
 * 动作前后字节变化对照。属性(全部属性驱动、可独立实例化):
 *  - `beforeRegions`:动作前区域快照只读面(协议 VisibleMemoryRegion 数组;缺省 =
 *    首个动作前无先前快照,全部前值不可知);
 *  - `delta`:本动作 ProjectionDelta(整体替换语义——组件只消费最新 delta
 *    整体重算,不跨 delta 累积;dirtyRanges 即动作后权威字节,D-P2)。
 *
 * diff 计算委托纯函数 `computeByteDiff`(src/ed/memory-diff.ts):跨
 * dirtyRange 按 (regionId, 地址) 归并、前值仅在前快照已下发窗口内判定
 * (窗口外 / 未知区域 → 前值不可知,渲染层明示"前值不可知",不伪造)。
 *
 * 截断呈现:dirtyRange 带 presence-only `truncated` 标记(§3.5 D-P6)时明示
 * "变更承载被截断,已按协议以 sync-projection 重新对齐"(9.1 sanctioned 路径,
 * SessionClient 已自动触发;此处为教学事实呈现)。
 *
 * FE-ED-08 无障碍基线:语义化 table(caption + scope)、前值不可知以文本承载、
 * 空态明示"本动作无可见字节变化"。
 */
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";

import type { ProjectionDelta, VisibleMemoryRegion } from "@stackmaster/protocol";

import { computeByteDiff } from "../../ed/memory-diff.js";

/** 前值不可知占位文案(窗口外 / 未知区域 / 未下发偏移;I-9 同款"不伪造"纪律)。 */
export const DIFF_UNKNOWN_BEFORE_TEXT = "前值不可知";

/** 截断明示文案(D-P6:标记存在 = 承载不完整,客户端走 sync 重对齐)。 */
export const DIFF_TRUNCATED_TEXT = "变更承载被截断,已按协议以 sync-projection 重新对齐";

@customElement("sm-memory-diff")
export class SmMemoryDiff extends LitElement {
  /** 动作前区域快照(只读面;缺省 = 无先前快照,前值全部不可知)。命名避开
   *  DOM 内建 `Element.before()`——Lit 属性与宿主方法同名会遮蔽内置接口。 */
  @property({ attribute: false })
  beforeRegions: readonly VisibleMemoryRegion[] | undefined;

  /** 本动作投影增量(整体替换语义;dirtyRanges 承载动作后权威字节)。 */
  @property({ attribute: false })
  delta: ProjectionDelta | null = null;

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
      border-block-end: 1px solid rgb(0 0 0 / 8%);
    }

    thead th {
      font-size: 0.75rem;
      font-weight: 600;
      color: graytext;
    }

    .mono {
      font-family: ui-monospace, monospace;
    }

    .unknown {
      color: graytext;
      font-style: italic;
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
    const units = computeByteDiff(this.beforeRegions, this.delta?.dirtyRanges ?? []);
    if (units.length === 0) {
      return html`<p class="empty" role="status">本动作无可见字节变化</p>`;
    }
    const truncated = (this.delta?.dirtyRanges ?? []).some((range) => range.truncated === true);
    return html`
      <div>
        <table part="table" aria-label="动作前后字节变化对照">
          <caption>
            内存 diff(${units.length} 字节变化;前值取自动作前已下发窗口)
          </caption>
          <thead>
            <tr>
              <th scope="col">区域</th>
              <th scope="col">地址</th>
              <th scope="col">前值 → 后值</th>
            </tr>
          </thead>
          <tbody>
            ${units.map((unit) => this.#renderUnit(unit))}
          </tbody>
        </table>
        ${truncated ? html`<p class="truncated-note" role="note">${DIFF_TRUNCATED_TEXT}</p>` : nothing}
      </div>
    `;
  }

  #renderUnit(unit: ReturnType<typeof computeByteDiff>[number]): TemplateResult {
    return html`
      <tr>
        <td>${unit.regionId}</td>
        <td class="mono">${unit.addressHex}</td>
        <td class="mono">
          ${unit.beforeByteHex === null
            ? html`<span class="unknown">${DIFF_UNKNOWN_BEFORE_TEXT}</span>`
            : unit.beforeByteHex}
          → ${unit.afterByteHex}
        </td>
      </tr>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sm-memory-diff": SmMemoryDiff;
  }
}

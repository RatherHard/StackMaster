/**
 * <sm-timeline> —— 时间线视图(WP-F9 / FE-ED-04,计划书阶段四范围)。
 *
 * 动作/checkpoint 历史:属性收 `entries`(客户端自账本构建——宿主以纯函数
 * `buildTimeline`(src/ed/timeline.ts)把 onActionResponse 流 + checkpoint
 * 列表转成条目后注入;组件不持有账本,零服务端往返)。
 * `currentRevision` 指示:与条目 revision 相同者标注"当前 revision"。
 *
 * 呈现口径:
 *  - 条目 = seq + kind 徽标(动作/checkpoint/提交)+ 摘要 + revision(+可选
 *    时刻与响应状态);rejected 动作以状态徽标明示(拒绝不前进 revision,
 *    I-5——同一 revision 可能出现多个条目);
 *  - 时刻仅作展示文本(宿主未提供时不渲染,不伪造)。
 *
 * FE-ED-08 无障碍基线:语义化有序列表(ol > li,时序即列表序)、kind/状态/
 * 当前标记全部以文本承载、空态明示。
 */
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";

import type { TimelineEntry } from "../../ed/timeline.js";
import { LocaleController, t, type SmMessageKey } from "../../i18n/i18n.js";
import { ensureSmThemeStyles } from "../../theme/theme-tokens.js";

/** kind 徽标 i18n 键(渲染时刻解析,WP-53)。 */
const KIND_LABEL_KEYS: Record<TimelineEntry["kind"], SmMessageKey> = {
  action: "ed.kindAction",
  checkpoint: "ed.kindCheckpoint",
  submit: "ed.kindSubmit",
};

@customElement("sm-timeline")
export class SmTimeline extends LitElement {
  /** 时间线条目(buildTimeline 产出;seq 升序)。 */
  @property({ attribute: false })
  entries: readonly TimelineEntry[] = [];

  /** 当前权威 revision(宿主注入,如 client.store.revision);命中条目标注。 */
  @property({ attribute: false })
  currentRevision: number | null = null;

  /** i18n:连接时消费 data-sm-language 锚;locale 变化即重渲染(WP-53)。 */
  readonly #i18n = new LocaleController(this);

  override connectedCallback(): void {
    super.connectedCallback();
    // LocaleController 经构造副作用注册(Lit addController);显式读点满足 lint。
    void this.#i18n;
    ensureSmThemeStyles(this.ownerDocument ?? document);
  }

  static override styles = css`
    :host {
      display: block;
      font-family: system-ui, sans-serif;
    }

    ol {
      margin: 0;
      padding: 0;
      list-style: none;
      font-size: 0.875rem;
    }

    li {
      display: flex;
      gap: 0.5rem;
      align-items: baseline;
      padding: 0.25rem 0.5rem;
      border-block-end: 1px solid var(--sm-divider-faint, rgb(0 0 0 / 8%));
    }

    .seq {
      flex: none;
      min-inline-size: 2ch;
      font-family: ui-monospace, monospace;
      color: graytext;
    }

    .kind-badge,
    .status-badge,
    .current-badge {
      flex: none;
      padding: 0 0.35rem;
      border-radius: 999px;
      background: var(--sm-badge-bg, rgb(0 0 0 / 8%));
      font-size: 0.75rem;
    }

    .status-badge {
      background: var(--sm-badge-bg-soft, rgb(0 0 0 / 4%));
      color: graytext;
    }

    .current-badge {
      background: highlight;
      color: highlighttext;
    }

    .label {
      min-inline-size: 0;
      overflow-wrap: anywhere;
    }

    .meta {
      flex: none;
      font-family: ui-monospace, monospace;
      font-size: 0.75rem;
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
    if (this.entries.length === 0) {
      return html`<p class="empty" role="status">${t("ed.timelineEmpty")}</p>`;
    }
    return html`
      <ol aria-label=${t("ed.timelineAria")}>
        ${this.entries.map((entry) => this.#renderEntry(entry))}
      </ol>
    `;
  }

  #renderEntry(entry: TimelineEntry): TemplateResult {
    const isCurrent = this.currentRevision !== null && entry.revision === this.currentRevision;
    return html`
      <li>
        <span class="seq">${entry.seq}.</span>
        <span class="kind-badge">${t(KIND_LABEL_KEYS[entry.kind])}</span>
        <span class="label">${entry.label}</span>
        <span class="meta">r${entry.revision}${this.#renderAtSuffix(entry)}</span>
        ${entry.status === undefined
          ? nothing
          : html`<span class="status-badge">${entry.status}</span>`}
        ${isCurrent ? html`<span class="current-badge">${t("ed.currentRevisionBadge")}</span>` : nothing}
      </li>
    `;
  }

  #renderAtSuffix(entry: TimelineEntry): string {
    if (entry.at === undefined) {
      return "";
    }
    // 展示层本地时间(locale 字符串);屏幕阅读器经 aria-label 同步承载。
    const time = new Date(entry.at).toLocaleTimeString();
    return ` · ${time}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sm-timeline": SmTimeline;
  }
}

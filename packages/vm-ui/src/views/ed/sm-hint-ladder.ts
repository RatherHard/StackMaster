/**
 * <sm-hint-ladder> —— 提示 ladder(WP-F9 / FE-ED-06,计划书阶段四范围)。
 *
 * `PublicHint` 消费(本地结构类型,对齐锚见 src/ed/ed-types.ts):
 *  - `revealPolicy = "on_request"`:**逐级揭示**——只给"最前面的未揭示条"一个
 *    "显示下一条提示"按钮(点击揭示该条,后续条保持锁定);全部揭示后按钮消失;
 *  - `revealPolicy = "after_n_failures"`:**计数自动揭示**——宿主传入的失败
 *    计数 `failures` 达到 `failureThreshold` 即自动呈现;未达标明示
 *    "再失败 N 次解锁"(N = threshold - failures,只差语义不含阈值细节);
 *  - **revealPolicy 语义在浏览器本地执行**,提交计数由宿主传入(失败计数 =
 *    ActionResponse failed/wrong_answer 类反馈;宿主接线归 WP-F8)——组件
 *    不派发任何动作、不做网络往返;
 *  - 防御性:`after_n_failures` 缺 `failureThreshold`(Schema if/then 已拒绝,
 *    此处兜底)按"永不自动解锁"呈现,不伪造阈值。
 *
 * 已揭示 / 未揭示分明:揭示条 = 完整文案;未揭示条 = 锁定说明文本(顺序
 * 信息对屏幕阅读器同可达,不以视觉为唯一载体)。
 *
 * FE-ED-08 无障碍基线:region + aria-label、原生 button、揭示/锁定状态文本化。
 */
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import type { PublicHint } from "../../ed/ed-types.js";

/** on_request 揭示按钮文案(逐级揭示)。 */
export const HINT_REVEAL_BUTTON_TEXT = "显示下一条提示";

/** after_n_failures 未达标锁定文案(N = 距解锁的剩余失败次数)。 */
export function hintLockedText(remaining: number): string {
  return `再失败 ${remaining} 次解锁`;
}

@customElement("sm-hint-ladder")
export class SmHintLadder extends LitElement {
  /** 提示列表(公开描述包 hintLadder;按 order 升序呈现)。 */
  @property({ attribute: false })
  hints: readonly PublicHint[] = [];

  /** 失败计数(宿主传入;after_n_failures 的解锁依据)。 */
  @property({ type: Number })
  failures = 0;

  @state()
  private revealedOrders: readonly number[] = [];

  static override styles = css`
    :host {
      display: block;
      font-family: system-ui, sans-serif;
    }

    ol {
      margin: 0;
      padding: 0;
      list-style: decimal;
    }

    li {
      padding: 0.25rem 0.5rem;
      border-block-end: 1px solid rgb(0 0 0 / 8%);
    }

    .hint-text {
      overflow-wrap: anywhere;
    }

    .locked {
      color: graytext;
      font-style: italic;
    }

    .reveal-button {
      padding: 0.25rem 0.75rem;
      border: 1px solid rgb(0 0 0 / 25%);
      border-radius: 4px;
      background: none;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }

    .reveal-button:focus-visible {
      outline: 2px solid accentcolor;
      outline-offset: 1px;
    }

    .empty {
      margin: 0;
      padding: 0.5rem 0.75rem;
      color: graytext;
      font-size: 0.875rem;
    }
  `;

  protected override render(): TemplateResult {
    if (this.hints.length === 0) {
      return html`<p class="empty" role="status">本题没有配置提示</p>`;
    }
    const ordered = [...this.hints].sort((a, b) => a.order - b.order);
    // "显示下一条提示"只挂在最前面的未揭示 on_request 条上(逐级揭示)。
    const nextRevealable = ordered.find(
      (hint) => hint.revealPolicy === "on_request" && !this.#isRevealed(hint.order),
    );
    return html`
      <section aria-label="提示阶梯">
        <ol>
          ${ordered.map((hint) => this.#renderHint(hint, hint === nextRevealable))}
        </ol>
      </section>
    `;
  }

  #isRevealed(order: number): boolean {
    return this.revealedOrders.includes(order);
  }

  #renderHint(hint: PublicHint, isNextRevealable: boolean): TemplateResult {
    if (hint.revealPolicy === "after_n_failures") {
      // Schema if/then 保证 threshold 必填;缺席兜底 = 永不自动解锁(不伪造阈值)。
      const threshold = hint.failureThreshold;
      const unlocked = threshold !== undefined && this.failures >= threshold;
      if (unlocked) {
        return this.#renderRevealed(hint, "失败次数达标,自动解锁");
      }
      const lockedText =
        threshold === undefined ? "失败达标后解锁" : hintLockedText(threshold - this.failures);
      return html`
        <li>
          <span class="locked">提示 ${hint.order}(未解锁):${lockedText}</span>
        </li>
      `;
    }
    if (this.#isRevealed(hint.order)) {
      return this.#renderRevealed(hint, undefined);
    }
    return html`
      <li>
        <span class="locked">提示 ${hint.order}(未揭示)</span>
        ${isNextRevealable
          ? html`<span>
              <button type="button" class="reveal-button" @click=${() => this.#reveal(hint.order)}>
                ${HINT_REVEAL_BUTTON_TEXT}
              </button>
            </span>`
          : nothing}
      </li>
    `;
  }

  #renderRevealed(hint: PublicHint, unlockReason: string | undefined): TemplateResult {
    return html`
      <li>
        <span class="hint-text">提示 ${hint.order}:${hint.hintText}</span>
        ${unlockReason === undefined ? nothing : html`<span class="locked">(${unlockReason})</span>`}
      </li>
    `;
  }

  #reveal(order: number): void {
    if (!this.#isRevealed(order)) {
      this.revealedOrders = [...this.revealedOrders, order];
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sm-hint-ladder": SmHintLadder;
  }
}

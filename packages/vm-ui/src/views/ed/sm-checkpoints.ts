/**
 * <sm-checkpoints> —— checkpoint UI(WP-F9 / FE-ED-05,计划书阶段四范围)。
 *
 * create / checkout / list(协议现成,含标签):
 *  - **create**:名称输入(可选,≤ 128 字符、禁 C0/C1 控制字符——与 protocol
 *    CreateCheckpointArgsSchema 同则,校验见 src/ed/ed-types.ts)→ 注入的
 *    `sendAction({type:"create_checkpoint", args:{label?}})`;校验失败行内
 *    呈现原因、不派发;
 *  - **checkout**:两步确认(点击"切换"→ 行内确认态 → 再次点击才派发
 *    `checkout_checkpoint`)——不用原生 confirm 对话框(键盘可达 + 可测);
 *  - **list**:属性收 `checkpoints`(宿主经 `client.listCheckpoints()` 取
 *    CheckpointRef 数组后注入;按创建序,顺序即语义)——表列 标签/revision/
 *    checkpointId/操作;
 *  - **终态会话**:`sessionTerminal` 为真禁用创建与切换,并明示引导;
 *  - **错误呈现**:`error` 属性(宿主接 onActionRejected / SessionCommandError)
 *    以 role="alert" 呈现;组件自身校验错误行内呈现。
 *
 * 组件不持有 SessionClient、不自行刷新列表:动作派发后由宿主在响应回流时
 * 重新拉取 list_checkpoints 并更新 `checkpoints` 属性(视图禁止直读
 * client,README 纪律)。
 *
 * FE-ED-08 无障碍基线:原生 input/button/table(label 关联、scope、焦点可见)、
 * 错误与确认态以文本 + role 承载。
 */
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import type { ActionObject, CheckpointRef } from "@stackmaster/protocol";

import { validateCheckpointLabel } from "../../ed/ed-types.js";

@customElement("sm-checkpoints")
export class SmCheckpoints extends LitElement {
  /** checkpoint 列表(宿主经 client.listCheckpoints() 注入,按创建序)。 */
  @property({ attribute: false })
  checkpoints: readonly CheckpointRef[] = [];

  /** 动作派发面(宿主接 client.sendAction;null = 未接线,按钮禁用)。 */
  @property({ attribute: false })
  sendAction: ((action: ActionObject) => void) | null = null;

  /** 终态会话(won/failed):禁用创建与切换(D1 约束 5:终态确定性拒绝)。 */
  @property({ type: Boolean, attribute: "session-terminal" })
  sessionTerminal = false;

  /** 宿主呈现的错误文案(onActionRejected / 命令失败;空 = 无错误)。 */
  @property({ type: String })
  error = "";

  @state()
  private labelInput = "";

  @state()
  private validationError: string | null = null;

  /** 两步确认态:待确认的 checkout 目标(null = 无确认态)。 */
  @state()
  private pendingCheckoutId: string | null = null;

  static override styles = css`
    :host {
      display: block;
      font-family: system-ui, sans-serif;
    }

    .create-row {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      margin-block-end: 0.5rem;
    }

    input[type="text"] {
      flex: 1 1 auto;
      min-inline-size: 0;
      padding: 0.25rem 0.5rem;
      font: inherit;
    }

    input:focus-visible,
    button:focus-visible {
      outline: 2px solid accentcolor;
      outline-offset: 1px;
    }

    button {
      padding: 0.25rem 0.75rem;
      border: 1px solid rgb(0 0 0 / 25%);
      border-radius: 4px;
      background: none;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.5;
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
      font-size: 0.8125rem;
      overflow-wrap: anywhere;
    }

    .alert {
      margin: 0.25rem 0;
      padding: 0.25rem 0.5rem;
      color: inherit;
      font-size: 0.875rem;
    }

    .terminal-note,
    .confirm-note {
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
    return html`
      <div>
        ${this.#renderCreateRow()}
        ${this.error === "" ? nothing : html`<p class="alert" role="alert">${this.error}</p>`}
        ${this.validationError === null
          ? nothing
          : html`<p class="alert" role="alert">${this.validationError}</p>`}
        ${this.sessionTerminal
          ? html`<p class="terminal-note" role="note">
              会话已终态,不能创建或切换 checkpoint(请新建会话)
            </p>`
          : nothing}
        ${this.#renderList()}
      </div>
    `;
  }

  #renderCreateRow(): TemplateResult {
    const createDisabled = this.sessionTerminal || this.sendAction === null;
    return html`
      <div class="create-row">
        <input
          type="text"
          .value=${this.labelInput}
          maxlength="128"
          aria-label="checkpoint 标签(可选,最长 128 字符)"
          placeholder="checkpoint 标签(可选)"
          ?disabled=${createDisabled}
          @input=${(event: InputEvent) => {
            this.labelInput = (event.target as HTMLInputElement).value;
          }}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Enter") {
              event.preventDefault();
              this.#createCheckpoint();
            }
          }}
        />
        <button type="button" ?disabled=${createDisabled} @click=${() => this.#createCheckpoint()}>
          创建 checkpoint
        </button>
      </div>
    `;
  }

  #createCheckpoint(): void {
    const trimmed = this.labelInput.trim();
    if (trimmed !== "") {
      const violation = validateCheckpointLabel(trimmed);
      if (violation !== null) {
        this.validationError = violation;
        return;
      }
    }
    this.validationError = null;
    this.sendAction?.({
      type: "create_checkpoint",
      args: trimmed === "" ? {} : { label: trimmed },
    });
    this.labelInput = "";
  }

  #renderList(): TemplateResult {
    if (this.checkpoints.length === 0) {
      return html`<p class="empty" role="status">暂无 checkpoint(创建后将按创建顺序列出)</p>`;
    }
    return html`
      <table part="table" aria-label="checkpoint 列表">
        <caption>checkpoint(按创建顺序;切换会把内容回退到对应 revision)</caption>
        <thead>
          <tr>
            <th scope="col">标签</th>
            <th scope="col">revision</th>
            <th scope="col">checkpointId</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          ${this.checkpoints.map((checkpoint) => this.#renderRow(checkpoint))}
        </tbody>
      </table>
    `;
  }

  #renderRow(checkpoint: CheckpointRef): TemplateResult {
    const checkoutDisabled = this.sessionTerminal || this.sendAction === null;
    const confirming = this.pendingCheckoutId === checkpoint.checkpointId;
    const label = checkpoint.label === undefined ? "(无标签)" : checkpoint.label;
    return html`
      <tr>
        <td>${label}</td>
        <td class="mono">${checkpoint.revision}</td>
        <td class="mono">${checkpoint.checkpointId}</td>
        <td>
          ${confirming
            ? html`
                <span class="confirm-note" role="status">
                  确认切换到 ${label}(revision ${checkpoint.revision})?
                </span>
                <button
                  type="button"
                  class="confirm-button"
                  ?disabled=${checkoutDisabled}
                  @click=${() => this.#confirmCheckout(checkpoint)}
                >
                  确认切换
                </button>
                <button type="button" @click=${() => this.#cancelCheckout()}>取消</button>
              `
            : html`
                <button
                  type="button"
                  class="checkout-button"
                  aria-label="切换到 checkpoint ${label}(revision ${checkpoint.revision})"
                  ?disabled=${checkoutDisabled}
                  @click=${() => {
                    this.pendingCheckoutId = checkpoint.checkpointId;
                  }}
                >
                  切换
                </button>
              `}
        </td>
      </tr>
    `;
  }

  /** 两步确认的第二击:派发 checkout_checkpoint 并退出确认态。 */
  #confirmCheckout(checkpoint: CheckpointRef): void {
    this.pendingCheckoutId = null;
    this.sendAction?.({
      type: "checkout_checkpoint",
      args: { checkpointId: checkpoint.checkpointId },
    });
  }

  #cancelCheckout(): void {
    this.pendingCheckoutId = null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sm-checkpoints": SmCheckpoints;
  }
}

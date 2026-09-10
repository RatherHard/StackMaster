/**
 * lit-virtualizer × Lit 3 版本兼容最小渲染冒烟。
 *
 * 背景:《前端实施计划》§六登记风险——"lit-virtualizer 与 Lit 3 版本兼容";
 * WP-F1 锁定版本组合并在本测试固化最低兼容证据:10 万行极简虚拟列表在
 * jsdom(ResizeObserver 桩见 test/setup.ts)下完成首屏渲染,且只渲染可见
 * 窗口内的少量行(虚拟化生效)。版本组合一旦失配(如升级 Lit 大版本),
 * 本测试先行红灯。
 *
 * API 形态登记:@lit-labs/virtualizer 2.x 的公开 API 是 <lit-virtualizer>
 * 组件(.items / .renderItem;2.0 起替代 0.x 的 virtualize 指令)。
 *
 * 已验证组合(升级时先更新此处与 README 登记,再跑本测试):
 *   lit ^3.3.3 × @lit-labs/virtualizer ^2.1.1 × vite ^8.3.0(2026-09-11)
 */
import { LitVirtualizer } from "@lit-labs/virtualizer";
import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import { describe, expect, it } from "vitest";

/** 虚拟列表行总量:证明"10 万行"量级下虚拟化只渲染首屏窗口。 */
const ROW_COUNT = 100_000;
/** 首屏窗口最多应渲染的行数上限(300px 视口桩下远小于总量)。 */
const FIRST_SCREEN_ROW_LIMIT = 100;

@customElement("sm-virtualizer-smoke")
class VirtualizerSmoke extends LitElement {
  protected override render(): unknown {
    const items: string[] = Array.from({ length: ROW_COUNT }, (_value, index) => `row-${index}`);
    return html`
      <lit-virtualizer
        id="list"
        style="display: block; block-size: 300px; overflow-y: auto;"
        .items=${items}
        .renderItem=${(item: string) => html`<div class="row">${item}</div>`}
      ></lit-virtualizer>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sm-virtualizer-smoke": VirtualizerSmoke;
  }
}

/** 等待若干渲染帧,给 ResizeObserver → 可见范围计算 → 重渲染链路时间。 */
async function settleFrames(frames: number): Promise<void> {
  for (let frame = 0; frame < frames; frame += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
    await Promise.resolve();
  }
}

describe("lit-virtualizer × Lit 3 兼容冒烟", () => {
  it("10 万行虚拟列表完成首屏渲染,且仅渲染可见窗口内的行", async () => {
    const element = document.createElement("sm-virtualizer-smoke");
    document.body.append(element);
    await element.updateComplete;

    const list = element.shadowRoot?.querySelector("lit-virtualizer") as LitVirtualizer<string>;
    expect(list, "<lit-virtualizer> 未在 shadow DOM 渲染").toBeInstanceOf(LitVirtualizer);

    // 首屏布局依赖 test/setup.ts 的 ResizeObserver 尺寸桩,给渲染帧时间收敛。
    await settleFrames(10);

    const rows = list.querySelectorAll(".row");
    expect(
      rows.length,
      "虚拟列表未渲染任何行——lit-virtualizer × Lit 3 组合失配或环境桩失效",
    ).toBeGreaterThan(0);
    expect(
      rows.length,
      `首屏渲染了 ${rows.length} 行,超过 ${FIRST_SCREEN_ROW_LIMIT} 上限——虚拟化未生效`,
    ).toBeLessThan(FIRST_SCREEN_ROW_LIMIT);
    expect(list.textContent).toContain("row-0");

    element.remove();
  });
});

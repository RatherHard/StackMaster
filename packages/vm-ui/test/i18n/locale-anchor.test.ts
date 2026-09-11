/**
 * WP-53 组件级语言机制测试:data-sm-language 锚消费(嵌入协议语义,与
 * WP-52 EmbedAppearanceController 落地面对接)、BCP-47 降级在锚上的确定性、
 * locale 切换 → 组件重渲染、以及 **未授予 language 的插件侧禁用锚**
 * (嵌入协议 §4.4 降级矩阵第 3 行:宿主不设锚 / 不发 language_changed →
 * vm-ui 保持内置默认 zh-CN;与 web-component 侧降级矩阵测试共用语义锚)。
 */
import { afterEach, describe, expect, it } from "vitest";
import { html, render } from "lit";

import "../../src/workspace/sm-workspace-menu.js";
import type { SmWorkspaceMenu } from "../../src/workspace/sm-workspace-menu.js";
import { DEFAULT_LOCALE, getLocale, setLocale } from "../../src/i18n/i18n.js";
import { defaultTabTypeRegistry } from "../../src/workspace/tab-registry.js";

function menuOf(host: Element): SmWorkspaceMenu {
  return host.querySelector("sm-workspace-menu") as SmWorkspaceMenu;
}

async function mount(template: ReturnType<typeof html>): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  render(template, host);
  const menu = menuOf(host);
  await menu.updateComplete;
  return host;
}

const TICK = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  setLocale(DEFAULT_LOCALE);
  for (const node of [...document.body.children]) {
    if (node instanceof HTMLElement && node.tagName !== "SM-WORKSPACE-MENU") {
      node.remove();
    }
  }
});

describe("data-sm-language 锚消费(嵌入形态对接)", () => {
  it("锚 en → 组件以英文重渲染(切换即生效)", async () => {
    const host = await mount(html`
      <div data-sm-language="en">
        <sm-workspace-menu
          .tabTypes=${defaultTabTypeRegistry.list()}
          connectionStatus="connected"
        ></sm-workspace-menu>
      </div>
    `);
    const menu = menuOf(host);
    expect(menu.shadowRoot?.querySelector(".step-button")?.textContent?.trim()).toBe(
      "Instruction step",
    );
    expect(menu.shadowRoot?.querySelector(".payload-step-button")?.textContent?.trim()).toBe(
      "Payload step",
    );
    // 注册表 labelKey:打开项按当前 locale 解析。
    const openButton = menu.shadowRoot?.querySelector<HTMLButtonElement>(
      'button.open-tab[data-tab-type="stack"]',
    );
    expect(openButton?.textContent?.trim()).toBe("Stack view");
  });

  it("运行中锚属性更新(language_changed 形态)→ MutationObserver 生效", async () => {
    // 嵌入形态时序契约:WP-52 宿主元素在 connectedCallback 即落 data-sm-*
    // 锚(早于工作区挂载),故消费点(组件连接)时锚已在场。
    const anchor = document.createElement("div");
    anchor.setAttribute("data-sm-language", "zh-CN");
    const menu = document.createElement("sm-workspace-menu") as SmWorkspaceMenu;
    anchor.append(menu);
    document.body.append(anchor);
    await menu.updateComplete;
    expect(menu.shadowRoot?.querySelector(".step-button")?.textContent?.trim()).toBe("指令步进");

    // 宿主运行中切换语言(WP-52 侧更新 data-sm-language 属性)。
    anchor.setAttribute("data-sm-language", "en");
    await TICK();
    await menu.updateComplete;
    expect(menu.shadowRoot?.querySelector(".step-button")?.textContent?.trim()).toBe(
      "Instruction step",
    );

    anchor.setAttribute("data-sm-language", "zh-CN");
    await TICK();
    await menu.updateComplete;
    expect(menu.shadowRoot?.querySelector(".step-button")?.textContent?.trim()).toBe("指令步进");

    // 未知标签确定性落默认(与当前 locale 相同 → 幂等无扰动)。
    anchor.setAttribute("data-sm-language", "fr");
    await TICK();
    await menu.updateComplete;
    expect(menu.shadowRoot?.querySelector(".step-button")?.textContent?.trim()).toBe("指令步进");
    anchor.remove();
  });

  it("BCP-47 降级矩阵(锚上):zh-TW→zh-CN、en-GB→en、未知 fr→zh-CN(确定性)", async () => {
    const cases: readonly [string, string][] = [
      ["zh-TW", "指令步进"],
      ["en-GB", "Instruction step"],
      ["fr", "指令步进"],
      ["", "指令步进"],
    ];
    for (const [tag, expected] of cases) {
      const anchor = document.createElement("div");
      if (tag !== "") {
        anchor.setAttribute("data-sm-language", tag);
      }
      const menu = document.createElement("sm-workspace-menu") as SmWorkspaceMenu;
      anchor.append(menu);
      document.body.append(anchor);
      await menu.updateComplete;
      expect(
        menu.shadowRoot?.querySelector(".step-button")?.textContent?.trim(),
        `BCP-47 "${tag}"`,
      ).toBe(expected);
      anchor.remove();
      setLocale(DEFAULT_LOCALE);
    }
  });
});

describe("未授予 language 的插件侧禁用锚(§4.4 降级矩阵第 3 行)", () => {
  it("无锚 = 不消费对应面,保持内置默认 zh-CN(与 WP-52 降级矩阵共用语义)", async () => {
    // 未授予 language 时,WP-52 侧不落 data-sm-language 锚、对应消息按 V-8
    // 丢弃;vm-ui 侧锚消费为 no-op,外观保持内置默认。
    const host = await mount(html`
      <div>
        <sm-workspace-menu .tabTypes=${defaultTabTypeRegistry.list()}></sm-workspace-menu>
      </div>
    `);
    const menu = menuOf(host);
    expect(menu.shadowRoot?.querySelector(".step-button")?.textContent?.trim()).toBe("指令步进");
    expect(menu.shadowRoot?.querySelector(".mode-indicator")?.textContent?.trim()).toBe("解题模式");
    expect(getLocaleSnapshot()).toBe("zh-CN");
  });
});

function getLocaleSnapshot(): string {
  return getLocale();
}

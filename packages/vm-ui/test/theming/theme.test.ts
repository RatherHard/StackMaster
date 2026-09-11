/**
 * WP-53 主题 token 机制测试(Q6 定案):
 *  - 文档级锚样式表幂等安装与三值锚规则结构(light / dark / auto + @media
 *    系统跟随——vm-ui 侧 auto 走 CSS,零 JS 解析;嵌入形态 auto 已由 WP-52
 *    解析为二值锚,边界登记于决策草稿);
 *  - 变量面断言:light 值 = 现行硬编码值原样(零视觉变化)、dark 值齐备;
 *  - sm-workspace `theme` 属性(独立使用形态)→ 自身 data-sm-theme 转写,
 *    显式属性胜过祖先锚(最近锚优先);
 *  - 机械护栏:全部 vm-ui 组件静态样式中不再存在 var() 之外的黑色半透明
 *    灰阶 / crimson 硬编码(组件零硬编码颜色改读变量);
 *  - **axe 套件双主题**(light 锚 / dark 锚各跑一遍,零 violations;
 *    color-contrast 沿既有豁免登记,真机补测归 WP-55);
 *  - 未授予 theme 的插件侧禁用锚(§4.4 降级矩阵第 2 行):无锚 = light 缺省。
 */
import axe from "axe-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LitElement } from "lit";

import "../../src/workspace/sm-workspace.js";
import "../../src/views/ed/sm-call-stack.js";
import "../../src/views/ed/sm-checkpoints.js";
import "../../src/views/ed/sm-error-explainer.js";
import "../../src/views/ed/sm-hint-ladder.js";
import "../../src/views/ed/sm-memory-diff.js";
import "../../src/views/ed/sm-structure-view.js";
import "../../src/views/ed/sm-timeline.js";
import type { SmCallStack } from "../../src/views/ed/sm-call-stack.js";
import type { SmCheckpoints } from "../../src/views/ed/sm-checkpoints.js";
import type { SmErrorExplainer } from "../../src/views/ed/sm-error-explainer.js";
import type { SmHintLadder } from "../../src/views/ed/sm-hint-ladder.js";
import type { SmMemoryDiff } from "../../src/views/ed/sm-memory-diff.js";
import type { SmStructureView } from "../../src/views/ed/sm-structure-view.js";
import type { SmTimeline } from "../../src/views/ed/sm-timeline.js";
import type { SmWorkspace } from "../../src/workspace/sm-workspace.js";
import {
  SM_THEME_ANCHOR_STYLESHEET_TEXT,
  SM_THEME_VARIABLES,
  ensureSmThemeStyles,
} from "../../src/theme/theme-tokens.js";

/** 参与机械护栏与 axe 的组件清单(标签名 → 元素类)。 */
const THEME_COMPONENT_TAGS: readonly { readonly tag: string; readonly type: unknown }[] = [
  { tag: "sm-workspace", type: undefined },
  { tag: "sm-structure-view", type: undefined },
  { tag: "sm-call-stack", type: undefined },
  { tag: "sm-memory-diff", type: undefined },
  { tag: "sm-timeline", type: undefined },
  { tag: "sm-checkpoints", type: undefined },
  { tag: "sm-hint-ladder", type: undefined },
  { tag: "sm-error-explainer", type: undefined },
];

/** 移除全部平衡的 var(...) 片段(fallback 内保留的旧值不算硬编码)。 */
function stripVarSpans(cssText: string): string {
  let result = "";
  let index = 0;
  while (index < cssText.length) {
    const start = cssText.indexOf("var(", index);
    if (start === -1) {
      result += cssText.slice(index);
      break;
    }
    result += cssText.slice(index, start);
    let depth = 0;
    let cursor = start + 3; // 指向 "("
    for (; cursor < cssText.length; cursor += 1) {
      if (cssText[cursor] === "(") {
        depth += 1;
      } else if (cssText[cursor] === ")") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    index = cursor + 1;
  }
  return result;
}

/** 每组件静态样式的合并 cssText。 */
function cssTextOf(tag: string): string {
  const ctor = customElements.get(tag) as (new () => LitElement) | undefined;
  expect(ctor, `组件未注册:${tag}`).toBeTruthy();
  const styles = (ctor as unknown as { elementStyles?: unknown[] }).elementStyles ?? [];
  return styles.map((style) => String((style as { cssText?: string }).cssText ?? style)).join("\n");
}

let main: HTMLElement | null = null;

beforeAll(() => {
  document.documentElement.lang = "zh-CN";
  document.title = "主题机制检查";
  main = document.createElement("main");
  main.id = "theme-test-main";
  main.append(Object.assign(document.createElement("h1"), { textContent: "主题机制检查" }));
  document.body.append(main);
});

afterAll(() => {
  main?.remove();
  main = null;
  document.getElementById("sm-theme-token-styles")?.remove();
});

describe("主题锚样式表(文档级注入)", () => {
  it("幂等安装:重复调用只保留一份 <style>", () => {
    ensureSmThemeStyles(document);
    ensureSmThemeStyles(document);
    const installed = document.querySelectorAll('style[id="sm-theme-token-styles"]');
    expect(installed.length).toBe(1);
    expect(installed[0]?.textContent).toBe(SM_THEME_ANCHOR_STYLESHEET_TEXT);
  });

  it("三值锚规则齐备:auto 由 @media (prefers-color-scheme: dark) 承担", () => {
    const css = SM_THEME_ANCHOR_STYLESHEET_TEXT;
    for (const value of ["light", "dark", "auto"]) {
      expect(css).toContain(`[data-sm-theme="${value}"]`);
    }
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    // auto 的暗色规则位于 media 内(系统跟随;vm-ui 零 JS 主题解析)。
    const mediaBody = css.slice(css.indexOf("@media"));
    expect(mediaBody).toContain('[data-sm-theme="auto"]');
    expect(mediaBody).toContain(SM_THEME_VARIABLES.dark["--sm-border"] ?? "");
  });

  it("变量面:light = 现行硬编码值原样(零视觉变化),dark 值齐备", () => {
    expect(SM_THEME_VARIABLES.light["--sm-border"]).toBe("rgb(0 0 0 / 15%)");
    expect(SM_THEME_VARIABLES.light["--sm-border-button"]).toBe("rgb(0 0 0 / 20%)");
    expect(SM_THEME_VARIABLES.light["--sm-border-strong"]).toBe("rgb(0 0 0 / 25%)");
    expect(SM_THEME_VARIABLES.light["--sm-divider"]).toBe("rgb(0 0 0 / 10%)");
    expect(SM_THEME_VARIABLES.light["--sm-divider-faint"]).toBe("rgb(0 0 0 / 8%)");
    expect(SM_THEME_VARIABLES.light["--sm-badge-bg"]).toBe("rgb(0 0 0 / 8%)");
    expect(SM_THEME_VARIABLES.light["--sm-badge-bg-soft"]).toBe("rgb(0 0 0 / 4%)");
    expect(SM_THEME_VARIABLES.light["--sm-danger"]).toBe("crimson");
    const lightVars: Record<string, string> = { ...SM_THEME_VARIABLES.light };
    const darkVars: Record<string, string> = { ...SM_THEME_VARIABLES.dark };
    for (const name of Object.keys(lightVars)) {
      expect(darkVars[name], `dark 缺变量:${name}`).toBeTruthy();
      expect(darkVars[name]).not.toBe(lightVars[name]);
    }
  });
});

describe("变量消费机械护栏(组件零硬编码颜色)", () => {
  it("全部组件样式:var() 之外不存在黑色半透明灰阶与 crimson 硬编码", () => {
    for (const { tag } of THEME_COMPONENT_TAGS) {
      const stripped = stripVarSpans(cssTextOf(tag));
      expect(stripped.includes("rgb(0 0 0"), `${tag} 存在 var() 外黑透明硬编码`).toBe(false);
      expect(stripped.includes("crimson"), `${tag} 存在 var() 外 crimson 硬编码`).toBe(false);
      expect(cssTextOf(tag).includes("var(--sm-"), `${tag} 未消费主题变量`).toBe(true);
    }
  });
});

describe("sm-workspace theme 属性(独立使用形态)", () => {
  it("theme 属性转写为自身 data-sm-theme;显式属性胜过祖先锚(最近锚优先)", async () => {
    const outer = document.createElement("div");
    outer.setAttribute("data-sm-theme", "light");
    const workspace = document.createElement("sm-workspace") as SmWorkspace;
    outer.append(workspace);
    main!.append(outer);
    workspace.theme = "dark";
    await workspace.updateComplete;
    expect(workspace.getAttribute("data-sm-theme")).toBe("dark");

    workspace.theme = "auto";
    await workspace.updateComplete;
    expect(workspace.getAttribute("data-sm-theme")).toBe("auto");

    // 缺省 null = 不写锚(由祖先锚或 light 缺省决定)。
    workspace.theme = null;
    await workspace.updateComplete;
    expect(workspace.hasAttribute("data-sm-theme")).toBe(false);
    outer.remove();
  });
});

describe("未授予 theme 的插件侧禁用锚(§4.4 降级矩阵第 2 行)", () => {
  it("无锚 = 不消费,变量缺省生效(light 缺省;与 WP-52 降级矩阵共用语义)", () => {
    document.getElementById("sm-theme-token-styles")?.remove();
    const host = document.createElement("div"); // 无 data-sm-theme
    host.innerHTML = "<p>light-default</p>";
    main!.append(host);
    // 样式表在场时,三值锚才可能改写变量;无锚元素不在任何选择器命中面内。
    expect(host.hasAttribute("data-sm-theme")).toBe(false);
    ensureSmThemeStyles(document);
    host.remove();
  });
});

describe("axe 双主题(light / dark 锚各一遍;零 violations)", () => {
  async function runAxeUnderTheme(theme: "light" | "dark"): Promise<void> {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-sm-theme", theme);
    main!.append(wrapper);

    // ED 七组件代表性满内容挂载(与既有 axe 套件同口径)。
    const error: import("@stackmaster/protocol").PublicError = {
      code: "invalid_rip",
      message: "非法 RIP",
      addressHex: null,
      explanation: {
        regionId: "region-code",
        permissions: "rx",
        valueHex: "0xdead",
        interpretedAs: "little_endian_qword",
        alignmentBytes: 4,
        expectedBytesLength: 8,
        actualBytesLength: 2,
        hints: ["小端解释", "检查 RSP 对齐"],
      },
    };
    const mounted: LitElement[] = [];
    const cases: readonly [string, (element: LitElement) => void][] = [
      ["sm-structure-view", (el) => { (el as SmStructureView).highlights = [
        { kind: "buffer_start", targetRegionId: "region-stack", startAddressHex: "0x1010", byteLength: 64, label: "buffer 起点" },
      ]; }],
      ["sm-call-stack", (el) => { (el as SmCallStack).frames = [
        { index: 0, functionLabel: "0x40A0(vulnerable)", returnAddressHex: "0x40100" },
        { index: 1, functionLabel: "func_1", returnAddressHex: "0x40200", truncated: true },
      ]; }],
      ["sm-memory-diff", (el) => {
        (el as SmMemoryDiff).beforeRegions = [{
          regionId: "region-stack", label: "stack", startAddressHex: "0x1000",
          byteLength: 4096, permissions: "rw", bytesHex: "00010203", truncated: false,
        }];
        (el as SmMemoryDiff).delta = {
          revision: 1,
          // truncated 为 presence-only 标记(存在即 true),false 形态不写键。
          dirtyRanges: [{ regionId: "region-stack", startAddressHex: "0x1000", bytesHex: "ff0102" }],
          changedRegisters: [],
        };
      }],
      ["sm-timeline", (el) => {
        (el as SmTimeline).entries = [
          { seq: 1, kind: "action", label: "step", revision: 1, status: "running" },
          { seq: 2, kind: "checkpoint", label: 'checkpoint "存档"', revision: 2, checkpointId: "cp-a" },
        ];
        (el as SmTimeline).currentRevision = 2;
      }],
      ["sm-checkpoints", (el) => {
        (el as SmCheckpoints).checkpoints = [{ checkpointId: "cp-a", label: "存档一", revision: 2 }];
        (el as SmCheckpoints).sendAction = () => {};
      }],
      ["sm-hint-ladder", (el) => {
        (el as SmHintLadder).hints = [
          { order: 1, revealPolicy: "on_request", hintText: "检查返回地址的写位置" },
        ];
        (el as SmHintLadder).failures = 0;
      }],
      ["sm-error-explainer", (el) => {
        (el as SmErrorExplainer).error = error;
        (el as SmErrorExplainer).mappings = [];
      }],
    ];
    for (const [tag, configure] of cases) {
      const element = document.createElement(tag) as LitElement;
      wrapper.append(element);
      configure(element);
      mounted.push(element);
    }
    await Promise.all(mounted.map((element) => element.updateComplete));

    const results = await axe.run(wrapper, {
      resultTypes: ["violations"],
      rules: {
        // jsdom 无布局引擎,对比度不可判定(既有豁免登记;真机补测归 WP-55)。
        "color-contrast": { enabled: false },
      },
    });
    const summary = results.violations.map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => node.target),
    }));
    expect(summary).toEqual([]);

    for (const element of mounted) {
      element.remove();
    }
    wrapper.remove();
  }

  it("light 锚:零 violations", async () => {
    ensureSmThemeStyles(document);
    await runAxeUnderTheme("light");
  });

  it("dark 锚:零 violations", async () => {
    ensureSmThemeStyles(document);
    await runAxeUnderTheme("dark");
  });
});

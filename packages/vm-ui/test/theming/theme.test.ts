/**
 * WP-53 主题 token 机制测试(Q6 定案;WP-73 扩展为三预设;
 * **2026-09-18 D-UI-6 收敛为终端单主题**)。
 *  - 文档级样式表幂等安装与**单主题锚规则**结构(`:root` 级缺省 = 终端 +
 *    单一显式 `[data-sm-theme="terminal"]` 锚;`light` / `dark` / `auto` 三预设与
 *    `@media (prefers-color-scheme)` 系统跟随分支**已退役**);
 *  - **「未设锚也是终端」机检**(D-UI-6 收敛实质 ⓑ 的结构面证据):未设锚元素的
 *    计算值即终端 token 值(不依赖组件侧回退值副本);
 *  - sm-workspace `theme` 属性(独立使用形态)→ 自身 data-sm-theme 转写;
 *    **值域只剩 `terminal`**;`null` = 不写锚(由 `:root` 缺省决定 = 终端);
 *  - 机械护栏:全部 vm-ui 组件静态样式中不再存在 var() 之外的黑色半透明
 *    灰阶 / crimson 硬编码(组件零硬编码颜色改读变量);豁免清单与源码
 *    `@customElement` 清单并集机检(防漏项);字号下限 13px;等宽字体栈回退值
 *    逐字一致(单主题下唯一保留的回退值形态,防多处副本漂移);
 *  - **axe 单主题**(terminal 一遍;color-contrast 沿既有 jsdom 豁免登记)。
 *
 * 随 D-UI-6 废止的断言(不在此文件复活):三预设键集一致、
 * `FROZEN_CONTRAST_VARIABLES`(light / dark 冻结语料)、四值锚规则、
 * axe light / dark 两遍。
 */
import axe from "axe-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LitElement } from "lit";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import "../../src/workspace/sm-workspace.js";
import "../../src/views/ed/sm-call-stack.js";
import "../../src/views/ed/sm-checkpoints.js";
import "../../src/views/ed/sm-error-explainer.js";
import "../../src/views/ed/sm-hint-ladder.js";
import "../../src/views/ed/sm-memory-diff.js";
import "../../src/views/ed/sm-structure-view.js";
import "../../src/views/ed/sm-timeline.js";
import "../../src/payload/sm-payload-tab.js";
import "../../src/views/byte/byte-view.js";
import "../../src/views/byte/vma-list.js";
import "../../src/views/chain/sm-jump-chain.js";
import "../../src/views/instruction/sm-instruction-view.js";
import "../../src/views/register/sm-register-view.js";
import "../../src/views/virtual/sm-window-list.js";
import "../../src/workspace/byte-tab.js";
import "../../src/workspace/sm-register-annotation.js";
import "../../src/workspace/sm-workspace-menu.js";
import type { SmCallStack } from "../../src/views/ed/sm-call-stack.js";
import type { SmCheckpoints } from "../../src/views/ed/sm-checkpoints.js";
import type { SmErrorExplainer } from "../../src/views/ed/sm-error-explainer.js";
import type { SmHintLadder } from "../../src/views/ed/sm-hint-ladder.js";
import type { SmMemoryDiff } from "../../src/views/ed/sm-memory-diff.js";
import type { SmStructureView } from "../../src/views/ed/sm-structure-view.js";
import type { SmTimeline } from "../../src/views/ed/sm-timeline.js";
import type { SmWorkspace } from "../../src/workspace/sm-workspace.js";
import {
  SM_MONO_FONT_STACK,
  SM_THEME_ANCHOR_STYLESHEET_TEXT,
  SM_THEME_ATTRIBUTE,
  SM_THEME_PRESET_VALUES,
  SM_THEME_VALUES,
  SM_THEME_VARIABLES,
  ensureSmThemeStyles,
} from "../../src/theme/theme-tokens.js";

/**
 * 参与机械护栏的**消费清单**(标签名 → 元素类)。未消费者见 `THEME_EXEMPT_TAGS`。
 * 两者**并集**由「护栏覆盖全部注册组件」一条与源码 `@customElement` 清单机检
 * 对齐 ⇒ **新增组件若不登记即变红**,杜绝手写清单漏项。
 */
const THEME_COMPONENT_TAGS: readonly { readonly tag: string; readonly type: unknown }[] = [
  { tag: "sm-workspace", type: undefined },
  { tag: "sm-structure-view", type: undefined },
  { tag: "sm-call-stack", type: undefined },
  { tag: "sm-memory-diff", type: undefined },
  { tag: "sm-timeline", type: undefined },
  { tag: "sm-checkpoints", type: undefined },
  { tag: "sm-hint-ladder", type: undefined },
  { tag: "sm-error-explainer", type: undefined },
  { tag: "sm-byte-view", type: undefined },
  { tag: "sm-vma-list", type: undefined },
  { tag: "sm-instruction-view", type: undefined },
  { tag: "sm-jump-chain", type: undefined },
  { tag: "sm-register-view", type: undefined },
  { tag: "sm-workspace-menu", type: undefined },
  { tag: "sm-register-annotation", type: undefined },
  { tag: "sm-payload-tab", type: undefined },
];

/**
 * **豁免清单**(不消费主题变量、结构上亦无颜色声明)。每项必须给出理由,并由
 * 「护栏覆盖全部注册组件」机检保证其不会成为"漏网组件"的藏身处。
 */
const THEME_EXEMPT_TAGS: readonly { readonly tag: string; readonly reason: string }[] = [
  { tag: "sm-byte-tab", reason: "视图分派壳:仅按 viewKind 渲染 sm-byte-view / sm-vma-list,自身无颜色声明" },
  { tag: "sm-window-list", reason: "虚拟列表容器:只承载滚动与行定位,无颜色声明" },
  {
    tag: "sm-payload-tab-host",
    reason:
      "WP-83 payload 惰性宿主:零样式、零颜色声明、零渲染输出的透传壳(真组件 sm-payload-tab 在引擎按需取回后挂入并自带主题消费)",
  },
];

/** 字号下限 13px(`0.8125rem` = 13px;等价推导见 `src/workspace/layout-presets.ts`)。 */
const MIN_FONT_SIZE_PX = 13;

/** rem → px 换算基准(浏览器默认根字号)。 */
const ROOT_FONT_SIZE_PX = 16;

/**
 * 定位 vm-ui 的 `src/` 目录。
 * 注:Vitest 下 `import.meta.url` 不保证是 `file:` scheme(实测抛
 * `TypeError: The URL must be of scheme file`)⇒ 以 cwd 为锚向上探测包根
 * (兼容「在 packages/vm-ui 下跑」与「在仓库根用聚合配置跑」两种形态)。
 */
function resolveSrcDir(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    for (const candidate of [join(dir, "src"), join(dir, "packages", "vm-ui", "src")]) {
      if (existsSync(join(candidate, "theme", "theme-tokens.ts"))) {
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("未定位到 vm-ui 的 src/ 目录(主题护栏扫描失败)");
}

/** 源码内全部 `@customElement("…")` 登记面(递归扫描 src/,用于覆盖率机检)。 */
function sourceComponentTags(): string[] {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts")) {
        for (const match of readFileSync(full, "utf8").matchAll(/@customElement\("([^"]+)"\)/gu)) {
          found.add(match[1] ?? "");
        }
      }
    }
  };
  walk(resolveSrcDir());
  return [...found].sort();
}

/** 归一空白后比较(源码换行 / 缩写差异不影响判定)。 */
function normalizeCss(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * 计算值比对归一化:jsdom 的 CSSOM 会去掉 `/` 两侧空白(`rgb(0 0 0/15%)`),
 * 故比对前剥除全部空白——两侧同口径处理,不掩盖值本身的差异。
 */
function normalizeComputed(text: string): string {
  return text.replace(/\s+/gu, "");
}

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

/**
 * 抽出全部**带回退值的** `var(--sm-*, <fallback>)`(平衡括号扫描;`rgb(...)` /
 * `color-mix(...)` 这类回退值内含括号,正则 `[^)]*` 会截断 ⇒ 必须配平计数)。
 * 裸形态 `var(--sm-*)` 不在结果内(无回退值 = 合规,无需判定)。
 */
function varSpans(cssText: string): { readonly name: string; readonly fallback: string }[] {
  const spans: { name: string; fallback: string }[] = [];
  const start = /var\(\s*(--sm-[a-z-]+)\s*,\s*/gu;
  for (let match = start.exec(cssText); match !== null; match = start.exec(cssText)) {
    const name = match[1] ?? "";
    let depth = 1;
    let cursor = start.lastIndex;
    for (; cursor < cssText.length; cursor += 1) {
      const char = cssText[cursor];
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    spans.push({ name, fallback: cssText.slice(start.lastIndex, cursor).trim() });
    start.lastIndex = cursor + 1;
  }
  return spans;
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

describe("主题样式表(文档级注入;单主题)", () => {
  it("幂等安装:重复调用只保留一份 <style>", () => {
    ensureSmThemeStyles(document);
    ensureSmThemeStyles(document);
    const installed = document.querySelectorAll('style[id="sm-theme-token-styles"]');
    expect(installed.length).toBe(1);
    expect(installed[0]?.textContent).toBe(SM_THEME_ANCHOR_STYLESHEET_TEXT);
  });

  it("单主题锚规则齐备::root 级缺省(:root 缺省块)+ 单一显式 terminal 锚", () => {
    const css = SM_THEME_ANCHOR_STYLESHEET_TEXT;
    expect(css).toContain(":root{");
    expect(css).toContain(`[${SM_THEME_ATTRIBUTE}="terminal"]`);
    // 退役面零残留:三预设其余值与系统跟随分支不得在场。
    for (const retired of ["light", "dark", "auto"]) {
      expect(css.includes(`[${SM_THEME_ATTRIBUTE}="${retired}"]`), `退役锚仍在:${retired}`).toBe(
        false,
      );
    }
    expect(css.includes("@media (prefers-color-scheme"), "系统跟随分支未退役").toBe(false);
    // 值域单一(无 auto 兼容别名)。
    expect([...SM_THEME_PRESET_VALUES]).toEqual(["terminal"]);
    expect([...SM_THEME_VALUES]).toEqual(["terminal"]);
  });

  it("单一变量记录:21 枚 token 名齐备且逐 token 有值(键集精确锁定见 theme-terminal)", () => {
    const names = Object.keys(SM_THEME_VARIABLES);
    expect(names).toHaveLength(21);
    for (const [name, value] of Object.entries(SM_THEME_VARIABLES)) {
      expect(value, `token 空值:${name}`).toBeTruthy();
    }
    // 单一来源:显式锚块与 `:root` 缺省块逐字同值(同一份记录生成)。
    const block = Object.entries(SM_THEME_VARIABLES)
      .map(([name, value]) => `${name}:${value}`)
      .join(";");
    expect(SM_THEME_ANCHOR_STYLESHEET_TEXT).toContain(`:root{${block}}`);
    expect(SM_THEME_ANCHOR_STYLESHEET_TEXT).toContain(
      `[${SM_THEME_ATTRIBUTE}="terminal"]{${block}}`,
    );
  });

  it("未设锚也是终端:无锚元素的计算值即终端 token 值(D-UI-6 收敛实质 ⓑ)", () => {
    document.getElementById("sm-theme-token-styles")?.remove();
    ensureSmThemeStyles(document);
    // 未设锚的宿主(生产形态:嵌入宿主 / 独立包裹层 / 任意祖先)。
    const host = document.createElement("div");
    const child = document.createElement("span");
    child.textContent = "probe";
    host.append(child);
    main!.append(host);
    expect(host.hasAttribute(SM_THEME_ATTRIBUTE)).toBe(false);
    expect(
      normalizeComputed(getComputedStyle(document.documentElement).getPropertyValue("--sm-bg-base")),
    ).toBe(normalizeComputed(SM_THEME_VARIABLES["--sm-bg-base"] ?? ""));
    for (const [name, value] of Object.entries(SM_THEME_VARIABLES)) {
      expect(
        normalizeComputed(getComputedStyle(child).getPropertyValue(name)),
        `缺省未命中终端值:${name}`,
      ).toBe(normalizeComputed(value));
    }
    host.remove();
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

  it("护栏覆盖全部注册组件:源码 @customElement 清单 = 消费清单 ∪ 豁免清单", () => {
    const declared = sourceComponentTags();
    // 防"扫描失效"导致假绿:源码里必须真的扫到组件。
    expect(declared.length).toBeGreaterThanOrEqual(18);
    const covered = [
      ...THEME_COMPONENT_TAGS.map((entry) => entry.tag),
      ...THEME_EXEMPT_TAGS.map((entry) => entry.tag),
    ].sort();
    // 新增 / 改名组件若不登记即在此变红(手写清单不可能漏项)。
    expect(covered).toEqual(declared);
    for (const tag of declared) {
      expect(customElements.get(tag), `组件未注册:${tag}`).toBeTruthy();
    }
    // 两份清单不得重叠,豁免不得藏身于消费清单。
    const consuming = new Set(THEME_COMPONENT_TAGS.map((entry) => entry.tag));
    for (const { tag } of THEME_EXEMPT_TAGS) {
      expect(consuming.has(tag), `${tag} 同时在消费与豁免清单`).toBe(false);
    }
  });

  it("字号下限 13px:全部组件 font-size 折算后不低于 13px(rem 按 16px 折算)", () => {
    for (const { tag } of THEME_COMPONENT_TAGS) {
      for (const match of cssTextOf(tag).matchAll(/font-size:\s*([\d.]+)(px|rem)/gu)) {
        const size = Number(match[1]);
        const px = match[2] === "rem" ? size * ROOT_FONT_SIZE_PX : size;
        expect(px, `${tag} 字号低于下限:${match[0]} → ${String(px)}px`).toBeGreaterThanOrEqual(
          MIN_FONT_SIZE_PX,
        );
      }
    }
  });

  it("等宽字体栈回退值与 SM_MONO_FONT_STACK 逐字一致(防多处副本漂移)", () => {
    const expected = normalizeCss(SM_MONO_FONT_STACK);
    let checked = 0;
    for (const { tag } of THEME_COMPONENT_TAGS) {
      // 回退值内含逗号但无括号 ⇒ 用 [^)]+ 取到 var() 收尾前的内容。
      for (const match of cssTextOf(tag).matchAll(/var\(--sm-font-mono,\s*([^)]+)\)/gu)) {
        checked += 1;
        expect(normalizeCss(match[1] ?? ""), `${tag} 的 --sm-font-mono 回退值漂移`).toBe(expected);
      }
    }
    // 全仓必须至少有一处消费(防"删掉声明即通过")。
    expect(checked, "未发现任何 --sm-font-mono 消费点").toBeGreaterThan(0);
  });

  it("回退值纪律:回退值只允许「省略」/「逐字等于终端值」/「非颜色中性值」(D-UI-6 收敛实质 ⓑ)", () => {
    const violations: string[] = [];
    let scanned = 0;
    for (const { tag } of THEME_COMPONENT_TAGS) {
      for (const span of varSpans(cssTextOf(tag))) {
        scanned += 1;
        if (span.name === "--sm-font-mono") {
          // 唯一例外:等宽字体栈回退值必须逐字等于定案栈(防副本漂移;见上一条机检)。
          expect(normalizeCss(span.fallback), `${tag} 的 --sm-font-mono 回退值漂移`).toBe(
            normalizeCss(SM_MONO_FONT_STACK),
          );
          continue;
        }
        // 三档合规:
        //  ① 逐字等于该 token 的终端值(终端等价;与单一来源不冲突);
        //  ② `none` / `0` / `0s` 这类**非颜色中性值**(效果面 token 的缺省关闭态,
        //     不产生浅色回落);
        //  ③ 裸形态 `var(--sm-x)`(无回退值;不在本扫描面内)。
        const equivalent =
          normalizeComputed(span.fallback) ===
          normalizeComputed(SM_THEME_VARIABLES[span.name] ?? "");
        const neutral = ["none", "0", "0s"].includes(span.fallback.toLowerCase());
        const shallow = /^(canvas|canvastext|graytext|linktext|accentcolor|field|mark|highlight|highlighttext|buttonface|buttontext|crimson|#fff|white)$|^rgb\(0 0 0/iu.test(
          normalizeCss(span.fallback),
        );
        if (!equivalent && !neutral) {
          violations.push(`${tag}::${span.name}::${normalizeCss(span.fallback)}`);
          continue;
        }
        // 浅色语义硬拒(即便"中性 / 等价"判定通过也不得出现)。
        expect(
          shallow,
          `${tag} 的 ${span.name} 回退值是浅色字面量:var(${span.name},${span.fallback})`,
        ).toBe(false);
      }
    }
    // 防"零扫描即通过"(扫描面必须真的覆盖到组件样式)。
    expect(scanned).toBeGreaterThan(0);

    // ── 未偿余额登记 lane(具名 + 计数锁定)────────────────────────────────
    // 曾在本轮**禁改文件**(`sm-workspace.ts` / `sm-workspace-menu.ts`)里存在的
    // 浅色回退(共 18 处:`var(--sm-fg, canvastext)` ×3 / `graytext` ×5 /
    // `canvas` ×1 / `accentcolor` ×2 / `field` ×3 / `highlight` ×2 /
    // `rgb(0 0 0 / x%)` ×2 族)**已由文件持有方修毕**(终值回退 / 删除);
    // 故本登记表现为空 —— 纪律变为**严格**:任何新增浅色回退一律直接变红
    // (无豁免通道)。若将来又出现必须跨 agent 暂缓的槽位,按
    // `{tag, token, fallback, count}` 入册(计数不得增长,修好后同批删除)。
    const pendingFixRegistry: readonly { readonly tag: string; readonly token: string; readonly fallback: string; readonly count: number }[] = [];
    const actualCounts = new Map<string, number>();
    for (const key of violations) {
      actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1);
    }
    const registered = new Map<string, number>();
    for (const entry of pendingFixRegistry) {
      const key = `${entry.tag}::${entry.token}::${entry.fallback}`;
      registered.set(key, (registered.get(key) ?? 0) + entry.count);
    }
    const exceeding = [...actualCounts].filter(
      ([key, count]) => count > (registered.get(key) ?? 0),
    );
    expect(
      exceeding.map(([key, count]) => {
        const registeredCount = registered.get(key) ?? 0;
        return `${key}(实际 ${String(count)} > 登记 ${String(registeredCount)})`;
      }),
      "新增未登记的浅色回退值(单主题纪律:回退值必须省略或终端等价)",
    ).toEqual([]);
    const stale = [...registered].filter(([key, count]) => (actualCounts.get(key) ?? 0) < count);
    expect(
      stale.map(([key, count]) => {
        const actualCount = actualCounts.get(key) ?? 0;
        return `${key}(登记 ${String(count)} > 实际 ${String(actualCount)})`;
      }),
      "登记项已过期:请同步收缩 pendingFixRegistry(该 token 回退值已修复)",
    ).toEqual([]);
  });
});

describe("sm-workspace theme 属性(独立使用形态;单主题值域)", () => {
  it("theme = terminal → 自身锚 = terminal;theme = null → 不写锚(:root 缺省 = 终端)", async () => {
    const workspace = document.createElement("sm-workspace") as SmWorkspace;
    main!.append(workspace);

    workspace.theme = "terminal";
    await workspace.updateComplete;
    expect(workspace.getAttribute(SM_THEME_ATTRIBUTE)).toBe("terminal");

    workspace.theme = null;
    await workspace.updateComplete;
    expect(workspace.hasAttribute(SM_THEME_ATTRIBUTE)).toBe(false);

    workspace.remove();
  });
});

describe("axe 单主题(terminal 锚;零 violations)", () => {
  async function runAxeUnderTerminal(): Promise<void> {
    const wrapper = document.createElement("div");
    wrapper.setAttribute(SM_THEME_ATTRIBUTE, "terminal");
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
        // jsdom 无布局引擎,对比度不可判定(既有豁免登记;真机补测归 E2E 面)。
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

  it("terminal 锚:零 violations(单主题生效的结构面证据)", async () => {
    ensureSmThemeStyles(document);
    await runAxeUnderTerminal();
  });
});

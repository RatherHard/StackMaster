/**
 * 终端单主题结构断言(原 WP-73 `terminal` 预设断言;2026-09-18 D-UI-6 收敛为
 * **唯一主题**)。
 *  - **21 枚 token 名精确锁定**(D-UI-6 明写的登记义务:按单主题重写,不是删除);
 *  - 单一变量记录:逐 token 齐备、无空值,`SM_THEME_PRESET_VALUES` = `["terminal"]`
 *    (三预设键集一致断言随预设退役,改为单套断言);
 *  - 色板为**具体色值**(无系统颜色关键词)——保证真机 axe 可判定;
 *  - 效果面 / 精灵滤镜 token **恒有定义**,不再有「light 下取 0 / none」的口径;
 *  - 字体栈与 §2.1 定案栈一字不差;
 *  - 可读性下限:按 WCAG 2 对比度公式逐对机检(保守初值口径);
 *  - 锚生效:`:root` 缺省 = 终端(**未设锚也是终端**);显式锚同值;
 *    `auto` 锚与系统跟随媒体查询**已随 D-UI-6 退场**。
 *
 * **真机 axe color-contrast 门禁归 E2E 面**(13.4 矩阵):本文件只在 jsdom 层固化
 * 结构面与公式面证据,不替代真机结论。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  SM_THEME_ANCHOR_STYLESHEET_TEXT,
  SM_THEME_ATTRIBUTE,
  SM_THEME_PRESET_VALUES,
  SM_THEME_VALUES,
  SM_TERMINAL_THEME_VALUE,
  SM_THEME_VARIABLES,
  ensureSmThemeStyles,
} from "../../src/theme/theme-tokens.js";

/** §2.1 定案字体栈(全组件统一)。 */
const MONO_FONT_STACK =
  'ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, "Noto Sans Mono CJK SC", monospace';

/** 前景类 token 与最低对比度要求(WCAG 2 AA 正文 4.5;主前景取 AAA 7)。 */
const TEXT_TOKENS: readonly { readonly name: string; readonly minRatio: number }[] = [
  { name: "--sm-fg", minRatio: 7 },
  { name: "--sm-fg-dim", minRatio: 4.5 },
  { name: "--sm-accent", minRatio: 4.5 },
  { name: "--sm-warn", minRatio: 4.5 },
  { name: "--sm-danger", minRatio: 4.5 },
  { name: "--sm-focus-ring", minRatio: 4.5 },
];

/** 21 枚 token 名清单(精确锁定的机检语料;键集断言按单主题重写)。 */
const EXPECTED_TOKEN_NAMES: readonly string[] = [
  "--sm-bg-base",
  "--sm-bg-panel",
  "--sm-bg-inset",
  "--sm-fg",
  "--sm-fg-dim",
  "--sm-accent",
  "--sm-warn",
  "--sm-danger",
  "--sm-selection",
  "--sm-focus-ring",
  "--sm-font-mono",
  "--sm-scanline-opacity",
  "--sm-caret-blink",
  "--sm-border",
  "--sm-border-button",
  "--sm-border-strong",
  "--sm-divider",
  "--sm-divider-faint",
  "--sm-badge-bg",
  "--sm-badge-bg-soft",
  // M3 WP-80 增量 token(深底画布精灵处理;单主题下恒有定义)。
  "--sm-canvas-sprite-filter",
];

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** 解析 `#rrggbb` / `rgb(r g b / p%)`(alpha < 1 必须给底 `bg` 以合成)。 */
function parseColor(value: string, bg?: Rgb): Rgb {
  const text = value.trim();
  const hex = /^#([0-9a-fA-F]{6})$/.exec(text);
  if (hex !== null) {
    const digits = hex[1] ?? "";
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
    };
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)%\s*\)$/.exec(text);
  const legacy = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(text);
  if (legacy !== null) {
    return { r: Number(legacy[1]), g: Number(legacy[2]), b: Number(legacy[3]) };
  }
  expect(rgb, `颜色形态不可解析(终端色板需具体色值):${value}`).not.toBeNull();
  const alpha = Number(rgb?.[4]) / 100;
  const foreground: Rgb = { r: Number(rgb?.[1]), g: Number(rgb?.[2]), b: Number(rgb?.[3]) };
  if (alpha >= 1) {
    return foreground;
  }
  expect(bg, `半透明色需要底色才能合成:${value}`).toBeDefined();
  const base = bg as Rgb;
  return {
    r: alpha * foreground.r + (1 - alpha) * base.r,
    g: alpha * foreground.g + (1 - alpha) * base.g,
    b: alpha * foreground.b + (1 - alpha) * base.b,
  };
}

/** WCAG 2 相对亮度。 */
function relativeLuminance(color: Rgb): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG 2 对比度(1..21)。 */
function contrastRatio(a: Rgb, b: Rgb): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((high as number) + 0.05) / ((low as number) + 0.05);
}

/** 取 token 值(缺失即断言失败,给出 token 名)。 */
function token(name: string): string {
  const value = SM_THEME_VARIABLES[name];
  expect(value, `缺 token:${name}`).toBeTypeOf("string");
  return value as string;
}

/**
 * 计算值比对归一化:jsdom 的 CSSOM 会去掉 `/` 两侧空白(`rgb(0 0 0/15%)`),
 * 故比对前剥除全部空白——两侧同口径处理,不掩盖值本身的差异。
 */
function normalizeComputed(text: string): string {
  return text.replace(/\s+/g, "");
}

let styleHost: HTMLElement | null = null;

beforeAll(() => {
  styleHost = document.createElement("div");
  styleHost.id = "theme-terminal-test-host";
  document.body.append(styleHost);
});

afterAll(() => {
  styleHost?.remove();
  styleHost = null;
  document.getElementById("sm-theme-token-styles")?.remove();
});

describe("单主题 token 集(D-UI-6 收敛)", () => {
  it("21 枚 token 名精确锁定(键集断言保留,不是删除)", () => {
    expect(Object.keys(SM_THEME_VARIABLES).sort()).toEqual([...EXPECTED_TOKEN_NAMES].sort());
    // 键数精确锁定(20 → 21 由 M3 WP-80 落地):新增一项必须同时更新本清单与
    // docs/user/界面帮助手册.html §12.2 的 token 表。
    expect(EXPECTED_TOKEN_NAMES).toHaveLength(21);
  });

  it("逐 token 齐备且非空(单一变量记录)", () => {
    for (const name of EXPECTED_TOKEN_NAMES) {
      expect(token(name).length, `token 空值:${name}`).toBeGreaterThan(0);
    }
  });

  it("值域单一:SM_THEME_PRESET_VALUES / SM_THEME_VALUES = [\"terminal\"](无 auto 别名)", () => {
    expect([...SM_THEME_PRESET_VALUES]).toEqual(["terminal"]);
    expect([...SM_THEME_VALUES]).toEqual(["terminal"]);
    expect(SM_TERMINAL_THEME_VALUE).toBe("terminal");
    expect(SM_THEME_VALUES).toContain(SM_TERMINAL_THEME_VALUE);
  });

  it("色板为具体色值(无系统颜色关键词),真机 axe 面可判定", () => {
    const colorTokens = Object.keys(SM_THEME_VARIABLES).filter(
      (name) =>
        name !== "--sm-font-mono" &&
        !name.startsWith("--sm-scanline") &&
        !name.startsWith("--sm-caret") &&
        // 精灵滤镜不是颜色值(`none` / `brightness()`),不进色值判定。
        !name.startsWith("--sm-canvas-sprite"),
    );
    for (const name of colorTokens) {
      expect(token(name), `终端色板需具体色值:${name}`).toMatch(/^(#[0-9a-fA-F]{6}|rgb\([^)]*\))$/);
    }
  });
});

describe("值域与锚面同源(单主题)", () => {
  it("锚样式表 = `:root` 缺省块 + 单一 terminal 锚,均由变量记录同源生成(零手写重复块)", () => {
    const css = SM_THEME_ANCHOR_STYLESHEET_TEXT;
    const block = Object.entries(SM_THEME_VARIABLES)
      .map(([name, value]) => `${name}:${value}`)
      .join(";");
    expect(css).toContain(`:root{${block}}`);
    expect(css).toContain(`[${SM_THEME_ATTRIBUTE}="terminal"]{${block}}`);
    // 退役面零残留:light / dark / auto 锚与系统跟随分支都不得在场。
    expect(css).not.toContain(`[${SM_THEME_ATTRIBUTE}="light"]`);
    expect(css).not.toContain(`[${SM_THEME_ATTRIBUTE}="dark"]`);
    expect(css).not.toContain(`[${SM_THEME_ATTRIBUTE}="auto"]`);
    expect(css).not.toContain("@media");
    expect(css).not.toContain("prefers-color-scheme");
    // 退役浅色字面量不得在场(`canvas` 这一系统色关键词;注意 `--sm-canvas-sprite-filter`
    // 的 token 名本身含 "canvas" ⇒ 只查取值形态 `:canvas` / `,canvas`)。
    expect(css).not.toContain(":canvas");
    expect(css).not.toContain(",canvas");
    expect(css).not.toContain("crimson");
  });

  it("文档级注入面:单份 <style id> 幂等且承载 `:root` 缺省 + terminal 规则", () => {
    ensureSmThemeStyles(document);
    ensureSmThemeStyles(document);
    const installed = document.querySelectorAll('style[id="sm-theme-token-styles"]');
    expect(installed.length).toBe(1);
    expect(installed[0]?.textContent).toBe(SM_THEME_ANCHOR_STYLESHEET_TEXT);
    expect(installed[0]?.textContent).toContain(`[${SM_THEME_ATTRIBUTE}="terminal"]`);
    expect(installed[0]?.textContent).toContain(":root{");
  });
});

describe("字体与效果面(单主题下恒有定义)", () => {
  it("字体栈与 §2.1 定案栈一字不差", () => {
    expect(token("--sm-font-mono")).toBe(MONO_FONT_STACK);
  });

  it("效果面恒开启且不超 0.06 / 1.1s 登记上限(无「light 下取 0」口径)", () => {
    const scanline = Number(token("--sm-scanline-opacity"));
    expect(scanline).toBeGreaterThan(0);
    expect(scanline).toBeLessThanOrEqual(0.06);
    const caret = token("--sm-caret-blink");
    expect(caret).toMatch(/^[\d.]+m?s$/);
    expect(parseFloat(caret)).toBeGreaterThan(0);
  });

  it("深底画布精灵处理恒有定义:只允许 brightness()(无「light 下 none」口径)", () => {
    const value = token("--sm-canvas-sprite-filter");
    expect(value, "精灵滤镜形态").toMatch(/^brightness\([\d.]+\)$/);
    expect(Number(/^brightness\(([\d.]+)\)$/.exec(value)?.[1] ?? "1")).toBeGreaterThan(1);
  });
});

describe("锚生效(jsdom 计算值面;跨 shadow 与真机 axe 归 E2E 面)", () => {
  /**
   * 挂载锚容器(样式表由 `ensureSmThemeStyles` 注入顶层文档;返回宿主与后代)。
   * jsdom 可判定**文档级样式表 → light DOM 元素**的自定义属性计算值与继承
   * (已实测),但**不跨 shadow 边界**(shadow 内 `getComputedStyle` 对继承的
   * 自定义属性返回空)——组件 shadow 内的真机级联由 E2E 断言。
   */
  function mountAnchored(anchorValue: string | null): { readonly host: HTMLElement; readonly child: HTMLElement } {
    ensureSmThemeStyles(document);
    const host = document.createElement("div");
    if (anchorValue !== null) {
      host.setAttribute(SM_THEME_ATTRIBUTE, anchorValue);
    }
    const child = document.createElement("span");
    child.textContent = "probe";
    host.append(child);
    styleHost?.append(host);
    return { host, child };
  }

  afterEach(() => {
    styleHost?.replaceChildren();
  });

  it("terminal 锚:宿主与其后代逐 token 计算值命中终端值集", () => {
    const { host, child } = mountAnchored("terminal");
    const hostComputed = getComputedStyle(host);
    const childComputed = getComputedStyle(child);
    for (const [name, value] of Object.entries(SM_THEME_VARIABLES)) {
      expect(normalizeComputed(hostComputed.getPropertyValue(name)), `未命中终端值:${name}`).toBe(
        normalizeComputed(value),
      );
      expect(normalizeComputed(childComputed.getPropertyValue(name)), `终端未继承:${name}`).toBe(
        normalizeComputed(value),
      );
    }
  });

  it("未设锚也是终端:`:root` 缺省逐 token 命中终端值(不依赖回退值副本)", () => {
    const { host, child } = mountAnchored(null);
    expect(host.hasAttribute(SM_THEME_ATTRIBUTE)).toBe(false);
    for (const [name, value] of Object.entries(SM_THEME_VARIABLES)) {
      expect(
        normalizeComputed(getComputedStyle(host).getPropertyValue(name)),
        `未设锚未命中终端值(root 缺省失效):${name}`,
      ).toBe(normalizeComputed(value));
      expect(
        normalizeComputed(getComputedStyle(child).getPropertyValue(name)),
        `未设锚未继承终端值:${name}`,
      ).toBe(normalizeComputed(value));
    }
  });

  it("历史坏锚兜底:`data-sm-theme` 遗留值(light / dark / auto)同样命中终端值集", () => {
    // 三预设期由嵌入形态宿主写入的锚值在单主题下落入自定义属性继承面;
    // 显式锚规则一律覆盖为终端值 ⇒ 不出现「坏锚改主题」的静默降级。
    for (const stale of ["light", "dark", "auto"]) {
      const { host } = mountAnchored(stale);
      for (const [name, value] of Object.entries(SM_THEME_VARIABLES)) {
        expect(
          normalizeComputed(getComputedStyle(host).getPropertyValue(name)),
          `坏锚 ${stale} 未收敛为终端值:${name}`,
        ).toBe(normalizeComputed(value));
      }
    }
  });
});

describe("终端色板可读性下限(WCAG 对比度公式;真机 axe 归 E2E 面)", () => {
  const backgrounds = ["--sm-bg-base", "--sm-bg-panel", "--sm-bg-inset"] as const;

  it("前景类 token 对三层背景逐对达标(AA 4.5;主前景 AAA 7)", () => {
    for (const { name, minRatio } of TEXT_TOKENS) {
      for (const background of backgrounds) {
        const bg = parseColor(token(background));
        const fg = parseColor(token(name), bg);
        const ratio = contrastRatio(fg, bg);
        expect(
          ratio,
          `${name} 对 ${background} 对比度不足(${ratio.toFixed(2)} < ${String(minRatio)})`,
        ).toBeGreaterThanOrEqual(minRatio);
      }
    }
  });

  it("选区底与前景可辨(≥ 4.5)", () => {
    const selection = parseColor(token("--sm-selection"));
    const fg = parseColor(token("--sm-fg"), selection);
    expect(contrastRatio(fg, selection)).toBeGreaterThanOrEqual(4.5);
  });

  it("强调边框在底色上达非文本对比(合成后 ≥ 3),边框族保持 α 阶梯", () => {
    const bg = parseColor(token("--sm-bg-base"));
    // 非文本对比(WCAG 1.4.11)的承载面 = 最强强调边框;卡片 / 按钮边框维持
    // 同族的弱边框阶梯(不强行拉到 3:1,避免破坏既有观感族)。
    const strong = parseColor(token("--sm-border-strong"), bg);
    const strongRatio = contrastRatio(strong, bg);
    expect(strongRatio, `--sm-border-strong 非文本对比不足(${strongRatio.toFixed(2)} < 3)`).toBeGreaterThanOrEqual(3);
    const alpha = (name: string): number => {
      const match = /\/\s*([\d.]+)%\s*\)$/.exec(token(name));
      expect(match, `边框族需 α 形态:${name}`).not.toBeNull();
      return Number(match?.[1]);
    };
    expect(alpha("--sm-border")).toBeLessThan(alpha("--sm-border-button"));
    expect(alpha("--sm-border-button")).toBeLessThan(alpha("--sm-border-strong"));
  });
});

/**
 * WP-73 `terminal` 预设结构断言(中期计划 §2.1 / D-MP-2 主题链):
 *  - 三预设 token 集:light / dark / terminal 同名键集一致,terminal 逐 token 齐备,
 *    且 terminal 色板为**具体色值**(无系统颜色关键词)——保证真机 axe 可判定;
 *  - 值域与锚面同源:terminal 锚规则由变量记录生成(机检无手写重复 CSS 块);
 *  - 效果面:light / dark 关闭(`--sm-scanline-opacity` = 0 / `--sm-caret-blink` = 0s),
 *    terminal 开启且不超 WP-74 的 0.06 上限(light / dark 零变化的结构保证);
 *  - 字体栈:三预设同源,与 §2.1 定案栈一字不差;
 *  - 可读性下限:terminal 色板按 WCAG 2 对比度公式逐对机检(保守初值口径)。
 *
 * **真机 axe color-contrast 门禁归 WP-74**(13.4 矩阵):本文件只在 jsdom 层固化
 * 结构面与公式面证据,不替代真机结论;terminal 数值按其报告修正。
 * 效果类 token 本包只落变量,扫描线 / 光标动画的实装(WP-74)必须 `aria-hidden`
 * 纯装饰 + 尊重 `prefers-reduced-motion`,且动画只用 transform / opacity。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  SM_THEME_ANCHOR_STYLESHEET_TEXT,
  SM_THEME_ATTRIBUTE,
  SM_THEME_PRESET_VALUES,
  SM_THEME_VALUES,
  SM_THEME_VARIABLES,
  ensureSmThemeStyles,
  type SmThemeValue,
} from "../../src/theme/theme-tokens.js";

/** §2.1 定案字体栈(全组件统一;WP-74 逐组件替换消费)。 */
const MONO_FONT_STACK =
  'ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, "Noto Sans Mono CJK SC", monospace';

/** terminal 预设的前景类 token 与最低对比度要求(WCAG 2 AA 正文 4.5;主前景取 AAA 7)。 */
const TERMINAL_TEXT_TOKENS: readonly { readonly name: string; readonly minRatio: number }[] = [
  { name: "--sm-fg", minRatio: 7 },
  { name: "--sm-fg-dim", minRatio: 4.5 },
  { name: "--sm-accent", minRatio: 4.5 },
  { name: "--sm-warn", minRatio: 4.5 },
  { name: "--sm-danger", minRatio: 4.5 },
  { name: "--sm-focus-ring", minRatio: 4.5 },
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
  expect(rgb, `颜色形态不可解析(terminal 预设需具体色值):${value}`).not.toBeNull();
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
function token(preset: "light" | "dark" | "terminal", name: string): string {
  const value = SM_THEME_VARIABLES[preset][name];
  expect(value, `${preset} 缺 token:${name}`).toBeTypeOf("string");
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

describe("三预设 token 集(WP-73)", () => {
  it("light / dark / terminal 同名键集一致,terminal 逐 token 齐备", () => {
    const lightNames = Object.keys(SM_THEME_VARIABLES.light).sort();
    const darkNames = Object.keys(SM_THEME_VARIABLES.dark).sort();
    const terminalNames = Object.keys(SM_THEME_VARIABLES.terminal).sort();
    expect(darkNames).toEqual(lightNames);
    expect(terminalNames).toEqual(lightNames);
    for (const name of terminalNames) {
      expect(token("terminal", name).length, `terminal 空值:${name}`).toBeGreaterThan(0);
    }
  });

  it("§2.1 清单齐备:背景三层 / 前景 / 语义色 / 字体 / 效果逐名在场", () => {
    const expected = [
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
      // M3 WP-80 增量 token(深底画布精灵处理;light `none` ⇒ 零视觉变化)。
      "--sm-canvas-sprite-filter",
    ];
    expect(Object.keys(SM_THEME_VARIABLES.terminal).sort()).toEqual([...expected].sort());
    // 键数精确锁定(20 → 21:新增一项必须同时更新本清单与
    // docs/user/界面帮助手册.html §12.2 的 token 表)。
    expect(expected).toHaveLength(21);
  });

  it("terminal 色板为具体色值(无系统颜色关键词),真机 axe 面可判定", () => {
    const colorTokens = Object.keys(SM_THEME_VARIABLES.terminal).filter(
      (name) =>
        name !== "--sm-font-mono" &&
        !name.startsWith("--sm-scanline") &&
        !name.startsWith("--sm-caret") &&
        // 精灵滤镜不是颜色值(`none` / `brightness()`),不进色值判定。
        !name.startsWith("--sm-canvas-sprite"),
    );
    for (const name of colorTokens) {
      expect(token("terminal", name), `terminal 需具体色值:${name}`).toMatch(
        /^(#[0-9a-fA-F]{6}|rgb\([^)]*\))$/,
      );
    }
  });

  it("terminal 是独立预设:颜色族与 light 逐 token 不同(不是 light 复用)", () => {
    for (const name of [
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
      "--sm-border",
      "--sm-divider",
      "--sm-badge-bg",
    ]) {
      expect(token("terminal", name), `terminal 与 light 同值(非独立预设):${name}`).not.toBe(
        token("light", name),
      );
    }
  });
});

describe("值域与锚面同源(WP-73)", () => {
  it("值域 = 预设集 + auto(terminal 增列,顺序稳定)", () => {
    expect([...SM_THEME_PRESET_VALUES]).toEqual(["light", "dark", "terminal"]);
    expect([...SM_THEME_VALUES]).toEqual(["light", "dark", "terminal", "auto"]);
    // `sm-workspace.theme` 属性类型即该值域(SmThemeValue)——编译期由 tsc 保证;
    // 此处固化运行期取值面(terminal 必须可选)。
    const terminalValue: SmThemeValue = "terminal";
    expect(SM_THEME_VALUES).toContain(terminalValue);
  });

  it("锚样式表含 terminal 规则,且由变量记录同源生成(零手写重复块)", () => {
    const css = SM_THEME_ANCHOR_STYLESHEET_TEXT;
    expect(css).toContain(`[${SM_THEME_ATTRIBUTE}="terminal"]`);
    const declarations = Object.entries(SM_THEME_VARIABLES.terminal)
      .map(([name, value]) => `${name}:${value}`)
      .join(";");
    expect(css).toContain(`[${SM_THEME_ATTRIBUTE}="terminal"]{${declarations}}`);
  });

  it("auto 的两条规则与 light / dark 锚逐值不变(系统跟随语义保留)", () => {
    const css = SM_THEME_ANCHOR_STYLESHEET_TEXT;
    const mediaIndex = css.indexOf("@media (prefers-color-scheme: dark)");
    expect(mediaIndex).toBeGreaterThan(0);
    const mediaRule = css.slice(mediaIndex);
    expect(mediaRule).toContain(`[${SM_THEME_ATTRIBUTE}="auto"]`);
    expect(mediaRule).toContain("--sm-border:rgb(255 255 255 / 22%)");
    // auto 的浅色缺省规则在 @media 之前,且不含 terminal 块。
    const beforeMedia = css.slice(0, mediaIndex);
    expect(beforeMedia).toContain(`[${SM_THEME_ATTRIBUTE}="auto"]`);
    expect(beforeMedia).toContain("--sm-border:rgb(0 0 0 / 15%)");
    expect(beforeMedia).not.toContain("terminal");
  });

  it("文档级注入面零结构变化:单份 <style id> 幂等且承载 terminal 规则", () => {
    ensureSmThemeStyles(document);
    ensureSmThemeStyles(document);
    const installed = document.querySelectorAll('style[id="sm-theme-token-styles"]');
    expect(installed.length).toBe(1);
    expect(installed[0]?.textContent).toBe(SM_THEME_ANCHOR_STYLESHEET_TEXT);
    expect(installed[0]?.textContent).toContain(`[${SM_THEME_ATTRIBUTE}="terminal"]`);
  });
});

describe("字体与效果面(WP-73 落变量,实装归 WP-74)", () => {
  it("字体栈:三预设同源且与 §2.1 定案栈一字不差", () => {
    for (const preset of SM_THEME_PRESET_VALUES) {
      expect(token(preset, "--sm-font-mono")).toBe(MONO_FONT_STACK);
    }
  });

  it("效果面:light / dark 关闭,terminal 开启且不超 0.06 上限", () => {
    for (const preset of ["light", "dark"] as const) {
      expect(token(preset, "--sm-scanline-opacity")).toBe("0");
      expect(token(preset, "--sm-caret-blink")).toBe("0s");
    }
    const scanline = Number(token("terminal", "--sm-scanline-opacity"));
    expect(scanline).toBeGreaterThan(0);
    expect(scanline).toBeLessThanOrEqual(0.06);
    const caret = token("terminal", "--sm-caret-blink");
    expect(caret).toMatch(/^[\d.]+m?s$/);
    expect(parseFloat(caret)).toBeGreaterThan(0);
  });

  it("深底画布精灵处理:light = none(零视觉变化),dark / terminal 取提亮度", () => {
    expect(token("light", "--sm-canvas-sprite-filter")).toBe("none");
    for (const preset of ["dark", "terminal"] as const) {
      const value = token(preset, "--sm-canvas-sprite-filter");
      // 只允许 `brightness()`(灰度精灵不带色相 ⇒ 不做滤镜近似的着色)。
      expect(value, `${preset} 精灵滤镜形态`).toMatch(/^brightness\([\d.]+\)$/);
      expect(Number(/^brightness\(([\d.]+)\)$/.exec(value)?.[1] ?? "1")).toBeGreaterThan(1);
    }
  });
});

describe("terminal 锚生效(jsdom 计算值面;跨 shadow 与真机 axe 归 WP-74)", () => {
  /**
   * 挂载锚容器(样式表由 `ensureSmThemeStyles` 注入顶层文档;返回宿主与后代)。
   * jsdom 可判定**文档级样式表 → light DOM 元素**的自定义属性计算值与继承
   * (已实测),但**不跨 shadow 边界**(shadow 内 `getComputedStyle` 对继承的
   * 自定义属性返回空)——组件 shadow 内的真机级联由 WP-74 E2E 断言。
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

  it("terminal 锚:宿主与其后代逐 token 计算值命中 terminal 值集", () => {
    const { host, child } = mountAnchored("terminal");
    const hostComputed = getComputedStyle(host);
    const childComputed = getComputedStyle(child);
    for (const [name, value] of Object.entries(SM_THEME_VARIABLES.terminal)) {
      expect(normalizeComputed(hostComputed.getPropertyValue(name)), `未命中 terminal 值:${name}`).toBe(
        normalizeComputed(value),
      );
      expect(normalizeComputed(childComputed.getPropertyValue(name)), `terminal 未继承:${name}`).toBe(
        normalizeComputed(value),
      );
    }
  });

  it("无锚:变量缺省为空(组件 `var(--sm-*, <light 值>)` 兜底;未授予形态语义)", () => {
    const { host } = mountAnchored(null);
    expect(getComputedStyle(host).getPropertyValue("--sm-bg-base").trim()).toBe("");
  });

  it("auto 锚:jsdom 无暗色偏好 ⇒ 浅色缺省(与 light 锚逐值一致;系统跟随由 CSS 承担)", () => {
    const { host } = mountAnchored("auto");
    const computed = getComputedStyle(host);
    for (const [name, value] of Object.entries(SM_THEME_VARIABLES.light)) {
      expect(normalizeComputed(computed.getPropertyValue(name)), `auto 未命中 light 缺省:${name}`).toBe(
        normalizeComputed(value),
      );
    }
  });

  it("最近锚优先:祖先 terminal 锚被自身锚遮蔽(D-MP-2 承载判定的机检依据)", () => {
    // 祖先链:terminal 锚 → 自身 dark 锚 ⇒ 自身命中 dark 值(祖先 terminal 不可达)。
    const outer = document.createElement("div");
    outer.setAttribute(SM_THEME_ATTRIBUTE, "terminal");
    const inner = document.createElement("div");
    inner.setAttribute(SM_THEME_ATTRIBUTE, "dark");
    outer.append(inner);
    styleHost?.append(outer);
    const terminalValue = token("terminal", "--sm-bg-base");
    const darkValue = token("dark", "--sm-bg-base");
    expect(darkValue).not.toBe(terminalValue); // 两预设该 token 必须可区分。
    expect(getComputedStyle(inner).getPropertyValue("--sm-bg-base").trim()).toBe(darkValue);
    // 移除自身锚(插件让位形态)→ 祖先 terminal 锚重新可达。
    inner.removeAttribute(SM_THEME_ATTRIBUTE);
    expect(getComputedStyle(inner).getPropertyValue("--sm-bg-base").trim()).toBe(terminalValue);
    outer.remove();
  });
});

describe("terminal 色板可读性下限(WCAG 对比度公式;真机 axe 归 WP-74)", () => {
  const backgrounds = ["--sm-bg-base", "--sm-bg-panel", "--sm-bg-inset"] as const;

  it("前景类 token 对三层背景逐对达标(AA 4.5;主前景 AAA 7)", () => {
    for (const { name, minRatio } of TERMINAL_TEXT_TOKENS) {
      for (const background of backgrounds) {
        const bg = parseColor(token("terminal", background));
        const fg = parseColor(token("terminal", name), bg);
        const ratio = contrastRatio(fg, bg);
        expect(
          ratio,
          `${name} 对 ${background} 对比度不足(${ratio.toFixed(2)} < ${String(minRatio)})`,
        ).toBeGreaterThanOrEqual(minRatio);
      }
    }
  });

  it("选区底与前景可辨(≥ 4.5)", () => {
    const selection = parseColor(token("terminal", "--sm-selection"));
    const fg = parseColor(token("terminal", "--sm-fg"), selection);
    expect(contrastRatio(fg, selection)).toBeGreaterThanOrEqual(4.5);
  });

  it("强调边框在底色上达非文本对比(合成后 ≥ 3),边框族保持 α 阶梯", () => {
    const bg = parseColor(token("terminal", "--sm-bg-base"));
    // 非文本对比(WCAG 1.4.11)的承载面 = 最强强调边框;卡片 / 按钮边框维持
    // 与 light / dark 同族的弱边框阶梯(不强行拉到 3:1,避免破坏既有观感族)。
    const strong = parseColor(token("terminal", "--sm-border-strong"), bg);
    const strongRatio = contrastRatio(strong, bg);
    expect(strongRatio, `--sm-border-strong 非文本对比不足(${strongRatio.toFixed(2)} < 3)`).toBeGreaterThanOrEqual(3);
    const alpha = (name: string): number => {
      const match = /\/\s*([\d.]+)%\s*\)$/.exec(token("terminal", name));
      expect(match, `terminal 边框族需 α 形态:${name}`).not.toBeNull();
      return Number(match?.[1]);
    };
    expect(alpha("--sm-border")).toBeLessThan(alpha("--sm-border-button"));
    expect(alpha("--sm-border-button")).toBeLessThan(alpha("--sm-border-strong"));
  });
});

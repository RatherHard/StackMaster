/**
 * 主题设计 token 机制层(WP-53 / Q6 定案机制;WP-73 边界变更扩展为三预设)。
 *
 * ## 边界变更登记(WP-73;中期计划 §2.1 + D-MP-2)
 *
 * 本文件此前登记的头注释为「视觉风格零重设计——只做功能对比度所需的最小变量面
 * (8 个)」。中期计划 §2.1 已把该边界**显式修订**为本计划登记的边界变更:
 * 变量面扩展为**完整设计 token 集**,新增 `terminal` 预设(黑客氛围靠一致性 +
 * 克制达成,学习可读性优先级高于氛围)。本处在实现侧回填引用:
 *  - 变更来源:`docs/中期计划.md` §2.1「终端风格设计语言」+ 决策点 D-MP-2;
 *  - 冻结不变量:8 个功能对比度变量(`--sm-border*` / `--sm-divider*` /
 *    `--sm-badge-bg*` / `--sm-danger`)的 **light / dark 值逐值不变**
 *    (机检语料 = `test/theming/theme.test.ts` 的 `FROZEN_CONTRAST_VARIABLES`);
 *  - 契约面零改动:嵌入协议 `EMBED_THEMES`(冻结 V 规则)保持三值,
 *    `terminal` 由 `data-sm-theme` 锚的扩展值承载(D-MP-2 承载定案)。
 *
 * ## 机制(自定并登记)
 *
 * 1. **变量经 `data-sm-theme` 属性锚注入,走文档级样式表 + CSS 自定义属性
 *    继承**:自定义属性一旦落在某个元素上,便沿 composed 树继承穿透各级
 *    shadow DOM——因此把变量集挂在**携带锚属性的宿主元素**(嵌入形态 =
 *    `<pwn-memory-vm data-sm-theme="…">`,WP-52 已落该锚)上,vm-ui 全部组件
 *    在自身 shadow 内以 `var(--sm-*, <light 缺省>)` 消费即可,嵌套组件零重复
 *    定义、零 JS 解析。文档级样式表由 `ensureSmThemeStyles()` 幂等注入宿主
 *    文档(各组件 connectedCallback 调用;CSSStyleSheet 构造式表在 jsdom 不可
 *    用,故用 `<style>` 元素,id 幂等)。
 * 2. **锚值面 = 预设三值 + `auto`**:`data-sm-theme="light|dark|terminal"` 直接
 *    命中变量集;`"auto"` 的系统跟随由 CSS `@media (prefers-color-scheme: dark)`
 *    承担——vm-ui 侧 **零 JS 主题解析、零 matchMedia 订阅**(嵌入形态的 auto 已
 *    由 WP-52 `EmbedAppearanceController` 按插件自身 `prefers-color-scheme` 解析
 *    为二值 resolvedTheme 落锚,两条路径互不依赖;登记该边界)。
 * 3. **独立使用形态**:`<sm-workspace theme="light|dark|terminal|auto">` 属性为
 *    便捷注入面(组件把它转写为自身 `data-sm-theme`——最近锚优先,显式属性胜过
 *    祖先锚,确定性);未设属性且无祖先锚 = 变量缺省 = light 缺省值。
 * 4. **单一来源**:锚样式表文本由变量记录**同源生成**
 *    (`SM_THEME_ANCHOR_STYLESHEET_TEXT`),严禁手写重复 CSS 块——新增预设只
 *    扩变量记录(D-API-80 机制不变)。
 *
 * ## 变量面(21 个 = 8 冻结功能对比度 + 12 WP-73 设计 token + 1 M3 WP-80 深底精灵处理)
 *
 * ### 冻结族(light / dark 值逐值不变;功能对比度口径)
 *
 * 现行组件样式的颜色分两类:
 *  - **系统颜色关键词**(canvas / canvastext / graytext / highlight /
 *    accentcolor / mark / field / linktext + color-mix 组合):随
 *    `color-scheme` 自动适应明暗(嵌入形态由 WP-52 落内联 color-scheme);
 *  - **黑色半透明灰阶与 crimson 硬编码**:dark 下黑透明边框/分隔线不可辨、
 *    crimson 对比不足——这是功能对比度变量面的全部对象:
 *      `--sm-border`(卡片边框 15%)、`--sm-border-button`(按钮边框 20%)、
 *      `--sm-border-strong`(hover/强调边框 25%)、`--sm-divider`(行分隔
 *      10%)、`--sm-divider-faint`(表行分隔 8%)、`--sm-badge-bg`(徽标底
 *      8%)、`--sm-badge-bg-soft`(弱徽标底 4%)、`--sm-danger`(crimson 族:
 *      编译错误 / 断点红)。
 *  dark 值为功能对比度初值(白透明等可见度放大 + danger 提亮),真机 axe
 *  color-contrast 门禁归 WP-55(13.4 矩阵),数值按其报告修正。
 *
 * ### WP-73 设计 token(§2.1 清单)
 *
 * | 族 | token | light / dark | terminal |
 * |---|---|---|---|
 * | 背景三层 | `--sm-bg-base` / `--sm-bg-panel` / `--sm-bg-inset` | 系统色关键词 | 近黑三层(非纯黑) |
 * | 前景 | `--sm-fg` / `--sm-fg-dim` | canvastext / graytext | 磷光绿 / 暗绿 |
 * | 语义色 | `--sm-accent` / `--sm-warn` / `--sm-selection` / `--sm-focus-ring` | linktext / highlight / highlight 混色 / accentcolor | 青绿 / 琥珀 / 暗绿底 / 亮绿环 |
 * | 字体 | `--sm-font-mono` | 三预设同一栈(§2.1 定案) | 同左 |
 * | 效果 | `--sm-scanline-opacity` / `--sm-caret-blink` | 关闭(0 / 0s) | 0.06 / 1.1s |
 *
 * ### M3 WP-80 增量 token(1 个;深底画布精灵处理)
 *
 * | token | light | dark / terminal |
 * |---|---|---|
 * | `--sm-canvas-sprite-filter` | `none`(零视觉变化) | `brightness(1.6)` |
 *
 * 背景:M1 移交的遗留项 —— Blockly 画布上的垃圾桶 / 缩放图标取自
 * `media/sprites.svg` 的 `.trash{fill:#888}` / `.zoom{stroke:#888}`(整张精灵表经
 * `<image>` 引用),在暗色 / terminal 近黑画布上偏暗。**不能**用「按主题锚选择器
 * 改写」:画布样式表注入画布宿主所在根(生产形态 = 工作区 shadow 根),而主题锚
 * 在 shadow 树之外,树内样式表匹配不到树外祖先(M1 真机实测 `filter` 恒 `none`)。
 * **修法 = 变量承载**:`filter: var(--sm-canvas-sprite-filter, none)` 走**自定义属性
 * 继承**穿透 shadow 边界(与其余 20 个 token 同一机制),故无需任何祖先选择器。
 * `light` 取 `none` ⇒ 与 M1 前逐像素一致。
 *
 * **light / dark 值取系统颜色关键词**:与现行渲染同源(color-scheme 自适应),
 * 因此组件(归 WP-74)开始消费这些 token 时 light / dark 仍像素级零变化;
 * **terminal 值一律取具体色值**(不依赖系统色),使真机 axe 判定确定、跨平台一致。
 * terminal 色板为**保守可读初值**(前景对三层背景实测对比度 ≥ 8.1:1,
 * 机检于 `test/theming/theme-terminal.test.ts` 的 WCAG 公式面),**真机
 * axe color-contrast 门禁归 WP-74**,数值按其报告修正。
 *
 * 效果类 token 本包**只落变量**(组件内零动画);扫描线 / 光标动画的实装(WP-74)
 * 必须:纯装饰 `aria-hidden`、`pointer-events: none`、包在
 * `prefers-reduced-motion: no-preference` 内(或给 reduce 覆盖)、动画只用
 * transform / opacity;字号下限 13px 亦归 WP-74,本包不越界改组件字号。
 */

/** §2.1 定案等宽字体栈(全组件统一的目标栈;逐组件替换归 WP-74)。 */
export const SM_MONO_FONT_STACK =
  'ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, "Noto Sans Mono CJK SC", monospace';

/** 有变量记录的预设集(值域 = 预设集 + `auto`;`auto` 无独立变量集)。 */
export const SM_THEME_PRESET_VALUES = ["light", "dark", "terminal"] as const;

export type SmThemePreset = (typeof SM_THEME_PRESET_VALUES)[number];

/**
 * 主题变量清单(三预设;light = 现行硬编码 / 系统色关键词原样,dark = 功能对比度
 * 初值 + 系统色关键词,terminal = WP-73 终端预设具体色值)。
 * 三预设**键集与键序一致**(机检:`test/theming/theme.test.ts`)。
 */
export const SM_THEME_VARIABLES: Readonly<Record<SmThemePreset, Readonly<Record<string, string>>>> = {
  light: {
    // ── 冻结功能对比度族(light / dark 逐值不变)─────────────────────────
    "--sm-border": "rgb(0 0 0 / 15%)",
    "--sm-border-button": "rgb(0 0 0 / 20%)",
    "--sm-border-strong": "rgb(0 0 0 / 25%)",
    "--sm-divider": "rgb(0 0 0 / 10%)",
    "--sm-divider-faint": "rgb(0 0 0 / 8%)",
    "--sm-badge-bg": "rgb(0 0 0 / 8%)",
    "--sm-badge-bg-soft": "rgb(0 0 0 / 4%)",
    "--sm-danger": "crimson",
    // ── 背景三层(§2.1;现行渲染同源系统色)───────────────────────────────
    "--sm-bg-base": "canvas",
    "--sm-bg-panel": "color-mix(in srgb, canvas 92%, highlight 8%)",
    "--sm-bg-inset": "field",
    // ── 前景(现行 canvastext / graytext)────────────────────────────────
    "--sm-fg": "canvastext",
    "--sm-fg-dim": "graytext",
    // ── 语义色(地址/链接 = linktext;警告/暂停 = highlight;焦点环 = accentcolor)─
    "--sm-accent": "linktext",
    "--sm-warn": "highlight",
    "--sm-selection": "color-mix(in srgb, highlight 14%, transparent)",
    "--sm-focus-ring": "accentcolor",
    // ── 字体与效果(字体栈三预设同源;效果面 light / dark 关闭)────────────
    "--sm-font-mono": SM_MONO_FONT_STACK,
    "--sm-scanline-opacity": "0",
    "--sm-caret-blink": "0s",
    // ── 深底画布精灵处理(M3 WP-80;light = 原样,零视觉变化)──────────────
    "--sm-canvas-sprite-filter": "none",
  },
  dark: {
    "--sm-border": "rgb(255 255 255 / 22%)",
    "--sm-border-button": "rgb(255 255 255 / 30%)",
    "--sm-border-strong": "rgb(255 255 255 / 40%)",
    "--sm-divider": "rgb(255 255 255 / 14%)",
    "--sm-divider-faint": "rgb(255 255 255 / 10%)",
    "--sm-badge-bg": "rgb(255 255 255 / 14%)",
    "--sm-badge-bg-soft": "rgb(255 255 255 / 8%)",
    "--sm-danger": "#ff8a94",
    // 新 token 与 light 同值:系统颜色关键词随 color-scheme 自适应(dark 下
    // 由嵌入形态落的内联 color-scheme 承担),不重复表达同一语义。
    "--sm-bg-base": "canvas",
    "--sm-bg-panel": "color-mix(in srgb, canvas 92%, highlight 8%)",
    "--sm-bg-inset": "field",
    "--sm-fg": "canvastext",
    "--sm-fg-dim": "graytext",
    "--sm-accent": "linktext",
    "--sm-warn": "highlight",
    "--sm-selection": "color-mix(in srgb, highlight 14%, transparent)",
    "--sm-focus-ring": "accentcolor",
    "--sm-font-mono": SM_MONO_FONT_STACK,
    "--sm-scanline-opacity": "0",
    "--sm-caret-blink": "0s",
    // 深色画布精灵补偿(值与 dark 同;见文件末族表)。
    "--sm-canvas-sprite-filter": "brightness(1.6)",
  },
  terminal: {
    // 边框族 = 磷光绿 α 阶梯(底色近黑,α 比 dark 档提升一档以保持可见度)。
    "--sm-border": "rgb(125 255 156 / 28%)",
    "--sm-border-button": "rgb(125 255 156 / 34%)",
    "--sm-border-strong": "rgb(125 255 156 / 46%)",
    "--sm-divider": "rgb(125 255 156 / 16%)",
    "--sm-divider-faint": "rgb(125 255 156 / 12%)",
    "--sm-badge-bg": "rgb(125 255 156 / 18%)",
    "--sm-badge-bg-soft": "rgb(125 255 156 / 10%)",
    // 危险色复用 dark 档已达标值(减少真机 axe 校准面)。
    "--sm-danger": "#ff8a94",
    // 背景三层:近黑非纯黑(带极轻绿底,降低长时阅读疲劳)。
    "--sm-bg-base": "#0b0f0b",
    "--sm-bg-panel": "#101610",
    "--sm-bg-inset": "#070907",
    // 前景:磷光绿主前景 + 暗绿注释层。
    "--sm-fg": "#b9ffc4",
    "--sm-fg-dim": "#6dd47f",
    // 语义色:青绿 = 可点击地址;琥珀 = 断点 / 暂停 / 警告。
    "--sm-accent": "#4fe6c2",
    "--sm-warn": "#ffc857",
    "--sm-selection": "#1c3a25",
    "--sm-focus-ring": "#a9ffb8",
    "--sm-font-mono": SM_MONO_FONT_STACK,
    // 效果面:terminal 唯一开启(实装归 WP-74;0.06 为其登记上限)。
    "--sm-scanline-opacity": "0.06",
    "--sm-caret-blink": "1.1s",
    // 深色画布精灵补偿:Blockly 垃圾桶 / 缩放图标为 `#888` 灰(SVG 精灵经
    // `<image>` 引用),在近黑底色上偏暗 ⇒ 提亮(不改变色相;不做滤镜近似的
    // 磷光着色,避免不可验证的色彩数学)。
    "--sm-canvas-sprite-filter": "brightness(1.6)",
  },
};

/** 主题锚属性(嵌入协议语义;与 WP-52 落地面同词)。 */
export const SM_THEME_ATTRIBUTE = "data-sm-theme";

/**
 * `terminal` 锚值(D-MP-2 承载定案):**不经嵌入协议**传达,由插件侧 /
 * 集成方在宿主元素上直接写 `data-sm-theme="terminal"` 承载;插件宿主自身
 * **从不写该值**(它只落二值 resolvedTheme),故该值出现即等价于"外部显式锚"。
 */
export const SM_TERMINAL_THEME_VALUE: SmThemePreset = "terminal";

/** 主题值域(三预设 + `auto`;独立使用形态的 `theme` 属性同值域)。 */
export const SM_THEME_VALUES = [...SM_THEME_PRESET_VALUES, "auto"] as const;
export type SmThemeValue = (typeof SM_THEME_VALUES)[number];

/** 把变量记录序列化为 CSS 声明块体(单一来源:SM_THEME_VARIABLES)。 */
function declarations(variables: Readonly<Record<string, string>>): string {
  return Object.entries(variables)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
}

/**
 * 文档级锚样式表文本(预设三锚 + auto 的系统跟随 + terminal 扩展锚;
 * 单一来源生成——严禁手写重复 CSS 块)。
 */
export const SM_THEME_ANCHOR_STYLESHEET_TEXT: string = [
  `[${SM_THEME_ATTRIBUTE}="light"]{${declarations(SM_THEME_VARIABLES.light)}}`,
  `[${SM_THEME_ATTRIBUTE}="dark"]{${declarations(SM_THEME_VARIABLES.dark)}}`,
  `[${SM_THEME_ATTRIBUTE}="auto"]{${declarations(SM_THEME_VARIABLES.light)}}`,
  `@media (prefers-color-scheme: dark){[${SM_THEME_ATTRIBUTE}="auto"]{${declarations(SM_THEME_VARIABLES.dark)}}}`,
  `[${SM_THEME_ATTRIBUTE}="terminal"]{${declarations(SM_THEME_VARIABLES.terminal)}}`,
].join("\n");

const THEME_STYLE_ELEMENT_ID = "sm-theme-token-styles";

/**
 * 幂等注入文档级主题锚样式表(组件 connectedCallback 各自调用一次;
 * 已安装则零开销)。默认注入顶层文档——锚元素(插件宿主 / 独立包裹层)位于
 * 顶层文档 light DOM,文档级规则命中后变量经继承穿透 shadow 树。
 * WP-73 增量面:仅样式表**内容**扩展(terminal 锚),注入面结构零变化。
 */
export function ensureSmThemeStyles(doc: Document = document): void {
  if (doc.getElementById(THEME_STYLE_ELEMENT_ID) !== null) {
    return;
  }
  const style = doc.createElement("style");
  style.id = THEME_STYLE_ELEMENT_ID;
  style.textContent = SM_THEME_ANCHOR_STYLESHEET_TEXT;
  doc.head.append(style);
}

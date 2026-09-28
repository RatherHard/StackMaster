/**
 * 主题设计 token 机制层(WP-53 / Q6 定案机制;WP-73 扩展为三预设;
 * **2026-09-18 UI 改版 D-UI-6 收敛为终端单主题**)。
 *
 * ## 单主题收敛登记(2026-09-18;D-UI-6)
 *
 * `light` / `dark` / `auto` 三预设于 **2026-09-18 UI 改版(决策 D-UI-6)** 退役:
 *  - `SM_THEME_PRESET_VALUES` 由 `["light","dark","terminal"]` 收敛为 `["terminal"]`;
 *  - `SM_THEME_VARIABLES` 由**三套变量记录降为一套**(键集 = 原 `terminal` 的
 *    21 枚,键序不变);
 *  - `SM_THEME_VALUES` 的 `auto` 分支退场(系统跟随规则
 *    `@media (prefers-color-scheme: dark)` 一并退场);
 *  - 锚样式表由「预设三锚 + auto 两规则」改为**`:root` 级缺省 + 单一 terminal
 *    锚**(见下「锚策略」段)。
 *
 * 退役依据:`docs/develop/decisions-分发改版与UI重设计.md` D-UI-6;该裁定同时
 * 要求**保留全部 21 枚 token 名**(组件侧零改动面;token 名是唯一契约面)与
 * **保留 token 键集精确锁定断言**(`test/theming/theme-terminal.test.ts`)。
 * 历史口径(三预设扩展 = WP-73 / 中期计划 §2.1 + D-MP-2;WP-73 之前为「视觉
 * 风格零重设计、只做功能对比度所需的最小变量面(8 个)」)仅作沿革留档,不再有效。
 *
 * ## 锚策略(2026-09-18 单主题下的选择:**`:root` 级缺省**)
 *
 * `SM_THEME_ANCHOR_STYLESHEET_TEXT` 现在生成**两条同值规则**:
 *  1. `:root{…21 枚 token…}` —— **缺省即是终端**。自定义属性落在 `html` 上后
 *     沿树继承穿透各级 shadow DOM ⇒ **任何未设锚的元素(含组件 shadow 内部)
 *     都拿到终端变量**。这是「未设锚 = 终端」的**结构性保证**:它不依赖组件
 *     声明回退值,也不依赖任何组件挂载「消费」锚;
 *  2. `[data-sm-theme="terminal"]{…同值…}` —— 显式锚(独立形态
 *     `<sm-workspace theme="terminal">` / 外部集成方直接写入)保持可用且幂等;
 *     同时**兜住历史外部锚值**(`data-sm-theme="light|dark|auto"` 在三预设期由
 *     外部写入,垃圾值在单主题下落入自定义属性继承面)⇒ 显式锚值一律
 *     覆盖为终端值,不出现「坏锚改主题」的静默降级。
 * 两条规则值来自**同一份变量记录**(单一来源;严禁手写重复 CSS 块)。
 *
 * 为什么不选「只保留单锚」:那样未设锚元素的自定义属性为空,终端呈现就完全
 * 落回组件侧 `var(--sm-*, <回退>)` 的回退字面量 —— 等于把「单主题」的保证
 * 挂在 30 个文件的回退值副本上(与单一来源纪律冲突,且回退值漂移不会变红)。
 *
 * ## 回退值纪律(2026-09-18 起;D-UI-6 收敛实质 ⓑ)
 *
 * 本仓自 2026-09-18 起为**单主题**:`var(--sm-*, <回退>)` 的回退值**不得是浅色
 * 字面量**(系统颜色关键词 `canvas` / `canvastext` / `graytext` / `field` /
 * `highlight` / `linktext` / `accentcolor` 在近黑终端底色上会**静默回落成浅色**,
 * 是「看起来生效」的失败模式),**只允许终端等价或省略**。本仓现行处置 =
 * **省略回退值**(`var(--sm-fg)` 裸形态):`:root` 缺省恒有定义 ⇒ 回退不可达,
 * 且 21 处色值不产生第二份副本。唯一例外 = **等宽字体栈回退值**(组件侧逐处
 * 保留 `var(--sm-font-mono, <SM_MONO_FONT_STACK>)` 逐字形态,由
 * `test/theming/theme.test.ts` 的「字体栈回退值一致性」机检防副本漂移)。
 *
 * ## 机制(自定并登记)
 *
 * 1. **变量走文档级样式表 + CSS 自定义属性继承**:文档级样式表由
 *    `ensureSmThemeStyles()` 幂等注入宿主文档(各组件 connectedCallback 调用;
 *    CSSStyleSheet 构造式表在 jsdom 不可用,故用 `<style>` 元素,id 幂等)。
 *    `:root` 规则落在 `html` ⇒ 变量沿 composed 树继承穿透各级 shadow DOM,
 *    vm-ui 全部组件在自身 shadow 内以 `var(--sm-*)` 消费即可,嵌套组件零重复
 *    定义、零 JS 解析。
 * 2. **值域单一**:`data-sm-theme` 锚与 `sm-workspace` 的 `theme` 属性值域同为
 *    `["terminal"]`(无 `auto` 别名、无系统跟随分支)。
 * 3. **独立使用形态**:`<sm-workspace theme="terminal">` 便捷注入面(组件把它
 *    转写为自身 `data-sm-theme`);未设属性 = 不写锚 = `:root` 缺省 = 终端。
 * 4. **单一来源**:锚样式表文本由变量记录**同源生成**
 *    (`SM_THEME_ANCHOR_STYLESHEET_TEXT`),严禁手写重复 CSS 块。
 *
 * ## 变量面(21 枚 = 8 功能对比度 + 12 设计 token + 1 深底精灵处理)
 *
 * | 族 | token | 终端取值 |
 * |---|---|---|
 * | 功能对比度 | `--sm-border` / `--sm-border-button` / `--sm-border-strong` / `--sm-divider` / `--sm-divider-faint` / `--sm-badge-bg` / `--sm-badge-bg-soft` | 磷光绿 α 阶梯 |
 * | 危险色 | `--sm-danger` | `#ff8a94`(复用原 dark 档已达标值) |
 * | 背景三层 | `--sm-bg-base` / `--sm-bg-panel` / `--sm-bg-inset` | 近黑三层(非纯黑) |
 * | 前景 | `--sm-fg` / `--sm-fg-dim` | 磷光绿 / 暗绿 |
 * | 语义色 | `--sm-accent` / `--sm-warn` / `--sm-selection` / `--sm-focus-ring` | 青绿 / 琥珀 / 暗绿底 / 亮绿环 |
 * | 字体 | `--sm-font-mono` | 定案等宽栈 |
 * | 效果 | `--sm-scanline-opacity` / `--sm-caret-blink` | `0.06` / `1.1s`(**恒有定义**,不再有「light 下取 0」的口径) |
 * | 深底精灵 | `--sm-canvas-sprite-filter` | `brightness(1.6)`(**恒有定义**,不再有「light 下取 none」的口径) |
 *
 * 色值一律取**具体色值**(不依赖系统颜色关键词),使真机 axe 判定确定、跨平台
 * 一致;色板为**保守可读初值**(前景对三层背景实测对比度 ≥ 8.1:1,机检于
 * `test/theming/theme-terminal.test.ts` 的 WCAG 公式面),真机 axe color-contrast
 * 门禁归 E2E 面(13.4 矩阵),数值按其报告修正。
 *
 * 效果类 token 本文件**只落变量**;扫描线 / 光标动画的实装必须:纯装饰
 * `aria-hidden`、`pointer-events: none`、包在 `prefers-reduced-motion: no-preference`
 * 内(或给 reduce 覆盖)、动画只用 transform / opacity。
 */

/** §2.1 定案等宽字体栈(全组件统一的目标栈)。 */
export const SM_MONO_FONT_STACK =
  'ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, "Noto Sans Mono CJK SC", monospace';

/**
 * 有变量记录的预设集(2026-09-18 单主题:**只有** `terminal`;无 `auto` 别名)。
 * 保留本常量 = 值域断言与三预设期已退役的嵌入协议 `EMBED_THEMES`(随 2026-09-19
 * WP-96 退役面物理删除)退场面的**显式收口点**(D-UI-6)。
 */
export const SM_THEME_PRESET_VALUES = ["terminal"] as const;

export type SmThemePreset = (typeof SM_THEME_PRESET_VALUES)[number];

/**
 * 主题变量清单(**单套**;2026-09-18 由三预设收敛,键集 = 原 `terminal` 21 枚,
 * 键序保持不变)。键集由 `test/theming/theme-terminal.test.ts` **精确锁定**
 * (新增 / 改名 token 必须同批更新该清单)。
 */
export const SM_THEME_VARIABLES: Readonly<Record<string, string>> = {
  // ── 功能对比度族(边框族 = 磷光绿 α 阶梯;底色近黑,α 按可见度取值)──────
  "--sm-border": "rgb(125 255 156 / 28%)",
  "--sm-border-button": "rgb(125 255 156 / 34%)",
  "--sm-border-strong": "rgb(125 255 156 / 46%)",
  "--sm-divider": "rgb(125 255 156 / 16%)",
  "--sm-divider-faint": "rgb(125 255 156 / 12%)",
  "--sm-badge-bg": "rgb(125 255 156 / 18%)",
  "--sm-badge-bg-soft": "rgb(125 255 156 / 10%)",
  // 危险色复用原 dark 档已达标值(减少真机 axe 校准面)。
  "--sm-danger": "#ff8a94",
  // ── 背景三层:近黑非纯黑(带极轻绿底,降低长时阅读疲劳)──────────────────
  "--sm-bg-base": "#0b0f0b",
  "--sm-bg-panel": "#101610",
  "--sm-bg-inset": "#070907",
  // ── 前景:磷光绿主前景 + 暗绿注释层 ────────────────────────────────────
  "--sm-fg": "#b9ffc4",
  "--sm-fg-dim": "#6dd47f",
  // ── 语义色:青绿 = 可点击地址;琥珀 = 断点 / 暂停 / 警告 ────────────────
  "--sm-accent": "#4fe6c2",
  "--sm-warn": "#ffc857",
  "--sm-selection": "#1c3a25",
  "--sm-focus-ring": "#a9ffb8",
  // ── 字体(单主题 = §2.1 定案等宽栈)──────────────────────────────────
  "--sm-font-mono": SM_MONO_FONT_STACK,
  // ── 效果面:单主题下恒开启(0.06 为其登记上限)────────────────────────
  "--sm-scanline-opacity": "0.06",
  "--sm-caret-blink": "1.1s",
  // ── 深底画布精灵处理:Blockly 垃圾桶 / 缩放图标为 `#888` 灰(SVG 精灵经
  //    `<image>` 引用),在近黑底色上偏暗 ⇒ 提亮(不改变色相;不做滤镜近似的
  //    磷光着色,避免不可验证的色彩数学)。单主题下恒有定义。
  "--sm-canvas-sprite-filter": "brightness(1.6)",
};

/** 主题锚属性(与 WP-52 落地面同词;单主题下显式锚与 `:root` 缺省同值)。 */
export const SM_THEME_ATTRIBUTE = "data-sm-theme";

/**
 * 主题锚值(单主题 = `terminal`;显式锚面由独立使用形态的 `theme` 属性 /
 * 外部集成方直接写入 `data-sm-theme="terminal"` 承载)。
 */
export const SM_TERMINAL_THEME_VALUE: SmThemePreset = "terminal";

/**
 * 主题值域(**单值**;`auto` 分支随 D-UI-6 退场,不留兼容别名)。
 */
export const SM_THEME_VALUES = [...SM_THEME_PRESET_VALUES] as const;
export type SmThemeValue = (typeof SM_THEME_VALUES)[number];

/** 把变量记录序列化为 CSS 声明块体(单一来源:SM_THEME_VARIABLES)。 */
function declarations(variables: Readonly<Record<string, string>>): string {
  return Object.entries(variables)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
}

/**
 * 文档级锚样式表文本(**`:root` 级缺省 + 单一 terminal 锚**;单一来源生成——
 * 严禁手写重复 CSS 块)。
 *
 * 规则顺序即级联顺序:`:root` 在前(缺省 = 终端),显式锚在后(同值覆盖,
 * 含兜住历史 `light|dark|auto` 坏锚)。详见文件头「锚策略」段。
 */
export const SM_THEME_ANCHOR_STYLESHEET_TEXT: string = [
  `:root{${declarations(SM_THEME_VARIABLES)}}`,
  `[${SM_THEME_ATTRIBUTE}="${SM_TERMINAL_THEME_VALUE}"]{${declarations(SM_THEME_VARIABLES)}}`,
].join("\n");

const THEME_STYLE_ELEMENT_ID = "sm-theme-token-styles";

/**
 * 幂等注入文档级主题样式表(组件 connectedCallback 各自调用一次;已安装则零
 * 开销)。默认注入顶层文档——`:root` 规则落在 `html`,变量经继承穿透 shadow 树,
 * 因此**未设锚的元素同样是终端**(单主题的结构性保证)。
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

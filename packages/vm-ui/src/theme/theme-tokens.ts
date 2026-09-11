/**
 * 主题设计 token 机制层(WP-53 / Q6 定案;视觉风格零重设计——只做功能对比度
 * 所需的最小变量面,以 axe 真机门禁为唯一口径,jsdom 层保结构断言)。
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
 * 2. **三值锚**:`data-sm-theme="light|dark"` 直接命中变量集;`"auto"` 的
 *    系统跟随由 CSS `@media (prefers-color-scheme: dark)` 承担——vm-ui 侧
 *    **零 JS 主题解析、零 matchMedia 订阅**(嵌入形态的 auto 已由 WP-52
 *    `EmbedAppearanceController` 按插件自身 `prefers-color-scheme` 解析为二值
 *    resolvedTheme 落锚,两条路径互不依赖;登记该边界)。
 * 3. **独立使用形态**:`<sm-workspace theme="light|dark|auto">` 属性为便捷
 *    注入面(组件把它转写为自身 `data-sm-theme`——最近锚优先,显式属性胜过
 *    祖先锚,确定性);未设属性且无祖先锚 = 变量缺省 = light 缺省值,既有
 *    单测与独立使用形态零变化。
 *
 * ## 变量面(8 个;light 值 = 现行硬编码值原样 → light 下像素级零变化)
 *
 * 现行组件样式的颜色分两类:
 *  - **系统颜色关键词**(canvas / canvastext / graytext / highlight /
 *    accentcolor / mark / field / linktext + color-mix 组合):随
 *    `color-scheme` 自动适应明暗(嵌入形态由 WP-52 落内联 color-scheme),
 *    **不入变量面**;
 *  - **黑色半透明灰阶与 crimson 硬编码**:dark 下黑透明边框/分隔线不可辨、
 *    crimson 对比不足——这是功能对比度变量面的全部对象:
 *      `--sm-border`(卡片边框 15%)、`--sm-border-button`(按钮边框 20%)、
 *      `--sm-border-strong`(hover/强调边框 25%)、`--sm-divider`(行分隔
 *      10%)、`--sm-divider-faint`(表行分隔 8%)、`--sm-badge-bg`(徽标底
 *      8%)、`--sm-badge-bg-soft`(弱徽标底 4%)、`--sm-danger`(crimson 族:
 *      编译错误 / 断点红)。
 *
 * dark 值为功能对比度初值(白透明等可见度放大 + danger 提亮),真机 axe
 * color-contrast 门禁归 WP-55(13.4 矩阵),数值按其报告修正。
 */

/** 主题变量清单(light = 现行硬编码值原样;dark = 功能对比度初值)。 */
export const SM_THEME_VARIABLES: Readonly<{
  light: Readonly<Record<string, string>>;
  dark: Readonly<Record<string, string>>;
}> = {
  light: {
    "--sm-border": "rgb(0 0 0 / 15%)",
    "--sm-border-button": "rgb(0 0 0 / 20%)",
    "--sm-border-strong": "rgb(0 0 0 / 25%)",
    "--sm-divider": "rgb(0 0 0 / 10%)",
    "--sm-divider-faint": "rgb(0 0 0 / 8%)",
    "--sm-badge-bg": "rgb(0 0 0 / 8%)",
    "--sm-badge-bg-soft": "rgb(0 0 0 / 4%)",
    "--sm-danger": "crimson",
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
  },
};

/** 主题锚属性(嵌入协议语义;与 WP-52 落地面同词)。 */
export const SM_THEME_ATTRIBUTE = "data-sm-theme";

/** 主题三值(独立使用形态的 `theme` 属性同值域;auto = 系统跟随)。 */
export const SM_THEME_VALUES = ["light", "dark", "auto"] as const;
export type SmThemeValue = (typeof SM_THEME_VALUES)[number];

/** 把变量记录序列化为 CSS 声明块体(单一来源:SM_THEME_VARIABLES)。 */
function declarations(variables: Readonly<Record<string, string>>): string {
  return Object.entries(variables)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
}

/** 文档级锚样式表文本(三值锚 + auto 的系统跟随;单一来源生成)。 */
export const SM_THEME_ANCHOR_STYLESHEET_TEXT: string = [
  `[${SM_THEME_ATTRIBUTE}="light"]{${declarations(SM_THEME_VARIABLES.light)}}`,
  `[${SM_THEME_ATTRIBUTE}="dark"]{${declarations(SM_THEME_VARIABLES.dark)}}`,
  `[${SM_THEME_ATTRIBUTE}="auto"]{${declarations(SM_THEME_VARIABLES.light)}}`,
  `@media (prefers-color-scheme: dark){[${SM_THEME_ATTRIBUTE}="auto"]{${declarations(SM_THEME_VARIABLES.dark)}}}`,
].join("\n");

const THEME_STYLE_ELEMENT_ID = "sm-theme-token-styles";

/**
 * 幂等注入文档级主题锚样式表(组件 connectedCallback 各自调用一次;
 * 已安装则零开销)。默认注入顶层文档——锚元素(插件宿主 / 独立包裹层)位于
 * 顶层文档 light DOM,文档级规则命中后变量经继承穿透 shadow 树。
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

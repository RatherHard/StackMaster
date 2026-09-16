/**
 * Payload 画布的 Blockly 主题接线(WP-74 前置修复:窗口常驻暴露的暗色对比度)。
 *
 * **缺陷事实(真机实测,chromium)**:
 * WP-71 让 payload 窗口常驻后,Blockly 轻 DOM 画布第一次进入 axe 暗色扫描面:
 * `.blocklyToolboxCategoryLabel` 前景 `#ffffff`、有效背景 `#dddddd`(Blockly
 * 工具箱默认浅底)= **1.35:1**(axe `color-contrast`,serious,4 节点);更糟的是
 * 该前景并非来自主题,而是 Blockly 自带样式表的字面量声明。
 *
 * **根因(两条,均与主题脱钩)**:
 *  1. 工具箱容器背景 = Blockly 自带样式表的浅色字面量,不随 StackMaster 主题;
 *  2. `.blocklyToolboxCategoryLabel { color: #fff }` 是**声明**在标签自身的样式表
 *     规则 —— 声明强于继承,故「给容器挂前景色」不能改写它,只能以同根样式表
 *     + 更高特异性改写。
 *
 * **修法(单一色源 = WP-73 主题 token)**:
 *  - 承载背景/前景的 Blockly 组件样式经**官方主题 API**(`Blockly.Theme
 *    .defineTheme` 的 `componentStyles`)映射到 `var(--sm-*)` —— Blockly 以
 *    `element.style.setProperty(prop, value)` 落地,内联层 + `var()` 引用使
 *    **token 换档(light / dark / terminal)即时生效**,无需重新 inject;
 *  - 只有「类目标签前景」一处无法用主题 API 覆盖(`color` 的 CSS 字面量声明),
 *    以注入到**画布宿主所在根**的样式表按更高特异性改写(Blockly 自身也把它的
 *    样式表注入同一根,故作用域与级联层级一致);
 *  - 组件内**零色值复制**:全部值都是 `var(--sm-*)` 引用(缺 token 时回落到
 *    系统色关键词,与 WP-73 light / dark 同源口径一致)。
 *
 * 注:未映射的组件样式(`cursorColour` / `markerColour` / `insertionMarkerColour`
 * / `*Opacity`)保持 Blockly 默认 —— 它们经 `getComponentStyle` 读入**渲染器常量**
 * 并写成 SVG **属性**(属性不解析 `var()`),映射会静默失效,故不越界改写。
 */
import * as Blockly from "blockly";

/** 画布宿主类名(组件 render 落下的 light DOM 锚;样式作用域唯一依据)。 */
export const PAYLOAD_CANVAS_HOST_CLASS = "payload-canvas-host";

/** 注入样式表元素 id(幂等锚;与 `ensureSmThemeStyles` 同纪律:根级单例)。 */
export const PAYLOAD_CANVAS_STYLE_ID = "sm-payload-canvas-style";

/** 主题注册名(Blockly 主题注册表键;同名重复登记 = 覆盖)。 */
export const PAYLOAD_BLOCKLY_THEME_NAME = "stackmaster-payload";

/**
 * Blockly 组件样式 → 主题 token 映射(单一色源;逐值均为 `var(--sm-*)` 引用)。
 *  - 工具箱 = 承载类目文本的面 → `--sm-bg-panel` / `--sm-fg`;
 *  - 飞出(积木托盘)= `--sm-bg-inset`(比面板更深一层,与右栏分区层级一致);
 *  - 画布底 = `--sm-bg-base`(网格关闭时由 Blockly 直接落地;开启时由同根
 *    样式表落地 `.blocklySvg`,见 `PAYLOAD_CANVAS_CSS`);
 *  - 滚动条 = `--sm-fg-dim`(暗色下不至于消失在深底里)。
 */
export const PAYLOAD_BLOCKLY_COMPONENT_STYLES: Blockly.Theme.ComponentStyle = {
  workspaceBackgroundColour: "var(--sm-bg-base, canvas)",
  toolboxBackgroundColour: "var(--sm-bg-panel, canvas)",
  toolboxForegroundColour: "var(--sm-fg, canvastext)",
  flyoutBackgroundColour: "var(--sm-bg-inset, field)",
  flyoutForegroundColour: "var(--sm-fg, canvastext)",
  scrollbarColour: "var(--sm-fg-dim, graytext)",
};

/**
 * 画布内部样式表(注入到画布宿主所在的根;覆盖 Blockly 自带 CSS 的字面色值)。
 * 逐条理由:
 *  - `.blocklySvg` 背景 = Blockly 自带 CSS 的字面 `#fff`(网格开启时
 *    `workspaceBackgroundColour` 落在网格图案之外的路径,故此处落地画布底);
 *  - `.blocklyToolboxCategoryLabel` 前景 = Blockly 自带 CSS 的字面 `#fff`
 *    (标签**声明**色,继承不能覆盖)⇒ 本包唯一必须的 CSS 改写;
 *  - `.blocklyToolboxCategory` 的选中/悬停由 Blockly 以半透明覆盖表达
 *    (`rgba(255,255,255,.2)`),在深底上仍可见,不改写。
 *
 * **未覆盖(真机取证后主动放弃,登记为遗留)**:
 *  - 垃圾桶 / 缩放为**光栅精灵**(`.blocklyTrash` 用 `<image>` 引 sprites),
 *    深底上需要 `filter: invert(1)` 一类补偿;但本样式表所在根 = 画布宿主的
 *    shadow 根,而主题锚 `data-sm-theme` 落在 shadow 树**之外**的宿主元素
 *    (`pwn-memory-vm`)—— shadow 树内的样式表不能匹配树外祖先,`[data-sm-theme
 *    ="dark"] … .blocklyTrash` 实测不命中(真机 `getComputedStyle(...).filter`
 *    恒为 `none`);CSS 亦无「按继承的 `color-scheme` 取 `filter` 值」的手段
 *    (`light-dark()` 只作用于颜色值)。故不写不命中的死规则,遗留见报告。
 */
export const PAYLOAD_CANVAS_CSS = `
.${PAYLOAD_CANVAS_HOST_CLASS} {
  background: var(--sm-bg-base, canvas);
}

.${PAYLOAD_CANVAS_HOST_CLASS} .blocklySvg {
  background-color: var(--sm-bg-base, canvas);
}

.${PAYLOAD_CANVAS_HOST_CLASS} .blocklyToolboxCategoryLabel {
  color: var(--sm-fg, canvastext);
}
`;

/**
 * 画布主题(Classic 为基,只覆盖上表六项;每进程单例 —— 主题注册表按名覆盖,
 * 重复 `defineTheme` 无收益)。
 */
export const PAYLOAD_BLOCKLY_THEME: Blockly.Theme = Blockly.Theme.defineTheme(
  PAYLOAD_BLOCKLY_THEME_NAME,
  {
    // ITheme.name 为类型面必填(Blockly 运行时以 defineTheme 首参为准并覆盖,
    // 见 defineTheme 实现:`c.name = a`);此处与注册名保持同源。
    name: PAYLOAD_BLOCKLY_THEME_NAME,
    base: Blockly.Themes.Classic,
    componentStyles: { ...PAYLOAD_BLOCKLY_COMPONENT_STYLES },
  },
);

/**
 * 确保画布样式表在场(幂等;注入画布宿主所在的根 —— shadow root 内嵌形态与
 * 文档形态同一条路径,类名作用域使其对宿主页面零影响)。
 */
export function ensurePayloadCanvasStyles(host: HTMLElement): void {
  const root: Node = host.getRootNode();
  if (root instanceof ShadowRoot) {
    if (root.querySelector(`#${PAYLOAD_CANVAS_STYLE_ID}`) !== null) {
      return;
    }
    const style = (root.ownerDocument ?? document).createElement("style");
    style.id = PAYLOAD_CANVAS_STYLE_ID;
    style.textContent = PAYLOAD_CANVAS_CSS;
    root.append(style);
    return;
  }
  const doc = root instanceof Document ? root : host.ownerDocument;
  if (doc.head === null || doc.getElementById(PAYLOAD_CANVAS_STYLE_ID) !== null) {
    return;
  }
  const style = doc.createElement("style");
  style.id = PAYLOAD_CANVAS_STYLE_ID;
  style.textContent = PAYLOAD_CANVAS_CSS;
  doc.head.append(style);
}

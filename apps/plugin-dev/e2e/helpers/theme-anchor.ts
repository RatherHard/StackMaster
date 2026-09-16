/**
 * WP-74 主题承载帮手:terminal 预设的三条真机承载路径。
 *
 * ## 为什么 terminal 必须由测试侧专门落锚
 *
 * 嵌入协议 `EMBED_THEMES` 是**冻结值域**(light / dark / auto,D-MP-2 / E-3),
 * 宿主控制消息 `theme_changed` 的载荷按该值域校验 ⇒ **terminal 不经协议传达**,
 * 而由集成方在宿主元素上直接写 `data-sm-theme="terminal"`(锚的扩展值)承载。
 * 因此真机门禁要覆盖 terminal,必须主动落锚;宿主模拟页的主题选择器只有
 * light / dark / auto 三项(它走协议),不承担该职责。
 *
 * ## 三条承载路径(三条都真机验证)
 *
 * 1. **插件文档页挂载前预置**(= 正式集成形态):页面 HTML 自带锚,
 *    `pwn-memory-vm` 在 connectedCallback 判定该值为外部显式锚 → 保留锚 +
 *    落 `color-scheme: dark`(web-component `#applyAppearanceToHost`),
 *    宿主 `theme_changed` 亦不夺锚。E2E 经
 *    `host-mock/plugin-site-server.mjs` 的 `/axe-terminal.html` 变体路由承载
 *    (与正式页同构,仅多一个主题锚 attribute)。
 * 2. **运行期外部锚写入**(插件已挂载后由集成方设置):走 web-component 的
 *    MutationObserver(`#observeAnchor`)路径,锚变更即生效、无需等 `theme_changed`。
 * 3. **独立使用形态**:工作区宿主 `sm-workspace` 的 `theme` 属性 → 组件转写为
 *    自身 `data-sm-theme`(theme-tokens §机制 3「最近锚优先」;plugin-dev 壳面
 *    无主题机制,由其消费)。
 *
 * 三条路径的期望结果一致:文档级样式表 `[data-sm-theme="terminal"]{…}`
 * (由 vm-ui `SM_THEME_ANCHOR_STYLESHEET_TEXT` 单源生成)命中锚元素,变量经
 * 继承穿透各级 shadow 树,组件零 JS 参与。
 *
 * 本文件只做**承载与抽样**(读计算值),不含任何主题实现;token 期望值的唯一
 * 来源是 `packages/vm-ui/src/theme/theme-tokens.ts` 的 terminal 记录(此处为
 * 只读抽样锚,值改动时本表随之更新——两处不一致即门禁红灯的意义所在)。
 */
import { expect, type Frame, type Locator, type Page } from "@playwright/test";

/** 主题锚属性(vm-ui `SM_THEME_ATTRIBUTE` 同词;嵌入协议不承载 terminal 值)。 */
export const THEME_ANCHOR_ATTRIBUTE = "data-sm-theme";

/** terminal 锚值(vm-ui `SM_TERMINAL_THEME_VALUE`;嵌入协议冻结值域之外)。 */
export const TERMINAL_THEME_VALUE = "terminal";

/** 插件宿主元素(嵌入形态的锚承载元素;`packages/web-component` 的 `<pwn-memory-vm>`)。 */
export const PLUGIN_HOST_SELECTOR = "pwn-memory-vm";

/** 工作区宿主元素(独立使用形态的锚承载元素;`theme` 属性转写面)。 */
export const WORKSPACE_SELECTOR = "sm-workspace";

/**
 * terminal 锚预置的插件文档页(挂载前承载形态;plugin-site-server 变体路由)。
 * 与 `/axe.html` 同构,仅多 `data-sm-theme="terminal"`。
 */
export const PLUGIN_TERMINAL_URL = "http://localhost:5174/axe-terminal.html";

/**
 * terminal token 抽样锚(只读抽样,证明锚真的级联生效 —— 只看 attribute 在场
 * 不足以证明预设生效):
 *  - `--sm-bg-base` = 背景三层之首(terminal 具体色值,非系统色关键词);
 *  - `--sm-scanline-opacity` = 效果面(terminal 唯一开启的预设);
 *  - `--sm-caret-blink` = 光标闪烁周期(同上)。
 */
export const TERMINAL_TOKEN_PROBES = {
  "--sm-bg-base": "#0b0f0b",
  "--sm-scanline-opacity": "0.06",
  "--sm-caret-blink": "1.1s",
} as const;

/** 抽样读取元素上 CSS 自定义属性的计算值(trim;未定义返回空串)。 */
export async function readThemeTokens(
  target: Locator,
  names: readonly string[] = Object.keys(TERMINAL_TOKEN_PROBES),
): Promise<Record<string, string>> {
  return target.evaluate((element, requested) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(
      requested.map((name) => [name, style.getPropertyValue(name).trim()]),
    );
  }, Array.from(names));
}

/** 断言锚已级联到 terminal 预设:抽样 token 计算值与 terminal 记录逐值一致。 */
export async function expectTerminalTokensActive(target: Locator): Promise<void> {
  const tokens = await readThemeTokens(target);
  for (const [name, expected] of Object.entries(TERMINAL_TOKEN_PROBES)) {
    expect(
      tokens[name],
      `${name} 未取到 terminal 预设值(期望 ${expected},实得 ${tokens[name] ?? ""})——锚在场但变量未级联`,
    ).toBe(expected);
  }
}

/**
 * 承载路径 2:运行期外部锚写入(插件宿主元素)。
 *
 * 降级形态 / 已挂载插件面的探针都走这条;落锚后锚变更观察立即生效,无需重载。
 */
export async function setTerminalAnchorOnPluginHost(frame: Frame): Promise<void> {
  await frame.evaluate((contract) => {
    const host = document.querySelector(contract.hostSelector);
    if (host === null) {
      throw new Error(`插件宿主元素 ${contract.hostSelector} 不在场,无法写入 terminal 锚`);
    }
    host.setAttribute(contract.attribute, contract.value);
  }, {
    hostSelector: PLUGIN_HOST_SELECTOR,
    attribute: THEME_ANCHOR_ATTRIBUTE,
    value: TERMINAL_THEME_VALUE,
  });
}

/**
 * 承载路径 3:独立使用形态(工作区 `theme` 属性 → 组件转写自身锚)。
 *
 * 壳面(plugin-dev 开发宿主)无嵌入外观机制,terminal 只能走该路径;组件按
 * 「最近锚优先」把它转写为自身 `data-sm-theme`,故断言用自动重试的
 * `toHaveAttribute`(转写发生在组件更新周期内)。
 */
export async function applyTerminalThemeOnWorkspace(page: Page): Promise<void> {
  await page
    .locator(WORKSPACE_SELECTOR)
    .first()
    .evaluate((element, value) => {
      element.setAttribute("theme", value);
    }, TERMINAL_THEME_VALUE);
}

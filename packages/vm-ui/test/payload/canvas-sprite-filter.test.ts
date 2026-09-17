/**
 * M3 WP-80 深底画布精灵处理(主题 token 承载)测试。
 *
 * 背景(M1 移交遗留):Blockly 画布的垃圾桶 / 缩放图标取自 `media/sprites.svg`
 * (`.trash{fill:#888}` / `.zoom{stroke:#888}`),在暗色 / terminal 近黑画布上偏暗;
 * 补偿**不能**用「按主题锚改写选择器」—— 画布样式表注入画布宿主所在根(生产形态 =
 * 工作区 shadow 根),主题锚在 shadow 树之外,树内样式表匹配不到树外祖先。
 *
 * 本测试固定修法的三条不变量:
 *  1. 样式表以 `var(--sm-canvas-sprite-filter, none)` 承载滤镜(自定义属性继承
 *     穿透 shadow 边界 ⇒ 无需祖先选择器);
 *  2. 样式表内**不出现主题锚选择器**(`[data-sm-theme…]`)—— 死规则不得回潮;
 *  3. 三预设键集齐备(light `none` = 零视觉变化)。
 */
import { describe, expect, it } from "vitest";

import { PAYLOAD_CANVAS_CSS } from "../../src/payload/blockly-theme.js";
import { SM_THEME_PRESET_VALUES, SM_THEME_VARIABLES } from "../../src/theme/theme-tokens.js";

describe("深底画布精灵处理(WP-80;token 承载而非锚选择器)", () => {
  it("画布样式表把垃圾桶 / 缩放滤镜绑定到主题 token(单一色源)", () => {
    expect(PAYLOAD_CANVAS_CSS).toContain(".blocklyTrash");
    expect(PAYLOAD_CANVAS_CSS).toContain(".blocklyZoom");
    expect(PAYLOAD_CANVAS_CSS).toContain("filter: var(--sm-canvas-sprite-filter, none)");
  });

  it("画布样式表不含主题锚选择器(树内样式表匹配不到树外祖先 = 死规则)", () => {
    expect(PAYLOAD_CANVAS_CSS).not.toContain("data-sm-theme");
    expect(PAYLOAD_CANVAS_CSS).not.toContain(":host(");
  });

  it("三预设均声明该 token;light 取 none(light / dark 像素级零变化前提)", () => {
    for (const preset of SM_THEME_PRESET_VALUES) {
      expect(SM_THEME_VARIABLES[preset]["--sm-canvas-sprite-filter"]).toBeTypeOf("string");
    }
    expect(SM_THEME_VARIABLES.light["--sm-canvas-sprite-filter"]).toBe("none");
  });
});

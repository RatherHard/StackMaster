/**
 * 外观状态控制器单测(协议三值状态保持 / 单主题落地值 / 语言内置默认;
 * WP-53 接线点的行为锚)。
 *
 * **2026-09-18 D-UI-6 单主题收敛**:`resolvedTheme` 恒 `"dark"`,不再读系统
 * `prefers-color-scheme`;原「auto 跟随系统切换 → resolved 翻转 + 事件」
 * 用例按其退役逐条重写(下 `describe` 第二段),不是删除断言面。
 */
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EMBED_LANGUAGE,
  DEFAULT_EMBED_THEME,
  EmbedAppearanceController,
} from "../../src/plugin/appearance.js";

describe("EmbedAppearanceController(WP-52 内置默认 + WP-53 接线点)", () => {
  it("内置默认:协议默认 theme=light(状态面)+ 单主题落地值 dark + zh-CN 语言", () => {
    const controller = new EmbedAppearanceController({ matchMedia: () => null });
    // theme 仍是协议默认值「light」(值域与默认值随协议不变,WP-96 退役);
    // resolvedTheme 是**落地值**,单主题下恒 dark。
    expect(controller.snapshot).toEqual({ theme: "light", resolvedTheme: "dark", language: "zh-CN" });
    expect(DEFAULT_EMBED_THEME).toBe("light");
    expect(DEFAULT_EMBED_LANGUAGE).toBe("zh-CN");
    controller.dispose();
  });

  it("apply 幂等接线:ready.config 与 *_changed 消费同一入口;三值状态保持", () => {
    const controller = new EmbedAppearanceController({ matchMedia: () => null });
    expect(controller.apply({ theme: "dark", language: "en-US" })).toBe(true);
    // 协议 theme 值被状态面保持,但不驱动落地值(恒 dark)。
    expect(controller.snapshot).toEqual({ theme: "dark", resolvedTheme: "dark", language: "en-US" });
    // 同值重放(ready 幂等重放,§4.5):无变化、无事件。
    const listener = vi.fn();
    controller.onChange(listener);
    expect(controller.apply({ theme: "dark", language: "en-US" })).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    // auto 三值原样保持(resolved 恒 dark,不再解析系统偏好)。
    expect(controller.apply({ theme: "auto" })).toBe(true);
    expect(controller.theme).toBe("auto");
    expect(controller.snapshot).toEqual({ theme: "auto", resolvedTheme: "dark", language: "en-US" });
    controller.dispose();
  });

  it("非法取值按冻结 Schema 拒绝(保持原值;V-4 语义复核)", () => {
    const controller = new EmbedAppearanceController({ matchMedia: () => null });
    controller.apply({ theme: "dark", language: "zh-CN" });
    const before = controller.snapshot;
    expect(controller.apply({ theme: "blue" as never })).toBe(false);
    expect(controller.apply({ language: "not bcp47!!" })).toBe(false);
    expect(controller.snapshot).toEqual(before);
    controller.dispose();
  });
});

describe("EmbedAppearanceController:单主题落地值(D-UI-6 收敛;系统跟随退役)", () => {
  it("resolvedTheme 恒 dark:三值(含 auto)与系统偏好都不改变落地值", () => {
    const controller = new EmbedAppearanceController({ matchMedia: () => null });
    for (const theme of ["light", "dark", "auto"] as const) {
      controller.apply({ theme });
      expect(controller.snapshot.resolvedTheme, `theme=${theme} 的落地值`).toBe("dark");
    }
    controller.dispose();
  });

  it("prefers-color-scheme 完全不被消费:注入的 matchMedia 假体零调用(系统切换不发事件)", () => {
    // 单主题下 matchMedia 选项面保留而内部不读 ⇒ 任何注入的实现都不得被调用。
    const query = vi.fn(() => null);
    const controller = new EmbedAppearanceController({ matchMedia: query });
    const listener = vi.fn();
    controller.onChange(listener);
    expect(controller.apply({ theme: "auto" })).toBe(true);
    // 仅 theme 状态面变化触发一次事件;resolvedTheme 未变(恒 dark)。
    expect(listener).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("无 matchMedia 环境与有 matchMedia 环境结果逐字相同(确定性;无系统分支)", () => {
    const without = new EmbedAppearanceController({ matchMedia: () => null });
    const withMedia = new EmbedAppearanceController({
      matchMedia: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    without.apply({ theme: "auto" });
    withMedia.apply({ theme: "auto" });
    expect(without.snapshot).toEqual(withMedia.snapshot);
    expect(without.snapshot).toEqual({ theme: "auto", resolvedTheme: "dark", language: "zh-CN" });
    without.dispose();
    withMedia.dispose();
  });
});

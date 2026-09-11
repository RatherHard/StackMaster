/**
 * 外观状态控制器单测(主题三值保持 / auto 系统跟随 / 语言内置默认;
 * WP-53 接线点的行为锚)。
 */
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EMBED_LANGUAGE,
  DEFAULT_EMBED_THEME,
  EmbedAppearanceController,
  type MediaQueryLike,
} from "../../src/plugin/appearance.js";

/** 假 matchMedia:可手动翻转 matches 的事件假体。 */
function fakeMatchMedia(dark: boolean): { query: (q: string) => MediaQueryLike; setDark(v: boolean): void } {
  let isDark = dark;
  const listeners = new Set<() => void>();
  return {
    query: (q: string) => ({
      get matches() {
        void q;
        return isDark;
      },
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    }),
    setDark(v: boolean) {
      isDark = v;
      for (const listener of [...listeners]) listener();
    },
  };
}

describe("EmbedAppearanceController(WP-52 内置默认 + WP-53 接线点)", () => {
  it("内置默认:light 主题 + zh-CN 语言(§4.4 未授予降级的缺省形态)", () => {
    const controller = new EmbedAppearanceController({ matchMedia: () => null });
    expect(controller.snapshot).toEqual({ theme: "light", resolvedTheme: "light", language: "zh-CN" });
    expect(DEFAULT_EMBED_THEME).toBe("light");
    expect(DEFAULT_EMBED_LANGUAGE).toBe("zh-CN");
    controller.dispose();
  });

  it("apply 幂等接线:ready.config 与 *_changed 消费同一入口;三值状态保持", () => {
    const controller = new EmbedAppearanceController({ matchMedia: () => null });
    expect(controller.apply({ theme: "dark", language: "en-US" })).toBe(true);
    expect(controller.snapshot).toEqual({ theme: "dark", resolvedTheme: "dark", language: "en-US" });
    // 同值重放(ready 幂等重放,§4.5):无变化、无事件。
    const listener = vi.fn();
    controller.onChange(listener);
    expect(controller.apply({ theme: "dark", language: "en-US" })).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    // auto 三值原样保持(resolved 解析为系统值)。
    controller.apply({ theme: "auto" });
    expect(controller.theme).toBe("auto");
    expect(controller.snapshot.theme).toBe("auto");
    controller.dispose();
  });

  it("auto 主题跟随 prefers-color-scheme(系统切换 → resolved 翻转 + 事件)", () => {
    const media = fakeMatchMedia(false);
    const controller = new EmbedAppearanceController({ matchMedia: media.query });
    const snapshots: string[] = [];
    controller.onChange((s) => snapshots.push(s.resolvedTheme));
    controller.apply({ theme: "auto" });
    expect(controller.snapshot.resolvedTheme).toBe("light");
    media.setDark(true);
    expect(controller.snapshot.resolvedTheme).toBe("dark");
    // 两次事件:auto 应用时(三值变化)+ 系统切换时(resolved 翻转)。
    expect(snapshots).toEqual(["light", "dark"]);
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

  it("无 matchMedia 环境(auto → 恒 light;缺语言 → 默认,确定性)", () => {
    const controller = new EmbedAppearanceController({ matchMedia: () => null });
    controller.apply({ theme: "auto" });
    expect(controller.snapshot.resolvedTheme).toBe("light");
    controller.dispose();
  });
});

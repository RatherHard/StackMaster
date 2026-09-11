/**
 * 主题 / 语言状态管理接线点(WP-52 交付面;WP-53 在此接口上增量)。
 *
 * 本波次只做**机制管道与内置默认值**:zh-CN 默认语言、light 默认主题 +
 * 主题三值(light / dark / auto)状态保持;`auto` 解析 = 跟随插件自身
 * `prefers-color-scheme`(matchMedia 注入,测试确定性)。主题双套 CSS
 * 变量与 i18n 抽取面归 WP-53——本控制器对外暴露的就是 WP-53 的消费接口:
 *  - `apply({theme, language})`:ready.config 与 theme_changed /
 *    language_changed 消费后的**唯一**入口(幂等);
 *  - `onChange`:状态变化订阅(组件据此落 attribute / colorScheme);
 *  - 三值原样保持(theme 属性即宿主下发的三值),`resolvedTheme` 是解析后
 *    的二值(light / dark),供落 `data-sm-theme` 与 `color-scheme`。
 */
import { EmbedLanguageSchema, EmbedThemeSchema, type EmbedTheme } from "@stackmaster/protocol";

/** 内置默认主题(未授予 theme / ready 前的形态;§4.4 降级矩阵行 2)。 */
export const DEFAULT_EMBED_THEME: EmbedTheme = "light";

/** 内置默认语言(未授予 language / ready 前;§4.4 降级矩阵行 3)。 */
export const DEFAULT_EMBED_LANGUAGE = "zh-CN";

/** 解析后的外观快照(theme 为三值原样,resolvedTheme 为二值)。 */
export interface EmbedAppearanceSnapshot {
  readonly theme: EmbedTheme;
  readonly resolvedTheme: "light" | "dark";
  readonly language: string;
}

/** matchMedia 最小面(默认 window.matchMedia;测试注入假体)。 */
export interface MediaQueryLike {
  matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

export interface EmbedAppearanceOptions {
  readonly matchMedia?: (query: string) => MediaQueryLike | null;
}

export class EmbedAppearanceController {
  #theme: EmbedTheme = DEFAULT_EMBED_THEME;
  #language = DEFAULT_EMBED_LANGUAGE;
  #resolved: "light" | "dark" = "light";
  #listeners = new Set<(snapshot: EmbedAppearanceSnapshot) => void>();
  readonly #matchMedia: (query: string) => MediaQueryLike | null;
  #systemDarkQuery: MediaQueryLike | null = null;

  public constructor(options: EmbedAppearanceOptions = {}) {
    this.#matchMedia = options.matchMedia ?? defaultMatchMedia;
    this.#syncSystemQuery();
  }

  /** 当前快照(theme 三值保持;resolvedTheme 为 auto 的系统解析结果)。 */
  public get snapshot(): EmbedAppearanceSnapshot {
    return { theme: this.#theme, resolvedTheme: this.#resolved, language: this.#language };
  }

  /** 语言(BCP-47;内置默认 zh-CN)。 */
  public get language(): string {
    return this.#language;
  }

  /** 主题三值原样(light / dark / auto;三值状态保持)。 */
  public get theme(): EmbedTheme {
    return this.#theme;
  }

  /**
   * 统一接线点(幂等):ready.config 初始下发与 theme_changed /
   * language_changed 运行时切换都经此处应用。language 非法值按冻结 Schema
   * 校验拒绝(保持原值;宿主侧 EmbedLanguageSchema 已闸,本端复核 V-4 语义)。
   * 返回是否发生变化。
   */
  public apply(config: { theme?: EmbedTheme; language?: string }): boolean {
    let changed = false;
    if (config.theme !== undefined) {
      const parsed = EmbedThemeSchema.safeParse(config.theme);
      if (parsed.success && parsed.data !== this.#theme) {
        this.#theme = parsed.data;
        changed = true;
      }
    }
    if (config.language !== undefined) {
      const parsed = EmbedLanguageSchema.safeParse(config.language);
      if (parsed.success && parsed.data !== this.#language) {
        this.#language = parsed.data;
        changed = true;
      }
    }
    if (this.#resolveTheme() !== this.#resolved) {
      changed = true;
    }
    if (changed) {
      this.#emit();
    }
    return changed;
  }

  /** 状态变化订阅(返回退订;立即不分发——消费方首读 snapshot)。 */
  public onChange(listener: (snapshot: EmbedAppearanceSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** 释放(auto 系统跟随监听注销)。 */
  public dispose(): void {
    this.#listeners.clear();
    this.#detachSystemQuery();
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  #syncSystemQuery(): void {
    this.#detachSystemQuery();
    const query = this.#matchMedia("(prefers-color-scheme: dark)");
    if (query === null) {
      return;
    }
    this.#systemDarkQuery = query;
    query.addEventListener("change", this.#onSystemChange);
    if (this.#resolveTheme() !== this.#resolved) {
      this.#resolved = this.#resolveTheme();
      this.#emit();
    }
  }

  #detachSystemQuery(): void {
    this.#systemDarkQuery?.removeEventListener("change", this.#onSystemChange);
    this.#systemDarkQuery = null;
  }

  readonly #onSystemChange = (): void => {
    if (this.#resolveTheme() !== this.#resolved) {
      this.#resolved = this.#resolveTheme();
      this.#emit();
    }
  };

  /** 三值 → 二值解析(auto = 系统暗色偏好;查询不可用回落 light)。 */
  #resolveTheme(): "light" | "dark" {
    if (this.#theme === "auto") {
      return this.#systemDarkQuery?.matches === true ? "dark" : "light";
    }
    return this.#theme;
  }

  #emit(): void {
    this.#resolved = this.#resolveTheme();
    const snapshot = this.snapshot;
    for (const listener of [...this.#listeners]) {
      listener(snapshot);
    }
  }
}

/** 默认 matchMedia(无该全局的环境——如部分测试环境——返回 null = 恒 light)。 */
function defaultMatchMedia(query: string): MediaQueryLike | null {
  const bound = (globalThis as { matchMedia?: typeof window.matchMedia }).matchMedia;
  if (bound === undefined) {
    return null;
  }
  return bound(query) as MediaQueryLike;
}

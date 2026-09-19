/**
 * 主题 / 语言状态管理接线点(WP-52 交付面;WP-53 在此接口上增量;
 * **2026-09-18 UI 改版 D-UI-6 收敛为终端单主题**)。
 *
 * ## 单主题形态(2026-09-18;D-UI-6)
 *
 * `light` / `dark` / `auto` 三预设退役,本控制器只剩**一条解析分支**:
 *  - `resolvedTheme` **恒 `"dark"`**(终端属暗族,落 `color-scheme` 用),
 *      **不再读** `prefers-color-scheme`;原 `auto` 的系统跟随分支与
 *     `matchMedia` 监听整条退场;
 *  - `theme` 字段**仍按协议三值原样保持**(`EmbedTheme` 来自
 *     `@stackmaster/protocol`,**不改协议包**;`EMBED_THEMES` 的物理退场属
 *     WP-96)——**协议的 `theme` 值不再驱动视觉主题**,它只是状态面事实
 *     (宿主下发了什么),消费方(嵌入宿主元素落锚)一律写终端锚。
 *
 * ## `DEFAULT_EMBED_THEME` 保持 `"light"`(判断 + 理由)
 *
 * 该常量是**协议默认值**(§4.4「未授予 theme 时的降级形态」),不是主题选择:
 * 嵌入协议的 `theme` 值域未变(零改动,冻结面),默认值随协议取值域的第一个
 * 合法值 = `light`。改它会把本次纯 UI 收敛扩权到**嵌入协议 E2E 断言面**
 * (`apps/plugin-dev/e2e/embed-protocol.spec.ts` 的
 * `expect(appearance.theme).toBe("light")` 等),而嵌入协议面**整体退役**属
 * WP-96 ⇒ **本次保持 `"light"`,只登记「协议 theme 值不再驱动视觉主题」**。
 *
 * ## 退役面(整条删除,不留兼容别名)
 *
 * `auto` 系统跟随(`#syncSystemQuery` / `#detachSystemQuery` /
 * `#onSystemChange` / `#systemDarkQuery` / `defaultMatchMedia`)。理由:三值
 * 判别对象消失后,系统跟随的**唯一用途**是把 `auto` 解析成 light / dark,而
 * 解析结果在单主题下恒为终端 ⇒ 保留监听只会在系统主题变化时白跑一轮并在
 * 无变化时不发事件(净效果 = 死代码)。`EmbedAppearanceOptions.matchMedia`
 * **保留**(属性 / 选项面最小改动:删它会牵连两处测试接缝的构造签名),
 * 但**内部不再读取**(`void options.matchMedia` 显式登记)。
 *
 * ## 保留面
 *
 *  - `apply({theme, language})`:ready.config 与 theme_changed /
 *    language_changed 消费后的**唯一**入口(幂等);
 *  - `onChange`:状态变化订阅(组件据此落 attribute / colorScheme);
 *  - `EmbedLanguageSchema` 校验(V-4 语义)与 `EmbedThemeSchema` 形态校验
 *    (非法值拒绝、保持原值)逐字保留 —— 值域校验是协议面,不随视觉主题收敛。
 */
import { EmbedLanguageSchema, EmbedThemeSchema, type EmbedTheme } from "@stackmaster/protocol";

/** 内置默认主题(协议默认值;未授予 theme / ready 前的形态;§4.4 降级矩阵行 2)。 */
export const DEFAULT_EMBED_THEME: EmbedTheme = "light";

/** 内置默认语言(未授予 language / ready 前;§4.4 降级矩阵行 3)。 */
export const DEFAULT_EMBED_LANGUAGE = "zh-CN";

/**
 * 解析后的外观快照:`theme` 为协议三值原样(状态面事实),`resolvedTheme` 为
 * 落地用解析值 —— 单主题下恒 `"dark"`(不再随 `theme` 变化)。
 */
export interface EmbedAppearanceSnapshot {
  readonly theme: EmbedTheme;
  readonly resolvedTheme: "light" | "dark";
  readonly language: string;
}

/** matchMedia 最小面(单主题下不再消费;保留供既有测试接缝构造假体)。 */
export interface MediaQueryLike {
  matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

/** 控制器选项(单主题下 `matchMedia` 不再被读取;保留选项面 = 最小改动)。 */
export interface EmbedAppearanceOptions {
  readonly matchMedia?: (query: string) => MediaQueryLike | null;
}

export class EmbedAppearanceController {
  #theme: EmbedTheme = DEFAULT_EMBED_THEME;
  #language = DEFAULT_EMBED_LANGUAGE;
  #listeners = new Set<(snapshot: EmbedAppearanceSnapshot) => void>();

  public constructor(options: EmbedAppearanceOptions = {}) {
    // 单主题下不再消费系统跟随:显式登记(选项面保留,读面退场)。
    void options.matchMedia;
  }

  /** 当前快照(theme 三值保持;resolvedTheme 单主题下恒 dark)。 */
  public get snapshot(): EmbedAppearanceSnapshot {
    return { theme: this.#theme, resolvedTheme: this.#resolveTheme(), language: this.#language };
  }

  /** 语言(BCP-47;内置默认 zh-CN)。 */
  public get language(): string {
    return this.#language;
  }

  /** 主题三值原样(light / dark / auto;三值状态保持,不驱动视觉)。 */
  public get theme(): EmbedTheme {
    return this.#theme;
  }

  /**
   * 统一接线点(幂等):ready.config 初始下发与 theme_changed /
   * language_changed 运行时切换都经此处应用。language 非法值按冻结 Schema
   * 校验拒绝(保持原值;宿主侧 EmbedLanguageSchema 已闸,本端复核 V-4 语义)。
   * 返回是否发生变化。
   *
   * 单主题注记:`resolvedTheme` 不再随 `theme` 变化 ⇒ 仅 `theme` 取值变化本身
   * 即构成变化(状态面事实变化,消费方读 `theme` 时需事件)。
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

  /** 释放(单主题下已无系统跟随监听可注销;保留 API 面供消费方统一释放)。 */
  public dispose(): void {
    this.#listeners.clear();
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /**
   * 落地用解析值(**单主题 = 恒 `"dark"`**;D-UI-6)。
   *
   * 原实现 = 三值 → 二值(`auto` 读 `prefers-color-scheme`,查询不可用回落
   * light)。该分支的**唯一输入**(`theme === "auto"` 与系统偏好)在单主题下
   * 都不再影响视觉 ⇒ 收敛为单一分支并保留「恒 dark」的字面,供 `color-scheme`
   * 消费(终端主题属暗族)。
   */
  #resolveTheme(): "light" | "dark" {
    return "dark";
  }

  #emit(): void {
    const snapshot = this.snapshot;
    for (const listener of [...this.#listeners]) {
      listener(snapshot);
    }
  }
}

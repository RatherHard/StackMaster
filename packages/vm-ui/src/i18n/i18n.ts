/**
 * i18n 基础设施(WP-53 / Q5 定案)。
 *
 * 组成:
 *  - **消息目录**:`catalog-zh-CN.ts`(默认语言 = 现行文案原样,键集事实源)+
 *    `catalog-en.ts`(类型系统强制同键集);
 *  - **locale 状态**:模块级单例 store(iframe 内单工作区形态的 MVP 定案;
 *    独立多实例形态留演进),`setLocale` / `getLocale` / `onLocaleChange`——
 *    接口形态与 WP-52 `EmbedAppearanceController`(apply / onChange / snapshot)
 *    同词汇;
 *  - **BCP-47 匹配降级确定性**(`resolveLocale`):精确匹配(zh-CN / en,连字符
 *    与下划线、大小写归一)→ 主子标签前缀匹配(zh-TW → zh-CN、en-GB → en)→
 *    内置默认(zh-CN)。非法 / 未知标签确定性落到默认(嵌入协议侧 Schema 已拒
 *    非法语法,本层是最后一道确定性兜底);
 *  - **类型安全取词**:`t(key, params?)`——key 为目录键集类型,`{name}` 占位
 *    替换(缺参保留占位,便于定位);目录缺键(理论不可能,类型已闸)回落
 *    zh-CN,再回落键名(防御性);
 *  - **响应式 locale**:`LocaleController`(Lit ReactiveController)——组件
 *    订阅 locale 变化即重渲染,连接时消费 `data-sm-language` 锚;
 *  - **锚消费**:`consumeAnchoredLanguage(element)`——沿 composed 树上溯
 *    (自身 → 祖先 → shadow host 链)找最近 `[data-sm-language]`(嵌入协议
 *    语义,WP-52 落于宿主元素),解析后应用;并对锚元素挂共享 MutationObserver,
 *    运行中 `language_changed` 更新锚属性即生效(未授予 language 的插件宿主
 *    不设锚 → 无消费,保持内置默认,§4.4 降级矩阵第 3 行)。
 *
 * 定态语义(登记):已生成的状态字符串(payload 执行日志、跳转/检索状态行、
 * 时间线/编译标签)按**生成时刻 locale 固化**;语言切换重渲染刷新的是模板内
 * t() 求值面。积木画布文案按 Blockly 注册时刻 locale 固化(遗留登记见决策草稿)。
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";

import { en } from "./catalog-en.js";
import { zhCN, type SmMessageKey } from "./catalog-zh-CN.js";

export type { SmMessageKey };

/** 内置语言集(Q5 定案:MVP = 默认语言 + 1)。 */
export const SUPPORTED_LOCALES = ["zh-CN", "en"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** 内置默认语言(= 现行文案语言;未授予 language / 缺锚 / 未知标签的确定性落点)。 */
export const DEFAULT_LOCALE: SupportedLocale = "zh-CN";

/** 语言目录表(键集经类型系统对齐)。 */
const CATALOGS: Record<SupportedLocale, Readonly<Record<SmMessageKey, string>>> = {
  "zh-CN": zhCN,
  en,
};

// ── locale store(模块级单例)────────────────────────────────────────────────

let currentLocale: SupportedLocale = DEFAULT_LOCALE;
const listeners = new Set<(locale: SupportedLocale) => void>();

/**
 * BCP-47 匹配降级(确定性):精确匹配 → 主子标签前缀匹配 → 默认。
 * 未知 / 空 / null / undefined 一律落 `DEFAULT_LOCALE`,零歧义。
 */
export function resolveLocale(tag: string | null | undefined): SupportedLocale {
  if (tag === null || tag === undefined) {
    return DEFAULT_LOCALE;
  }
  const normalized = tag.trim().replaceAll("_", "-").toLowerCase();
  if (normalized === "") {
    return DEFAULT_LOCALE;
  }
  for (const locale of SUPPORTED_LOCALES) {
    if (normalized === locale.toLowerCase()) {
      return locale;
    }
  }
  const primary = normalized.split("-")[0] ?? "";
  for (const locale of SUPPORTED_LOCALES) {
    if (primary === locale.toLowerCase().split("-")[0]) {
      return locale;
    }
  }
  return DEFAULT_LOCALE;
}

/** 当前 locale。 */
export function getLocale(): SupportedLocale {
  return currentLocale;
}

/** 设置 locale(BCP-47 降级确定性解析;同值为幂等 no-op)。返回是否发生变化。 */
export function setLocale(tag: string): boolean {
  const resolved = resolveLocale(tag);
  if (resolved === currentLocale) {
    return false;
  }
  currentLocale = resolved;
  for (const listener of [...listeners]) {
    listener(currentLocale);
  }
  return true;
}

/** 订阅 locale 变化(返回退订函数;立即不分发——消费方首读 getLocale)。 */
export function onLocaleChange(listener: (locale: SupportedLocale) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ── 取词 ─────────────────────────────────────────────────────────────────────

/**
 * 类型安全取词:当前 locale 目录 → 缺键回落 zh-CN → 再回落键名(防御性,
 * 类型系统下不可达);`{name}` 占位按 params 替换,缺参保留占位。
 */
export function t(
  key: SmMessageKey,
  params?: Readonly<Record<string, string | number>>,
): string {
  const text = CATALOGS[currentLocale][key] ?? CATALOGS[DEFAULT_LOCALE][key] ?? String(key);
  if (params === undefined) {
    return text;
  }
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

// ── 响应式控制器与锚消费 ─────────────────────────────────────────────────────

/**
 * locale 响应式控制器:组件加一行 `readonly #i18n = new LocaleController(this)`
 * 即获得「连接时消费 data-sm-language 锚 + locale 变化即重渲染」。
 */
export class LocaleController implements ReactiveController {
  readonly #host: ReactiveControllerHost & Element;
  #unsubscribe: (() => void) | null = null;

  public constructor(host: ReactiveControllerHost & Element) {
    this.#host = host;
    host.addController(this);
  }

  /** 连接:消费最近语言锚 + 订阅 locale 变化(重渲染)。 */
  public hostConnected(): void {
    consumeAnchoredLanguage(this.#host);
    this.#unsubscribe ??= onLocaleChange(() => {
      this.#host.requestUpdate();
    });
  }

  /** 断连:退订(重连再订;store 常驻)。 */
  public hostDisconnected(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }
}

/**
 * 沿 composed 树上溯枚举(自身 → 父链 → shadow host → 父链 → …,到顶层文档
 * 为止)——同树内沿 parentElement,跨 shadow 边界经 getRootNode().host。
 */
function* composedAncestors(element: Element): Generator<Element> {
  let node: Element = element;
  while (true) {
    yield node;
    if (node.parentElement !== null) {
      node = node.parentElement;
      continue;
    }
    const root = node.getRootNode();
    if (root instanceof ShadowRoot) {
      node = root.host;
      continue;
    }
    break;
  }
}

/** 语言锚属性(嵌入协议语义;WP-52 落于插件宿主元素)。 */
export const SM_LANGUAGE_ATTRIBUTE = "data-sm-language";

/** 共享锚观察器(单锚:单工作区形态 MVP 定案;属性变化 → 重解析应用)。 */
let languageAnchorObserver: MutationObserver | null = null;
let observedAnchor: Element | null = null;

/**
 * 消费最近语言锚:找最近 `[data-sm-language]` 祖先(含自身),解析并应用;
 * 无锚(未授予 language 的宿主,§4.4)= 不消费,保持当前(内置默认)值。
 * 对锚挂共享 MutationObserver——运行中 `language_changed` 更新锚属性即生效。
 */
export function consumeAnchoredLanguage(element: Element): void {
  let anchor: Element | null = null;
  for (const candidate of composedAncestors(element)) {
    if (candidate.hasAttribute(SM_LANGUAGE_ATTRIBUTE)) {
      anchor = candidate;
      break;
    }
  }
  if (anchor === null) {
    return;
  }
  const value = anchor.getAttribute(SM_LANGUAGE_ATTRIBUTE);
  if (value !== null) {
    setLocale(value);
  }
  if (observedAnchor !== anchor) {
    languageAnchorObserver?.disconnect();
    languageAnchorObserver = new MutationObserver(() => {
      const next = anchor?.getAttribute(SM_LANGUAGE_ATTRIBUTE);
      if (next !== null && next !== undefined) {
        setLocale(next);
      }
    });
    languageAnchorObserver.observe(anchor, {
      attributes: true,
      attributeFilter: [SM_LANGUAGE_ATTRIBUTE],
    });
    observedAnchor = anchor;
  }
}

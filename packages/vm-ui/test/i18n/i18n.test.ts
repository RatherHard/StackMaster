/**
 * WP-53 i18n 基础设施测试:目录完整性(键集一致 / 参数占位符一致)、
 * BCP-47 匹配降级矩阵(精确 → 主子标签前缀 → 默认)、locale 响应式
 * (setLocale / onLocaleChange / 幂等)、t() 参数替换与缺参行为。
 */
import { afterEach, describe, expect, it } from "vitest";

import { en } from "../../src/i18n/catalog-en.js";
import { zhCN } from "../../src/i18n/catalog-zh-CN.js";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  getLocale,
  onLocaleChange,
  resolveLocale,
  setLocale,
  t,
} from "../../src/i18n/i18n.js";

afterEach(() => {
  // locale store 是模块级单例:逐用例复位,杜绝跨用例污染。
  setLocale(DEFAULT_LOCALE);
});

describe("i18n 目录完整性(Q5:zh-CN / en 键集一致,缺键红灯)", () => {
  it("en 与 zh-CN 键集完全一致(双向)", () => {
    const zhKeys = Object.keys(zhCN).sort();
    const enKeys = Object.keys(en).sort();
    expect(enKeys).toEqual(zhKeys);
  });

  it("全部键的两种语言值均为非空字符串", () => {
    for (const key of Object.keys(zhCN) as (keyof typeof zhCN)[]) {
      expect(typeof zhCN[key], `zh-CN 缺值:${key}`).toBe("string");
      expect(zhCN[key].length, `zh-CN 空值:${key}`).toBeGreaterThan(0);
      expect(typeof en[key], `en 缺值:${key}`).toBe("string");
      expect(en[key].length, `en 空值:${key}`).toBeGreaterThan(0);
    }
  });

  it("参数占位符集合在两种语言中一致({name} 同构)", () => {
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();
    for (const key of Object.keys(zhCN) as (keyof typeof zhCN)[]) {
      expect(placeholders(en[key]), `占位符漂移:${key}`).toEqual(placeholders(zhCN[key]));
    }
  });

  it("zh-CN 目录值 = 现行文案原样(关键锚逐字断言,防抽取改写)", () => {
    // 这些键与既有组件测试的文案断言共用锚;改写即 518 用例红灯。
    expect(zhCN["menu.whatifTitle"]).toBe("调试通过 ≠ 提交通过(裁决以提交为准)");
    expect(zhCN["ed.callStackTruncated"]).toBe("仅显示最内 64 帧");
    expect(zhCN["ed.diffUnknownBefore"]).toBe("前值不可知");
    expect(zhCN["ed.noTeachingNote"]).toBe("该错误暂无教学注解");
    expect(zhCN["reg.copied"]).toBe("已复制");
    expect(zhCN["reg.copyFallback"]).toBe("已就绪手动复制");
    expect(zhCN["ed.hintReveal"]).toBe("显示下一条提示");
    expect(zhCN["debug.pausedBreakpoint"]).toBe("命中断点,已暂停");
    expect(zhCN["common.noContentNote"]).toBe("该类型暂未提供内容");
  });

  it("内置语言集 = {zh-CN, en},默认 zh-CN(Q5 定案)", () => {
    expect([...SUPPORTED_LOCALES]).toEqual(["zh-CN", "en"]);
    expect(DEFAULT_LOCALE).toBe("zh-CN");
  });
});

describe("BCP-47 匹配降级确定性(精确 → 前缀 → 默认)", () => {
  it("精确匹配(含大小写与下划线归一)", () => {
    expect(resolveLocale("zh-CN")).toBe("zh-CN");
    expect(resolveLocale("zh-cn")).toBe("zh-CN");
    expect(resolveLocale("ZH_CN")).toBe("zh-CN");
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("en-US")).toBe("en");
  });

  it("主子标签前缀匹配(zh-TW → zh-CN、en-GB → en)", () => {
    expect(resolveLocale("zh-TW")).toBe("zh-CN");
    expect(resolveLocale("zh-Hant-TW")).toBe("zh-CN");
    expect(resolveLocale("en-GB")).toBe("en");
    expect(resolveLocale("en_GB-oed")).toBe("en");
  });

  it("未知 / 非法 / 空标签确定性落默认(zh-CN)", () => {
    expect(resolveLocale("fr")).toBe("zh-CN");
    expect(resolveLocale("de-AT")).toBe("zh-CN");
    expect(resolveLocale("xx-YY")).toBe("zh-CN");
    expect(resolveLocale("")).toBe("zh-CN");
    expect(resolveLocale("   ")).toBe("zh-CN");
    expect(resolveLocale(null)).toBe("zh-CN");
    expect(resolveLocale(undefined)).toBe("zh-CN");
  });
});

describe("locale store 响应式", () => {
  it("setLocale 切换 + onLocaleChange 分发;同值为幂等 no-op", () => {
    expect(getLocale()).toBe("zh-CN");
    const seen: string[] = [];
    const unsubscribe = onLocaleChange((locale) => seen.push(locale));

    expect(setLocale("en")).toBe(true);
    expect(getLocale()).toBe("en");
    expect(setLocale("en-US")).toBe(false); // en-US 解析为 en,同值幂等。
    expect(seen).toEqual(["en"]);

    unsubscribe();
    expect(setLocale("zh-CN")).toBe(true);
    expect(seen).toEqual(["en"]); // 退订后不再分发。
  });
});

describe("t() 类型安全取词", () => {
  it("zh-CN 缺省取词;参数替换;en 切换后取 en 值", () => {
    expect(t("common.jumpOk", { target: "0x00400000" })).toBe("已跳转到 0x00400000");
    setLocale("en");
    expect(t("common.jumpOk", { target: "0x00400000" })).toBe("Jumped to 0x00400000");
  });

  it("缺参保留占位(定位用);未知键回落链(防御性)", () => {
    expect(t("common.jumpOk")).toBe("已跳转到 {target}");
    // 缺键回落:类型系统下不可达,运行时兜底回落键名(以逃逸类型断言验证)。
    const missing = "no.such.key" as unknown as Parameters<typeof t>[0];
    expect(t(missing)).toBe("no.such.key");
  });
});

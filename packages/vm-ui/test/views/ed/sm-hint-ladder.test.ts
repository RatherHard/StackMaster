/**
 * <sm-hint-ladder> 组件测试(FE-ED-06):revealPolicy 两分支(on_request 逐级
 * 揭示按钮 / after_n_failures 计数自动解锁)、计数边界、防御性缺阈值、排序、
 * 空态。
 */
import { describe, expect, it } from "vitest";

import type { PublicHint } from "../../../src/ed/ed-types.js";

import { HINT_REVEAL_BUTTON_TEXT, SmHintLadder } from "../../../src/views/ed/sm-hint-ladder.js";

import "../../../src/views/ed/sm-hint-ladder.js";
import { queryAllShadow, queryShadow } from "./helpers.js";

function hint(overrides: Partial<PublicHint>): PublicHint {
  return { order: 1, revealPolicy: "on_request", hintText: "检查返回地址的写位置", ...overrides };
}

async function mounted(
  hints: readonly PublicHint[],
  failures = 0,
): Promise<SmHintLadder> {
  const element = document.createElement("sm-hint-ladder") as SmHintLadder;
  document.body.append(element);
  element.hints = hints;
  element.failures = failures;
  await element.updateComplete;
  return element;
}

describe("SmHintLadder on_request 逐级揭示(FE-ED-06)", () => {
  it("未揭示条目呈锁定态;'显示下一条提示'只挂最前未揭示条", async () => {
    const element = await mounted([
      hint({ order: 2, hintText: "第二条" }),
      hint({ order: 1, hintText: "第一条" }),
      hint({ order: 3, hintText: "第三条" }),
    ]);
    const items = queryAllShadow(element, "ol li");
    expect(items).toHaveLength(3);
    // 排序按 order 升序(输入乱序 → 重排为 1,2,3);锁定态不泄露提示文案。
    expect(items[0]?.textContent).toContain("提示 1(未揭示)");
    expect(items[0]?.textContent).not.toContain("第一条");
    expect(queryAllShadow(element, ".reveal-button")).toHaveLength(1);
    expect(items[0]?.querySelector(".reveal-button")).not.toBeNull();
    expect(items[1]?.querySelector(".reveal-button")).toBeNull();
    element.remove();
  });

  it("点击揭示 → 文案呈现;再点下一条逐级推进(不跳级)", async () => {
    const element = await mounted([hint({ order: 1, hintText: "第一条" }), hint({ order: 2, hintText: "第二条" })]);
    const firstButton = queryShadow<HTMLButtonElement>(element, ".reveal-button")!;
    expect(firstButton.textContent?.trim()).toBe(HINT_REVEAL_BUTTON_TEXT);
    firstButton.click();
    await element.updateComplete;
    expect(queryAllShadow(element, "ol li")[0]?.textContent).toContain("第一条");
    expect(queryAllShadow(element, "ol li")[0]?.querySelector(".reveal-button")).toBeNull();

    const secondButton = queryShadow<HTMLButtonElement>(element, ".reveal-button");
    expect(secondButton).not.toBeNull();
    secondButton!.click();
    await element.updateComplete;
    expect(queryAllShadow(element, "ol li")[1]?.textContent).toContain("第二条");
    expect(queryShadow(element, ".reveal-button")).toBeNull(); // 全部揭示 → 按钮消失
    element.remove();
  });

  it("全部揭示后按钮消失(无空转按钮)", async () => {
    const element = await mounted([hint({})]);
    queryShadow<HTMLButtonElement>(element, ".reveal-button")!.click();
    await element.updateComplete;
    expect(queryAllShadow(element, ".reveal-button")).toHaveLength(0);
    expect(queryAllShadow(element, "ol li")).toHaveLength(1);
    // 再次设置同一提示列表不复活按钮(揭示态保持在组件状态中)。
    element.hints = [...element.hints];
    await element.updateComplete;
    expect(queryAllShadow(element, ".reveal-button")).toHaveLength(0);
    element.remove();
  });
});

describe("SmHintLadder after_n_failures 计数自动揭示(FE-ED-06)", () => {
  it("未达标 → '再失败 N 次解锁'(N = threshold - failures)", async () => {
    const element = await mounted(
      [hint({ revealPolicy: "after_n_failures", failureThreshold: 3, hintText: "尝试 padding" })],
      1,
    );
    expect(queryShadow(element, ".locked")?.textContent).toContain("再失败 2 次解锁");
    expect(queryShadow(element, ".hint-text")).toBeNull();
    element.remove();
  });

  it("failures 边界:恰好达标 → 自动解锁;超过 → 同样解锁", async () => {
    const atThreshold = await mounted(
      [hint({ revealPolicy: "after_n_failures", failureThreshold: 3 })],
      3,
    );
    expect(queryShadow(atThreshold, ".hint-text")?.textContent).toContain("检查返回地址的写位置");
    atThreshold.remove();

    const beyond = await mounted(
      [hint({ revealPolicy: "after_n_failures", failureThreshold: 3 })],
      10,
    );
    expect(queryShadow(beyond, ".hint-text")).not.toBeNull();
    beyond.remove();
  });

  it("防御性:after_n_failures 缺 failureThreshold → 永不自动解锁(不伪造阈值)", async () => {
    const element = await mounted(
      [hint({ revealPolicy: "after_n_failures", failureThreshold: undefined })],
      99,
    );
    expect(queryShadow(element, ".locked")?.textContent).toContain("失败达标后解锁");
    expect(queryShadow(element, ".hint-text")).toBeNull();
    element.remove();
  });

  it("混合策略:on_request 揭示按钮与 after_n_failures 锁定并存互不干扰", async () => {
    const element = await mounted([
      hint({ order: 1, revealPolicy: "after_n_failures", failureThreshold: 2 }),
      hint({ order: 2 }),
    ], 0);
    expect(queryShadow(element, ".locked")?.textContent).toContain("再失败 2 次解锁");
    expect(queryShadow(element, ".reveal-button")?.textContent?.trim()).toBe(HINT_REVEAL_BUTTON_TEXT);
    element.remove();
  });
});

describe("SmHintLadder 空态", () => {
  it("无提示 → 空态说明", async () => {
    const element = await mounted([]);
    expect(queryShadow(element, "ol")).toBeNull();
    expect(queryShadow(element, "[role='status']")?.textContent).toContain("没有配置提示");
    element.remove();
  });
});

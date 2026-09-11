/**
 * <sm-call-stack> 组件测试(FE-ED-02):帧渲染(index/functionLabel/
 * returnAddressHex)、index 0 最内帧标注、截断明示(不渲染空白、不用 +N 计数)、
 * 空栈空态。
 */
import { describe, expect, it } from "vitest";

import type { PublicCallFrame } from "@stackmaster/protocol";

import { CALL_STACK_TRUNCATED_TEXT, SmCallStack } from "../../../src/views/ed/sm-call-stack.js";

import "../../../src/views/ed/sm-call-stack.js";
import { queryAllShadow, queryShadow } from "./helpers.js";

function frame(index: number, truncated?: true): PublicCallFrame {
  return {
    index,
    functionLabel: index === 0 ? "0x40A0(vulnerable)" : `func_${index}`,
    returnAddressHex: `0x${index.toString(16)}00`,
    ...(truncated === undefined ? {} : { truncated }),
  };
}

async function mounted(frames: readonly PublicCallFrame[]): Promise<SmCallStack> {
  const element = document.createElement("sm-call-stack") as SmCallStack;
  document.body.append(element);
  element.frames = frames;
  await element.updateComplete;
  return element;
}

describe("SmCallStack 调用栈渲染(FE-ED-02)", () => {
  it("渲染帧表:index / 函数标签 / 返回地址(0x 小写归一化)", async () => {
    const element = await mounted([frame(0), frame(1), frame(2)]);
    const rows = queryAllShadow(element, "tbody tr");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector(".index-cell")?.textContent).toContain("0");
    expect(rows[0]?.querySelector("td")?.textContent?.trim()).toContain("vulnerable");
    expect(rows[2]?.querySelector(".addr")?.textContent?.trim()).toBe("0x200");
    element.remove();
  });

  it("index 0 标注'最内帧(当前函数)';其余帧无标注", async () => {
    const element = await mounted([frame(0), frame(1)]);
    const rows = queryAllShadow(element, "tbody tr");
    expect(rows[0]?.querySelector(".innermost")?.textContent?.trim()).toBe("最内帧(当前函数)");
    expect(rows[1]?.querySelector(".innermost")).toBeNull();
    element.remove();
  });

  it("截断标记(last frame truncated)→ 明示'仅显示最内 64 帧',不渲染空白", async () => {
    const frames = Array.from({ length: 64 }, (_, index) =>
      frame(index, index === 63 ? true : undefined),
    );
    const element = await mounted(frames);
    const note = queryShadow(element, ".truncated-note");
    expect(note?.textContent?.trim()).toBe(CALL_STACK_TRUNCATED_TEXT);
    expect(queryAllShadow(element, "tbody tr")).toHaveLength(64);
    element.remove();
  });

  it("无截断标记 → 不呈现截断文案", async () => {
    const element = await mounted([frame(0), frame(1)]);
    expect(queryShadow(element, ".truncated-note")).toBeNull();
    element.remove();
  });

  it("空栈 → 空态明示,不渲染表格", async () => {
    const element = await mounted([]);
    expect(queryShadow(element, "table")).toBeNull();
    expect(queryShadow(element, "[role='status']")?.textContent).toContain("暂无调用帧");
    element.remove();
  });
});

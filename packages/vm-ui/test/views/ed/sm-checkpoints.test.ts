/**
 * <sm-checkpoints> 组件测试(FE-ED-05):列表呈现(标签/revision/checkpointId,
 * 按创建序)、create 派发与标签校验、checkout 两步确认、终态禁用、错误呈现、
 * 空态与未接线禁用。
 */
import { describe, expect, it, vi } from "vitest";

import type { ActionObject, CheckpointRef } from "@stackmaster/protocol";

import type { SmCheckpoints } from "../../../src/views/ed/sm-checkpoints.js";

import "../../../src/views/ed/sm-checkpoints.js";
import { queryAllShadow, queryShadow, setInputValue } from "./helpers.js";

function checkpointRef(overrides: Partial<CheckpointRef>): CheckpointRef {
  return { checkpointId: "cp-1", revision: 2, ...overrides };
}

async function mounted(
  checkpoints: readonly CheckpointRef[] = [],
  sendAction: ((action: ActionObject) => void) | null = vi.fn(),
  sessionTerminal = false,
): Promise<SmCheckpoints> {
  const element = document.createElement("sm-checkpoints") as SmCheckpoints;
  document.body.append(element);
  element.checkpoints = checkpoints;
  element.sendAction = sendAction;
  element.sessionTerminal = sessionTerminal;
  await element.updateComplete;
  return element;
}

describe("SmCheckpoints 列表(FE-ED-05)", () => {
  it("按创建序渲染 标签/revision/checkpointId 表", async () => {
    const element = await mounted([
      checkpointRef({ checkpointId: "cp-a", label: "存档一", revision: 2 }),
      checkpointRef({ checkpointId: "cp-b", revision: 5 }),
    ]);
    const rows = queryAllShadow(element, "tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector("td")?.textContent?.trim()).toBe("存档一");
    expect(rows[1]?.querySelector("td")?.textContent?.trim()).toBe("(无标签)");
    expect(rows[1]?.querySelectorAll("td.mono")[1]?.textContent).toContain("cp-b");
    element.remove();
  });

  it("空列表 → 空态,不渲染表格", async () => {
    const element = await mounted([]);
    expect(queryShadow(element, "table")).toBeNull();
    expect(queryShadow(element, "[role='status']")?.textContent).toContain("暂无 checkpoint");
    element.remove();
  });
});

describe("SmCheckpoints create(标签校验 + 派发)", () => {
  it("输入标签点击创建 → create_checkpoint(label);输入框清空", async () => {
    const sendAction = vi.fn();
    const element = await mounted([], sendAction);
    setInputValue(element, "input[type='text']", "覆盖前存档");
    await element.updateComplete;
    queryShadow<HTMLButtonElement>(element, ".create-row button")!.click();
    await element.updateComplete;
    expect(sendAction).toHaveBeenCalledTimes(1);
    expect(sendAction).toHaveBeenCalledWith({ type: "create_checkpoint", args: { label: "覆盖前存档" } });
    expect(queryShadow<HTMLInputElement>(element, "input[type='text']")!.value).toBe("");
    element.remove();
  });

  it("空标签(空白)→ 无标签 args 派发", async () => {
    const sendAction = vi.fn();
    const element = await mounted([], sendAction);
    setInputValue(element, "input[type='text']", "   ");
    queryShadow<HTMLButtonElement>(element, ".create-row button")!.click();
    expect(sendAction).toHaveBeenCalledWith({ type: "create_checkpoint", args: {} });
    element.remove();
  });

  it("标签超 128 字符 → 行内校验错误,不派发", async () => {
    const sendAction = vi.fn();
    const element = await mounted([], sendAction);
    setInputValue(element, "input[type='text']", "a".repeat(129));
    queryShadow<HTMLButtonElement>(element, ".create-row button")!.click();
    await element.updateComplete;
    expect(sendAction).not.toHaveBeenCalled();
    const alerts = queryAllShadow(element, "[role='alert']");
    expect(alerts.some((alert) => alert.textContent?.includes("128"))).toBe(true);
    element.remove();
  });

  it("标签含控制字符 → 行内校验错误,不派发", async () => {
    const sendAction = vi.fn();
    const element = await mounted([], sendAction);
    setInputValue(element, "input[type='text']", "bad\u0007");
    queryShadow<HTMLButtonElement>(element, ".create-row button")!.click();
    await element.updateComplete;
    expect(sendAction).not.toHaveBeenCalled();
    expect(queryAllShadow(element, "[role='alert']").some((alert) => alert.textContent?.includes("控制字符"))).toBe(true);
    element.remove();
  });

  it("输入框 Enter 键同样触发创建", async () => {
    const sendAction = vi.fn();
    const element = await mounted([], sendAction);
    setInputValue(element, "input[type='text']", "k");
    queryShadow<HTMLInputElement>(element, "input[type='text']")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }),
    );
    expect(sendAction).toHaveBeenCalledTimes(1);
    element.remove();
  });
});

describe("SmCheckpoints checkout(两步确认)", () => {
  it("第一击'切换'进入确认态(不派发);'确认切换'才派发 checkout_checkpoint", async () => {
    const sendAction = vi.fn();
    const element = await mounted([checkpointRef({ checkpointId: "cp-a", label: "存档一", revision: 2 })], sendAction);
    queryShadow<HTMLButtonElement>(element, ".checkout-button")!.click();
    await element.updateComplete;
    expect(sendAction).not.toHaveBeenCalled();
    const confirmButton = queryShadow<HTMLButtonElement>(element, ".confirm-button")!;
    expect(confirmButton).not.toBeNull();
    expect(queryShadow(element, "[role='status']")?.textContent).toContain("确认切换到 存档一");
    confirmButton.click();
    expect(sendAction).toHaveBeenCalledTimes(1);
    expect(sendAction).toHaveBeenCalledWith({
      type: "checkout_checkpoint",
      args: { checkpointId: "cp-a" },
    });
    element.remove();
  });

  it("'取消'退出确认态,不派发", async () => {
    const sendAction = vi.fn();
    const element = await mounted([checkpointRef({ checkpointId: "cp-a" })], sendAction);
    queryShadow<HTMLButtonElement>(element, ".checkout-button")!.click();
    await element.updateComplete;
    const buttons = queryAllShadow<HTMLButtonElement>(element, "td button");
    buttons[buttons.length - 1]!.click(); // 取消按钮
    await element.updateComplete;
    expect(sendAction).not.toHaveBeenCalled();
    expect(queryShadow(element, ".confirm-button")).toBeNull();
    element.remove();
  });
});

describe("SmCheckpoints 终态与错误呈现", () => {
  it("sessionTerminal → 创建与切换禁用 + 终态引导文案", async () => {
    const sendAction = vi.fn();
    const element = await mounted([checkpointRef({ checkpointId: "cp-a" })], sendAction, true);
    expect((queryShadow<HTMLInputElement>(element, "input[type='text']")!).disabled).toBe(true);
    expect((queryShadow(element, ".create-row button") as HTMLButtonElement).disabled).toBe(true);
    expect((queryShadow(element, ".checkout-button") as HTMLButtonElement).disabled).toBe(true);
    expect(queryShadow(element, "[role='note']")?.textContent).toContain("会话已终态");
    element.remove();
  });

  it("sendAction 未接线(null)→ 按钮禁用", async () => {
    const element = await mounted([checkpointRef({})], null);
    expect((queryShadow(element, ".create-row button") as HTMLButtonElement).disabled).toBe(true);
    expect((queryShadow(element, ".checkout-button") as HTMLButtonElement).disabled).toBe(true);
    element.remove();
  });

  it("error 属性 → role='alert' 呈现(宿主接线 onActionRejected / 命令失败)", async () => {
    const element = await mounted();
    element.error = "动作被拒绝:session_terminal";
    await element.updateComplete;
    expect(queryShadow(element, ".alert[role='alert']")?.textContent?.trim()).toBe(
      "动作被拒绝:session_terminal",
    );
    element.remove();
  });
});

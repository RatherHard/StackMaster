/**
 * <sm-workspace-menu> 工作区菜单行为测试(WP-F5 / FE-WS-03/04a/05):
 * 打开分组、step/reset 禁用矩阵、终态引导(Q5/M11)、断线横幅
 * (reconnecting attempt/retryDelayMs、connection-replaced 手动重连)、
 * 拒绝错误呈现(含 explanation,不只 code)。
 */
import { describe, expect, it } from "vitest";

import type { PublicError } from "@stackmaster/protocol";

import { SmWorkspaceMenu } from "../../src/workspace/sm-workspace-menu.js";
import { createDefaultTabTypeRegistry } from "../../src/workspace/tab-registry.js";

async function mountMenu(): Promise<SmWorkspaceMenu> {
  const element = new SmWorkspaceMenu();
  element.tabTypes = createDefaultTabTypeRegistry().list();
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function menuOf(element: SmWorkspaceMenu): ShadowRoot {
  return element.shadowRoot as ShadowRoot;
}

describe("<sm-workspace-menu> 打开分组(FE-WS-03 菜单项可扩展)", () => {
  it("按注册表渲染打开项,点击发出 open-tab 动作(含 debug 占位项)", async () => {
    const element = await mountMenu();
    const actions: unknown[] = [];
    element.addEventListener("workspace-menu-action", (event) => {
      actions.push((event as CustomEvent).detail.action);
    });

    const openButtons = [...menuOf(element).querySelectorAll("button.open-tab")];
    expect(openButtons.map((button) => button.textContent?.trim())).toEqual([
      "栈视图",
      "自由视图",
      "寄存器视图",
      "调试",
    ]);
    (openButtons[3] as HTMLButtonElement).click();

    expect(actions).toEqual([{ action: "open-tab", tabType: "debug" }]);
    // 占位项的提示文案:空态指向 WP-F8(注册存在不实现)。
    expect((openButtons[3] as HTMLButtonElement).getAttribute("title")).toContain("WP-F8");
    element.remove();
  });
});

describe("<sm-workspace-menu> 运行项禁用矩阵(FE-WS-04a / FE-WS-05)", () => {
  it("已连接 + 运行中(paused):step 与 reset 可点", async () => {
    const element = await mountMenu();
    element.hasSession = true;
    element.connectionStatus = "connected";
    element.projectionStatus = "paused";
    element.revision = 3;
    await element.updateComplete;

    expect((menuOf(element).querySelector("button.step-button") as HTMLButtonElement).disabled).toBe(false);
    expect((menuOf(element).querySelector("button.reset-button") as HTMLButtonElement).disabled).toBe(false);
    element.remove();
  });

  it("运行中(running)同样可点;终态(won/failed)reset 禁用并呈现引导", async () => {
    const element = await mountMenu();
    element.hasSession = true;
    element.connectionStatus = "connected";
    element.projectionStatus = "running";
    await element.updateComplete;
    expect((menuOf(element).querySelector("button.reset-button") as HTMLButtonElement).disabled).toBe(false);

    element.projectionStatus = "won";
    await element.updateComplete;
    const reset = menuOf(element).querySelector("button.reset-button") as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    const guidance = menuOf(element).querySelector(".guidance");
    expect(guidance?.textContent).toContain("测试环境已结束,请新建会话");
    element.remove();
  });

  it("failed 终态同样禁用;断线时 step/reset 均禁用", async () => {
    const element = await mountMenu();
    element.hasSession = true;
    element.connectionStatus = "connected";
    element.projectionStatus = "failed";
    await element.updateComplete;
    expect((menuOf(element).querySelector("button.reset-button") as HTMLButtonElement).disabled).toBe(true);

    element.projectionStatus = "paused";
    element.connectionStatus = "reconnecting";
    await element.updateComplete;
    expect((menuOf(element).querySelector("button.step-button") as HTMLButtonElement).disabled).toBe(true);
    expect((menuOf(element).querySelector("button.reset-button") as HTMLButtonElement).disabled).toBe(true);
    element.remove();
  });

  it("终态引导的新建会话按钮发出 new-session 动作(close+create 流程归宿主)", async () => {
    const element = await mountMenu();
    element.hasSession = true;
    element.connectionStatus = "connected";
    element.projectionStatus = "won";
    await element.updateComplete;

    const actions: unknown[] = [];
    element.addEventListener("workspace-menu-action", (event) => {
      actions.push((event as CustomEvent).detail.action);
    });
    (menuOf(element).querySelector("button.new-session-button") as HTMLButtonElement).click();
    expect(actions).toEqual([{ action: "new-session" }]);
    element.remove();
  });
});

describe("<sm-workspace-menu> 状态与断线横幅(FE-WS-03)", () => {
  it("状态区呈现 projection status + revision + 连接状态", async () => {
    const element = await mountMenu();
    element.hasSession = true;
    element.connectionStatus = "connected";
    element.projectionStatus = "paused";
    element.revision = 7;
    await element.updateComplete;

    expect(menuOf(element).querySelector(".session-status")?.textContent).toBe("paused");
    expect(menuOf(element).querySelector(".revision")?.textContent).toBe("7");
    expect(menuOf(element).querySelector(".connection-status")?.textContent).toBe("connected");
    element.remove();
  });

  it("reconnecting:横幅呈现最近投影 + attempt / retryDelayMs", async () => {
    const element = await mountMenu();
    element.hasSession = true;
    element.connectionStatus = "reconnecting";
    element.reconnectAttempt = 2;
    element.retryDelayMs = 1000;
    element.revision = 7;
    element.projectionStatus = "paused";
    await element.updateComplete;

    const banner = menuOf(element).querySelector(".banner") as HTMLElement;
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.textContent).toContain("最近一次公开投影(revision 7)");
    expect(banner.textContent).toContain("第 2 次重试");
    expect(banner.textContent).toContain("1000 ms 后重试");
    expect(banner.textContent).toContain("本地 VM 执行降级"); // 横幅明示零本地降级纪律。
    element.remove();
  });

  it("connected 状态无横幅", async () => {
    const element = await mountMenu();
    element.connectionStatus = "connected";
    element.hasSession = true;
    await element.updateComplete;
    expect(menuOf(element).querySelector(".banner")).toBeNull();
    element.remove();
  });

  it("connection-replaced:横幅转为 alert + 手动重连动作", async () => {
    const element = await mountMenu();
    element.hasSession = true;
    element.connectionStatus = "disconnected";
    element.disconnectReason = "connection-replaced";
    await element.updateComplete;

    const banner = menuOf(element).querySelector(".banner") as HTMLElement;
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("连接已被同一会话的新连接取代");

    const actions: unknown[] = [];
    element.addEventListener("workspace-menu-action", (event) => {
      actions.push((event as CustomEvent).detail.action);
    });
    (menuOf(element).querySelector("button.reconnect-button") as HTMLButtonElement).click();
    expect(actions).toEqual([{ action: "reconnect" }]);
    element.remove();
  });

  it("step / reset 点击发出对应动作", async () => {
    const element = await mountMenu();
    element.hasSession = true;
    element.connectionStatus = "connected";
    element.projectionStatus = "paused";
    await element.updateComplete;

    const actions: unknown[] = [];
    element.addEventListener("workspace-menu-action", (event) => {
      actions.push((event as CustomEvent).detail.action);
    });
    (menuOf(element).querySelector("button.step-button") as HTMLButtonElement).click();
    (menuOf(element).querySelector("button.reset-button") as HTMLButtonElement).click();
    expect(actions).toEqual([{ action: "step" }, { action: "reset" }]);
    element.remove();
  });
});

describe("<sm-workspace-menu> 拒绝错误呈现(可解释性反馈)", () => {
  it("呈现 code + message + explanation(hints 与事实字段),不只 code", async () => {
    const element = await mountMenu();
    const error = {
      code: "permission_denied",
      message: "目标地址不可写",
      addressHex: "0x1004",
      explanation: {
        regionId: "region-stack",
        permissions: "rw",
        valueHex: "0x2004",
        hints: ["检查写入目标", "使用可写区域"],
      },
    } as PublicError;
    element.lastError = error;
    await element.updateComplete;

    const errorBar = menuOf(element).querySelector(".error") as HTMLElement;
    expect(errorBar.getAttribute("role")).toBe("alert");
    expect(errorBar.textContent).toContain("[permission_denied]");
    expect(errorBar.textContent).toContain("目标地址不可写");
    expect(errorBar.textContent).toContain("检查写入目标");
    expect(errorBar.textContent).toContain("region-stack");
    expect(errorBar.textContent).toContain("0x2004");
    element.remove();
  });

  it("「知道了」消隐当前错误;新错误到达重新呈现", async () => {
    const element = await mountMenu();
    element.lastError = { code: "budget_exhausted", message: "预算耗尽" };
    await element.updateComplete;
    (menuOf(element).querySelector("button.error-dismiss") as HTMLButtonElement).click();
    await element.updateComplete;
    expect(menuOf(element).querySelector(".error")).toBeNull();

    element.lastError = { code: "stale_base_revision", message: "baseRevision 过期" };
    await element.updateComplete;
    expect(menuOf(element).querySelector(".error")?.textContent).toContain("stale_base_revision");
    element.remove();
  });
});

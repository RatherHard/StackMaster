/**
 * <sm-workspace-menu> 工作区菜单行为测试(WP-F5 / FE-WS-03/04a/05;WP-F8
 * 增补 FE-WS-04c/06 + what-if 横幅):打开分组、step/reset 禁用矩阵、终态
 * 引导(Q5/M11)、断线横幅(reconnecting attempt/retryDelayMs、
 * connection-replaced 手动重连)、拒绝错误呈现(含 explanation,不只 code)、
 * 运行到断点与模式切换门槛、what-if 纪律横幅。
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
  it("按注册表渲染打开项,点击发出 open-tab 动作(WP-F8:debug = 指令视图 + ED 组件面五类)", async () => {
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
      "Payload 搭建",
      "指令视图",
      "结构视图",
      "调用栈",
      "内存 diff",
      "时间线",
      "checkpoint",
    ]);
    (openButtons[4] as HTMLButtonElement).click();

    expect(actions).toEqual([{ action: "open-tab", tabType: "debug" }]);
    // 指令视图(WP-F8 真工厂):提示文案 = 展示名(有工厂,非占位空态)。
    expect((openButtons[4] as HTMLButtonElement).getAttribute("title")).toContain("指令视图");
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

describe("<sm-workspace-menu> 积木步进(FE-WS-04b,WP-F6)", () => {
  it("payload 标签页未激活时禁用(缺省不可用)", async () => {
    const element = await mountMenu();
    element.hasSession = true;
    element.connectionStatus = "connected";
    await element.updateComplete;
    const button = menuOf(element).querySelector("button.payload-step-button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toContain("仅 Payload 标签页激活时可用");
    element.remove();
  });

  it("payload 标签页激活时可用,点击发出 payload-step 动作", async () => {
    const element = await mountMenu();
    element.payloadStepEnabled = true;
    await element.updateComplete;
    const button = menuOf(element).querySelector("button.payload-step-button") as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    const actions: unknown[] = [];
    element.addEventListener("workspace-menu-action", (event) => {
      actions.push((event as CustomEvent).detail.action);
    });
    button.click();
    expect(actions).toEqual([{ action: "payload-step" }]);
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

// ── WP-F8:运行到断点 / 模式切换 / what-if 横幅(FE-WS-04c/06,ADR-DC1 条款 7)──

describe("<sm-workspace-menu> 模式切换与运行到断点(WP-F8)", () => {
  it("debugModeAvailable=false:隐藏模式切换项(未启用调试的题目);运行到断点禁用", async () => {
    const element = await mountMenu();
    expect(menuOf(element).querySelector(".mode-toggle-button")).toBeNull();
    expect((menuOf(element).querySelector(".run-to-breakpoint-button") as HTMLButtonElement).disabled).toBe(true);
    element.remove();
  });

  it("debugModeAvailable=true:切换项可见;点击发出 toggle-debug-mode;文案随模式反转", async () => {
    const element = await mountMenu();
    element.debugModeAvailable = true;
    await element.updateComplete;
    const actions: unknown[] = [];
    element.addEventListener("workspace-menu-action", (event) => {
      actions.push((event as CustomEvent).detail.action);
    });

    const toggle = menuOf(element).querySelector(".mode-toggle-button") as HTMLButtonElement;
    expect(toggle.textContent).toContain("切换到调试模式");
    toggle.click();
    expect(actions).toEqual([{ action: "toggle-debug-mode" }]);

    element.debugModeActive = true;
    await element.updateComplete;
    expect((menuOf(element).querySelector(".mode-toggle-button") as HTMLButtonElement).textContent).toContain(
      "返回解题模式",
    );
    element.remove();
  });

  it("运行到断点:宿主注入的可用性直控禁用态;点击发出 run-to-breakpoint 动作", async () => {
    const element = await mountMenu();
    element.debugModeAvailable = true;
    element.runToBreakpointEnabled = true;
    await element.updateComplete;
    const actions: unknown[] = [];
    element.addEventListener("workspace-menu-action", (event) => {
      actions.push((event as CustomEvent).detail.action);
    });

    const runButton = menuOf(element).querySelector(".run-to-breakpoint-button") as HTMLButtonElement;
    expect(runButton.disabled).toBe(false);
    runButton.click();
    expect(actions).toEqual([{ action: "run-to-breakpoint" }]);
    element.remove();
  });

  it("what-if 纪律横幅:仅调试模式常驻呈现(条款 7 不可误读)", async () => {
    const element = await mountMenu();
    element.debugModeAvailable = true;
    await element.updateComplete;
    expect(menuOf(element).querySelector(".whatif-banner")).toBeNull();

    element.debugModeActive = true;
    await element.updateComplete;
    const banner = menuOf(element).querySelector(".whatif-banner");
    expect(banner?.textContent).toContain("调试通过 ≠ 提交通过");
    expect(banner?.textContent).toContain("裁决以提交为准");
    expect(banner?.textContent).toContain("ASLR");
    element.remove();
  });
});

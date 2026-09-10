/**
 * plugin-dev 开发壳测试(WP-F5 demo):壳结构冒烟、会话表单接线
 * (create_session → connect → 工作区组合根注入)、新建会话流程
 * (close_session 兜底 + 重建)、工作区终态引导事件(new-session-request)。
 * vm-ui 产物不在测试环境加载(见 README 加载模型):客户端以替身注入。
 */
import { describe, expect, it } from "vitest";

import {
  mountWorkspaceShell,
  wireSessionDemo,
  boot,
  type SessionDemoClientLike,
  type WorkspaceShellHandles,
} from "../src/main.js";

/** 会话客户端替身:记录调用序列(与 SessionClient 面结构兼容)。 */
class FakeSessionClient implements SessionDemoClientLike {
  static created: FakeSessionClient[] = [];

  readonly calls: string[] = [];
  sessionId: string | null = null;
  failCreate = false;
  failClose = false;

  constructor() {
    FakeSessionClient.created.push(this);
  }

  async createSession(input: { challengeId: string }): Promise<unknown> {
    if (this.failCreate) {
      throw new Error("create failed (fake)");
    }
    this.calls.push(`create:${input.challengeId}`);
    this.sessionId = "session-fake-0001";
    return { sessionId: this.sessionId };
  }

  connect(): void {
    this.calls.push("connect");
  }

  async closeSession(): Promise<unknown> {
    if (this.failClose) {
      throw new Error("close failed (fake)");
    }
    this.calls.push("close");
    this.sessionId = null;
    return {};
  }
}

interface Fixture {
  readonly handles: WorkspaceShellHandles;
  readonly controller: ReturnType<typeof wireSessionDemo>;
}

function mount(): Fixture {
  const root = document.createElement("div");
  document.body.append(root);
  const handles = mountWorkspaceShell(root);
  const controller = wireSessionDemo(handles, () => new FakeSessionClient());
  return { handles, controller };
}

/** 冲刷微任务(事件处理器内的 async 流程兑现)。 */
async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

describe("plugin-dev 开发壳:壳结构", () => {
  it("挂载冒烟:标题、状态行、创建会话表单与 <sm-workspace> 挂载点渲染到位", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const handles = mountWorkspaceShell(root);

    expect(handles.root.className).toBe("plugin-dev-shell");
    expect(handles.root.querySelector("h1")?.textContent).toContain("plugin-dev");
    expect(handles.status.id).toBe("dev-status");
    expect(handles.status.textContent).toContain("开发壳就绪");
    expect(handles.tabArea.getAttribute("aria-label")).toBe("工作区标签页区域");
    // jsdom 测试环境不加载 vm-ui 产物(见 README 加载模型),<sm-workspace>
    // 保持未升级的占位元素;元素注册与渲染由 packages/vm-ui 自身测试覆盖。
    const workspace = handles.tabArea.querySelector("sm-workspace");
    expect(workspace).toBeInstanceOf(HTMLElement);
    expect(workspace?.tagName.toLowerCase()).toBe("sm-workspace");
    // 创建会话表单:四个输入 + 两个按钮(挑战上下文三方比对输入 + embed token)。
    expect(handles.form.challengeId.value).toContain("challenge-dev");
    expect(handles.form.challengeVersion.value).toBe("1.0.0");
    expect(handles.form.embedSessionId.value).toContain("embed-dev");
    expect(handles.form.embedToken.value).toContain("embed-token-dev");
    expect(handles.form.createButton.textContent).toContain("创建并连接");
    expect(handles.form.newSessionButton.textContent).toContain("新建会话");
  });

  it("重复挂载幂等:先清空容器再挂载,不产生重复节点", () => {
    const root = document.createElement("div");
    document.body.append(root);

    mountWorkspaceShell(root);
    const handles = mountWorkspaceShell(root);

    expect(root.querySelectorAll(".plugin-dev-shell")).toHaveLength(1);
    expect(handles.tabArea.querySelectorAll("sm-workspace")).toHaveLength(1);
  });
});

describe("plugin-dev 开发壳:会话 demo 接线", () => {
  it("表单提交 → createSession(表单值)→ connect → 工作区注入客户端(组合根)", async () => {
    const { handles, controller } = mount();
    handles.form.challengeId.value = "challenge-demo-9";

    handles.form.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    const client = controller.client as FakeSessionClient;
    expect(client).toBeInstanceOf(FakeSessionClient);
    expect(client.calls).toEqual(["create:challenge-demo-9", "connect"]);
    expect((handles.workspace as { client?: unknown }).client).toBe(client);
    expect(handles.status.textContent).toContain("会话已创建并连接");
  });

  it("创建失败 → 状态行呈现可解释错误,不注入工作区", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const handles = mountWorkspaceShell(root);
    const controller = wireSessionDemo(handles, () => {
      const client = new FakeSessionClient();
      client.failCreate = true;
      return client;
    });

    handles.form.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    expect(controller.client).toBeNull();
    expect((handles.workspace as { client?: unknown }).client).toBeUndefined();
    expect(handles.status.textContent).toContain("会话创建失败");
    expect(handles.status.textContent).toContain("create failed (fake)");
  });

  it("新建会话按钮:无既有会话时直接 createSession + connect", async () => {
    const { handles, controller } = mount();

    handles.form.newSessionButton.click();
    await settle();

    const first = controller.client as FakeSessionClient;
    expect(first.calls).toEqual(["create:challenge-dev-0001", "connect"]);
  });

  it("已有会话时新建:先 close_session 再重建(close 被拒不阻塞引导流程)", async () => {
    const { handles, controller } = mount();

    // 先建立会话。
    await controller.createAndConnect();
    const first = controller.client as FakeSessionClient;

    await controller.newSession();
    const second = controller.client as FakeSessionClient;

    expect(first.calls).toEqual(["create:challenge-dev-0001", "connect", "close"]);
    expect(second).not.toBe(first);
    expect(second.calls).toEqual(["create:challenge-dev-0001", "connect"]);
    expect((handles.workspace as { client?: unknown }).client).toBe(second);
  });

  it("工作区终态引导事件(new-session-request)→ 触发新建会话流程(Q5/M11 挂点)", async () => {
    const { handles, controller } = mount();
    await controller.createAndConnect();
    const first = controller.client as FakeSessionClient;

    handles.workspace.dispatchEvent(new CustomEvent("new-session-request", { bubbles: true }));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(first.calls).toContain("close");
    expect((controller.client as FakeSessionClient).calls).toContain("create:challenge-dev-0001");
  });

  it("boot:加载产物成功 → 返回控制器;加载失败 → 状态行指引构建产物", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const handles = mountWorkspaceShell(root);
    const controller = await boot(root, async () => ({ SessionClient: FakeSessionClient }));
    expect(controller).not.toBeNull();
    expect(handles.tabArea.querySelector("sm-workspace")).not.toBeNull();

    const root2 = document.createElement("div");
    document.body.append(root2);
    const failing = await boot(root2, async () => {
      throw new Error("404 /index.js");
    });
    expect(failing).toBeNull();
    const status = root2.querySelector("#dev-status");
    expect(status?.textContent).toContain("vm-ui 产物加载失败");
    expect(status?.textContent).toContain("pnpm build");
  });
});

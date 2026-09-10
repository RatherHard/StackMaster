import { describe, expect, it } from "vitest";
import { mountWorkspaceShell } from "../src/main.js";

describe("plugin-dev 开发壳", () => {
  it("挂载冒烟:标题、状态行与 <sm-workspace> 挂载点渲染到位", () => {
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

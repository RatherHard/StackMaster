/**
 * plugin-dev 开发壳引导逻辑(WP-F1)。
 *
 * 职责:把开发壳占位结构(标题 + 联调状态行 + 工作区挂载点)挂进 index.html
 * 的 #app 容器,供本 WP 冒烟与后续 WP(会话联调、Playwright 最小集)挂接。
 *
 * 加载模型:<sm-workspace> 不在此模块导入——vm-ui 的构建产物由 index.html
 * 以 ES module URL 直接加载并注册自定义元素(平台宿主消费已发布组件包的
 * 真实拓扑;dependency-cruiser no-backend-dependency-on-browser-packages
 * 禁止 apps 静态依赖浏览器可达包)。详见 README「加载模型」。
 */

/** 挂载后的开发壳结构句柄(测试与后续 WP 的挂接点)。 */
export interface WorkspaceShellHandles {
  /** 挂载根元素(.plugin-dev-shell)。 */
  root: HTMLElement;
  /** 开发状态行(联调期提示信息)。 */
  status: HTMLElement;
  /** 工作区挂载点(内含 <sm-workspace>,由 vm-ui 产物注册)。 */
  tabArea: HTMLElement;
}

/**
 * 挂载开发壳占位结构;幂等——重复挂载前先清空容器,热更新下不产生重复节点。
 * 浏览器只保存公开投影与 UI 状态:本函数只装配静态壳结构,不持有任何会话数据。
 */
export function mountWorkspaceShell(root: HTMLElement): WorkspaceShellHandles {
  root.replaceChildren();

  const shell = document.createElement("div");
  shell.className = "plugin-dev-shell";

  const header = document.createElement("header");
  const title = document.createElement("h1");
  title.textContent = "StackMaster plugin-dev";
  const status = document.createElement("p");
  status.id = "dev-status";
  status.textContent = "开发壳就绪:会话 API 联调见 README(/sessions 反代默认 127.0.0.1:13000)";
  header.append(title, status);

  const tabArea = document.createElement("main");
  tabArea.className = "tab-area";
  tabArea.setAttribute("aria-label", "工作区标签页区域");
  // vm-ui 产物加载后该标签被升级为 <sm-workspace>;未加载时保持未升级占位元素。
  const workspace = document.createElement("sm-workspace");
  tabArea.append(workspace);

  shell.append(header, tabArea);
  root.append(shell);

  return { root: shell, status, tabArea };
}

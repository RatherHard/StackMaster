/**
 * plugin-dev 开发壳引导逻辑(WP-F1 建壳,WP-F5 完整工作区 demo)。
 *
 * 职责:在 index.html 的 #app 容器挂载「创建会话表单 + <sm-workspace> 工作区」,
 * 并把表单提交接线到 SessionClient 的真实流程(create_session → 认证 WSS
 * connect → 工作区组合根注入),菜单动作(step / reset / 断线重连)随之对
 * 真实会话生效。终态引导(Q5/M11):工作区发出 `new-session-request` 事件 →
 * 本壳执行 close_session(如未关)+ create_session 新流程。
 *
 * 加载模型:<sm-workspace> / SessionClient 不在此模块静态导入——vm-ui 的构建
 * 产物由 index.html 以 ES module URL 直接加载(平台宿主消费已发布组件包的
 * 真实拓扑;dependency-cruiser no-backend-dependency-on-browser-packages
 * 禁止 apps 静态依赖浏览器可达包)。运行时经 `import("/index.js")` 取命名
 * 导出(动态 URL,不进构建图)。详见 README「加载模型」。
 */

/** 会话创建输入(冻结 create_session 载荷;身份零承载)。 */
export interface SessionCreateInput {
  readonly challengeId: string;
  readonly challengeVersion: string;
  readonly embedSessionId: string;
  readonly embedToken: string;
}

/** 工作区需要的会话客户端最小面(与 SessionClient 结构兼容;测试可注入替身)。 */
export interface SessionDemoClientLike {
  createSession(input: SessionCreateInput): Promise<unknown>;
  connect(): void;
  closeSession(): Promise<unknown>;
  readonly sessionId: string | null;
}

/** 创建会话表单句柄。 */
export interface SessionFormHandles {
  /** 创建会话表单(submit = 创建并连接)。 */
  readonly form: HTMLFormElement;
  readonly challengeId: HTMLInputElement;
  readonly challengeVersion: HTMLInputElement;
  readonly embedSessionId: HTMLInputElement;
  readonly embedToken: HTMLInputElement;
  readonly createButton: HTMLButtonElement;
  readonly newSessionButton: HTMLButtonElement;
}

/** 挂载后的开发壳结构句柄(测试与后续 WP 的挂接点)。 */
export interface WorkspaceShellHandles {
  /** 挂载根元素(.plugin-dev-shell)。 */
  readonly root: HTMLElement;
  /** 开发状态行(联调期提示信息)。 */
  readonly status: HTMLElement;
  /** 工作区挂载点(内含 <sm-workspace>,由 vm-ui 产物注册)。 */
  readonly tabArea: HTMLElement;
  /** 工作区元素(产物加载后升级;组合根注入点)。 */
  readonly workspace: HTMLElement;
  /** 创建会话表单。 */
  readonly form: SessionFormHandles;
}

/** 会话 demo 控制器(接线后的动作入口;测试断言面)。 */
export interface SessionDemoController {
  /** 读表单 → createSession → connect → 工作区注入。 */
  createAndConnect(): Promise<void>;
  /** 终态引导流程:close_session(如未关)+ create_session 新流程。 */
  newSession(): Promise<void>;
  /** 当前客户端(未创建为 null)。 */
  readonly client: SessionDemoClientLike | null;
}

/** 表单演示缺省值(开发夹具;零真实凭证——真实凭证走环境变量签发,不入库)。 */
const DEMO_DEFAULTS: SessionCreateInput = {
  challengeId: "challenge-dev-0001",
  challengeVersion: "1.0.0",
  embedSessionId: "embed-dev-0001",
  embedToken: "embed-token-dev-0001",
};

/** 开发壳样式(注入一次;仅开发联调形态)。 */
const SHELL_STYLE_ID = "plugin-dev-shell-style";
const SHELL_STYLE = `
.plugin-dev-shell { display: flex; flex-direction: column; gap: 0.75rem; max-inline-size: 78rem; margin: 0 auto; padding: 1rem; }
.plugin-dev-shell header h1 { margin: 0; font-size: 1.25rem; }
.plugin-dev-shell #dev-status { margin: 0.25rem 0 0; color: graytext; font-size: 0.8125rem; }
.session-form { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: end; padding: 0.5rem 0.75rem; border: 1px solid rgb(0 0 0 / 15%); border-radius: 8px; font: system-ui 0.8125rem sans-serif; }
.session-form label { display: flex; flex-direction: column; gap: 0.125rem; font-size: 0.75rem; color: graytext; }
.session-form input { font: inherit; padding: 0.25rem 0.375rem; min-inline-size: 12ch; }
.session-form button { font: inherit; padding: 0.3125rem 0.75rem; cursor: pointer; }
.plugin-dev-shell .tab-area { min-block-size: 32rem; }
`;

/**
 * 挂载开发壳结构;幂等——重复挂载前先清空容器,热更新下不产生重复节点。
 * 浏览器只保存公开投影与 UI 状态:本函数只装配静态壳结构,不持有任何会话数据。
 */
export function mountWorkspaceShell(root: HTMLElement): WorkspaceShellHandles {
  root.replaceChildren();

  if (document.getElementById(SHELL_STYLE_ID) === null) {
    const style = document.createElement("style");
    style.id = SHELL_STYLE_ID;
    style.textContent = SHELL_STYLE;
    document.head.append(style);
  }

  const shell = document.createElement("div");
  shell.className = "plugin-dev-shell";

  const header = document.createElement("header");
  const title = document.createElement("h1");
  title.textContent = "StackMaster plugin-dev";
  const status = document.createElement("p");
  status.id = "dev-status";
  status.textContent = "开发壳就绪:填写题目上下文并「创建并连接」(会话 API 经 /sessions 反代,默认 127.0.0.1:13000)";
  header.append(title, status);

  // 创建会话表单(challengeId / challengeVersion / embedSessionId / embedToken)。
  const form = document.createElement("form");
  form.className = "session-form";
  form.setAttribute("aria-label", "创建会话");
  const input = (name: keyof SessionCreateInput, label: string): HTMLInputElement => {
    const field = document.createElement("label");
    const caption = document.createElement("span");
    caption.textContent = label;
    const control = document.createElement("input");
    control.name = name;
    control.value = DEMO_DEFAULTS[name];
    control.required = true;
    field.append(caption, control);
    form.append(field);
    return control;
  };
  const challengeId = input("challengeId", "challengeId");
  const challengeVersion = input("challengeVersion", "challengeVersion");
  const embedSessionId = input("embedSessionId", "embedSessionId");
  const embedToken = input("embedToken", "embedToken");
  const createButton = document.createElement("button");
  createButton.type = "submit";
  createButton.className = "create-button";
  createButton.textContent = "创建并连接";
  const newSessionButton = document.createElement("button");
  newSessionButton.type = "button";
  newSessionButton.className = "new-session-button";
  newSessionButton.textContent = "新建会话";
  form.append(createButton, newSessionButton);

  const tabArea = document.createElement("main");
  tabArea.className = "tab-area";
  tabArea.setAttribute("aria-label", "工作区标签页区域");
  // vm-ui 产物加载后该元素升级为 <sm-workspace>;未加载时保持未升级占位元素。
  const workspace = document.createElement("sm-workspace");

  tabArea.append(workspace);
  shell.append(header, form, tabArea);
  root.append(shell);

  return {
    root: shell,
    status,
    tabArea,
    workspace,
    form: {
      form,
      challengeId,
      challengeVersion,
      embedSessionId,
      embedToken,
      createButton,
      newSessionButton,
    },
  };
}

/** 读表单 → create_session 输入(缺省回落演示值)。 */
export function readSessionForm(handles: WorkspaceShellHandles): SessionCreateInput {
  const value = (control: HTMLInputElement): string =>
    control.value.trim() || DEMO_DEFAULTS[control.name as keyof SessionCreateInput];
  return {
    challengeId: value(handles.form.challengeId),
    challengeVersion: value(handles.form.challengeVersion),
    embedSessionId: value(handles.form.embedSessionId),
    embedToken: value(handles.form.embedToken),
  };
}

// ── 夹具描述包注入(WP-F8 / FE-WS-06:调试可用性 + ED 教学面)────────────────

/**
 * 夹具公开描述包的结构切面(开发壳本地类型;数据形态对齐
 * challenge-schema 公开包,**零代码依赖**——夹具 JSON 数据占位无秘密)。
 * vm-ui 以结构化类型消费(ed-types.ts 本地面),此处只透传数据。
 */
export interface DevDescriptor {
  /** debugMode 声明(opt-out;true = 工作区菜单呈现解题/调试模式切换项)。 */
  readonly debugMode?: boolean;
  /** 提示 ladder(FE-ED-06;透传 <sm-hint-ladder>.hints)。 */
  readonly hintLadder?: readonly unknown[];
  /** 错误教学注解映射(FE-ED-07;透传 <sm-error-explainer>.mappings)。 */
  readonly publicErrorMapping?: readonly unknown[];
}

/**
 * 把夹具描述包注入工作区装配(debugModeAvailable / hintLadder /
 * publicErrorMapping;sm-workspace 未升级(产物未加载)时至少落
 * debugModeAvailable 属性——自定义元素升级后 Lit 初始化消费该值)。
 */
export function applyChallengeDescriptor(handles: WorkspaceShellHandles, descriptor: DevDescriptor): void {
  const workspace = handles.workspace as {
    debugModeAvailable?: boolean;
    challengeDescriptor?: unknown;
  };
  workspace.debugModeAvailable = descriptor.debugMode === true;
  workspace.challengeDescriptor = {
    hintLadder: descriptor.hintLadder ?? [],
    publicErrorMapping: descriptor.publicErrorMapping ?? [],
  };
  if (descriptor.debugMode === true) {
    handles.status.textContent = `${handles.status.textContent} 调试模式可用(夹具描述包 debugMode=true)。`;
  }
}

/** 缺省夹具描述包加载:fetch 本地 JSON(开发联调面;失败 = fail-soft null)。 */
export async function loadDevDescriptor(url = "/fixtures/dev-descriptor.json"): Promise<DevDescriptor | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as DevDescriptor;
  } catch {
    return null;
  }
}

/**
 * 接线会话 demo:表单提交 = 创建并连接;「新建会话」按钮与工作区终态引导
 * 事件(new-session-request)= close_session(如未关)+ create_session 新流程。
 */
export function wireSessionDemo(
  handles: WorkspaceShellHandles,
  createClient: () => SessionDemoClientLike,
): SessionDemoController {
  const setStatus = (text: string): void => {
    handles.status.textContent = text;
  };

  let activeClient: SessionDemoClientLike | null = null;

  const controller: SessionDemoController = {
    get client(): SessionDemoClientLike | null {
      return activeClient;
    },

    async createAndConnect(): Promise<void> {
      const input = readSessionForm(handles);
      try {
        const client = createClient();
        await client.createSession(input);
        client.connect();
        activeClient = client;
        // 组合根注入:工作区据此装配 ProjectionDataSource(client.store)。
        (handles.workspace as { client?: unknown }).client = client;
        setStatus(`会话已创建并连接(sessionId=${client.sessionId ?? "未知"});顶部菜单可步进 / 重启。`);
      } catch (error) {
        setStatus(`会话创建失败:${error instanceof Error ? error.message : String(error)}(检查 compose 拓扑与反代)`);
      }
    },

    async newSession(): Promise<void> {
      if (activeClient !== null && activeClient.sessionId !== null) {
        try {
          await activeClient.closeSession();
        } catch {
          // 已终态 / 已关闭的会话 close 被拒:不阻塞新建流程(Q5 引导语义)。
        }
      }
      await this.createAndConnect();
    },
  };

  handles.form.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void controller.createAndConnect();
  });
  handles.form.newSessionButton.addEventListener("click", () => {
    void controller.newSession();
  });
  // 终态引导挂点:工作区 reset 禁用时呈现「新建会话」→ 发出本事件(Q5/M11)。
  handles.workspace.addEventListener("new-session-request", () => {
    void controller.newSession();
  });

  return controller;
}

/** vm-ui 产物 URL(publicDir 静态资源形态;变量间接引用避免打包器解析)。 */
const vmUiModuleUrl = "/index.js";

/** 产物动态加载(运行时 URL;@vite-ignore 保持运行时语义,不进构建图)。 */
function defaultLoadModule(): Promise<{ SessionClient: new () => SessionDemoClientLike }> {
  return import(/* @vite-ignore */ vmUiModuleUrl);
}

/**
 * 开发壳引导(仅供 index.html 调用;测试经 mountWorkspaceShell +
 * wireSessionDemo 注入替身)。动态加载 vm-ui 产物并完成接线;产物缺失时
 * (未先构建 packages/vm-ui)在状态行给出可操作指引。夹具描述包
 * (WP-F8)fail-soft 加载后注入工作区:debugModeAvailable + ED 教学面。
 */
export async function boot(
  root: HTMLElement,
  loadModule: () => Promise<{ SessionClient: new () => SessionDemoClientLike }> = defaultLoadModule,
  loadDescriptor: () => Promise<DevDescriptor | null> = () => loadDevDescriptor(),
): Promise<SessionDemoController | null> {
  const handles = mountWorkspaceShell(root);
  try {
    const vmUi = await loadModule();
    const controller = wireSessionDemo(handles, () => new vmUi.SessionClient());
    const descriptor = await loadDescriptor();
    if (descriptor !== null) {
      applyChallengeDescriptor(handles, descriptor);
    } else {
      handles.status.textContent = `${handles.status.textContent} 夹具描述包未加载:调试模式切换项隐藏(降级明示)。`;
    }
    return controller;
  } catch (error) {
    handles.status.textContent = `vm-ui 产物加载失败:${
      error instanceof Error ? error.message : String(error)
    }——请先执行 pnpm build 构建packages/vm-ui(dist/index.js)`;
    return null;
  }
}

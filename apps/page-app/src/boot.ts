/**
 * page-app 引导序列(分发改版 WP-92;组合根)。
 *
 * ## 序列(与 `apps/plugin-dev/src/main.ts` 的**会话装配**部分同源,授权链换成新的)
 *
 *   1. 从路径取 `challengeId` / `version`(`/app/c/:challengeId/:version`);
 *   2. 运行期加载 vm-ui 构建产物(见 `vm-ui-module.ts`);
 *   3. `new SessionClient()` —— **同源相对路径**:
 *      `baseUrl` 缺省 ⇒ REST 走相对路径(`/sessions` 等,浏览器按当前 origin
 *      解析)、WSS 由 `location.href` 派生 `ws(s)://<同源>/sessions/channel`;
 *   4. `await client.createSession({challengeId, challengeVersion: version})`
 *      —— **不带任何 token**:授权来源是换票时下发的**启动授权凭证 Cookie**
 *      (HttpOnly,`Path=/sessions`),由 `credentials: "include"` 自动呈递
 *      (D-LT-5 5c);
 *   5. `client.connect()` —— 认证 WSS(升级请求同源携带 Cookie);
 *   6. 取公开描述包(`fetchChallengeDescriptor`,同源绝对 origin);
 *      **失败不阻塞会话**:缺席明示(静态面不渲染),会话照常可用;
 *   7. 挂 `<sm-workspace>`、注入组合根属性(`client` ⇒ 工作区自建数据源)。
 *
 * ## 两条纪律(不得回退)
 *
 *  - **浏览器侧不做授权判断**:本文件从不读票据查询串、不校验租户、不判断
 *    "这个地址该不该能用"。唯一的授权事实来自 `POST /sessions` 的应答
 *    (401 = 地址已失效);
 *  - **401 / 凭证过期 = 不重试**:`createSession` 失败即呈现「地址已失效,
 *    请向平台重新获取」并停止。**不做**自动重试、不重新换票、不反复打 401
 *    (D-LT-2:票据与授权凭证都是**单次消费**,重试没有任何成功可能,只会制造
 *    噪音与限流计数)。
 */
import { parseLaunchPath, type LaunchPath } from "./launch-path.js";
import {
  WORKSPACE_ELEMENT_TAG,
  loadVmUiModule,
  type LaunchIdentityLike,
  type SessionClientLike,
  type VmUiModule,
} from "./vm-ui-module.js";

/** 页面级提示(渲染进 DOM 的状态行;文案面向学习者,不含内部细节)。 */
export interface PageNotice {
  readonly level: "info" | "error";
  readonly text: string;
}

/** 引导结果的确定性状态码(E2E 与单测的断言锚;不做字符串匹配)。 */
export type BootStatus =
  /** 工作区已装配(会话可能仍在连接中)。 */
  | "ready"
  /** 地址不符合契约形态(不发起任何网络请求)。 */
  | "invalid-address"
  /** vm-ui 产物取不回 / 形状漂移。 */
  | "vm-ui-unavailable"
  /** `create_session` 失败(授权凭证缺失 / 过期 / 已消费 / 题目不可用)。 */
  | "session-failed";

/** 引导产物(调试与 E2E 用;生产路径不读)。 */
export interface BootResult {
  readonly status: BootStatus;
  readonly workspace: HTMLElement | null;
  readonly client: SessionClientLike | null;
  readonly notes: readonly PageNotice[];
}

/** 引导依赖(全部可注入 ⇒ 单测零网络、零真实 vm-ui 产物)。 */
export interface BootDeps {
  /** 页面挂载根(#app)。 */
  readonly root: HTMLElement;
  /** 只读的文档面注入(getter 形态,便于单测替换)。 */
  readonly readPath?: () => string;
  readonly readOrigin?: () => string;
  readonly loadModule?: () => Promise<Awaited<ReturnType<typeof loadVmUiModule>>>;
}

/** 缺省读取面(浏览器全局;单测注入替身)。 */
const defaultReadPath = (): string => globalThis.location.pathname;
const defaultReadOrigin = (): string => globalThis.location.origin;

/**
 * 地址失效的**用户可见文案**(D-LT-2「幂等」行逐字给定的口径)。
 *
 * 单列成函数是为了让 E2E / 单测断言**同一份文本**,而不是各自抄一份字符串
 * (文案漂移不会被任何类型检查发现)。
 */
export function invalidLaunchNotice(): PageNotice {
  return { level: "error", text: "地址已失效,请向平台重新获取" };
}

/** 地址形态不符(用户手打 / 被截断 / 部署前缀不对)。 */
export function malformedAddressNotice(): PageNotice {
  return {
    level: "error",
    text: "地址无效:这不是一个 StackMaster 题目启动地址(缺少题目定位路径)。",
  };
}

/** vm-ui 产物不可用(部署漏了 /vm-ui/ 目录,或产物版本与页面不匹配)。 */
export function vmUiUnavailableNotice(reason: "module-unreachable" | "module-shape-drift"): PageNotice {
  return reason === "module-unreachable"
    ? {
        level: "error",
        text: "前端资源未就绪(未找到 /vm-ui/index.js):请先构建 packages/vm-ui 与 apps/page-app。",
      }
    : {
        level: "error",
        text: "前端资源版本不匹配(/vm-ui/index.js 形状与页面期望不符):请重新构建并整体替换 dist。",
      };
}

/** 会话创建失败(401 = 授权凭证缺失 / 过期 / 已消费;其余为服务端拒绝)。 */
export function sessionFailedNotice(cause: unknown): PageNotice {
  const hint = `地址已失效,请向平台重新获取(授权凭证单次消费,不重试)。`;
  const detail = cause instanceof Error ? cause.message : "";
  return {
    level: "error",
    // 细节只作为诊断尾注:面向学习者的一句话在前,不泄露任何内部结构
    // (错误文本已经是服务端粗化后的 PublicError.message)。
    text: detail === "" ? hint : `${hint} 诊断:${detail}`,
  };
}

/** 地址形态有效但题目不可用时的提示(描述包缺席**不**走这条)。 */
export function descriptorAbsentNotice(): PageNotice {
  return {
    level: "info",
    text: "题目描述包未加载:简介与教学面暂不可用(会话不受影响)。",
  };
}

/** 描述包视图 → 工作区静态面(结构投影;字段缺失即 null = 不渲染该面)。 */
export function descriptorStaticFace(descriptor: unknown): unknown {
  if (descriptor === null || typeof descriptor !== "object") {
    return null;
  }
  const view = descriptor as Record<string, unknown>;
  const briefing = view["briefing"];
  const vmProfile = view["vmProfile"];
  if (
    briefing === null ||
    typeof briefing !== "object" ||
    vmProfile === null ||
    typeof vmProfile !== "object"
  ) {
    return null;
  }
  const briefingRecord = briefing as Record<string, unknown>;
  const profileRecord = vmProfile as Record<string, unknown>;
  const title = briefingRecord["title"];
  const summary = briefingRecord["summary"];
  if (typeof title !== "string" || typeof summary !== "string") {
    return null;
  }
  const registers = Array.isArray(profileRecord["registers"]) ? profileRecord["registers"] : [];
  const canary = profileRecord["canary"];
  return {
    title,
    summary,
    archBits: typeof profileRecord["archBits"] === "number" ? profileRecord["archBits"] : 0,
    endianness: typeof profileRecord["endianness"] === "string" ? profileRecord["endianness"] : "little",
    pageSizeBytes:
      typeof profileRecord["pageSizeBytes"] === "number" ? profileRecord["pageSizeBytes"] : 0,
    registerNames: registers
      .map((entry) =>
        entry !== null && typeof entry === "object"
          ? (entry as Record<string, unknown>)["name"]
          : undefined,
      )
      .filter((name): name is string => typeof name === "string"),
    canaryEnabled:
      canary !== null && typeof canary === "object"
        ? (canary as Record<string, unknown>)["enabled"] === true
        : false,
    encodingTable: Array.isArray(profileRecord["encodingTable"]) ? profileRecord["encodingTable"] : [],
  };
}

/** 提示行的稳定选择器(E2E 断言锚;不依赖 class 命名)。 */
export const PAGE_NOTICE_SELECTOR = "[data-page-notice]";

/** 渲染提示行(幂等:同一次引导内追加;重复挂载前先清空根)。 */
function appendNotice(root: HTMLElement, notice: PageNotice): void {
  let host = root.querySelector<HTMLElement>(PAGE_NOTICE_SELECTOR);
  if (host === null) {
    host = root.ownerDocument.createElement("p");
    host.setAttribute("data-page-notice", "true");
    host.setAttribute("role", "status");
    // 覆盖层:不参与布局(工作区恒占满视口,提示浮在其上)。
    host.style.cssText = [
      "position:fixed",
      "inset-block-start:0",
      "inset-inline:0",
      "margin:0",
      "padding:0.5rem 0.75rem",
      "font:0.8125rem/1.4 system-ui, sans-serif",
      "background:var(--sm-bg-panel, #101610)",
      "color:var(--sm-fg-dim, #6dd47f)",
      "z-index:1",
    ].join(";");
    root.append(host);
  }
  const line = root.ownerDocument.createElement("span");
  line.setAttribute("data-notice-level", notice.level);
  line.textContent = notice.text;
  if (host.childNodes.length > 0) {
    host.append(root.ownerDocument.createElement("br"));
  }
  host.append(line);
}

/**
 * 引导页面(幂等:先清空挂载根)。
 *
 * @returns 引导结果(状态码 + 产物);**不抛错** —— 所有失败都折叠为状态码与
 *   提示行,页面永远能渲染出一个可读的结果(白屏是最坏的失败模式)。
 */
export async function bootPage(deps: BootDeps): Promise<BootResult> {
  const readPath = deps.readPath ?? defaultReadPath;
  const readOrigin = deps.readOrigin ?? defaultReadOrigin;
  const loadModule = deps.loadModule ?? (() => loadVmUiModule());
  const root = deps.root;
  const notes: PageNotice[] = [];
  root.replaceChildren();

  const record = (notice: PageNotice): void => {
    notes.push(notice);
    appendNotice(root, notice);
  };

  // ① 路径解析(纯函数;失败 = 呈现 + 零网络请求)。
  const launch: LaunchPath | null = parseLaunchPath(readPath());
  if (launch === null) {
    record(malformedAddressNotice());
    return { status: "invalid-address", workspace: null, client: null, notes };
  }

  // ② vm-ui 产物(运行期 URL 加载;见 vm-ui-module.ts)。
  const loaded = await loadModule();
  if (!loaded.ok) {
    record(vmUiUnavailableNotice(loaded.reason));
    return { status: "vm-ui-unavailable", workspace: null, client: null, notes };
  }
  const vmUi: VmUiModule = loaded.module;

  // ③④ 建会话(授权来自 Cookie;同源相对路径 ⇒ 不传 baseUrl)。
  const client = new vmUi.SessionClient();
  const identity: LaunchIdentityLike = {
    challengeId: launch.challengeId,
    challengeVersion: launch.version,
  };
  try {
    await client.createSession(identity);
  } catch (error) {
    // 单次消费的凭证:重试在语义上不可能成功 ⇒ **不重试**,直接呈现失效。
    record(sessionFailedNotice(error));
    return { status: "session-failed", workspace: null, client: null, notes };
  }

  // ⑤ 认证通道(失败不阻塞装配:断线重连由 SessionClient 状态机承担)。
  client.connect();

  // ⑥ 公开描述包(同源;失败 = 缺席明示,不阻塞会话)。
  const origin = readOrigin();
  let descriptorView: unknown = null;
  let descriptorLoaded = false;
  try {
    const outcome = await vmUi.fetchChallengeDescriptor({
      sessionApiOrigin: origin,
      challengeId: launch.challengeId,
      challengeVersion: launch.version,
    });
    if (outcome.ok) {
      descriptorView = outcome.descriptor;
      descriptorLoaded = true;
    }
  } catch {
    // 取包抛错(网络 / 护栏)等同缺席:会话不受影响。
    descriptorLoaded = false;
  }

  // ⑦ 挂工作区 + 注组合根属性(属性面以 sm-workspace 的 @property 声明为准)。
  const workspace = root.ownerDocument.createElement(WORKSPACE_ELEMENT_TAG) as HTMLElement & {
    client?: SessionClientLike | null;
    debugModeAvailable?: boolean;
    challengeDescriptor?: unknown;
    challengeStatic?: unknown;
    descriptorStatus?: string;
  };
  workspace.setAttribute("data-page-app-workspace", "true");
  // 描述包缺席 ⇒ `absent`(缺席明示面板);拿到才 `loaded`。
  workspace.descriptorStatus = descriptorLoaded ? "loaded" : "absent";
  if (descriptorLoaded) {
    const view =
      descriptorView !== null && typeof descriptorView === "object"
        ? (descriptorView as Record<string, unknown>)
        : {};
    const hintLadder = view["hintLadder"];
    const publicErrorMapping = view["publicErrorMapping"];
    workspace.challengeDescriptor = {
      hintLadder: Array.isArray(hintLadder) ? hintLadder : [],
      publicErrorMapping: Array.isArray(publicErrorMapping) ? publicErrorMapping : [],
    };
    // 静态面不齐备(缺 briefing / vmProfile)⇒ 该面取 null = 不渲染,描述包的
    // 其余部分(hintLadder / 错误注解)仍已注入。
    workspace.challengeStatic = descriptorStaticFace(descriptorView);
    // debugMode 是 opt-out(缺省即启用;仅显式 false 关闭)——与正式通道
    // 归一化口径一致(见 vm-ui `parseDescriptorView`)。
    workspace.debugModeAvailable = view["debugMode"] !== false;
  } else {
    workspace.debugModeAvailable = false;
    record(descriptorAbsentNotice());
  }
  // 组合根注入:换绑即由工作区自建公开档数据源(`new ProjectionDataSource(
  // client.store)`);此处**不**同时注入 dataSource(避免两个来源相争)。
  workspace.client = client;
  root.append(workspace);

  return { status: "ready", workspace, client, notes };
}

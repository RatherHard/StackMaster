/**
 * 宿主模拟页逻辑(WP-51 联调面,非交付物)。
 *
 * 流程(D-API-75 MVP 演示面,通道 a):
 *  1. 宿主(CSPRNG)生成 esid——经 embed-runtime 的 generateEmbedSessionId;
 *  2. 页面(宿主平台)调 vite 代理层的宿主后端替身 `POST /host-api/embed-tokens`
 *     签发 embed token(凭证只存页面内存);
 *  3. 建 iframe(src 只带 `#esid=<esid>`),握手完成(ready)后面板更新;
 *  4. 「经 port 下发 token」演示 D-API-75 备用通道(握手后 MessageChannel);
 *  5. 主题 / 语言按钮演示控制面;「iframe 重载」演示 §4.5(新 esid、旧值作废)。
 *
 * 加载模型:embed-runtime 产物经 /vendor/embed-runtime 动态 import(变量 URL,
 * @vite-ignore,不进构建图)——与 plugin-dev main.ts 加载 vm-ui 产物同款,
 * 不产生 apps → 浏览器包的静态依赖边(dependency-cruiser 纪律)。
 */

/* ── embed-runtime 产物动态加载(运行时 URL)───────────────────────────── */

const runtimeUrl = "/vendor/embed-runtime/index.js";

async function loadRuntime() {
  return import(/* @vite-ignore */ runtimeUrl);
}

/* ── DOM 读取与面板渲染 ──────────────────────────────────────────────── */

const el = (id) => document.getElementById(id);

function readContext() {
  return {
    tenantId: el("tenant-id").value.trim() || "e2e-tenant",
    userId: el("user-id").value.trim() || "e2e-user",
    challengeId: el("challenge-id").value.trim() || "chal-e2e-plugin-dev",
    challengeVersion: el("challenge-version").value.trim() || "1.0.0",
  };
}

function logEvent(text) {
  const list = el("event-log");
  const item = document.createElement("li");
  item.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  list.append(item);
  list.scrollTop = list.scrollHeight;
}

function renderState(session, note) {
  el("state").textContent = note ?? session.getState();
  el("esid").textContent = session.getEmbedSessionId();
  el("negotiated").textContent = String(session.getNegotiatedVersion() ?? "—");
  el("granted").textContent =
    session.getGrantedCapabilities().length > 0
      ? session.getGrantedCapabilities().join(", ")
      : session.getState() === "ready"
        ? "(空数组:完全静态形态)"
        : "—";
}

function renderCounters(counters) {
  const tbody = el("counters").querySelector("tbody");
  tbody.replaceChildren();
  for (const [key, value] of Object.entries(counters)) {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    const count = document.createElement("td");
    name.textContent = key;
    count.textContent = String(value);
    row.append(name, count);
    tbody.append(row);
  }
}

/* ── 嵌入会话装配 ────────────────────────────────────────────────────── */

const state = { session: null, iframe: null, embedToken: null, runtime: null };

function pluginOriginOf(pluginUrl) {
  return new URL(pluginUrl, window.location.href).origin;
}

function removeIframe() {
  if (state.iframe !== null) {
    state.iframe.remove();
    state.iframe = null;
  }
}

/** 建 iframe 并挂接会话事件(opaque 开关决定 sandbox 与握手路径)。 */
function mountIframe(session, opaque) {
  removeIframe();
  const iframe = document.createElement("iframe");
  iframe.title = "嵌入的题目工作区(联调)";
  iframe.setAttribute("data-testid", "host-mock-iframe");
  // opaque 演示 = sandbox 无 allow-same-origin(§4.2);同源演示允许同源以便
  // 桩页经 POST 体取回引导配置(通道 a)。真实部署为独立来源 iframe。
  iframe.sandbox = opaque ? "allow-scripts allow-forms" : "allow-scripts allow-same-origin allow-forms";
  iframe.src = session.buildIframeSrc();
  // 挂接 iframe(V-1' / V-5 窗口绑定:source === iframe.contentWindow;
  // WP-52 修正:缺失时 contentWindow 绑定为 null,一切 hello 被 fail-closed 拒绝)。
  session.attachIframe(iframe);
  iframe.addEventListener("load", () => session.notifyIframeLoad());
  el("iframe-slot").replaceChildren(iframe);
  state.iframe = iframe;
}

/** 宿主可授予能力集(WP-55 诊断控制:三勾选框;空集 = 完全静态形态)。 */
function readGrantableCapabilities() {
  const granted = [];
  if (el("cap-auto-resize").checked) granted.push("auto_resize");
  if (el("cap-theme").checked) granted.push("theme");
  if (el("cap-language").checked) granted.push("language");
  return granted;
}

function bindSessionEvents(session) {
  const { EMBED_SESSION_EVENTS } = state.runtime;
  session.addEventListener(EMBED_SESSION_EVENTS.handshakeComplete, (event) => {
    renderState(session, "ready(握手完成)");
    logEvent(`握手完成:协商版本 ${event.detail.negotiatedVersion},授予 [${event.detail.grantedCapabilities.join(", ")}]`);
    setControlEnabled(true);
  });
  session.addEventListener(EMBED_SESSION_EVENTS.sessionUnavailable, (event) => {
    renderState(session, `不可用(${event.detail.reason})`);
    logEvent(`embed 会话不可用:${event.detail.reason}——控制面投递已停止(§4.5)`);
    setControlEnabled(false);
  });
  session.addEventListener(EMBED_SESSION_EVENTS.violationCountersChanged, (event) => {
    renderCounters(event.detail.counters);
  });
  session.addEventListener(EMBED_SESSION_EVENTS.heightChanged, (event) => {
    logEvent(`height_changed:${event.detail.heightPx}px${event.detail.clamped ? "(已被宿主收紧)" : ""}`);
    state.iframe.style.blockSize = `${Math.min(960, Math.max(240, event.detail.heightPx))}px`;
  });
  session.addEventListener(EMBED_SESSION_EVENTS.reloadInitiated, (event) => {
    logEvent(`重载发起:新 esid ${event.detail.sessionId}`);
  });
  renderCounters(session.getViolationCounters());
}

function setControlEnabled(enabled) {
  for (const id of ["port-button", "theme-select", "language-select"]) {
    el(id).disabled = !enabled;
  }
  el("reload-button").disabled = false;
  el("dispose-button").disabled = false;
}

/** 签发并嵌入:esid 生成 → token 签发代理 → 建 iframe → 握手。 */
async function embed() {
  const runtime = state.runtime;
  if (runtime === null) return;
  disposeSession("重新嵌入前解除旧会话");
  const context = readContext();
  const opaque = el("opaque-mode").checked;
  const pluginUrl = el("plugin-url").value.trim();

  // 1. 宿主生成 esid(CSPRNG ≥128bit,base64url 恰 22 字符)。
  const esid = runtime.generateEmbedSessionId((size) => {
    const out = new Uint8Array(size);
    globalThis.crypto.getRandomValues(out);
    return out;
  });

  // 2. 经宿主后端替身签发 embed token(POST;token 只存页面内存,不落日志)。
  let issued;
  try {
    const response = await fetch("/host-api/embed-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...context, embedSessionId: esid }),
    });
    issued = await response.json();
    if (!response.ok) {
      throw new Error(issued?.message ?? `HTTP ${response.status}`);
    }
  } catch (error) {
    logEvent(`签发失败:${error instanceof Error ? error.message : String(error)}(核对 SESSION_API_HOST_BACKEND_TOKEN 与 compose 拓扑)`);
    return;
  }
  state.embedToken = issued.embedToken;
  logEvent(`embed token 已签发(内存持有,过期时刻 ${issued.expiresAt});esid=${esid}`);

  // 3. 建会话 + iframe(opaque 开关切换 §4.1 / §4.2 路径)。
  // 显式传 sessionId:签发记录与 iframe fragment 的 esid 必须同值(D-API-75
  // 通道 a 的一致性前提——插件以 fragment esid 换取的引导配置由该签发登记担保;
  // WP-52 修正:不传时 SDK 自行生成新 esid,与签发 esid 脱节,引导取回必 404)。
  const session = runtime.createEmbedSession({
    pluginUrl,
    pluginOrigin: pluginOriginOf(pluginUrl),
    opaqueOrigin: opaque,
    config: { theme: el("theme-select").value || "light", language: el("language-select").value || "zh-CN" },
    sessionId: esid,
    // 能力降级诊断(WP-55 §4.4 矩阵):宿主可授予集 = 勾选交集;未勾选项
    // 即便插件 hello 声明也不授予(V-8 的宿主侧授予面)。
    grantableCapabilities: readGrantableCapabilities(),
  });
  state.session = session;
  bindSessionEvents(session);
  mountIframe(session, opaque);
  renderState(session, "awaiting-hello(等待插件 hello)");
  logEvent(`iframe 已创建:${session.buildIframeSrc()}(fragment 只携带 esid)`);
}

/** iframe 重载(§4.5):新 esid、旧值作废、重走握手;token 由宿主重新签发。 */
async function reload() {
  const session = state.session;
  if (session === null) return;
  const detail = session.reload();
  const context = readContext();
  // 如适用申请新 token:旧 token 因会话绑定不匹配自然失效(嵌入协议 §6.2)。
  try {
    const response = await fetch("/host-api/embed-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...context, embedSessionId: detail.sessionId }),
    });
    const issued = await response.json();
    if (response.ok) {
      state.embedToken = issued.embedToken;
      logEvent(`重载后 token 已重新签发(新 esid);旧 esid 已作废(V-5)`);
    }
  } catch {
    logEvent("重载后 token 签发失败(握手仍可进行;create-session 将不可用)");
  }
  mountIframe(state.session, el("opaque-mode").checked);
  renderState(state.session, "awaiting-hello(重载后等待 hello)");
}

/** 经 port 下发 token(D-API-75 备用通道;port 转移为必需前置,V-13)。 */
function deliverViaPort() {
  const session = state.session;
  if (session === null || state.embedToken === null) return;
  try {
    session.deliverTokenViaPort(state.embedToken);
    logEvent("token 已经 MessageChannel port 下发(port 转移前置已满足;桩插件侧不消费,正式插件归 WP-52)");
  } catch (error) {
    logEvent(`port 下发被拒:${error instanceof Error ? error.message : String(error)}`);
  }
}

function disposeSession(note) {
  if (state.session !== null) {
    state.session.dispose();
    state.session = null;
  }
  removeIframe();
  state.embedToken = null;
  setControlEnabled(false);
  el("reload-button").disabled = true;
  el("dispose-button").disabled = true;
  el("state").textContent = note ?? "未嵌入";
}

/* ── 诊断注入(WP-55 E2E;伪造消息 → 对端丢弃 + 本地计数,零反馈,V-12)── */

/** 会话内合法 esid 形态的「错值」(满足 Schema 字符集/长度,V-4 放行、V-5 落网)。 */
const FORGED_WRONG_ESID = `wrong-esid-${"0".repeat(14)}`;

/**
 * 注入伪造消息(诊断面板按钮):
 *  - 目标 = 宿主窗口:本页窗口自投递宿主→插件方向的完整信封——source 为本页
 *    窗口而非 iframe.contentWindow(origin 也非插件来源),宿主侧 V-1 / V-1'
 *    落网(不受信来源场景);
 *  - 目标 = 插件 iframe:经 iframe.contentWindow.postMessage 向插件投递伪造的
 *    宿主→插件方向控制消息——source === window.parent(V-1' 通过)、origin 为
 *    钉住值(V-1 通过),由场景字段命中 V-5 / V-6 / V-7 / V-8。
 * 一切注入的预期:对端丢弃 + 本地计数、零回复、会话不中断(插件侧计数经
 * violationCounters 诊断 getter 由 E2E 读出)。
 */
function injectForged() {
  const session = state.session;
  if (session === null) {
    logEvent("诊断注入:无活动 embed 会话(先签发并嵌入)");
    return;
  }
  const esid = session.getEmbedSessionId();
  const target = el("inject-target").value;
  const scenario = el("inject-scenario").value;

  if (target === "host-window") {
    // ready 形态信封(宿主→插件方向)投给宿主自身:方向集先于 Schema 语义,
    // 但来源检查(V-1/V-1')最先落网——两条计数都可作为断言锚。
    window.postMessage(
      {
        protocolVersion: 1,
        type: "ready",
        sessionId: esid,
        seq: 99,
        payload: { grantedCapabilities: ["theme"], config: { theme: "dark", language: "zh-CN" } },
      },
      window.location.origin,
    );
    logEvent("诊断注入 → 宿主窗口:不受信来源伪造消息(预期 V-1/V-1' 计数,零反馈)");
    return;
  }

  const contentWindow = state.iframe?.contentWindow ?? null;
  if (contentWindow === null) {
    logEvent("诊断注入:iframe 未挂接");
    return;
  }
  const pluginOrigin = pluginOriginOf(el("plugin-url").value.trim());
  const post = (message) => contentWindow.postMessage(message, pluginOrigin);
  switch (scenario) {
    case "wrong-esid-ready":
      post({
        protocolVersion: 1,
        type: "ready",
        sessionId: FORGED_WRONG_ESID,
        seq: 5,
        payload: { grantedCapabilities: ["theme"], config: { theme: "dark", language: "zh-CN" } },
      });
      logEvent("诊断注入 → 插件:ready 携带错 sessionId(预期插件 V-5 计数)");
      break;
    case "wrong-direction-hello":
      post({
        protocolVersion: 1,
        type: "hello",
        sessionId: esid,
        seq: 9,
        payload: { supportedVersions: [1], capabilities: ["theme"] },
      });
      logEvent("诊断注入 → 插件:hello 为插件→宿主方向(预期插件 V-6 计数)");
      break;
    case "stale-seq-theme":
      // seq Schema 下限 = 1:乱序形态用「已过期的合法 seq」表达(握手完成后
      // 插件侧高水位 ≥ 1,seq=1 必然 ≤ 高水位 → V-7)。
      post({
        protocolVersion: 1,
        type: "theme_changed",
        sessionId: esid,
        seq: 1,
        payload: { theme: "dark" },
      });
      logEvent("诊断注入 → 插件:theme_changed seq 过期(预期插件 V-7 计数)");
      break;
    case "ungranted-theme":
      post({
        protocolVersion: 1,
        type: "theme_changed",
        sessionId: esid,
        seq: 99,
        payload: { theme: "dark" },
      });
      logEvent("诊断注入 → 插件:theme_changed 而 theme 未授予(预期插件 V-8 计数)");
      break;
    default:
      logEvent(`诊断注入:未知场景 ${scenario}`);
  }
}

/* ── 接线 ────────────────────────────────────────────────────────────── */

async function boot() {
  try {
    state.runtime = await loadRuntime();
  } catch (error) {
    logEvent(
      `embed-runtime 产物加载失败:${error instanceof Error ? error.message : String(error)}——先执行 pnpm build 构建 packages/embed-runtime`,
    );
    el("embed-button").disabled = true;
    return;
  }
  el("embed-button").addEventListener("click", () => void embed());
  el("reload-button").addEventListener("click", () => void reload());
  el("port-button").addEventListener("click", deliverViaPort);
  el("dispose-button").addEventListener("click", () => disposeSession());
  el("inject-button").addEventListener("click", injectForged);
  el("theme-select").addEventListener("change", (event) => {
    try {
      const sent = state.session?.sendThemeChanged(event.target.value) ?? false;
      logEvent(sent ? `theme_changed 已发送(${event.target.value})` : "theme_changed 被 V-10 自限丢弃");
    } catch (error) {
      logEvent(`theme_changed 发送失败:${error instanceof Error ? error.message : String(error)}`);
    }
  });
  el("language-select").addEventListener("change", (event) => {
    try {
      const sent = state.session?.sendLanguageChanged(event.target.value) ?? false;
      logEvent(sent ? `language_changed 已发送(${event.target.value})` : "language_changed 被 V-10 自限丢弃");
    } catch (error) {
      logEvent(`language_changed 发送失败:${error instanceof Error ? error.message : String(error)}`);
    }
  });
  logEvent("宿主模拟页就绪:点击「签发并嵌入」开始 §4.1 握手(opaque 开关切换 §4.2)。");
}

void boot();

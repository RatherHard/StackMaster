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

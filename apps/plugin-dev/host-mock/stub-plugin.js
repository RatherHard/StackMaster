/**
 * 握手桩插件页逻辑(WP-51 联调桩,非交付物)。
 *
 * ⚠️ 本页是 WP-51 联调用的最小协议桩:只实现插件侧 hello 发起(重试上限内
 * seq 递增,§4.3)与 ready 消费(钉住宿主 origin,V-11),并按授予能力演示
 * height_changed 与运行时主题 / 语言消费。正式插件 Shell(iframe 内插件视图
 * 托管、create-session、vm-ui 装配)归 WP-52——本桩不做任何会话动作。
 *
 * 引导配置演示(D-API-75 通道 a):以 fragment 中的一次性 esid 经 POST 体向
 * 宿主后端取回 `{embedToken, sessionApiOrigin, …}`;token 只存页面内存、
 * 不解析、不进 URL——桩页不消费它(create-session 归 WP-52)。
 * port 凭证演示(通道 b):宿主经 MessageChannel 转移 port 后,桩页把 port
 * 收包形态记录到面板(只展示信封 kind,不显示凭证值——凭证对浏览器不透明)。
 */

const el = (id) => document.getElementById(id);

function setText(id, text) {
  el(id).textContent = text;
}

/** esid 取自 location.fragment(一次性、无权限语义;重载即轮换)。 */
function readEmbedSessionId() {
  const match = /(?:^#|&)esid=([A-Za-z0-9_-]{22,128})/.exec(window.location.hash);
  return match?.[1] ?? null;
}

const state = {
  esid: readEmbedSessionId(),
  parentOrigin: null, // ready 后钉住(V-11)
  seq: 0,
  helloSent: 0,
  helloMaxRetries: 3, // D-API-77 默认
  ready: false,
  granted: [],
};

function postToParent(message) {
  // hello 阶段插件不知道宿主来源,允许 "*"(接收面唯一为 window.parent,
  // 宿主侧 V-1/V-1'/V-5/V-7 全量补偿);ready 之后一律用钉住的明确 origin。
  const targetOrigin = state.parentOrigin ?? "*";
  window.parent.postMessage(JSON.stringify(message), targetOrigin);
}

function nextSeq() {
  state.seq += 1;
  return state.seq;
}

function sendHello() {
  if (state.ready || state.esid === null) return;
  if (state.helloSent >= state.helloMaxRetries) {
    setText("proto-state", "降级显示:T_handshake 内未收到 ready(§4.3,静态文案不重试风暴)");
    return;
  }
  state.helloSent += 1;
  postToParent({
    protocolVersion: 1,
    type: "hello",
    sessionId: state.esid,
    seq: nextSeq(),
    payload: {
      supportedVersions: [1],
      capabilities: ["theme", "language", "auto_resize"],
    },
  });
  setText("hello-count", `${state.helloSent} / 上限 ${state.helloMaxRetries}`);
  setText("proto-state", "hello 已发出,等待 ready");
}

/** 引导配置取回(D-API-75 通道 a):POST 体承载 esid,换 {embedToken, …}。 */
async function fetchBootstrapConfig() {
  if (state.esid === null) {
    setText("bootstrap", "无 esid(fragment 缺失)");
    return;
  }
  try {
    const response = await fetch("/host-api/embed-bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ embedSessionId: state.esid }),
    });
    if (!response.ok) {
      setText("bootstrap", `未取回(HTTP ${response.status};esid 单次有效,签发后须由宿主页面先行登记)`);
      return;
    }
    const config = await response.json();
    // token 只存页面内存(不解析、不校验、不显示);create-session 归 WP-52。
    window.__stubBootstrapConfig = config;
    setText(
      "bootstrap",
      `已取得(challengeId=${config.challengeId} v${config.challengeVersion};token 在内存,不解析不展示;sessionApiOrigin=${config.sessionApiOrigin})`,
    );
  } catch (error) {
    setText("bootstrap", `取回失败(${error instanceof Error ? error.message : String(error)};opaque 形态下跨源属预期)`);
  }
}

function applyReady(message, event) {
  state.ready = true;
  state.parentOrigin = event.origin; // V-11:钉住宿主 origin
  state.granted = message.payload.grantedCapabilities;
  setText("proto-state", "ready(就绪;宿主 origin 已钉住)");
  setText("config", JSON.stringify(message.payload.config));
  el("config").textContent = `theme=${message.payload.config.theme}, language=${message.payload.config.language}, 授予=[${state.granted.join(", ") || "无"}]`;
  // auto_resize 已授予:演示一次高度上报(内容变化驱动;正式实现归 WP-52)。
  if (state.granted.includes("auto_resize")) {
    const heightPx = Math.min(100000, Math.max(1, document.body.scrollHeight + 24));
    postToParent({
      protocolVersion: 1,
      type: "height_changed",
      sessionId: state.esid,
      seq: nextSeq(),
      payload: { heightPx },
    });
  }
}

/** port 收包(D-API-75 通道 b):记录信封形态,凭证值不回显(浏览器不透明)。 */
function bindPort(port) {
  port.onmessage = (event) => {
    const body = event.data;
    if (body !== null && typeof body === "object" && typeof body.kind === "string") {
      setText("port-state", `已收到 port 信封(kind=${body.kind};credential 不回显)`);
    } else if (body !== null && typeof body === "object" && typeof body.type === "string") {
      setText("last-message", `port: ${body.type} (seq ${String(body.seq)})`);
      applyControlMessage(body);
    }
  };
}

function applyControlMessage(message) {
  if (message.type === "theme_changed") {
    document.documentElement.style.colorScheme =
      message.payload.theme === "dark" ? "dark" : message.payload.theme === "light" ? "light" : "light dark";
    setText("last-message", `theme_changed → ${message.payload.theme}`);
  } else if (message.type === "language_changed") {
    setText("last-message", `language_changed → ${message.payload.language}`);
  }
}

window.addEventListener("message", (event) => {
  // port 转移消息:transfer 消息零载荷(null),port2 在 event.ports 中。
  if (event.ports.length > 0) {
    bindPort(event.ports[0]);
    setText("port-state", "port 已转移(等待凭证信封)");
    return;
  }
  // 协议信封两种到达形态都接受:字符串 JSON(桩自身的 hello 形态)与
  // 结构化对象(embed-runtime 的 ready / 控制消息形态)。
  const raw = event.data;
  let message = null;
  if (typeof raw === "string") {
    try {
      message = JSON.parse(raw);
    } catch {
      return; // 不可解析:静默丢弃(V-12 插件侧同纪律)。
    }
  } else if (raw !== null && typeof raw === "object") {
    message = raw;
  }
  if (message === null || typeof message !== "object") return;
  if (state.esid === null || message.sessionId !== state.esid) return; // V-5
  if (message.type !== "ready" && message.type !== "theme_changed" && message.type !== "language_changed") return; // V-6
  if (state.ready && event.origin !== state.parentOrigin) return; // V-1(握手后)
  setText("last-message", `${message.type} (seq ${String(message.seq)})`);
  if (message.type === "ready") {
    applyReady(message, event);
  } else {
    applyControlMessage(message);
  }
});

void (async () => {
  setText("esid", state.esid ?? "(fragment 无 esid)");
  if (state.esid === null) {
    setText("proto-state", "降级显示:fragment 缺少 esid,不发起握手");
    return;
  }
  await fetchBootstrapConfig();
  sendHello();
  // T_handshake 窗口内的重试:seq 递增(§4.3;宿主侧对重复 hello 丢弃+计数)。
  window.setInterval(() => {
    if (!state.ready) sendHello();
  }, 3000);
})();

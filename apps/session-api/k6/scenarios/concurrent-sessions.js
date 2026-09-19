/**
 * k6 场景:并发会话维持(阶段三 WP-8,质量门禁 9;D-API-73)。
 *
 * ramping-vus 阶梯爬升;每个 VU 迭代 = **启动地址链**建立会话
 * (POST `/auth/launch-tickets` → GET `launchUrl`(手工 `Sec-Fetch-Mode: navigate`、
 * `redirects: 0`)→ POST `/sessions` create v2)→ 打开 WSS 通道(会话凭证 Cookie
 * 呈递)→ 每 HEARTBEAT_ACTION_INTERVAL_MS 发一个 write_bytes 动作维持会话活跃 →
 * 保持 HOLD_MS → REST close 收尾(`protocolVersion: 2`)。ws.connect 阻塞至连接
 * 关闭,VU 全程占有一个会话——并发会话数 ≈ 活跃 VU 数。
 *
 * 服务端视角的并发数经 GET /metrics 采样(session_api_live_sessions)以
 * Trend `server_live_sessions` 记录;客户端视角以 `held_sessions`(每次成功
 * 建立会话 +1)计数。无 threshold(D-API-73)。
 *
 * ## 共享预算(WP-96;与 rest-lifecycle 同款说明)
 *
 * 新链的 `userId` 是**部署级配置**(`SESSION_API_LAUNCH_USER_ID`,缺省
 * `launch-anon`)⇒ 本场景的全部会话共用一条 `rate:{tenant}:{user}` 预算。本场景
 * 每次迭代只消耗 2 次 REST(create + close),且 HOLD_MS(缺省 20 s)远大于均摊
 * 周期 ⇒ 峰值 6 VU 时约 18 次迭代/分,距 REST 预算 120/min 与签发预算 60/min
 * 都很远,**无需额外节奏补偿**(下面仍按同一算式取 `MIN_ITERATION_MS`,使
 * `CONC_PEAK` / `HOLD_MS` 被调小到短周期时也不会静默削顶)。
 *
 * 注意:被测拓扑的租户并发预算(SESSION_API_MAX_CONCURRENT_SESSIONS_PER_TENANT,
 * 默认 8)是真实护栏——本场景峰值刻意压在预算内(≤ 6),超限拒绝属 429 冻结
 * 形态行为,不是基线采集目标。任一硬闸拒绝即 `throw`(不静默跑错链路)。
 */
import http from "k6/http";
import ws from "k6/ws";
import { Counter, Trend } from "k6/metrics";
import { sleep } from "k6";

const HELD = new Counter("held_sessions");
const SERVER_LIVE = new Trend("server_live_sessions", true);

const BASE_URL = __ENV.BASE_URL || "http://host.docker.internal:13118";
const WS_URL = `${BASE_URL.replace(/^http/, "ws")}/sessions/channel`;
const HOST_BEARER = __ENV.HOST_BEARER || "host-backend-shared-credential-0123456789";
const ORIGIN = __ENV.K6_ORIGIN || "http://localhost:13000";
const CHALLENGE_ID = __ENV.K6_CHALLENGE_ID || "chal-k6-baseline";
const CHALLENGE_VERSION = __ENV.K6_CHALLENGE_VERSION || "1.0.0";
const HOLD_MS = Number(__ENV.HOLD_MS || 20000);
const INTERVAL_MS = Number(__ENV.HEARTBEAT_ACTION_INTERVAL_MS || 2000);
const PEAK_VUS = Number(__ENV.CONC_PEAK || 6);

/** 会话动作协议版本(WP-90 起 v2;动作帧与命令体同版)。 */
const PROTOCOL_VERSION = 2;
const LAUNCH_GRANT_COOKIE = "sm_launch_grant";
const SESSION_CREDENTIAL_COOKIE = "sm_session_credential";
/** 本场景每次迭代消耗的 `rate:{tenant}:{user}` REST 调用数(create + close)。 */
const REST_CALLS_PER_ITERATION = 2;

const ISSUANCE_PER_MINUTE = Number(__ENV.LAUNCH_ISSUANCE_PER_MINUTE || 60);
const REST_PER_MINUTE = Number(__ENV.REST_REQUESTS_PER_MINUTE || 120);
/** 每 VU 的最小迭代周期(共享预算均摊;本场景实际由 HOLD_MS 主导)。 */
const MIN_ITERATION_MS = Math.ceil(
  Math.max(
    60_000 / ISSUANCE_PER_MINUTE,
    (60_000 / REST_PER_MINUTE) * REST_CALLS_PER_ITERATION,
  ) * PEAK_VUS * 1.1,
);

export const options = {
  scenarios: {
    concurrent_sessions: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "5s", target: PEAK_VUS },
        { duration: "20s", target: PEAK_VUS },
        { duration: "5s", target: 0 },
      ],
      gracefulStop: "10s",
    },
  },
};

function post(path, body, headers = {}) {
  return http.post(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: Object.assign({ "content-type": "application/json", origin: ORIGIN }, headers),
    tags: { name: path },
  });
}

/** 大小写不敏感地读响应头(沿既有双查写法,k6 头键大小写随版本而变)。 */
function headerValue(response, name) {
  const target = name.toLowerCase();
  const keys = Object.keys(response.headers);
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index].toLowerCase() === target) {
      return response.headers[keys[index]];
    }
  }
  return "";
}

/** 从 Set-Cookie 里取指定 Cookie 的值(多 Cookie 时 k6 以逗号连接)。 */
function cookieValue(response, name) {
  const raw = headerValue(response, "set-cookie");
  const parts = String(raw).split(",");
  for (let index = 0; index < parts.length; index += 1) {
    const pair = parts[index].trim().split(";")[0];
    const separator = pair.indexOf("=");
    if (separator > 0 && pair.slice(0, separator).trim() === name) {
      return pair.slice(separator + 1).trim();
    }
  }
  return "";
}

/** 见 rest-lifecycle 文件头:k6 无浏览器语义,origin 重新基到 BASE_URL;票据不入 tag。 */
function redeemUrlOf(launchUrl) {
  const path = String(launchUrl).replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+/, "");
  if (path.indexOf("/app/c/") !== 0) {
    throw new Error("launchUrl 形态不符(应以 /app/c/ 开头)");
  }
  return `${BASE_URL}${path}`;
}

/** 启动地址链(签发 → 换票 → create_session v2);返回会话凭证 Cookie 材料。 */
function createSessionViaLaunchAddress() {
  const issued = post(
    "/auth/launch-tickets",
    { challengeId: CHALLENGE_ID, version: CHALLENGE_VERSION },
    { authorization: `Bearer ${HOST_BEARER}` },
  );
  if (issued.status !== 201) {
    throw new Error(`启动票据签发失败:${issued.status}`);
  }
  const launchUrl = issued.json("launchUrl");
  if (typeof launchUrl !== "string" || launchUrl === "") {
    throw new Error("签发响应缺少 launchUrl(契约恰两键 {launchUrl, expiresAt})");
  }

  const redeemed = http.get(redeemUrlOf(launchUrl), {
    headers: { "sec-fetch-mode": "navigate" },
    redirects: 0,
    tags: { name: "/app/c/:challengeId/:version" },
  });
  if (redeemed.status !== 302) {
    throw new Error(`换票失败(期望 302):${redeemed.status}`);
  }
  const grant = cookieValue(redeemed, LAUNCH_GRANT_COOKIE);
  if (grant === "") {
    throw new Error(`换票响应缺少 ${LAUNCH_GRANT_COOKIE} Cookie`);
  }

  const created = post("/sessions", {
    command: "create_session",
    protocolVersion: PROTOCOL_VERSION,
    payload: { challengeId: CHALLENGE_ID, challengeVersion: CHALLENGE_VERSION },
  }, { cookie: `${LAUNCH_GRANT_COOKIE}=${grant}` });
  if (created.status !== 201) {
    throw new Error(`create 失败:${created.status}`);
  }
  const sessionId = created.json("payload.sessionId");
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new Error("create_session 响应缺少 payload.sessionId");
  }
  const credential = cookieValue(created, SESSION_CREDENTIAL_COOKIE);
  if (credential === "") {
    throw new Error(`create_session 响应缺少 ${SESSION_CREDENTIAL_COOKIE} Cookie`);
  }
  return { sessionId, credential };
}

export default function () {
  const started = Date.now();
  const { sessionId, credential } = createSessionViaLaunchAddress();
  /** 幂等键前缀(每会话唯一;替代旧链的 embedSessionId 用途)。 */
  const runTag = `k6-conc-${__VU}-${__ITER}-${Date.now().toString(36)}`;
  HELD.add(1);

  // 服务端并发会话 gauge 采样(指标面观察;轮询即基线数据的一部分)。
  const metricsSample = http.get(`${BASE_URL}/metrics`, { tags: { name: "/metrics" } });
  const liveMatch = /session_api_live_sessions (\d+)/.exec(metricsSample.body || "");
  if (liveMatch !== null) {
    SERVER_LIVE.add(Number(liveMatch[1]));
  }

  const sessionCookie = { cookie: `${SESSION_CREDENTIAL_COOKIE}=${credential}` };
  ws.connect(WS_URL, { headers: sessionCookie }, (socket) => {
    let seq = 0;
    const act = () => {
      seq += 1;
      socket.send(JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "action",
        sessionId,
        seq,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          sessionId,
          clientSeq: seq,
          baseRevision: seq - 1,
          idempotencyKey: `${runTag}-${seq}`,
          action: { type: "write_bytes", args: { addressHex: "0x7ffff000", bytesHex: "0102" } },
        },
      }));
      if (Date.now() - openedAt < HOLD_MS - INTERVAL_MS) {
        socket.setTimeout(act, INTERVAL_MS);
      } else {
        socket.close();
      }
    };
    const openedAt = Date.now();
    socket.on("open", () => {
      socket.setTimeout(act, INTERVAL_MS);
    });
    socket.on("close", () => {
      post("/sessions/close", {
        command: "close_session",
        protocolVersion: PROTOCOL_VERSION,
        payload: { sessionId },
      }, sessionCookie);
    });
  });

  const elapsed = Date.now() - started;
  if (elapsed < MIN_ITERATION_MS) {
    sleep((MIN_ITERATION_MS - elapsed) / 1000);
  }
}

export function handleSummary(data) {
  const condensed = {};
  for (const [name, metric] of Object.entries(data.metrics)) {
    condensed[name] = metric.values !== undefined
      ? Object.fromEntries(Object.entries(metric.values).map(([k, v]) => [k, typeof v === "number" ? Number(v.toFixed(3)) : v]))
      : metric;
  }
  return {
    stdout: JSON.stringify({
      scenario: "concurrent-sessions",
      chain: "launch-address/v2",
      minIterationMs: MIN_ITERATION_MS,
      endedAt: new Date().toISOString(),
      testRunDurationMs: data.state ? data.state.testRunDurationMs : undefined,
      metrics: condensed,
    }, null, 2),
  };
}

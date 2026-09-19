/**
 * k6 场景:WSS 动作 RTT(阶段三 WP-8,质量门禁 9;D-API-73)。
 *
 * 链路(WP-96 起 = **启动地址链**,旧链 `/auth/embed-tokens` 与四键载荷已退役):
 * POST `/auth/launch-tickets`(宿主凭证;体恰两键)→ GET `launchUrl`
 * (**手工补 `Sec-Fetch-Mode: navigate`**、`redirects: 0` 接住 `Set-Cookie:
 * sm_launch_grant`)→ POST `/sessions` create(**v2,payload 恰两键**;授权来自
 * 授权凭证 Cookie;响应 `Set-Cookie: sm_session_credential`)→ GET
 * `/sessions/channel` 升级(k6/ws,Cookie 呈递)→ stop-and-wait 发送 write_bytes
 * 动作帧(帧与载荷 `protocolVersion: 2`),逐帧测量 RTT → POST `/sessions/close`。
 *
 * 指标:custom Trend `wss_action_rtt_ms`(逐动作);create/close 的 REST
 * 时延由 k6 内建 http_req_duration(按 name 标签分道)承载。
 * 铁律:不设 threshold(10.3 / 13.6——数据作为 T2 触发判据基线,避免过早优化)。
 *
 * ## 共享预算(WP-96;与 rest-lifecycle 同款说明)
 *
 * 新链的 `userId` 由服务端配置派生(`SESSION_API_LAUNCH_USER_ID`,缺省
 * `launch-anon`)⇒ 全部会话共用一条 `rate:{tenant}:{user}` 预算;旧脚本的
 * 「每迭代唯一用户」在结构上不可用。本场景每迭代消耗 2 次 REST(create + close)
 * + 1 次签发 ⇒ 按两条预算均摊出 `MIN_ITERATION_MS`(见常量);ⓘ WSS 动作本身受
 * **每连接令牌桶**(`SESSION_API_WSS_MESSAGE_RATE_PER_SECOND`,缺省 30/s)约束,
 * 与 REST 预算无关 —— 缺省动作间隔 50 ms(= 20 次/s)仍在其内。
 *
 * 任一硬闸拒绝(签发 / 换票 / create / close 非期望状态码)即 `throw`:不允许
 * 脚本静默跑在半数被拒的状态(旧形态的"被 429 削顶但照出数字"不再出现)。
 *
 * 运行(docker grafana/k6,见 apps/session-api/README.md §六):
 *   docker run --rm -i -e BASE_URL=http://host.docker.internal:13118 grafana/k6 run - < scenarios/action-rtt-wss.js
 *
 * 环境变量:BASE_URL(缺省 http://host.docker.internal:13118)、
 * HOST_BEARER(与被测拓扑的 SESSION_API_HOST_BACKEND_TOKEN 一致,dev 合成值)、
 * K6_CHALLENGE_ID / K6_CHALLENGE_VERSION(缺省 chal-k6-baseline / 1.0.0;题目
 * **必须登记在宿主凭证绑定的锚租户下**,否则 create_session 422,见
 * k6/seed-challenge.mjs 的租户纪律段)、
 * ACTIONS_PER_ITER(每次迭代动作数,缺省 8)、ACTION_INTERVAL_MS(动作间隔,缺省 50,
 * 保持每连接速率低于 D-API-43 的默认令牌桶 30/s)、
 * LAUNCH_ISSUANCE_PER_MINUTE / REST_REQUESTS_PER_MINUTE(拓扑的两条预算值,用于
 * 均摊节奏;run-baseline 会从 compose/integration.env 自动对齐)。
 */
import http from "k6/http";
import ws from "k6/ws";
import { Trend, Counter } from "k6/metrics";
import { sleep } from "k6";

const ACTION_RTT = new Trend("wss_action_rtt_ms", true);
const ACTIONS_OK = new Counter("wss_actions_confirmed");
const SESSIONS_CREATED = new Counter("sessions_created");

const BASE_URL = __ENV.BASE_URL || "http://host.docker.internal:13118";
const WS_URL = `${BASE_URL.replace(/^http/, "ws")}/sessions/channel`;
const HOST_BEARER = __ENV.HOST_BEARER || "host-backend-shared-credential-0123456789";
const ACTIONS_PER_ITER = Number(__ENV.ACTIONS_PER_ITER || 8);
const ACTION_INTERVAL_MS = Number(__ENV.ACTION_INTERVAL_MS || 50);
const ORIGIN = __ENV.K6_ORIGIN || "http://localhost:13000";
const CHALLENGE_ID = __ENV.K6_CHALLENGE_ID || "chal-k6-baseline";
const CHALLENGE_VERSION = __ENV.K6_CHALLENGE_VERSION || "1.0.0";

/** 会话动作协议版本(WP-90 起 v2;传输帧与帧内载荷同版)。 */
const PROTOCOL_VERSION = 2;
const LAUNCH_GRANT_COOKIE = "sm_launch_grant";
const SESSION_CREDENTIAL_COOKIE = "sm_session_credential";
/** 本场景每次迭代消耗的 `rate:{tenant}:{user}` REST 调用数(create + close)。 */
const REST_CALLS_PER_ITERATION = 2;

const ACTION_VUS = Number(__ENV.ACTION_VUS || 2);
const ISSUANCE_PER_MINUTE = Number(__ENV.LAUNCH_ISSUANCE_PER_MINUTE || 60);
const REST_PER_MINUTE = Number(__ENV.REST_REQUESTS_PER_MINUTE || 120);
const MIN_ITERATION_MS = Math.ceil(
  Math.max(
    60_000 / ISSUANCE_PER_MINUTE,
    (60_000 / REST_PER_MINUTE) * REST_CALLS_PER_ITERATION,
  ) * ACTION_VUS * 1.1,
);

function postJson(path, body, headers = {}) {
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

/**
 * `launchUrl` 重新基到 `BASE_URL`(`SESSION_API_PUBLIC_ORIGIN` 是浏览器视角的源,
 * k6 容器内不可达)⇒ 只取 path+query。⚠ 结果携带一次性票据:**不入 tag / 日志 /
 * 断言消息**(换票请求的 tag 用静态路由模板)。
 */
function redeemUrlOf(launchUrl) {
  const path = String(launchUrl).replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+/, "");
  if (path.indexOf("/app/c/") !== 0) {
    throw new Error("launchUrl 形态不符(应以 /app/c/ 开头)");
  }
  return `${BASE_URL}${path}`;
}

/** 启动地址链:签发 → 换票(手工 navigate + 不跟随 302)→ create_session v2。 */
function createSessionViaLaunchAddress() {
  const issued = postJson(
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

  const created = postJson("/sessions", {
    command: "create_session",
    protocolVersion: PROTOCOL_VERSION,
    payload: { challengeId: CHALLENGE_ID, challengeVersion: CHALLENGE_VERSION },
  }, { cookie: `${LAUNCH_GRANT_COOKIE}=${grant}` });
  if (created.status !== 201) {
    throw new Error(`create_session 失败:${created.status}`);
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

export const options = {
  // 无 threshold(D-API-73:首采不设通过阈值)。
  scenarios: {
    action_rtt: {
      executor: "constant-vus",
      vus: ACTION_VUS,
      duration: __ENV.ACTION_DURATION || "30s",
      gracefulStop: "5s",
    },
  },
};

export default function () {
  const started = Date.now();
  const { sessionId, credential } = createSessionViaLaunchAddress();
  /** 幂等键前缀(每会话唯一;替代旧链的 embedSessionId 用途)。 */
  const runTag = `k6-rtt-${__VU}-${__ITER}-${Date.now().toString(36)}`;
  SESSIONS_CREATED.add(1);
  const sessionCookie = { cookie: `${SESSION_CREDENTIAL_COOKIE}=${credential}` };

  // WSS 通道:Cookie 呈递会话凭证;stop-and-wait 逐帧测量 RTT。
  ws.connect(WS_URL, { headers: sessionCookie }, (socket) => {
    let seq = 0;
    let sentAt = 0;
    const sendNextAction = () => {
      seq += 1;
      sentAt = Date.now();
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
    };
    socket.on("open", () => {
      sendNextAction();
    });
    socket.on("message", (data) => {
      const frame = JSON.parse(data);
      if (frame.type !== "action_response") {
        return; // 错误帧等不计入 RTT(基线采集动作面)。
      }
      ACTION_RTT.add(Date.now() - sentAt);
      ACTIONS_OK.add(1);
      if (seq >= ACTIONS_PER_ITER) {
        socket.close();
        return;
      }
      if (ACTION_INTERVAL_MS > 0) {
        socket.setTimeout(() => {
          sendNextAction();
        }, ACTION_INTERVAL_MS);
      } else {
        sendNextAction();
      }
    });
    socket.on("close", () => {
      const closed = http.post(`${BASE_URL}/sessions/close`, JSON.stringify({
        command: "close_session",
        protocolVersion: PROTOCOL_VERSION,
        payload: { sessionId },
      }), {
        headers: Object.assign({
          "content-type": "application/json",
          origin: ORIGIN,
        }, sessionCookie),
        tags: { name: "/sessions/close" },
      });
      if (closed.status !== 200) {
        throw new Error(`close_session 失败:${closed.status}`);
      }
    });
  });

  const elapsed = Date.now() - started;
  if (elapsed < MIN_ITERATION_MS) {
    sleep((MIN_ITERATION_MS - elapsed) / 1000);
  }
}

export function handleSummary(data) {
  // 原始 summary JSON 到 stdout(runner 归档为 results/<ts>/<scenario>.json)。
  const condensed = {};
  for (const [name, metric] of Object.entries(data.metrics)) {
    condensed[name] = metric.values !== undefined
      ? Object.fromEntries(Object.entries(metric.values).map(([k, v]) => [k, typeof v === "number" ? Number(v.toFixed(3)) : v]))
      : metric;
  }
  return {
    stdout: JSON.stringify({
      scenario: "action-rtt-wss",
      chain: "launch-address/v2",
      minIterationMs: MIN_ITERATION_MS,
      endedAt: new Date().toISOString(),
      testRunDurationMs: data.state ? data.state.testRunDurationMs : undefined,
      metrics: condensed,
    }, null, 2),
  };
}

/**
 * k6 场景:WSS 动作 RTT(阶段三 WP-8,质量门禁 9;D-API-73)。
 *
 * 链路:POST /auth/embed-tokens → POST /sessions(Set-Cookie 会话凭证)→
 * GET /sessions/channel 升级(k6/ws,Cookie 呈递)→ stop-and-wait 发送
 * write_bytes 动作帧,逐帧测量 RTT → POST /sessions/close 收尾。
 *
 * 指标:custom Trend `wss_action_rtt_ms`(逐动作);create/close 的 REST
 * 时延由 k6 内建 http_req_duration(按 name 标签分道)承载。
 * 铁律:不设 threshold(10.3 / 13.6——数据作为 T2 触发判据基线,避免过早优化)。
 *
 * 运行(docker grafana/k6,见 apps/session-api/README.md):
 *   docker run --rm -i -e BASE_URL=http://host.docker.internal:13118 grafana/k6 run - < scenarios/action-rtt-wss.js
 *
 * 环境变量:BASE_URL(缺省 http://host.docker.internal:13118)、
 * HOST_BEARER(与被测拓扑的 SESSION_API_HOST_BACKEND_TOKEN 一致,dev 合成值)、
 * ACTIONS_PER_ITER(每次迭代动作数,缺省 8)、ACTION_INTERVAL_MS(动作间隔,缺省 50,
 * 保持每连接速率低于 D-API-43 的默认令牌桶 30/s)。
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

function postJson(path, body, headers = {}) {
  return http.post(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: Object.assign({ "content-type": "application/json", origin: ORIGIN }, headers),
    tags: { name: path },
  });
}

/** 嵌入会话标识(契约下限 22 字符,EMBED_SESSION_ID_MIN_LENGTH;128-bit 语感)。 */
function makeEmbedSessionId(tag) {
  let id = `k6-${tag}-${__VU}-${__ITER}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  while (id.length < 22) {
    id += "0";
  }
  return id;
}

/** 每迭代唯一用户(限流执行点是 (tenant,user) 120/min 固定窗口,D-API-50;
 * 唯一用户使持续建会话的基线负载不被生产护栏刻意削顶)。 */
function makeUserId(tag) {
  return `k6-${tag}-user-${__VU}-${__ITER}`;
}

function extractSessionCredential(response) {
  const header = response.headers["Set-Cookie"] || response.headers["set-cookie"];
  if (!header) {
    throw new Error("create_session 响应缺少 Set-Cookie");
  }
  const pairs = header.split(",");
  for (const candidate of pairs) {
    const trimmed = candidate.trim();
    if (trimmed.startsWith("sm_session_credential=")) {
      return trimmed.slice("sm_session_credential=".length, trimmed.indexOf(";", 0) === -1 ? trimmed.length : trimmed.indexOf(";", 0));
    }
  }
  throw new Error(`Set-Cookie 无会话凭证:${header.slice(0, 64)}`);
}

export const options = {
  // 无 threshold(D-API-73:首采不设通过阈值)。
  scenarios: {
    action_rtt: {
      executor: "constant-vus",
      vus: Number(__ENV.ACTION_VUS || 2),
      duration: __ENV.ACTION_DURATION || "30s",
      gracefulStop: "5s",
    },
  },
};

export default function () {
  const embedSessionId = makeEmbedSessionId("rtt");
  const issued = postJson("/auth/embed-tokens", {
    tenantId: "k6-tenant",
    userId: makeUserId("rtt"),
    challengeId: __ENV.K6_CHALLENGE_ID || "chal-k6-baseline",
    challengeVersion: "1.0.0",
    embedSessionId,
  }, { authorization: `Bearer ${HOST_BEARER}` });
  if (issued.status !== 201) {
    throw new Error(`embed token 签发失败:${issued.status}`);
  }
  const embedToken = issued.json("embedToken");

  const created = postJson("/sessions", {
    command: "create_session",
    protocolVersion: 1,
    payload: {
      challengeId: __ENV.K6_CHALLENGE_ID || "chal-k6-baseline",
      challengeVersion: "1.0.0",
      embedSessionId,
      embedToken,
    },
  }, { authorization: `Bearer ${HOST_BEARER}` });
  if (created.status !== 201) {
    throw new Error(`create_session 失败:${created.status}`);
  }
  const sessionId = created.json("payload.sessionId");
  const credential = extractSessionCredential(created);
  SESSIONS_CREATED.add(1);

  // WSS 通道:Cookie 呈递会话凭证;stop-and-wait 逐帧测量 RTT。
  ws.connect(WS_URL, { headers: { Cookie: `sm_session_credential=${credential}` } }, (socket) => {
    let seq = 0;
    let sentAt = 0;
    const sendNextAction = () => {
      seq += 1;
      sentAt = Date.now();
      socket.send(JSON.stringify({
        protocolVersion: 1,
        type: "action",
        sessionId,
        seq,
        payload: {
          protocolVersion: 1,
          sessionId,
          clientSeq: seq,
          baseRevision: seq - 1,
          idempotencyKey: `k6-${embedSessionId}-${seq}`,
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
      http.post(`${BASE_URL}/sessions/close`, JSON.stringify({
        command: "close_session",
        protocolVersion: 1,
        payload: { sessionId },
      }), {
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          cookie: `sm_session_credential=${credential}`,
        },
        tags: { name: "/sessions/close" },
      });
    });
  });

  sleep(0.1);
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
      endedAt: new Date().toISOString(),
      testRunDurationMs: data.state ? data.state.testRunDurationMs : undefined,
      metrics: condensed,
    }, null, 2),
  };
}

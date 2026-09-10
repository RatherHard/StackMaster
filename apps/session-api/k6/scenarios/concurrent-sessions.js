/**
 * k6 场景:并发会话维持(阶段三 WP-8,质量门禁 9;D-API-73)。
 *
 * ramping-vus 阶梯爬升;每个 VU 迭代 = 建立会话(create_session)→ 打开
 * WSS 通道(Cookie 呈递)→ 每 HEARTBEAT_ACTION_INTERVAL_MS 发一个 write_bytes
 * 动作维持会话活跃 → 保持 HOLD_MS → REST close 收尾。ws.connect 阻塞至连接
 * 关闭,VU 全程占有一个会话——并发会话数 ≈ 活跃 VU 数。
 *
 * 服务端视角的并发数经 GET /metrics 采样(session_api_live_sessions)以
 * Trend `server_live_sessions` 记录;客户端视角以 `held_sessions`(每次成功
 * 建立会话 +1)计数。无 threshold(D-API-73)。
 *
 * 注意:被测拓扑的租户并发预算(SESSION_API_MAX_CONCURRENT_SESSIONS_PER_TENANT,
 * 默认 8)是真实护栏——本场景峰值刻意压在预算内(≤ 6),超限拒绝属 429 冻结
 * 形态行为,不是基线采集目标。
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
const HOLD_MS = Number(__ENV.HOLD_MS || 20000);
const INTERVAL_MS = Number(__ENV.HEARTBEAT_ACTION_INTERVAL_MS || 2000);

export const options = {
  scenarios: {
    concurrent_sessions: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "5s", target: Number(__ENV.CONC_PEAK || 6) },
        { duration: "20s", target: Number(__ENV.CONC_PEAK || 6) },
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

export default function () {
  let embedSessionId = `k6-conc-${__VU}-${__ITER}-${Date.now().toString(36)}`;
  while (embedSessionId.length < 22) {
    embedSessionId += "0";
  }
  const auth = { authorization: `Bearer ${HOST_BEARER}` };
  const issued = post("/auth/embed-tokens", {
    tenantId: "k6-tenant",
    userId: `k6-conc-user-${__VU}-${Math.floor(Date.now() / 60000)}`,
    challengeId: CHALLENGE_ID,
    challengeVersion: "1.0.0",
    embedSessionId,
  }, auth);
  if (issued.status !== 201) throw new Error(`签发失败:${issued.status}`);

  const created = post("/sessions", {
    command: "create_session",
    protocolVersion: 1,
    payload: {
      challengeId: CHALLENGE_ID,
      challengeVersion: "1.0.0",
      embedSessionId,
      embedToken: issued.json("embedToken"),
    },
  }, auth);
  if (created.status !== 201) throw new Error(`create 失败:${created.status}`);
  const sessionId = created.json("payload.sessionId");
  const credential = (created.headers["Set-Cookie"] || created.headers["set-cookie"] || "")
    .split(";")[0].split("=")[1];
  HELD.add(1);

  // 服务端并发会话 gauge 采样(指标面观察;轮询即基线数据的一部分)。
  const metricsSample = http.get(`${BASE_URL}/metrics`, { tags: { name: "/metrics" } });
  const liveMatch = /session_api_live_sessions (\d+)/.exec(metricsSample.body || "");
  if (liveMatch !== null) {
    SERVER_LIVE.add(Number(liveMatch[1]));
  }

  ws.connect(WS_URL, { headers: { cookie: `sm_session_credential=${credential}` } }, (socket) => {
    let seq = 0;
    const act = () => {
      seq += 1;
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
          idempotencyKey: `k6-conc-${embedSessionId}-${seq}`,
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
        protocolVersion: 1,
        payload: { sessionId },
      }, { cookie: `sm_session_credential=${credential}` });
    });
  });

  sleep(0.1);
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
      endedAt: new Date().toISOString(),
      testRunDurationMs: data.state ? data.state.testRunDurationMs : undefined,
      metrics: condensed,
    }, null, 2),
  };
}

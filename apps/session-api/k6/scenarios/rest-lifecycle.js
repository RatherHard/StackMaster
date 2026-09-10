/**
 * k6 场景:REST 生命周期(阶段三 WP-8,质量门禁 9;D-API-73)。
 *
 * 每次迭代 = 完整生命周期:POST /auth/embed-tokens → POST /sessions(create)→
 * POST /sessions/projection-sync ×2 → POST /sessions/checkpoints(list)→
 * POST /sessions/close。REST 命令时延按 k6 内建 http_req_duration 的 name
 * 标签分道(路由路径),checks 断言状态码(只记录,不作阈值)。
 *
 * 无 threshold(D-API-73:首采不设通过阈值)。
 */
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import { sleep } from "k6";

const CYCLES = new Counter("lifecycle_cycles_completed");
const CYCLE_MS = new Trend("lifecycle_cycle_ms", true);

const BASE_URL = __ENV.BASE_URL || "http://host.docker.internal:13118";
const HOST_BEARER = __ENV.HOST_BEARER || "host-backend-shared-credential-0123456789";
const ORIGIN = __ENV.K6_ORIGIN || "http://localhost:13000";
const CHALLENGE_ID = __ENV.K6_CHALLENGE_ID || "chal-k6-baseline";

export const options = {
  scenarios: {
    rest_lifecycle: {
      executor: "constant-vus",
      vus: Number(__ENV.REST_VUS || 2),
      duration: __ENV.REST_DURATION || "30s",
      gracefulStop: "5s",
    },
  },
};

function post(path, body, headers = {}) {
  return http.post(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: Object.assign({ "content-type": "application/json", origin: ORIGIN }, headers),
    tags: { name: path },
  });
}

/** 嵌入会话标识(契约下限 22 字符)与每迭代唯一用户(120/min 护栏不被削顶)。 */
function makeEmbedSessionId() {
  let id = `k6-rest-${__VU}-${__ITER}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  while (id.length < 22) {
    id += "0";
  }
  return id;
}

export default function () {
  const started = Date.now();
  const embedSessionId = makeEmbedSessionId();
  const auth = { authorization: `Bearer ${HOST_BEARER}` };

  const issued = post("/auth/embed-tokens", {
    tenantId: "k6-tenant",
    userId: `k6-rest-user-${__VU}-${__ITER}`,
    challengeId: CHALLENGE_ID,
    challengeVersion: "1.0.0",
    embedSessionId,
  }, auth);
  if (issued.status !== 201) throw new Error(`签发失败:${issued.status}`);
  const embedToken = issued.json("embedToken");

  const created = post("/sessions", {
    command: "create_session",
    protocolVersion: 1,
    payload: { challengeId: CHALLENGE_ID, challengeVersion: "1.0.0", embedSessionId, embedToken },
  }, auth);
  if (created.status !== 201) throw new Error(`create 失败:${created.status}`);
  const sessionId = created.json("payload.sessionId");
  const cookieHeader = (created.headers["Set-Cookie"] || created.headers["set-cookie"] || "")
    .split(";")[0];

  const cookieHeaders = { cookie: cookieHeader };
  for (let i = 0; i < 2; i += 1) {
    post("/sessions/projection-sync", {
      command: "sync_projection",
      protocolVersion: 1,
      payload: { sessionId },
    }, cookieHeaders);
  }
  post("/sessions/checkpoints", {
    command: "list_checkpoints",
    protocolVersion: 1,
    payload: { sessionId },
  }, cookieHeaders);
  const closed = post("/sessions/close", {
    command: "close_session",
    protocolVersion: 1,
    payload: { sessionId },
  }, cookieHeaders);
  if (closed.status !== 200) throw new Error(`close 失败:${closed.status}`);

  CYCLES.add(1);
  CYCLE_MS.add(Date.now() - started);
  sleep(0.2);
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
      scenario: "rest-lifecycle",
      endedAt: new Date().toISOString(),
      testRunDurationMs: data.state ? data.state.testRunDurationMs : undefined,
      metrics: condensed,
    }, null, 2),
  };
}

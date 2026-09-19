/**
 * k6 场景:REST 生命周期(阶段三 WP-8,质量门禁 9;D-API-73)。
 *
 * ## 链路(WP-96 起 = **启动地址链**;旧链 `/auth/embed-tokens` 已退役)
 *
 * 每次迭代 = POST `/auth/launch-tickets`(宿主凭证;体恰两键 `{challengeId, version}`)
 * → GET `<launchUrl>`(**手工补 `Sec-Fetch-Mode: navigate`**、`redirects: 0` 不跟随
 * 302 ⇒ 接住 `Set-Cookie: sm_launch_grant`)→ POST `/sessions`(create,v2 恰两键
 * payload + 授权凭证 Cookie)→ `/sessions/projection-sync` ×2 → `/sessions/checkpoints`
 * (list_checkpoints)→ `/sessions/close`(close_session)。**全部命令 `protocolVersion: 2`**。
 *
 * ## k6 的能力边界(为什么三步都写得这么"手工")
 *
 * k6 是 HTTP 客户端,**不是浏览器**(D-LT-2 的换票闸是按顶层导航设计的):
 *  1. `Sec-Fetch-Mode: navigate` **浏览器由顶层导航自动带**,k6 必须**手工补**;
 *  2. `redirects: 0` ⇒ 不跟随 302,才能读到换票响应的 `Set-Cookie`(跟随则 Cookie
 *     由 k6 的 cookie jar 吃掉,拿不到凭证材料);
 *  3. `launchUrl` 的 origin 由服务端 `SESSION_API_PUBLIC_ORIGIN` 派生(浏览器视角的
 *     源),而本脚本跑在 **k6 容器**里 ⇒ 只取 path+query **重新基到 `BASE_URL`**
 *     (同源约束对非浏览器客户端不适用;见 `redeemUrlOf`);
 *  4. 票据 **绝不进日志与指标标签**:换票请求的 tag 用静态路由模板,k6 summary 里
 *     不出现 `?t=`(D-LT-3 / 契约 §八 条目 7)。
 *
 * ## ⚠ 负载模型已变(与旧基线**不可比**,勿把两组数字并列解读)
 *
 * 新链的 `userId` 由**服务端配置**派生(`SESSION_API_LAUNCH_USER_ID`,缺省
 * `launch-anon`,D-LT-5 第 6 条)⇒ 同一部署下**所有会话共用一个 `userId`**。旧脚本
 * 赖以规避削顶的「每迭代唯一用户」**结构性不可用**(那正是把 `userId` 交还给客户端的
 * 形态,已被否决)。因此本场景按**共享预算均摊节奏**:每 VU 的最小迭代周期取两条
 * 预算的较紧者——
 *
 *   签发预算 `60/min`(rate:{锚租户}:launch_tickets,≤ 1 次/迭代)
 *   REST 预算  `120/min`(rate:{tenant}:{user},本场景 5 次/迭代)
 *
 * ⇒ `MIN_ITERATION_MS = max(60000/签发预算, 60000/REST预算 × 每次迭代REST调用数)
 *    × VU 数 × 1.1(余量,避免贴着窗口边界偶发 429)`。两条预算都取**拓扑的
 * 配置值**(经 `LAUNCH_ISSUANCE_PER_MINUTE` / `REST_REQUESTS_PER_MINUTE` 传入;
 * run-baseline 从 compose/integration.env 自动对齐)⇒ **不调低护栏做压测**
 * (README §七 的纪律仍成立)。
 *
 * **429 不是"被容忍的噪声"**:任一硬闸拒绝即 `throw`(迭代失败可见于
 * `iterations_failed` 与 stderr 留档),不允许脚本静默跑在半数被拒的状态。
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
/** CSRF / CORS 白名单里的一个精确 origin(与拓扑 `SESSION_API_ALLOWED_ORIGINS` 同源)。 */
const ORIGIN = __ENV.K6_ORIGIN || "http://localhost:13000";
const CHALLENGE_ID = __ENV.K6_CHALLENGE_ID || "chal-k6-baseline";
const CHALLENGE_VERSION = __ENV.K6_CHALLENGE_VERSION || "1.0.0";

/** 会话动作协议版本:WP-90 起 v2(`create_session` payload 恰两键,授权来自 Cookie)。 */
const PROTOCOL_VERSION = 2;
/** 授权凭证 Cookie 名(契约 §四;非秘密)。 */
const LAUNCH_GRANT_COOKIE = "sm_launch_grant";
/** 本场景每次迭代消耗的 `rate:{tenant}:{user}` REST 调用数(create + 2 sync + list + close)。 */
const REST_CALLS_PER_ITERATION = 5;

const VUS = Number(__ENV.REST_VUS || 2);
const ISSUANCE_PER_MINUTE = Number(__ENV.LAUNCH_ISSUANCE_PER_MINUTE || 60);
const REST_PER_MINUTE = Number(__ENV.REST_REQUESTS_PER_MINUTE || 120);
const MIN_ITERATION_MS = Math.ceil(
  Math.max(
    60_000 / ISSUANCE_PER_MINUTE,
    (60_000 / REST_PER_MINUTE) * REST_CALLS_PER_ITERATION,
  ) * VUS * 1.1,
);

export const options = {
  scenarios: {
    rest_lifecycle: {
      executor: "constant-vus",
      vus: VUS,
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

/** 大小写不敏感地读响应头(k6 的头键大小写形态随版本而变;沿既有双查写法)。 */
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
 * 把服务端签发的 `launchUrl` 重新基到 `BASE_URL`(见文件头第 3 条)。
 *
 * ⚠ **不得**把结果写进 tag / 日志 / 断言消息(它携带一次性票据,`?t=` 只能进
 * 受控的网络请求;D-LT-3)。
 */
function redeemUrlOf(launchUrl) {
  const path = String(launchUrl).replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+/, "");
  if (path.indexOf("/app/c/") !== 0) {
    throw new Error("launchUrl 形态不符(应以 /app/c/ 开头):换票路径由契约模板派生");
  }
  return `${BASE_URL}${path}`;
}

/** 启动地址链:签发 → 换票(手工 navigate + 不跟随 302)→ create_session v2。 */
function createSessionViaLaunchAddress() {
  // ① 签发(宿主凭证;租户由凭证 × 白名单在服务端派生,请求体无租户位)。
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

  // ② 换票:导航语义 + 不跟随("手工补头"的理由见文件头第 1 / 2 条)。
  const redeemed = http.get(redeemUrlOf(launchUrl), {
    headers: { "sec-fetch-mode": "navigate" },
    redirects: 0,
    // tag 用**静态**模板:票据在查询串里,绝不能出现在指标标签 / 归档里。
    tags: { name: "/app/c/:challengeId/:version" },
  });
  if (redeemed.status !== 302) {
    throw new Error(`换票失败(期望 302 干净路径重定向):${redeemed.status}`);
  }
  const grant = cookieValue(redeemed, LAUNCH_GRANT_COOKIE);
  if (grant === "") {
    throw new Error(`换票响应缺少 ${LAUNCH_GRANT_COOKIE} Cookie(Set-Cookie 交付面缺失)`);
  }

  // ③ 建会话:payload **恰两键**;授权只来自上一步的 Cookie(不再有 embed token)。
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
  const cookieHeader = String(headerValue(created, "set-cookie")).split(";")[0];
  return { sessionId, cookieHeader };
}

export default function () {
  const started = Date.now();
  const { sessionId, cookieHeader } = createSessionViaLaunchAddress();
  const cookieHeaders = { cookie: cookieHeader };

  for (let index = 0; index < 2; index += 1) {
    post("/sessions/projection-sync", {
      command: "sync_projection",
      protocolVersion: PROTOCOL_VERSION,
      payload: { sessionId },
    }, cookieHeaders);
  }
  post("/sessions/checkpoints", {
    command: "list_checkpoints",
    protocolVersion: PROTOCOL_VERSION,
    payload: { sessionId },
  }, cookieHeaders);
  const closed = post("/sessions/close", {
    command: "close_session",
    protocolVersion: PROTOCOL_VERSION,
    payload: { sessionId },
  }, cookieHeaders);
  if (closed.status !== 200) {
    throw new Error(`close 失败:${closed.status}`);
  }

  CYCLES.add(1);
  CYCLE_MS.add(Date.now() - started);

  // 共享预算均摊节奏(文件头「负载模型已变」段):迭代周期不足即补足。
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
      scenario: "rest-lifecycle",
      /** 链路标识(WP-96 起):旧链读数与此不可比。 */
      chain: "launch-address/v2",
      minIterationMs: MIN_ITERATION_MS,
      endedAt: new Date().toISOString(),
      testRunDurationMs: data.state ? data.state.testRunDurationMs : undefined,
      metrics: condensed,
    }, null, 2),
  };
}

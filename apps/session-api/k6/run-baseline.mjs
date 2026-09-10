/**
 * k6 基线首采运行器(阶段三 WP-8,质量门禁 9;D-API-73)。
 *
 * 前置:compose 全拓扑已由 `pnpm compose:app:up` 拉起(或等价的 host 混合
 * 拓扑,BASE_URL 指向宿主进程)。本运行器不做拓扑生命周期管理——它
 *   1. 轮询 BASE_URL /healthz 就绪;
 *   2. 经 k6/seed-challenge.mjs 登记基线题目(compose/integration.env 注入
 *      依赖服务连接;容器拓扑的 PG / MinIO 端口已发布到宿主);
 *   3. 以 grafana/k6 官方镜像逐场景执行(脚本经 stdin 传入,免卷挂载的
 *      Windows 路径转换问题);被测地址 = BASE_URL(容器内经
 *      host.docker.internal / 或宿主端口直接可达);
 *   4. 归档:results/<UTC 时间戳>/<scenario>.json(k6 原始 summary)+ 前后
 *      各一次 /metrics 快照 + summary.md(人读摘要)。
 *
 * 用法:
 *   pnpm --filter @stackmaster/session-api k6:baseline
 *   BASE_URL=http://host.docker.internal:13000 node k6/run-baseline.mjs
 *
 * 铁律:不设通过阈值(10.3 / 13.6)——首采数字只作 T2 触发判据基线。
 */
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // apps/session-api
// BASE_URL = k6 容器视角的被测地址(host.docker.internal 指向宿主发布端口);
// HOST_BASE_URL = 本运行器(宿主侧)健康检查 / 指标采样用的同一服务地址。
const BASE_URL = process.env.BASE_URL || "http://host.docker.internal:13000";
const HOST_BASE_URL = process.env.HOST_BASE_URL || "http://127.0.0.1:13000";
const RESULTS_ROOT = join(APP_DIR, "k6", "results");
const SCENARIOS = [
  { name: "action-rtt-wss", file: join(APP_DIR, "k6", "scenarios", "action-rtt-wss.js") },
  { name: "rest-lifecycle", file: join(APP_DIR, "k6", "scenarios", "rest-lifecycle.js") },
  { name: "concurrent-sessions", file: join(APP_DIR, "k6", "scenarios", "concurrent-sessions.js") },
];

function runChild(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(Object.assign(error, { stdout, stderr }));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function waitForHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "never";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${HOST_BASE_URL}/healthz`);
      if (response.ok) return;
      last = `status ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`被测拓扑未就绪(${HOST_BASE_URL}/healthz:${last})——先运行 pnpm compose:app:up`);
}

/** 从 compose/integration.env 解析宿主进程环境(键值对解析,非 shell)。 */
async function integrationEnv() {
  const path = join(APP_DIR, "compose", "integration.env");
  const values = {};
  if (!existsSync(path)) {
    return values;
  }
  const content = await readFile(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return values;
}

async function fetchMetricsSnapshot() {
  const response = await fetch(`${HOST_BASE_URL}/metrics`);
  if (!response.ok) {
    return `(GET /metrics → ${response.status})`;
  }
  return response.body ? await response.text() : "";
}

function runK6Scenario(scenario, dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "run", "--rm", "-i",
        "-e", `BASE_URL=${BASE_URL}`,
        ...(process.env.HOST_BEARER ? ["-e", `HOST_BEARER=${process.env.HOST_BEARER}`] : []),
        ...(process.env.K6_CHALLENGE_ID ? ["-e", `K6_CHALLENGE_ID=${process.env.K6_CHALLENGE_ID}`] : []),
        "grafana/k6:latest", "run", "--quiet", "-",
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", async (code) => {
      // stderr 逐场景留档(k6 运行期错误 / 异常迭代信息,诊断面)。
      await writeFile(join(dir, `${scenario.name}.stderr.log`), stderr, "utf8").catch(() => undefined);
      if (code === 0) resolve(stdout);
      else reject(new Error(`k6 ${scenario.name} 退出码 ${code}\n${stderr.slice(-2000)}`));
    });
    readFile(scenario.file, "utf8")
      .then((script) => child.stdin.end(script))
      .catch(reject);
  });
}

function pick(json, keys) {
  return json?.metrics?.[keys] ?? null;
}

/** condensed JSON 的指标对象即 values 本体(avg/med/p(90)/p(95)/max/count)。 */
function fmtValues(values) {
  if (values === null || typeof values !== "object") return "—";
  const f = (x) => (typeof x === "number" ? Math.round(x * 1000) / 1000 : x);
  if ("count" in values && !("avg" in values)) {
    return `count ${f(values.count)}`;
  }
  const parts = ["avg", "med", "p(90)", "p(95)", "max"]
    .filter((key) => key in values)
    .map((key) => `${key} ${f(values[key])}`);
  return parts.length > 0 ? parts.join(" / ") : "—";
}

function buildSummaryMd(results, metricsBefore, metricsAfter, baseUrl) {
  const lines = [
    "# k6 基线首采摘要(阶段三 WP-8,质量门禁 9)",
    "",
    `- 被测地址:${baseUrl}(形态与时间戳见同目录 JSON;D-API-73)`,
    `- 采集时间:${new Date().toISOString()}`,
    "- 阈值:**不设通过阈值**(10.3 / 13.6——数据作为 T2 触发判据基线,避免过早优化)",
    "- 环境:本机 Docker + compose 拓扑(容器形态;见 apps/session-api/README.md 的拓扑说明)",
    "",
    "| 场景 | 关键指标 | 数值 |",
    "|---|---|---|",
  ];
  for (const { name, json } of results) {
    if (name === "action-rtt-wss") {
      lines.push(`| ${name} | wss_action_rtt_ms | ${fmtValues(pick(json, "wss_action_rtt_ms"))} |`);
      lines.push(`| ${name} | wss_actions_confirmed | ${fmtValues(pick(json, "wss_actions_confirmed"))} |`);
      lines.push(`| ${name} | sessions_created | ${fmtValues(pick(json, "sessions_created"))} |`);
    }
    if (name === "rest-lifecycle") {
      lines.push(`| ${name} | lifecycle_cycle_ms | ${fmtValues(pick(json, "lifecycle_cycle_ms"))} |`);
      lines.push(`| ${name} | lifecycle_cycles_completed | ${fmtValues(pick(json, "lifecycle_cycles_completed"))} |`);
    }
    if (name === "concurrent-sessions") {
      lines.push(`| ${name} | server_live_sessions | ${fmtValues(pick(json, "server_live_sessions"))} |`);
      lines.push(`| ${name} | held_sessions | ${fmtValues(pick(json, "held_sessions"))} |`);
    }
    const httpDuration = pick(json, "http_req_duration");
    if (httpDuration !== null) {
      lines.push(`| ${name} | http_req_duration | ${fmtValues(httpDuration)} |`);
    }
  }
  lines.push(
    "",
    "## 采集前 /metrics 快照(指标面最小集;D-API-70)",
    "",
    "```text",
    metricsBefore.trim(),
    "```",
    "",
    "## 采集后 /metrics 快照",
    "",
    "```text",
    metricsAfter.trim(),
    "```",
    "",
    "## 纪律注记",
    "",
    "- 本基线在本机 dev 拓扑采集,数字不构成性能承诺(10.3:目标值待真实网络 / 设备 benchmark 后确定);",
    "- 会话 ID、租户、用户等标识符不出现在指标输出(标签纪律,D-API-71;/metrics 快照可作为附件复核);",
    "- 原始 summary JSON 与 /metrics 快照逐场景归档于本目录。",
  );
  return lines.join("\n");
}

await waitForHealth();
console.log(`[k6:baseline] 被测拓扑就绪:${HOST_BASE_URL}(k6 容器视角:${BASE_URL})`);

// 题目登记(integration.env 注入依赖服务连接;重复登记 = 复用既有版本)。
const seedEnv = { ...process.env, ...(await integrationEnv()) };
await runChild(process.execPath, [join(APP_DIR, "k6", "seed-challenge.mjs")], {
  cwd: APP_DIR,
  env: seedEnv,
});
console.log("[k6:baseline] 基线题目就绪");

const runId = new Date().toISOString().replace(/[:.]/g, "");
const runDir = join(RESULTS_ROOT, runId);
await mkdir(runDir, { recursive: true });

const metricsBefore = await fetchMetricsSnapshot();
await writeFile(join(runDir, "metrics-before.txt"), metricsBefore, "utf8");

const results = [];
for (const scenario of SCENARIOS) {
  console.log(`[k6:baseline] 运行场景 ${scenario.name} ……`);
  const stdout = await runK6Scenario(scenario, runDir);
  await writeFile(join(runDir, `${scenario.name}.json`), stdout, "utf8");
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  results.push({ name: scenario.name, json });
  console.log(`[k6:baseline] 场景完成:${scenario.name}`);
}

const metricsAfter = await fetchMetricsSnapshot();
await writeFile(join(runDir, "metrics-after.txt"), metricsAfter, "utf8");
await writeFile(join(runDir, "summary.md"), buildSummaryMd(results, metricsBefore, metricsAfter, BASE_URL), "utf8");
console.log(`[k6:baseline] 结果归档:${runDir}`);

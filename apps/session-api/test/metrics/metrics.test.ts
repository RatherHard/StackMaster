/**
 * 指标面最小集单元测试(阶段三 WP-8;D-API-70 / D-API-71):
 *  - 五指标族的渲染形态(名、help、标签、直方图分桶展开);
 *  - 动作标签值的有界域(未知动作类型折叠 `other`,基数防护);
 *  - /metrics 端点:恒 200 + Prometheus 文本格式,不破坏既有路由与错误面;
 *  - 标签纪律机检 assertMetricsTextDiscipline:白名单外指标 / 白名单外标签 /
 *    秘密语料 / 标识符形态值四类违例,红灯反例逐类证明可检出(映射文档 §五
 *    "必触发反例"纪律)。
 */
import { describe, expect, it } from "vitest";
import { PublicErrorSchema } from "@stackmaster/protocol";

import {
  METRIC_FAMILIES,
  SessionMetrics,
  assertMetricsTextDiscipline,
} from "../../src/metrics/metrics.js";
import { METRICS_ROUTE, buildMetricsPlugin } from "../../src/metrics/metrics-plugin.js";
import { loadSessionApiConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { buildServer } from "../../src/server.js";
import { REQUIRED_AUTH_ENV, REQUIRED_STORAGE_ENV } from "../helpers/required-env.js";

describe("SessionMetrics 五指标族(D-API-70)", () => {
  it("渲染输出含全部白名单族;动作 RTT 按 action/outcome 标签分桶", async () => {
    const metrics = new SessionMetrics();
    metrics.observeActionRtt("write_bytes", "accepted", 0.012);
    metrics.observeActionRtt("undo", "rejected", 0.003);
    metrics.observeActionRtt("step", "error", 0.5);
    metrics.observeProjectionDelta("write_bytes", 512);
    metrics.setLiveSessions(3);
    metrics.setQueueDepth(0);
    metrics.setWorkerProcesses(3);

    const text = await metrics.render();
    for (const family of METRIC_FAMILIES) {
      expect(text).toContain(`# HELP ${family.name} `);
      expect(text).toContain(`# TYPE ${family.name} ${family.type}`);
    }
    // 直方图展开样本的标签序不定(prom-client 哈希序,le 可居首);前瞻逐片匹配。
    expect(text).toMatch(/^session_api_action_rtt_seconds_bucket\{(?=[^}]*action="write_bytes")(?=[^}]*le="0\.025")(?=[^}]*outcome="accepted")[^}]*\} 1$/m);
    expect(text).toMatch(/^session_api_action_rtt_seconds_bucket\{(?=[^}]*action="undo")(?=[^}]*le="0\.005")(?=[^}]*outcome="rejected")[^}]*\} 1$/m);
    expect(text).toMatch(/^session_api_action_rtt_seconds_count\{(?=[^}]*action="step")(?=[^}]*outcome="error")[^}]*\} 1$/m);
    expect(text).toContain("session_api_live_sessions 3");
    expect(text).toContain("session_api_worker_processes 3");
    expect(text).toMatch(/^session_api_projection_delta_bytes_sum\{[^}]*action="write_bytes"[^}]*\} 512$/m);
  });

  it("非冻结动作类型折叠为 other(基数防护兜底)", async () => {
    const metrics = new SessionMetrics();
    metrics.observeActionRtt("type_that_does_not_exist", "accepted", 0.01);
    const text = await metrics.render();
    expect(text).toMatch(/^session_api_action_rtt_seconds_bucket\{(?=[^}]*action="other")(?=[^}]*outcome="accepted")[^}]*\} \d+$/m);
    expect(text).not.toContain("type_that_does_not_exist");
  });

  it("projection delta 为 null 时零观测;contentType 为 Prometheus 文本格式", async () => {
    const metrics = new SessionMetrics();
    metrics.observeProjectionDelta("reset", null);
    const text = await metrics.render();
    expect(text).not.toContain("session_api_projection_delta_bytes_count");
    expect(metrics.contentType).toContain("text/plain");
  });
});

describe("标签纪律机检 assertMetricsTextDiscipline(D-API-71)", () => {
  it("白名单渲染零违例(合法形态)", async () => {
    const metrics = new SessionMetrics();
    metrics.observeActionRtt("write_bytes", "accepted", 0.01);
    metrics.observeActionRtt("write_bytes", "rejected", 0.01);
    metrics.setLiveSessions(1);
    metrics.setWorkerProcesses(1);
    metrics.setQueueDepth(0);
    metrics.observeProjectionDelta("write_bytes", 256);
    expect(assertMetricsTextDiscipline(await metrics.render())).toEqual([]);
  });

  it("红灯反例:白名单外指标名被检出(unknown-metric-name)", async () => {
    const metrics = new SessionMetrics();
    const text = `${await metrics.render()}\n# HELP rogue_secret_metric internal state\n# TYPE rogue_secret_metric gauge\nrogue_secret_metric 1\n`;
    const violations = assertMetricsTextDiscipline(text);
    expect(violations.some((item) => item.id === "unknown-metric-name")).toBe(true);
  });

  it("红灯反例:白名单外标签(会话 ID 入标签)被检出(unknown-label-name)", () => {
    const violations = assertMetricsTextDiscipline(
      'session_api_live_sessions{sessionId="e58ed7639ab7c9d0a4f1b2c3d4e5f607"} 1\n',
    );
    expect(violations.some((item) => item.id === "unknown-label-name")).toBe(true);
  });

  it("红灯反例:秘密语料(FLAG / seed hex)被检出(secret-corpus-hit)", () => {
    const flag = assertMetricsTextDiscipline("# some metric note FLAG{leaked_value}\n");
    expect(flag.some((item) => item.id === "secret-corpus-hit")).toBe(true);
    const seed = assertMetricsTextDiscipline(
      "session_api_live_sessions{note=\"00112233445566778899aabbccddeeff\"} 0\n",
    );
    expect(seed.some((item) => item.id === "secret-corpus-hit")).toBe(true);
  });

  it("红灯反例:服务端签发标识符形态值被检出(session-id-shaped-value)", () => {
    const violations = assertMetricsTextDiscipline(
      'session_api_live_sessions{note="sess-0123456789abcdef0123456789abcdef"} 1\n',
    );
    expect(violations.some((item) => item.id === "session-id-shaped-value")).toBe(true);
  });
});

describe("/metrics 端点(D-API-70:挂载不破坏既有路由与错误面)", () => {
  it("GET /metrics 恒 200 + Prometheus 文本格式;输出过标签纪律机检零违例", async () => {
    const config = loadSessionApiConfig({
      NODE_ENV: "test",
      SESSION_API_PORT: "0",
      ...REQUIRED_AUTH_ENV,
      ...REQUIRED_STORAGE_ENV,
    });
    const metrics = new SessionMetrics();
    metrics.observeActionRtt("step", "accepted", 0.004);
    const app = buildServer(config, createLogger(config), {
      metricsPlugin: buildMetricsPlugin(metrics),
    });
    await app.ready();
    const response = await app.inject({ method: "GET", url: METRICS_ROUTE });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("# HELP session_api_action_rtt_seconds ");
    expect(assertMetricsTextDiscipline(response.body)).toEqual([]);
    await app.close();
  });

  it("未挂载 metricsPlugin 时 /metrics 走 404 冻结形态;POST /metrics 同形(既有错误面不变)", async () => {
    const config = loadSessionApiConfig({
      NODE_ENV: "test",
      SESSION_API_PORT: "0",
      ...REQUIRED_AUTH_ENV,
      ...REQUIRED_STORAGE_ENV,
    });
    const app = buildServer(config, createLogger(config));
    await app.ready();
    const get = await app.inject({ method: "GET", url: METRICS_ROUTE });
    expect(get.statusCode).toBe(404);
    expect(PublicErrorSchema.parse(get.json())).toMatchObject({
      code: "invalid_input_format",
      message: "resource not found",
    });
    const post = await app.inject({ method: "POST", url: METRICS_ROUTE });
    expect(post.statusCode).toBe(404);
    expect(PublicErrorSchema.parse(post.json())).toMatchObject({
      code: "invalid_input_format",
      message: "resource not found",
    });
    await app.close();
  });
});

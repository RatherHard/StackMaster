import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PublicErrorSchema } from "@stackmaster/protocol";
import { loadSessionApiConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { buildServer, HEALTH_ROUTE, READY_ROUTE } from "../src/server.js";
import type { ReadinessProbe } from "../src/runtime/runtime.js";
import { createLogCapture } from "./helpers/log-capture.js";
import { REQUIRED_ENV_FIXTURE } from "./helpers/required-env.js";

function buildWithCapture(): {
  app: FastifyInstance;
  capture: ReturnType<typeof createLogCapture>;
} {
  // 本文件只验证 HTTP 骨架纪律,不验证配置闸:env 取必备键合法 fixture
  // (必备键缺失的 fail-closed 拒绝路径由 test/config.test.ts 承接)。
  const config = loadSessionApiConfig({
    ...REQUIRED_ENV_FIXTURE,
    NODE_ENV: "test",
    SESSION_API_PORT: "0",
  });
  const capture = createLogCapture();
  const logger = createLogger(config, capture.stream);
  return { app: buildServer(config, logger), capture };
}

describe("健康检查端点", () => {
  it("GET /healthz 返回 ok", async () => {
    const { app } = buildWithCapture();
    const response = await app.inject({ method: "GET", url: HEALTH_ROUTE });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

describe("错误响应面 = 冻结 PublicError 形态(基线 #8 骨架锚点)", () => {
  it("未知路由返回冻结形态且零框架细节", async () => {
    const { app } = buildWithCapture();
    const response = await app.inject({ method: "GET", url: "/definitely-not-a-route" });
    expect(response.statusCode).toBe(404);
    // 过冻结 Schema 即证明:形态、字段集与取值域全部落在契约内(strictObject
    // 会拒绝框架默认报文的 error / statusCode 等多余字段)。
    expect(() => PublicErrorSchema.parse(response.json())).not.toThrow();
    expect(response.json()).toEqual({
      code: "invalid_input_format",
      message: "resource not found",
    });
  });

  it("畸形 JSON 请求:冻结形态响应,解析器细节只进受控日志", async () => {
    const { app, capture } = buildWithCapture();
    const response = await app.inject({
      method: "POST",
      url: HEALTH_ROUTE,
      payload: "{definitely-not-json",
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: "invalid_input_format",
      message: "invalid request",
    });
    // 响应面零解析器细节;细节在受控日志(err 序列化器,堆栈剥离)。
    expect(response.body).not.toContain("Unexpected");
    const errorEntries = capture
      .entries()
      .filter((entry) => entry["msg"] === "request failed");
    expect(errorEntries.length).toBeGreaterThan(0);
    const serialized = errorEntries[0]?.["err"] as Record<string, unknown>;
    expect(typeof serialized["message"]).toBe("string");
    expect(serialized).not.toHaveProperty("stack");
  });

  it("处理器抛错:internal_error 冻结形态,内部细节与堆栈不出响应面", async () => {
    const { app, capture } = buildWithCapture();
    void app.get("/boom", async () => {
      throw new Error("secret internal detail at C:\\repo\\secret.ts");
    });
    const response = await app.inject({ method: "GET", url: "/boom" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      code: "internal_error",
      message: "internal error",
    });
    expect(response.body).not.toContain("secret internal detail");
    // 受控日志含 message(可解释性)但不含堆栈与调用帧。
    const raw = capture.raw();
    expect(raw).toContain("request failed");
    expect(raw).not.toContain("    at ");
  });
});

describe("readiness 端点(D-API-9 预留的本阶段落地;D-API-34)", () => {
  const probes = (
    failing: readonly string[],
  ): ReadinessProbe[] => [
    {
      name: "postgres",
      check: async () => {
        if (failing.includes("postgres")) {
          throw new Error("postgres down");
        }
      },
    },
    {
      name: "redis",
      check: async () => {
        if (failing.includes("redis")) {
          throw new Error("redis down");
        }
      },
    },
  ];

  it("全部探针通过 → 200 ok", async () => {
    const config = loadSessionApiConfig({
      ...REQUIRED_ENV_FIXTURE,
      NODE_ENV: "test",
      SESSION_API_PORT: "0",
    });
    const capture = createLogCapture();
    const logger = createLogger(config, capture.stream);
    const app = buildServer(config, logger, { readinessProbes: probes([]) });
    const response = await app.inject({ method: "GET", url: READY_ROUTE });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("任一探针失败 → 503 + 统一冻结形态(失败方不透出,只进受控日志)", async () => {
    const config = loadSessionApiConfig({
      ...REQUIRED_ENV_FIXTURE,
      NODE_ENV: "test",
      SESSION_API_PORT: "0",
    });
    const capture = createLogCapture();
    const logger = createLogger(config, capture.stream);
    const app = buildServer(config, logger, { readinessProbes: probes(["redis"]) });
    const response = await app.inject({ method: "GET", url: READY_ROUTE });
    expect(response.statusCode).toBe(503);
    expect(() => PublicErrorSchema.parse(response.json())).not.toThrow();
    expect(response.json()).toEqual({
      code: "internal_error",
      message: "dependencies unavailable",
    });
    // 失败方(redis)只在受控日志出现,绝不在响应面。
    expect(response.body).not.toContain("redis");
    expect(capture.raw()).toContain("readiness probe failed");
  });

  it("探针未接线(骨架形态)→ 503:依赖未知不可谎报就绪", async () => {
    const { app } = buildWithCapture();
    const response = await app.inject({ method: "GET", url: READY_ROUTE });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: "internal_error",
      message: "dependencies unavailable",
    });
    // /healthz liveness 语义不变:恒 200。
    const live = await app.inject({ method: "GET", url: HEALTH_ROUTE });
    expect(live.statusCode).toBe(200);
  });
});

describe("请求 ID 纪律", () => {  it("合法 x-request-id 被回显(跨服务关联),并进入请求日志字段", async () => {
    const { app, capture } = buildWithCapture();
    const response = await app.inject({
      method: "GET",
      url: HEALTH_ROUTE,
      headers: { "x-request-id": "host-req-0001" },
    });
    expect(response.headers["x-request-id"]).toBe("host-req-0001");
    const logLines = capture
      .entries()
      .filter((entry) => entry["reqId"] === "host-req-0001");
    expect(logLines.length).toBeGreaterThan(0);
  });

  it("非法 x-request-id(超出冻结字符集)被替换为服务端生成,不原样进日志", async () => {
    const { app, capture } = buildWithCapture();
    const malicious = "bad id\ninjection";
    const response = await app.inject({
      method: "GET",
      url: HEALTH_ROUTE,
      headers: { "x-request-id": malicious },
    });
    const echoed = response.headers["x-request-id"];
    expect(typeof echoed).toBe("string");
    expect(echoed).not.toBe(malicious);
    expect(echoed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(capture.raw()).not.toContain("injection");
  });

  it("缺失 x-request-id 由服务端生成(UUID 形态)", async () => {
    const { app } = buildWithCapture();
    const response = await app.inject({ method: "GET", url: HEALTH_ROUTE });
    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

import { describe, expect, it } from "vitest";
import type { Logger } from "pino";
import { loadSessionApiConfig } from "../src/config.js";
import {
  REDACTION_CENSOR,
  createLogger,
  withSessionFields,
} from "../src/logger.js";
import { createLogCapture } from "./helpers/log-capture.js";
import { REQUIRED_ENV_FIXTURE } from "./helpers/required-env.js";

function captureLogger(logErrorStacks = false): { logger: Logger; capture: ReturnType<typeof createLogCapture> } {
  // 本文件只验证日志纪律,不验证配置闸:env 取必备键合法 fixture
  // (必备键缺失的 fail-closed 拒绝路径由 test/config.test.ts 承接)。
  const config = loadSessionApiConfig({
    ...REQUIRED_ENV_FIXTURE,
    NODE_ENV: "test",
    SESSION_API_PORT: "0",
    SESSION_API_LOG_ERROR_STACKS: logErrorStacks ? "true" : "",
  });
  const capture = createLogCapture();
  return { logger: createLogger(config, capture.stream), capture };
}

describe("Pino 日志纪律(9.1 编排器落点,ZR-B7 服务器侧)", () => {
  it("seed / flag / 凭证语料在顶层与嵌套位置被遮蔽为固定占位符,不回显值与长度", () => {
    const { logger, capture } = captureLogger();
    logger.info(
      {
        seed: "deadbeef",
        flag: "flag{hidden}",
        token: "bearer-token",
        nested: { authorization: "Basic abc", deeper: { password: "p4ss" } },
        keep: "visible-value",
      },
      "语料遮蔽",
    );
    const raw = capture.raw();
    expect(raw).toContain(REDACTION_CENSOR);
    expect(raw).not.toContain("deadbeef");
    expect(raw).not.toContain("flag{hidden}");
    expect(raw).not.toContain("bearer-token");
    expect(raw).not.toContain("Basic abc");
    expect(raw).not.toContain("p4ss");
    // 非敏感字段不受遮蔽影响(遮蔽是精确路径,不是全文黑洞)。
    expect(raw).toContain("visible-value");
  });

  it("错误日志默认不含堆栈与文件路径——只保留 type + message(受控通道演进开关关闭)", () => {
    const { logger, capture } = captureLogger(false);
    const err = new Error("boom: detail at C:\\repo\\src\\file.ts");
    logger.error({ err }, "handled");
    const entry = capture.entries().find((e) => e["msg"] === "handled");
    expect(entry).toBeDefined();
    const serialized = entry?.["err"] as Record<string, unknown>;
    expect(serialized["type"]).toBe("Error");
    expect(serialized["message"]).toBe("boom: detail at C:\\repo\\src\\file.ts");
    expect(serialized).not.toHaveProperty("stack");
    expect(capture.raw()).not.toContain("    at ");
  });

  it("堆栈开关显式开启时受控日志可含堆栈(排障演进面,默认恒为关闭)", () => {
    const { logger, capture } = captureLogger(true);
    logger.error({ err: new Error("with stack") }, "handled");
    const entry = capture.entries().find((e) => e["msg"] === "handled");
    const serialized = entry?.["err"] as Record<string, unknown>;
    expect(typeof serialized["stack"]).toBe("string");
  });

  it("非 Error 抛出物被序列化为 NonError,不因序列化器抛错丢日志", () => {
    const { logger, capture } = captureLogger();
    logger.error({ err: "plain string rejection" }, "handled");
    const entry = capture.entries().find((e) => e["msg"] === "handled");
    const serialized = entry?.["err"] as Record<string, unknown>;
    expect(serialized["type"]).toBe("NonError");
    expect(serialized["message"]).toBe("plain string rejection");
  });

  it("withSessionFields 白名单绑定会话域一等字段(请求 ID / 会话 ID / 租户 / revision 纪律)", () => {
    const { logger, capture } = captureLogger();
    const log = withSessionFields(logger, {
      sessionId: "01JABC-1",
      tenantId: "t-1",
      revision: 7,
    });
    log.info("session scoped");
    const entry = capture.entries().find((e) => e["msg"] === "session scoped");
    expect(entry?.["sessionId"]).toBe("01JABC-1");
    expect(entry?.["tenantId"]).toBe("t-1");
    expect(entry?.["revision"]).toBe(7);
  });

  it("req 序列化白名单:头部与连接细节结构性不入日志", () => {
    const { logger, capture } = captureLogger();
    logger.info(
      {
        req: {
          method: "POST",
          url: "/sessions",
          headers: { authorization: "Bearer x", cookie: "sid=y" },
          remoteAddress: "10.0.0.1",
        },
      },
      "req discipline",
    );
    const raw = capture.raw();
    const entry = capture.entries().find((e) => e["msg"] === "req discipline");
    const req = entry?.["req"] as Record<string, unknown>;
    expect(req["method"]).toBe("POST");
    expect(req["url"]).toBe("/sessions");
    expect(Object.keys(req).sort()).toEqual(["method", "url"]);
    expect(raw).not.toContain("Bearer x");
    expect(raw).not.toContain("sid=y");
  });

  it("日志行携带应用标识与环境(app/env 一等字段),默认 pid/hostname 不在场", () => {
    const { logger, capture } = captureLogger();
    logger.info("base discipline");
    const entry = capture.entries().find((e) => e["msg"] === "base discipline");
    expect(entry?.["app"]).toBe("session-api");
    expect(entry?.["env"]).toBe("test");
    expect(entry).not.toHaveProperty("hostname");
  });
});

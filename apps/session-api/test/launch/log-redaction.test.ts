/**
 * 日志零票据(WP-91;D-LT-3 ⓪「查询串脱敏」)。
 *
 * **两层断言,主次分明**:
 *  - **运行时断言为主**(下文 `buildServer` + `log-capture` 的那两条):它走的是
 *    **真实装配路径**(真 logger → 真 fastify → 真 onRequest/请求日志),证明
 *    "票据确实不会落进应用侧日志",而不是"那个纯函数返回值看起来对"。
 *    只写纯函数单测会漏掉一整类缺陷 —— 序列化器**忘了调用**它。
 *  - **纯函数单测为辅**:穷举 `redactRequestUrl` 的形态边界(它没有 IO,
 *    可以廉价穷举)。
 *
 * 本文件的位置在 `test/launch/`,而**不是** `test/persistence/`:它是启动票据
 * 面(D-LT-3)的交付物。换票路由落地后(step 2 / WP-92),那条"取**全部**
 * `req.url` 断言不含票据"的用例应扩到**换票请求本身**;此处先钉死控制点。
 */

import { describe, expect, it } from "vitest";
import type { Logger } from "pino";
import { createLogger, redactRequestUrl } from "../../src/logger.js";
import { buildServer } from "../../src/server.js";
import { loadSessionApiConfig } from "../../src/config.js";
import { createLogCapture, type LogCapture } from "../helpers/log-capture.js";
import { REQUIRED_ENV_FIXTURE } from "../helpers/required-env.js";
import { generateLaunchTicketToken } from "../../src/launch/ticket-token.js";

describe("redactRequestUrl(纯函数:形态边界)", () => {
  it("剥离查询串(整段),保留路径与路径参数", () => {
    expect(redactRequestUrl("/app/c/ch-1/1.0.0?t=SECRET")).toBe("/app/c/ch-1/1.0.0");
    expect(redactRequestUrl("/app/c/ch-1/1.0.0?a=1&b=2&t=SECRET")).toBe("/app/c/ch-1/1.0.0");
    expect(redactRequestUrl("/host/scores?cursor=abc&limit=10")).toBe("/host/scores");
  });

  it("无查询串时**逐字不变**(不是「顺手重写路径」)", () => {
    expect(redactRequestUrl("/sessions")).toBe("/sessions");
    expect(redactRequestUrl("/")).toBe("/");
    expect(redactRequestUrl("")).toBe("");
  });

  it("只有 `?`、没有内容 ⇒ 剥到空查询(不留下裸问号)", () => {
    expect(redactRequestUrl("/x?")).toBe("/x");
  });

  it("fragment 一并剥离(通用原语,不依赖「fragment 不过线路」的前提)", () => {
    expect(redactRequestUrl("/x#frag")).toBe("/x");
    expect(redactRequestUrl("/x?t=SECRET#frag")).toBe("/x");
  });

  it("参数名漂移免疫:秘密挂在**任意**参数名上都被剥离", () => {
    // 这是选择"整段剥离"而不是"只 censor `t`"的理由 —— 本断言即其证明。
    for (const name of ["t", "ticket", "token", "launch", "x", ""]) {
      expect(redactRequestUrl(`/app/c/a/1.0.0?${name}=SUPERSECRET`)).toBe("/app/c/a/1.0.0");
    }
  });

  it("non-string 入站原样透传(不抛错、不把 undefined 变字符串)", () => {
    expect(redactRequestUrl(undefined)).toBeUndefined();
    // 越界形态(上游类型标注不可信):非字符串不得让日志序列化抛错。
    expect(redactRequestUrl(123 as unknown as string)).toBe(123);
    expect(redactRequestUrl(null as unknown as string)).toBeNull();
  });
});

/** 真实装配路径的日志装置:真 logger → 真 fastify(与 logging.test.ts 同形)。 */
function realPipeline(): { logger: Logger; capture: LogCapture } {
  const config = loadSessionApiConfig({
    ...REQUIRED_ENV_FIXTURE,
    NODE_ENV: "test",
    SESSION_API_PORT: "0",
  });
  const capture = createLogCapture();
  return { logger: createLogger(config, capture.stream), capture };
}

describe("★ 机检 ②:应用侧日志零票据(真实装配路径)", () => {
  it("携带 ?t=<票据> 的请求**整体**不落日志;捕获到的每个 req.url 均不含票据", async () => {
    const { logger, capture } = realPipeline();
    const config = loadSessionApiConfig({
      ...REQUIRED_ENV_FIXTURE,
      NODE_ENV: "test",
      SESSION_API_PORT: "0",
    });
    const app = buildServer(config, logger, {});
    await app.ready();

    const token = generateLaunchTicketToken();
    // 换票路径形态(该路由此刻尚未装配 ⇒ 404,但**请求日志面照常产生** ——
    // 这正是本用例要覆盖的:泄漏发生在日志,而非响应)。
    const response = await app.inject({
      method: "GET",
      url: `/app/c/ch-stack-frame/1.0.0?t=${token}`,
    });
    expect(response.statusCode).toBe(404);

    // ★ 断言一:整个日志文本不含票据(最宽口径 —— 连"票据恰好出现在别的
    //   字段里"也抓住)。
    expect(capture.raw()).not.toContain(token);
    // ★ 断言二:逐个 req.url(窄口径,给出可定位的失败信息)。
    const urls = capture
      .entries()
      .map((entry) => (entry["req"] as { url?: string } | undefined)?.url)
      .filter((url): url is string => typeof url === "string");
    expect(urls.length).toBeGreaterThan(0); // 请求日志确实产生了(否则本用例空转)
    for (const url of urls) {
      expect(url).not.toContain(token);
      expect(url).not.toContain("?");
    }
    // 断言三:路径部分仍被记录(脱敏不是"把 url 整个删掉")。
    expect(urls.some((url) => url === "/app/c/ch-stack-frame/1.0.0")).toBe(true);

    await app.close();
  });

  it("形态无关:票据挂在**任意**查询参数名下都不落日志(参数名漂移免疫)", async () => {
    const { logger, capture } = realPipeline();
    const config = loadSessionApiConfig({
      ...REQUIRED_ENV_FIXTURE,
      NODE_ENV: "test",
      SESSION_API_PORT: "0",
    });
    const app = buildServer(config, logger, {});
    await app.ready();

    const token = generateLaunchTicketToken();
    await app.inject({ method: "GET", url: `/host/scores?notTheTicketParam=${token}` });

    expect(capture.raw()).not.toContain(token);
    await app.close();
  });

  it("脱敏不破日志可用性:非票据查询串同样被剥离(如实登记的代价)", async () => {
    const { logger, capture } = realPipeline();
    const config = loadSessionApiConfig({
      ...REQUIRED_ENV_FIXTURE,
      NODE_ENV: "test",
      SESSION_API_PORT: "0",
    });
    const app = buildServer(config, logger, {});
    await app.ready();

    await app.inject({ method: "GET", url: "/host/scores?cursor=abc&limit=10" });
    const raw = capture.raw();
    expect(raw).not.toContain("cursor=abc");
    expect(raw).not.toContain("limit=10");
    // 请求本身仍被记录(否则"脱敏"退化成"不记日志")。
    expect(raw).toContain("/host/scores");

    await app.close();
  });
});

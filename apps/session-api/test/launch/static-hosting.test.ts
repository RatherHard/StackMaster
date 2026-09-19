/**
 * 页面托管集成用例(分发改版 WP-92;D-API-161)。
 *
 * 三件事必须被锁死,否则"配了静态托管就把换票吃掉"会在生产才暴露:
 *
 *  1. **路由优先级**:`GET /app/c/:challengeId/:version`(换票,动态段)在
 *     静态托管注册**之后**仍被换票处理(302 + Cookie),而不是被静态面吞掉。
 *     这正是本 WP 最容易踩坏的地方 —— `/app` 前缀由两条路由共享。
 *  2. **静态托管真的生效**:`GET /app/` 取回 `dist/index.html`,且响应头是
 *     D-LT-3 ⓪ 要求的 `Cache-Control: no-store` + `Referrer-Policy: no-referrer`;
 *     `/app/**` 下的真实文件可取(产物里的 vm-ui 资源)。
 *  3. **"未配置 ⇒ 不注册"不等于"换票失效"**:页面托管是**可解耦**的服务端
 *     能力;未配置时静态面 404(冻结 PublicError 形态),而换票照常工作
 *     —— 运维用同域反代托管页面是完全合法的部署形态。
 *
 * 载体 = 与生产**同一份**装配逻辑(`test/routes/helpers/session-rig.ts` 调
 * `resolvePageAppDir` + `buildPageAppShell`,`server.ts` 按同一注册序挂载);
 * 目录 = 真实构建产物 `apps/page-app/dist`(整仓门禁序里 `pnpm build` 先于
 * `pnpm test`)。
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LAUNCH_GRANT_COOKIE_NAME } from "../../src/auth/cookie.js";
import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  TEST_HOST_BACKEND_TOKEN,
  TEST_TENANT_ID,
  buildSessionTestRig,
  type SessionTestRig,
} from "../routes/helpers/session-rig.js";

/** 页面应用构建产物目录(仓库内真实路径;与 runtime.ts 的缺省同源)。 */
const PAGE_APP_DIST = fileURLToPath(new URL("../../../page-app/dist/", import.meta.url));

/** 装配路径断言用到的三处源码面(见对应用例的理由段)。 */
const INDEX_ENTRY_PATH = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const SERVER_SOURCE_PATH = fileURLToPath(new URL("../../src/server.ts", import.meta.url));
const RUNTIME_SOURCE_PATH = fileURLToPath(
  new URL("../../src/runtime/runtime.ts", import.meta.url),
);

/** 仓库内**不存在**的目录(表达"该部署不托管页面"的显式配置)。 */
const MISSING_PAGE_APP_DIST = fileURLToPath(
  new URL("./__no_such_page_app_dir__/", import.meta.url),
);

const PUBLIC_ORIGIN = "https://lab.example.test";

/** 产物是否在场(未构建 ⇒ 静态面用例整组跳过;换票用例照跑)。 */
const distBuilt = existsSync(PAGE_APP_DIST);

/** 装配一条完整启用签发面的装置(白名单租户 + 公开来源 + 已发布题目)。 */
async function buildRig(env: Record<string, string> = {}): Promise<SessionTestRig> {
  const rig = await buildSessionTestRig({
    env: {
      SESSION_API_HOST_TENANTS: TEST_TENANT_ID,
      SESSION_API_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      ...env,
    },
  });
  await rig.registerByteChallenge({});
  return rig;
}

/** 签发一张票并取出票据值(走真实签发路由)。 */
async function issueTicket(rig: SessionTestRig): Promise<string> {
  const response = await rig.app.inject({
    method: "POST",
    url: "/auth/launch-tickets",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TEST_HOST_BACKEND_TOKEN}`,
    },
    payload: { challengeId: TEST_CHALLENGE_ID, version: TEST_CHALLENGE_VERSION },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { launchUrl: string };
  const ticket = new URL(body.launchUrl).searchParams.get("t") ?? "";
  expect(ticket.length).toBeGreaterThan(0);
  return ticket;
}

/** 换票(带 `Sec-Fetch-Mode: navigate`)。 */
function redeem(rig: SessionTestRig, ticket: string) {
  return rig.app.inject({
    method: "GET",
    url: `/app/c/${TEST_CHALLENGE_ID}/${TEST_CHALLENGE_VERSION}?t=${encodeURIComponent(ticket)}`,
    headers: { "sec-fetch-mode": "navigate" },
  });
}

describe("★ 路由优先级:换票路由不被静态托管吞掉(D-API-161)", () => {
  it("注册了静态托管时,`GET /app/c/:challengeId/:version?t=` 仍是换票(302 + 授权凭证 Cookie)", async () => {
    const rig = await buildRig({ SESSION_API_PAGE_APP_DIR: PAGE_APP_DIST });
    const ticket = await issueTicket(rig);

    const redeemed = await redeem(rig, ticket);

    // 换票语义(而非"拿到一个页面"):302 + 干净路径 + 授权凭证 Cookie。
    expect(redeemed.statusCode).toBe(302);
    expect(redeemed.headers["location"]).toBe(
      `/app/c/${TEST_CHALLENGE_ID}/${TEST_CHALLENGE_VERSION}`,
    );
    expect(redeemed.headers["set-cookie"]).toContain(LAUNCH_GRANT_COOKIE_NAME);
    // D-LT-3 ⓪:换票响应带 no-store / no-referrer(与页面响应同族)。
    expect(redeemed.headers["cache-control"]).toBe("no-store");
    expect(redeemed.headers["referrer-policy"]).toBe("no-referrer");
    // 第二次仍 401(单次消费未被"静态路径"影响语义)。
    const replay = await redeem(rig, ticket);
    expect(replay.statusCode).toBe(401);
  });
});

describe("静态托管生效时(D-API-161;需构建产物)", () => {
  it.skipIf(!distBuilt)("`GET /app/` 取回 index.html,且带 no-store + no-referrer", async () => {
    const rig = await buildRig({ SESSION_API_PAGE_APP_DIR: PAGE_APP_DIST });
    const response = await rig.app.inject({ method: "GET", url: "/app/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    // 页面必须真的存在(而不是某个 200 的兜底页):断言构建入口标志。
    expect(response.body).toContain("#app");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });

  it.skipIf(!distBuilt)("`/app/**` 下的真实产物文件可取(vm-ui 资源经同源静态路径交付)", async () => {
    const rig = await buildRig({ SESSION_API_PAGE_APP_DIR: PAGE_APP_DIST });
    // 产物里必然存在的文件:构建期从 packages/vm-ui/dist 拷入的入口模块。
    const response = await rig.app.inject({ method: "GET", url: "/app/vm-ui/index.js" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("javascript");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.body.length).toBeGreaterThan(1000);
  });

  it.skipIf(!distBuilt)("未知 `/app/**` 路径落到冻结 404 形态(wildcard:false ⇒ 不吞任意路径)", async () => {
    const rig = await buildRig({ SESSION_API_PAGE_APP_DIR: PAGE_APP_DIST });
    const response = await rig.app.inject({ method: "GET", url: "/app/definitely-not-a-file.js" });
    expect(response.statusCode).toBe(404);
    // 冻结 PublicError 形态(而非框架默认报文)。
    expect(response.json()).toEqual({ code: "invalid_input_format", message: "resource not found" });
  });
});

describe("★ 装配路径断言(防 D-API-156 缺陷族复发)", () => {
  /**
   * `runtime` 造好的插件必须被**进程入口**传给 `buildServer` —— 否则生产
   * 面静默缺失而测试接缝全绿(这正是 D-API-156 缺陷 1 的成因:`hostScoresRoutes`
   * 造好却漏传,生产 `GET /host/scores` 从未挂载)。
   *
   * 载体 = 有界源码面机检(与 `test/debug/demo-challenge-debug-capability.test.ts`
   * 的「防漂移机检」同款):`index.ts` 是进程入口、顶层即 `main()` 与 listen,
   * 无法在单测里 import 执行;而本断言要锁的是**那一行传递**,源码面正是
   * 唯一能表达它的地方。
   */
  it("进程入口 index.ts 把 runtime.pageAppShell 传给 buildServer(漏传即生产缺面)", () => {
    const source = readFileSync(INDEX_ENTRY_PATH, "utf8");
    expect(source).toMatch(/^\s*pageAppShell:\s*runtime\.pageAppShell,\s*$/m);
  });

  it("装配点齐备:server.ts 注册该 deps 字段 + runtime.ts 构造它(三处同改的义务)", () => {
    const serverSource = readFileSync(SERVER_SOURCE_PATH, "utf8");
    const runtimeSource = readFileSync(RUNTIME_SOURCE_PATH, "utf8");
    // server.ts:deps 字段 + register 块(且 register 在 launchRoutes 之后)。
    expect(serverSource).toMatch(/readonly pageAppShell\?:/);
    const registerIndex = serverSource.indexOf("app.register(deps.pageAppShell)");
    const launchRegisterIndex = serverSource.indexOf("app.register(deps.launchRoutes)");
    expect(registerIndex).toBeGreaterThan(-1);
    expect(launchRegisterIndex).toBeGreaterThan(-1);
    // **路由优先级的装配层保证**:静态托管注册必须晚于换票路由。
    expect(registerIndex).toBeGreaterThan(launchRegisterIndex);
    // runtime.ts:构造 + 返回字段。
    expect(runtimeSource).toMatch(/buildPageAppShell\(\{\s*distDir:/);
    expect(runtimeSource).toMatch(/^\s*pageAppShell,\s*$/m);
  });
});

describe("页面目录配置形态(D-API-161:配置错误 fail-closed)", () => {
  it("显式配置却指不到目录 ⇒ **启动期**拒绝(fail-closed,不是运行期 404)", async () => {
    const outcome = await buildRig({ SESSION_API_PAGE_APP_DIR: MISSING_PAGE_APP_DIST }).catch(
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("SESSION_API_PAGE_APP_DIR");
  });

  it("未显式配置 ⇒ 用仓库内缺省目录;无论缺省是否可用,换票照常(解耦)", async () => {
    const rig = await buildRig();
    const staticProbe = await rig.app.inject({ method: "GET", url: "/app/" });
    // 缺省目录存在(已构建)⇒ 200;不存在 ⇒ 404 冻结形态。两条分支都合法。
    expect([200, 404]).toContain(staticProbe.statusCode);

    const ticket = await issueTicket(rig);
    const redeemed = await redeem(rig, ticket);
    expect(redeemed.statusCode).toBe(302);
  });
});

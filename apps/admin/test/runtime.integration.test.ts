/**
 * admin 全装配集成测试(容器门控;WP-79)。
 *
 * 承载面:`buildAdminRuntime` **全装配**(真实 PostgreSQL 连接池 + 独立只读
 * 角色 `admin_ro` + 真实 RLS 政策 + 真实三表连接 + 受控日志审计 + 指标),
 * 以及装配出的服务经**真实 HTTP** 的三面读数。
 *
 * 为什么必须有这一条(纪律先例 D-API-120):单元 / 服务级用例走测试装置
 * (`test/helpers/rig.ts`)装配,与生产装配路径**不是同一条**;verifier 的
 * 教训是"测试接缝自己传了参数,生产入口漏传"这类缺陷只在**装配路径**上
 * 才可见。故 `runtime.ts` 的覆盖由本文件承载(与 verifier
 * `test/runtime.integration.test.ts` 同款分工)。
 *
 * 门控:`SESSION_API_IT=1`(globalSetup 负责 compose deps up --wait / down)。
 */
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AdminConfig } from "../src/config.js";
import { ADMIN_ROUTES } from "../src/routes/admin-routes.js";
import { buildAdminRuntime, type AdminRuntime } from "../src/runtime.js";
import { silentLogger } from "./helpers/rig.js";
import {
  ADMIN_ROLE,
  ADMIN_ROLE_PASSWORD,
  IT_CONFIG,
  IT_ENABLED,
  SKIP_REASON,
  ensureAdminGrants,
  ensureAdminRole,
  ensureMigrated,
  insertSession,
  insertSubmission,
  insertVerdict,
  purgeTenant,
  registerChallenge,
  uniqueIds,
  withRole,
} from "./helpers/it.js";

const TEST_CREDENTIAL = "admin-it-credential-0123456789";
const TEST_CREDENTIAL_SHA256 = createHash("sha256")
  .update(TEST_CREDENTIAL, "utf8")
  .digest("hex");

function itConfig(tenants: readonly string[]): AdminConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    // 0 = 临时端口(测试不占用固定端口,避免与并行套件冲突)。
    port: 0,
    logLevel: "info",
    logErrorStacks: false,
    gracefulShutdownTimeoutSeconds: 10,
    postgresUrl: withRole(IT_CONFIG.postgresUrl, ADMIN_ROLE, ADMIN_ROLE_PASSWORD),
    credentialSha256: TEST_CREDENTIAL_SHA256,
    tenants,
    scoresBatch: 10,
    rateLimitPerMinute: 100,
  };
}

function baseUrl(runtime: AdminRuntime): string {
  const address = runtime.server.server.address() as AddressInfo | null;
  if (address === null) {
    throw new Error("server 未监听");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe.skipIf(!IT_ENABLED)(`buildAdminRuntime 全装配(容器门控;${SKIP_REASON})`, () => {
  const ids = uniqueIds("admin-runtime");
  const challengeId = `chal-${ids.tenantId}`;
  let admin: Pool;
  let runtime: AdminRuntime;

  beforeAll(async () => {
    admin = new Pool({ connectionString: IT_CONFIG.postgresUrl });
    await ensureAdminRole(admin);
    await ensureMigrated(admin);
    await ensureAdminGrants(admin);
    await registerChallenge(admin, {
      tenantId: ids.tenantId,
      challengeId,
      contentVersion: "1.0.0",
      title: "runtime IT",
    });
    await insertSession(admin, {
      tenantId: ids.tenantId,
      sessionId: ids.sessionId,
      challengeId,
      challengeVersion: "1.0.0",
    });
    const submissionId = await insertSubmission(admin, {
      tenantId: ids.tenantId,
      sessionId: ids.sessionId,
    });
    await insertVerdict(admin, {
      tenantId: ids.tenantId,
      submissionId,
      verdict: "success",
      detail: { hiddenTestIndex: 7 },
    });

    runtime = await buildAdminRuntime(itConfig([ids.tenantId]), silentLogger);
    await runtime.startServer();
  }, 120_000);

  afterAll(async () => {
    for (const step of runtime.closeHandles) {
      await step.run();
    }
    await purgeTenant(admin, ids.tenantId);
    await admin.end();
  });

  const headers = { authorization: `Bearer ${TEST_CREDENTIAL}` };

  it("装配出的运维面:healthz 200 / readyz 200(真实 ping 经 admin_ro)/ metrics 有界", async () => {
    // 停机句柄按序注册(关服务 → 关连接池):顺序是停机语义的一部分。
    expect(runtime.closeHandles.map((step) => step.name)).toEqual([
      "close-admin-server",
      "close-postgres",
    ]);
    const base = baseUrl(runtime);
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    const metrics = await fetch(`${base}/metrics`);
    expect(metrics.status).toBe(200);
    const text = await metrics.text();
    // 绑定租户**数量**入指标(标识符绝不入标签)。
    expect(text).toContain("admin_bound_tenants 1");
    expect(text).not.toContain(ids.tenantId);
  });

  it("装配路径端到端:三面经真实 PG + RLS + 适配器 + 契约校验读数", async () => {
    const base = baseUrl(runtime);
    const challenges = await fetch(`${base}${ADMIN_ROUTES.challenges}`, { headers });
    expect(challenges.status).toBe(200);
    const challengeBody = (await challenges.json()) as {
      items: { challengeId: string; title: string | null; versions: { contentVersion: string }[] }[];
    };
    expect(challengeBody.items.map((item) => item.challengeId)).toEqual([challengeId]);
    expect(challengeBody.items[0]?.versions.map((version) => version.contentVersion)).toEqual([
      "1.0.0",
    ]);

    const verdicts = await fetch(`${base}${ADMIN_ROUTES.verdicts}`, { headers });
    expect(verdicts.status).toBe(200);
    const verdictBody = (await verdicts.json()) as {
      items: { status: string; verdict?: string }[];
      truncated: boolean;
    };
    expect(verdictBody.truncated).toBe(false);
    expect(verdictBody.items.some((item) => item.status === "verdicted" && item.verdict === "success")).toBe(
      true,
    );
    expect(JSON.stringify(verdictBody)).not.toContain("hiddenTestIndex");

    const scores = await fetch(`${base}${ADMIN_ROUTES.scores}`, { headers });
    expect(scores.status).toBe(200);
    const scoresBody = (await scores.json()) as {
      items: { challengeId: string; challengeVersion: string; verdict: string }[];
      nextCursor: string | null;
    };
    expect(scoresBody.items).toHaveLength(1);
    expect(scoresBody.items[0]?.challengeId).toBe(challengeId);
    expect(scoresBody.items[0]?.challengeVersion).toBe("1.0.0");
    expect(scoresBody.nextCursor).toBeNull();
    // 私有判题明细与租户字段在真实载荷里零命中。
    expect(JSON.stringify(scoresBody)).not.toContain("detail");
    expect(JSON.stringify(scoresBody)).not.toContain("tenantId");
  });

  it("未绑定租户 / 未认证在真实装配下同为冻结拒绝(404 / 401 同形)", async () => {
    const base = baseUrl(runtime);
    const crossTenant = await fetch(
      `${base}${ADMIN_ROUTES.scores}?tenant=${ids.tenantId}-other`,
      { headers },
    );
    expect(crossTenant.status).toBe(404);
    expect(await crossTenant.text()).toBe(
      JSON.stringify({ code: "invalid_input_format", message: "resource not found" }),
    );
    const anonymous = await fetch(`${base}${ADMIN_ROUTES.scores}`);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).toBe(
      JSON.stringify({ code: "invalid_input_format", message: "authentication failed" }),
    );
  });

  it("空白名单装配 = 合法 fail-closed 态(进程照常起,数据面整体 404 同形)", async () => {
    const strict = await buildAdminRuntime(itConfig([]), silentLogger);
    await strict.startServer();
    try {
      expect(await strict.metrics.render()).toContain("admin_bound_tenants 0");
      const response = await fetch(`${baseUrl(strict)}${ADMIN_ROUTES.challenges}`, { headers });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(
        JSON.stringify({ code: "invalid_input_format", message: "resource not found" }),
      );
    } finally {
      for (const step of strict.closeHandles) {
        await step.run();
      }
    }
  });
});

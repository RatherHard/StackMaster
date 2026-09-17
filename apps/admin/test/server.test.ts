/**
 * 管理面服务级测试(D-MP-5 分支 A;WP-79 第 6 条「服务级用例」)。
 *
 * 覆盖矩阵:
 *  - 运维面:healthz / readyz(探针失败 503 冻结且失败方不透出)/ metrics
 *    (指标名 ⊆ 白名单、零秘密语料、零租户标识符);
 *  - 凭证矩阵:缺失 / 错误 / 畸形 → 401 冻结同形;正确 → 200;
 *  - 租户作用域:白名单内子选、跨租户与不存在**同形**、白名单为空整体 404
 *    且零存储调用(防枚举 + fail-closed);
 *  - 只读面零写:三条数据路由全部 GET(POST 无路由)、存储只被读方法调用;
 *  - 裁决面契约:载荷逐条过 `VerdictQueryResponseSchema`(pending 三字段 /
 *    verdicted 五字段,零 `detail`);
 *  - 成绩面契约:经 HTTP 的载荷同样逐字过 `HostScoresResponseSchema`;
 *  - 审计 fail-closed:审计写失败 ⇒ 503 且零数据下发;
 *  - 安全头:CSP `frame-ancestors 'none'` 与插件链路分离;
 *  - 最小只读页:语义化 DOM / 零内联脚本样式 / 凭证零持久化。
 */
import { describe, expect, it } from "vitest";
import { HostScoresResponseSchema, VerdictQueryResponseSchema } from "@stackmaster/protocol";

import { ADMIN_AUDIT_ACTOR } from "../src/audit/admin-audit.js";
import { AdminCredentialVerifier } from "../src/auth/credential.js";
import { ADMIN_CONTENT_SECURITY_POLICY, adminSecurityHeaders } from "../src/http/security-headers.js";
import { METRIC_FAMILIES } from "../src/metrics.js";
import { ADMIN_RATE_LIMITED_ERROR, AdminRateLimiter } from "../src/rate-limit.js";
import {
  ADMIN_AUDIT_UNAVAILABLE_ERROR,
  ADMIN_INVALID_REQUEST_ERROR,
  ADMIN_NOT_FOUND_ERROR,
  ADMIN_ROUTES,
  ADMIN_STORAGE_UNAVAILABLE_ERROR,
  ADMIN_UNAUTHORIZED,
  ADMIN_UNAVAILABLE_STATUS,
} from "../src/routes/admin-routes.js";
import { buildAdminServer, CONSOLE_ROUTES } from "../src/server.js";
import { HOST_SCORE_RECORD_FIELDS } from "../src/scores/export.js";
import { CONSOLE_CSS, CONSOLE_JS } from "../src/console/page-source.js";
import { AdminMetrics } from "../src/metrics.js";
import { AdminStoreError } from "../src/persistence/ports.js";
import type { AdminReadStore } from "../src/persistence/ports.js";
import {
  authHeaders,
  createAdminTestRig,
  silentLogger,
  TEST_CREDENTIAL,
  TEST_CREDENTIAL_SHA256,
  type AdminTestRig,
} from "./helpers/rig.js";

const SUBMISSION_A = "11111111-1111-4111-8111-111111111111";
const SUBMISSION_A_PENDING = "33333333-3333-4333-8333-333333333333";
const SUBMISSION_PENDING = "22222222-2222-4222-8222-222222222222";
const SCORE_ROW_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SCORE_ROW_B = "aaaaaaaa-0000-4000-8000-000000000002";
const SESSION_A = "sess-000000000001";
const SESSION_B = "sess-000000000002";

/** 播种两个租户(tenant-a = 绑定;tenant-b = 白名单外)。 */
function seed(rig: AdminTestRig): void {
  for (const tenant of ["tenant-a", "tenant-b"]) {
    rig.store.seedChallenge({
      tenantId: tenant,
      // challenges 主键是 challenge_id(全局唯一,001 迁移):题目归属单一租户,
      // 故按租户给出不同题目标识(与库层形态一致)。
      challengeId: `chal-${tenant}`,
      title: "IT 题目",
      versions: [
        {
          contentVersion: "1.0.0",
          vmProfileVersion: "1.0.0",
          registeredAtEpochSeconds: 1_700_000_000,
        },
      ],
    });
  }
  rig.store.seedSubmission({
    tenantId: "tenant-a",
    submissionId: SUBMISSION_A,
    sessionId: SESSION_A,
    revision: 3,
    challengeId: "chal-tenant-a",
    challengeVersion: "1.0.0",
    createdAtEpochSeconds: 1_700_000_000,
    verdict: "success",
    decidedAtEpochSeconds: 1_700_000_100,
    scoreRowId: SCORE_ROW_A,
  });
  rig.store.seedSubmission({
    tenantId: "tenant-b",
    submissionId: SUBMISSION_PENDING,
    sessionId: SESSION_B,
    revision: 4,
    challengeId: "chal-tenant-b",
    challengeVersion: "1.0.0",
    createdAtEpochSeconds: 1_700_000_500,
    verdict: "wrong_answer",
    decidedAtEpochSeconds: 1_700_000_600,
    scoreRowId: SCORE_ROW_B,
  });
}

describe("admin 运维面(healthz / readyz / metrics)", () => {
  it("healthz 恒 200;readyz 探针全过 200", async () => {
    const rig = await createAdminTestRig();
    const health = await rig.server.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    const ready = await rig.server.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(200);
    await rig.server.close();
  });

  it("readyz 探针失败 → 503 冻结形态,失败方不透出", async () => {
    const server = await buildAdminServer({
      logger: silentLogger,
      metrics: new AdminMetrics(),
      readinessProbes: [
        {
          name: "postgres",
          check: async () => {
            throw new Error("password authentication failed for user admin_ro");
          },
        },
      ],
      console: false,
    });
    await server.ready();
    const ready = await server.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(503);
    expect(ready.body).toBe(
      JSON.stringify({ code: "internal_error", message: "dependencies unavailable" }),
    );
    expect(ready.body).not.toContain("admin_ro");
    expect(ready.body).not.toContain("password");
    await server.close();
  });

  it("metrics:指标名 ⊆ 白名单;标签是有界枚举;零秘密语料、零租户标识符", async () => {
    const rig = await createAdminTestRig();
    seed(rig);
    await rig.server.inject({
      method: "GET",
      url: `${ADMIN_ROUTES.scores}?tenant=tenant-a`,
      headers: authHeaders(),
    });
    await rig.server.inject({ method: "GET", url: ADMIN_ROUTES.scores, headers: authHeaders("wrong-credential") });
    const response = await rig.server.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
    const text = response.body;
    const names = text
      .split("\n")
      .filter((line) => line.startsWith("# TYPE "))
      .map((line) => (line.split(" ")[2] ?? "").replace(/^([a-z_]+).*$/, "$1"))
      .filter((name) => name !== "");
    expect(names.length).toBeGreaterThan(0);
    for (const family of names) {
      expect(METRIC_FAMILIES.some((name) => family.startsWith(name)), family).toBe(true);
    }
    expect(text).toContain('surface="scores"');
    expect(text).toContain('outcome="ok"');
    expect(text).toContain('outcome="denied"');
    // 零标识符纪律:租户标识符不得出现在指标渲染面(只允许数量)。
    expect(text).not.toContain("tenant-a");
    expect(text).not.toContain("tenant-b");
    expect(text).toContain("admin_bound_tenants 1");
    // 零秘密语料(凭证值 / 摘要形态)。
    expect(text).not.toContain(TEST_CREDENTIAL);
    await rig.server.close();
  });
});

describe("admin 凭证矩阵与租户作用域", () => {
  it("缺失 / 非 Bearer / 错误凭证 → 401 同形冻结体", async () => {
    const rig = await createAdminTestRig();
    seed(rig);
    const missing = await rig.server.inject({ method: "GET", url: ADMIN_ROUTES.scores });
    const notBearer = await rig.server.inject({
      method: "GET",
      url: ADMIN_ROUTES.scores,
      headers: { authorization: TEST_CREDENTIAL },
    });
    const wrong = await rig.server.inject({
      method: "GET",
      url: ADMIN_ROUTES.scores,
      headers: authHeaders("wrong-credential"),
    });
    for (const response of [missing, notBearer, wrong]) {
      expect(response.statusCode).toBe(401);
      expect(response.body).toBe(JSON.stringify(ADMIN_UNAUTHORIZED));
    }
    // 未认证请求不得触碰数据面(零存储调用)。
    expect(rig.store.readCalls).toEqual([]);
    await rig.server.close();
  });

  it("白名单内子选放行;白名单外租户与不存在**同形** 404", async () => {
    const rig = await createAdminTestRig({ tenants: ["tenant-a"] });
    seed(rig);
    const own = await rig.server.inject({
      method: "GET",
      url: `${ADMIN_ROUTES.scores}?tenant=tenant-a`,
      headers: authHeaders(),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json<{ items: { id: string }[] }>().items.map((item) => item.id)).toEqual([
      SCORE_ROW_A,
    ]);
    // 跨租户:tenant-b 存在于库中但不在绑定集合 ⇒ 与不存在同形。
    const crossTenant = await rig.server.inject({
      method: "GET",
      url: `${ADMIN_ROUTES.scores}?tenant=tenant-b`,
      headers: authHeaders(),
    });
    const nonexistent = await rig.server.inject({
      method: "GET",
      url: `${ADMIN_ROUTES.scores}?tenant=tenant-zzz`,
      headers: authHeaders(),
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.body).toBe(JSON.stringify(ADMIN_NOT_FOUND_ERROR));
    expect(nonexistent.statusCode).toBe(404);
    expect(nonexistent.body).toBe(crossTenant.body);
    await rig.server.close();
  });

  it("白名单为空 ⇒ 数据面整体 404 同形且零存储调用(fail-closed)", async () => {
    const rig = await createAdminTestRig({ tenants: [] });
    seed(rig);
    for (const route of [ADMIN_ROUTES.challenges, ADMIN_ROUTES.verdicts, ADMIN_ROUTES.scores]) {
      const response = await rig.server.inject({ method: "GET", url: route, headers: authHeaders() });
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe(JSON.stringify(ADMIN_NOT_FOUND_ERROR));
    }
    expect(rig.store.readCalls).toEqual([]);
    await rig.server.close();
  });

  it("多租户绑定且未指定租户 ⇒ 404 同形(不猜、不回退第一个)", async () => {
    const rig = await createAdminTestRig({ tenants: ["tenant-a", "tenant-b"] });
    seed(rig);
    const ambiguous = await rig.server.inject({
      method: "GET",
      url: ADMIN_ROUTES.scores,
      headers: authHeaders(),
    });
    expect(ambiguous.statusCode).toBe(404);
    expect(ambiguous.body).toBe(JSON.stringify(ADMIN_NOT_FOUND_ERROR));
    const explicit = await rig.server.inject({
      method: "GET",
      url: `${ADMIN_ROUTES.scores}?tenant=tenant-b`,
      headers: authHeaders(),
    });
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json<{ items: { id: string }[] }>().items.map((item) => item.id)).toEqual([
      SCORE_ROW_B,
    ]);
    await rig.server.close();
  });

  it("查询参数严格:未知参数 / 非法游标 / 越天花板 limit → 400 冻结体", async () => {
    const rig = await createAdminTestRig();
    seed(rig);
    const cases = [
      `${ADMIN_ROUTES.scores}?tenantt=tenant-a`,
      `${ADMIN_ROUTES.scores}?cursor=not-a-uuid`,
      `${ADMIN_ROUTES.scores}?limit=100000`,
      `${ADMIN_ROUTES.verdicts}?since=abc`,
      `${ADMIN_ROUTES.verdicts}?submissionId=not-a-uuid`,
    ];
    for (const url of cases) {
      const response = await rig.server.inject({ method: "GET", url, headers: authHeaders() });
      expect(response.statusCode, url).toBe(400);
      expect(response.body).toBe(JSON.stringify(ADMIN_INVALID_REQUEST_ERROR));
    }
    await rig.server.close();
  });
});

describe("admin 只读面零写", () => {
  it("三条数据路由只接受 GET(POST 即 404 且零存储调用)", async () => {
    const rig = await createAdminTestRig();
    seed(rig);
    for (const route of [ADMIN_ROUTES.challenges, ADMIN_ROUTES.verdicts, ADMIN_ROUTES.scores]) {
      const posted = await rig.server.inject({
        method: "POST",
        url: route,
        headers: authHeaders(),
        payload: { tenant: "tenant-a" },
      });
      expect(posted.statusCode, route).toBe(404);
    }
    expect(rig.store.readCalls).toEqual([]);
    await rig.server.close();
  });

  it("存储只被读方法触达(调用轨迹里不存在写方法名)", async () => {
    const rig = await createAdminTestRig();
    seed(rig);
    await rig.server.inject({
      method: "GET",
      url: `${ADMIN_ROUTES.challenges}?tenant=tenant-a`,
      headers: authHeaders(),
    });
    await rig.server.inject({
      method: "GET",
      url: `${ADMIN_ROUTES.verdicts}?tenant=tenant-a`,
      headers: authHeaders(),
    });
    await rig.server.inject({
      method: "GET",
      url: `${ADMIN_ROUTES.scores}?tenant=tenant-a`,
      headers: authHeaders(),
    });
    expect([...new Set(rig.store.readCalls)].sort()).toEqual([
      "listChallenges",
      "queryVerdicts",
      "readScoresPage",
    ]);
    // 端口实现的原型面 = 只读面(写方法不存在于类型上,也不存在于运行时)。
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(rig.store)).sort()).toEqual([
      "constructor",
      "listChallenges",
      "queryVerdicts",
      "readScoresPage",
      "seedChallenge",
      "seedSubmission",
    ]);
    await rig.server.close();
  });
});

describe("admin 裁决面与成绩面契约", () => {
  it("裁决载荷逐条过 VerdictQueryResponseSchema(pending 三字段 / verdicted 五字段)", async () => {
    const rig = await createAdminTestRig({ tenants: ["tenant-a", "tenant-b"] });
    seed(rig);
    rig.store.seedSubmission({
      tenantId: "tenant-a",
      submissionId: SUBMISSION_A_PENDING,
      sessionId: "sess-pending",
      revision: 7,
      challengeId: "chal-tenant-a",
      challengeVersion: "1.0.0",
      createdAtEpochSeconds: 1_700_001_000,
      verdict: null,
      decidedAtEpochSeconds: null,
      scoreRowId: null,
    });
    const response = await rig.server.inject({
      method: "GET",
      url: `${ADMIN_ROUTES.verdicts}?tenant=tenant-a`,
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ items: Record<string, unknown>[]; truncated: boolean }>();
    expect(body.truncated).toBe(false);
    expect(body.items).toHaveLength(2);
    for (const item of body.items) {
      expect(() => VerdictQueryResponseSchema.parse(item)).not.toThrow();
    }
    const pending = body.items.find((item) => item["submissionId"] === SUBMISSION_A_PENDING);
    expect(Object.keys(pending ?? {}).sort()).toEqual(["revision", "status", "submissionId"]);
    const verdicted = body.items.find((item) => item["submissionId"] === SUBMISSION_A);
    expect(Object.keys(verdicted ?? {}).sort()).toEqual([
      "decidedAt",
      "revision",
      "status",
      "submissionId",
      "verdict",
    ]);
    expect(JSON.stringify(body)).not.toContain("detail");
    await rig.server.close();
  });

  it("裁决面时间窗过滤生效;命中上限时 truncated = true", async () => {
    const rig = await createAdminTestRig();
    seed(rig);
    const empty = await rig.server.inject({
      method: "GET",
      url: `${ADMIN_ROUTES.verdicts}?tenant=tenant-a&since=1700000500`,
      headers: authHeaders(),
    });
    expect(empty.json<{ items: unknown[] }>().items).toEqual([]);
    // 第二条 tenant-a 提交(时间窗内的新提交)⇒ limit=1 时必然截断。
    rig.store.seedSubmission({
      tenantId: "tenant-a",
      submissionId: SUBMISSION_A_PENDING,
      sessionId: "sess-second",
      revision: 8,
      challengeId: "chal-tenant-a",
      challengeVersion: "1.0.0",
      createdAtEpochSeconds: 1_700_002_000,
      verdict: null,
      decidedAtEpochSeconds: null,
      scoreRowId: null,
    });
    const truncated = await rig.server.inject({
      method: "GET",
      url: `${ADMIN_ROUTES.verdicts}?tenant=tenant-a&limit=1`,
      headers: authHeaders(),
    });
    expect(truncated.json<{ truncated: boolean }>().truncated).toBe(true);
    await rig.server.close();
  });

  it("题目登记列表只含公开登记值(题目标识 / 标题 / 版本链)", async () => {
    const rig = await createAdminTestRig();
    seed(rig);
    const response = await rig.server.inject({
      method: "GET",
      url: `${ADMIN_ROUTES.challenges}?tenant=tenant-a`,
      headers: authHeaders(),
    });
    const body = response.json<{ items: Record<string, unknown>[] }>();
    expect(body.items).toHaveLength(1);
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(["challengeId", "title", "versions"]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("private_bundle");
    expect(serialized).not.toContain("signature");
    expect(serialized).not.toContain("sha256");
    await rig.server.close();
  });

  it("题目登记值越过公开包契约 ⇒ 503 零下发(不把越界值下发给运维)", async () => {
    const rig = await createAdminTestRig();
    rig.store.seedChallenge({
      tenantId: "tenant-a",
      // 库层无 CHECK(001 迁移是自由文本)⇒ 越界值真的可能落库;
      // 读面出口校验是唯一拦截面。
      challengeId: "UPPER-CASE-ID",
      title: "漂移题目",
      versions: [
        {
          contentVersion: "1.0.0",
          vmProfileVersion: "1.0.0",
          registeredAtEpochSeconds: 1_700_000_000,
        },
      ],
    });
    const response = await rig.server.inject({
      method: "GET",
      url: `${ADMIN_ROUTES.challenges}?tenant=tenant-a`,
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe(JSON.stringify(ADMIN_STORAGE_UNAVAILABLE_ERROR));
    expect(response.body).not.toContain("UPPER-CASE-ID");
    expect(response.body).not.toContain("漂移题目");
    // 数据确被读过(不是"没查到"的假绿),失败落审计 outcome=error。
    expect(rig.store.readCalls).toContain("listChallenges");
    expect(rig.audit.entries.at(-1)?.outcome).toBe("error");
    await rig.server.close();
  });

  it("成绩面经 HTTP 的载荷逐字过 HostScoresResponseSchema,且不含 tenantId 回显", async () => {
    const rig = await createAdminTestRig();
    seed(rig);
    const response = await rig.server.inject({
      method: "GET",
      url: `${ADMIN_ROUTES.scores}?tenant=tenant-a`,
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<unknown>();
    expect(() => HostScoresResponseSchema.parse(body)).not.toThrow();
    expect(Object.keys(body as Record<string, unknown>).sort()).toEqual(["items", "nextCursor"]);
    // 零租户回显:载荷里不存在 tenantId 键(字段集 = 契约七字段)。
    expect(JSON.stringify(body)).not.toContain("tenantId");
    expect(JSON.stringify(body)).not.toContain('"tenant"');
    for (const item of (body as { items: Record<string, unknown>[] }).items) {
      expect(Object.keys(item).sort()).toEqual([...HOST_SCORE_RECORD_FIELDS].sort());
    }
    await rig.server.close();
  });
});

describe("admin 审计(fail-closed)与限流", () => {
  it("成功查询落审计(系统主体 + 绑定租户 + 有界结局)", async () => {
    const rig = await createAdminTestRig();
    seed(rig);
    await rig.server.inject({
      method: "GET",
      url: `${ADMIN_ROUTES.scores}?tenant=tenant-a`,
      headers: authHeaders(),
    });
    expect(rig.audit.entries).toHaveLength(1);
    expect(rig.audit.entries[0]?.surface).toBe("scores");
    expect(rig.audit.entries[0]?.outcome).toBe("ok");
    expect(rig.audit.entries[0]?.tenantId).toBe("tenant-a");
    expect(rig.audit.entries[0]?.actor).toBe(ADMIN_AUDIT_ACTOR);
    await rig.server.close();
  });

  it("审计写失败 ⇒ 503 且**零数据下发**(fail-closed 的落点是披露点)", async () => {
    const rig = await createAdminTestRig({ failAudit: true });
    seed(rig);
    const response = await rig.server.inject({
      method: "GET",
      url: `${ADMIN_ROUTES.scores}?tenant=tenant-a`,
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe(JSON.stringify(ADMIN_AUDIT_UNAVAILABLE_ERROR));
    expect(response.body).not.toContain(SCORE_ROW_A);
    expect(response.body).not.toContain("items");
    // 数据确实被读过(证明这不是"没查到"的假绿),但没有离开进程。
    expect(rig.store.readCalls).toContain("readScoresPage");
    await rig.server.close();
  });

  it("存储不可用 ⇒ 503 storage unavailable(不伪装成空批)", async () => {
    const rig = await createAdminTestRig();
    const failing: AdminReadStore = {
      implementation: "memory",
      listChallenges: async () => {
        throw new AdminStoreError("db down");
      },
      queryVerdicts: async () => [],
      readScoresPage: async () => {
        throw new AdminStoreError("db down");
      },
    };
    const server = await buildAdminServer({
      logger: silentLogger,
      metrics: new AdminMetrics(),
      readinessProbes: [],
      console: false,
      routes: {
        credentials: new AdminCredentialVerifier(TEST_CREDENTIAL_SHA256),
        tenants: rig.tenants,
        store: failing,
        audit: rig.audit,
        metrics: rig.metrics,
        rateLimiter: new AdminRateLimiter(1_000),
      },
    });
    await server.ready();
    const response = await server.inject({
      method: "GET",
      url: ADMIN_ROUTES.scores,
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe(JSON.stringify(ADMIN_STORAGE_UNAVAILABLE_ERROR));
    expect(response.body).not.toContain("db down");
    // 失败查询落审计(outcome = error),账目不因失败而丢。
    expect(rig.audit.entries.at(-1)?.outcome).toBe("error");
    await server.close();
    await rig.server.close();
  });

  it("频率触顶 ⇒ 429 冻结形态(与 D-API-50 频率类同码同文案)", async () => {
    const rig = await createAdminTestRig({ rateLimitPerMinute: 2 });
    seed(rig);
    const url = `${ADMIN_ROUTES.challenges}?tenant=tenant-a`;
    expect((await rig.server.inject({ method: "GET", url, headers: authHeaders() })).statusCode).toBe(200);
    expect((await rig.server.inject({ method: "GET", url, headers: authHeaders() })).statusCode).toBe(200);
    const third = await rig.server.inject({ method: "GET", url, headers: authHeaders() });
    expect(third.statusCode).toBe(429);
    expect(third.body).toBe(JSON.stringify(ADMIN_RATE_LIMITED_ERROR));
    await rig.server.close();
  });

  it("服务级 503 常量与审计失败常量都是冻结 PublicError 形态", () => {
    expect(ADMIN_STORAGE_UNAVAILABLE_ERROR.code).toBe("internal_error");
    expect(ADMIN_AUDIT_UNAVAILABLE_ERROR.code).toBe("internal_error");
    expect(ADMIN_UNAVAILABLE_STATUS).toBe(503);
  });
});

describe("admin 安全头与最小只读页", () => {
  it("全部响应携带安全头;CSP frame-ancestors 'none'(与插件链路分离)", async () => {
    const rig = await createAdminTestRig();
    seed(rig);
    const api = await rig.server.inject({
      method: "GET",
      url: `${ADMIN_ROUTES.challenges}?tenant=tenant-a`,
      headers: authHeaders(),
    });
    const page = await rig.server.inject({ method: "GET", url: CONSOLE_ROUTES.page });
    for (const response of [api, page]) {
      expect(response.headers["content-security-policy"]).toBe(ADMIN_CONTENT_SECURITY_POLICY);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(adminSecurityHeaders()["content-security-policy"]).toContain("frame-ancestors 'none'");
    // 零宿主来源白名单:管理面 CSP 里不存在任何 http(s):// 来源(插件链路的
    // frame-ancestors 白名单形态在这里结构性缺席)。
    expect(adminSecurityHeaders()["content-security-policy"]).not.toMatch(/https?:\/\//);
    expect(adminSecurityHeaders()["content-security-policy"]).not.toContain("unsafe-inline");
    await rig.server.close();
  });

  it("只读页:语义化 DOM + 零内联脚本样式 + 凭证零持久化", async () => {
    const rig = await createAdminTestRig();
    const page = await rig.server.inject({ method: "GET", url: CONSOLE_ROUTES.page });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    const html = page.body;
    expect(html).toContain('<main>');
    expect(html).toContain("<h1>");
    expect(html).toContain('<label for="admin-token">');
    expect(html).toContain('<label for="admin-tenant">');
    expect(html).toContain('type="password"');
    expect(html).toContain("<caption");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
    expect(html).toContain(`<script src="${CONSOLE_ROUTES.script}" defer>`);
    expect(html).not.toContain("<style");
    expect(html).not.toMatch(/<script(?![^>]*src=)/);
    expect(html).not.toContain("onclick=");
    // 凭证零持久化:脚本不碰 Cookie / Web Storage / URL。
    expect(CONSOLE_JS).not.toContain("localStorage");
    expect(CONSOLE_JS).not.toContain("sessionStorage");
    expect(CONSOLE_JS).not.toContain("document.cookie");
    expect(CONSOLE_JS).not.toContain("location.search");
    expect(CONSOLE_JS).toContain('credentials: "omit"');
    expect(CONSOLE_JS).toContain("Authorization");
    const script = await rig.server.inject({ method: "GET", url: CONSOLE_ROUTES.script });
    expect(script.headers["content-type"]).toContain("text/javascript");
    const style = await rig.server.inject({ method: "GET", url: CONSOLE_ROUTES.style });
    expect(style.headers["content-type"]).toContain("text/css");
    expect(style.body).toBe(CONSOLE_CSS);
    await rig.server.close();
  });
});

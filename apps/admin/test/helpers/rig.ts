/**
 * 管理面服务级测试装置(D-MP-5 分支 A)。
 *
 * 装配形态与生产 `runtime.ts` **同构**(同一 `buildAdminServer` / 同一
 * `buildAdminRoutes`),只把数据面换成内存只读实现、把审计换成内存审计——
 * 这是"装配路径即可测路径"的纪律:管理面的服务级用例不经任何测试专用
 * 分支,因而不会出现"测试接缝绕开生产装配"的缺陷族(先例 D-API-120)。
 */
import { createHash } from "node:crypto";
import type { Logger } from "pino";

import { MemoryAdminQueryAudit } from "../../src/audit/admin-audit.js";
import { AdminCredentialVerifier } from "../../src/auth/credential.js";
import { AdminTenantBinding } from "../../src/auth/tenant-binding.js";
import { AdminMetrics } from "../../src/metrics.js";
import { AdminRateLimiter } from "../../src/rate-limit.js";
import { MemoryAdminReadStore } from "../../src/persistence/memory-read-store.js";
import { buildAdminServer } from "../../src/server.js";

/** 测试凭证(与任何会话 / 宿主 / 裁决凭证无关;明文只存在于测试内)。 */
export const TEST_CREDENTIAL = "admin-test-credential-0123456789";
/** 测试凭证摘要(装配进校验器;与 `ADMIN_CREDENTIAL_SHA256` 同形)。 */
export const TEST_CREDENTIAL_SHA256 = createHash("sha256")
  .update(TEST_CREDENTIAL, "utf8")
  .digest("hex");

/** 会话面 / 宿主面凭证样本(证明管理面凭证与它们零交集;仅测试用字面)。 */
export const FOREIGN_CREDENTIALS = [
  "host-backend-shared-credential-0123456789",
  "session-credential-sample-0123456789",
  "verifier-dev",
] as const;

export const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
} as unknown as Logger;

export interface AdminTestRigOptions {
  /** 凭证绑定租户白名单(缺省单租户 "tenant-a")。 */
  readonly tenants?: readonly string[];
  /** 频率闸上限(缺省 1000,避免服务级用例误触顶)。 */
  readonly rateLimitPerMinute?: number;
  /** 只读页(缺省提供)。 */
  readonly console?: boolean;
  /** 注入审计失败(证明披露点 fail-closed)。 */
  readonly failAudit?: boolean;
}

export interface AdminTestRig {
  readonly server: Awaited<ReturnType<typeof buildAdminServer>>;
  readonly store: MemoryAdminReadStore;
  readonly audit: MemoryAdminQueryAudit;
  readonly metrics: AdminMetrics;
  readonly tenants: AdminTenantBinding;
}

export async function createAdminTestRig(
  options: AdminTestRigOptions = {},
): Promise<AdminTestRig> {
  const store = new MemoryAdminReadStore();
  const audit = new MemoryAdminQueryAudit();
  if (options.failAudit === true) {
    audit.failWith = new Error("audit sink unavailable");
  }
  const metrics = new AdminMetrics();
  const tenants = new AdminTenantBinding(options.tenants ?? ["tenant-a"]);
  // 与生产装配同形(runtime.ts):绑定租户**数量**入指标(标识符绝不入标签)。
  metrics.boundTenants.set(tenants.size);
  const rateLimiter = new AdminRateLimiter(options.rateLimitPerMinute ?? 1_000);
  const server = await buildAdminServer({
    logger: silentLogger,
    metrics,
    readinessProbes: [{ name: "postgres", check: async () => undefined }],
    console: options.console ?? true,
    routes: {
      credentials: new AdminCredentialVerifier(TEST_CREDENTIAL_SHA256),
      tenants,
      store,
      audit,
      metrics,
      rateLimiter,
    },
  });
  await server.ready();
  return { server, store, audit, metrics, tenants };
}

/** 已认证请求的公共头(凭证呈递形态 = Authorization Bearer)。 */
export function authHeaders(credential: string = TEST_CREDENTIAL): Record<string, string> {
  return { authorization: `Bearer ${credential}` };
}

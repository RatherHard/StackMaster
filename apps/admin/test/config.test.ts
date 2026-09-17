/**
 * 配置三道闸测试(D-MP-5 分支 A;verifier `config.test.ts` 同款)。
 * 红灯语料:缺失必备键 / 未知保留键 / 越天花板取值 / 非法白名单条目,
 * 任一即拒绝启动。
 */
import { describe, expect, it } from "vitest";

import {
  ConfigValidationError,
  MAX_BOUND_TENANTS,
  SCORES_BATCH_CEILING,
  loadAdminConfig,
  parseTenantWhitelist,
} from "../src/config.js";

const REQUIRED = {
  ADMIN_POSTGRES_URL: "postgres://admin_ro:admin-ro-dev@127.0.0.1:15432/session_api",
  ADMIN_CREDENTIAL_SHA256: "ab".repeat(32),
};

const base = (overrides: Record<string, string | undefined> = {}) => ({
  ...REQUIRED,
  ...overrides,
});

describe("loadAdminConfig(三道闸)", () => {
  it("缺必备键 → 拒绝启动(逐键登记)", () => {
    const env = { ADMIN_POSTGRES_URL: REQUIRED.ADMIN_POSTGRES_URL };
    expect(() => loadAdminConfig(env)).toThrow(ConfigValidationError);
    try {
      loadAdminConfig(env);
    } catch (error) {
      expect((error as ConfigValidationError).issues.join("\n")).toContain(
        "ADMIN_CREDENTIAL_SHA256",
      );
    }
  });

  it("未知保留键(拼写错误)→ 拒绝启动,不静默落默认", () => {
    expect(() => loadAdminConfig(base({ ADMIN_SCORES_BACTH: "10" }))).toThrow(
      /ADMIN_SCORES_BACTH/,
    );
    expect(() => loadAdminConfig(base({ ADMIN_TENANT: "tenant-a" }))).toThrow(/ADMIN_TENANT/);
  });

  it("越天花板取值 → 拒绝启动(默认值 + 天花板双闸)", () => {
    expect(() =>
      loadAdminConfig(base({ ADMIN_SCORES_BATCH: String(SCORES_BATCH_CEILING + 1) })),
    ).toThrow(/ADMIN_SCORES_BATCH/);
    expect(() => loadAdminConfig(base({ ADMIN_RATE_LIMIT_PER_MINUTE: "100000" }))).toThrow(
      /ADMIN_RATE_LIMIT_PER_MINUTE/,
    );
  });

  it("凭证摘要形态非法 → 拒绝启动(明文凭证不得入配置)", () => {
    expect(() =>
      loadAdminConfig(base({ ADMIN_CREDENTIAL_SHA256: "plain-text-credential" })),
    ).toThrow(/ADMIN_CREDENTIAL_SHA256/);
  });

  it("白名单条目非法 / 超天花板 → 拒绝启动(不静默丢弃条目)", () => {
    expect(() => loadAdminConfig(base({ ADMIN_TENANTS: "tenant-a,保 with space" }))).toThrow(
      /ADMIN_TENANTS/,
    );
    const tooMany = Array.from({ length: MAX_BOUND_TENANTS + 1 }, (_, i) => `t${i}`).join(",");
    expect(() => loadAdminConfig(base({ ADMIN_TENANTS: tooMany }))).toThrow(/ADMIN_TENANTS/);
  });

  it("合法配置加载默认值;PORT=0 仅 NODE_ENV=test 合法", () => {
    const config = loadAdminConfig({ ...base(), NODE_ENV: "test", ADMIN_PORT: "0" });
    expect(config.port).toBe(0);
    expect(config.scoresBatch).toBe(100);
    expect(config.rateLimitPerMinute).toBe(120);
    expect(config.tenants).toEqual([]);
    expect(() =>
      loadAdminConfig({ ...base(), NODE_ENV: "production", ADMIN_PORT: "0" }),
    ).toThrow(ConfigValidationError);
  });

  it("空字符串环境变量按未提供处理(容器编排占位形态)", () => {
    expect(() => loadAdminConfig({ ...base(), ADMIN_POSTGRES_URL: "" })).toThrow(
      ConfigValidationError,
    );
    // ADMIN_TENANTS 空占位 = 合法的 fail-closed 配置态(不是配置错误)。
    const config = loadAdminConfig({ ...base(), ADMIN_TENANTS: "" });
    expect(config.tenants).toEqual([]);
  });

  it("白名单解析:去重保序;空串 / 全空白 = 空数组", () => {
    expect(parseTenantWhitelist(" t1 , t2 ,t1 ")).toEqual(["t1", "t2"]);
    expect(parseTenantWhitelist(",,  ,")).toEqual([]);
    const config = loadAdminConfig(base({ ADMIN_TENANTS: "tenant-b,tenant-a,tenant-b" }));
    expect(config.tenants).toEqual(["tenant-b", "tenant-a"]);
  });
});

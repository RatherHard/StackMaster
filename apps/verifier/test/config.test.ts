/**
 * 配置三道闸测试(WP-61;D-API-9 载体纪律的 `VERIFIER_` 前缀延伸)。
 * 红灯语料:缺失必备键 / 未知保留键 / 越天花板取值,任一即拒绝启动。
 */
import { describe, expect, it } from "vitest";

import { ConfigValidationError, loadVerifierConfig } from "../src/config.js";

const REQUIRED = {
  VERIFIER_POSTGRES_URL: "postgres://verifier:pw@127.0.0.1:15432/verifier",
  VERIFIER_MINIO_ENDPOINT: "127.0.0.1",
  VERIFIER_MINIO_ACCESS_KEY: "verifier-read",
  VERIFIER_MINIO_SECRET_KEY: "verifier-secret",
};

const base = (overrides: Record<string, string | undefined> = {}) => ({
  ...REQUIRED,
  ...overrides,
});

describe("loadVerifierConfig(三道闸)", () => {
  it("缺必备键 → 拒绝启动(逐键登记)", () => {
    const env = {
      VERIFIER_POSTGRES_URL: REQUIRED.VERIFIER_POSTGRES_URL,
    };
    expect(() => loadVerifierConfig(env)).toThrow(ConfigValidationError);
    try {
      loadVerifierConfig(env);
    } catch (error) {
      expect((error as ConfigValidationError).issues.join("\n")).toContain(
        "VERIFIER_MINIO_ENDPOINT",
      );
    }
  });

  it("未知保留键(拼写错误)→ 拒绝启动,不静默落默认", () => {
    expect(() => loadVerifierConfig(base({ VERIFIER_POLL_INTERVALL_MS: "500" }))).toThrow(
      /VERIFIER_POLL_INTERVALL_MS/,
    );
  });

  it("越天花板取值 → 拒绝启动(默认值 + 天花板双闸)", () => {
    expect(() => loadVerifierConfig(base({ VERIFIER_CLAIM_BATCH_SIZE: "101" }))).toThrow(
      /VERIFIER_CLAIM_BATCH_SIZE/,
    );
    expect(() => loadVerifierConfig(base({ VERIFIER_MAX_RUN_ATTEMPTS: "1000000" }))).toThrow(
      /VERIFIER_MAX_RUN_ATTEMPTS/,
    );
  });

  it("合法配置加载默认值;PORT=0 仅 NODE_ENV=test 合法", () => {
    const config = loadVerifierConfig({ ...base(), NODE_ENV: "test", VERIFIER_PORT: "0" });
    expect(config.port).toBe(0);
    expect(config.pollIntervalMs).toBe(1_000);
    expect(config.claimBatchSize).toBe(4);
    expect(config.maxRunAttempts).toBe(3);
    expect(config.maxActionLogBytes).toBe(4_194_304);
    expect(config.minioBucketPrivate).toBe("private-bundles");
    expect(() =>
      loadVerifierConfig({ ...base(), NODE_ENV: "production", VERIFIER_PORT: "0" }),
    ).toThrow(ConfigValidationError);
  });

  it("空字符串环境变量按未提供处理(容器编排占位形态)", () => {
    // 空字符串剔除后走必备键闸:缺失即拒绝。
    expect(() =>
      loadVerifierConfig({ ...base(), VERIFIER_MINIO_ENDPOINT: "" }),
    ).toThrow(ConfigValidationError);
  });
});

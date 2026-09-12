import { describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  loadSessionApiConfig,
} from "../src/config.js";

function load(env: Record<string, string>, requiredKeys?: readonly string[]) {
  return loadSessionApiConfig(env, requiredKeys);
}

/**
 * 全部必备键的测试专用值(WP-2 签发面 + WP-3 持久化面;本地开发端口与
 * 合成密钥,非真实凭据——合成 PEM / base64 仅测试形态合法性)。
 */
const REQUIRED_WP3: Record<string, string> = {
  // WP-2:合成 Ed25519 PKCS#8 私钥(测试专用,非真实凭证)。
  SESSION_API_SIGNING_KEY: [
    "-----BEGIN PRIVATE KEY-----",
    "MC4CAQAwBQYDK2VwBCIEIK11DLj8nDBqdChkWTmwkhU/CGIjEA3JdufHWQshc6nr",
    "-----END PRIVATE KEY-----",
  ].join("\n"),
  SESSION_API_HOST_BACKEND_TOKEN: "host-backend-test-token-0123456789",
  // WP-3:
  SESSION_API_POSTGRES_URL: "postgres://stackmaster:stackmaster-dev@127.0.0.1:15432/session_api",
  SESSION_API_REDIS_URL: "redis://127.0.0.1:16379/0",
  SESSION_API_MINIO_ENDPOINT: "127.0.0.1",
  SESSION_API_MINIO_ACCESS_KEY: "stackmaster-dev",
  SESSION_API_MINIO_SECRET_KEY: "stackmaster-dev-secret",
  SESSION_API_SNAPSHOT_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
};

describe("配置加载与启动校验(fail-closed)", () => {
  it("缺省可选环境变量得到安全默认值(本机回环 / info / 窗口 90 天 / TTL 300 s / 停机宽限 10 s)", () => {
    const config = load(REQUIRED_WP3);
    expect(config).toEqual({
      nodeEnv: "development",
      host: "127.0.0.1",
      port: 3000,
      logLevel: "info",
      logErrorStacks: false,
      n1WindowDays: 90,
      idempotencyWindowTtlSeconds: 300,
      gracefulShutdownTimeoutSeconds: 10,
      // WP-3 持久化面:必备键取值原样透传 + 可选键默认值。
      postgresUrl: REQUIRED_WP3.SESSION_API_POSTGRES_URL,
      redisUrl: REQUIRED_WP3.SESSION_API_REDIS_URL,
      minioEndpoint: "127.0.0.1",
      minioPort: 9000,
      minioAccessKey: "stackmaster-dev",
      minioSecretKey: "stackmaster-dev-secret",
      minioBucketPrivate: "private-bundles",
      minioBucketPublic: "public-descriptors",
      snapshotEncryptionKey: REQUIRED_WP3.SESSION_API_SNAPSHOT_ENCRYPTION_KEY,
      snapshotRetentionDays: 30,
      autoSnapshotEveryRevisions: 50,
      // WP-2 认证与凭证面字段(默认值;fixture 取值原样透传)。
      signingKey: REQUIRED_WP3.SESSION_API_SIGNING_KEY,
      hostBackendToken: "host-backend-test-token-0123456789",
      allowedOrigins: [],
      embedTokenTtlSeconds: 3600,
      sessionCredentialTtlSeconds: 3600,
      // WP-4 请求护栏(D-API-31)默认值。
      maxRequestBodyBytes: 65536,
      maxJsonDepth: 16,
      maxClientSeqPerSession: 65536,
      // WP-5 WSS 通道(D-API-42 ~ D-API-45)默认值。
      wssHeartbeatIntervalSeconds: 30,
      wssIdleTimeoutSeconds: 60,
      wssMessageRatePerSecond: 30,
      wssSendBufferLimit: 256,
      disconnectKeepaliveSeconds: 300,
      // WP-6 限流、配额与会话资源回收(D-API-50 ~ D-API-55)默认值。
      rateLimitRequestsPerMinute: 120,
      maxConcurrentSessionsPerTenant: 8,
      submissionsPerMinute: 30,
      maxCheckpointsPerSession: 256,
      snapshotByteBudget: 1048576,
      tenantStorageQuotaBytes: 268435456,
      terminalSessionRetentionDays: 30,
      // 阶段五 WP-50 公开描述包下发通道(D-API-76)默认值。
      maxDescriptorBytes: 262144,
      // 阶段六 WP-64 审计归档面(D-API-92)默认值。
      auditArchiveIntervalSeconds: 3600,
      auditArchiveBatch: 10000,
      auditRetentionDays: 30,
      auditBucket: "audit-archive",
      // 阶段六 WP-63 裁决重询限流(D-API-84 / D-API-86)默认值。
      verdictQueriesPerMinute: 30,
      // 阶段六 WP-66 容器级 Worker 隔离(Q4 定案,D-API-105)默认值:
      // 缺省进程池(dev / CI 拓扑零回退)+ 容器池参数量化缺省。
      workerExecutionMode: "process",
      workerContainerImage: "stackmaster/session-api:dev",
      workerContainerCpus: 1,
      workerContainerMemory: 268435456,
      workerContainerPidsLimit: 64,
    });
  });

  it("合法环境变量被解析为运行配置(字符串数字强制转换,D-API-4 配置键生效)", () => {
    const config = load({
      ...REQUIRED_WP3,
      NODE_ENV: "production",
      SESSION_API_HOST: "0.0.0.0",
      SESSION_API_PORT: "8443",
      SESSION_API_LOG_LEVEL: "warn",
      SESSION_PROTOCOL_N1_WINDOW_DAYS: "0",
      IDEMPOTENCY_WINDOW_TTL_SECONDS: "600",
      SESSION_API_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS: "30",
      SESSION_API_MINIO_PORT: "19000",
      SESSION_API_MINIO_BUCKET_PRIVATE: "private-bundles-test",
      SESSION_API_MINIO_BUCKET_PUBLIC: "public-descriptors-test",
      SESSION_API_SNAPSHOT_RETENTION_DAYS: "7",
      SESSION_API_AUTO_SNAPSHOT_EVERY_REVISIONS: "10",
      // WP-2 认证与凭证面配置键生效(D-API-19)。
      SESSION_API_ALLOWED_ORIGINS: "https://plugin.example,https://backup.example",
      SESSION_API_EMBED_TOKEN_TTL_SECONDS: "600",
      SESSION_API_SESSION_CREDENTIAL_TTL_SECONDS: "1800",
      // WP-4 请求护栏配置键生效(D-API-31)。
      SESSION_API_MAX_REQUEST_BODY_BYTES: "131072",
      SESSION_API_MAX_JSON_DEPTH: "8",
      SESSION_API_MAX_CLIENT_SEQ_PER_SESSION: "1000",
      // WP-6 限流与配额配置键生效(D-API-50 ~ D-API-55)。
      SESSION_API_RATE_LIMIT_REQUESTS_PER_MINUTE: "60",
      SESSION_API_MAX_CONCURRENT_SESSIONS_PER_TENANT: "4",
      SESSION_API_SUBMISSIONS_PER_MINUTE: "10",
      SESSION_API_MAX_CHECKPOINTS_PER_SESSION: "128",
      SESSION_API_SNAPSHOT_BYTE_BUDGET: "524288",
      SESSION_API_TENANT_STORAGE_QUOTA_BYTES: "104857600",
      SESSION_API_TERMINAL_SESSION_RETENTION_DAYS: "7",
      // 阶段六 WP-64 审计归档面配置键生效(D-API-92)。
      SESSION_API_AUDIT_ARCHIVE_INTERVAL_SECONDS: "600",
      SESSION_API_AUDIT_ARCHIVE_BATCH: "500",
      SESSION_API_AUDIT_RETENTION_DAYS: "90",
      SESSION_API_AUDIT_BUCKET: "audit-archive-prod",
    });
    expect(config.nodeEnv).toBe("production");
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(8443);
    expect(config.logLevel).toBe("warn");
    expect(config.logErrorStacks).toBe(false);
    // 0 = 立即下线旧版(D-API-4 的合法取值)。
    expect(config.n1WindowDays).toBe(0);
    expect(config.idempotencyWindowTtlSeconds).toBe(600);
    expect(config.gracefulShutdownTimeoutSeconds).toBe(30);
    // WP-3 持久化面配置键生效。
    expect(config.minioPort).toBe(19000);
    expect(config.minioBucketPrivate).toBe("private-bundles-test");
    expect(config.minioBucketPublic).toBe("public-descriptors-test");
    expect(config.snapshotRetentionDays).toBe(7);
    expect(config.autoSnapshotEveryRevisions).toBe(10);
    // WP-2 认证与凭证面:精确来源白名单拆分 + TTL 透传。
    expect(config.allowedOrigins).toEqual(["https://plugin.example", "https://backup.example"]);
    expect(config.embedTokenTtlSeconds).toBe(600);
    expect(config.sessionCredentialTtlSeconds).toBe(1800);
    // WP-4 请求护栏:字符串数字强制转换。
    expect(config.maxRequestBodyBytes).toBe(131072);
    expect(config.maxJsonDepth).toBe(8);
    expect(config.maxClientSeqPerSession).toBe(1000);
    // WP-6 限流与配额:字符串数字强制转换。
    expect(config.rateLimitRequestsPerMinute).toBe(60);
    expect(config.maxConcurrentSessionsPerTenant).toBe(4);
    expect(config.submissionsPerMinute).toBe(10);
    expect(config.maxCheckpointsPerSession).toBe(128);
    expect(config.snapshotByteBudget).toBe(524288);
    expect(config.tenantStorageQuotaBytes).toBe(104857600);
    expect(config.terminalSessionRetentionDays).toBe(7);
    // 阶段六 WP-64 审计归档面:字符串数字强制转换(D-API-92)。
    expect(config.auditArchiveIntervalSeconds).toBe(600);
    expect(config.auditArchiveBatch).toBe(500);
    expect(config.auditRetentionDays).toBe(90);
    expect(config.auditBucket).toBe("audit-archive-prod");
  });

  it("空字符串环境变量按未提供处理(容器编排占位形态),走默认值", () => {
    const config = load({
      ...REQUIRED_WP3,
      SESSION_API_PORT: "",
      SESSION_API_LOG_LEVEL: "",
      SESSION_API_SNAPSHOT_RETENTION_DAYS: "",
    });
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe("info");
    expect(config.snapshotRetentionDays).toBe(30);
  });

  describe("取值非法即拒绝启动", () => {
    const cases: ReadonlyArray<[name: string, env: Record<string, string>, field: string]> = [
      ["SESSION_API_PORT 非数字", { SESSION_API_PORT: "not-a-port" }, "SESSION_API_PORT"],
      ["SESSION_API_PORT 超出端口范围", { SESSION_API_PORT: "70000" }, "SESSION_API_PORT"],
      ["负数 N-1 窗口天数", { SESSION_PROTOCOL_N1_WINDOW_DAYS: "-1" }, "SESSION_PROTOCOL_N1_WINDOW_DAYS"],
      ["非整数幂等窗口 TTL", { IDEMPOTENCY_WINDOW_TTL_SECONDS: "1.5" }, "IDEMPOTENCY_WINDOW_TTL_SECONDS"],
      ["幂等窗口 TTL 为 0", { IDEMPOTENCY_WINDOW_TTL_SECONDS: "0" }, "IDEMPOTENCY_WINDOW_TTL_SECONDS"],
      ["未登记 LOG_LEVEL", { SESSION_API_LOG_LEVEL: "chatty" }, "SESSION_API_LOG_LEVEL"],
      ["未登记 NODE_ENV", { NODE_ENV: "staging" }, "NODE_ENV"],
      ["堆栈开关取值越界(coerce 布尔的拼写变体)", { SESSION_API_LOG_ERROR_STACKS: "yes" }, "SESSION_API_LOG_ERROR_STACKS"],
      ["停机宽限为 0", { SESSION_API_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS: "0" }, "SESSION_API_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS"],
      // WP-2 认证与凭证面取值闸。
      ["embed token TTL 超过协议外圈护栏", { SESSION_API_EMBED_TOKEN_TTL_SECONDS: "604801" }, "SESSION_API_EMBED_TOKEN_TTL_SECONDS"],
      ["会话凭证 TTL 超过协议外圈护栏", { SESSION_API_SESSION_CREDENTIAL_TTL_SECONDS: "86401" }, "SESSION_API_SESSION_CREDENTIAL_TTL_SECONDS"],
      ["embed token TTL 为 0", { SESSION_API_EMBED_TOKEN_TTL_SECONDS: "0" }, "SESSION_API_EMBED_TOKEN_TTL_SECONDS"],
      ["签发密钥不是合法 PEM", { SESSION_API_SIGNING_KEY: "not-a-pem" }, "SESSION_API_SIGNING_KEY"],
      ["宿主后端共享凭证过短", { SESSION_API_HOST_BACKEND_TOKEN: "short" }, "SESSION_API_HOST_BACKEND_TOKEN"],
      ["CORS 白名单含通配符", { SESSION_API_ALLOWED_ORIGINS: "*" }, "SESSION_API_ALLOWED_ORIGINS"],
      ["CORS 白名单含路径(非精确来源)", { SESSION_API_ALLOWED_ORIGINS: "https://plugin.example/app" }, "SESSION_API_ALLOWED_ORIGINS"],
      // WP-4 请求护栏:默认值 + 天花板双闸(D-API-31)。
      ["请求体字节上限超过天花板", { SESSION_API_MAX_REQUEST_BODY_BYTES: "1048577" }, "SESSION_API_MAX_REQUEST_BODY_BYTES"],
      ["请求体字节上限为 0", { SESSION_API_MAX_REQUEST_BODY_BYTES: "0" }, "SESSION_API_MAX_REQUEST_BODY_BYTES"],
      ["嵌套深度超过天花板", { SESSION_API_MAX_JSON_DEPTH: "65" }, "SESSION_API_MAX_JSON_DEPTH"],
      ["clientSeq 预算超过天花板", { SESSION_API_MAX_CLIENT_SEQ_PER_SESSION: "10000001" }, "SESSION_API_MAX_CLIENT_SEQ_PER_SESSION"],
      // WP-6 限流与配额:默认值 + 天花板双闸(D-API-50 ~ D-API-54)。
      ["请求频率超过天花板", { SESSION_API_RATE_LIMIT_REQUESTS_PER_MINUTE: "100001" }, "SESSION_API_RATE_LIMIT_REQUESTS_PER_MINUTE"],
      ["并发会话预算为 0", { SESSION_API_MAX_CONCURRENT_SESSIONS_PER_TENANT: "0" }, "SESSION_API_MAX_CONCURRENT_SESSIONS_PER_TENANT"],
      ["checkpoint 配额超过协议上限", { SESSION_API_MAX_CHECKPOINTS_PER_SESSION: "257" }, "SESSION_API_MAX_CHECKPOINTS_PER_SESSION"],
      ["租户存储配额超过天花板", { SESSION_API_TENANT_STORAGE_QUOTA_BYTES: "1099511627777" }, "SESSION_API_TENANT_STORAGE_QUOTA_BYTES"],
      // 阶段六 WP-64 审计归档面:默认值 + 天花板双闸(D-API-92)。
      ["审计归档节拍超过天花板", { SESSION_API_AUDIT_ARCHIVE_INTERVAL_SECONDS: "604801" }, "SESSION_API_AUDIT_ARCHIVE_INTERVAL_SECONDS"],
      ["审计归档节拍为 0", { SESSION_API_AUDIT_ARCHIVE_INTERVAL_SECONDS: "0" }, "SESSION_API_AUDIT_ARCHIVE_INTERVAL_SECONDS"],
      ["审计归档批为 0", { SESSION_API_AUDIT_ARCHIVE_BATCH: "0" }, "SESSION_API_AUDIT_ARCHIVE_BATCH"],
      ["审计在线保留窗口超过天花板", { SESSION_API_AUDIT_RETENTION_DAYS: "3651" }, "SESSION_API_AUDIT_RETENTION_DAYS"],
      ["审计桶名过短", { SESSION_API_AUDIT_BUCKET: "ab" }, "SESSION_API_AUDIT_BUCKET"],
    ];
    for (const [name, env, field] of cases) {
      it(`${name}被拒绝启动`, () => {
        expect(() => load(env)).toThrow(ConfigValidationError);
        try {
          load(env);
        } catch (error) {
          expect((error as ConfigValidationError).issues.join("\n")).toContain(field);
        }
      });
    }
  });

  it("SESSION_API_PORT=0(临时端口)仅允许 NODE_ENV=test,其余环境拒绝启动", () => {
    expect(load({ ...REQUIRED_WP3, NODE_ENV: "test", SESSION_API_PORT: "0" }).port).toBe(0);
    expect(() => load({ ...REQUIRED_WP3, SESSION_API_PORT: "0" })).toThrow(/临时端口/);
    expect(() => load({ ...REQUIRED_WP3, NODE_ENV: "production", SESSION_API_PORT: "0" })).toThrow(/临时端口/);
  });

  it("WSS 空闲超时不大于心跳间隔拒绝启动(组合约束的唯一裁决点,D-API-42)", () => {
    try {
      load({
        ...REQUIRED_WP3,
        SESSION_API_WSS_HEARTBEAT_INTERVAL_SECONDS: "30",
        SESSION_API_WSS_IDLE_TIMEOUT_SECONDS: "30",
      });
      expect.unreachable("空闲超时必须大于心跳间隔");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const message = String(error);
      expect(message).toContain("SESSION_API_WSS_IDLE_TIMEOUT_SECONDS");
      expect(message).toContain("SESSION_API_WSS_HEARTBEAT_INTERVAL_SECONDS");
    }
  });

  it("未知保留键(SESSION_API_ 前缀)拒绝启动——拼写错误不得静默落到默认值", () => {
    try {
      load({ SESSION_API_IDEMPOTENCY_TTL: "300" });
      expect.unreachable("未知保留键必须拒绝启动");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues.join("\n")).toContain(
        "SESSION_API_IDEMPOTENCY_TTL",
      );
    }
  });

  it("必备键缺失拒绝启动,且错误信息不含键值(错误面不是密钥外泄通道)", () => {
    try {
      load({ SESSION_API_SIGNING_KEY: "super-secret-value" }, ["SESSION_API_SIGNING_KEY", "SESSION_API_DATABASE_URL"]);
      expect.unreachable("必备键缺失必须拒绝启动");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const issues = (error as ConfigValidationError).issues.join("\n");
      expect(issues).toContain("SESSION_API_DATABASE_URL");
      expect(issues).toContain("SESSION_API_SIGNING_KEY");
      expect(issues).not.toContain("super-secret-value");
    }
  });

  describe("WP-3 持久化面必备键与快照加密密钥(fail-closed,D-API-21)", () => {
    const requiredKeyNames = Object.keys(REQUIRED_WP3);
    for (const key of requiredKeyNames) {
      it(`必备键 ${key} 缺失拒绝启动`, () => {
        const env = { ...REQUIRED_WP3 };
        delete env[key];
        try {
          load(env);
          expect.unreachable("必备键缺失必须拒绝启动");
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigValidationError);
          expect((error as ConfigValidationError).issues.join("\n")).toContain(key);
        }
      });
    }

    it("快照加密密钥解码后长度非法拒绝启动(仅报字段名与结构原因,不含取值)", () => {
      const tooShort = Buffer.alloc(16, 1).toString("base64");
      try {
        load({ ...REQUIRED_WP3, SESSION_API_SNAPSHOT_ENCRYPTION_KEY: tooShort });
        expect.unreachable("密钥长度非法必须拒绝启动");
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        const message = String(error);
        expect(message).toContain("SESSION_API_SNAPSHOT_ENCRYPTION_KEY");
        expect(message).toContain("32 字节");
        // 错误面不得回显取值(哪怕取值本身不是秘密)。
        expect(message).not.toContain(tooShort);
      }
    });

    it("快照加密密钥非 base64 拒绝启动", () => {
      expect(() =>
        load({ ...REQUIRED_WP3, SESSION_API_SNAPSHOT_ENCRYPTION_KEY: "!!not-base64!!" }),
      ).toThrow(ConfigValidationError);
    });
  });
});

// ── 阶段六 WP-66 容器级 Worker 隔离(Q4 定案;D-API-105)────────────────────
describe("worker 执行形态配置键(WP-66,Q4 定案:缺省进程池,容器池显式启用)", () => {
  it("缺省形态 = process(dev / CI 拓扑零回退;容器池不做缺省)", () => {
    const config = load(REQUIRED_WP3);
    expect(config.workerExecutionMode).toBe("process");
    // 容器池参数缺省值(量化理由见 config.ts 常量注释与 D-API-105)。
    expect(config.workerContainerImage).toBe("stackmaster/session-api:dev");
    expect(config.workerContainerCpus).toBe(1);
    expect(config.workerContainerMemory).toBe(268435456); // 256 MiB(字节)
    expect(config.workerContainerPidsLimit).toBe(64);
  });

  it("显式 SESSION_API_WORKER_EXECUTION_MODE=container 被受理(容器池为显式启用形态)", () => {
    const config = load({
      ...REQUIRED_WP3,
      SESSION_API_WORKER_EXECUTION_MODE: "container",
    });
    expect(config.workerExecutionMode).toBe("container");
  });

  it("容器池参数显式取值被解析(cpus / memory(字节) / pids / image)", () => {
    const config = load({
      ...REQUIRED_WP3,
      SESSION_API_WORKER_CONTAINER_CPUS: "2",
      SESSION_API_WORKER_CONTAINER_MEMORY: "536870912",
      SESSION_API_WORKER_CONTAINER_PIDS_LIMIT: "128",
      SESSION_API_WORKER_CONTAINER_IMAGE: "registry.example.com/session-api:1.2.3",
    });
    expect(config.workerContainerCpus).toBe(2);
    expect(config.workerContainerMemory).toBe(536870912);
    expect(config.workerContainerPidsLimit).toBe(128);
    expect(config.workerContainerImage).toBe("registry.example.com/session-api:1.2.3");
  });

  it("执行形态取值非法(process | container 之外)拒绝启动", () => {
    expect(() =>
      load({ ...REQUIRED_WP3, SESSION_API_WORKER_EXECUTION_MODE: "kube" }),
    ).toThrow(ConfigValidationError);
  });

  it("容器池参数越天花板拒绝启动(cpus / memory / pids;默认值 + 天花板双闸同形)", () => {
    expect(() =>
      load({ ...REQUIRED_WP3, SESSION_API_WORKER_CONTAINER_CPUS: "17" }),
    ).toThrow(ConfigValidationError);
    expect(() =>
      load({ ...REQUIRED_WP3, SESSION_API_WORKER_CONTAINER_MEMORY: "4294967297" }),
    ).toThrow(ConfigValidationError);
    expect(() =>
      load({ ...REQUIRED_WP3, SESSION_API_WORKER_CONTAINER_PIDS_LIMIT: "4097" }),
    ).toThrow(ConfigValidationError);
  });

  it("容器池参数低于地板拒绝启动(memory 低于单帧 + 状态的最小可行形态即拒)", () => {
    expect(() =>
      load({ ...REQUIRED_WP3, SESSION_API_WORKER_CONTAINER_MEMORY: "1024" }),
    ).toThrow(ConfigValidationError);
    expect(() =>
      load({ ...REQUIRED_WP3, SESSION_API_WORKER_CONTAINER_CPUS: "0" }),
    ).toThrow(ConfigValidationError);
  });
});

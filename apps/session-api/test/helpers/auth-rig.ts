/**
 * WP-2 认证面测试装配台:配置 / 签名密钥 / 端口内存实现 / 日志捕获 +
 * 独立 fastify 实例上的插件与 WP-4 替身路由(inject 驱动;不依赖
 * src/server.ts 之外的最终装配)。
 *
 * 替身路由是"WP-4 装配面"的最小演示:
 *  - POST /test/sessions:create-session 消费链(三方比对 → 会话签发 →
 *    Set-Cookie 交付 → create_session 审计);
 *  - POST /test/actions:凭证 preHandler 保护的命令路由(submit 审计)。
 * 正式生命周期路由(编译器装载、会话表、限流)归 WP-4,不在本测试面。
 */

import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { EmbedTokenClaims } from "@stackmaster/protocol/server-only";
import {
  AUDIT_EVENT_KINDS,
  type AuditEventKind,
  type IssuedEmbedTokenRecord,
} from "../../src/auth/index.js";
import {
  AUTH_FAILED_ERROR,
  AUTH_FAILED_HTTP_STATUS,
  EmbedTokenConsumptionRejected,
  InMemoryAuditSink,
  InMemoryCredentialRevocationStore,
  InMemoryTokenIssuanceStore,
  buildAuthPlugin,
  buildCredentialPreHandler,
  consumeEmbedToken,
  createTokenSigner,
  issueSessionCredential,
  setSessionCredentialCookie,
  type TokenSigner,
} from "../../src/auth/index.js";
import { loadSessionApiConfig, type SessionApiConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { buildServer } from "../../src/server.js";
import type { Logger } from "pino";
import { createLogCapture, type LogCapture } from "./log-capture.js";
import { REQUIRED_STORAGE_ENV } from "./required-env.js";

export { AUDIT_EVENT_KINDS };
export type { AuditEventKind };

/** 测试专用宿主后端共享凭证(≥ 16 字符;非真实凭据)。 */
export const TEST_HOST_BACKEND_TOKEN = "host-backend-shared-credential-0123456789";

/** 测试身份语料(全部为非秘密的合成标识符)。 */
export const TEST_TENANT_ID = "tenant-alpha";
export const TEST_USER_ID = "user-42";
export const TEST_CHALLENGE_ID = "chal-stack-escape";
export const TEST_CHALLENGE_VERSION = "1.2.3";

/** 合成 embedSessionId(128-bit CSPRNG base64url,满足 ≥ 22 字符冻结约束)。 */
export function makeEmbedSessionId(): string {
  return randomBytes(16).toString("base64url");
}

/** 测试专用 Ed25519 私钥 PEM(进程内生成,非真实凭据)。 */
export const TEST_SIGNING_KEY_PEM: string = (() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
})();

export interface AuthRigOptions {
  /** 配置覆盖(如 allowedOrigins / TTL);默认带一个白名单来源供 CSRF / CORS 断言。 */
  readonly env?: Readonly<Record<string, string>>;
  /** 确定性时钟(store / 消费共用;测试注入以覆盖 TTL 过期路径)。 */
  readonly now?: () => number;
}

export interface IssuedTestEmbedToken {
  readonly token: string;
  readonly claims: EmbedTokenClaims;
  readonly record: IssuedEmbedTokenRecord;
}

export interface AuthTestRig {
  readonly app: FastifyInstance;
  readonly config: SessionApiConfig;
  readonly logger: Logger;
  readonly capture: LogCapture;
  readonly signer: TokenSigner;
  readonly issuanceStore: InMemoryTokenIssuanceStore;
  readonly revocationStore: InMemoryCredentialRevocationStore;
  readonly audit: InMemoryAuditSink;
  /** 直接经 signer + store 签发测试 embed token(绕过 HTTP 签发端点的矩阵用例)。 */
  issueEmbedToken(overrides?: {
    readonly ttlSeconds?: number;
    readonly claims?: Partial<Pick<EmbedTokenClaims, "tenantId" | "userId" | "challengeId" | "challengeVersion" | "embedSessionId">>;
  }): Promise<IssuedTestEmbedToken>;
  /** 宿主后端签发请求头。 */
  hostHeaders(): { authorization: string };
}

export const DEFAULT_ALLOWED_ORIGINS = "https://plugin.example";

export async function buildAuthTestRig(options: AuthRigOptions = {}): Promise<AuthTestRig> {
  const config = loadSessionApiConfig({
    NODE_ENV: "test",
    SESSION_API_PORT: "0",
    SESSION_API_SIGNING_KEY: TEST_SIGNING_KEY_PEM,
    SESSION_API_HOST_BACKEND_TOKEN: TEST_HOST_BACKEND_TOKEN,
    SESSION_API_ALLOWED_ORIGINS: DEFAULT_ALLOWED_ORIGINS,
    ...REQUIRED_STORAGE_ENV,
    ...options.env,
  });
  const capture = createLogCapture();
  const logger = createLogger(config, capture.stream);
  const app = buildServer(config, logger);
  const signer = await createTokenSigner(config.signingKey);
  const issuanceStore = new InMemoryTokenIssuanceStore({ now: options.now });
  const revocationStore = new InMemoryCredentialRevocationStore({ now: options.now });
  const audit = new InMemoryAuditSink();

  await app.register(
    buildAuthPlugin({ config, signer, issuanceStore, revocationStore, audit }),
  );

  // —— WP-4 替身:create-session 消费链(装配面的最小演示)——
  app.post("/test/sessions", async (request, reply) => {
    const body = request.body as {
      embedToken?: unknown;
      challengeId?: unknown;
      challengeVersion?: unknown;
      embedSessionId?: unknown;
    };
    if (
      typeof body.embedToken !== "string" ||
      typeof body.challengeId !== "string" ||
      typeof body.challengeVersion !== "string" ||
      typeof body.embedSessionId !== "string"
    ) {
      return reply.code(400).send({ code: "invalid_input_format", message: "invalid request" });
    }
    try {
      const identity = await consumeEmbedToken(
        { signer, issuanceStore, audit, logger, now: options.now },
        {
          embedToken: body.embedToken,
          context: {
            challengeId: body.challengeId,
            challengeVersion: body.challengeVersion,
            embedSessionId: body.embedSessionId,
          },
        },
      );
      const sessionId = `sess-${randomUUID()}`;
      const issued = await issueSessionCredential(
        { signer, audit, ttlSeconds: config.sessionCredentialTtlSeconds, now: options.now },
        {
          sessionId,
          tenantId: identity.tenantId,
          userId: identity.userId,
          challengeId: identity.challengeId,
          challengeVersion: identity.challengeVersion,
        },
      );
      await audit.append({
        kind: "create_session",
        at: (options.now ?? Date.now)(),
        actor: { tenantId: identity.tenantId, userId: identity.userId },
        sessionId,
        detail: { embedTokenJti: identity.embedTokenJti },
      });
      setSessionCredentialCookie(reply, issued.token, issued.ttlSeconds, config.nodeEnv);
      return reply.code(201).send({ sessionId });
    } catch (err) {
      if (err instanceof EmbedTokenConsumptionRejected) {
        return reply.code(AUTH_FAILED_HTTP_STATUS).send(AUTH_FAILED_ERROR);
      }
      throw err;
    }
  });

  // —— WP-4 替身:凭证保护的命令路由(submit 语义的最小演示)——
  const requireSessionCredential = buildCredentialPreHandler(
    { signer, revocationStore, allowedOrigins: config.allowedOrigins, now: options.now },
    {
      getSessionAnchor: (request) => {
        const payload = (request.body as { payload?: { sessionId?: unknown } } | null)?.payload;
        return typeof payload?.sessionId === "string" ? payload.sessionId : undefined;
      },
    },
  );
  app.post(
    "/test/actions",
    { preHandler: requireSessionCredential },
    async (request, reply) => {
      const auth = request.sessionAuth;
      if (auth === null) {
        return reply.code(AUTH_FAILED_HTTP_STATUS).send(AUTH_FAILED_ERROR);
      }
      await audit.append({
        kind: "submit",
        at: (options.now ?? Date.now)(),
        actor: auth.context.principal(),
        sessionId: auth.claims.sessionId,
      });
      return reply.code(200).send({
        principal: auth.context.principal(),
        sessionId: auth.claims.sessionId,
      });
    },
  );
  // 只读命令替身(GET;无请求体 → 无会话锚,凭证校验 + CSRF 闸不适用变更面)。
  app.get(
    "/test/actions",
    { preHandler: requireSessionCredential },
    async (request, reply) => {
      const auth = request.sessionAuth;
      if (auth === null) {
        return reply.code(AUTH_FAILED_HTTP_STATUS).send(AUTH_FAILED_ERROR);
      }
      return reply.code(200).send({ sessionId: auth.claims.sessionId });
    },
  );

  await app.ready();

  return {
    app,
    config,
    logger,
    capture,
    signer,
    issuanceStore,
    revocationStore,
    audit,
    async issueEmbedToken(overrides = {}) {
      const ttlSeconds = overrides.ttlSeconds ?? config.embedTokenTtlSeconds;
      const nowMs = (options.now ?? Date.now)();
      const claims: EmbedTokenClaims = {
        tenantId: overrides.claims?.tenantId ?? TEST_TENANT_ID,
        userId: overrides.claims?.userId ?? TEST_USER_ID,
        challengeId: overrides.claims?.challengeId ?? TEST_CHALLENGE_ID,
        challengeVersion: overrides.claims?.challengeVersion ?? TEST_CHALLENGE_VERSION,
        embedSessionId: overrides.claims?.embedSessionId ?? makeEmbedSessionId(),
        jti: randomUUID(),
        expiresAt: Math.floor(nowMs / 1000) + ttlSeconds,
      };
      const token = await signer.signEmbedToken(claims);
      const record: IssuedEmbedTokenRecord = {
        jti: claims.jti,
        tenantId: claims.tenantId,
        userId: claims.userId,
        challengeId: claims.challengeId,
        challengeVersion: claims.challengeVersion,
        embedSessionId: claims.embedSessionId,
        issuedAt: nowMs,
        expiresAt: claims.expiresAt * 1000,
      };
      await issuanceStore.put(record, ttlSeconds);
      return { token, claims, record };
    },
    hostHeaders() {
      return { authorization: `Bearer ${TEST_HOST_BACKEND_TOKEN}` };
    },
  };
}

/** 从 create-session 响应提取 Set-Cookie 呈递值(inject 无 Cookie Jar)。 */
export function sessionCredentialFromSetCookie(response: {
  headers: Record<string, unknown>;
}): string {
  const setCookie = response.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (typeof raw !== "string") {
    throw new Error("响应缺少 Set-Cookie(凭证交付面缺失)");
  }
  const separator = raw.indexOf("=");
  const value = raw.slice(separator + 1, raw.indexOf(";", separator));
  return value;
}

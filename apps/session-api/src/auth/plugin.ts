/**
 * buildAuthPlugin:可装配的认证插件(WP-2 交付面;最终装配归 WP-4)。
 *
 * 职责(任务分解 WP-2 第 1 / 4 条):
 *  - 注册 embed token 签发端点(宿主后端 → session-api;嵌入协议 §六):
 *    宿主凭证认证(无凭证 / 错凭证一律统一 401,先于请求体校验,防未认证
 *    探测)→ 生成 jti → 域 2 密钥签名七字段 claims → 写签发记录
 *    (token:{jti},TTL = token TTL ≤ MAX_EMBED_TOKEN_TTL_SECONDS)→
 *    响应体 JSON 交付(D-API-11;接收方是宿主后端服务器,token 禁入 URL
 *    query、不经 postMessage 下发——交付通道归阶段五);
 *  - 传输卫生装配:@fastify/cookie(凭证呈递依赖)+ @fastify/cors 精确
 *    来源白名单(D-API-16;空表 = 不放行任何跨源)。CSRF 防护在凭证
 *    preHandler 内(D-API-17,middleware.ts)。
 *
 * 封装语义:本插件以 fastify 的 skip-override 插件元数据(fastify-plugin
 * 同款 Symbol,避免引入未声明依赖)注册到调用方上下文——Cookie / CORS /
 * preHandler 工厂对 WP-4 在根上下文注册的生命周期路由可见。
 *
 * 依赖注入:端口(signer / stores / audit)可注入,默认内存实现
 * (memory.ts;测试与未接线期)。插件测试用独立 fastify 实例 + inject,
 * 不依赖 src/server.ts / src/index.ts 的最终装配。
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import {
  EMBED_TOKEN_MAX_LENGTH,
  EmbedSessionIdSchema,
  OpaqueIdSchema,
} from "@stackmaster/protocol";
import {
  CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE,
  EmbedTokenClaimsSchema,
  type EmbedTokenClaims,
} from "@stackmaster/protocol/server-only";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import {
  AUTH_FAILED_ERROR,
  AUTH_FAILED_HTTP_STATUS,
  INVALID_REQUEST_ERROR,
  INVALID_REQUEST_HTTP_STATUS,
} from "./consumption.js";
import { createTokenSigner, type TokenSigner } from "./keys.js";
import {
  InMemoryAuditSink,
  InMemoryCredentialRevocationStore,
  InMemoryTokenIssuanceStore,
} from "./memory.js";
import type { AuditSink, CredentialRevocationStore, TokenIssuanceStore } from "./ports.js";

/** embed token 签发端点(宿主后端 → session-api;服务端间,非浏览器面)。 */
export const EMBED_TOKEN_ISSUANCE_ROUTE = "/auth/embed-tokens";

/** 签发端点宿主凭证的 Authorization 头前缀。 */
const BEARER_PREFIX = "Bearer ";

/** 认证面消费的配置切片(SessionApiConfig 结构兼容;signingKey 可选透传)。 */
export interface AuthModuleConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly hostBackendToken: string;
  readonly allowedOrigins: readonly string[];
  readonly embedTokenTtlSeconds: number;
  readonly sessionCredentialTtlSeconds: number;
  /** 签名私钥 PEM(SessionApiConfig 携带;无 signer 注入时必经此字段装配)。 */
  readonly signingKey?: string;
}

export interface AuthPluginOptions {
  readonly config: AuthModuleConfig;
  /** 签发 / 校验器(默认由 config.signingKey 装配——签名私钥须在配置内)。 */
  readonly signer?: TokenSigner;
  readonly signingKeyPem?: string;
  /** 端口默认内存实现(测试与未接线期;生产由 WP-4 接 Redis / PG 适配器)。 */
  readonly issuanceStore?: TokenIssuanceStore;
  readonly revocationStore?: CredentialRevocationStore;
  readonly audit?: AuditSink;
}

/** 签发请求体契约(strictObject:多余字段——尤其任何身份自报复述——即拒)。 */
const EmbedTokenIssuanceRequestSchema = z.strictObject({
  tenantId: OpaqueIdSchema,
  userId: OpaqueIdSchema,
  challengeId: OpaqueIdSchema,
  challengeVersion: z
    .string()
    .regex(
      new RegExp(CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE),
      "题目内容版本必须为 X.Y.Z 形式的语义化版本",
    ),
  embedSessionId: EmbedSessionIdSchema,
});

/** 签发成功响应(响应体 JSON 交付;token 禁入 URL query / postMessage)。 */
export interface EmbedTokenIssuanceResponse {
  readonly embedToken: string;
  /** 过期时刻(Unix epoch 秒;与签名 claims.expiresAt 同值)。 */
  readonly expiresAt: number;
}

/**
 * 宿主凭证常数时间比较:双侧 sha256 后 timingSafeEqual——长度差异也被
 * 折叠进摘要比较,不透出长度侧信道。
 */
function hostBackendTokenMatches(authorization: unknown, expected: string): boolean {
  if (typeof authorization !== "string" || !authorization.startsWith(BEARER_PREFIX)) {
    return false;
  }
  const presented = authorization.slice(BEARER_PREFIX.length);
  const presentedDigest = createHash("sha256").update(presented, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

/**
 * fastify 插件元数据:skip-override 使本插件的注册(cookie / cors / 路由 /
 * 装饰)落在调用方上下文,WP-4 的生命周期路由因此可直接使用 Cookie 呈递与
 * CORS 钩子(等价 fastify-plugin 的默认行为;Symbol 为 fastify 公开插件协议)。
 */
const SKIP_OVERRIDE = Symbol.for("skip-override");

/** 插件装配后的认证运行时依赖(WP-4 组装消费链与凭证 preHandler 的单一取用点)。 */
export interface AuthRuntimeDeps {
  readonly config: AuthModuleConfig;
  readonly signer: TokenSigner;
  readonly issuanceStore: TokenIssuanceStore;
  readonly revocationStore: CredentialRevocationStore;
  readonly audit: AuditSink;
}

declare module "fastify" {
  interface FastifyInstance {
    /** 认证运行时依赖(插件注册后可读;与插件的签发路由共享同一实例)。 */
    authRuntimeDeps: AuthRuntimeDeps;
  }
}

/**
 * 构造认证插件。签名密钥装配失败(非法 PEM / 非 Ed25519)在注册期即抛错
 * (fail-closed:进 fastify 注册错误路径,进程不进入服务态)。
 */
export function buildAuthPlugin(options: AuthPluginOptions): FastifyPluginAsync {
  const config = options.config;

  const plugin = async (fastify: Parameters<FastifyPluginAsync>[0]): Promise<void> => {
    const signingKeyPem = options.signingKeyPem ?? config.signingKey;
    if (signingKeyPem === undefined && options.signer === undefined) {
      throw new TypeError(
        "buildAuthPlugin:需要注入 signer,或提供 signingKeyPem / config.signingKey",
      );
    }
    const signer = options.signer ?? (await createTokenSigner(signingKeyPem ?? ""));
    const issuanceStore = options.issuanceStore ?? new InMemoryTokenIssuanceStore();
    const revocationStore = options.revocationStore ?? new InMemoryCredentialRevocationStore();
    const audit = options.audit ?? new InMemoryAuditSink();

    // 运行时依赖暴露:WP-4 的 create-session 消费链与凭证 preHandler
    // (buildCredentialPreHandler)由此取用与签发路由同源的实例。
    fastify.decorate("authRuntimeDeps", {
      config,
      signer,
      issuanceStore,
      revocationStore,
      audit,
    });

    // Cookie 支撑(幂等:已注册则跳过,防调用方重复注册冲突)。
    if (!fastify.hasPlugin("@fastify/cookie")) {
      await fastify.register(cookie);
    }
    // CORS 精确来源白名单(D-API-16):数组形态 = 逐项精确匹配,仅命中请求
    // 回显 Access-Control-Allow-Origin;空数组 = 无任何来源放行(fail-closed),
    // 浏览器面被拦,非浏览器调用方(宿主后端)不受影响。拒绝时不透出任何
    // 配置细节(仅不回 ACAO 头)。
    await fastify.register(cors, {
      origin: [...config.allowedOrigins],
      credentials: true,
      methods: ["GET", "HEAD", "POST", "OPTIONS"],
      maxAge: 600,
    });

    // 请求侧身份面初始化(preHandler 之后可读;之前恒 null)。
    fastify.decorateRequest("sessionAuth", null);

    fastify.post(EMBED_TOKEN_ISSUANCE_ROUTE, async (request, reply) => {
      // 1. 宿主凭证认证(嵌入协议 §六:无凭证的签发请求拒绝)。先于请求体
      //    校验——未认证方不得探测请求体字段有效性(401 / 400 不给探测面)。
      if (!hostBackendTokenMatches(request.headers.authorization, config.hostBackendToken)) {
        request.log.warn({ reason: "host_backend_token_invalid" }, "embed token issuance rejected");
        return reply.code(AUTH_FAILED_HTTP_STATUS).send(AUTH_FAILED_ERROR);
      }

      // 2. 请求体契约校验(strictObject):失败 = 400 冻结 PublicError 形态,
      //    校验器细节(字段路径 / 原始文本)只进受控日志(基线 #8)。
      const parsed = EmbedTokenIssuanceRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        request.log.warn(
          { reason: "invalid_issuance_body", issueCount: parsed.error.issues.length },
          "embed token issuance rejected",
        );
        return reply.code(INVALID_REQUEST_HTTP_STATUS).send(INVALID_REQUEST_ERROR);
      }

      // 3. jti → 七字段 claims → 域 2 密钥签名 → 签发记录(TTL = token TTL)。
      const jti = randomUUID();
      const nowMs = Date.now();
      const expiresAt = Math.floor(nowMs / 1000) + config.embedTokenTtlSeconds;
      // 冻结 Schema 自检:签发面与契约漂移即抛错(500 内部路径,契约漂移属
      // 实现事故而非调用方错误)。
      const claims: EmbedTokenClaims = EmbedTokenClaimsSchema.parse({
        ...parsed.data,
        jti,
        expiresAt,
      });
      const embedToken = await signer.signEmbedToken(claims);
      if (embedToken.length > EMBED_TOKEN_MAX_LENGTH) {
        throw new Error(`签发的 embed token 超过载体长度上限(${EMBED_TOKEN_MAX_LENGTH})`);
      }
      await issuanceStore.put(
        {
          jti: claims.jti,
          tenantId: claims.tenantId,
          userId: claims.userId,
          challengeId: claims.challengeId,
          challengeVersion: claims.challengeVersion,
          embedSessionId: claims.embedSessionId,
          issuedAt: nowMs,
          expiresAt: claims.expiresAt * 1000,
        },
        config.embedTokenTtlSeconds,
      );

      // 4. 审计(append-only;detail 仅非秘密标量,零凭证材料)。
      await audit.append({
        kind: "embed_token_issued",
        at: nowMs,
        actor: { tenantId: claims.tenantId, userId: claims.userId },
        detail: {
          jti: claims.jti,
          challengeId: claims.challengeId,
          challengeVersion: claims.challengeVersion,
          embedSessionId: claims.embedSessionId,
          ttlSeconds: config.embedTokenTtlSeconds,
        },
      });

      // 5. 交付:响应体 JSON(D-API-11)。接收方是宿主后端服务器;token 不回
      //    显在 URL、不经 postMessage、不进日志(req 序列化器白名单兜底)。
      const body: EmbedTokenIssuanceResponse = { embedToken, expiresAt: claims.expiresAt };
      return reply.code(201).send(body);
    });
  };

  Object.assign(plugin, {
    [SKIP_OVERRIDE]: true,
    [Symbol.for("plugin-meta")]: { name: "@stackmaster/session-api-auth" },
  });
  return plugin as FastifyPluginAsync;
}

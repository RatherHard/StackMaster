/**
 * buildAuthPlugin:可装配的认证插件(WP-2 交付面;最终装配归 WP-4)。
 *
 * 职责:
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
 *
 * ⚠ **`/auth/embed-tokens` 端点已退役**(分发改版 WP-91;D-LT-1 第 5 项
 * 「与嵌入协议同批硬切,不留过渡别名」)。**承继者** = `POST /auth/launch-tickets`
 * (`src/launch/launch-routes.ts`)。
 * **2026-09-19(WP-96)补记**:该端点在 N-1 窗口期内遗留的 v1 分支函数
 * (`consumeEmbedToken` / `verifyEmbedToken` / `signEmbedToken` /
 * `EmbedTokenClaims` / `TokenIssuanceStore`)已随 v1 冻结面与嵌入协议面
 * **物理删除** —— 本文件现在只保留 `hostBackendTokenMatches`(被
 * `/host/scores`、`/auth/launch-tickets` 共用同一份实现)、Cookie / CORS 装配、
 * `authRuntimeDeps` 装饰。
 */

import { createHash, timingSafeEqual } from "node:crypto";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import type { FastifyPluginAsync } from "fastify";

import { createTokenSigner, type TokenSigner } from "./keys.js";
import { InMemoryAuditSink, InMemoryCredentialRevocationStore } from "./memory.js";
import type { AuditSink, CredentialRevocationStore } from "./ports.js";

/** 宿主凭证的 Authorization 头前缀(签发端点与成绩面共用)。 */
const BEARER_PREFIX = "Bearer ";

/** 认证面消费的配置切片(SessionApiConfig 结构兼容;signingKey 可选透传)。 */
export interface AuthModuleConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly hostBackendToken: string;
  readonly allowedOrigins: readonly string[];
  // 2026-09-19 WP-96:`embedTokenTtlSeconds` 已随嵌入协议面退役删除(原唯一消费者 =
  // `/auth/embed-tokens` 签发链,该端点与 embed token 一族同批物理删除)。
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
  readonly revocationStore?: CredentialRevocationStore;
  readonly audit?: AuditSink;
}

/**
 * 宿主凭证常数时间比较:双侧 sha256 后 timingSafeEqual——长度差异也被
 * 折叠进摘要比较,不透出长度侧信道。
 *
 * 导出面(WP-78):宿主成绩同步只读接口(host-scores-routes.ts)复用**同一
 * 实现**——宿主凭证校验只有这一处(禁写第二套实现),既有签发端点的行为
 * 与字节面零改动。
 */
export function hostBackendTokenMatches(authorization: unknown, expected: string): boolean {
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
    const revocationStore = options.revocationStore ?? new InMemoryCredentialRevocationStore();
    const audit = options.audit ?? new InMemoryAuditSink();

    // 运行时依赖暴露:WP-4 的 create-session 消费链与凭证 preHandler
    // (buildCredentialPreHandler)由此取用与签发路由同源的实例。
    fastify.decorate("authRuntimeDeps", {
      config,
      signer,
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
      // ETag 必须对跨源浏览器脚本可读(D-API-76 增补,2026-09-11):描述包
      // 下发端点的 ETag = 登记摘要,是描述包客户端加载器的完整性校验锚——
      // 跨源插件 iframe 的 fetch 读不到该头即无法做客户端侧哈希比对。
      // (选项名是 @fastify/cors 的 exposedHeaders,非 Express 风格 exposeHeaders。)
      exposedHeaders: ["ETag"],
    });

    // 请求侧身份面初始化(preHandler 之后可读;之前恒 null)。
    fastify.decorateRequest("sessionAuth", null);

    // ── `/auth/embed-tokens` 端点已退役(WP-91;D-LT-1 第 5 项:与嵌入协议
    //    同批硬切,**不留过渡别名**)─────────────────────────────────────────
    // 退役内容:该端点的 `fastify.post(...)` 本体 + 请求体私有 Schema
    // (`EmbedTokenIssuanceRequestSchema`)+ `EmbedTokenIssuanceResponse`
    // interface + `EMBED_TOKEN_ISSUANCE_ROUTE` 常量。
    //
    // **承继者** = `POST /auth/launch-tickets`(`src/launch/launch-routes.ts`):
    // 同一位置、同一宿主凭证姿态、同一限流纪律;交付面从"回 embed token
    // 给宿主后端"变为"回一次性启动地址给平台后端"。
    //
    // **2026-09-19(WP-96)补记**:该端点在 N-1 窗口期的 v1 残留(embed token
    // 铸造 / 消费 / 吊销函数、claims 载体面、`token:{jti}` 存储端口)已随 v1
    // 冻结面与嵌入协议面**物理删除**。本文件与认证域其余模块现在只服务
    // 会话凭证 + 启动授权凭证两条链。
  };

  Object.assign(plugin, {
    [SKIP_OVERRIDE]: true,
    [Symbol.for("plugin-meta")]: { name: "@stackmaster/session-api-auth" },
  });
  return plugin as FastifyPluginAsync;
}

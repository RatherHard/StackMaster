/**
 * 调试通道插件装配(阶段四 WP-41;ADR-DC1 条款 1 / 决议 3 / §六 R3)。
 *
 * 端点:`GET /sessions/debug-channel`(WebSocket 升级;位于会话凭证 Cookie
 * 的 Path=/sessions 前缀覆盖之下,D-API-12)。
 *
 * 升级认证 = 与既有 WSS 通道同一 REST / WSS 统一入口(复用认证实现,
 * buildCredentialPreHandler 同源实例):升级前未过认证即以 HTTP 401 +
 * 冻结 PublicError 统一形态拒绝升级(失败面不区分原因,防枚举;**失败
 * 响应与既有通道字节级一致**)。GET 升级不走 CSRF 闸(D-API-17)。
 *
 * 帧护栏:ws 服务端 `maxPayload = MAX_WSS_FRAME_BYTES`(与既有通道同值;
 * 调试协议语义 §四.6)。装配序要求:本插件须在既有 WSS 通道插件之后注册
 * (@fastify/websocket 装饰器已就位时跳过二次注册;独立装配时自行注册)。
 */
import websocket from "@fastify/websocket";
import { MAX_WSS_FRAME_BYTES } from "@stackmaster/protocol";
import type { FastifyPluginAsync } from "fastify";
import type { Logger } from "pino";

import { buildCredentialPreHandler } from "../auth/middleware.js";
import type { CredentialRevocationStore } from "../auth/ports.js";
import type { TokenSigner } from "../auth/keys.js";
import type { SessionMetrics } from "../metrics/metrics.js";
import type { RequestGuardLimits } from "../routes/request-guards.js";
import type { SessionActionRateLimiter } from "../limits/index.js";
import type { DebugChannelOrchestrator } from "./debug-channel-orchestrator.js";
import { DEBUG_CHANNEL_ROUTE, DEBUG_CLOSE_UNAUTHENTICATED } from "./debug-channel-constants.js";
import { DebugChannelConnection, type DebugChannelSocket } from "./debug-channel.js";

export interface DebugChannelDeps {
  readonly orchestrator: DebugChannelOrchestrator;
  // ── 升级认证(与 REST / 既有 WSS 通道凭证 preHandler 同源实例)──
  readonly signer: TokenSigner;
  readonly revocationStore: CredentialRevocationStore;
  readonly allowedOrigins: readonly string[];
  readonly logger: Logger;
  /** 数值面(默认取 config;测试装配可注入亚秒值验证行为)。 */
  readonly heartbeatIntervalSeconds: number;
  readonly idleTimeoutSeconds: number;
  readonly messageRatePerSecond: number;
  readonly sendBufferLimit: number;
  /** 结构护栏(与 REST 同值装配)。 */
  readonly limits: RequestGuardLimits;
  /**
   * 每会话动作预算闸(WP-41,ADR-DC1 条款 6:调试帧与解题共用同一桶;
   * 缺省未注入 = 不设本闸)。
   */
  readonly sessionActionLimiter?: SessionActionRateLimiter;
  readonly metrics?: SessionMetrics;
  readonly now?: () => number;
}

export function buildDebugChannel(deps: DebugChannelDeps): FastifyPluginAsync {
  const plugin = async (fastify: Parameters<FastifyPluginAsync>[0]): Promise<void> => {
    // 帧字节护栏:既有 WSS 通道插件先行注册时装饰器已就位(跳过二次注册;
    // 独立装配形态下在此注册同一配置)。
    if (!fastify.hasDecorator("websocketServer")) {
      await fastify.register(websocket, { options: { maxPayload: MAX_WSS_FRAME_BYTES } });
    }

    const credentialPreHandler = buildCredentialPreHandler(
      {
        signer: deps.signer,
        revocationStore: deps.revocationStore,
        allowedOrigins: deps.allowedOrigins,
        ...(deps.now === undefined ? {} : { now: deps.now }),
      },
      // 升级请求无请求体:claims.sessionId 升级即锚定本连接,帧级绑定校验
      // 在通道状态机执行(与既有通道同形态)。
      {},
    );

    fastify.get(
      DEBUG_CHANNEL_ROUTE,
      { websocket: true, preHandler: credentialPreHandler },
      (socket, request) => {
        const auth = request.sessionAuth;
        if (auth === null) {
          // 升级后未认证防御面(preHandler 已保证不可达):无凭证锚即无
          // 错误帧锚(不伪造 sessionId),直接策略关闭。
          request.log.warn({ reason: "unauthenticated_socket" }, "debug channel rejected");
          socket.close(DEBUG_CLOSE_UNAUTHENTICATED, "unauthenticated");
          return;
        }
        new DebugChannelConnection({
          socket: socket as unknown as DebugChannelSocket,
          claims: auth.claims,
          orchestrator: deps.orchestrator,
          logger: deps.logger,
          limits: deps.limits,
          heartbeatIntervalSeconds: deps.heartbeatIntervalSeconds,
          idleTimeoutSeconds: deps.idleTimeoutSeconds,
          messageRatePerSecond: deps.messageRatePerSecond,
          ...(deps.sessionActionLimiter === undefined
            ? {}
            : { sessionActionLimiter: deps.sessionActionLimiter }),
          sendBufferLimit: deps.sendBufferLimit,
          ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }),
          ...(deps.now === undefined ? {} : { now: deps.now }),
        }).start();
      },
    );
  };

  // fastify 插件元数据:skip-override 使 @fastify/websocket 装饰与本插件路由
  // 注册落在调用方上下文(与既有 WSS 通道插件同一机制)。
  Object.assign(plugin, {
    [Symbol.for("skip-override")]: true,
    [Symbol.for("plugin-meta")]: { name: "@stackmaster/session-api-debug-channel" },
  });
  return plugin as FastifyPluginAsync;
}

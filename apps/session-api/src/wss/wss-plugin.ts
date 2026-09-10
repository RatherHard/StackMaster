/**
 * WSS 通道插件装配(阶段三 WP-5 第 1 条;D-API-40)。
 *
 * 端点:`GET /sessions/channel`(WebSocket 升级;位于会话凭证 Cookie 的
 * Path=/sessions 前缀覆盖之下,D-API-12)。
 *
 * 升级认证 = **REST / WSS 统一入口**:凭证 preHandler(authenticateSessionCredential,
 * Cookie 呈递)在 fastify 生命周期内先行执行——升级前未过认证即以 HTTP 401 +
 * 冻结 PublicError 统一形态拒绝升级(升级即拒;失败面不区分原因,防枚举,
 * D-API-14)。GET 升级不属变更方法,Cookie 呈递不走 CSRF 闸(D-API-17)。
 *
 * 帧护栏:ws 服务端 `maxPayload = MAX_WSS_FRAME_BYTES`——超限帧由协议层以
 * close 1009 强制断开(请求护栏的字节维度在传输层落地,D-API-46)。
 *
 * 升级后未认证防御面:preHandler 保证 handler 内 sessionAuth 非空;防御分支
 * 直接策略关闭(无凭证锚即无错误帧锚,不伪造 sessionId)。
 *
 * 返回装配体:plugin 注册到 server;registry 供优雅停机(close-wss-channels
 * 步骤)与测试使用。
 */
import websocket from "@fastify/websocket";
import { MAX_WSS_FRAME_BYTES } from "@stackmaster/protocol";
import type { FastifyPluginAsync } from "fastify";
import type { Logger } from "pino";

import { buildCredentialPreHandler } from "../auth/middleware.js";
import type { CredentialRevocationStore } from "../auth/ports.js";
import type { TokenSigner } from "../auth/keys.js";
import type { SessionApiConfig } from "../config.js";
import type { IdempotencyWindow, RouteStore } from "../persistence/ports.js";
import type { RequestGuardLimits } from "../routes/request-guards.js";
import type { SessionActionRateLimiter, KeepaliveExpiryHook } from "../limits/index.js";
import type { LiveSessionManager } from "../sessions/session-manager.js";
import { WSS_CHANNEL_ROUTE, WSS_CLOSE_UNAUTHENTICATED } from "./channel-constants.js";
import { ActionChannelConnection, type ChannelSocket } from "./wss-channel.js";
import { SessionConnectionRegistry } from "./connection-registry.js";
import { randomUUID } from "node:crypto";

export interface WssChannelDeps {
  readonly manager: LiveSessionManager;
  readonly idempotencyWindow: IdempotencyWindow;
  /** RouteStore(T0 单实例消费;可省略,D-API-49)。 */
  readonly routeStore?: RouteStore;
  // ── 升级认证(与 REST 凭证 preHandler 同源实例)──
  readonly signer: TokenSigner;
  readonly revocationStore: CredentialRevocationStore;
  readonly allowedOrigins: readonly string[];
  readonly logger: Logger;
  /** 数值面(默认取 config;测试装配可注入亚秒值验证行为)。 */
  readonly heartbeatIntervalSeconds: number;
  readonly idleTimeoutSeconds: number;
  readonly messageRatePerSecond: number;
  readonly sendBufferLimit: number;
  readonly disconnectKeepaliveSeconds: number;
  /** 结构护栏(与 REST 路由同值装配;8.3)。 */
  readonly limits: RequestGuardLimits;
  /**
   * 每会话动作频率限制(WP-6,D-API-53;与每连接令牌桶叠加,同源实现;
   * 缺省未注入 = 不设本闸)。
   */
  readonly sessionActionLimiter?: SessionActionRateLimiter;
  /**
   * 保持窗口到期钩子(WP-6 会话资源回收执行面的挂载点,D-API-45 / D-API-55;
   * 注册表先释放 route 键再进入本钩子。缺省仅释放 route 键——WP-5 缺省形态)。
   */
  readonly onKeepaliveExpiry?: KeepaliveExpiryHook;
  /** 出站帧录制面(WP-7;生产缺省不注入)。 */
  readonly outboundFrameSink?: (frame: import("@stackmaster/protocol").WssFrame) => void;
  readonly now?: () => number;
}

export interface WssChannelAssembly {
  readonly plugin: FastifyPluginAsync;
  /** 连接注册表(停机步骤 close-wss-channels 的执行体;多连接 / 保持窗口)。 */
  readonly registry: SessionConnectionRegistry;
}

export function buildWssChannel(deps: WssChannelDeps): WssChannelAssembly {
  // 保持窗口到期钩子的组合(WP-6 接线,D-API-55):每会话动作频率桶逐出 →
  // 回收执行面(会话关闭 + worker 回收 + 会话行对齐)。二者都缺省时保持
  // WP-5 缺省形态(仅释放 route 键)。
  const needsExpiryHook = deps.sessionActionLimiter !== undefined || deps.onKeepaliveExpiry !== undefined;
  const registry = new SessionConnectionRegistry({
    logger: deps.logger,
    disconnectKeepaliveSeconds: deps.disconnectKeepaliveSeconds,
    ...(deps.routeStore === undefined ? {} : { routeStore: deps.routeStore }),
    // 路由键 TTL 与会话保活节奏一致:保持窗口 + 心跳余量(D-API-49)。
    routeTtlSeconds: deps.disconnectKeepaliveSeconds + deps.heartbeatIntervalSeconds * 4,
    ownerId: randomUUID(),
    ...(needsExpiryHook
      ? {
          onKeepaliveExpiry: async (session: { readonly sessionId: string; readonly tenantId: string }) => {
            deps.sessionActionLimiter?.evict(session.sessionId);
            await deps.onKeepaliveExpiry?.(session);
          },
        }
      : {}),
  });

  const plugin = async (fastify: Parameters<FastifyPluginAsync>[0]): Promise<void> => {
    // 帧字节护栏:超限帧由协议层 close 1009 强制断开(8.3 / D-API-46)。
    await fastify.register(websocket, { options: { maxPayload: MAX_WSS_FRAME_BYTES } });

    const credentialPreHandler = buildCredentialPreHandler(
      {
        signer: deps.signer,
        revocationStore: deps.revocationStore,
        allowedOrigins: deps.allowedOrigins,
        ...(deps.now === undefined ? {} : { now: deps.now }),
      },
      // 升级请求无请求体:连接绑定不在升级期做锚校验,claims.sessionId 升级即
      // 锚定本连接,帧级绑定校验在通道状态机执行(任务分解 WP-5 第 1 条)。
      {},
    );

    fastify.get(WSS_CHANNEL_ROUTE, { websocket: true, preHandler: credentialPreHandler }, (socket, request) => {
      const auth = request.sessionAuth;
      if (auth === null) {
        // 升级后未认证防御面(preHandler 已保证不可达):无凭证锚即无错误帧
        // 锚(不伪造 sessionId),直接策略关闭。
        request.log.warn({ reason: "unauthenticated_socket" }, "wss channel rejected");
        socket.close(WSS_CLOSE_UNAUTHENTICATED, "unauthenticated");
        return;
      }
      new ActionChannelConnection({
        socket: socket as unknown as ChannelSocket,
        claims: auth.claims,
        manager: deps.manager,
        idempotencyWindow: deps.idempotencyWindow,
        registry,
        logger: deps.logger,
        limits: deps.limits,
        heartbeatIntervalSeconds: deps.heartbeatIntervalSeconds,
        idleTimeoutSeconds: deps.idleTimeoutSeconds,
        messageRatePerSecond: deps.messageRatePerSecond,
        ...(deps.sessionActionLimiter === undefined
          ? {}
          : { sessionActionLimiter: deps.sessionActionLimiter }),
        sendBufferLimit: deps.sendBufferLimit,
        ...(deps.outboundFrameSink === undefined ? {} : { outboundFrameSink: deps.outboundFrameSink }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
      }).start();
    });
  };

  // fastify 插件元数据:skip-override 使 @fastify/websocket 的装饰(injectWS /
  // websocketServer)与本插件的路由注册落在调用方上下文——与 buildAuthPlugin
  // 同一机制(Symbol 为 fastify 公开插件协议),否则根实例上无 injectWS 可用。
  Object.assign(plugin, {
    [Symbol.for("skip-override")]: true,
    [Symbol.for("plugin-meta")]: { name: "@stackmaster/session-api-wss-channel" },
  });
  return { plugin: plugin as FastifyPluginAsync, registry };
}

/** SessionApiConfig 中 WSS 通道消费的数值切片(结构兼容;供装配参数命名)。 */
export type WssChannelConfigSlice = Pick<
  SessionApiConfig,
  | "wssHeartbeatIntervalSeconds"
  | "wssIdleTimeoutSeconds"
  | "wssMessageRatePerSecond"
  | "wssSendBufferLimit"
  | "disconnectKeepaliveSeconds"
>;

/**
 * REST 生命周期路由(任务分解 WP-4 第 1 / 2 条;D-API-1 路由表,D-API-30/31/32)。
 *
 * 五个会话级命令(12 动作不设 REST 镜像,WSS-only,D-API-1):
 *   POST /sessions                    create_session(消费 embed token,免会话凭证)
 *   POST /sessions/projection-sync    sync_projection(凭证保护)
 *   POST /sessions/checkpoints        list_checkpoints(凭证保护)
 *   POST /sessions/submissions        submit(凭证保护)
 *   POST /sessions/close              close_session(凭证保护)
 *
 * 纪律:
 *  - 一切入站按冻结 Schema 重新校验(session-contract:N-1 受理集合路由 +
 *    strictObject + 结构护栏);失败 = 冻结 PublicError,零校验器细节,
 *    原始 issue 路径只进受控日志(基线 #8);
 *  - 身份只读 request.sessionAuth(基线 #1;凭证 preHandler 产出);
 *    会话定位 = 请求体 payload.sessionId 为权威锚,与凭证绑定三方对齐
 *    (跨租户 / 跨会话呈递在 preHandler 即 401);
 *  - 会话定位失败与路由 404 同形(防枚举);一切非 2xx = 冻结 PublicError
 *    (映射矩阵 D-API-32);
 *  - 响应面在发送前过冻结 `SessionCommandResponseSchema` 自检(漂移即 500
 *    兜底,绝不下发非契约形态);
 *  - create-session 的重复创建与并发预算接入点:`createSessionGuard` 钩子
 *    (执行面归 WP-6;缺省放行,D-API-35)。
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  type SessionCommandRequest,
  type PublicError,
  SessionCommandResponseSchema,
} from "@stackmaster/protocol";

import {
  AUTH_FAILED_ERROR,
  AUTH_FAILED_HTTP_STATUS,
  EmbedTokenConsumptionRejected,
  consumeEmbedToken,
  issueSessionCredential,
  setSessionCredentialCookie,
  buildCredentialPreHandler,
  type AuditSink,
  type CredentialRevocationStore,
  type TokenIssuanceStore,
  type TokenSigner,
} from "../auth/index.js";
import type { Logger } from "pino";

import type { SessionApiConfig } from "../config.js";
import { withSessionFields } from "../logger.js";
import type { RequestGuardLimits } from "./request-guards.js";
import {
  mapDomainFailure,
  mapValidationFailure,
} from "./error-mapping.js";
import { parseSessionCommandRequest } from "./session-contract.js";
import { LiveSessionManager } from "../sessions/session-manager.js";

/** 生命周期路由表(D-API-1;list_checkpoints 以 POST 承载,调整理由记 D-API-30)。 */
export const SESSION_ROUTES = {
  create: "/sessions",
  projectionSync: "/sessions/projection-sync",
  checkpoints: "/sessions/checkpoints",
  submissions: "/sessions/submissions",
  close: "/sessions/close",
} as const;

/**
 * create-session 接入点钩子(WP-6 限流 / 并发预算的执行面挂载点;D-API-35)。
 * 抛错即拒绝创建(调用方以冻结 PublicError 形态呈现);缺省放行——本阶段
 * 只固定接入点,不实现限流本身(任务分解 WP-4 第 5 条)。
 */
export interface CreateSessionGuard {
  beforeCreate(request: FastifyRequest, identity: {
    readonly tenantId: string;
    readonly userId: string;
    readonly challengeId: string;
    readonly challengeVersion: string;
  }): Promise<void>;
}

export interface SessionRouteDeps {
  readonly config: Pick<SessionApiConfig, "nodeEnv" | "sessionCredentialTtlSeconds">;
  readonly manager: LiveSessionManager;
  readonly guards: RequestGuardLimits;
  /** pino 根 logger(consumeEmbedToken 等域服务要求 pino Logger;请求关联经 reqId 子日志)。 */
  readonly logger: Logger;
  // ── 认证面(与签发路由同源实例;由运行时装配注入)──
  readonly signer: TokenSigner;
  readonly issuanceStore: TokenIssuanceStore;
  readonly revocationStore: CredentialRevocationStore;
  readonly audit: AuditSink;
  readonly allowedOrigins: readonly string[];
  /** WP-6 接入点(缺省放行)。 */
  readonly createSessionGuard?: CreateSessionGuard;
  /**
   * 每租户 / 每用户请求频率闸(WP-6,D-API-50;凭证保护命令共用,
   * `rate:{tenant}:{user}` 固定窗口;缺省未注入 = 放行)。
   */
  readonly requestRateGate?: (tenantId: string, userId: string) => Promise<void>;
  /**
   * 提交频率闸(WP-6,D-API-50;submit 专属,`rate:{tenant}:{user}:submit`
   * 固定窗口;缺省未注入 = 放行)。
   */
  readonly submitRateGate?: (tenantId: string, userId: string) => Promise<void>;
  readonly now?: () => number;
}

function sendFailure(reply: FastifyReply, status: number, body: PublicError): FastifyReply {
  return reply.code(status).send(body);
}

/** 请求关联的受控子日志(reqId 单一真源;凭证材料零入日志)。 */
function requestCorrelatedLogger(deps: SessionRouteDeps, request: FastifyRequest): Logger {
  return deps.logger.child({ reqId: request.id });
}

/** 从请求体提取会话定位锚(凭证绑定校验用;路径不携带会话标识,D-API-1)。 */
function payloadSessionId(request: FastifyRequest): string | undefined {
  const payload = (request.body as { payload?: { sessionId?: unknown } } | null)?.payload;
  return typeof payload?.sessionId === "string" ? payload.sessionId : undefined;
}

export function buildSessionRoutes(deps: SessionRouteDeps): FastifyPluginAsync {
  const now = deps.now ?? Date.now;

  return async function sessionRoutes(fastify): Promise<void> {
    // ── 凭证保护(四个会话命令;create-session 除外——它消费 embed token)──
    const requireSessionCredential = buildCredentialPreHandler(
      {
        signer: deps.signer,
        revocationStore: deps.revocationStore,
        allowedOrigins: deps.allowedOrigins,
        now: deps.now,
      },
      { getSessionAnchor: payloadSessionId },
    );

    /** 命令路由共用骨架:契约校验 → 命令执行 → 冻结响应自检(零校验器细节)。 */
    const logContractRejection = (
      request: FastifyRequest,
      failure: ReturnType<typeof parseSessionCommandRequest> extends infer R
        ? R extends { ok: false; failure: infer F } ? F : never
        : never,
    ): void => {
      request.log.warn(
        {
          reason: failure.kind,
          ...(failure.issueCount === undefined ? {} : { issueCount: failure.issueCount }),
          ...(failure.issuePaths === undefined ? {} : { issuePaths: failure.issuePaths }),
          ...(failure.dimension === undefined ? {} : { dimension: failure.dimension }),
        },
        "session command rejected at contract layer",
      );
    };

    const commandHandler = (
      command: Exclude<SessionCommandRequest["command"], "create_session">,
      execute: (
        manager: LiveSessionManager,
        sessionId: string,
        tenantId: string,
        request: FastifyRequest,
      ) => Promise<object>,
    ) =>
      async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
        const parsed = parseSessionCommandRequest(request.body, deps.guards);
        if (!parsed.ok) {
          logContractRejection(request, parsed.failure);
          const mapped = mapValidationFailure(parsed.failure);
          return sendFailure(reply, mapped.status, mapped.body);
        }
        if (parsed.request.command !== command) {
          // 命令与路由不匹配(路由即命令判别,请求体 command 仅供契约校验):
          // 与畸形请求同族确定性拒绝。
          request.log.warn({ reason: "command_route_mismatch" }, "session command rejected at contract layer");
          return sendFailure(reply, 400, mapValidationFailure({ kind: "malformed_body" }).body);
        }
        const auth = request.sessionAuth;
        if (auth === null) {
          return sendFailure(reply, AUTH_FAILED_HTTP_STATUS, AUTH_FAILED_ERROR);
        }
        try {
          // 每租户 / 每用户请求频率闸(WP-6,D-API-50):触顶 = 429 冻结形态。
          if (deps.requestRateGate !== undefined) {
            await deps.requestRateGate(auth.claims.tenantId, auth.claims.userId);
          }
          const payload = await execute(
            deps.manager,
            parsed.request.payload.sessionId,
            auth.claims.tenantId,
            request,
          );
          // 响应面冻结自检:漂移即抛错走 500 兜底(实现事故不外发)。
          return reply.code(200).send(SessionCommandResponseSchema.parse({
            command,
            payload,
          }));
        } catch (error) {
          const mapped = mapDomainFailure(error);
          if (mapped !== null) {
            return sendFailure(reply, mapped.status, mapped.body);
          }
          throw error;
        }
      };

    // ── create_session(消费 embed token;免会话凭证)───────────────────────
    type ConsumedIdentity = Awaited<ReturnType<typeof consumeEmbedToken>>;
    type CreatedOutcome = Awaited<ReturnType<LiveSessionManager["createSession"]>>;
    fastify.post(SESSION_ROUTES.create, async (request, reply) => {
      const parsed = parseSessionCommandRequest(request.body, deps.guards);
      if (!parsed.ok) {
        logContractRejection(request, parsed.failure);
        const mapped = mapValidationFailure(parsed.failure);
        return sendFailure(reply, mapped.status, mapped.body);
      }
      if (parsed.request.command !== "create_session") {
        request.log.warn({ reason: "command_route_mismatch" }, "create_session rejected at contract layer");
        return sendFailure(reply, 400, mapValidationFailure({ kind: "malformed_body" }).body);
      }
      const payload = parsed.request.payload;

      // 1. embed token 三方比对消费(签名 → jti 单次原子消费 → 记录比对 →
      //    上下文比对;拒绝面统一 401,D-API-14;token 值零入日志)。
      let identity: ConsumedIdentity;
      try {
        identity = await consumeEmbedToken(
          {
            signer: deps.signer,
            issuanceStore: deps.issuanceStore,
            audit: deps.audit,
            logger: requestCorrelatedLogger(deps, request),
            now,
          },
          {
            embedToken: payload.embedToken,
            context: {
              challengeId: payload.challengeId,
              challengeVersion: payload.challengeVersion,
              embedSessionId: payload.embedSessionId,
            },
          },
        );
      } catch (error) {
        if (error instanceof EmbedTokenConsumptionRejected) {
          return sendFailure(reply, AUTH_FAILED_HTTP_STATUS, AUTH_FAILED_ERROR);
        }
        throw error;
      }

      // 2. WP-6 接入点:重复创建 / 并发预算(缺省放行;拒绝即冻结形态)。
      if (deps.createSessionGuard !== undefined) {
        try {
          await deps.createSessionGuard.beforeCreate(request, {
            tenantId: identity.tenantId,
            userId: identity.userId,
            challengeId: identity.challengeId,
            challengeVersion: identity.challengeVersion,
          });
        } catch (error) {
          request.log.warn(
            { reason: "create_session_guard_rejected", err: error },
            "create_session rejected by guard",
          );
          const mapped = mapDomainFailure(error);
          if (mapped !== null) {
            return sendFailure(reply, mapped.status, mapped.body);
          }
          throw error;
        }
      }

      // 3. 题目装载 + 编排器创建 + 会话行落库(私有包只透传)。
      let outcome: CreatedOutcome;
      try {
        outcome = await deps.manager.createSession(identity);
      } catch (error) {
        const mapped = mapDomainFailure(error);
        if (mapped !== null) {
          return sendFailure(reply, mapped.status, mapped.body);
        }
        throw error;
      }

      // 4. 会话凭证签发 + Cookie 交付(响应体零凭证字段,D-API-3 / 12)。
      const issued = await issueSessionCredential(
        { signer: deps.signer, audit: deps.audit, ttlSeconds: deps.config.sessionCredentialTtlSeconds, now },
        {
          sessionId: outcome.sessionId,
          tenantId: identity.tenantId,
          userId: identity.userId,
          challengeId: identity.challengeId,
          challengeVersion: identity.challengeVersion,
        },
      );
      setSessionCredentialCookie(reply, issued.token, issued.ttlSeconds, deps.config.nodeEnv);

      // 5. 冻结响应(create_session 分支;投影 revision 耦合由 Schema 复验)。
      return reply.code(201).send(SessionCommandResponseSchema.parse({
        command: "create_session",
        payload: {
          sessionId: outcome.sessionId,
          revision: outcome.revision,
          projection: outcome.projection,
        },
      }));
    });

    // ── sync_projection ──
    fastify.post(SESSION_ROUTES.projectionSync, {
      preHandler: requireSessionCredential,
      handler: commandHandler("sync_projection", async (manager, sessionId, tenantId) => {
        const { revision, projection } = await manager.syncProjection(sessionId, tenantId);
        return { revision, projection };
      }),
    });

    // ── list_checkpoints(POST 承载;调整理由记 D-API-30)──
    fastify.post(SESSION_ROUTES.checkpoints, {
      preHandler: requireSessionCredential,
      handler: commandHandler("list_checkpoints", async (manager, sessionId, tenantId) => {
        const checkpoints = await manager.listCheckpoints(sessionId, tenantId);
        return { checkpoints };
      }),
    });

    // ── submit(裁决引用与动作日志锚整体 SERVER_ONLY,响应只含 {submissionId, revision})──
    fastify.post(SESSION_ROUTES.submissions, {
      preHandler: requireSessionCredential,
      handler: commandHandler("submit", async (manager, sessionId, tenantId, request) => {
        // 提交频率闸(WP-6,D-API-50):请求频率之外的第二维度,触顶 429 冻结形态。
        const auth = request.sessionAuth;
        if (deps.submitRateGate !== undefined && auth !== null) {
          await deps.submitRateGate(tenantId, auth.claims.userId);
        }
        const { submissionId, revision } = await manager.submit(sessionId, tenantId);
        withSessionFields(requestCorrelatedLogger(deps, request), { sessionId, tenantId, revision }).info(
          "submission recorded",
        );
        return { submissionId, revision };
      }),
    });

    // ── close_session ──
    fastify.post(SESSION_ROUTES.close, {
      preHandler: requireSessionCredential,
      handler: commandHandler("close_session", async (manager, sessionId, tenantId) => {
        return manager.closeSession(sessionId, tenantId);
      }),
    });
  };
}

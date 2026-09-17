/**
 * 管理面只读路由(D-MP-5 分支 A;三个只读面 + 冻结拒绝面;D-API-135)。
 *
 * 面 1 `GET /admin/challenges` —— 题目登记列表(`challenges` /
 *   `challenge_versions` 语义;公开登记值:题目标识 / 标题 / 版本链摘要)。
 * 面 2 `GET /admin/verdicts`   —— 裁决查询(按 submissionId / 题目 / 时间窗;
 *   载荷逐条过冻结 `VerdictQueryResponseSchema`,`detail` 与 `reference`
 *   结构性不可达)。
 * 面 3 `GET /admin/scores`     —— 成绩导出(**复用 WP-78 契约与语义**,
 *   出口唯一 = `HostScoresResponseSchema.parse`;禁写第二套实现)。
 *
 * ── 认证 ─────────────────────────────────────────────────────────────
 * 三条路由全部要求管理面独立凭证(`Authorization: Bearer <凭证>`;
 * `ADMIN_CREDENTIAL_SHA256` 摘要比对,常量时间)。缺失 / 错误 / 畸形一律
 * 401 + 同一冻结 `PublicError`(D-API-14 统一失败面,零枚举信号)。
 *
 * ── 租户作用域(与 O-MP-6 同源)──────────────────────────────────────
 * 租户只能由「凭证绑定集合(ADMIN_TENANTS)+ 查询参数在集合内子选」确定;
 * 未绑定 / 白名单为空 / 多租户未指定 ⇒ 404 **同形**(与"库中不存在"
 * 逐字节相同,防枚举)。查询参数决定不了租户,请求体不存在(GET)。
 *
 * ── 审计(fail-closed)────────────────────────────────────────────────
 * 每次查询在下发前落一条受控日志审计记录(见 `audit/admin-audit.ts`:
 * 审计 kind 十值封闭集,管理面查询是运维读取事实,不新增 kind);
 * **审计写失败 ⇒ 503 且零数据下发**(fail-closed 的落点是披露点)。
 *
 * ── 只读 ─────────────────────────────────────────────────────────────
 * 三条路由全部 GET,无请求体语义,无写路径。查询参数走**严格对象**:
 * 未登记参数即 400(而非静默忽略——静默忽略一个写错的过滤条件 =
 * 返回"看起来正确其实是另一个作用域"的数据,是运营面最危险的一类错误)。
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  IDENTIFIER_CHARSET_PATTERN,
  OPAQUE_ID_MAX_LENGTH,
  PublicErrorSchema,
  VerdictQueryResponseSchema,
  type PublicError,
} from "@stackmaster/protocol";

import { ADMIN_AUDIT_ACTOR, type AdminQueryAudit } from "../audit/admin-audit.js";
import { AdminTenantBinding } from "../auth/tenant-binding.js";
import { assertPublicRegistryEntries } from "../challenges/registry-contract.js";
import {
  ADMIN_UNAUTHORIZED_ERROR,
  ADMIN_UNAUTHORIZED_STATUS,
  type AdminCredentialVerifier,
} from "../auth/credential.js";
import type { AdminMetrics } from "../metrics.js";
import {
  ADMIN_RATE_LIMITED_ERROR,
  ADMIN_RATE_LIMITED_STATUS,
  type AdminRateLimiter,
} from "../rate-limit.js";
import { AdminStoreError, type AdminReadStore } from "../persistence/ports.js";
import {
  DEFAULT_CHALLENGE_PAGE,
  DEFAULT_SCORES_BATCH,
  DEFAULT_VERDICT_PAGE,
  SCORES_BATCH_CEILING,
  VERDICT_PAGE_CEILING,
} from "../config.js";
import { exportHostScores } from "../scores/export.js";

/** 管理面只读路由表(实现面登记;D-API-83 同款先例:GET 无请求体)。 */
export const ADMIN_ROUTES = {
  challenges: "/admin/challenges",
  verdicts: "/admin/verdicts",
  scores: "/admin/scores",
} as const;

/** 认证拒绝的冻结响应体(401,复用 protocol PublicErrorSchema)。 */
export const ADMIN_UNAUTHORIZED = ADMIN_UNAUTHORIZED_ERROR;

/** 查询参数不合规(400 冻结形态;文案与会话面 `invalid request` 同族)。 */
export const ADMIN_INVALID_REQUEST_ERROR: PublicError = PublicErrorSchema.parse({
  code: "invalid_input_format",
  message: "invalid request",
});

/** 存储不可用(503 冻结形态;fail-closed,绝不兜底成空批/空列表)。 */
export const ADMIN_STORAGE_UNAVAILABLE_ERROR: PublicError = PublicErrorSchema.parse({
  code: "internal_error",
  message: "storage unavailable",
});

/** 审计不可用(503 冻结形态;审计写失败即零数据下发)。 */
export const ADMIN_AUDIT_UNAVAILABLE_ERROR: PublicError = PublicErrorSchema.parse({
  code: "internal_error",
  message: "audit unavailable",
});

/** 数据面 404 冻结形态(未绑定租户 / 白名单为空 / 不存在,**同形**)。 */
export const ADMIN_NOT_FOUND_ERROR: PublicError = PublicErrorSchema.parse({
  code: "invalid_input_format",
  message: "resource not found",
});

export const ADMIN_NOT_FOUND_STATUS = 404;
export const ADMIN_INVALID_REQUEST_STATUS = 400;
export const ADMIN_UNAVAILABLE_STATUS = 503;

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 查询参数公共片段:租户子选(可选;绑定集合内子选)。 */
const tenantParam = z
  .string()
  .min(1)
  .max(OPAQUE_ID_MAX_LENGTH)
  .regex(IDENTIFIER_CHARSET_PATTERN, "租户标识符只接受冻结字符集");

const ChallengesQuerySchema = z.strictObject({
  tenant: tenantParam.optional(),
  limit: z.coerce.number().int().min(1).max(SCORES_BATCH_CEILING).default(DEFAULT_CHALLENGE_PAGE),
});

const VerdictsQuerySchema = z.strictObject({
  tenant: tenantParam.optional(),
  limit: z.coerce.number().int().min(1).max(VERDICT_PAGE_CEILING).default(DEFAULT_VERDICT_PAGE),
  submissionId: z.string().regex(UUID_PATTERN, "submissionId 必须是 UUID").optional(),
  challengeId: tenantParam.optional(),
  // Unix epoch 秒(UTC);窗口闭区间。非法值 = 400(不静默忽略过滤条件)。
  since: z.coerce.number().int().min(0).optional(),
  until: z.coerce.number().int().min(0).optional(),
});

const ScoresQuerySchema = z.strictObject({
  tenant: tenantParam.optional(),
  limit: z.coerce.number().int().min(1).max(SCORES_BATCH_CEILING).default(DEFAULT_SCORES_BATCH),
  // keyset 游标 = 上一页末行 `verdicts.id`(D-API-123:主键游标,禁时刻游标)。
  cursor: z.string().regex(UUID_PATTERN, "cursor 必须是 UUID").optional(),
});

export interface AdminRouteDeps {
  readonly credentials: AdminCredentialVerifier;
  readonly tenants: AdminTenantBinding;
  readonly store: AdminReadStore;
  readonly audit: AdminQueryAudit;
  readonly metrics: AdminMetrics;
  readonly rateLimiter: AdminRateLimiter;
  /** 审计时刻源(测试可注入;缺省 Date.now)。 */
  readonly now?: () => number;
}

type Surface = "challenges" | "verdicts" | "scores";

export function buildAdminRoutes(deps: AdminRouteDeps): FastifyPluginAsync {
  const now = deps.now ?? (() => Date.now());

  /** 拒绝路径审计:尽力而为(此刻无租户上下文;响应已是拒绝态)。 */
  const bestEffortAudit = async (
    surface: Surface,
    outcome: "denied" | "not_found" | "rate_limited" | "error",
    tenantId?: string,
  ): Promise<void> => {
    try {
      await deps.audit.record({
        surface,
        outcome,
        actor: ADMIN_AUDIT_ACTOR,
        at: now(),
        ...(tenantId === undefined ? {} : { tenantId }),
      });
    } catch {
      // 拒绝面本身已是 fail-closed:审计失败只损失账目,不改变拒绝结论。
    }
  };

  /**
   * 凭证 + 频率闸(两闸都在租户解析之前:未认证请求不得触碰任何租户维度)。
   * 返回 `null` = 已发出拒绝响应。
   */
  const preflight = async (
    surface: Surface,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<boolean> => {
    if (!deps.credentials.verify(request.headers["authorization"])) {
      request.log.warn({ surface, reason: "admin_credential_rejected" }, "admin request rejected");
      await bestEffortAudit(surface, "denied");
      deps.metrics.recordQuery(surface, "denied", 0);
      await reply.code(ADMIN_UNAUTHORIZED_STATUS).send(ADMIN_UNAUTHORIZED);
      return false;
    }
    if (!deps.rateLimiter.allow(request.ip)) {
      await bestEffortAudit(surface, "rate_limited");
      deps.metrics.recordQuery(surface, "rate_limited", 0);
      await reply.code(ADMIN_RATE_LIMITED_STATUS).send(ADMIN_RATE_LIMITED_ERROR);
      return false;
    }
    return true;
  };

  const rejectInvalid = async (
    surface: Surface,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    await bestEffortAudit(surface, "denied");
    deps.metrics.recordQuery(surface, "denied", 0);
    return reply.code(ADMIN_INVALID_REQUEST_STATUS).send(ADMIN_INVALID_REQUEST_ERROR);
  };

  /**
   * 租户解析 + 读面 + **披露点 fail-closed 审计** + 响应。
   *
   * 顺序是硬语义:租户未绑定 ⇒ 404(不触存储);存储异常 ⇒ 503(不伪装
   * 空批);审计失败 ⇒ 503 且 body 不含任何数据项。
   */
  const withTenant = async <Body>(
    surface: Surface,
    requestedTenant: string | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
    produce: (tenantId: string) => Promise<Body>,
  ): Promise<unknown> => {
    const startedAt = now();
    const resolution = deps.tenants.resolve(requestedTenant);
    if (resolution.kind === "not_found") {
      await bestEffortAudit(surface, "not_found");
      deps.metrics.recordQuery(surface, "not_found", 0);
      return reply.code(ADMIN_NOT_FOUND_STATUS).send(ADMIN_NOT_FOUND_ERROR);
    }
    let body: Body;
    try {
      body = await produce(resolution.tenantId);
    } catch (error) {
      if (error instanceof AdminStoreError) {
        request.log.error({ surface, err: error.message }, "admin read store unavailable");
        await bestEffortAudit(surface, "error", resolution.tenantId);
        deps.metrics.recordQuery(surface, "error", 0);
        return reply.code(ADMIN_UNAVAILABLE_STATUS).send(ADMIN_STORAGE_UNAVAILABLE_ERROR);
      }
      throw error;
    }
    // ── fail-closed 审计:披露点之前必须落账;落账失败即零数据下发 ──
    try {
      await deps.audit.record({
        surface,
        outcome: "ok",
        tenantId: resolution.tenantId,
        actor: ADMIN_AUDIT_ACTOR,
        at: now(),
      });
    } catch (error) {
      request.log.error({ surface, err: String(error) }, "admin query audit failed (fail-closed)");
      deps.metrics.recordQuery(surface, "error", 0);
      return reply.code(ADMIN_UNAVAILABLE_STATUS).send(ADMIN_AUDIT_UNAVAILABLE_ERROR);
    }
    deps.metrics.recordQuery(surface, "ok", Math.max(0, (now() - startedAt) / 1_000));
    return reply.code(200).send(body);
  };

  return async function adminRoutes(fastify): Promise<void> {
    // ── 面 1:题目登记列表 ────────────────────────────────────────────
    fastify.get(ADMIN_ROUTES.challenges, async (request, reply): Promise<unknown> => {
      if (!(await preflight("challenges", request, reply))) {
        return reply;
      }
      const parsed = ChallengesQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        return rejectInvalid("challenges", reply);
      }
      return withTenant("challenges", parsed.data.tenant, request, reply, async (tenantId) => {
        const items = await deps.store.listChallenges({ tenantId, limit: parsed.data.limit });
        // 出口前的公开契约校验(复用 `@stackmaster/challenge-schema` 的模式源):
        // 越界登记值 ⇒ 503 零下发,不把不符契约的值下发给运维(见该模块头注)。
        assertPublicRegistryEntries(items);
        return { items };
      });
    });

    // ── 面 2:裁决查询(载荷逐条过冻结契约)────────────────────────────
    fastify.get(ADMIN_ROUTES.verdicts, async (request, reply): Promise<unknown> => {
      if (!(await preflight("verdicts", request, reply))) {
        return reply;
      }
      const parsed = VerdictsQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        return rejectInvalid("verdicts", reply);
      }
      const query = parsed.data;
      return withTenant("verdicts", query.tenant, request, reply, async (tenantId) => {
        // 多取一行探测截断(与成绩面的 `limit + 1` 探测同一纪律)。
        const rows = await deps.store.queryVerdicts({
          tenantId,
          limit: query.limit + 1,
          ...(query.submissionId === undefined ? {} : { submissionId: query.submissionId }),
          ...(query.challengeId === undefined ? {} : { challengeId: query.challengeId }),
          ...(query.since === undefined ? {} : { sinceEpochSeconds: query.since }),
          ...(query.until === undefined ? {} : { untilEpochSeconds: query.until }),
        });
        const page = rows.slice(0, query.limit);
        return {
          // 逐条过冻结契约(D-API-83/D-API-84:pending 态不得携带 verdict /
          // decidedAt 的跨字段耦合由 schema 强制;越界字面即抛 500 兜底)。
          items: page.map((row) =>
            VerdictQueryResponseSchema.parse(
              row.status === "pending"
                ? { submissionId: row.submissionId, revision: row.revision, status: "pending" }
                : {
                    submissionId: row.submissionId,
                    revision: row.revision,
                    status: "verdicted",
                    verdict: row.verdict,
                    decidedAt: row.decidedAtEpochSeconds,
                  },
            ),
          ),
          // 时间窗查询是**有界**形态:`truncated` 是给运营的确定信号
          // (命中上限 ⇒ 收窄窗口),不发明第二套游标语义(见 D-API-135)。
          truncated: rows.length > query.limit,
        };
      });
    });

    // ── 面 3:成绩导出(WP-78 契约与语义的唯一出口)─────────────────────
    fastify.get(ADMIN_ROUTES.scores, async (request, reply): Promise<unknown> => {
      if (!(await preflight("scores", request, reply))) {
        return reply;
      }
      const parsed = ScoresQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        return rejectInvalid("scores", reply);
      }
      const query = parsed.data;
      return withTenant("scores", query.tenant, request, reply, async (tenantId) =>
        exportHostScores({
          store: deps.store,
          tenantId,
          limit: query.limit,
          ...(query.cursor === undefined ? {} : { afterId: query.cursor }),
        }),
      );
    });
  };
}

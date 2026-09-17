/**
 * 宿主成绩同步只读路由(中期 M3 WP-78;D-API-122 ~ D-API-126)。
 *
 * `GET /host/scores` —— 宿主后端(平台服务端)批量拉取**本租户成绩**的只读
 * 查询面。契约面 = `HostScoresResponse`(WP-78 冻结,独立版本族
 * `HOST_SCORES_PROTOCOL_VERSION` / `…/schemas/host-scores/v1`)。纪律:
 *
 *  - **认证 = 宿主凭证**(D-API-122):`Authorization: Bearer
 *    <SESSION_API_HOST_BACKEND_TOKEN>`,复用 `hostBackendTokenMatches` 的
 *    常数时间比较(sha256 + timingSafeEqual,**同一实现零副本**)——**不是**
 *    会话凭证面;缺失 / 畸形 / 错误一律统一 401 + 冻结
 *    `{code:"invalid_input_format", message:"authentication failed"}`(字节级
 *    沿 D-API-14),不区分失败原因(防枚举)。宿主凭证是静态共享令牌,无过期
 *    面 ⇒ 凭证矩阵 = 缺失 / 畸形 / 错误(含长度差异)。
 *  - **GET 免 CSRF 门**:凭证经 Authorization 头呈递(浏览器不自动附加),
 *    非 Cookie 呈递向量 ⇒ 不适用 D-API-17 的 CSRF 闸(沿既有 GET 口径)。
 *  - **租户绑定 = 凭证 × 白名单**(O-MP-6 落地面,D-API-124):租户**只**从
 *    `SESSION_API_HOST_TENANTS` 推导(认证配置面),查询参数只能在集合内
 *    **子选**,**禁止由查询参数决定租户**;请求体零身份字段(本路由无请求体)。
 *    白名单空 / 缺失 ⇒ **整体 404 同形**(fail-closed,防枚举);`tenantId`
 *    参数不在集合内 ⇒ **与"不存在"同形 404**(不区分"该租户不存在"与
 *    "该租户未绑定")。
 *  - **查询参数白名单**(D-API-124):仅 `cursor` / `limit` / `tenantId`;
 *    任何未登记参数 ⇒ 400 冻结形态(未知面不静默忽略,防"参数被忽略导致
 *    调用方误读调用语义")。`cursor` 走冻结标识符字符集 ∧ UUID 规范形态闸
 *    (不合规 = 400,不把畸形游标送进库层 cast);`limit` 为正整数且
 *    ≤ config.hostScoresBatch,**超限 = 400 冻结形态**(确定性拒绝,不钳制
 *    ——D-API-125)。
 *  - **批量上限三道闸**(D-API-125):required / known 键面由
 *    `KNOWN_ENV_KEYS` 覆盖 + `envSchema` 的 `max` = 天花板常量(配置超限拒绝
 *    启动)+ 本路由的请求面 `limit ≤ config.hostScoresBatch`。
 *  - **限流**(D-API-125):`rate:{tenant}:host_scores` 固定窗口(tenant =
 *    凭证绑定集合的规范化锚 = 字典序最小 tenantId,与配置书写顺序无关;
 *    子选不改限流键 ⇒ 无法通过交替子选放大预算);触顶 429 + 冻结形态
 *    `{code:"budget_exhausted", message:"rate limit exceeded"}`——与 D-API-50 /
 *    D-API-84 频率类**共用同一冻结常量**(字节级一致)。
 *  - **载荷上限面**(D-API-123):响应发送前过冻结 `HostScoresResponseSchema`
 *    自检(漂移即 500 兜底,绝不下发非契约形态;落库 verdict 字面在 11 值外
 *    同走此兜底);`verdicts.detail` / `submissions.reference` / 内部堆栈在
 *    本路由零读取零下发(SERVER_ONLY)。
 *  - **终态确定性**(D-API-123):`nextCursor` = 有下一页时的末行 `id`,
 *    否则恒 `null`(键恒在);空批 ⇒ `nextCursor = null`(契约跨字段耦合),
 *    空批是**合法终态**而非错误。
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import {
  HostScoresResponseSchema,
  IDENTIFIER_CHARSET_PATTERN,
  OPAQUE_ID_MAX_LENGTH,
  type HostScoresResponse,
} from "@stackmaster/protocol";

import {
  AUTH_FAILED_ERROR,
  AUTH_FAILED_HTTP_STATUS,
  hostBackendTokenMatches,
} from "../auth/index.js";
import type { HostScoresQueryStore } from "../persistence/index.js";
import {
  mapDomainFailure,
  NOT_FOUND_ERROR,
  VALIDATION_ERROR,
} from "./error-mapping.js";

/** 宿主成绩同步路由表(D-API-122 定案路由)。 */
export const HOST_SCORES_ROUTES = {
  scores: "/host/scores",
} as const;

/** 宿主面查询参数白名单(未知参数 = 400;登记面即契约实现口径)。 */
export const HOST_SCORES_QUERY_PARAMS = ["cursor", "limit", "tenantId"] as const;

/**
 * 游标参数形态闸:规范 UUID 文本(`verdicts.id` 的文本投影;大小写不敏感,
 * 库内恒小写)。契约面 `id` 字段保持不透明标识符(D-API-123),本闸是
 * **实现期**口径——畸形游标在路由层确定性拒绝(400),不进库层 cast
 * (否则会以 503 形态呈现调用方错误,既是错误精度错配,也让调用方无法
 * 区分自身输入错误与存储故障)。
 */
const CURSOR_UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface HostScoresRouteDeps {
  /** 宿主后端共享凭证(与签发端点同源配置键;比较走常数时间路径)。 */
  readonly hostBackendToken: string;
  /**
   * 凭证绑定的租户白名单(config.hostTenants;已规范化:去重 + 字典序)。
   * 空数组 = 宿主成绩面整体 404 同形(fail-closed,防枚举)。
   */
  readonly hostTenants: readonly string[];
  /** 单批行数上限(config.hostScoresBatch;query 参数 limit 不得越过)。 */
  readonly hostScoresBatch: number;
  /** 宿主成绩只读读取端口(零写入面;租户集合为入参,非载荷字段)。 */
  readonly scores: Pick<HostScoresQueryStore, "listScores">;
  /**
   * 宿主面频率闸(D-API-125;`rate:{tenant}:host_scores` 固定窗口;缺省未
   * 注入 = 放行,与既有 requestRateGate / verdictRateGate 同装配纪律)。
   * 入参 = 凭证绑定集合的规范化锚租户(见文件头)。
   */
  readonly hostScoresRateGate?: (anchorTenantId: string) => Promise<void>;
}

/** 宿主凭证 preHandler:统一 401 出口(reason 只进受控日志)。 */
export function buildHostCredentialPreHandler(
  hostBackendToken: string,
): preHandlerHookHandler {
  return async function hostCredentialPreHandler(request, reply) {
    if (!hostBackendTokenMatches(request.headers.authorization, hostBackendToken)) {
      request.log.warn({ reason: "host_scores_credential_rejected" }, "host credential rejected");
      return reply.code(AUTH_FAILED_HTTP_STATUS).send(AUTH_FAILED_ERROR);
    }
  };
}

export function buildHostScoresRoutes(deps: HostScoresRouteDeps): FastifyPluginAsync {
  // 限流锚租户:绑定集合的字典序最小项(config 已排序)。空集合时该面整体
  // 404(下方第一步),锚不会被消费。
  const rateAnchorTenant = deps.hostTenants[0];

  return async function hostScoresRoutes(fastify): Promise<void> {
    const requireHostCredential = buildHostCredentialPreHandler(deps.hostBackendToken);

    fastify.get(HOST_SCORES_ROUTES.scores, {
      preHandler: requireHostCredential,
      handler: async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
        // 1. 面可用闸(O-MP-6 / D-API-124):白名单空 / 缺失 ⇒ 整体 404 同形
        //    (fail-closed,防枚举;与"不存在"不可区分)。
        if (deps.hostTenants.length === 0 || rateAnchorTenant === undefined) {
          request.log.warn({ reason: "host_scores_surface_unbound" }, "host scores surface disabled");
          return notFound(reply);
        }

        // 2. 查询参数闸(白名单 + 取值):一切不合规 = 400 冻结形态。
        const query = request.query as Record<string, unknown>;
        const unknown = Object.keys(query).filter(
          (key) => !(HOST_SCORES_QUERY_PARAMS as readonly string[]).includes(key),
        );
        if (unknown.length > 0) {
          request.log.warn({ reason: "host_scores_unknown_param" }, "host scores rejected at param gate");
          return invalidRequest(reply);
        }

        const limitParam = query["limit"]; // raw
        let limit = deps.hostScoresBatch;
        if (limitParam !== undefined) {
          if (typeof limitParam !== "string" || !/^[0-9]+$/.test(limitParam)) {
            request.log.warn({ reason: "host_scores_limit_malformed" }, "host scores rejected at limit gate");
            return invalidRequest(reply);
          }
          const parsed = Number(limitParam);
          // 超限 = 确定性拒绝(不钳制):钳制会把调用方的分页逻辑错误静默
          // 变成"每页都取到上限",且页边界与调用方预期不符(D-API-125)。
          if (parsed < 1 || parsed > deps.hostScoresBatch) {
            request.log.warn(
              { reason: "host_scores_limit_over_batch", batch: deps.hostScoresBatch },
              "host scores rejected at batch gate",
            );
            return invalidRequest(reply);
          }
          limit = parsed;
        }

        const cursorParam = query["cursor"];
        let afterId: string | null = null;
        if (cursorParam !== undefined) {
          if (
            typeof cursorParam !== "string" ||
            cursorParam.length === 0 ||
            cursorParam.length > OPAQUE_ID_MAX_LENGTH ||
            !IDENTIFIER_CHARSET_PATTERN.test(cursorParam) ||
            !CURSOR_UUID_PATTERN.test(cursorParam)
          ) {
            request.log.warn({ reason: "host_scores_cursor_malformed" }, "host scores rejected at cursor gate");
            return invalidRequest(reply);
          }
          afterId = cursorParam;
        }

        // 3. 租户子选闸(只能在凭证绑定集合内子选):不在集合内 ⇒ 404 同形
        //    (与"该租户不存在"不可区分;禁止由查询参数决定租户)。
        const tenantParam = query["tenantId"];
        let tenantIds: readonly string[];
        if (tenantParam === undefined) {
          tenantIds = deps.hostTenants;
        } else {
          if (typeof tenantParam !== "string" || !deps.hostTenants.includes(tenantParam)) {
            request.log.warn({ reason: "host_scores_tenant_not_bound" }, "host scores tenant sub-selection rejected");
            return notFound(reply);
          }
          tenantIds = [tenantParam];
        }

        try {
          // 4. 频率闸(D-API-125):触顶 429 冻结形态(字节级沿 D-API-50)。
          if (deps.hostScoresRateGate !== undefined) {
            await deps.hostScoresRateGate(rateAnchorTenant);
          }
          // 5. 只读读取(keyset 分页;至多 limit + 1 行 = 探测行)。
          const rows = await deps.scores.listScores({ tenantIds, afterId, limit });
          const hasMore = rows.length > limit;
          const page = hasMore ? rows.slice(0, limit) : rows;
          const last = page.at(-1);
          const body: HostScoresResponse = HostScoresResponseSchema.parse({
            items: page.map((row) => ({
              id: row.id,
              submissionId: row.submissionId,
              sessionId: row.sessionId,
              challengeId: row.challengeId,
              challengeVersion: row.challengeVersion,
              verdict: row.verdict,
              decidedAt: row.decidedAtEpochSeconds,
            })),
            nextCursor: hasMore && last !== undefined ? last.id : null,
          });
          return reply.code(200).send(body);
        } catch (error) {
          // 域异常统一映射(限流 429 / 存储不可用 503 等);未知异常上抛走
          // 500 兜底(含响应面自检失败,绝不下发非契约形态)。
          const mapped = mapDomainFailure(error);
          if (mapped !== null) {
            return reply.code(mapped.status).send(mapped.body);
          }
          throw error;
        }
      },
    });

    // 契约版本常量(HOST_SCORES_PROTOCOL_VERSION = 1,$id 命名空间承载)不进
    // 响应载荷(N-1 受理是路由级事实,回显即扩大探测面);限流 429 冻结形态
    // 经 mapDomainFailure(RateLimitExceeded)呈现,与 D-API-50 频率类共用同一
    // 冻结常量 RATE_LIMITED_ERROR(字节级一致)。
  };
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send(NOT_FOUND_ERROR);
}

function invalidRequest(reply: FastifyReply): FastifyReply {
  // 400 冻结形态取 error-mapping 的 VALIDATION_ERROR(= `invalid_input_format`
  // / "invalid request",与 WP-2 签发端点的 INVALID_REQUEST_ERROR 逐字节同形
  // ——同一 (400, code, message) 三元组在本进程只有一份真源)。
  return reply.code(400).send(VALIDATION_ERROR);
}

/**
 * 启动票据的签发端点与换票路由(WP-91 第二步;D-LT-1 ~ D-LT-5,
 * 语义权威 = `docs/contracts/启动票据协议.md`)。
 *
 * 两条路由,一条链:
 *
 *  1. `POST /auth/launch-tickets`(**平台后端 → 服务端**,服务端间):
 *     宿主凭证(`SESSION_API_HOST_BACKEND_TOKEN`,**复用** `hostBackendTokenMatches`
 *     的同一份实现,禁写第二套)⇒ 白名单租户派生 ⇒ 请求体契约校验 ⇒
 *     题目已发布校验 ⇒ 频率闸 ⇒ 生成票据 + 写 `launch:{jti}` ⇒ 201
 *     `{launchUrl, expiresAt}`(恰两键)。
 *
 *  2. `GET /app/c/:challengeId/:version?t=<ticket>`(**学习者浏览器 → 服务端**,
 *     页面服务端内完成,D-LT-2 方案 A「零 JS 换票」):`Sec-Fetch-Mode: navigate`
 *     ⇒ 票据存在未过期 ⇒ **Lua CAS 原子消费** ⇒ 路径字段与绑定逐字一致 ⇒
 *     签发起动授权凭证 + `Set-Cookie` ⇒ **302 到不含票据的干净路径**。
 *
 * **闸序(步骤 1)**:401(宿主凭证)→ 404(签发面未启用)→ 400(请求体)⇒
 * **429(频率)** ⇒ 404(题目不存在/未发布)→ 201。
 * **频率闸刻意排在题目查询之前**:题目查询是一次 PG 往返,把频率闸放在它后面
 * 等于让超额请求照样打到数据库(`host-scores-routes.ts` 的先例同此:
 * 频率闸是"昂贵操作前的最后一道闸")。两种 404 都返回**同一个** `NOT_FOUND_ERROR`
 * 常量 ⇒ 「白名单外 / 题目不存在 / 签发面未启用」逐字节同形(机检 ⑥)。
 *
 * **换票的 401 三态逐字节同形(机检 ③)**:过期 / 已消费 / 不存在**全部**由
 * `LaunchTicketStore.consume` 返回 `null` 表达(端口面就不区分),故它们必然
 * 走同一个 `sendAuthFailed` —— 这不是"小心地写成一样",而是**结构上没有第二个
 * 出口**。`Sec-Fetch-Mode` 不合格与票据形态不合格也走同一出口(更严的同形)。
 *
 * **审计零新增(D-LT-5 第 7 条)**:本文件**不写 `audit_log`**(十值封闭集不动),
 * 可审计性由**受控日志**承载(拒绝原因进 `reason` 字段;票据与凭证**永不**入日志)。
 */
import {
  LAUNCH_TICKET_ISSUANCE_ROUTE,
  LAUNCH_TICKET_REDEEM_PATH_TEMPLATE,
  LaunchTicketRequestSchema,
  LaunchTicketResponseSchema,
} from "@stackmaster/protocol";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";

import {
  AUTH_FAILED_ERROR,
  AUTH_FAILED_HTTP_STATUS,
  INVALID_REQUEST_ERROR,
  INVALID_REQUEST_HTTP_STATUS,
  SESSION_CREDENTIAL_COOKIE_PATH,
  issueLaunchGrant,
  setLaunchGrantCookie,
  type LaunchGrantStore,
  type TokenSigner,
} from "../auth/index.js";
import { hostBackendTokenMatches } from "../auth/plugin.js";
import type { ChallengeRegistry, LaunchTicketStore } from "../persistence/ports.js";
import { NOT_FOUND_ERROR, mapDomainFailure } from "../routes/error-mapping.js";
import { buildLaunchUrl, launchRedeemPath, launchTicketFromQuery } from "./launch-url.js";
import { generateLaunchTicketToken, isLaunchTicketTokenShape } from "./ticket-token.js";

/**
 * 请求体内字符串字段的长度护栏(字节 / 字符数;超长即 **400**)。
 *
 * **为什么需要它**:`routerOptions.maxParamLength = 256` 只覆盖**路径参数**,
 * 对请求体无效;而 Fastify 的 `bodyLimit` 是 64 KiB 量级,意味着一个 60 KiB 的
 * `challengeId` 会被完整解析后再交给 Zod。本护栏在 Schema 之前先按长度砍掉
 * 明显越界的形态(与 Zod 的 `OpaqueIdSchema.max` **双保险**:这里是粗闸,
 * 那里是精确闸;两者都不通过 = 400)。
 */
const MAX_BODY_FIELD_LENGTH = 256;

export interface LaunchRouteDeps {
  /** 宿主后端共享凭证(bearer;常数时间比较)。 */
  readonly hostBackendToken: string;
  /**
   * 宿主凭证绑定的租户白名单(已字典序规范化;**空数组 ⇒ 签发面整体 404
   * 同形 fail-closed**)。锚租户 = `hostTenants[0]`。
   */
  readonly hostTenants: readonly string[];
  /**
   * 公开来源(页面与 API 同源;`null` = 该部署未启用签发面 ⇒ 404 同形)。
   * `launchUrl` 的绝对地址**只**由此派生,永不采信请求头。
   */
  readonly publicOrigin: string | null;
  /** 启动面占位主体(D-LT-5.6;写进授权凭证 claims 的 `userId`)。 */
  readonly launchUserId: string;
  /** 票据与授权凭证的 TTL(秒;同一配置族)。 */
  readonly launchTicketTtlSeconds: number;
  /** 题目登记查询(**跨租户公开面**;`findPublishedChallengeVersion`)。 */
  readonly registry: Pick<ChallengeRegistry, "findPublishedChallengeVersion">;
  /** `launch:{jti}` 键域端口(CAS 单次消费)。 */
  readonly ticketStore: LaunchTicketStore;
  /** `launchGrant:{jti}` 键域端口(GETDEL 单次消费)。 */
  readonly grantStore: LaunchGrantStore;
  readonly signer: TokenSigner;
  readonly logger: Logger;
  readonly nodeEnv: "development" | "test" | "production";
  /** 授权凭证 Cookie Path(装配参数;缺省 `/sessions`)。 */
  readonly launchGrantCookiePath?: string;
  /**
   * 签发频率闸(D-LT-2;`rate:{锚租户}:launch_tickets` 固定窗口;缺省未注入 =
   * 放行)。触顶由既有唯一出口抛 `RateLimitExceeded` ⇒ 429 冻结形态。
   */
  readonly launchTicketRateGate?: (anchorTenantId: string) => Promise<void>;
  readonly now?: () => number;
}

function sendAuthFailed(reply: FastifyReply): FastifyReply {
  return reply.code(AUTH_FAILED_HTTP_STATUS).send(AUTH_FAILED_ERROR);
}

function sendNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send(NOT_FOUND_ERROR);
}

function sendInvalidRequest(reply: FastifyReply): FastifyReply {
  return reply.code(INVALID_REQUEST_HTTP_STATUS).send(INVALID_REQUEST_ERROR);
}

/**
 * 请求体的**粗形态闸**(在 Schema 之前):非对象 / 超长字符串 ⇒ false。
 *
 * 只做"能不能继续"的判定,不做字段语义判定(Schema 才是精确闸)—— 两道闸
 * 的职责分工写在这里是为了避免"到底谁负责拒"的含糊。
 */
function bodyWithinLengthGuard(body: unknown): boolean {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }
  for (const value of Object.values(body as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > MAX_BODY_FIELD_LENGTH) {
      return false;
    }
    if (typeof value === "object" && value !== null) {
      // 嵌套对象不在本契约的表达范围内(strictObject 恰两键)⇒ 提前拒。
      return false;
    }
  }
  return true;
}

export function buildLaunchRoutes(deps: LaunchRouteDeps): FastifyPluginAsync {
  const now = deps.now ?? Date.now;
  // 锚租户 = 白名单字典序最小项(配置规范化时已排序,见 config.ts splitHostTenants)。
  const anchorTenantId = deps.hostTenants[0];

  return async function launchRoutes(fastify): Promise<void> {
    // ── POST /auth/launch-tickets(签发)────────────────────────────────
    fastify.post(LAUNCH_TICKET_ISSUANCE_ROUTE, async (request, reply) => {
      // 1. 宿主凭证认证(先于一切请求体检查:未认证方不得探测请求体字段
      //    有效性 —— 401 / 400 不给探测面)。
      if (!hostBackendTokenMatches(request.headers.authorization, deps.hostBackendToken)) {
        request.log.warn({ reason: "host_backend_token_invalid" }, "launch ticket issuance rejected");
        return sendAuthFailed(reply);
      }

      // 2. 签发面未启用 ⇒ **404 同形**(与"题目不存在"逐字节一致)。
      //    两种成因分开记日志(运维可诊断),但响应面刻意不分:
      //    白名单为空 / 未配公开来源都是**部署形态**,不该给调用方探测信号。
      if (anchorTenantId === undefined || deps.hostTenants.length === 0) {
        request.log.warn({ reason: "launch_surface_unbound_tenants" }, "launch ticket issuance disabled");
        return sendNotFound(reply);
      }
      if (deps.publicOrigin === null) {
        request.log.warn({ reason: "launch_surface_unbound_origin" }, "launch ticket issuance disabled");
        return sendNotFound(reply);
      }

      // 3. 请求体:长度粗闸 → 冻结 Schema 精确闸(strictObject 恰两键)。
      if (!bodyWithinLengthGuard(request.body)) {
        request.log.warn({ reason: "launch_body_guard" }, "launch ticket issuance rejected");
        return sendInvalidRequest(reply);
      }
      const parsed = LaunchTicketRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        request.log.warn(
          { reason: "invalid_launch_body", issueCount: parsed.error.issues.length },
          "launch ticket issuance rejected",
        );
        return sendInvalidRequest(reply);
      }

      // ── 4~7:频率闸 → 题目校验 → 写绑定 → 201 ────────────────────────────
      //
      // **整段包在既有域失败映射里**(`mapDomainFailure`,与
      // `host-scores-routes.ts` 同形):这是「沿既有唯一出口」的**执行面**,
      // 不是注释里的承诺 ——
      //  - 频率闸触顶抛 `RateLimitExceeded` ⇒ **429 + 冻结 `budget_exhausted`**
      //    (与 D-API-50 / D-API-125 **字节级一致**,零新增形态);
      //  - 存储不可用经适配器翻译为 `PersistenceError("store_unavailable")`
      //    ⇒ **503 `storage unavailable`**(fail-closed,不自造错误形态)。
      // 若不在此映射,两者都会冒泡成框架级 500 —— **实测踩过**
      // (首版漏了 try/catch,限流用例拿到 500 而不是 429)。
      try {
        // 4. 频率闸(排在题目查询**之前**:题目查询是一次 PG 往返,把闸放在它
        //    后面等于让超额请求照样打到数据库)。
        if (deps.launchTicketRateGate !== undefined) {
          await deps.launchTicketRateGate(anchorTenantId);
        }

        // 5. 题目已发布校验(**跨租户公开面**:题目是公开导航信息)。
        //    null ⇒ 404 同形。⚠ **不走** create_session 的 422 映射:那是
        //    "会话创建期题目装载失败"的语义,与"签发期题目不存在"不同族。
        const published = await deps.registry.findPublishedChallengeVersion(
          parsed.data.challengeId,
          parsed.data.version,
        );
        if (published === null) {
          request.log.warn({ reason: "launch_challenge_not_published" }, "launch ticket issuance rejected");
          return sendNotFound(reply);
        }

        // 6. 生成票据 + 写绑定记录。**租户只在这里派生**:宿主凭证 × 白名单
        //    ⇒ URL / body 参数**结构性**不参与(请求体连 tenantId 位都没有)。
        const ticket = generateLaunchTicketToken();
        const nowMs = now();
        const expiresAt = Math.floor(nowMs / 1000) + deps.launchTicketTtlSeconds;
        await deps.ticketStore.put(
          ticket,
          {
            tenantId: anchorTenantId,
            challengeId: parsed.data.challengeId,
            version: parsed.data.version,
            expiresAt,
          },
          deps.launchTicketTtlSeconds,
        );

        request.log.info(
          { challengeId: parsed.data.challengeId, version: parsed.data.version },
          "launch ticket issued",
        );

        // 7. 响应恰两键(`launchUrl` / `expiresAt`);**票据值只在 launchUrl 内**
        //    ——响应不另回票据字段(D-LT-1:多回一个字段 = 把同一个秘密复制到
        //    第二个可被日志与前端缓存捕获的位置)。
        const body = LaunchTicketResponseSchema.parse({
          launchUrl: buildLaunchUrl(
            deps.publicOrigin,
            parsed.data.challengeId,
            parsed.data.version,
            ticket,
          ),
          expiresAt,
        });
        return reply.code(201).send(body);
      } catch (error) {
        const mapped = mapDomainFailure(error);
        if (mapped !== null) {
          request.log.warn({ reason: "launch_issuance_domain_failure" }, "launch ticket issuance failed");
          return reply.code(mapped.status).send(mapped.body);
        }
        throw error;
      }
    });

    // ── GET /app/c/:challengeId/:version?t=<ticket>(换票)────────────────
    fastify.get(LAUNCH_TICKET_REDEEM_PATH_TEMPLATE, async (request, reply) => {
      // D-LT-3:D-LT-4:换票响应与页面响应**必须**带 no-store 与 no-referrer。
      // 在**所有**返回路径上先设好(含 401)—— 失败响应同样不该被缓存或
      // 经 Referer 外传(它同样能证明"这个地址被访问过")。
      void reply.header("Cache-Control", "no-store");
      void reply.header("Referrer-Policy", "no-referrer");

      // ⓪ `Sec-Fetch-Mode: navigate` 校验(纯请求头,不需 JS):拒绝子资源 /
      //    嵌入式换票(D-LT-2「会话固定缓解」第 4 项)。
      const secFetchMode = request.headers["sec-fetch-mode"];
      if (secFetchMode !== "navigate") {
        request.log.warn({ reason: "redeem_not_navigate" }, "launch ticket redemption rejected");
        return sendAuthFailed(reply);
      }

      // ① 票据形态(纯函数,不触碰存储):非字符串 / 空 / 超粗闸 / 非 base64url
      //    一律拒绝。
      const ticket = launchTicketFromQuery(request.query);
      if (ticket === undefined || !isLaunchTicketTokenShape(ticket)) {
        request.log.warn({ reason: "redeem_ticket_malformed" }, "launch ticket redemption rejected");
        return sendAuthFailed(reply);
      }

      const params = request.params as { challengeId?: string; version?: string };
      const challengeId = params.challengeId ?? "";
      const version = params.version ?? "";

      // ②③④ 存在且未过期 + 单次原子消费 + 绑定逐字一致 —— **一个** CAS 调用
      //      完成(失败不得留下半态)。返回 null 覆盖:不存在 / 已消费 /
      //      已过期 / 绑定不符四种形态,且**同形** ⇒ 三态逐字节一致是结构性
      //      结果,不是靠三处分别写对。
      const binding = await deps.ticketStore.consume(ticket, { challengeId, version });
      if (binding === null) {
        request.log.warn({ reason: "redeem_ticket_invalid" }, "launch ticket redemption rejected");
        return sendAuthFailed(reply);
      }

      // ⑤ 签发起动授权凭证(**不建会话**、**不调** `issueSessionCredential`,
      //    D-LT-5 5b —— 候选 C「换票即建会话」已被否决)。
      const issued = await issueLaunchGrant(
        {
          signer: deps.signer,
          grantStore: deps.grantStore,
          ttlSeconds: deps.launchTicketTtlSeconds,
          now,
        },
        {
          tenantId: binding.tenantId,
          userId: deps.launchUserId,
          challengeId: binding.challengeId,
          challengeVersion: binding.version,
        },
      );
      setLaunchGrantCookie(
        reply,
        issued.token,
        issued.ttlSeconds,
        deps.nodeEnv,
        deps.launchGrantCookiePath ?? SESSION_CREDENTIAL_COOKIE_PATH,
      );

      request.log.info(
        { challengeId: binding.challengeId, version: binding.version },
        "launch ticket redeemed",
      );

      // ⑥ 302 到**不含票据**的干净路径。Location 由 `launchRedeemPath` 产出,
      //    该函数结构上无法表达查询串 ⇒「忘了抹票据」不可表达。
      return reply.redirect(launchRedeemPath(binding.challengeId, binding.version), 302);
    });
  };
}

/** 类型面再导出(装配侧免于直接依赖 fastify 类型)。 */
export type { FastifyPluginAsync, FastifyRequest };

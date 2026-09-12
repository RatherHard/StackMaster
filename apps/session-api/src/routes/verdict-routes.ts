/**
 * 裁决呈现路由(阶段六 WP-63;D-API-83 / D-API-84;任务分解 §二 WP-63 第 1 条)。
 *
 * `GET /verdicts/:submissionId` —— WP-60 定案的裁决呈现通道 (a) REST 查询面
 * 的实现落位(呈现链路 = session-api 读裁决域 PG `verdicts` 表;verifier
 * 信任域 4 零浏览器可达路由面)。纪律:
 *
 *  - **认证(会话凭证同模型)**:复用 `buildCredentialPreHandler` / 
 *    `authenticateSessionCredential` 同一入口,Cookie 呈递;GET 非变更方法
 *    不走 CSRF 闸(D-API-17 同纪律)。会话锚不在路径而在凭证据点——定位链
 *    = `verdicts` → `submissions`(同 submission_id)→ 会话归属(tenantId
 *    与凭证据点全等 + sessionId 与凭证据点全等;查询层租户校验强制,D-API-20),
 *    任一环不符 = 404 + 冻结 `PublicError`("resource not found")——跨租户、
 *    跨会话与"不存在"同形态(防枚举,D-API-32 会话定位失败行同形);
 *  - **路径参数**:submissionId 走冻结标识符字符集校验(D-API-76 同款先例:
 *    GET 无请求体,路径参数字符集闸;不合规 = 404 同形,防枚举);
 *  - **重询限流(D-API-84)**:`rate:{tenant}:{user}:verdict` 维度子键固定
 *    窗口,触顶 = 429 + 冻结形态 `{code:"budget_exhausted", message:"rate
 *    limit exceeded"}`——与 D-API-50 频率类冻结形态字节级一致(同一冻结
 *    常量 `RATE_LIMITED_ERROR`),零限流器状态透出;
 *  - **载荷上限面**:pending = 恒定三字段 `{submissionId, revision, status}`;
 *    verdicted = 五字段(`verdict` 11 值字面 + `decidedAt` epoch 秒)。
 *    响应发送前过冻结 `VerdictQueryResponseSchema` 自检(漂移即 500 兜底,
 *    绝不下发非契约形态;落库字面在 11 值外同走此兜底);`verdicts.detail`
 *    与 `submissions.reference` 在本路由零读取零下发(SERVER_ONLY,D-API-96);
 *  - **裁决不可用 ≠ 判负(fail-closed,D-API-84)**:run failed / 队列积压 /
 *    裁决域不可用时,裁决未落库 = 确定性 pending;裁决域存储不可用 = 503
 *    `store_unavailable` 同形——绝不以 `timeout` / `wrong_answer` 类兜底判负。
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  IDENTIFIER_CHARSET_PATTERN,
  OPAQUE_ID_MAX_LENGTH,
  VerdictQueryResponseSchema,
} from "@stackmaster/protocol";

import {
  AUTH_FAILED_ERROR,
  AUTH_FAILED_HTTP_STATUS,
  buildCredentialPreHandler,
  type TokenSigner,
} from "../auth/index.js";
import type { CredentialRevocationStore } from "../auth/ports.js";
import type { VerdictQueryStore } from "../persistence/index.js";
import { mapDomainFailure, NOT_FOUND_ERROR } from "./error-mapping.js";

/** 裁决呈现路由表(D-API-83 定案路由;D-API-97 实现面登记)。 */
export const VERDICT_ROUTES = {
  verdict: "/verdicts/:submissionId",
} as const;

/** submissionId 路径参数上限(冻结标识符字符集;服务端签发 UUID 天然满足)。 */
const SUBMISSION_ID_MAX_LENGTH = OPAQUE_ID_MAX_LENGTH;

export interface VerdictRouteDeps {
  // ── 认证面(与生命周期路由同源实例;runtime 装配注入)──
  readonly signer: TokenSigner;
  readonly revocationStore: CredentialRevocationStore;
  readonly allowedOrigins: readonly string[];
  /** 裁决呈现面读取端口(只读;零裁决写入面——裁决唯一出处 = verifier)。 */
  readonly verdicts: VerdictQueryStore;
  /**
   * 裁决重询频率闸(WP-63,D-API-84;`rate:{tenant}:{user}:verdict` 固定
   * 窗口;缺省未注入 = 放行,与 requestRateGate / submitRateGate 同装配纪律)。
   */
  readonly verdictRateGate?: (tenantId: string, userId: string) => Promise<void>;
  readonly now?: () => number;
}

/**
 * submissionId 路径参数字符集校验(D-API-76 同款先例:冻结标识符字符集,
 * 禁路径穿越与控制字符)。不合规即 404 同形(与不存在同响应,防枚举)。
 */
export function isVerdictSubmissionIdWellFormed(submissionId: string): boolean {
  return (
    submissionId.length > 0 &&
    submissionId.length <= SUBMISSION_ID_MAX_LENGTH &&
    IDENTIFIER_CHARSET_PATTERN.test(submissionId)
  );
}

export function buildVerdictRoutes(deps: VerdictRouteDeps): FastifyPluginAsync {
  return async function verdictRoutes(fastify): Promise<void> {
    // 凭证 preHandler(会话凭证同模型,D-API-83):无 getSessionAnchor——
    // 路径不携带会话标识(D-API-1 纪律),会话归属由定位链按凭证据点强制。
    const requireSessionCredential = buildCredentialPreHandler(
      {
        signer: deps.signer,
        revocationStore: deps.revocationStore,
        allowedOrigins: deps.allowedOrigins,
        ...(deps.now === undefined ? {} : { now: deps.now }),
      },
      {},
    );

    fastify.get(VERDICT_ROUTES.verdict, {
      preHandler: requireSessionCredential,
      handler: async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
        const auth = request.sessionAuth;
        if (auth === null) {
          return reply.code(AUTH_FAILED_HTTP_STATUS).send(AUTH_FAILED_ERROR);
        }
        const { submissionId } = request.params as { submissionId: string };
        // 1. 路径参数字符集闸:不合规 = 404 同形(防枚举,D-API-76 先例)。
        if (!isVerdictSubmissionIdWellFormed(submissionId)) {
          request.log.warn({ reason: "verdict_param_rejected" }, "verdict query rejected at param gate");
          return notFound(reply);
        }
        try {
          // 2. 重询限流(D-API-84):触顶 429 冻结形态(字节级沿 D-API-50)。
          if (deps.verdictRateGate !== undefined) {
            await deps.verdictRateGate(auth.claims.tenantId, auth.claims.userId);
          }
          // 3. 定位链:submissions 行按 (id, tenantId, sessionId) 三条件定位。
          const submission = await deps.verdicts.findSubmissionForVerdict(
            submissionId,
            auth.claims.tenantId,
            auth.claims.sessionId,
          );
          if (submission === null) {
            // 跨租户 / 跨会话 / 不存在同形态(防枚举)。
            return notFound(reply);
          }
          // 4. 裁决行读取(未落库 = null → 恒定 pending,fail-closed)。
          const verdict = await deps.verdicts.findVerdictBySubmissionId(submissionId);
          const payload = verdict === null
            ? { submissionId, revision: submission.revision, status: "pending" as const }
            : {
                submissionId,
                revision: submission.revision,
                status: "verdicted" as const,
                verdict: verdict.verdict,
                decidedAt: verdict.decidedAtEpochSeconds,
              };
          // 5. 响应面冻结自检:漂移(含落库字面在 11 值外)即 500 兜底。
          const body = VerdictQueryResponseSchema.parse(payload);
          return reply.code(200).send(body);
        } catch (error) {
          // 域异常统一映射(限流 429 / 存储不可用 503 等);未知异常上抛走
          // 500 兜底(与 commandHandler 同纪律)。
          const mapped = mapDomainFailure(error);
          if (mapped !== null) {
            return reply.code(mapped.status).send(mapped.body);
          }
          throw error;
        }
      },
    });

    // 契约版本常量(D-API-86:VERDICT_CHANNEL_PROTOCOL_VERSION = 1,$id
    // 命名空间承载)不进响应载荷(N-1 受理是路由级事实,回显即扩大探测面);
    // 重询限流的 429 冻结形态经 mapDomainFailure(RateLimitExceeded)呈现,
    // 与 D-API-50 频率类共用同一冻结常量 RATE_LIMITED_ERROR(字节级一致)。
  };
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send(NOT_FOUND_ERROR);
}

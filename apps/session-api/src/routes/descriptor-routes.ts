/**
 * 公开描述包下发通道(阶段五 WP-50;任务分解 §二 WP-50 第 3 条;D-API-76;
 * 校验清单 M2 服务端面;D-API-66 的阶段五承接)。
 *
 * 路由形态:**`GET /descriptors/:challengeId/:version`**(签名 URL 与端点
 * 二选一的定案 = 端点;理由与替代路线的放弃理由记 D-API-76)。challengeId /
 * version 均非会话标识(无权限语义的公开内容定位符),可入路径——与
 * D-API-1"路径不携带会话标识"的纪律不冲突。
 *
 * 认证姿态(定案,记 D-API-76):公开描述包是**公开内容**(设计上可 CDN
 * 分发,8.3),无凭证 GET;零租户、零会话、零凭证面。CORS 沿用全局精确
 * 来源白名单(SESSION_API_ALLOWED_ORIGINS,D-API-16;GET 在既有方法集内)
 * ——浏览器面插件 iframe 跨源获取需要 ACAO;白名单缺省(空表)= 跨源面
 * 全拦(fail-closed 默认),同源调用不受影响。不设租户限流(rate:{tenant}:{user}
 * 无身份锚可计量;滥用防线 = CDN 期边缘限流 + 本端点响应护栏,D-API-76)。
 *
 * 服务序(每步确定性拒绝,响应面恒为冻结 `PublicError`,D-API-32 同形):
 *   1. 参数字符集校验(challengeId 冻结标识符字符集、version 语义化版本
 *      字符集,禁路径穿越)→ 不合即 404 + `invalid_input_format` /
 *      "resource not found"(与路由级 404 同形,防枚举);
 *   2. 注册表查版本行(公开面跨租户读取,findPublishedChallengeVersion)
 *      → 未登记 404 同形(SSRF 纪律:只接受已登记派生获取路径,拒任意 URL);
 *   3. 对象存储取回(`public-descriptors` 桶,复用既有 ChallengeBundleStore
 *      端口,零扩展)→ 行在而对象缺失 = 服务端数据一致性事故 → 422 +
 *      `internal_error` / "challenge invalid"(与 D-API-32 challenge_invalid
 *      行"双包缺失"同形,防题目枚举);
 *   4. 摘要复算:对桶内原始字节复算 SHA-256,与登记摘要
 *      (challenge_versions.public_descriptor_sha256,受 Ed25519 登记签名
 *      担保,D-API-23)比对 → 不符 422 challenge invalid 同形(红灯语料:
 *      摘要篡改,见 test/routes/descriptor-routes.test.ts);
 *   5. 响应护栏(8.3 纪律,数值定案记 D-API-76):响应体字节上限
 *      (SESSION_API_MAX_DESCRIPTOR_BYTES,解析前强制)→ JSON 解析 →
 *      嵌套深度 / 数组长度 / 字符串长度巡检(与 D-API-31 请求护栏同值
 *      装配)→ 越限 422 challenge invalid 同形(超限载荷不可能通过登记
 *      摘要校验,同形呈现防题目枚举);
 *   6. 200 返回描述包 JSON(`application/json`;体 = 桶内原始字节,逐字节
 *      确定性,I-4)。ETag = 登记摘要(实体标签形态),为 CDN 期条件请求
 *      与缓存复用铺路(本阶段不做 If-None-Match 协商;版本不可变语义由
 *      Cache-Control 表达)。
 *
 * 发布清单契约(Q2,记 D-API-76):不立独立清单契约——发布清单(8.3
 * "发布清单应有内容哈希或签名")的语义由"challenge_versions 行内双包
 * SHA-256 摘要 + 端点取回后动态复算比对"承载;摘要的真实性上游由登记
 * 签名(Ed25519 over registrationSignatureBasis,含双摘要)担保。
 *
 * 零秘密面自证:响应体只含公开 Schema 字段(登记管线上游担保形态合法性;
 * 本端点担保完整性(摘要)与尺寸护栏;客户端侧 WP-54 另有哈希校验 +
 * 尺寸护栏双闸)。响应不回显任何内部对象名、租户、签名材料。
 */
import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  IDENTIFIER_CHARSET_PATTERN,
  OPAQUE_ID_MAX_LENGTH,
  type PublicError,
} from "@stackmaster/protocol";
import { CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE } from "@stackmaster/protocol/server-only";
import type { ChallengeBundleStore, ChallengeRegistry } from "../persistence/index.js";
import { PersistenceError } from "../persistence/index.js";
import {
  CHALLENGE_INVALID_ERROR,
  NOT_FOUND_ERROR,
} from "./error-mapping.js";
import {
  assertRequestWithinLimits,
  GUARD_MAX_ARRAY_LENGTH,
  GUARD_MAX_STRING_LENGTH,
  type RequestGuardLimits,
} from "./request-guards.js";

/** 公开描述包下发路由表(D-API-1 阶段五 WP-50 增补行)。 */
export const DESCRIPTOR_ROUTES = {
  /** `:challengeId` / `:version` 均为公开内容定位符(非会话标识)。 */
  descriptor: "/descriptors/:challengeId/:version",
} as const;

/** challengeId 路径参数上限(与对象命名约束同值:1–128,冻结标识符字符集)。 */
const CHALLENGE_ID_MAX_LENGTH = OPAQUE_ID_MAX_LENGTH;
/** version 路径参数上限(与对象命名约束同值;取值域另受 semver 模式约束)。 */
const VERSION_MAX_LENGTH = OPAQUE_ID_MAX_LENGTH;
/** 题目内容版本模式(与 embed token claims / 登记路径同一冻结字面量)。 */
const VERSION_PATTERN = new RegExp(CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE);

export interface DescriptorRouteDeps {
  /** 题目注册表(公开面读取:findPublishedChallengeVersion,无租户过滤)。 */
  readonly registry: Pick<ChallengeRegistry, "findPublishedChallengeVersion">;
  /** 题目双包对象存储(公开桶读取:getPublic;复用既有端口,零扩展)。 */
  readonly bundles: Pick<ChallengeBundleStore, "getPublic">;
  /** 响应体字节上限(config.maxDescriptorBytes;D-API-76 配置键天花板)。 */
  readonly maxDescriptorBytes: number;
  /** JSON 嵌套深度上限(与 D-API-31 请求护栏同值装配)。 */
  readonly maxJsonDepth: number;
}

/** 参数校验失败(细节只进受控日志;响应恒 404 同形)。 */
export class DescriptorParamRejected extends Error {
  readonly field: "challengeId" | "version";

  constructor(field: "challengeId" | "version", reason: string) {
    super(`descriptor path parameter rejected (${field}): ${reason}`);
    this.name = "DescriptorParamRejected";
    this.field = field;
  }
}

/**
 * 路径参数字符集校验(D-API-23 同锚:challengeId 走冻结标识符字符集,
 * version 走 semver 字符集;显式禁路径穿越序列)。不合即抛
 * DescriptorParamRejected → 404 同形(与未登记同响应,防枚举)。
 */
export function assertDescriptorParams(
  challengeId: string,
  version: string,
): void {
  if (
    challengeId.length === 0 ||
    challengeId.length > CHALLENGE_ID_MAX_LENGTH ||
    !IDENTIFIER_CHARSET_PATTERN.test(challengeId)
  ) {
    throw new DescriptorParamRejected("challengeId", "不满足冻结标识符字符集");
  }
  if (
    version.length === 0 ||
    version.length > VERSION_MAX_LENGTH ||
    !VERSION_PATTERN.test(version) ||
    version.includes("..")
  ) {
    throw new DescriptorParamRejected("version", "不满足题目版本字符集(禁路径穿越)");
  }
}

/** 下发路径的确定性失败(调用方以冻结 PublicError 形态呈现)。 */
export class DescriptorContentRejected extends Error {
  constructor(reason: string) {
    super(`descriptor content rejected: ${reason}`);
    this.name = "DescriptorContentRejected";
  }
}

function sendFailure(reply: FastifyReply, status: number, body: PublicError): FastifyReply {
  return reply.code(status).send(body);
}

export function buildDescriptorRoutes(deps: DescriptorRouteDeps): FastifyPluginAsync {
  const guardLimits: RequestGuardLimits = {
    maxJsonDepth: deps.maxJsonDepth,
    maxArrayLength: GUARD_MAX_ARRAY_LENGTH,
    maxStringLength: GUARD_MAX_STRING_LENGTH,
  };

  return async function descriptorRoutes(fastify): Promise<void> {
    fastify.get(DESCRIPTOR_ROUTES.descriptor, async (request: FastifyRequest, reply: FastifyReply) => {
      const { challengeId, version } = request.params as {
        challengeId: string;
        version: string;
      };

      // 1. 参数字符集校验(禁路径穿越;失败 = 404 与未登记同形,防枚举)。
      try {
        assertDescriptorParams(challengeId, version);
      } catch (error) {
        if (error instanceof DescriptorParamRejected) {
          request.log.warn(
            { reason: "descriptor_param_rejected", field: error.field },
            "descriptor request rejected at parameter layer",
          );
          return sendFailure(reply, 404, NOT_FOUND_ERROR);
        }
        throw error;
      }

      // 2. 注册表查版本行(只接受已登记派生获取路径,SSRF 纪律)。
      let row: Awaited<ReturnType<typeof deps.registry.findPublishedChallengeVersion>>;
      try {
        row = await deps.registry.findPublishedChallengeVersion(challengeId, version);
      } catch (error) {
        if (error instanceof PersistenceError) {
          request.log.error({ err: error }, "descriptor registry lookup failed");
          throw error; // 503 由兜底矩阵呈现(D-API-32 存储不可用行)
        }
        throw error;
      }
      if (row === null) {
        request.log.warn(
          { reason: "descriptor_version_unregistered" },
          "descriptor request rejected: version not registered",
        );
        return sendFailure(reply, 404, NOT_FOUND_ERROR);
      }

      // 3. 对象存储取回(公开桶;行在而对象缺失 = 服务端一致性事故)。
      let content: Uint8Array | null;
      try {
        content = await deps.bundles.getPublic(challengeId, version);
      } catch (error) {
        if (error instanceof PersistenceError) {
          request.log.error({ err: error }, "descriptor object retrieval failed");
          throw error; // 503(D-API-32 存储不可用行)
        }
        throw error;
      }
      if (content === null) {
        request.log.error(
          { reason: "descriptor_object_missing" },
          "descriptor object missing for registered version",
        );
        return sendFailure(reply, 422, CHALLENGE_INVALID_ERROR);
      }

      // 4. 响应体字节护栏(解析前强制;超限 = 桶内对象与登记内容不符)。
      if (content.byteLength > deps.maxDescriptorBytes) {
        request.log.warn(
          { reason: "descriptor_bytes_over_limit" },
          "descriptor rejected at byte-limit guard",
        );
        return sendFailure(reply, 422, CHALLENGE_INVALID_ERROR);
      }

      // 5. 摘要复算(对桶内原始字节;与登记摘要比对,不符即拒)。
      const computedSha256 = createHash("sha256").update(content).digest("hex");
      if (computedSha256 !== row.publicDescriptorSha256.toLowerCase()) {
        request.log.warn(
          { reason: "descriptor_digest_mismatch" },
          "descriptor rejected: digest mismatch against registered row",
        );
        return sendFailure(reply, 422, CHALLENGE_INVALID_ERROR);
      }

      // 6. JSON 解析 + 结构护栏(嵌套深度 / 数组长度 / 字符串长度;与
      //    D-API-31 请求护栏同值装配。置于摘要比对之后:超限载荷必先过
      //    完整性闸,两闸拒绝面同形,顺序只影响受控日志归因)。
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(content).toString("utf8"));
      } catch {
        request.log.warn(
          { reason: "descriptor_not_json" },
          "descriptor rejected: stored object is not valid JSON",
        );
        return sendFailure(reply, 422, CHALLENGE_INVALID_ERROR);
      }
      try {
        assertRequestWithinLimits(parsed, guardLimits);
      } catch (error) {
        request.log.warn(
          { reason: "descriptor_guard_violation", dimension: (error as { dimension?: string }).dimension },
          "descriptor rejected at structural guard",
        );
        return sendFailure(reply, 422, CHALLENGE_INVALID_ERROR);
      }

      // 7. 200 返回描述包 JSON(体 = 桶内原始字节,逐字节确定性,I-4);
      //    ETag = 登记摘要(CDN 期条件请求铺路),版本不可变 → immutable。
      const etag = `"${row.publicDescriptorSha256.toLowerCase()}"`;
      void reply
        .code(200)
        .header("Content-Type", "application/json; charset=utf-8")
        .header("ETag", etag)
        .header("Cache-Control", "public, max-age=3600, immutable");
      return reply.send(Buffer.from(content));
    });
  };
}

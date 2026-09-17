/**
 * 管理面凭证校验(D-MP-5 分支 A;独立凭证硬约束,D-API-134)。
 *
 * 独立性(硬约束,`docs/项目计划书.md:807`):
 *  - 凭证值来自 `ADMIN_CREDENTIAL_SHA256`(仅 `ADMIN_` 命名空间),
 *    **不使用**会话凭证 / 会话签名密钥(`SESSION_*`),**不使用**宿主后端
 *    共享令牌(`SESSION_API_HOST_BACKEND_TOKEN`),**不使用** verifier 面
 *    任何材料——管理面凭证与会话面、宿主面、裁决面的凭证材料零交集。
 *  - 呈递方式 = `Authorization: Bearer <凭证>` 请求头:凭证**不入 URL query**、
 *    不入 Cookie(`:807`「不得使用长期 URL 参数」;不用 Cookie 也就没有 CSRF 面),
 *    不写日志、不进指标标签。
 *
 * 比较形态 = 双侧 sha256 + `timingSafeEqual`(session-api
 * `hostBackendTokenMatches` 同款):长度差异被折叠进摘要比较,长度侧信道
 * 零透出;配置侧只驻留摘要,进程内存里不存在明文凭证。
 *
 * 拒绝面 = 401 + 冻结 `PublicError`(D-API-14 统一形态,复用 protocol 的
 * `PublicErrorSchema`,不写第二套错误契约):缺失 / 畸形 / 错误 / 过期形态
 * 全部同状态同码同文案,细节只进受控日志。
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { PublicErrorSchema, type PublicError } from "@stackmaster/protocol";

/** Authorization 头前缀(与会话 / 宿主面同一形态,凭证值域不同)。 */
const BEARER_PREFIX = "Bearer ";

/** 管理面凭证拒绝的 HTTP 状态(D-API-14 统一失败面)。 */
export const ADMIN_UNAUTHORIZED_STATUS = 401;

/** 管理面凭证拒绝的冻结响应体(D-API-14:401 + 单码 + 静态文案,零枚举面)。 */
export const ADMIN_UNAUTHORIZED_ERROR: PublicError = PublicErrorSchema.parse({
  code: "invalid_input_format",
  message: "authentication failed",
});

/**
 * 管理面凭证校验器(构造期只接受 sha256 摘要;明文凭证永不进入本进程)。
 */
export class AdminCredentialVerifier {
  readonly #expectedDigest: Buffer;

  /**
   * @param credentialSha256 管理面凭证的 sha256 摘要(小写十六进制,
   *   已被启动配置闸校验过形态)。
   */
  constructor(credentialSha256: string) {
    this.#expectedDigest = Buffer.from(credentialSha256, "hex");
  }

  /**
   * 校验 `Authorization` 头。返回布尔值——**不返回拒绝原因**(原因分类
   * 是枚举通道;受控日志只记无凭证内容的事实)。
   */
  verify(authorization: unknown): boolean {
    if (typeof authorization !== "string" || !authorization.startsWith(BEARER_PREFIX)) {
      return false;
    }
    const presented = authorization.slice(BEARER_PREFIX.length);
    if (presented === "") {
      return false;
    }
    const presentedDigest = createHash("sha256").update(presented, "utf8").digest();
    return timingSafeEqual(presentedDigest, this.#expectedDigest);
  }
}

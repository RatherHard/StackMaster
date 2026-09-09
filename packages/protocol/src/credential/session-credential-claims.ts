/**
 * SessionCredentialClaims —— 会话凭证的绑定字段集合(阶段三 WP-0,冻结)。
 *
 * 嵌入协议 §六设计面"随即由 session-api 另行签发会话凭证"的字段面兑现
 * (字段分类:WP-1 清单 §6.6):create-session 三方比对通过后由 session-api
 * 签发,绑定会话、租户、用户、题目身份对与过期时间,`jti` 为吊销键。
 *
 * 与 EmbedTokenClaims 同构(嵌入协议 §2.2):
 * - claims 对持票玩家无秘密性(会话上下文皆为其可见会话信息),分类 BOUNDARY
 *   ——防伪造靠签名(密钥仅域 2),防重放靠 jti 单次消费 + 过期 + 会话绑定;
 * - **解析器仅经 @stackmaster/protocol/server-only 子路径导出**:浏览器对凭证
 *   不解析、不校验、不在会话期外留存——不给浏览器可达代码提供解析入口,
 *   防"解析凭证做条件渲染"反模式(落盘 JSON Schema 保持公开供跨语言机检);
 * - 签名载体(JWT / PASETO / 自有格式)与交付面(HTTP 头 / Cookie 类)均为
 *   实现决策(D-API-3),本 Schema 冻结的是签名前 claims 载荷的字段集合;
 *   服务端永远以签发记录为锚,claims 内字段永不作为"自报身份"采信。
 */
import { z } from "zod";
import { OpaqueIdSchema } from "../common/identifiers.js";
import { CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE } from "../embed/embed-token-claims.js";

/**
 * 绑定字段集合(七字段冻结):EmbedTokenClaims 的 embedSessionId 绑定在此
 * 替换为 sessionId 绑定(会话已建立,iframe 会话绑定已由三方比对承接),
 * 其余六字段与 embed token 同源延续。
 */
export const SessionCredentialClaimsSchema = z.strictObject({
  /** 会话绑定(6.2 第 2 条):凭证只对签发它的会话有效,跨会话持有即无效。 */
  sessionId: OpaqueIdSchema,
  tenantId: OpaqueIdSchema,
  userId: OpaqueIdSchema,
  /** 题目身份对(版本号脱离题目 ID 无意义);会话期内题目版本锁定(9.1)。 */
  challengeId: OpaqueIdSchema,
  challengeVersion: z
    .string()
    .regex(
      new RegExp(CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE),
      "题目内容版本必须为 X.Y.Z 形式的语义化版本",
    ),
  /** 凭证实例标识:吊销键(删除即吊销;域 2 存储带 TTL)与单次消费语义的载体。 */
  jti: OpaqueIdSchema,
  /** 过期时刻:Unix epoch 秒(UTC);TTL ≤ MAX_SESSION_CREDENTIAL_TTL_SECONDS(D-API-4)。 */
  expiresAt: z.number().int().min(0),
});

export type SessionCredentialClaims = z.infer<typeof SessionCredentialClaimsSchema>;

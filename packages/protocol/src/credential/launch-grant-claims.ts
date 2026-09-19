/**
 * LaunchGrantClaims —— 「启动授权凭证」的签名载荷(WP-90 / D-LT-5 实施细化 5a,
 * 分发改版冻结)。
 *
 * **它是什么**:换票(`GET /app/c/:challengeId/:version?t=<ticket>`,语义见
 * `docs/contracts/启动票据协议.md` §四)成功后,由页面服务端**签发起动授权凭证**
 * 并经 `Set-Cookie` 下发的凭证的**签名前 claims 字段集合**。它证明的是「这个
 * 浏览器被授予了 **(tenant, challengeId, version)** 的入场权」,仅此而已。
 *
 * **为什么是独立 Schema(而不是复用 `SessionCredentialClaims`)**:D-LT-5 实施
 * 细化 5a 明确 —— 授权凭证 **≠** 会话凭证:后者在**会话已建立**之后签发并绑定
 * `sessionId`(`issueSessionCredential` 强制要求已存在的会话行),而本凭证在
 * **会话尚未建立**时下发(换票**不建会话**,候选 C 已否决)。⇒ 本 Schema
 * **没有 `sessionId`、没有 `embedSessionId`**,这正是「授权凭证 ≠ 会话凭证」的
 * **结构性表达**;两族字段名相近但**必须各自独立演进**,不做 `.shape` 复用。
 *
 * **它与 `create_session` 的关系(5c)**:协议 v2 起 `create_session` 载荷
 * **恰两键**(`challengeId` / `challengeVersion`)、无 `embedToken` /
 * `embedSessionId` ⇒ 授权来源 = **本凭证 Cookie**。服务端身份派生路径不变:
 * 租户 / 用户 / 题目只从「本凭证的签名 claims × 凭证签发存储记录
 * (`launchGrant:{jti}`)」派生,payload 只提供**导航信息**,且必须与凭证绑定
 * **逐字一致**(不一致 = 冻结 `PublicError` 枚举内拒绝,**不新增 code**,亦
 * **不得**降级为「以 payload 为准」)。
 *
 * **分类 `BOUNDARY`**:claims 对持票浏览器无秘密性(租户 / 用户 / 题目上下文
 * 皆为其会话上下文可见信息),防伪造靠签名(密钥仅域 2),防重放靠 `jti`
 * **单次消费**(消费即失效)+ `expiresAt` + 题目绑定;服务端永远以签发记录为锚,
 * claims 内字段**永不**作为"自报身份"采信。
 *
 * **解析器仅经 `@stackmaster/protocol/server-only` 子路径导出**:浏览器对授权
 * 凭证不解析、不校验(与 `EmbedTokenClaims` / `SessionCredentialClaims` 同机制
 * 不同实例)——不给浏览器可达代码提供"解析凭证做条件渲染"的反模式入口;
 * 落盘 JSON Schema 保持公开供机检(`x-sm-class: boundary`)。
 *
 * **$id 命名空间 = 会话动作协议族**(`SESSION_ACTION_SCHEMA_BASE_ID`,
 * `…/schemas/session-action/v2`):本凭证与 `create_session` **同族演进**
 * (5a 裁定)——它是那条命令链的授权输入,不与启动票据族的 URL 形态绑定。
 */
import { z } from "zod";
import { OpaqueIdSchema } from "../common/identifiers.js";
import { CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE } from "../embed/embed-token-claims.js";

/**
 * 启动授权凭证的绑定字段集合(**恰六字段**,D-LT-5 实施细化 5a 表):
 * - `tenantId`:服务端派生(宿主凭证 × `SESSION_API_HOST_TENANTS` 白名单),
 *   **永不**来自请求体 / URL;
 * - `userId`:服务端配置派生(`SESSION_API_LAUNCH_USER_ID`,缺省 `launch-anon`);
 * - `challengeId` / `challengeVersion`:公开导航信息,签发时由签发请求体给出
 *   (题目身份对,且必须与 `create_session` payload 逐字一致);
 * - `jti`:**单次消费**键(换票时写 `launchGrant:{jti}`,消费即删 / 置废);
 * - `expiresAt`:非负整数(epoch 秒);短时,TTL 与启动票据**同一配置族**
 *   (上限 `MAX_LAUNCH_TICKET_TTL_SECONDS`,缺省 `DEFAULT_LAUNCH_TICKET_TTL_SECONDS`)。
 */
export const LaunchGrantClaimsSchema = z.strictObject({
  tenantId: OpaqueIdSchema,
  userId: OpaqueIdSchema,
  challengeId: OpaqueIdSchema,
  challengeVersion: z
    .string()
    .regex(
      new RegExp(CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE),
      "题目内容版本必须为 X.Y.Z 形式的语义化版本",
    ),
  /** 凭证实例标识:单次消费键(`launchGrant:{jti}`,消费即失效)与吊销载体。 */
  jti: OpaqueIdSchema,
  /** 过期时刻:Unix epoch 秒(UTC);短时,TTL 与启动票据同一配置族。 */
  expiresAt: z.number().int().min(0),
});

export type LaunchGrantClaims = z.infer<typeof LaunchGrantClaimsSchema>;

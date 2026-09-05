/**
 * EmbedTokenClaims —— embed token 的绑定字段集合(WP-5,冻结)。
 *
 * embed token 是宿主平台后端签发给浏览器、随 create-session 提交给会话编排器
 * 的短期凭证(计划书 9.2):短期、单用途或有限次数,绑定五要素——租户、用户、
 * 题目版本、iframe 会话、过期时间(6.2 第 2 条、9.2)。签发与校验流程只在
 * 本文与 docs/嵌入协议.md §六做设计,实现归阶段五。
 *
 * 浏览器对 token 保持不透明:不解析、不校验、不持久化超出会话期的副本。
 * 本 Schema 因此**不经包入口导出**(只经 @stackmaster/protocol/server-only
 * 子路径供后端签发 / 校验消费;JSON Schema 落盘产物保持公开供跨语言机检)
 * ——不给浏览器可达代码提供 claims 解析器,防止"解析 token 做条件渲染"
 * 反模式(分类仍为 BOUNDARY:载荷本身可穿越浏览器,只是解析器不必在浏览器)。
 *
 * claims 对持票玩家本身无秘密性(租户 / 用户 / 题目上下文皆为其可见会话信息),
 * 分类 BOUNDARY(WP-1 §二"短期会话凭证"行);防伪造靠签名(签发方持有密钥),
 * 防重放靠 jti 一次性 / 限次 + 过期时间 + embedSessionId 绑定。
 *
 * 服务端(6.2 第 1 条)始终以签发记录与 host 凭证为锚:token 只是凭证材料,
 * 接受与否由签发方密钥、签发存储(token:{jti})与绑定校验决定,
 * token 内字段永不作为"自报身份"采信。
 */
import { z } from "zod";
import { OpaqueIdSchema } from "../common/identifiers.js";
import { EmbedSessionIdSchema } from "./embed-message.js";

/**
 * 题目内容版本格式:与 @stackmaster/challenge-schema 的 SEMVER_PATTERN_SOURCE
 * 同一冻结格式(`X.Y.Z`)。本包不得依赖工作区包(5.5),故在此以同一字面量
 * 重复冻结;格式变更属契约变更,两端必须同步(CI golden fixture 覆盖)。
 */
export const CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE = "^[0-9]+\\.[0-9]+\\.[0-9]+$";

const CHALLENGE_CONTENT_VERSION_PATTERN = new RegExp(CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE);

/**
 * 绑定字段集合(七字段冻结):
 * - 五要素来自计划书 9.2:tenantId / userId / challengeVersion / embedSessionId / expiresAt;
 * - `challengeId` 与 challengeVersion 构成题目身份对(版本号脱离题目 ID 无意义,
 *   与 challenge-schema 的 XS-ID-CORR 共享身份字段一致);
 * - `jti` 是 token 实例标识:单用途 / 有限次数语义与吊销(WP-1 §二 Redis
 *   `token:{jti}`,域 2,带 TTL)都以它为键。
 *
 * 序列化与签名载体(JWT / PASETO / 自有格式)是阶段五实现决策,不属契约;
 * 本 Schema 冻结的是签名前 claims 载荷的字段集合。
 */
export const EmbedTokenClaimsSchema = z.strictObject({
  tenantId: OpaqueIdSchema,
  userId: OpaqueIdSchema,
  challengeId: OpaqueIdSchema,
  challengeVersion: z
    .string()
    .regex(CHALLENGE_CONTENT_VERSION_PATTERN, "题目内容版本必须为 X.Y.Z 形式的语义化版本"),
  embedSessionId: EmbedSessionIdSchema,
  jti: OpaqueIdSchema,
  /** 过期时刻:Unix epoch 秒(UTC);签发 TTL 上限见 limits.ts 的 MAX_EMBED_TOKEN_TTL_SECONDS。 */
  expiresAt: z.number().int().min(0),
});

export type EmbedTokenClaims = z.infer<typeof EmbedTokenClaimsSchema>;

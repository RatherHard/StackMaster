/**
 * SessionCommandRequest —— 浏览器 → 编排器的会话级命令请求(阶段三 WP-0 冻结;
 * v2 由分发改版 WP-90 / D-LT-5 增补)。
 *
 * 协议语义文档 §5.1 冻结的生命周期命令集在本 Schema 收口请求面(语义文档 §九;
 * 字段分类与硬门槛论证:docs/contracts/数据分类与秘密零驻留清单.md §6.5)。
 * 命令经 REST 路由承载(HTTP 路由表为实现面文档登记,不作 JSON Schema 契约,
 * D-API-1);本 Schema 是传输无关的请求体契约。
 *
 * **身份零承载(硬门槛,v1 / v2 两版一致)**:请求体不存在任何身份字段 ——
 * `create_session` 只携带**导航信息**(题目身份对),租户 / 用户身份只从
 * 「授权凭证的签名 claims × 签发存储记录」派生(6.2 第 1 条"不接受请求体自报
 * 身份"的契约层结构表达;红灯 fixture 登记自报形态,strictObject 即拒)。
 *
 * **v2 破坏性变更(D-LT-5 第 2 条,2026-09-18)**:`create_session` 载荷由四键
 * 收为**恰两键** `{challengeId, challengeVersion}`:
 *  - `embedToken` **退场** —— 授权来源改为**换票产出的「启动授权凭证」Cookie**
 *    (服务端从凭证签名 claims × 签发存储记录派生身份与题目绑定);
 *  - `embedSessionId` **退场** —— 本形态**没有嵌入会话**,留着会让绑定面出现
 *    一个无法解释的字段(D-LT-5 第 3 条);
 *  - 服务端身份派生路径不变:payload 只提供**导航信息**,且必须与凭证绑定
 *    **逐字一致**(不一致 = 冻结错误码,不得降级为「以 payload 为准」)。
 *
 * **N-1 兼容窗口(D-LT-5 第 2 条)**:窗口期内 v1 请求照旧受理,故本文件同时
 * 产出两版判别联合 —— `SessionCommandRequestSchema`(v2,当前)与
 * `SessionCommandRequestV1Schema`(v1 冻结面,仅窗口期受理;`create_session`
 * 载荷仍是那四键)。窗口期结束删除 v1 面与
 * `SESSION_ACTION_PROTOCOL_PREVIOUS_VERSION`。**两版各自只接受本版本字面量**:
 * 双版本受理由服务端「版本 → Schema」注册表承担,而不是把两个形状合成一个
 * 宽松 Schema(后者会让 v2 请求携带 `embedToken` 也被接受 —— 那正是本次要关掉
 * 的门)。
 *
 * `command` 为封闭枚举:未知命令契约层拒绝,扩展走协议版本演进,不靠枚举外
 * 预留(与 12 动作 `type` 同纪律;连字符记法 ↔ snake_case 枚举的同义映射记
 * D-API-8)。
 */
import { z } from "zod";
import { OpaqueIdSchema } from "../common/identifiers.js";
import { EMBED_TOKEN_MAX_LENGTH } from "../common/limits.js";
import { EmbedSessionIdSchema } from "../embed/embed-message.js";
import { CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE } from "../embed/embed-token-claims.js";
import {
  SESSION_ACTION_PROTOCOL_PREVIOUS_VERSION,
  SESSION_ACTION_PROTOCOL_VERSION,
} from "../version.js";

/** 全部会话级命令(语义文档 §5.1 冻结,WP-0 冻结 wire 记法)。 */
export const SESSION_COMMANDS = [
  "create_session",
  "sync_projection",
  "list_checkpoints",
  "submit",
  "close_session",
] as const;

export type SessionCommand = (typeof SESSION_COMMANDS)[number];

/**
 * 会话命令请求统一信封字段(每个分支同形,drift 机检按分支键集断言)。
 * 按版本字面量参数化:各版本 Schema 只接受**本版本**(N-1 窗口由服务端按路由
 * 双版本受理,§5.2;合成宽松字面量会让版本判定形同虚设)。
 */
function sessionCommandRequestEnvelope(version: number) {
  return { protocolVersion: z.literal(version) } as const;
}

/** 题目身份对(公开导航信息;两版一致,见文件头「身份零承载」)。 */
const ChallengeIdentityFields = {
  challengeId: OpaqueIdSchema,
  challengeVersion: z
    .string()
    .regex(
      new RegExp(CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE),
      "题目内容版本必须为 X.Y.Z 形式的语义化版本",
    ),
} as const;

/**
 * `create_session` 载荷(**v2,恰两键**):公开导航信息。
 *
 * **无 `embedToken` / `embedSessionId`** —— 前者由「启动授权凭证」Cookie 取代
 * (授权来源 = 服务端签发的凭证,不是客户端提交的 token),后者所绑定的嵌入会话
 * 在本形态不存在。**授权不在这份载荷里,也不由它证明**:载荷只说明「打开哪一题」,
 * 「以谁的身份、被授予了哪一题」全部来自凭证 claims × 签发存储记录,且必须与
 * 本载荷逐字一致(D-LT-5 第 2 条)。
 */
export const CreateSessionRequestPayloadSchema = z.strictObject({
  ...ChallengeIdentityFields,
});

export type CreateSessionRequestPayload = z.infer<typeof CreateSessionRequestPayloadSchema>;

/**
 * `create_session` 载荷(**v1 冻结面,四键**,仅 N-1 窗口期受理):
 * 题目上下文三方比对输入 + embed token。
 *
 * 该形状**随嵌入协议面一同退场**(`/auth/embed-tokens` 与 embed token 属嵌入
 * 协议,整体退役、不做版本演进);它留在契约包里的唯一目的是让窗口期内的 v1
 * 客户端仍能被独立 Schema 校验(服务端装配期断言受理集合每个版本都有 Schema,
 * 缺一即拒绝启动)。窗口期结束即删除。
 */
export const CreateSessionRequestPayloadV1Schema = z.strictObject({
  ...ChallengeIdentityFields,
  embedSessionId: EmbedSessionIdSchema,
  embedToken: z
    .string()
    .min(1)
    .max(EMBED_TOKEN_MAX_LENGTH, `embed token 超过最大长度 ${EMBED_TOKEN_MAX_LENGTH}`),
});

export type CreateSessionRequestPayloadV1 = z.infer<
  typeof CreateSessionRequestPayloadV1Schema
>;

/** 除 create_session 外,命令以服务端签发的 sessionId 定位会话(v1 / v2 同形)。 */
const SessionIdPayloadSchema = z.strictObject({ sessionId: OpaqueIdSchema });

/**
 * 按版本产出会话命令请求判别联合:统一信封 + 按 `command` 判别的 strictObject
 * 载荷,type ↔ payload 耦合由结构表达,TS 与 Rust 校验结论一致(与 EmbedMessage
 * 同形)。`createSessionPayload` 由调用方按版本注入(两版唯一的形状差异就在它)。
 */
function sessionCommandRequestSchemaForVersion(
  version: number,
  createSessionPayload: z.ZodType,
) {
  const envelope = sessionCommandRequestEnvelope(version);
  return z.discriminatedUnion("command", [
    z.strictObject({
      ...envelope,
      command: z.literal("create_session"),
      payload: createSessionPayload,
    }),
    z.strictObject({
      ...envelope,
      command: z.literal("sync_projection"),
      payload: SessionIdPayloadSchema,
    }),
    z.strictObject({
      ...envelope,
      command: z.literal("list_checkpoints"),
      payload: SessionIdPayloadSchema,
    }),
    z.strictObject({
      ...envelope,
      command: z.literal("submit"),
      payload: SessionIdPayloadSchema,
    }),
    z.strictObject({
      ...envelope,
      command: z.literal("close_session"),
      payload: SessionIdPayloadSchema,
    }),
  ]);
}

/** 当前版本(v2)的会话命令请求。 */
export const SessionCommandRequestSchema = sessionCommandRequestSchemaForVersion(
  SESSION_ACTION_PROTOCOL_VERSION,
  CreateSessionRequestPayloadSchema,
);

/** N-1 窗口期的冻结 v1 请求(create_session 仍为四键;窗口期结束即删除)。 */
export const SessionCommandRequestV1Schema = sessionCommandRequestSchemaForVersion(
  SESSION_ACTION_PROTOCOL_PREVIOUS_VERSION,
  CreateSessionRequestPayloadV1Schema,
);

export type SessionCommandRequest = z.infer<typeof SessionCommandRequestSchema>;

export type SessionCommandRequestV1 = z.infer<typeof SessionCommandRequestV1Schema>;

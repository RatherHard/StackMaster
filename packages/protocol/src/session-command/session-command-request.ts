/**
 * SessionCommandRequest —— 浏览器 → 编排器的会话级命令请求(阶段三 WP-0 冻结)。
 *
 * 协议语义文档 §5.1 冻结的生命周期命令集在本 Schema 收口请求面(语义文档 §九;
 * 字段分类与硬门槛论证:docs/contracts/数据分类与秘密零驻留清单.md §6.5)。
 * 命令经 REST 路由承载(HTTP 路由表为实现面文档登记,不作 JSON Schema 契约,
 * D-API-1);本 Schema 是传输无关的请求体契约。
 *
 * 身份零承载(硬门槛):请求体不存在任何身份字段——`create_session` 只携带
 * 题目上下文与 embed token(凭证材料),租户 / 用户身份只从 token 签名 claims
 * × 签发存储记录三方比对派生(6.2 第 1 条"不接受请求体自报身份"的契约层
 * 结构表达;红灯 fixture 登记自报形态,strictObject 即拒)。
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
import { SESSION_ACTION_PROTOCOL_VERSION } from "../version.js";

/** 全部会话级命令(语义文档 §5.1 冻结,WP-0 冻结 wire 记法)。 */
export const SESSION_COMMANDS = [
  "create_session",
  "sync_projection",
  "list_checkpoints",
  "submit",
  "close_session",
] as const;

export type SessionCommand = (typeof SESSION_COMMANDS)[number];

/** 会话命令请求统一信封字段(每个分支同形,drift 机检按分支键集断言)。 */
const SessionCommandRequestEnvelope = {
  /** 协议版本;本 Schema 只接受当前版本(N-1 窗口由服务端按路由双版本受理,§5.2)。 */
  protocolVersion: z.literal(SESSION_ACTION_PROTOCOL_VERSION),
} as const;

/**
 * `create_session` 载荷:题目上下文三方比对输入 + embed token。
 * `challengeId` / `challengeVersion` / `embedSessionId` 必须与签名 claims 及
 * 签发存储记录一致(嵌入协议 §六校验序),`embedToken` 为签名载体不透明字符串
 * (载体格式为实现决策 D-API-3,Schema 只约束长度上限;值禁入 URL / 日志 /
 * 错误响应)。
 */
export const CreateSessionRequestPayloadSchema = z.strictObject({
  challengeId: OpaqueIdSchema,
  challengeVersion: z
    .string()
    .regex(
      new RegExp(CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE),
      "题目内容版本必须为 X.Y.Z 形式的语义化版本",
    ),
  embedSessionId: EmbedSessionIdSchema,
  embedToken: z
    .string()
    .min(1)
    .max(EMBED_TOKEN_MAX_LENGTH, `embed token 超过最大长度 ${EMBED_TOKEN_MAX_LENGTH}`),
});

/** 除 create_session 外,命令以服务端签发的 sessionId 定位会话。 */
const SessionIdPayloadSchema = z.strictObject({ sessionId: OpaqueIdSchema });

/**
 * 会话命令请求判别联合:统一信封 + 按 `command` 判别的 strictObject 载荷,
 * type ↔ payload 耦合由结构表达,TS 与 Rust 校验结论一致(与 EmbedMessage 同形)。
 */
export const SessionCommandRequestSchema = z.discriminatedUnion("command", [
  z.strictObject({
    ...SessionCommandRequestEnvelope,
    command: z.literal("create_session"),
    payload: CreateSessionRequestPayloadSchema,
  }),
  z.strictObject({
    ...SessionCommandRequestEnvelope,
    command: z.literal("sync_projection"),
    payload: SessionIdPayloadSchema,
  }),
  z.strictObject({
    ...SessionCommandRequestEnvelope,
    command: z.literal("list_checkpoints"),
    payload: SessionIdPayloadSchema,
  }),
  z.strictObject({
    ...SessionCommandRequestEnvelope,
    command: z.literal("submit"),
    payload: SessionIdPayloadSchema,
  }),
  z.strictObject({
    ...SessionCommandRequestEnvelope,
    command: z.literal("close_session"),
    payload: SessionIdPayloadSchema,
  }),
]);

export type SessionCommandRequest = z.infer<typeof SessionCommandRequestSchema>;

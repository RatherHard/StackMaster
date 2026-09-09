/**
 * WssFrame —— 浏览器 ↔ 编排器认证 WSS 通道的消息传输帧(阶段三 WP-0 冻结)。
 *
 * 会话动作协议语义文档 §一"传输层信封归 WP-5 与阶段三"的阶段三落点;
 * 帧字段集 = 计划书 8.2 最低字段清单(协议版本、消息类型、会话 ID、序列号、
 * 可选请求 ID、结构化载荷)的直接落位(字段分类:WP-1 清单 §6.7)。
 *
 * 载荷三类型全部是已冻结契约的**纯复用**,零新增载荷字段——通道承载面不扩权:
 * - `action` → 冻结 `ActionRequest`(12 动作协议面,客户端 → 服务端);
 * - `action_response` → 冻结 `ActionResponse`(服务端 → 客户端);
 * - `error` → 冻结 `PublicError`(服务端 → 客户端;通道级校验失败——未认证 /
 *   畸形帧 / 频率超限——同样只产出该形态,零校验器细节透出,基线 #8)。
 *
 * 版本承载(语义文档 §5.2):传输帧随会话动作协议同一版本编号演进(D-API-2),
 * 不另设版本常量;**连接级锚定**——首帧 `protocolVersion` 即本连接的解释版本,
 * 此后任何帧携带其他版本一律拒绝;响应帧不携带新版本(信封按请求版本解释)。
 * `seq` 只承担传输层关联与诊断,权威序 = 执行序(帧序即执行序);防重放与串行
 * 由载荷内 `clientSeq` / `idempotencyKey` / `baseRevision` 承担。心跳走 RFC 6455
 * 协议层 ping/pong,不设应用层心跳帧(D-API-6),帧类型集合封闭。
 */
import { z } from "zod";
import { OpaqueIdSchema } from "../common/identifiers.js";
import { PublicErrorSchema } from "../error/public-error.js";
import { ActionRequestSchema } from "../session-action/action-request.js";
import { ActionResponseSchema } from "../session-action/action-response.js";
import { SESSION_ACTION_PROTOCOL_VERSION } from "../version.js";

/** 全部 WSS 消息类型(封闭枚举;扩展 = 协议版本演进)。 */
export const WSS_MESSAGE_TYPES = ["action", "action_response", "error"] as const;

export type WssMessageType = (typeof WSS_MESSAGE_TYPES)[number];

/** 客户端 → 服务端方向的消息类型(接收端方向检查;嵌入协议规则 V-6 同纪律)。 */
export const WSS_CLIENT_TO_SERVER_TYPES = ["action"] as const;

/** 服务端 → 客户端方向的消息类型。 */
export const WSS_SERVER_TO_CLIENT_TYPES = ["action_response", "error"] as const;

export type WssClientToServerType = (typeof WSS_CLIENT_TO_SERVER_TYPES)[number];
export type WssServerToClientType = (typeof WSS_SERVER_TO_CLIENT_TYPES)[number];

/**
 * WSS 消息帧判别联合:统一信封六字段(8.2 基线),type ↔ payload 耦合由结构
 * 表达,TS 与 Rust 校验结论一致(与 EmbedMessage 同形)。
 */
export const WssFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    protocolVersion: z.literal(SESSION_ACTION_PROTOCOL_VERSION),
    type: z.literal("action"),
    /** 帧绑定会话:必须与连接绑定凭证的会话一致,不一致拒绝(WP-5)。 */
    sessionId: OpaqueIdSchema,
    /** 发送方连接内严格递增(允许跳号);传输层关联与诊断用,非权威序号。 */
    seq: z.number().int().min(1),
    /** 可选发送方关联值;响应对应帧回显同一值(传输层关联,载荷内 requestId 语义独立)。 */
    requestId: OpaqueIdSchema.optional(),
    payload: ActionRequestSchema,
  }),
  z.strictObject({
    protocolVersion: z.literal(SESSION_ACTION_PROTOCOL_VERSION),
    type: z.literal("action_response"),
    sessionId: OpaqueIdSchema,
    seq: z.number().int().min(1),
    requestId: OpaqueIdSchema.optional(),
    payload: ActionResponseSchema,
  }),
  z.strictObject({
    protocolVersion: z.literal(SESSION_ACTION_PROTOCOL_VERSION),
    type: z.literal("error"),
    sessionId: OpaqueIdSchema,
    seq: z.number().int().min(1),
    requestId: OpaqueIdSchema.optional(),
    payload: PublicErrorSchema,
  }),
]);

export type WssFrame = z.infer<typeof WssFrameSchema>;

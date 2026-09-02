/**
 * ActionRequest —— 浏览器 → 编排器的动作请求信封(计划书 6.2)。
 *
 * 整体分类 `BOUNDARY`(WP-1 §6.1):玩家自报内容,服务端对全部字段按同一契约
 * 重新校验,不信任客户端类型标注(5.6)。strictObject 使未知字段在契约层拒绝(I-1);
 * 解析层必须同时剥离未声明字段、不读取其内容(ZR-T2)。
 */
import { z } from "zod";
import { IdempotencyKeySchema, OpaqueIdSchema } from "../common/identifiers.js";
import { SESSION_ACTION_PROTOCOL_VERSION } from "../version.js";
import { ActionObjectSchema } from "./action-object.js";

export const ActionRequestSchema = z.strictObject({
  /**
   * 协议版本;本 Schema 只接受当前版本。
   * N-1 兼容窗口期间服务端按路由同时接受上一版 Schema(5.6,窗口语义见语义文档 §五)。
   */
  protocolVersion: z.literal(SESSION_ACTION_PROTOCOL_VERSION),
  /** create-session 时由服务端签发;token 绑定校验在服务端(6.2 第 2 条)。 */
  sessionId: OpaqueIdSchema,
  /** 客户端会话内严格递增序号,自 1 起;串行与防乱序语义见语义文档 §四。 */
  clientSeq: z.number().int().min(1),
  /** 乐观并发控制:必须等于服务端当前 revision,过期即拒绝(语义文档 §四)。 */
  baseRevision: z.number().int().min(0),
  /** 客户端生成的幂等键;防重与幂等窗口语义见语义文档 §四(ZR-T3)。 */
  idempotencyKey: IdempotencyKeySchema,
  /** 动作判别对象;args 按 type 逐一校验(语义文档 §三)。 */
  action: ActionObjectSchema,
});

export type ActionRequest = z.infer<typeof ActionRequestSchema>;

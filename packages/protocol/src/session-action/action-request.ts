/**
 * ActionRequest —— 浏览器 → 编排器的动作请求信封(计划书 6.2)。
 *
 * 整体分类 `BOUNDARY`(WP-1 §6.1):玩家自报内容,服务端对全部字段按同一契约
 * 重新校验,不信任客户端类型标注(5.6)。strictObject 使未知字段在契约层拒绝(I-1);
 * 解析层必须同时剥离未声明字段、不读取其内容(ZR-T2)。
 *
 * **N-1 兼容窗口的历史与关闭(D-LT-5 第 2 条)**:v2 生效时窗口期内 v1 请求曾照旧
 * 受理,本文件因此按**版本字面量参数化**产出过两份形状完全相同的 Schema
 * (`ActionRequestSchema` = 当前版本,`ActionRequestV1Schema` = 上一版本),
 * 供服务端「版本 → Schema」注册表登记(装配期断言受理集合每个版本都有 Schema,
 * 缺一即拒绝启动)。**动作请求的形状在 v1 → v2 之间零变化**,差异只在信封的
 * `protocolVersion` 字面量。**2026-09-19 窗口关闭(随 WP-96)**:
 * `ActionRequestV1Schema` 与 `SESSION_ACTION_PROTOCOL_PREVIOUS_VERSION` 同批
 * **物理删除**;本参数化工厂保留(单一版本调用),装配期断言保留在场。
 */
import { z } from "zod";
import { IdempotencyKeySchema, OpaqueIdSchema } from "../common/identifiers.js";
import { SESSION_ACTION_PROTOCOL_VERSION } from "../version.js";
import { ActionObjectSchema } from "./action-object.js";

/** 按版本字面量产出动作请求 Schema(形状在 v1 → v2 之间完全一致;见文件头)。 */
function actionRequestSchemaForVersion(version: number) {
  return z.strictObject({
    /**
     * 协议版本;Schema 只接受**本版本**字面量
     * (版本受理由服务端按路由的版本 → Schema 注册表承担,5.6;
     * 语义见语义文档 §5.2)。
     */
    protocolVersion: z.literal(version),
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
}

/** 当前版本的动作请求信封(`protocolVersion` = `SESSION_ACTION_PROTOCOL_VERSION`)。 */
export const ActionRequestSchema = actionRequestSchemaForVersion(
  SESSION_ACTION_PROTOCOL_VERSION,
);

export type ActionRequest = z.infer<typeof ActionRequestSchema>;

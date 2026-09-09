/**
 * SessionCommandResponse —— 编排器 → 浏览器的会话级命令响应(阶段三 WP-0 冻结)。
 *
 * 字段分类与硬门槛论证:docs/contracts/数据分类与秘密零驻留清单.md §6.5。
 * 整体 `PUBLIC`(全部字段值来源 ⊆ 服务端签发不透明标识符、§4.1 revision、
 * 第四章公开投影、玩家自报回显);载荷三个结构性负面结论(§6.5):
 * 1. `create_session` 响应不含会话凭证——交付面为 HTTP 头 / Cookie 类实现面
 *    (D-API-3),JSON 契约体零凭证字段;
 * 2. `submit` 响应只含 `{submissionId, revision}`——裁决引用(规范化动作日志、
 *    快照、题目身份)整体 SERVER_ONLY,不下发;正式裁决(11 种结果类型)经
 *    阶段六 verifier 链路返回,不在本契约;
 * 3. 响应不携带版本字段(语义文档 §5.2:信封按请求版本解释;红灯 fixture 登记)。
 *
 * 跨字段一致性(与 ActionResponse 增量耦合第 2 条同机制):携带 projection 的
 * 分支,`projection.revision` 必须等于同载荷 `revision`——超出 JSON Schema 结构
 * 表达能力,由 superRefine 与 fixture 反例双侧锁定。
 */
import { z } from "zod";
import { OpaqueIdSchema } from "../common/identifiers.js";
import { CHECKPOINT_LABEL_MAX_LENGTH, MAX_CHECKPOINTS_PER_SESSION } from "../common/limits.js";
import { PublicStateProjectionSchema } from "../projection/public-state-projection.js";
import { SESSION_COMMANDS } from "./session-command-request.js";

/**
 * checkpoint 引用(`list_checkpoints` 响应条目;语义文档 §5.1:checkpointId、
 * label?、内容 revision、创建顺序)。数组按创建顺序排列(顺序即语义,不设
 * 冗余序号字段);`label` 为玩家自报回显,与 `create_checkpoint` args 同纪律
 * (≤ 128 字符;控制字符封禁在写入侧已拒绝,回显侧不再重复值级校验——
 * 服务端只可能回显自己校验通过过的标签)。
 */
export const CheckpointRefSchema = z.strictObject({
  /** 服务端 create_checkpoint 时签发;归属校验在服务端(6.3)。 */
  checkpointId: OpaqueIdSchema,
  label: z.string().min(1).max(CHECKPOINT_LABEL_MAX_LENGTH).optional(),
  /** 内容 revision(create_checkpoint 响应的 revision;I-5 语义)。 */
  revision: z.number().int().min(0),
});

export type CheckpointRef = z.infer<typeof CheckpointRefSchema>;

/** 会话命令响应统一信封字段(每个分支同形,drift 机检按分支键集断言)。 */
const SessionCommandResponseEnvelope = {
  /** 与请求回显同一命令名(封闭枚举;请求侧枚举的镜像)。 */
  command: z.enum(SESSION_COMMANDS),
} as const;

/** 服务端签发 revision 的公共形态(I-5:权威单调计数器)。 */
const RevisionSchema = z.number().int().min(0);

const SessionCommandResponseUnionSchema = z.discriminatedUnion("command", [
  z.strictObject({
    ...SessionCommandResponseEnvelope,
    command: z.literal("create_session"),
    /** 服务端签发的会话标识;有效性由会话表与凭证绑定校验(6.2 第 2 条)。 */
    payload: z.strictObject({
      sessionId: OpaqueIdSchema,
      /** 初始 revision(恒为 0;I-5:首个动作 baseRevision 的对齐锚,语义文档 §4.2)。 */
      revision: RevisionSchema,
      /** 初始公开投影(整体 PUBLIC,第四章;§5.1"初始公开投影")。 */
      projection: PublicStateProjectionSchema,
    }),
  }),
  z.strictObject({
    ...SessionCommandResponseEnvelope,
    command: z.literal("sync_projection"),
    payload: z.strictObject({
      revision: RevisionSchema,
      /** 完整最近已生成投影(§5.1:只重发、不重询,WP-1 D1 约束 1)。 */
      projection: PublicStateProjectionSchema,
    }),
  }),
  z.strictObject({
    ...SessionCommandResponseEnvelope,
    command: z.literal("list_checkpoints"),
    payload: z.strictObject({
      /** 按创建顺序排列(顺序即语义);上限 MAX_CHECKPOINTS_PER_SESSION 外圈护栏。 */
      checkpoints: z
        .array(CheckpointRefSchema)
        .max(MAX_CHECKPOINTS_PER_SESSION, `checkpoint 列表超过上限 ${MAX_CHECKPOINTS_PER_SESSION}`),
    }),
  }),
  z.strictObject({
    ...SessionCommandResponseEnvelope,
    command: z.literal("submit"),
    payload: z.strictObject({
      /** 服务端签发的提交引用 ID;裁决引用本体 SERVER_ONLY(D-W8-9),不下发。 */
      submissionId: OpaqueIdSchema,
      /** 提交时的会话权威 revision。 */
      revision: RevisionSchema,
    }),
  }),
  z.strictObject({
    ...SessionCommandResponseEnvelope,
    command: z.literal("close_session"),
    payload: z.strictObject({
      /** 关闭时会话的最终权威 revision(客户端账本对齐锚)。 */
      revision: RevisionSchema,
    }),
  }),
]);

/** 跨字段一致性:携带 projection 的分支,投影 revision 必须等于载荷 revision。 */
export const SessionCommandResponseSchema = SessionCommandResponseUnionSchema.superRefine(
  (response, ctx) => {
    if (
      (response.command === "create_session" || response.command === "sync_projection") &&
      response.payload.projection.revision !== response.payload.revision
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["payload", "projection", "revision"],
        message: `投影 revision(${response.payload.projection.revision})必须等于载荷 revision(${response.payload.revision})`,
      });
    }
  },
);

export type SessionCommandResponse = z.infer<typeof SessionCommandResponseSchema>;

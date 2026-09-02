/**
 * 12 种会话动作的 args Schema(计划书 6.2,WP-2 逐一冻结)。
 *
 * 通用规则:
 * - args 是玩家输入(`BOUNDARY`,WP-1 §6.1):本 Schema 只做结构与字面校验;
 *   地址合法性、区域权限、操作数范围与资源预算由服务端在执行前重新校验(6.2 第 6 条);
 * - 全部 strictObject:未知字段在契约层拒绝(I-1);"剥离"仅指拒绝之后的规范化
 *   序列化与日志脱敏环节排除未声明字段(ZR-T2);
 * - 地址与值用 0x 前缀十六进制字符串(6.2);位宽按题目 VM Profile 由服务端校验
 *   (动作协议与 VM Profile 解耦,docs/develop/Vm 模块设计.md);
 * - 无参动作的 args 是空对象 `{}`(args 字段本身必填,见 action-request.ts)。
 */
import { z } from "zod";
import { AddressHexSchema, BytesHexSchema, ValueHex64Schema } from "../common/hex.js";
import { OpaqueIdSchema } from "../common/identifiers.js";
import { CHECKPOINT_LABEL_MAX_LENGTH } from "../common/limits.js";

/**
 * run_to_event 的暂停事件枚举(计划书 6.2;与 WP-1 §4.2 `PublicEvent.kind`、
 * 决策 D5 `pausedOn` 同源)。MVP 只含五类,伪 `syscall` 不作为暂停事件提供;
 * 扩展走协议版本演进,不靠枚举预留(阶段一任务分解:禁止预留字段)。
 */
export const PauseEventSchema = z.enum(["read", "write", "call", "ret", "exception"]);
export type PauseEvent = z.infer<typeof PauseEventSchema>;

/** 向指定地址写入字节(教学动作:构造 payload 覆盖 buffer / 返回地址)。 */
export const WriteBytesArgsSchema = z.strictObject({
  /** 目标起始地址。对不可见地址(隐藏映射或未映射)一律按 I-9 统一拒绝,不产生事件。 */
  addressHex: AddressHexSchema,
  /** 字节内容(偶数长度十六进制串);协议级上限 MAX_WRITE_BYTES。 */
  bytesHex: BytesHexSchema,
});

/** 把 64 位值压入栈(教学动作;字节序语义由引擎按题目 VM Profile 决定)。 */
export const PushArgsSchema = z.strictObject({
  valueHex: ValueHex64Schema,
});

/** 弹出栈顶值;弹出结果只经公开投影对玩家可见。 */
export const PopArgsSchema = z.strictObject({});

/** 调用目标地址:压入返回地址并跳转(教学动作,非任意指令执行)。 */
export const CallArgsSchema = z.strictObject({
  /** 目标地址;合法性(是否落在可执行区域)由服务端判定并按 I-9 统一拒绝形态反馈。 */
  targetHex: AddressHexSchema,
});

/** 返回:弹出栈顶作为新 RIP;非法 RIP 属可解释错误(WP-3 错误枚举,4.4)。 */
export const RetArgsSchema = z.strictObject({});

/** 单步执行恰好一条指令(4.4"单条机器动作");连续多步走 run_to_event,步数不作为动作自由度。 */
export const StepArgsSchema = z.strictObject({});

/** 运行直到触发指定类别事件后暂停(4.4"执行到关键事件")。 */
export const RunToEventArgsSchema = z.strictObject({
  pauseOn: PauseEventSchema,
});

/** 在当前指令边界暂停运行中的 VM。 */
export const PauseArgsSchema = z.strictObject({});

/** 撤销上一次已执行动作:内容回退、revision 前进(语义文档 §四);终态会话确定性拒绝(D1 约束 5)。 */
export const UndoArgsSchema = z.strictObject({});

/** 恢复到指定 checkpoint 的内容(新 revision 携带旧内容,语义文档 §四)。 */
export const CheckoutCheckpointArgsSchema = z.strictObject({
  /** 服务端 create_checkpoint 时签发;归属校验在服务端(6.3)。 */
  checkpointId: OpaqueIdSchema,
});

/** 重置会话到题目初始状态(终态会话确定性拒绝,D1 约束 5)。 */
export const ResetArgsSchema = z.strictObject({});

/**
 * checkpoint 标签的控制字符封禁(C0/C1;审计日志注入面,语义文档 §2.1)。
 * 注:这里**有意**在正则中匹配控制字符以拒绝它们。
 */
// eslint-disable-next-line no-control-regex -- 封禁 C0/C1 控制字符本身要求正则中出现控制字符(语义文档 §2.1)
const CHECKPOINT_LABEL_PATTERN = /^[^\u0000-\u001F\u007F-\u009F]*$/;

/** 创建 checkpoint(6.3:服务端保存 COW 快照;时间线只存引用,4.4)。 */
export const CreateCheckpointArgsSchema = z.strictObject({
  /** 可选的玩家自报标签(BOUNDARY;时间线展示用)。 */
  label: z
    .string()
    .min(1)
    .max(CHECKPOINT_LABEL_MAX_LENGTH)
    .regex(CHECKPOINT_LABEL_PATTERN, "标签不允许包含控制字符")
    .optional(),
});

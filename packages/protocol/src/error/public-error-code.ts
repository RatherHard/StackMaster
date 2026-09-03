/**
 * PublicErrorCode —— 冻结错误码枚举(WP-1 §6.3 E-1,WP-3 冻结 16 值)。
 *
 * 覆盖计划书 4.4 的九类教学错误 + I-9 统一访问拒绝 + 资源预算 +
 * 协议级拒绝 + 内部错误兜底。枚举值本身是公开契约;出现与否是
 * (错误类别, 可见状态) 的确定性函数,与秘密内容无相关(I-8)。
 *
 * 扩展走协议版本演进,不靠预留值(阶段一任务分解:禁止预留字段)。
 */
import { z } from "zod";

export const PUBLIC_ERROR_CODES = [
  // —— 教学错误(计划书 4.4 九类)——
  "invalid_input_format", // 输入格式错误(十六进制 / 结构非法,§7#8 契约层同码)
  "invalid_payload_length", // payload 长度错误
  "offset_out_of_range", // 偏移不足或过长(写出可见区域边界)
  "endianness_mismatch", // 端序错误(值被按错误端序解释的教学反馈)
  "permission_denied", // 权限错误(对可见但不可写 / 不可执行地址操作)
  "invalid_rip", // 非法 RIP(ret 弹出值不可作为执行位置)
  "canary_violation", // Canary 破坏(触发会话 failed 的教学结果)
  "invalid_call_argument", // 参数寄存器错误(调用约定:参数不在约定位置)
  "objective_not_met", // 目标条件未满足(零谓词信息,E-4 / I-7)
  // —— 统一访问拒绝 ——
  "inaccessible_address", // I-9:不可见地址(隐藏映射与未映射统一形态)
  // —— 资源预算 ——
  "budget_exhausted", // 题目资源预算耗尽(步数 / 内存 / 输出上限等)
  // —— 协议级拒绝与兜底(不携带地址与解释字段,WP-1 §4.4)——
  "stale_base_revision", // baseRevision 过期(先 sync-projection 再重试)
  "stale_client_seq", // clientSeq 乱序
  "idempotency_conflict", // 幂等键冲突(同键不同内容)
  "session_terminal", // 会话已终态(won/failed)后禁止该动作(D1 约束 5)
  "internal_error", // 引擎内部错误(engine_error 的公开兜底形态,不带细节,E-6)
] as const;

export const PublicErrorCodeSchema = z.enum(PUBLIC_ERROR_CODES);
export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

/**
 * 11 种稳定结果类型(计划书 9.1,WP-2 冻结)。
 *
 * 归属:正式裁决(verifier,信任域 4)与提交 / 回放链路的结果字段。
 * 与交互会话的 `PublicStatus`(won / failed)相互独立(WP-1 决策 D6):
 * 前者是权威成绩,只能由 verifier 对规范化动作日志独立重放产生;后者是教学反馈。
 * 枚举值即契约:前端不得解析枚举之外的非契约字段(5.6)。
 */
import { z } from "zod";

export const VerdictResultSchema = z.enum([
  "success",
  "wrong_answer",
  "invalid_action",
  "program_crash",
  "memory_fault",
  "resource_limit",
  "timeout",
  "engine_error",
  "challenge_invalid",
  "replay_mismatch",
  "cancelled",
]);

export type VerdictResult = z.infer<typeof VerdictResultSchema>;

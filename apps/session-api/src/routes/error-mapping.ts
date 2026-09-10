/**
 * HTTP 状态 ↔ 冻结结果类型映射矩阵(任务分解 WP-4 第 4 条;D-API-32)。
 *
 * 原则:
 *  - 一切非 2xx 响应体 = 冻结 `PublicError` 形态(基线 #8),code ∈ 16 冻结码,
 *    message 恒为静态模板文案——零内部细节、零校验器细节、零进程细节;
 *  - 拒绝路径确定性(I-4):同一失败类别恒映射同一 (HTTP 状态, code, message)
 *    三元组,与隐藏状态无关;载荷常量在模块加载期过冻结 Schema 自检,
 *    契约漂移即抛错(拒绝启动,与 server.ts 装配期自检同源);
 *  - 认证拒绝沿 WP-2 的统一失败面(D-API-14:401 + 单一形态,防枚举),
 *    本模块不重复定义;
 *  - 会话定位失败(不存在 / 已关闭回收 / 租户不匹配)统一 404,与路由级
 *    404 同形——跨租户探测得不到额外信号(防枚举)。
 *
 * 映射矩阵(编排器域结果类型 → HTTP):
 *  | 结果类别           | HTTP | PublicError code   | 静态文案                       |
 *  |--------------------|------|--------------------|--------------------------------|
 *  | invalid_action     | 400  | invalid_input_format | invalid request              |
 *  | (版本不受支持)     | 400  | invalid_input_format | unsupported protocol version |
 *  | (请求超限-字节)    | 413  | invalid_input_format | request too large            |
 *  | (认证失败)         | 401  | invalid_input_format | authentication failed (D-API-14) |
 *  | (会话定位失败)     | 404  | invalid_input_format | resource not found           |
 *  | session_terminal   | 409  | session_terminal   | session is terminal           |
 *  | (clientSeq 触顶)   | 409  | stale_client_seq   | client sequence budget exhausted |
 *  | challenge_invalid  | 422  | internal_error     | challenge invalid             |
 *  | engine_error       | 500  | internal_error     | internal error                |
 *  | timeout(看门狗 3) | 504  | budget_exhausted   | session timed out             |
 *  | cancelled(预留)   | 409  | session_terminal   | session is terminal           |
 *  | (存储不可用)       | 503  | internal_error     | storage unavailable           |
 *  | (限流频率触顶 WP-6)| 429  | budget_exhausted   | rate limit exceeded (D-API-50)|
 *  | (并发预算触顶 WP-6)| 429  | budget_exhausted   | concurrent session budget exceeded (D-API-52) |
 */
import { PublicErrorSchema, type PublicError } from "@stackmaster/protocol";

import { PersistenceError } from "../persistence/errors.js";
import { ConcurrentSessionBudgetExhausted, RateLimitExceeded } from "../limits/errors.js";
import {
  ChallengeLoadRejected,
  ClientSeqBudgetExhausted,
  MappedOrchestratorFailure,
} from "../sessions/session-manager.js";
import type { CommandValidationFailure } from "./session-contract.js";

/** 路由级校验失败 → (HTTP 状态, 冻结载荷)。 */
export function mapValidationFailure(failure: CommandValidationFailure): {
  readonly status: number;
  readonly body: PublicError;
} {
  switch (failure.kind) {
    case "unsupported_version":
      return { status: 400, body: UNSUPPORTED_VERSION_ERROR };
    case "guard_violation":
    case "malformed_body":
    default:
      return { status: 400, body: VALIDATION_ERROR };
  }
}

/** 编排器 / 持久化域异常 → (HTTP 状态, 冻结载荷);未知异常返回 null(调用方走 500 兜底)。 */
export function mapDomainFailure(error: unknown): {
  readonly status: number;
  readonly body: PublicError;
} | null {
  if (error instanceof MappedOrchestratorFailure) {
    switch (error.kind) {
      case "timeout":
        return { status: 504, body: TIMEOUT_ERROR };
      case "cancelled":
      case "session_terminal":
        return { status: 409, body: TERMINAL_ERROR };
      case "not_found":
        return { status: 404, body: NOT_FOUND_ERROR };
      case "engine_error":
      default:
        return { status: 500, body: ENGINE_ERROR_ERROR };
    }
  }
  if (error instanceof ChallengeLoadRejected) {
    return { status: 422, body: CHALLENGE_INVALID_ERROR };
  }
  if (error instanceof ClientSeqBudgetExhausted) {
    return { status: 409, body: CLIENT_SEQ_BUDGET_ERROR };
  }
  // WP-6 限流触顶(D-API-50 / D-API-52):429 + 冻结形态,非 5xx、非静默。
  if (error instanceof RateLimitExceeded) {
    return { status: 429, body: RATE_LIMITED_ERROR };
  }
  if (error instanceof ConcurrentSessionBudgetExhausted) {
    return { status: 429, body: CONCURRENT_SESSION_BUDGET_ERROR };
  }
  if (error instanceof PersistenceError) {
    return { status: 503, body: STORAGE_UNAVAILABLE_ERROR };
  }
  return null;
}

// —— 冻结载荷常量(模块加载期过 Schema 自检;漂移即抛错拒绝启动)——

export const VALIDATION_ERROR: PublicError = PublicErrorSchema.parse({
  code: "invalid_input_format",
  message: "invalid request",
});

export const UNSUPPORTED_VERSION_ERROR: PublicError = PublicErrorSchema.parse({
  code: "invalid_input_format",
  message: "unsupported protocol version",
});

export const REQUEST_TOO_LARGE_ERROR: PublicError = PublicErrorSchema.parse({
  code: "invalid_input_format",
  message: "request too large",
});

export const NOT_FOUND_ERROR: PublicError = PublicErrorSchema.parse({
  code: "invalid_input_format",
  message: "resource not found",
});

export const TERMINAL_ERROR: PublicError = PublicErrorSchema.parse({
  code: "session_terminal",
  message: "session is terminal",
});

export const CLIENT_SEQ_BUDGET_ERROR: PublicError = PublicErrorSchema.parse({
  code: "stale_client_seq",
  message: "client sequence budget exhausted",
});

export const CHALLENGE_INVALID_ERROR: PublicError = PublicErrorSchema.parse({
  code: "internal_error",
  message: "challenge invalid",
});

export const TIMEOUT_ERROR: PublicError = PublicErrorSchema.parse({
  code: "budget_exhausted",
  message: "session timed out",
});

export const ENGINE_ERROR_ERROR: PublicError = PublicErrorSchema.parse({
  code: "internal_error",
  message: "internal error",
});

export const STORAGE_UNAVAILABLE_ERROR: PublicError = PublicErrorSchema.parse({
  code: "internal_error",
  message: "storage unavailable",
});

// —— WP-6 限流触顶(D-API-50 / D-API-52):429 预留行的落地,冻结载荷常量 ——
// 选码纪律与 D-API-14 / D-API-41 同族:资源预算类失败用 `budget_exhausted`
// (能力矩阵 addressHex / explanation 双 forbidden,零解释面,零限流器状态透出);
// 两类触顶恒为各自 (429, code, message) 三元组,与隐藏状态无关(I-4)。

/** 每租户 / 每用户请求频率或提交频率触顶(D-API-50)。 */
export const RATE_LIMITED_ERROR: PublicError = PublicErrorSchema.parse({
  code: "budget_exhausted",
  message: "rate limit exceeded",
});

/** 每租户并发会话预算触顶(D-API-52)。 */
export const CONCURRENT_SESSION_BUDGET_ERROR: PublicError = PublicErrorSchema.parse({
  code: "budget_exhausted",
  message: "concurrent session budget exceeded",
});

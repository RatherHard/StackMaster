/**
 * 限流 / 配额触顶的确定性异常(任务分解 WP-6 第 1 条;D-API-50 / D-API-52)。
 *
 * 触顶 = 确定性拒绝(I-4):同一失败类别恒映射同一 (HTTP 状态, code, message)
 * 三元组——呈现面由 error-mapping 矩阵(D-API-32 增补 429 行)承载:
 *  - RateLimitExceeded → 429 + `budget_exhausted` / "rate limit exceeded";
 *  - ConcurrentSessionBudgetExhausted → 429 + `budget_exhausted` /
 *    "concurrent session budget exceeded"。
 *
 * 零内部细节透出:限流器余量、窗口锚、在途计数等内部状态只进受控日志
 * (构造参数 detail 仅日志),绝不进入响应面。
 */

/** 频率维度(触顶呈现同形:429 + 冻结形态;维度只进受控日志)。 */
export type RateLimitDimension = "request_rate" | "submission_rate" | "session_action_rate";

/** 每租户 / 每用户请求频率或提交频率触顶(固定窗口计数;D-API-50)。 */
export class RateLimitExceeded extends Error {
  readonly dimension: RateLimitDimension;

  constructor(dimension: RateLimitDimension, detail: string) {
    super(`rate limit exceeded (${dimension}): ${detail}`);
    this.name = "RateLimitExceeded";
    this.dimension = dimension;
  }
}

/** 每租户并发会话预算触顶(D-API-52;精确执行面在 LiveSessionManager 同步入场预留)。 */
export class ConcurrentSessionBudgetExhausted extends Error {
  constructor(detail: string) {
    super(`concurrent session budget exceeded: ${detail}`);
    this.name = "ConcurrentSessionBudgetExhausted";
  }
}

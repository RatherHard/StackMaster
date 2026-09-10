/** SessionClient 的错误面(WP-F2):客户端本地拒绝与 REST 命令失败两类。
 *
 * 服务端失败形态 = 冻结 `PublicError`(REST 非 2xx 响应体 / WSS 错误帧),
 * 客户端不制造第二类错误形态;本文件只是客户端自身的可编程错误通道。
 */
import type { PublicError } from "@stackmaster/protocol";

/** SessionClient 本地错误码。 */
export type SessionClientErrorCode =
  | "not_connected"
  | "no_session"
  | "invalid_url"
  | "rest_failed"
  | "contract_drift";

/** 客户端本地错误(断线期投递动作、未建会话、地址解析失败等)。 */
export class SessionClientError extends Error {
  readonly code: SessionClientErrorCode;

  constructor(code: SessionClientErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionClientError";
    this.code = code;
  }
}


/**
 * REST 会话命令失败(非 2xx):携带 HTTP 状态码与冻结 `PublicError` 响应体
 * (429 限流 = budget_exhausted 冻结形态;响应体不可解析时合成为
 * internal_error 兜底,零服务端细节透出)。
 */
export class SessionCommandError extends SessionClientError {
  readonly httpStatus: number;
  readonly publicError: PublicError;

  constructor(httpStatus: number, publicError: PublicError) {
    super("rest_failed", `会话命令失败(HTTP ${httpStatus}):${publicError.code}`);
    this.name = "SessionCommandError";
    this.httpStatus = httpStatus;
    this.publicError = publicError;
  }
}

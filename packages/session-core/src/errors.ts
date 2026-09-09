/**
 * 错误面(WP-8):编排核心的机器可读错误。
 *
 * 纪律:编排核心不把校验器内部细节、worker stderr 或载荷内容带进错误消息
 * (服务端校验基线 #8);错误只携带机器可读 `code` 与静态模板文本。
 */

/** 编排核心错误码(进程 / 协议 / 生命周期三类;非浏览器可见面)。 */
export type OrchestratorErrorCode =
  | "worker_spawn_failed"
  | "protocol_version_mismatch"
  | "protocol_violation"
  | "worker_command_rejected"
  | "worker_crashed"
  | "worker_not_loaded"
  | "invalid_worker_output"
  | "session_closed";

/** 编排核心错误(`code` 供调用方分支;消息为静态模板)。 */
export class OrchestratorError extends Error {
  public readonly code: OrchestratorErrorCode;

  public constructor(code: OrchestratorErrorCode, message: string) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
  }
}

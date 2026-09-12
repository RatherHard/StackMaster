/**
 * @stackmaster/session-core —— 会话编排核心(阶段二 WP-8)。
 *
 * 进程内领域层:生命周期状态机(create-session → action → … → close)、
 * 单会话串行队列、worker 进程管理(spawn / 崩溃分类 / 僵尸回收)、服务端
 * 校验基线 #1–#5 的编排侧实现、revision / 投影 / checkpoint 账本、幂等
 * 缓存、submit 内部引用与崩溃替换恢复。HTTP / WSS 路由、真实认证与持久化
 * 归阶段三(认证以可注入 [`AuthContext`] 替身承载)。
 *
 * 语义权威:docs/develop/会话编排语义规约.md(D-W8-1 ~ D-W8-10);
 * 进程帧协议:docs/develop/引擎进程协议.md(WP-1 冻结面)。
 *
 * 秘密零驻留:本包不导入 challenge-schema server-only 子路径、不解析私有
 * 包内容;依赖纪律由 tooling/dependency-cruiser.cjs 强制。
 */

export { SessionOrchestrator } from "./session.js";
export type {
  ActionObject,
  CheckpointEntry,
  CreateSessionOptions,
  PrecheckErrorCode,
  RecoverOptions,
  ReplayContextSummary,
  ReplayMaterial,
  SessionPhase,
  SubmitReference,
} from "./session.js";
export { WorkerConnection, MAX_FRAME_BYTES } from "./worker-connection.js";
export type {
  ReadyFrame,
  WorkerCommandSpec,
  WorkerExit,
  WorkerExitKind,
  WorkerFrame,
} from "./worker-connection.js";
export { ensureWorkerBinary } from "./worker-binary.js";
export { OrchestratorError } from "./errors.js";
export type { OrchestratorErrorCode } from "./errors.js";
export { stubAuthContext } from "./auth.js";
export type { AuthContext, SessionPrincipal } from "./auth.js";

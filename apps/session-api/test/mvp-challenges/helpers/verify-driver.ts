/**
 * 一次性 verify 驱动(MVP 题目集裁决闭环回归专用;WP-68)。
 *
 * 复用 `@stackmaster/session-core` 的 `WorkerConnection`(引擎进程协议 §2
 * 帧 discipline 的单一实现)+ `resolveWorkerLauncher`(进程形态启动器),
 * 向**未装载**的一次性 vm-worker 进程发送 §4.9 `verify` 命令,取回
 * `verify_report`(11 值裁决 + 重放逐项结论 + 隐藏测试汇总 + logDigest)。
 *
 * 非第二实现声明(ADR-8 纪律):重放与裁决语义全部在 vm-worker 进程内
 * (`vm_runtime::replay` / 判题驱动单一实现);本驱动只是测试侧的协议客户
 * 粘合,与生产 verifier(`apps/verifier` VerifyWorkerClient)消费**同一**
 * 命令面;生产全链路(登记 → 队列 → verifier 服务)由 compose 套件另行
 * 实跑承载。
 *
 * 秘密零驻留:请求与响应整体 SERVER_ONLY;本模块不落任何载荷内容。
 */
import { WorkerConnection, resolveWorkerLauncher } from "@stackmaster/session-core";

/** verify 请求输入(与生产 VerifyRequest 同形;SERVER_ONLY 面)。 */
export interface VerifyDriverRequest {
  readonly privateBundle: unknown;
  readonly publicDescriptor: unknown;
  readonly replayContext: unknown;
  /** 规范化动作日志文本(stackmaster-action-log/1;引擎权威导出)。 */
  readonly actionLog: string;
}

/** verify_report 载荷(协议 §4.9;整体 SERVER_ONLY)。 */
export interface VerifyDriverReport {
  readonly verdict: string;
  readonly replay: {
    readonly kind: "matched" | "diverged" | "context_mismatch" | "fault";
    readonly entry?: number;
    readonly field?: string;
    readonly reason?: string;
    readonly finalStatus?: string;
  };
  readonly hiddenTests?:
    | { readonly kind: "executed"; readonly allPassed: boolean; readonly tests: readonly { readonly index: number; readonly verdict: string; readonly expected: string; readonly passed: boolean }[] }
    | { readonly kind: "fault"; readonly reason: string }
    | { readonly kind: "skipped" };
  readonly logDigest: string;
}

export type VerifyDriverResult =
  | { readonly kind: "report"; readonly report: VerifyDriverReport }
  | { readonly kind: "command_error"; readonly code: string };

let verifySequence = 0;

/** spawn 一次性 worker → verify 单命令 → shutdown 优雅退出。 */
export async function verifyWithWorker(request: VerifyDriverRequest): Promise<VerifyDriverResult> {
  verifySequence += 1;
  const { connection } = await WorkerConnection.connect(
    await resolveWorkerLauncher({
      // 协议端口:sessionId 仅用于进程标识与容器命名派生;一次性 verify 进程
      // 不进会话账目,标识只需唯一且名法安全。
      sessionId: `verify-once-${process.pid}-${verifySequence}`,
    }),
  );
  try {
    const frame = await connection.request({
      type: "verify",
      privateBundle: request.privateBundle,
      publicDescriptor: request.publicDescriptor,
      replayContext: request.replayContext,
      actionLog: request.actionLog,
    });
    if (frame["type"] === "verify_report") {
      const report = frame["report"] as {
        verdict: string;
        replay: VerifyDriverReport["replay"];
        hiddenTests?: VerifyDriverReport["hiddenTests"];
        logDigest: string;
      };
      return { kind: "report", report };
    }
    if (frame["type"] === "command_error") {
      const error = frame["error"] as { code?: string } | undefined;
      return { kind: "command_error", code: String(error?.code ?? "unknown") };
    }
    throw new Error(`verify 返回意外帧类型:${String(frame["type"])}`);
  } finally {
    // 优雅停机(退出码 0);响应不到达时收割兜底(连接层 kill 语义)。
    try {
      await connection.request({ type: "shutdown" });
    } catch {
      connection.kill();
    }
    await connection.waitExit();
  }
}

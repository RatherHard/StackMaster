/**
 * vm-worker verify 客户端(WP-61;ADR-3 进程边界:spawn + stdio NDJSON,
 * 禁 FFI)。
 *
 * 一次性裁决进程形态:spawn → `ready` 自报(协议版本比对 fail-closed,
 * 零协商降级)→ 调用方做 bundle lock 复核(`ready` 身份)→ `verify`
 * 单命令 → `shutdown` 优雅退出,进程不复用。帧纪律与 Rust 帧层对偶:
 * 一行一帧、单帧 `MAX_FRAME_BYTES`(16 MiB,D-F2)、stop-and-wait;
 * stdout 每行必须是协议帧,违规即进程不可信(收割 + run failed 方向)。
 *
 * 秘密零驻留:verify 请求与响应整体 SERVER_ONLY(引擎进程协议面);本
 * 模块不落任何载荷内容到日志,受控日志只含事件与确定性原因标签。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { ENGINE_PROCESS_PROTOCOL_VERSION } from "@stackmaster/protocol";

import { MAX_FRAME_BYTES } from "../protocol-limits.js";

/** worker 自报帧(`ready`)。 */
export interface ReadyFrame {
  readonly vmEngineVersion: string;
  readonly engineBuildId: string;
}

/** verify 命令请求(协议 §四;载荷整体 SERVER_ONLY)。 */
export interface VerifyRequest {
  readonly privateBundle: unknown;
  readonly publicDescriptor: unknown;
  readonly sessionSeedHex?: string;
  readonly replayContext: unknown;
  readonly actionLog: string;
}

/** 重放逐项结论(worker verify 响应的 `replay` 字段)。 */
export interface VerifyReplayOutcome {
  readonly kind: "matched" | "diverged" | "context_mismatch" | "fault";
  readonly entry?: number;
  readonly field?: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly finalRevision?: number;
  readonly finalStatus?: string;
  readonly stateHashSequence?: readonly string[];
  readonly revisionSequence?: readonly number[];
  readonly reason?: string;
}

/** 隐藏测试逐项结论(WP-62;仅索引与判定值,谓词内容 / testId 零公开面)。 */
export interface HiddenTestEntryReport {
  readonly index: number;
  readonly verdict: string;
  readonly expected: string;
  readonly passed: boolean;
}

/** 隐藏测试汇总面(worker verify 响应的 `hiddenTests` 字段;协议 §4.9 增补)。 */
export type HiddenTestSummaryReport =
  | {
      readonly kind: "executed";
      readonly allPassed: boolean;
      readonly tests: readonly HiddenTestEntryReport[];
    }
  | { readonly kind: "fault"; readonly reason: string }
  | { readonly kind: "skipped" };

/** verify 响应载荷(11 值裁决面 + 逐项结论 + 隐藏测试汇总 + logDigest 复算值)。 */
export interface VerifyReport {
  readonly verdict: string;
  readonly replay: VerifyReplayOutcome;
  readonly hiddenTests?: HiddenTestSummaryReport;
  readonly logDigest: string;
}

/** verify 单命令的结果(三种确定性别形态)。 */
export type VerifyOutcome =
  | { readonly kind: "report"; readonly report: VerifyReport }
  | { readonly kind: "command_error"; readonly code: string }
  | { readonly kind: "process_failure"; readonly reason: string };

/** 可注入的进程描述(测试注入假 worker;生产为 vm-worker 二进制)。 */
export interface WorkerCommandSpec {
  readonly command: string;
  readonly args?: readonly string[];
  /** 追加环境变量(测试假 worker 行为驱动;生产缺省不注入)。 */
  readonly env?: readonly (readonly [string, string])[];
}

interface PendingRequest {
  resolve: (frame: Record<string, unknown>) => void;
  reject: (error: VerifyClientError) => void;
}

/** 客户端确定性失败(reason 为封闭原因标签,只进受控日志)。 */
export class VerifyClientError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "VerifyClientError";
    this.reason = reason;
  }
}

/**
 * 一次性 verify worker 进程连接。`spawn` 完成 `ready` 握手与协议版本比对;
 * `verify` 为单命令 stop-and-wait;`dispose` 走 shutdown → 优雅退出
 * (超时收割,进程不复用)。
 */
export class VerifyWorkerClient {
  readonly ready: ReadyFrame;
  private readonly child: ChildProcess;
  private readonly stdin: NodeJS.WritableStream;
  private readonly reader: Interface;
  private pending: PendingRequest | null = null;
  private nextSeq = 1;
  private disposed = false;

  private constructor(child: ChildProcess, ready: ReadyFrame) {
    this.child = child;
    this.ready = ready;
    const stdout = child.stdout;
    const stdin = child.stdin;
    if (stdout === null || stdin === null) {
      throw new VerifyClientError("spawn_failed", "worker stdio 管道缺失");
    }
    this.stdin = stdin;
    this.reader = createInterface({ input: stdout });
    this.reader.on("line", (line: string) => this.onLine(line));
    // 进程先行退出:在途请求确定性失败(进程不复用)。'error' 事件(启动
    // 失败 / kill 失败)同样收敛为确定性失败,不产生 uncaught exception。
    child.once("exit", () => {
      const pending = this.pending;
      this.pending = null;
      pending?.reject(
        new VerifyClientError("process_exited", "worker 进程在请求处理中退出"),
      );
    });
    child.on("error", (error: Error) => {
      const pending = this.pending;
      this.pending = null;
      pending?.reject(
        new VerifyClientError("process_exited", `worker 进程异常:${error.message}`),
      );
    });
  }

  /** spawn → ready 握手(协议版本不一致即回收进程并拒绝,协议 §2.2)。 */
  static async spawn(spec: WorkerCommandSpec): Promise<VerifyWorkerClient> {
    const child = spawn(spec.command, spec.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(spec.env === undefined
        ? {}
        : { env: { ...process.env, ...Object.fromEntries(spec.env) } }),
    });
    // spawn 失败(ENOENT 等)经 'error' 事件异步到达:必须消费,否则进程级
    // uncaught exception(帧纪律的进程可信面)。holder 承载异步赋值
    // (回调内赋值不参与 TS 流分析)。
    const spawnError: { value: Error | null } = { value: null };
    child.once("error", (error: Error) => {
      spawnError.value = error;
    });
    const firstFrame = await VerifyWorkerClient.receiveFirst(child);
    if (
      firstFrame === null ||
      firstFrame["type"] !== "ready" ||
      typeof firstFrame["protocolVersion"] !== "number"
    ) {
      child.kill("SIGKILL");
      if (spawnError.value !== null) {
        throw new VerifyClientError(
          "spawn_failed",
          `worker 进程启动失败:${spawnError.value.message}`,
        );
      }
      throw new VerifyClientError("protocol_violation", "worker 首帧必须是 ready 自报帧");
    }
    if (firstFrame["protocolVersion"] !== ENGINE_PROCESS_PROTOCOL_VERSION) {
      child.kill("SIGKILL");
      throw new VerifyClientError(
        "protocol_version_mismatch",
        "worker 协议版本与 verifier 不一致(fail-closed,无协商降级)",
      );
    }
    const ready: ReadyFrame = {
      vmEngineVersion: String(firstFrame["vmEngineVersion"] ?? ""),
      engineBuildId: String(firstFrame["engineBuildId"] ?? ""),
    };
    return new VerifyWorkerClient(child, ready);
  }

  /** verify 单命令(协议 §四;超时由调用方经 dispose 收割兜底)。 */
  async verify(request: VerifyRequest, timeoutMs: number): Promise<VerifyOutcome> {
    if (this.disposed) {
      return { kind: "process_failure", reason: "worker_not_available" };
    }
    try {
      const frame = await this.request(
        {
          type: "verify",
          privateBundle: request.privateBundle,
          publicDescriptor: request.publicDescriptor,
          replayContext: request.replayContext,
          actionLog: request.actionLog,
          ...(request.sessionSeedHex === undefined
            ? {}
            : { sessionSeedHex: request.sessionSeedHex }),
        },
        timeoutMs,
      );
      if (frame["type"] === "verify_report") {
        const report = frame["report"];
        if (report === null || typeof report !== "object" || Array.isArray(report)) {
          return { kind: "process_failure", reason: "invalid_verify_report" };
        }
        const record = report as { readonly [field: string]: unknown };
        return {
          kind: "report",
          report: {
            verdict: String(record["verdict"] ?? ""),
            replay: record["replay"] as VerifyReplayOutcome,
            hiddenTests: record["hiddenTests"] as HiddenTestSummaryReport | undefined,
            logDigest: String(record["logDigest"] ?? ""),
          },
        };
      }
      if (frame["type"] === "command_error") {
        const error = frame["error"] as { readonly code?: string } | undefined;
        return {
          kind: "command_error",
          code: String(error?.code ?? "unknown"),
        };
      }
      return { kind: "process_failure", reason: "unexpected_frame" };
    } catch (error) {
      if (error instanceof VerifyClientError) {
        return { kind: "process_failure", reason: error.reason };
      }
      throw error;
    }
  }

  /** 优雅停机:shutdown → 退出码 0;超时收割(进程不复用)。 */
  async dispose(timeoutMs = 5_000): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      await this.request({ type: "shutdown" }, timeoutMs);
    } catch {
      // 响应不到达:下方收割兜底。
    }
    const exited = new Promise<void>((resolve) => this.child.once("exit", resolve));
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const timer = setTimeout(() => this.child.kill("SIGKILL"), timeoutMs);
      timer.unref?.();
    }
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs + 1_000))]);
    this.reader.close();
  }

  /** 强制收割(超时 / 异常路径;进程不复用)。 */
  kill(): void {
    this.disposed = true;
    this.child.kill("SIGKILL");
    this.reader.close();
  }

  private request(
    frame: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    if (this.pending !== null) {
      return Promise.reject(
        new VerifyClientError("protocol_violation", "stop-and-wait 违规"),
      );
    }
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const pending: PendingRequest = { resolve: () => undefined, reject: () => undefined };
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    this.pending = pending;
    const timer = setTimeout(() => {
      const stalled = this.pending;
      this.pending = null;
      stalled?.reject(new VerifyClientError("timeout", "worker 响应超时"));
    }, timeoutMs);
    timer.unref?.();
    this.stdin.write(`${JSON.stringify({ ...frame, seq })}\n`);
    return promise.finally(() => clearTimeout(timer));
  }

  private onLine(line: string): void {
    if (line.length > MAX_FRAME_BYTES) {
      this.failPending("frame_too_large", "worker 帧超限");
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(line) as unknown;
    } catch {
      this.failPending("invalid_worker_output", "worker stdout 出现非协议帧行");
      return;
    }
    if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
      this.failPending("invalid_worker_output", "worker 帧不是 JSON 对象");
      return;
    }
    const pending = this.pending;
    this.pending = null;
    pending?.resolve(frame as Record<string, unknown>);
  }

  private failPending(reason: string, message: string): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(new VerifyClientError(reason, message));
    this.reader.close();
  }

  private static receiveFirst(
    child: ChildProcess,
  ): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const stdout = child.stdout;
      if (stdout === null) {
        resolve(null);
        return;
      }
      const reader = createInterface({ input: stdout });
      const timer = setTimeout(() => {
        reader.close();
        resolve(null);
      }, 10_000);
      timer.unref?.();
      reader.once("line", (line: string) => {
        clearTimeout(timer);
        reader.close();
        try {
          resolve(JSON.parse(line) as Record<string, unknown>);
        } catch {
          resolve(null);
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reader.close();
        resolve(null);
      });
    });
  }
}

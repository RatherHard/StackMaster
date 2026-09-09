/**
 * worker 进程连接(WP-8;D-W8-10):spawn、NDJSON 帧、stop-and-wait 请求
 * / 响应、退出分类。
 *
 * 帧纪律与 Rust 帧层(`vm_worker::protocol::frame`)对偶:一行一帧、单帧
 * 16 MiB、`seq` 自 1 严格递增、stdout 每行必须是协议帧(纯净性);违反即
 * 判定进程不可信,标记崩溃并拒绝后续使用(恢复归崩溃替换路径)。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { ENGINE_PROCESS_PROTOCOL_VERSION } from "@stackmaster/protocol";
import { OrchestratorError } from "./errors.js";

/** 单帧上限(协议 D-F2;双向强制)。 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** worker 自报帧(`ready`)。 */
export interface ReadyFrame {
  readonly type: "ready";
  readonly protocolVersion: number;
  readonly vmEngineVersion: string;
  readonly engineBuildId: string;
}

/** worker 响应帧(§4.6 响应帧汇总;载荷按 `type` 窄化由调用方断言)。 */
export interface WorkerFrame {
  readonly type: string;
  readonly seq?: number;
  readonly [field: string]: unknown;
}

/** worker 退出分类(D-W8-10;编排器据此选择恢复路径)。 */
export type WorkerExitKind = "graceful" | "watchdog_timeout" | "forced" | "crashed";

export interface WorkerExit {
  readonly kind: WorkerExitKind;
  readonly code: number | null;
  readonly signal: string | null;
}

/** 可注入的进程描述(测试注入假 worker;生产为 vm-worker 二进制)。 */
export interface WorkerCommandSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: readonly (readonly [string, string])[];
}

interface PendingRequest {
  resolve: (frame: WorkerFrame) => void;
  reject: (error: OrchestratorError) => void;
}

/** 单会话 worker 进程连接。一次服务一个会话,终止后不复用。 */
export class WorkerConnection {
  private readonly child: ChildProcess;
  private readonly stdin: NodeJS.WritableStream;
  private readonly reader: Interface;
  private pending: PendingRequest | null = null;
  private nextSeq = 1;
  private closed = false;
  private readonly exitPromise: Promise<WorkerExit>;
  private exitKind: WorkerExitKind | null = null;
  private readyFrame: ReadyFrame | null = null;

  private constructor(child: ChildProcess) {
    this.child = child;
    const stdout = child.stdout;
    const stdin = child.stdin;
    if (stdout === null || stdin === null) {
      throw new OrchestratorError("worker_spawn_failed", "worker stdio 管道缺失");
    }
    this.stdin = stdin;
    this.reader = createInterface({ input: stdout });
    this.reader.on("line", (line: string) => this.onLine(line));
    this.exitPromise = new Promise<WorkerExit>((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.reader.close();
        // 进程退出时仍有未决请求 = 崩溃(响应永不到达):拒绝在途调用。
        const pending = this.pending;
        this.pending = null;
        pending?.reject(
          new OrchestratorError("worker_crashed", "worker 进程在请求处理中退出"),
        );
        const kind: WorkerExitKind =
          this.exitKind ??
          (code === 0 && signal === null
            ? "graceful"
            : code === 3
              ? "watchdog_timeout"
              : signal !== null
                ? "forced"
                : "crashed");
        resolve({ kind, code, signal });
      });
    });
  }

  /** spawn 并等待 `ready` 自报帧;协议版本不一致即回收进程并拒绝建会话。 */
  static async spawn(options: WorkerCommandSpec): Promise<{
    connection: WorkerConnection;
    ready: ReadyFrame;
  }> {
    const child = spawn(options.command, options.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.env === undefined
        ? {}
        : {
            env: {
              ...process.env,
              ...Object.fromEntries(options.env),
            },
          }),
    });
    const connection = new WorkerConnection(child);
    const ready = (await connection.receive()) as unknown as ReadyFrame;
    if (ready.type !== "ready" || typeof ready.protocolVersion !== "number") {
      connection.destroy();
      throw new OrchestratorError(
        "protocol_violation",
        "worker 首帧必须是 ready 自报帧",
      );
    }
    if (ready.protocolVersion !== ENGINE_PROCESS_PROTOCOL_VERSION) {
      connection.destroy();
      throw new OrchestratorError(
        "protocol_version_mismatch",
        "worker 协议版本与编排器不一致(fail-closed,无协商降级)",
      );
    }
    connection.readyFrame = ready;
    return { connection, ready };
  }

  /** worker 自报身份(版本策略 §三记录项 #3 的运行时来源)。 */
  get identity(): { vmEngineVersion: string; engineBuildId: string } {
    return {
      vmEngineVersion: this.readyFrame?.vmEngineVersion ?? "",
      engineBuildId: this.readyFrame?.engineBuildId ?? "",
    };
  }

  /** stop-and-wait 请求:赋 `seq`、写一行、等一帧响应。 */
  async request(frame: Record<string, unknown>): Promise<WorkerFrame> {
    if (this.closed) {
      throw new OrchestratorError("worker_crashed", "worker 进程已终止");
    }
    const seq = this.nextSeq;
    this.nextSeq += 1;
    this.child.stdin?.write(`${JSON.stringify({ ...frame, seq })}\n`);
    const response = await this.receive();
    if (response.seq !== undefined && response.seq !== seq) {
      this.markCrashed();
      throw new OrchestratorError(
        "protocol_violation",
        "worker 响应 seq 与命令不匹配",
      );
    }
    return response;
  }

  /** 读一帧(stdout 纯净性:每行必须可解析为 JSON 对象)。 */
  private receive(): Promise<WorkerFrame> {
    if (this.pending) {
      // stop-and-wait:上一请求未决即发新请求是编排器缺陷。
      throw new OrchestratorError("protocol_violation", "stop-and-wait 违规");
    }
    return new Promise<WorkerFrame>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  private onLine(line: string): void {
    if (line.length > MAX_FRAME_BYTES) {
      this.markCrashed();
      this.failPending("protocol_violation", "worker 帧超限");
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(line) as unknown;
    } catch {
      this.markCrashed();
      this.failPending("invalid_worker_output", "worker stdout 出现非协议帧行");
      return;
    }
    if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
      this.markCrashed();
      this.failPending("invalid_worker_output", "worker 帧不是 JSON 对象");
      return;
    }
    const pending = this.pending;
    this.pending = null;
    pending?.resolve(frame as WorkerFrame);
  }

  private failPending(code: "protocol_violation" | "invalid_worker_output", message: string): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(new OrchestratorError(code, message));
  }

  private markCrashed(): void {
    this.exitKind = "crashed";
    this.closed = true;
  }

  /** 进程是否已不可用(崩溃 / 关闭)。 */
  get unavailable(): boolean {
    return this.closed;
  }

  /** 强制终止(SIGKILL);幂等。 */
  kill(): void {
    this.exitKind = this.exitKind ?? "forced";
    this.child.kill("SIGKILL");
  }

  /** 版本握手失败等场景:杀进程、按崩溃分类。 */
  destroy(): void {
    this.markCrashed();
    this.child.kill("SIGKILL");
  }

  /** 等待进程退出并返回分类。 */
  waitExit(): Promise<WorkerExit> {
    return this.exitPromise;
  }

  /** 标记正常关闭(优雅 shutdown 之后;进程不复用)。 */
  markClosed(): void {
    this.closed = true;
  }
}

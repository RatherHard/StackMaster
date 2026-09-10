/**
 * 调试通道连接状态机(阶段四 WP-41;WP-40 协议语义 §二/§三/§四;ADR-DC1
 * 条款 1 / 决议 3 / §六 R3)。
 *
 * 与既有 WSS 动作通道(wss-channel.ts)同构的连接生命周期,独立端点 +
 * 独立协议版本,**既有通道零改动**(D-API-2 锚定实现零触碰,锚定机制在
 * 调试通道内自建同款):
 *
 *   [升级请求] → 凭证 preHandler(D-API-12 Cookie;失败 = HTTP 401 统一
 *   形态,字节级一致)→ handler(claims.sessionId 升级即锚定本连接)
 *     → ACTIVE_AWAITING_FRAME → 首帧(受理集合内)protocolVersion = 本连接
 *     解释版本 → ACTIVE_ANCHORED(漂移帧确定性拒绝)
 *     → CLOSED(空闲 1000 / 停机 1001 / 背压 1013 / 对端关闭)
 *
 * 每帧流水线(收序即处理序;串行链保证帧序 = 执行序):
 *   频率闸(每连接令牌桶)→ **每会话动作预算闸(与解题共用同一
 *   SessionActionRateLimiter 桶,不设第二类限额;触顶 = budget_exhausted /
 *   "action rate limit exceeded",与解题 429 字节级一致,条款 6)** →
 *   文本 / JSON 形态 → 结构护栏 → 版本受理 + 连接锚定 → 冻结
 *   DebugFrameSchema 重新校验 → 方向检查(客户端只发 5 值请求帧)→ 会话
 *   绑定 → DebugChannelOrchestrator(attach 重放对齐 / 帧转发)→ S→C 帧
 *   下发(requestId 回显,载荷原样转发,零本地推导)。
 */
import {
  DEBUG_CHANNEL_PROTOCOL_VERSION,
  DEBUG_CLIENT_TO_SERVER_TYPES,
  DebugFrameSchema,
  type DebugFrame,
  type PublicError,
} from "@stackmaster/protocol";
import type { SessionCredentialClaims } from "@stackmaster/protocol/server-only";
import type { Logger } from "pino";

import type { RequestGuardLimits } from "../routes/request-guards.js";
import { BoundedSendBuffer, type FrameWriteSink } from "../wss/bounded-send-buffer.js";
import { MessageRateLimiter } from "../wss/message-rate-limiter.js";
import type { SessionMetrics } from "../metrics/metrics.js";
import {
  DEBUG_ACTION_RATE_LIMIT_ERROR,
  DEBUG_CLOSE_IDLE_TIMEOUT,
  DEBUG_CLOSE_INTERNAL_DRIFT,
  DEBUG_CLOSE_SEND_BUFFER_OVERFLOW,
  DEBUG_CLOSE_SHUTDOWN,
  DEBUG_IDLE_TIMEOUT_ERROR,
  DEBUG_INTERNAL_ERROR,
  DEBUG_MALFORMED_FRAME_ERROR,
  DEBUG_RATE_LIMIT_ERROR,
  DEBUG_SEND_BUFFER_OVERFLOW_ERROR,
  DEBUG_SESSION_MISMATCH_ERROR,
  DEBUG_UNSUPPORTED_VERSION_ERROR,
} from "./debug-channel-constants.js";
import { parseDebugChannelFrame, type DebugFrameRejection } from "./debug-frame-contract.js";
import { DebugChannelError, type DebugChannelOrchestrator } from "./debug-channel-orchestrator.js";

/** 服务端 WebSocket 连接的最小结构面(与既有通道同一形态;测试可注入替身)。 */
export interface DebugChannelSocket {
  send(data: string, cb?: (err?: Error) => void): void;
  ping(cb?: () => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "pong", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
}

export interface DebugChannelConnectionOptions {
  readonly socket: DebugChannelSocket;
  /** 升级期通过统一认证入口的会话凭证 claims(升级即锚定)。 */
  readonly claims: SessionCredentialClaims;
  readonly orchestrator: DebugChannelOrchestrator;
  readonly logger: Logger;
  /** 结构护栏(与 REST / 既有通道同值装配)。 */
  readonly limits: RequestGuardLimits;
  /** 心跳间隔(秒)。 */
  readonly heartbeatIntervalSeconds: number;
  /** 空闲超时(秒;pong / 入站消息静默判定)。 */
  readonly idleTimeoutSeconds: number;
  /** 通道消息频率(令牌桶容量 = 速率 / 秒;每连接桶)。 */
  readonly messageRatePerSecond: number;
  /**
   * 每会话动作预算闸(与解题动作共用同一桶,ADR-DC1 条款 6;缺省未注入 =
   * 不设本闸)。
   */
  readonly sessionActionLimiter?: { tryTake(sessionId: string): boolean };
  /** 发送缓冲帧数上限(背压)。 */
  readonly sendBufferLimit: number;
  /** 指标面(纯观测;缺省零观测开销)。 */
  readonly metrics?: SessionMetrics;
  readonly now?: () => number;
}

interface DebugOutboundFrameInput {
  protocolVersion: number;
  type: DebugFrame["type"];
  sessionId: string;
  seq: number;
  requestId?: string;
  payload: unknown;
}

/** 空闲断开后 socket 收尾的宽限(非配置面)。 */
const TERMINATE_GRACE_MS = 1000;

export class DebugChannelConnection {
  readonly #options: DebugChannelConnectionOptions;
  readonly #log: Logger;
  readonly #socket: DebugChannelSocket;
  readonly #claims: SessionCredentialClaims;
  readonly #rateLimiter: MessageRateLimiter;
  readonly #sendBuffer: BoundedSendBuffer;
  readonly #metrics: SessionMetrics | undefined;
  /** 单连接串行链:帧序 = 执行序。 */
  #chain: Promise<void> = Promise.resolve();
  /** 连接锚定的协议版本(首帧即协商;null = 尚未锚定)。 */
  #anchoredVersion: number | null = null;
  #outboundSeq = 0;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #terminateTimer: NodeJS.Timeout | null = null;
  #lastAliveAt: number;
  #closed = false;
  #closing = false;
  #started = false;

  constructor(options: DebugChannelConnectionOptions) {
    this.#options = options;
    this.#socket = options.socket;
    this.#claims = options.claims;
    this.#log = options.logger.child({
      component: "debug-channel",
      sessionId: options.claims.sessionId,
      tenantId: options.claims.tenantId,
    });
    this.#rateLimiter = new MessageRateLimiter({
      capacityPerSecond: options.messageRatePerSecond,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.#sendBuffer = new BoundedSendBuffer({
      sink: this.#sinkFrameText,
      limit: options.sendBufferLimit,
      onOverflow: () => this.#onSendBufferOverflow(),
      onWriteError: (error) => {
        this.#log.warn({ reason: error.message }, "debug socket write failed");
      },
    });
    this.#lastAliveAt = (options.now ?? Date.now)();
    this.#metrics = options.metrics;
  }

  get sessionId(): string {
    return this.#claims.sessionId;
  }

  get tenantId(): string {
    return this.#claims.tenantId;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  /** 连接锚定的协议版本(测试断言)。 */
  get anchoredVersion(): number | null {
    return this.#anchoredVersion;
  }

  start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#socket.on("message", (data, isBinary) => this.#onRawMessage(data, isBinary));
    this.#socket.on("pong", () => {
      this.#lastAliveAt = this.#nowMs();
    });
    this.#socket.on("error", (error) => {
      this.#log.warn({ reason: error.message }, "debug socket error");
    });
    this.#socket.on("close", () => this.#onClosed());
    const heartbeatMs = this.#options.heartbeatIntervalSeconds * 1000;
    this.#heartbeatTimer = setInterval(() => this.#heartbeatTick(), heartbeatMs);
    this.#heartbeatTimer.unref();
    this.#log.debug("debug channel started");
  }

  /** 停机收尾:冲刷发送缓冲后以 1001 有序关闭。 */
  async closeForShutdown(): Promise<void> {
    await this.#sendBuffer.waitDrained(TERMINATE_GRACE_MS);
    this.#closeSocket(DEBUG_CLOSE_SHUTDOWN, "server shutting down");
  }

  // ── 入站:同步前置闸 + 串行链 ───────────────────────────────────────────

  #onRawMessage(data: Buffer, isBinary: boolean): void {
    if (this.#closed) {
      return;
    }
    this.#lastAliveAt = this.#nowMs();

    // 1. 每连接频率闸:同步判定,触顶 = 逐帧确定性拒绝(连接保持)。
    if (!this.#rateLimiter.tryTake()) {
      this.#log.warn({ reason: "message_rate_exceeded" }, "debug frame rejected");
      this.#metrics?.observeDebugFrame("other", "rejected");
      this.#emitError(DEBUG_RATE_LIMIT_ERROR);
      return;
    }
    // 1b. 每会话动作预算闸(与解题共用同一桶,条款 6;429 字节级一致)。
    if (
      this.#options.sessionActionLimiter !== undefined &&
      !this.#options.sessionActionLimiter.tryTake(this.#claims.sessionId)
    ) {
      this.#log.warn({ reason: "session_action_rate_exceeded" }, "debug frame rejected");
      this.#options.metrics?.observeDebugBudgetRejection();
      this.#options.metrics?.observeDebugFrame("other", "rejected");
      this.#emitError(DEBUG_ACTION_RATE_LIMIT_ERROR);
      return;
    }

    // 2. 二进制帧 = 畸形(通道只承载 JSON 文本帧)。
    if (isBinary) {
      this.#metrics?.observeDebugFrame("other", "rejected");
      this.#rejectFrame({ kind: "malformed_frame" });
      return;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(data.toString("utf8"));
    } catch {
      this.#metrics?.observeDebugFrame("other", "rejected");
      this.#rejectFrame({ kind: "malformed_json" });
      return;
    }

    // 3. 结构护栏 → 版本受理 + 连接锚定 → 冻结帧 Schema 重新校验。
    const parsed = parseDebugChannelFrame(parsedJson, this.#anchoredVersion, this.#options.limits);
    if (!parsed.ok) {
      this.#metrics?.observeDebugFrame("other", "rejected");
      this.#rejectFrame(parsed.rejection);
      return;
    }
    const frame = parsed.frame;

    // 4. 方向检查:客户端只发 5 值请求帧(S→C 类型出现于上行 = 契约违规)。
    if (!(DEBUG_CLIENT_TO_SERVER_TYPES as readonly string[]).includes(frame.type)) {
      this.#metrics?.observeDebugFrame("other", "rejected");
      this.#rejectFrame({ kind: "direction_violation" });
      return;
    }

    // 5. 会话绑定:帧 sessionId 必须等于凭证绑定会话(跨会话帧确定性拒绝)。
    if (frame.sessionId !== this.#claims.sessionId) {
      this.#metrics?.observeDebugFrame("other", "rejected");
      this.#rejectFrame({ kind: "session_mismatch" });
      return;
    }

    // 6. 串行链:编排器执行 → 响应帧下发(入站 seq 不做拒绝依据)。
    this.#options.metrics?.observeDebugFrame(frame.type, "accepted");
    this.#chain = this.#chain.then(() => this.#processFrame(frame), () => undefined);
  }

  async #processFrame(frame: DebugFrame): Promise<void> {
    if (this.#closed) {
      return;
    }
    const requestId = frame.requestId === undefined ? {} : { requestId: frame.requestId };
    try {
      switch (frame.type) {
        case "debug_attach": {
          const receipt = await this.#options.orchestrator.attach(
            this.#claims.sessionId,
            this.#claims.tenantId,
            frame.payload.origin,
          );
          this.#emitFrame({
            protocolVersion: this.#anchoredVersion ?? DEBUG_CHANNEL_PROTOCOL_VERSION,
            type: "debug_attached",
            sessionId: this.#claims.sessionId,
            seq: this.#nextSeq(),
            ...requestId,
            payload: {
              revision: receipt.revision,
              status: receipt.status,
              ...(receipt.pausedAddressHex === undefined
                ? {}
                : { paused: { addressHex: receipt.pausedAddressHex } }),
            },
          });
          return;
        }
        case "debug_window": {
          const receipt = await this.#options.orchestrator.window(
            this.#claims.sessionId,
            this.#claims.tenantId,
            frame.payload.addressHex,
            frame.payload.byteLength,
          );
          this.#emitFrame({
            protocolVersion: this.#anchoredVersion ?? DEBUG_CHANNEL_PROTOCOL_VERSION,
            type: "debug_window_data",
            sessionId: this.#claims.sessionId,
            seq: this.#nextSeq(),
            ...requestId,
            payload: {
              addressHex: receipt.addressHex,
              bytesHex: receipt.bytesHex,
              ...(receipt.truncated ? { truncated: true } : {}),
            },
          });
          return;
        }
        case "debug_step": {
          const receipt = await this.#options.orchestrator.step(this.#claims.sessionId, this.#claims.tenantId);
          this.#emitPaused(receipt, requestId);
          return;
        }
        case "debug_run_to_breakpoint": {
          const receipt = await this.#options.orchestrator.runToBreakpoint(
            this.#claims.sessionId,
            this.#claims.tenantId,
            frame.payload.breakpoints,
          );
          this.#emitPaused(receipt, requestId);
          return;
        }
        case "debug_search": {
          const receipt = await this.#options.orchestrator.search(
            this.#claims.sessionId,
            this.#claims.tenantId,
            frame.payload.patternHex,
            frame.payload.maxHits,
          );
          this.#emitFrame({
            protocolVersion: this.#anchoredVersion ?? DEBUG_CHANNEL_PROTOCOL_VERSION,
            type: "debug_search_results",
            sessionId: this.#claims.sessionId,
            seq: this.#nextSeq(),
            ...requestId,
            payload: {
              hits: receipt.hits,
              ...(receipt.truncated ? { truncated: true } : {}),
            },
          });
          return;
        }
        default: {
          // 受理集合外类型已在方向检查拒绝;此分支不可达(防御性收口)。
          this.#emitError(DEBUG_INTERNAL_ERROR);
        }
      }
    } catch (error) {
      if (error instanceof DebugChannelError) {
        this.#log.warn({ reason: error.message }, "debug frame failed in orchestrator domain");
        this.#emitError(error.payload);
        return;
      }
      this.#log.warn(
        { type: error instanceof Error ? error.name : "NonError" },
        "debug frame failed with unknown error",
      );
      this.#emitError(DEBUG_INTERNAL_ERROR);
    }
  }

  /** debug_paused(wire 载荷 = reason + addressHex,WP-40 冻结;步数只进日志)。 */
  #emitPaused(
    receipt: { reason: string; addressHex: string; stepsExecuted: number },
    requestId: { requestId?: string },
  ): void {
    this.#log.debug({ reason: receipt.reason, steps: receipt.stepsExecuted }, "debug execution paused");
    this.#emitFrame({
      protocolVersion: this.#anchoredVersion ?? DEBUG_CHANNEL_PROTOCOL_VERSION,
      type: "debug_paused",
      sessionId: this.#claims.sessionId,
      seq: this.#nextSeq(),
      ...requestId,
      payload: { reason: receipt.reason, addressHex: receipt.addressHex },
    });
  }

  // ── 出站:错误帧与信封 ──────────────────────────────────────────────────

  #rejectFrame(rejection: DebugFrameRejection): void {
    this.#log.warn(
      {
        reason: rejection.kind,
        ...(rejection.issueCount === undefined ? {} : { issueCount: rejection.issueCount }),
        ...(rejection.issuePaths === undefined ? {} : { issuePaths: rejection.issuePaths }),
        ...(rejection.dimension === undefined ? {} : { dimension: rejection.dimension }),
      },
      "debug frame rejected",
    );
    const payload: PublicError =
      rejection.kind === "unsupported_version" || rejection.kind === "version_anchor_violation"
        ? DEBUG_UNSUPPORTED_VERSION_ERROR
        : rejection.kind === "session_mismatch"
          ? DEBUG_SESSION_MISMATCH_ERROR
          : DEBUG_MALFORMED_FRAME_ERROR;
    this.#emitError(payload);
  }

  #emitError(payload: PublicError): void {
    this.#emitFrame({
      protocolVersion: this.#anchoredVersion ?? DEBUG_CHANNEL_PROTOCOL_VERSION,
      type: "error",
      sessionId: this.#claims.sessionId,
      seq: this.#nextSeq(),
      payload,
    });
  }

  #emitFrame(frame: DebugOutboundFrameInput): void {
    if (this.#closed || this.#closing) {
      return;
    }
    let valid: DebugFrame;
    try {
      valid = DebugFrameSchema.parse(frame);
    } catch (error) {
      // 契约漂移 = 实现事故:细节只进受控日志,连接立即策略关闭。
      this.#log.error(
        { reason: error instanceof Error ? error.message : "outbound frame drift" },
        "outbound debug frame failed contract self-check",
      );
      this.#closeSocket(DEBUG_CLOSE_INTERNAL_DRIFT, "internal contract drift");
      return;
    }
    this.#sendBuffer.enqueue(JSON.stringify(valid));
  }

  #onSendBufferOverflow(): void {
    this.#log.warn({ reason: "send_buffer_overflow" }, "debug channel disconnected (slow consumer)");
    const errorFrameText = JSON.stringify(
      DebugFrameSchema.parse({
        protocolVersion: this.#anchoredVersion ?? DEBUG_CHANNEL_PROTOCOL_VERSION,
        type: "error",
        sessionId: this.#claims.sessionId,
        seq: this.#nextSeq(),
        payload: DEBUG_SEND_BUFFER_OVERFLOW_ERROR,
      }),
    );
    try {
      this.#socket.send(errorFrameText, () => undefined);
    } catch {
      // 发送失败不改变断开路径。
    }
    this.#closeSocket(DEBUG_CLOSE_SEND_BUFFER_OVERFLOW, "send buffer limit exceeded");
  }

  #closeSocket(code: number, reason: string): void {
    if (this.#closing) {
      return;
    }
    this.#closing = true;
    try {
      this.#socket.close(code, reason);
    } catch (error) {
      this.#log.warn(
        { reason: error instanceof Error ? error.message : "close failed" },
        "debug socket close failed",
      );
    }
    if (this.#terminateTimer === null) {
      this.#terminateTimer = setTimeout(() => {
        try {
          this.#socket.terminate();
        } catch {
          // 收尾失败无进一步处置面。
        }
      }, TERMINATE_GRACE_MS);
      this.#terminateTimer.unref();
    }
  }

  #heartbeatTick(): void {
    if (this.#closed || this.#closing) {
      return;
    }
    const idleMs = this.#options.idleTimeoutSeconds * 1000;
    if (this.#nowMs() - this.#lastAliveAt > idleMs) {
      this.#log.info({ reason: "idle_timeout" }, "debug channel idle timeout");
      this.#emitError(DEBUG_IDLE_TIMEOUT_ERROR);
      this.#sendBuffer.dispose();
      this.#closeSocket(DEBUG_CLOSE_IDLE_TIMEOUT, "idle timeout");
      return;
    }
    try {
      this.#socket.ping();
    } catch {
      // ping 失败交由 close/error 事件收尾。
    }
  }

  #onClosed(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    if (this.#terminateTimer !== null) {
      clearTimeout(this.#terminateTimer);
      this.#terminateTimer = null;
    }
    this.#sendBuffer.dispose();
    this.#log.info({ anchoredVersion: this.#anchoredVersion }, "debug channel closed");
  }

  #nextSeq(): number {
    this.#outboundSeq += 1;
    return this.#outboundSeq;
  }

  #nowMs(): number {
    return (this.#options.now ?? Date.now)();
  }

  readonly #sinkFrameText: FrameWriteSink = (text, onWritten) => {
    try {
      this.#socket.send(text, onWritten);
    } catch (error) {
      onWritten(error instanceof Error ? error : new Error(String(error)));
    }
  };
}
